// inbound.js: 入库页 —— 拍照建档 / 扫码入库 双入口 → 已入库印章
page('inbound', function (app) {
  let recentInbounds = []
  loadRecents()

  async function loadRecents() {
    try {
      const tx = await api('report:today')
      recentInbounds = (tx.recent || []).filter(t => t.type === 'in').slice(0, 10)
    } catch { recentInbounds = [] }
    render()
  }

  function render() {
    app.innerHTML = ''

    // 双按钮
    const row = document.createElement('div'); row.className = 'bigrow'
    const photo = document.createElement('button'); photo.className = 'big photo'
    photo.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28"><path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>拍照建档'
    photo.onclick = photoFlow
    const scan = document.createElement('button'); scan.className = 'big'
    scan.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫码入库'
    scan.onclick = () => openScanner(onScan, '扫条码入库')
    row.appendChild(photo); row.appendChild(scan)
    app.appendChild(row)

    // 搜索
    const searchDiv = document.createElement('div'); searchDiv.className = 'scanrow'
    const input = document.createElement('input'); input.className = 'search'; input.placeholder = '没有相机？打字搜或新建商品'
    input.style.width = '100%'; input.onchange = () => { const v = input.value.trim(); if (v) onScan(v) }
    searchDiv.appendChild(input)
    app.appendChild(searchDiv)

    // 建档表单（拍照或扫码后展开）
    const form = document.createElement('div'); form.className = 'form-card'; form.id = 'inbound-form'
    form.innerHTML =
      '<div class="ft"><b>新商品建档</b><span class="aitag" id="ai-tag">AI 已预填</span></div>' +
      '<div class="fld"><label>商品名称</label><input id="f-name" placeholder="例：伊势尼 8号钩"></div>' +
      '<div class="fldrow">' +
        '<div class="fld"><label>分类</label><select id="f-cat"><option>鱼钩</option><option>鱼线</option><option>饵料</option><option>鱼竿</option><option>浮漂</option><option>渔轮</option><option>路亚假饵</option><option>铅坠</option><option>渔网</option><option>钓箱钓椅</option><option>伞/遮阳</option><option>支架</option><option>服装穿戴</option><option>灯具</option><option>工具配件</option><option>收纳包具</option><option>增氧保鲜</option><option>活饵</option><option>小药</option><option>其他</option></select></div>' +
        '<div class="fld"><label>进价（元）</label><input id="f-cost" type="number" step="0.01" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="fld"><label>数量</label><input id="f-qty" type="number" placeholder="大概多少个？"><div class="tip">大概还有多少个？不准没关系，以后盘点会校正</div></div>' +
      '<button class="okbtn" id="f-ok">完成入库</button>'
    app.appendChild(form)

    document.getElementById('f-ok').onclick = finishInbound

    // 今日入库记录
    if (recentInbounds.length > 0) {
      const recTitle = document.createElement('div'); recTitle.className = 'sectitle'
      recTitle.innerHTML = '<span class="tag" style="background:var(--ink)">今日入库</span>'
      app.appendChild(recTitle)
      const recs = document.createElement('div'); recs.style.padding = '0 16px 14px'
      recentInbounds.forEach(t => {
        const name = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || '-'
        const time = (t.timestamp || '').slice(11, 16)
        const div = document.createElement('div'); div.className = 'rec'
        div.innerHTML =
          '<div class="ph" style="background:var(--green)">' + (name[0] || '?') + '</div>' +
          '<div class="info"><div class="n">' + name + '</div><div class="d">' + time + '</div></div>' +
          '<div class="q">+' + t.quantity + '</div>'
        recs.appendChild(div)
      })
      app.appendChild(recs)
    }
  }

  async function onScan(code) {
    if (!code) return
    try {
      const rows = await api('product:search', { keyword: code })
      if (!rows || rows.length === 0) { showCreateForm(code, null); return }
      const p = rows[0]
      const name = prodName(p)
      const qty = parseInt(prompt('「' + name + '」\n库存 ' + (p.total_stock || 0) + '，入多少个？', '1')) || 1
      if (qty <= 0) return
      const cost = prompt('进价多少元？', String((p.cost_price || 0) / 100))
      await api('inbound:create', { product_id: p.id, quantity: qty, cost_price: cost ? Math.round(parseFloat(cost) * 100) : p.cost_price, location: p.location || '', operator: '手机' })
      showStamp('已入库', name + ' × ' + qty, true)
      loadRecents()
    } catch (e) { toast('入库失败: ' + e.message) }
  }

  function showCreateForm(code, aiResult) {
    const form = document.getElementById('inbound-form')
    const aiTag = document.getElementById('ai-tag')
    document.getElementById('f-name').value = aiResult ? (aiResult.brand || '') + ' ' + (aiResult.model || '') : ''
    document.getElementById('f-cat').value = aiResult ? aiResult.category || '其他' : '其他'
    document.getElementById('f-cost').value = aiResult ? (aiResult.cost_price_yuan || '') : ''
    document.getElementById('f-qty').value = ''
    if (aiResult) { aiTag.classList.add('show') } else { aiTag.classList.remove('show') }
    form.classList.add('show')
    // 存 code 到临时属性
    form.setAttribute('data-code', code)
    document.getElementById('f-qty').focus()
  }

  async function photoFlow() {
    // 拍照 → 调 ai:photoDraft → 预填表单
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment'
    input.onchange = async function () {
      if (!input.files || !input.files[0]) return
      const file = input.files[0]
      const reader = new FileReader()
      reader.onload = async function () {
        const base64 = reader.result.split(',')[1]
        toast('AI 识别中…')
        try {
          const r = await api('ai:photoDraft', { imageBase64: base64, mimeType: file.type })
          if (r && r.ok && r.items && r.items.length > 0) {
            const item = r.items[0]
            showCreateForm(item.sku_code || '', {
              brand: item.brand, model: item.model, category: item.category,
              cost_price_yuan: item.cost_price_fen ? (item.cost_price_fen / 100).toFixed(2) : '',
            })
            toast('AI 已填好，你只需填数量')
          } else {
            showCreateForm('', null)
            toast('AI 识别失败，请手动填写')
          }
        } catch {
          showCreateForm('', null)
          toast('AI 不可用，请手动填写')
        }
      }
      reader.readAsDataURL(file)
    }
    input.click()
  }

  async function finishInbound() {
    const form = document.getElementById('inbound-form')
    const name = document.getElementById('f-name').value.trim()
    const cat = document.getElementById('f-cat').value
    const costStr = document.getElementById('f-cost').value
    const qty = parseInt(document.getElementById('f-qty').value) || 0
    if (!name) { toast('填个商品名就能入库了'); return }
    if (qty <= 0) { toast('填个数量'); return }
    const cost = costStr ? Math.round(parseFloat(costStr) * 100) : 0
    const code = form.getAttribute('data-code') || ''
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category: cat, brand: '', model: name,
        cost_price: cost, suggest_price: Math.round(cost * 1.5), status: '待盘点',
      })
      await api('inbound:create', { product_id: r.id, quantity: qty, cost_price: cost, location: '', operator: '手机' })
      showStamp('已入库', name + ' × ' + qty, true)
      form.classList.remove('show')
      document.getElementById('ai-tag').classList.remove('show')
      ;['f-name', 'f-cost', 'f-qty'].forEach(id => document.getElementById(id).value = '')
      loadRecents()
    } catch (e) { toast('入库失败: ' + e.message) }
  }

  render()
})
