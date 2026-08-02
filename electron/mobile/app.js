// app.js: 手机端框架 —— 路由 / fetch / token / 组件 / 印章动画 / toast
// 视觉：阿东渔具 · 纸质感 · 贴纸收款键 · 印章反馈

const TOKEN = (() => { const p = new URLSearchParams(location.search); return p.get('token') || '' })()
const SERVER = ''
const COLORS = ["#0e9f6e","#b7791f","#1677ff","#7c3aed","#d64545","#0e7490","#be185d","#3f6212","#9a3412"]

async function api(channel, payload) {
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

function openScanner(cb, hint) {
  scanCallback = cb
  if ('BarcodeDetector' in window) {
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code'] })
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(stream => {
      const overlay = document.createElement('div')
      overlay.id = 'scanner-overlay'
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#000;z-index:200;display:flex;flex-direction:column'
      overlay.innerHTML = '<button style="position:absolute;top:16px;right:16px;width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.2);color:#fff;border:none;font-size:20px;cursor:pointer;z-index:10">✕</button><video autoplay playsinline style="flex:1;object-fit:cover"></video><div style="position:absolute;bottom:80px;left:16px;right:16px;display:flex;gap:8px"><input id="scan-manual" placeholder="或手动输入条码" style="flex:1;padding:12px;border-radius:10px;border:none;font-size:16px"><button id="scan-manual-btn" style="padding:12px 18px;border-radius:10px;border:none;background:var(--blue);color:#fff;font-size:14px;cursor:pointer">确认</button></div>'
      document.body.appendChild(overlay)
      overlay.querySelector('button').onclick = () => { closeScanner(); stopStream(stream) }
      document.getElementById('scan-manual-btn').onclick = () => { const v = document.getElementById('scan-manual').value.trim(); if (v && scanCallback) { closeScanner(); stopStream(stream); scanCallback(v) } }
      overlay.querySelector('video').srcObject = stream
      overlay.querySelector('video').play()
      poll(detector, overlay.querySelector('video'), stream)
    }).catch(() => { const v = prompt('摄像头不可用，请手动输入条码'); if (v && scanCallback) scanCallback(v) })
  } else {
    const v = prompt('此浏览器不支持扫码，请手动输入条码'); if (v && scanCallback) scanCallback(v)
  }
}

let pollTimer
function poll(detector, video, stream) {
  if (!document.getElementById('scanner-overlay')) { stopStream(stream); return }
  detector.detect(video).then(barcodes => {
    if (barcodes.length > 0 && scanCallback) {
      stopStream(stream); closeScanner(); scanCallback(barcodes[0].rawValue); return
    }
    pollTimer = setTimeout(() => poll(detector, video, stream), 200)
  }).catch(() => { pollTimer = setTimeout(() => poll(detector, video, stream), 500) })
}

function closeScanner() {
  const el = document.getElementById('scanner-overlay'); if (el) { el.remove(); scanCallback = null }
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
}

function stopStream(stream) { stream.getTracks().forEach(t => t.stop()) }

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
