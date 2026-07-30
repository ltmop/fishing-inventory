// 局域网只读 HTTP 服务：老板手机连店里同一个 WiFi，微信扫码看账
// 零依赖（Node 内置 http），不 import electron，db/dataDir 注入，可被 scripts/test-backend.mjs 直接单测
// 安全基线：随机 token 鉴权（401）+ 路径白名单（404）+ GET only（405）+ 不解析请求体
//           + 每 IP 120 次/分钟速率限制（429）+ 安全响应头；API 全程只读不写库
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const DEFAULT_PORT = 17532
const MAX_PORT_RETRY = 10
// 与 DashboardPage 的 LOW_STOCK_THRESHOLD 保持一致
const LOW_STOCK_THRESHOLD = 5
const RATE_LIMIT_PER_MIN = 120

// ---------- 统计查询（口径参照 DashboardPage：金额单位分，退货冲减营业额/毛利） ----------

/** 本地今日 00:00 ~ 明日 00:00 的 UTC ISO 区间（transactions.timestamp 存 UTC ISO） */
function todayRange() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}

function querySummary(db) {
  const [from, to] = todayRange()
  const txs = db
    .prepare(
      `SELECT type, quantity, unit_price, selling_price, notes FROM transactions
       WHERE timestamp >= ? AND timestamp < ?`,
    )
    .all(from, to)
  let todayRevenue = 0
  let todayProfit = 0
  let todayInQty = 0
  let todayOutQty = 0
  for (const t of txs) {
    if (t.type === 'in') {
      todayInQty += t.quantity
    } else if (t.type === 'out') {
      todayOutQty += t.quantity
      // 换货出新腿也是正常 out，与桌面端同口径自动涵盖
      if (t.selling_price != null) todayRevenue += t.selling_price * t.quantity
      if (t.selling_price != null && t.unit_price != null) {
        todayProfit += (t.selling_price - t.unit_price) * t.quantity
      }
    } else if (t.type === 'return' && t.notes !== '换货退旧') {
      // 退货按负收入冲减营业额和毛利（换货退旧腿不冲减，与桌面端一致）
      if (t.selling_price != null) todayRevenue -= t.selling_price * t.quantity
      if (t.selling_price != null && t.unit_price != null) {
        todayProfit -= (t.selling_price - t.unit_price) * t.quantity
      }
    }
  }
  const totalSku = db.prepare('SELECT COUNT(*) AS n FROM products').get().n
  const stock = db
    .prepare('SELECT COALESCE(SUM(quantity),0) AS q, COALESCE(SUM(quantity * cost_price),0) AS v FROM inventory_batches')
    .get()
  const lowStockCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM products p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s
         ON s.product_id = p.id
       WHERE COALESCE(s.q, 0) < ?`,
    )
    .get(LOW_STOCK_THRESHOLD).n
  return {
    todayRevenue,
    todayProfit,
    todayInQty,
    todayOutQty,
    totalSku,
    totalStock: stock.q,
    stockValue: stock.v,
    lowStockCount,
  }
}

/** 低库存商品列表（总库存 < 5，升序，最缺的在前） */
function queryLowStock(db) {
  return db
    .prepare(
      `SELECT p.brand, p.model, p.sku_code, p.location, COALESCE(s.q, 0) AS stock
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s
         ON s.product_id = p.id
       WHERE COALESCE(s.q, 0) < ?
       ORDER BY stock ASC, p.id ASC`,
    )
    .all(LOW_STOCK_THRESHOLD)
    .map((r) => ({
      name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
      sku: r.sku_code,
      stock: r.stock,
      location: r.location,
    }))
}

/** 库存搜索：关键词匹配品牌/型号/SKU/条码（LIKE 通配符转义），老板在仓库找货用 */
function queryInventory(db, q) {
  const keyword = String(q ?? '').trim()
  if (!keyword) return []
  const like = `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  return db
    .prepare(
      `SELECT p.brand, p.model, p.sku_code, p.location, p.cost_price, COALESCE(s.q, 0) AS stock
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s
         ON s.product_id = p.id
       WHERE p.brand LIKE ? ESCAPE '\\' OR p.model LIKE ? ESCAPE '\\'
          OR p.sku_code LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\'
       ORDER BY p.id ASC
       LIMIT 50`,
    )
    .all(like, like, like, like)
    .map((r) => ({
      name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
      sku: r.sku_code,
      stock: r.stock,
      costPrice: r.cost_price,
      location: r.location,
    }))
}

