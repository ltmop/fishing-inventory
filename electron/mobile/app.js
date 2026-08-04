// app.js: 手机端框架 —— 路由 / fetch / token / 组件 / 印章动画 / toast
// 视觉：阿东渔具 · 纸质感 · 贴纸收款键 · 印章反馈

// token 持久化：优先从 URL 拿（扫码打开时带 token），其次从 localStorage 取（上次记住的），
// 都没有才提示重新扫码。首次扫码打开时自动记住，之后关闭页面/加到主屏幕都能直接重开。
const TOKEN = (() => {
  const fromUrl = new URLSearchParams(location.search).get('token')
  if (fromUrl) {
    try { localStorage.setItem('fi-mobile-token', fromUrl) } catch { /* 存不住不致命 */ }
    return fromUrl
  }
  try { return localStorage.getItem('fi-mobile-token') || '' } catch { return '' }
})()
const SERVER = ''
const COLORS = ["#0e9f6e","#b7791f","#1677ff","#7c3aed","#d64545","#0e7490","#be185d","#3f6212","#9a3412"]

async function api(channel, payload) {
  if (!TOKEN) throw new Error('未连接电脑，请回到设置页扫码进入手机端')
  const r = await fetch(SERVER + '/api/invoke?token=' + TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, payload: payload || {} }),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || '请求失败')
  return data.result
}

let currentPage = ''
function navigate(hash) { location.hash = hash }
window.addEventListener('hashchange', renderPage)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('dateEl').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  renderPage()
})

function renderPage() {
  const hash = (location.hash || '#pos').replace('#', '')
  const page = hash || 'pos'
  if (page === currentPage) return
  currentPage = page
  document.querySelectorAll('.tab').forEach(a => {
    a.classList.toggle('on', a.getAttribute('href') === '#' + page)
  })
  const app = document.getElementById('app')
  app.innerHTML = '<div class="text-center" style="padding:40px;color:var(--sub)">加载中...</div>'
  const fn = pages[page]
  if (fn) { try { fn(app) } catch (e) { app.innerHTML = '<div class="text-center" style="padding:40px"><div style="font-size:48px">⚠️</div><div class="text-red font-bold mt">' + page + ' 出错</div><div class="text-sm text-muted mt-sm">' + e.message + '</div></div>' } }
  else { app.innerHTML = '<div class="text-center" style="padding:40px"><div style="font-size:48px">⚠️</div><div class="font-bold mt">页面未找到</div></div>' }
}

// ========== 印章动画 ==========
function showStamp(text, detail, isGreen) {
  const el = document.getElementById('doneStamp'), sa = document.getElementById('stampA'), sb = document.getElementById('stampB'), se = document.getElementById('stampEl')
  sa.textContent = text
  sb.textContent = detail || ''
  se.classList.toggle('green', !!isGreen)
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 1300)
}

// ========== Toast ==========
let tt
function toast(msg) {
  const el = document.getElementById('toastEl')
  el.textContent = msg; el.classList.add('show')
  clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), 1500)
}

// ========== 工具 ==========
function fmt(cents, nullText) {
  if (cents === null || cents === undefined) return nullText || '-'
  const v = cents / 100
  return '¥' + (v % 1 ? v.toFixed(2) : v.toFixed(0))
}

function phColor(p) { return COLORS[(p.id || 0) % COLORS.length] }
function phChar(p) { const name = (p.brand || '') + (p.model || '') || p.sku_code || ''; return name[0] || '?' }
function prodName(p) { return (p.brand || '') + ' ' + (p.model || '') || p.sku_code || '未知' }

// ========== 扫码 ==========
let scanCallback = null

// 扫码：拍照解析条码。用 <input capture> 调起相机拍照，再本地解析——
// 不依赖 getUserMedia（局域网 HTTP 非安全环境会禁用摄像头扫码），店里 WiFi 下也能用。
function openScanner(cb, hint) {
  scanCallback = cb
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.capture = 'environment'
  input.onchange = function () {
    if (!input.files || !input.files[0]) return
    const file = input.files[0]
    const reader = new FileReader()
    reader.onload = function () {
      const img = new Image()
      img.onload = async function () {
        try {
          const code = await decodeBarcode(img)
          if (code && scanCallback) { closeScanner(); scanCallback(code) }
          else manualFallback('没识别出条码，手动输一下')
        } catch (e) { manualFallback('识别失败，手动输一下') }
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  }
  input.click()
}

async function decodeBarcode(img) {
  // 优先浏览器原生 BarcodeDetector（Chrome 支持，能解析图片）
  if ('BarcodeDetector' in window) {
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code'] })
    const codes = await detector.detect(img)
    if (codes.length > 0) return codes[0].rawValue
  }
  // 兜底：本地 zxing 解析（离线打包，不依赖网络/安全上下文）
  if (window.ZXing) {
    const reader = new ZXing.BrowserMultiFormatReader()
    const result = await reader.decodeFromImageElement(img)
    return result ? result.getText() : null
  }
  throw new Error('no decoder')
}

function manualFallback(hint) {
  const v = prompt(hint || '请输入条码')
  if (v && scanCallback) { closeScanner(); scanCallback(v) }
}

function closeScanner() {
  scanCallback = null
}

// ========== 页面注册 ==========
const pages = {}
function page(name, fn) { pages[name] = fn }

page('more', (app) => {
  app.innerHTML = ''
  const items = [
    ['⚠️ 补货清单', '低库存 + 补货建议', () => navigate('restock')],
    ['👤 客户欠款', '赊账查询与收款', () => navigate('customers')],
    ['🏭 供应商', '进货对账', () => navigate('suppliers')],
    ['📋 核对货架', '每天核对一片区域', () => navigate('stocktake')],
  ]
  items.forEach(([t, d, fn]) => {
    const card = document.createElement('div')
    card.className = 'card'; card.style.cursor = 'pointer'; card.onclick = fn
    card.innerHTML = '<div class="font-bold">' + t + '</div><div class="text-sm text-muted mt-sm">' + d + '</div>'
    app.appendChild(card)
  })
  const note = document.createElement('div')
  note.className = 'text-center text-sm text-muted'; note.style.padding = '20px'
  note.textContent = '更多功能请在电脑上操作'
  app.appendChild(note)
})

renderPage()
