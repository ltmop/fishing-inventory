// app.js: 手机端框架 —— 路由 / fetch / token / 组件
// 铁律：零外部依赖；所有写操作走 /api/invoke；AI 挂了不挡手填

// ========== Token & API ==========
const TOKEN = (function () {
  const p = new URLSearchParams(location.search)
  return p.get('token') || ''
})()

const SERVER = ''

async function api(channel, payload) {
  const r = await fetch(SERVER + '/api/invoke?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, payload: payload || {} }),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || '请求失败')
  return data.result
}

// ========== 路由 ==========
let currentPage = ''

function navigate(hash) {
  location.hash = hash
}

window.addEventListener('hashchange', renderPage)
document.addEventListener('DOMContentLoaded', renderPage)

function renderPage() {
  const hash = (location.hash || '#pos').replace('#', '')
  const page = hash || 'pos'
  if (page === currentPage) return
  currentPage = page
  // 更新底部导航
  document.querySelectorAll('.nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + page)
  })
  // 渲染页面
  const app = document.getElementById('app')
  app.innerHTML = '<div style="text-align:center;padding:40px;color:#999">加载中...</div>'
  const fn = pages[page]
  if (fn) {
    try { fn(app) } catch (e) { app.innerHTML = errPage(page + ' 页面加载出错', e.message) }
  } else {
    app.innerHTML = errPage('页面未找到', '没有这个功能')
  }
}

// ========== 工具 ==========
function el(tag, attrs, ...children) {
  const e = document.createElement(tag)
  if (attrs) Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'className') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v)
    else e.setAttribute(k, v)
  })
  children.forEach(c => {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c))
    else if (c instanceof Node) e.appendChild(c)
    else if (Array.isArray(c)) c.forEach(cc => e.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc))
  })
  return e
}

function $(sel) { return document.querySelector(sel) }
function $$(sel) { return document.querySelectorAll(sel) }

function fmt(cents, nullText) {
  if (cents === null || cents === undefined) return nullText || '-'
  return '¥' + (cents / 100).toFixed(2)
}

function errPage(title, detail) {
  return '<div class="err-page"><div class="icon">⚠️</div><div style="font-size:16px;font-weight:600;color:#ff4d4f">' + title + '</div><div class="text-sm text-muted mt">' + (detail || '') + '</div><div class="text-xs text-muted mt">请在电脑上操作此功能</div></div>'
}

// ========== 扫码模块 ==========
let scanCallback = null

function openScanner(callback, hint) {
  scanCallback = callback
  const overlay = document.getElementById('scan-overlay')
  if (!overlay) {
    // 动态创建扫码遮罩
    const div = document.createElement('div')
    div.id = 'scan-overlay'
    div.innerHTML = '<button class="scan-close" id="scan-close-btn">✕</button><video id="scan-video" autoplay playsinline></video><div class="scan-input"><input type="text" id="scan-manual" placeholder="或手动输入条码"><button id="scan-manual-btn">确认</button></div>'
    document.body.appendChild(div)
    document.getElementById('scan-close-btn').onclick = closeScanner
    document.getElementById('scan-manual-btn').onclick = () => {
      const v = document.getElementById('scan-manual').value.trim()
      if (v && scanCallback) { closeScanner(); scanCallback(v); }
    }
  }
  document.getElementById('scan-overlay').classList.add('show')
  document.getElementById('scan-manual').value = ''
  startScan()
}

function closeScanner() {
  const overlay = document.getElementById('scan-overlay')
  if (overlay) overlay.classList.remove('show')
  stopScan()
}

function startScan() {
  const video = document.getElementById('scan-video')
  if (!video) return
  // BarcodeDetector API (Chrome/Android)
  if ('BarcodeDetector' in window) {
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code'] })
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(stream => {
      video.srcObject = stream
      video.play()
      pollBarcode(detector, video, stream)
    }).catch(() => { scanFallback('摄像头不可用，请手动输入') })
  } else {
    scanFallback('此浏览器不支持扫码，请手动输入')
  }
}

let scanPollTimer = null
function pollBarcode(detector, video, stream) {
  if (!document.getElementById('scan-overlay').classList.contains('show')) { stopStream(stream); return }
  detector.detect(video).then(barcodes => {
    if (barcodes.length > 0 && scanCallback) {
      stopStream(stream)
      closeScanner()
      scanCallback(barcodes[0].rawValue)
      return
    }
    scanPollTimer = setTimeout(() => pollBarcode(detector, video, stream), 200)
  }).catch(() => {
    scanPollTimer = setTimeout(() => pollBarcode(detector, video, stream), 500)
  })
}

function stopScan() {
  if (scanPollTimer) { clearTimeout(scanPollTimer); scanPollTimer = null }
  const video = document.getElementById('scan-video')
  if (video && video.srcObject) stopStream(video.srcObject)
}

function stopStream(stream) {
  stream.getTracks().forEach(t => t.stop())
}

function scanFallback(msg) {
  const manual = document.getElementById('scan-manual')
  if (manual) manual.placeholder = msg
}

// ========== 页面注册 ==========
const pages = {}

function page(name, renderFn) {
  pages[name] = renderFn
}

// ========== 更多页 ==========
page('more', (app) => {
  app.innerHTML = ''
  const items = [
    ['⚠️ 补货清单', '低库存 + 补货建议', () => navigate('restock')],
    ['👤 客户欠款', '赊账查询与收款', () => navigate('customers')],
    ['🏭 供应商', '进货对账', () => navigate('suppliers')],
    ['📋 核对货架', '每天核对一片区域', () => navigate('stocktake')],
  ]
  items.map(([title, desc, onclick]) => {
    const card = el('div', { className: 'card', onclick }, [
      el('div', { className: 'font-bold text-lg' }, title),
      el('div', { className: 'text-sm text-muted mt-sm' }, desc),
    ])
    app.appendChild(card)
  })
  app.appendChild(el('div', { className: 'text-center text-xs text-muted mt', style: 'padding:20px' }, '更多功能请在电脑上操作'))
})

// ========== 启动 ==========
renderPage()