/** 今日出入库流水（最近 50 条，金额：出库/退货记售价、入库记成本价，单位分） */
function queryToday(db) {
  const [from, to] = todayRange()
  return db
    .prepare(
      `SELECT t.type, t.quantity, t.unit_price, t.selling_price, t.timestamp, t.notes,
              p.brand, p.model, p.sku_code
       FROM transactions t
       LEFT JOIN products p ON p.id = t.product_id
       WHERE t.timestamp >= ? AND t.timestamp < ?
       ORDER BY t.timestamp DESC, t.id DESC
       LIMIT 50`,
    )
    .all(from, to)
    .map((r) => ({
      time: r.timestamp,
      type: r.type,
      name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code || '',
      sku: r.sku_code ?? '',
      quantity: r.quantity,
      amount:
        r.type === 'in'
          ? r.unit_price != null
            ? r.unit_price * r.quantity
            : null
          : r.selling_price != null
            ? r.selling_price * r.quantity
            : null,
    }))
}

// ---------- 手机端页面（单文件 HTML，fetch 自动带 URL 里的 token） ----------

const MOBILE_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#1e3a5f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>渔具库存 · 手机看店</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f0f4f9; color: #1f2937; padding-bottom: 32px; }
  header { background: linear-gradient(135deg, #1e3a5f, #1d4ed8); color: #fff; padding: 20px 16px 40px; }
  header h1 { font-size: 20px; font-weight: 700; }
  header .sub { font-size: 12px; opacity: .75; margin-top: 4px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 16px; margin-top: -24px; }
  .card { background: #fff; border-radius: 14px; padding: 16px; box-shadow: 0 2px 8px rgba(30,58,95,.08); }
  .card .label { font-size: 13px; color: #64748b; }
  .card .value { font-size: 26px; font-weight: 700; margin-top: 6px; font-variant-numeric: tabular-nums; color: #1e3a5f; }
  .card .value.green { color: #15803d; }
  .section { margin: 20px 16px 0; }
  .section h2 { font-size: 16px; font-weight: 700; margin-bottom: 10px; color: #1e3a5f; }
  .row { background: #fff; border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(30,58,95,.06); }
  .row .name { font-size: 15px; font-weight: 600; }
  .row .meta { font-size: 12px; color: #94a3b8; margin-top: 2px; font-family: monospace; }
  .row .num { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .num.red { color: #dc2626; }
  .num.blue { color: #1d4ed8; }
  .badge { display: inline-block; font-size: 11px; border-radius: 4px; padding: 1px 6px; margin-right: 6px; }
  .badge.out { background: #fee2e2; color: #dc2626; }
  .badge.in { background: #dcfce7; color: #15803d; }
  .badge.return { background: #fef3c7; color: #b45309; }
  .search { width: 100%; font-size: 16px; padding: 12px 14px; border: 2px solid #1d4ed8; border-radius: 12px; outline: none; margin-bottom: 10px; }
  .empty { text-align: center; color: #94a3b8; font-size: 13px; padding: 18px 0; }
  .err { margin: 20px 16px; background: #fee2e2; color: #b91c1c; border-radius: 10px; padding: 14px; font-size: 14px; }
  .time { font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<header>
  <h1>渔具库存 · 手机看店</h1>
  <div class="sub" id="updated">数据加载中…</div>
</header>

<div class="cards">
  <div class="card"><div class="label">今日营业额</div><div class="value" id="v-revenue">-</div></div>
  <div class="card"><div class="label">今日毛利</div><div class="value green" id="v-profit">-</div></div>
  <div class="card"><div class="label">今日入库</div><div class="value" id="v-in">-</div></div>
  <div class="card"><div class="label">今日出库</div><div class="value" id="v-out">-</div></div>
</div>

<div class="section">
  <h2>低库存预警</h2>
  <div id="lowstock"><div class="empty">加载中…</div></div>
</div>

<div class="section">
  <h2>查库存（输入品牌/型号/SKU/条码）</h2>
  <input class="search" id="q" type="search" placeholder="比如：光威、赤刃、JC-FG" autocomplete="off">
  <div id="result"></div>
</div>

<div class="section">
  <h2>今日流水</h2>
  <div id="today"><div class="empty">加载中…</div></div>
</div>

<script>
var token = new URLSearchParams(location.search).get('token') || '';
function api(path) {
  var sep = path.indexOf('?') >= 0 ? '&' : '?';
  return fetch(path + sep + 'token=' + encodeURIComponent(token)).then(function (r) {
    if (r.status === 401) throw new Error('访问密码不对，请用店里电脑上最新的二维码重新扫码打开');
    if (!r.ok) throw new Error('加载失败（' + r.status + '），请确认手机连着店里的 WiFi');
    return r.json();
  });
}
function yuan(fen) { return fen == null ? '-' : '¥' + (fen / 100).toFixed(2); }
function esc(s) { return String(s == null ? '' : s); }
function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstChild; }

function addRow(box, name, meta, numHtml) {
  var row = document.createElement('div');
  row.className = 'row';
  var left = document.createElement('div');
  var n = document.createElement('div'); n.className = 'name'; n.textContent = name;
  var m = document.createElement('div'); m.className = 'meta'; m.textContent = meta || '';
  left.appendChild(n); left.appendChild(m);
  var right = document.createElement('div'); right.className = 'num'; right.innerHTML = numHtml;
  row.appendChild(left); row.appendChild(right);
  box.appendChild(row);
}

function loadSummary() {
  api('/api/summary').then(function (s) {
    document.getElementById('v-revenue').textContent = yuan(s.todayRevenue);
    document.getElementById('v-profit').textContent = yuan(s.todayProfit);
    document.getElementById('v-in').textContent = '+' + s.todayInQty;
    document.getElementById('v-out').textContent = '-' + s.todayOutQty;
    document.getElementById('updated').textContent =
      '库存 ' + s.totalStock + ' 件 · 库存总值 ' + yuan(s.stockValue) + ' · 更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }).catch(showErr);
}
function loadLowStock() {
  api('/api/low-stock').then(function (items) {
    var box = document.getElementById('lowstock');
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = '<div class="empty">库存都充足，没有预警</div>'; return; }
    items.forEach(function (it) {
      addRow(box, it.name, it.sku + (it.location ? ' · ' + it.location : ''),
        '<span class="red">剩 ' + it.stock + '</span>');
    });
  }).catch(showErr);
}
var TYPE_LABEL = { in: '入库', out: '出库', return: '退货', exchange: '换货' };
function loadToday() {
  api('/api/today').then(function (items) {
    var box = document.getElementById('today');
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = '<div class="empty">今天还没有出入库记录</div>'; return; }
    items.slice(0, 20).forEach(function (t) {
      var d = new Date(t.time);
      var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      var cls = t.type === 'out' ? 'out' : t.type === 'in' ? 'in' : 'return';
      var sign = t.type === 'in' ? '+' : t.type === 'return' ? '−' : '−';
      addRow(box, t.name, hm + ' · ' + t.sku,
        '<span class="badge ' + cls + '">' + (TYPE_LABEL[t.type] || t.type) + '</span>' +
        '<span class="' + (t.type === 'in' ? 'blue' : '') + '">' + sign + t.quantity + '</span>' +
        (t.amount != null ? '<div class="time">' + yuan(t.amount) + '</div>' : ''));
    });
  }).catch(showErr);
}
var searchTimer = null;
document.getElementById('q').addEventListener('input', function (e) {
  clearTimeout(searchTimer);
  var q = e.target.value.trim();
  if (!q) { document.getElementById('result').innerHTML = ''; return; }
  searchTimer = setTimeout(function () {
    api('/api/inventory?q=' + encodeURIComponent(q)).then(function (items) {
      var box = document.getElementById('result');
      box.innerHTML = '';
      if (!items.length) { box.innerHTML = '<div class="empty">没搜到，换个关键词试试</div>'; return; }
      items.forEach(function (it) {
        addRow(box, it.name, it.sku + ' · ' + yuan(it.costPrice),
          '<span class="' + (it.stock < 5 ? 'red' : 'blue') + '">' + it.stock + ' 件</span>' +
          (it.location ? '<div class="time">' + esc(it.location) + '</div>' : ''));
      });
    }).catch(showErr);
  }, 300);
});
function showErr(e) {
  var old = document.querySelector('.err');
  if (old) old.remove();
  var d = document.createElement('div');
  d.className = 'err';
  d.textContent = e.message;
  document.body.appendChild(d);
}
function loadAll() { loadSummary(); loadLowStock(); loadToday(); }
loadAll();
setInterval(loadAll, 30000);
</script>
</body>
</html>`

// ---------- 服务实例 ----------

/**
 * 创建局域网只读服务实例。
 * @param {{ db: import('node:sqlite').DatabaseSync, dataDir: string, basePort?: number }} opts
 *   db 注入业务库连接（照 commands.js 模式）；dataDir 用于存 token 与开关配置
 */
export function createInventoryServer({ db, dataDir, basePort = DEFAULT_PORT }) {
  const tokenPath = path.join(dataDir, 'server-token.txt')
  const configPath = path.join(dataDir, 'server-config.json')
  let server = null
  let port = null
  let token = null
  let lastError = null
  // 速率限制：ip → 最近一分钟内的请求时间戳
  const hits = new Map()

  function loadConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      return { enabled: c.enabled !== false }
    } catch {
      return { enabled: true } // 默认开启
    }
  }

  function saveConfig(enabled) {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify({ enabled }), 'utf8')
    } catch (e) {
      console.error('[server] 配置写入失败:', e)
    }
  }

  /** 首次启动生成 32 位随机 token，之后从文件复用；文件权限收紧为仅本人可读写 */
  function loadOrCreateToken() {
    try {
      const t = fs.readFileSync(tokenPath, 'utf8').trim()
      if (/^[0-9a-f]{32}$/.test(t)) return t
    } catch {
      // 文件不存在或读不了：走生成流程
    }
    const t = crypto.randomBytes(16).toString('hex')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(tokenPath, t, { mode: 0o600 })
    return t
  }

  function regenerateToken() {
    token = crypto.randomBytes(16).toString('hex')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(tokenPath, token, { mode: 0o600 })
    return status()
  }

  function tokenOk(provided) {
    if (!provided || !token) return false
    const a = Buffer.from(String(provided))
    const b = Buffer.from(token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  function rateLimited(ip) {
    const nowMs = Date.now()
    const cutoff = nowMs - 60_000
    const list = (hits.get(ip) ?? []).filter((t) => t > cutoff)
    if (list.length >= RATE_LIMIT_PER_MIN) {
      hits.set(ip, list)
      return true
    }
    list.push(nowMs)
    hits.set(ip, list)
    return false
  }

  /** 第一个非内部 IPv4 地址（手机访问用）；拿不到回退 127.0.0.1 */
  function lanIp() {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === 'IPv4' && !ni.internal) return ni.address
      }
    }
    return '127.0.0.1'
  }

  const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  }

  function sendJson(res, code, data) {
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  function handle(req, res) {
    // GET only：写方法一律 405，请求体从不解析
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (rateLimited(req.socket.remoteAddress ?? 'unknown')) {
      sendJson(res, 429, { error: 'too many requests' })
      return
    }
    // 路径严格白名单：URL 解析后精确匹配，不存在路径穿越问题
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      res.end(MOBILE_PAGE)
      return
    }
    const ROUTES = {
      '/api/summary': () => querySummary(db),
      '/api/low-stock': () => queryLowStock(db),
      '/api/inventory': () => queryInventory(db, url.searchParams.get('q')),
      '/api/today': () => queryToday(db),
    }
    const route = ROUTES[url.pathname]
    if (!route) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    // token 鉴权：?token= 或 x-token / Authorization: Bearer 头
    const provided =
      url.searchParams.get('token') ??
      req.headers['x-token'] ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : null)
    if (!tokenOk(provided)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    sendJson(res, 200, route())
  }

  /** 端口被占用时 +1 重试，最多 10 次；basePort=0 由系统分配（测试用） */
  function tryListen(p, attemptsLeft) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        try {
          handle(req, res)
        } catch (e) {
          console.error('[server] 请求处理异常:', e)
          try {
            sendJson(res, 500, { error: 'internal error' })
          } catch {
            // 连接已断开等情况，忽略
          }
        }
      })
      s.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attemptsLeft > 0 && p !== 0) {
          resolve(tryListen(p + 1, attemptsLeft - 1))
        } else {
          reject(e)
        }
      })
      s.listen(p, '0.0.0.0', () => {
        s.removeAllListeners('error')
        resolve({ server: s, port: s.address().port })
      })
    })
  }

  async function start() {
    if (server) return status()
    if (!loadConfig().enabled) return status()
    token = loadOrCreateToken()
    try {
      const r = await tryListen(basePort, MAX_PORT_RETRY - 1)
      server = r.server
      port = r.port
      lastError = null
      console.log(`[server] 手机看店服务已启动：http://${lanIp()}:${port}`)
    } catch (e) {
      lastError = e.message
      console.error('[server] 启动失败:', e)
    }
    return status()
  }

  async function stop() {
    if (!server) return status()
    const s = server
    server = null
    port = null
    await new Promise((resolve) => s.close(resolve))
    return status()
  }

  async function setEnabled(enabled) {
    saveConfig(enabled)
    if (enabled) return start()
    return stop()
  }

  function status() {
    const enabled = loadConfig().enabled
    const running = server !== null
    return {
      enabled,
      running,
      port: running ? port : null,
      ip: lanIp(),
      url: running ? `http://${lanIp()}:${port}/?token=${token}` : null,
      error: lastError,
    }
  }

  return { start, stop, setEnabled, regenerateToken, status }
}
