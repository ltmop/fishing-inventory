// 云备份 + 远程看店 · HTTP 服务
// 零 npm 依赖，纯 node:http + node:crypto
// 铁律：服务器只存密文，没有任何接口能写回本地业务库
import http from 'node:http'
import crypto from 'node:crypto'
import * as store from './store.js'

const PORT = parseInt(process.env.PORT || '3100', 10)
const ADMIN_KEY = process.env.ADMIN_KEY
if (!ADMIN_KEY) {
  console.warn('[cloud-server] 未设置 ADMIN_KEY 环境变量，/admin 路由不可用')
}

const MAX_BODY = 100 * 1024 * 1024 // 100MB（备份用）

// ---------- 工具 ----------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY) { req.destroy(); reject(new Error('body too large')) }
      else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function randomHex(n) { return crypto.randomBytes(n).toString('hex') }

function checkToken(req, expected) {
  const t = req.headers['x-token']
  if (!t || t !== expected) return false
  return true
}

// ---------- 用户鉴权中间件 ----------

function requireUser(req, res) {
  const userId = req.headers['x-user-id']
  if (!userId || !fs.existsSync(store.userDir(userId))) {
    json(res, 401, { ok: false, error: '未配对或用户不存在' })
    return null
  }
  return userId
}

function requireUploadAuth(req, res) {
  const userId = requireUser(req, res)
  if (!userId) return null
  const meta = store.loadMeta(userId)
  const uploadToken = meta.uploadToken
  if (!checkToken(req, uploadToken)) {
    json(res, 401, { ok: false, error: 'uploadToken 无效' })
    return null
  }
  return userId
}

