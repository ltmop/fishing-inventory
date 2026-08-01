// 云同步引擎：配对 + 快照调度 + 备份上传 + 恢复
// 铁律：try/catch 全部包裹，任何环节挂掉静默降级——云挂了是本地单机版，不是打不开
// 密钥 K 只存本地 cloud.json，永不上传服务器

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { encrypt, encryptBuffer, decryptBuffer, generateKey } from './cloudCrypto.js'
import { buildSnapshot } from './cloudSnapshot.js'

const CLOUD_URL = process.env.CLOUD_SERVER_URL || 'http://localhost:3100'

let db = null
let dbPath = null
let dataDir = null
let backupDir = null
let getIsPro = () => false
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

// ---------- B3 调度器状态 ----------
let schedulerTimer = null
let lastMtime = 0
let lastBackupDate = ''
let schedulerRunning = false

// ---------- 初始化 ----------

export function initCloud(database, dbP, dataD, backupD, isProFn) {
  db = database
  dbPath = dbP
  dataDir = dataD
  backupDir = backupD
  if (typeof isProFn === 'function') getIsPro = isProFn
  loadLocalConfig()
  startScheduler()
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
  } catch { return }
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

// ---------- B1 Pro 门控 ----------

function checkPro() {
  return getIsPro()
}

// ---------- B3 调度器 ----------

function startScheduler() {
  if (schedulerRunning) return
  schedulerRunning = true

  // 启动后 60s 首次检查
  setTimeout(() => {
    if (cloudState.paired && checkPro()) {
      const lastSync = cloudState.lastSyncAt ? new Date(cloudState.lastSyncAt).getTime() : 0
      if (Date.now() - lastSync > 6 * 3600 * 1000) {
        syncSnapshot().catch(() => {})
      }
    }
  }, 60_000)

  // 每 5 分钟轮询
  schedulerTimer = setInterval(() => {
    if (!cloudState.paired || !checkPro()) return
    try {
      const mtime = fs.statSync(dbPath).mtimeMs
      const lastSync = cloudState.lastSyncAt ? new Date(cloudState.lastSyncAt).getTime() : 0
      if (mtime !== lastMtime && Date.now() - lastSync > 15 * 60 * 1000) {
        lastMtime = mtime
        syncSnapshot().catch(() => {})
      }
      // 每日备份：日期变更时
      const today = new Date().toISOString().slice(0, 10)
      if (today !== lastBackupDate && mtime !== lastMtime) {
        lastBackupDate = today
        uploadBackup().catch(() => {})
      }
    } catch { return }
  }, 5 * 60 * 1000)
}

export function stopScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null }
  schedulerRunning = false
}

// ---------- 退出前 best-effort 快照 ----------

export async function exitSnapshot() {
  if (!cloudState.paired || !checkPro()) return
  try {
    const p = syncSnapshot()
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))
    await Promise.race([p, timeout])
  } catch { return }
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
  // B1: Pro 门控——付费才能上传，到期即停
  if (!checkPro()) return
  cloudState.syncing = true
  try {
    if (!cloudState.userId || !cloudState.uploadToken) return

    let name = storeName || '我的门店'
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'store_name'").get()
      if (row?.value) name = row.value
    } catch { return }

    const snap = buildSnapshot(db, name)
    const json = JSON.stringify(snap)
    const enc = encrypt(json, cloudState.keyK)

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
  if (!checkPro()) return
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
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

// ---------- B2 恢复 ----------

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
    const r = await fetch(`${CLOUD_URL}/api/backup/download?date=${encodeURIComponent(date)}`, {
      headers: { 'x-user-id': cloudState.userId, 'x-token': cloudState.uploadToken },
    })
    const data = await r.json()
    if (!data.ok) return { ok: false, error: data.error || '备份不存在' }

    const buf = decryptBuffer({ iv: data.iv, data: data.data }, cloudState.keyK)
    const { gunzipSync } = await import('node:zlib')
    const decompressed = gunzipSync(buf)

    const header = decompressed.slice(0, 16).toString('utf8')
    if (!header.startsWith('SQLite format 3')) {
      return { ok: false, error: '备份文件损坏：非 SQLite 格式' }
    }

    // 校验完整性
    const tmpPath = dbPath + '.restore.tmp'
    fs.writeFileSync(tmpPath, decompressed)

    // 用临时连接做 integrity_check
    const Database = (await import('node:sqlite')).DatabaseSync
    let tmpDb = null
    try {
      tmpDb = new Database(tmpPath)
      const check = tmpDb.prepare('PRAGMA integrity_check').get()
      if (check.integrity_check !== 'ok') {
        try { fs.unlinkSync(tmpPath) } catch { return }
        return { ok: false, error: `备份校验失败: ${check.integrity_check}` }
      }
    } finally {
      if (tmpDb) tmpDb.close()
    }

    // 先自动本地备份当前库
    const { backupNow } = await import('./backup.js')
    try { backupNow(db, dbPath, backupDir) } catch { return }

    // WAL checkpoint + 关闭主库连接
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()

    // 替换：当前库 → .pre-restore.bak 留底 → 恢复文件 → data.db
    const bakPath = dbPath + '.pre-restore.bak'
    try { fs.unlinkSync(bakPath) } catch { return }
    fs.renameSync(dbPath, bakPath)
    fs.renameSync(tmpPath, dbPath)

    return { ok: true, restored: true, date }
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
