// 云同步引擎：配对 + 快照调度 + 备份上传 + 恢复
// 铁律：try/catch 全部包裹，任何环节挂掉静默降级——云挂了是本地单机版，不是打不开
// 密钥 K 只存本地 cloud.json，永不上传服务器

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { encrypt, encryptBuffer, decryptBuffer, generateKey } from './cloudCrypto.js'
import { buildSnapshot } from './cloudSnapshot.js'

// 默认云端地址（可通过环境变量覆盖）
const CLOUD_URL = process.env.CLOUD_SERVER_URL || 'http://localhost:3100'

let db = null
let dbPath = null
let dataDir = null
let cloudState = {
  paired: false,
  userId: null,
  uploadToken: null,
  viewToken: null,
  keyK: null,
  lastSyncAt: null,
  lastBackupAt: null,
  syncing: false,
  error: null,
  viewUrl: null,
}

const CLOUD_CONFIG = 'cloud.json'

// ---------- 初始化 ----------

export function initCloud(database, dbP, dataD, getIsPro, getLicense) {
  db = database
  dbPath = dbP
  dataDir = dataD
  loadLocalConfig()
}

function loadLocalConfig() {
  try {
    const file = path.join(dataDir, CLOUD_CONFIG)
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8')
      const cfg = JSON.parse(raw)
      if (cfg.userId && cfg.keyK) {
        cloudState = { ...cloudState, ...cfg, paired: true, viewUrl: buildViewUrl(cfg.viewToken, cfg.keyK) }
      }
    }
  } catch { /* 文件损坏当未配对 */ }
}

function saveLocalConfig() {
  try {
    fs.writeFileSync(
      path.join(dataDir, CLOUD_CONFIG),
      JSON.stringify({
        userId: cloudState.userId,
        uploadToken: cloudState.uploadToken,
        viewToken: cloudState.viewToken,
        keyK: cloudState.keyK,
        pairedAt: cloudState.pairedAt,
      }),
      'utf8',
    )
    cloudState.paired = true
    cloudState.viewUrl = buildViewUrl(cloudState.viewToken, cloudState.keyK)
  } catch (e) {
    cloudState.error = `保存凭证失败: ${e.message}`
  }
}

function buildViewUrl(viewToken, keyK) {
  if (!viewToken || !keyK) return null
  return `${CLOUD_URL}/v/${viewToken}#key=${keyK}`
}

// ---------- 配对 ----------

export async function pairWithCloud(pairCode) {
  if (!db) return { ok: false, error: '数据库未就绪' }
  try {
    const r = await fetch(`${CLOUD_URL}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairCode }),
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error || '配对失败' }

    // 生成密钥 K（首次配对）
    const keyK = cloudState.keyK || generateKey()

    cloudState.userId = data.userId
    cloudState.uploadToken = data.uploadToken
    cloudState.viewToken = data.viewToken
    cloudState.keyK = keyK
    cloudState.pairedAt = new Date().toISOString()
    cloudState.error = null

    saveLocalConfig()
    return { ok: true, viewUrl: cloudState.viewUrl }
  } catch (e) {
    return { ok: false, error: `配对请求失败: ${e.message}` }
  }
}

// ---------- 快照上传 ----------

export async function syncSnapshot(storeName) {
  if (!db || cloudState.syncing) return
  cloudState.syncing = true
  try {
    if (!cloudState.userId || !cloudState.uploadToken) return

    // 读 storeName（settings 表）
    let name = storeName || '我的门店'
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'store_name'").get()
      if (row?.value) name = row.value
    } catch { /* 没设店名用默认 */ }

    // 构建快照 JSON
    const snap = buildSnapshot(db, name)
    const json = JSON.stringify(snap)

    // 加密
    const enc = encrypt(json, cloudState.keyK)

    // 上传
    const r = await fetch(`${CLOUD_URL}/api/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': cloudState.userId,
        'x-token': cloudState.uploadToken,
      },
      body: JSON.stringify(enc),
    })
    if (r.ok) {
      cloudState.lastSyncAt = new Date().toISOString()
      cloudState.error = null
    }
  } catch (e) {
    cloudState.error = `快照同步失败: ${e.message}`
  } finally {
    cloudState.syncing = false
  }
}

// ---------- 整库备份上传 ----------

export async function uploadBackup() {
  if (!db || !dbPath || !cloudState.userId) return
  try {
    // WAL checkpoint
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

    // 读 db 文件 → gzip → 加密
    const raw = fs.readFileSync(dbPath)
    const { gzipSync } = await import('node:zlib')
    const compressed = gzipSync(raw)
    const enc = encryptBuffer(compressed, cloudState.keyK)

    const today = new Date().toISOString().slice(0, 10)

    const r = await fetch(`${CLOUD_URL}/api/backup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': cloudState.userId,
        'x-token': cloudState.uploadToken,
        'x-date': today,
      },
      body: JSON.stringify(enc),
    })
    if (r.ok) {
      cloudState.lastBackupAt = new Date().toISOString()
      cloudState.error = null
    }
  } catch (e) {
    cloudState.error = `备份上传失败: ${e.message}`
  }
}

// ---------- 恢复 ----------

export async function listCloudBackups() {
  if (!cloudState.userId || !cloudState.uploadToken) return { ok: false, error: '未配对' }
  try {
    const r = await fetch(`${CLOUD_URL}/api/backup/list`, {
      headers: { 'x-user-id': cloudState.userId, 'x-token': cloudState.uploadToken },
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

export async function restoreFromCloud(date) {
  if (!cloudState.userId || !cloudState.uploadToken) return { ok: false, error: '未配对' }
  try {
    // 1. 下载
    const r = await fetch(`${CLOUD_URL}/api/backup/download?date=${encodeURIComponent(date)}`, {
      headers: { 'x-user-id': cloudState.userId, 'x-token': cloudState.uploadToken },
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error || '备份不存在' }

    // 2. 解密
    const buf = decryptBuffer({ iv: data.iv, data: data.data }, cloudState.keyK)

    // 3. 解压
    const { gunzipSync } = await import('node:zlib')
    const decompressed = gunzipSync(buf)

    // 4. 校验 SQLite 头
    const header = decompressed.slice(0, 16).toString('utf8')
    if (!header.startsWith('SQLite format 3')) {
      return { ok: false, error: '备份文件损坏：非 SQLite 格式' }
    }

    // 5. 写入临时文件
    const tmpPath = dbPath + '.restore.tmp'
    fs.writeFileSync(tmpPath, decompressed)

    return { ok: true, tmpPath }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------- 吊销链接 ----------

export async function regenViewLink() {
  if (!cloudState.userId) return { ok: false, error: '未配对' }
  try {
    const adminKey = process.env.ADMIN_KEY
    if (!adminKey) return { ok: false, error: '服务器未配置 ADMIN_KEY' }
    const r = await fetch(`${CLOUD_URL}/admin/regen?key=${encodeURIComponent(adminKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: cloudState.userId }),
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error }

    cloudState.viewToken = data.viewToken
    saveLocalConfig()
    return { ok: true, viewUrl: cloudState.viewUrl }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------- 状态查询 ----------

export function getCloudState() {
  return { ...cloudState, viewUrl: cloudState.viewUrl }
}