// 简洁 fs import
import fs from 'node:fs'

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,x-token,x-user-id,x-date' })
    res.end()
    return
  }

  try {
    // ======== POST /api/pair ========
    if (req.method === 'POST' && pathname === '/api/pair') {
      const body = JSON.parse((await readBody(req)).toString())
      const code = body.pairCode?.trim()
      if (!code) return json(res, 400, { ok: false, error: '缺少 pairCode' })
      const userId = store.validatePairCode(code)
      if (!userId) return json(res, 403, { ok: false, error: '配对码无效或已过期' })
      const uploadToken = randomHex(32)
      const viewToken = randomHex(16)
      const meta = store.loadMeta(userId)
      meta.uploadToken = uploadToken
      meta.viewToken = viewToken
      meta.note = body.note || meta.note || ''
      store.saveMeta(userId, meta)
      return json(res, 200, { ok: true, userId, uploadToken, viewToken })
    }

    // ======== POST /api/snapshot ========
    if (req.method === 'POST' && pathname === '/api/snapshot') {
      const userId = requireUploadAuth(req, res)
      if (!userId) return
      const body = JSON.parse((await readBody(req)).toString())
      if (!body.iv || !body.data) return json(res, 400, { ok: false, error: '缺少 iv/data' })
      store.saveSnapshot(userId, body.iv, body.data)
      return json(res, 200, { ok: true, at: new Date().toISOString() })
    }

    // ======== POST /api/backup ========
    if (req.method === 'POST' && pathname === '/api/backup') {
      const userId = requireUploadAuth(req, res)
      if (!userId) return
      const date = req.headers['x-date']
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { ok: false, error: '缺少或非法 x-date (YYYY-MM-DD)' })
      const body = JSON.parse((await readBody(req)).toString())
      if (!body.iv || !body.data) return json(res, 400, { ok: false, error: '缺少 iv/data' })
      store.saveBackup(userId, date, body.iv, body.data)
      store.cleanOldBackups(userId, 30)
      return json(res, 200, { ok: true })
    }

    // ======== GET /api/backup/list ========
    if (req.method === 'GET' && pathname === '/api/backup/list') {
      const userId = requireUploadAuth(req, res)
      if (!userId) return
      return json(res, 200, { ok: true, files: store.listBackups(userId) })
    }

    // ======== GET /api/backup/download ========
    if (req.method === 'GET' && pathname === '/api/backup/download') {
      const userId = requireUploadAuth(req, res)
      if (!userId) return
      const date = url.searchParams.get('date')
      if (!date) return json(res, 400, { ok: false, error: '缺少 date' })
      const backup = store.loadBackup(userId, date)
      if (!backup) return json(res, 404, { ok: false, error: '备份不存在' })
      return json(res, 200, { ok: true, iv: backup.iv, data: backup.data })
    }

    // ======== GET /api/snapshot/fetch (手机页用，viewToken 鉴权) ========
    if (req.method === 'GET' && pathname === '/api/snapshot/fetch') {
      const t = url.searchParams.get('t')
      if (!t) return json(res, 401, { ok: false, error: '缺少 viewToken' })
      // 遍历用户找匹配的 viewToken
      const users = store.listUsers()
      let found = null
      for (const u of users) {
        const meta = store.loadMeta(u.userId)
        if (meta.viewToken === t && !meta.viewTokenOld.includes(t)) { found = u.userId; break }
      }
      if (!found) return json(res, 401, { ok: false, error: 'viewToken 无效或已吊销' })
      const snap = store.loadSnapshot(found)
      if (!snap) return json(res, 404, { ok: false, error: '暂无快照数据' })
      return json(res, 200, { ok: true, iv: snap.iv, data: snap.data })
    }

    // ======== GET /v/{viewToken} ========
    if (pathname.startsWith('/v/')) {
      const token = pathname.slice(3)
      const users = store.listUsers()
      let valid = false
      for (const u of users) {
        const meta = store.loadMeta(u.userId)
        if (meta.viewToken === token && !meta.viewTokenOld.includes(token)) { valid = true; break }
      }
      if (!valid) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>404</h1><p>链接无效或已吊销，请联系老板重新生成</p>')
        return
      }
      const html = fs.readFileSync(new URL('./view.html', import.meta.url).pathname, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // ======== GET /admin ========
    if (pathname === '/admin' || pathname === '/admin/') {
      const key = url.searchParams.get('key')
      if (!key || key !== ADMIN_KEY) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>401</h1><p>需要 ADMIN_KEY</p>')
        return
      }
      const html = fs.readFileSync(new URL('./admin.html', import.meta.url).pathname, 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }

    // ======== POST /admin/* (需要 admin key) ========
    if (pathname.startsWith('/admin/')) {
      const key = url.searchParams.get('key')
      if (!key || key !== ADMIN_KEY) return json(res, 401, { ok: false, error: '需要 ADMIN_KEY' })

      // 生成配对码
      if (pathname === '/admin/pair' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString())
        const userId = randomHex(16)
        store.initUser(userId)
        const code = store.createPairCode(userId)
        const meta = store.loadMeta(userId)
        meta.note = body.note || ''
        store.saveMeta(userId, meta)
        return json(res, 200, { ok: true, pairCode: code, userId })
      }

      // 吊销 viewToken
      if (pathname === '/admin/regen' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString())
        const userId = body.userId
        if (!userId) return json(res, 400, { ok: false, error: '缺少 userId' })
        const meta = store.loadMeta(userId)
        if (meta.viewToken) meta.viewTokenOld.push(meta.viewToken)
        meta.viewToken = randomHex(16)
        store.saveMeta(userId, meta)
        return json(res, 200, { ok: true, viewToken: meta.viewToken })
      }

      // 删除用户
      if (pathname === '/admin/delete' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString())
        if (!body.userId) return json(res, 400, { ok: false, error: '缺少 userId' })
        const dir = store.userDir(body.userId)
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
        return json(res, 200, { ok: true })
      }

      // 用户列表
      if (pathname === '/admin/users' && req.method === 'GET') {
        return json(res, 200, { ok: true, users: store.listUsers() })
      }
    }

    // ======== 404 ========
    json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    console.error('[cloud-server]', e.message)
    json(res, 500, { ok: false, error: e.message || 'internal error' })
  }
})

server.listen(PORT, () => {
  console.log(`[cloud-server] 云备份服务已启动，端口 ${PORT}`)
  if (!ADMIN_KEY) console.warn('[cloud-server] ⚠ 未设置 ADMIN_KEY')
})

process.on('SIGTERM', () => { server.close(); process.exit(0) })
process.on('SIGINT', () => { server.close(); process.exit(0) })
