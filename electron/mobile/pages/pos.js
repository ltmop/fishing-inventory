// pos.js: 开单页 —— 扫码/搜索/热销榜 → 购物车 → 贴纸四键结账 → 收讫印章
page('pos', function (app) {
  const cart = []
  let hotProducts = []
  let busy = false
  let searchTimer = null

  loadHot()

  async function loadHot() {
    try { hotProducts = await api('report:hotSellers', { days: 30 }) } catch { hotProducts = [] }
    render()
  }

  function render() {
    app.innerHTML = ''

    // 扫码 + 搜索
    const scanrow = document.createElement('div'); scanrow.className = 'scanrow'
    const scanbtn = document.createElement('button'); scanbtn.className = 'scanbtn'
    scanbtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫 码'
    scanbtn.onclick = () => openScanner(handleScan, '扫条码或手输商品')
    const search = document.createElement('input'); search.className = 'search'; search.placeholder = '打字搜：品名 / 型号 / 条码'
    search.oninput = function (e) {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        const kw = e.target.value.trim()
        if (kw.length >= 2) handleSearch(kw)
      }, 300)
    }
    scanrow.appendChild(scanbtn); scanrow.appendChild(search)
    app.appendChild(scanrow)
    const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = '人多时直接点下面热销榜，不用搜索'
    app.appendChild(hint)

    // 热销榜
    if (hotProducts.length > 0) {
      const title = document.createElement('div'); title.className = 'sectitle'
      title.innerHTML = '<span class="tag">本店热销</span><span>近30天卖得最多 · 点图加单</span>'
      app.appendChild(title)
      const grid = document.createElement('div'); grid.className = 'grid'
      hotProducts.forEach(p => {
        const card = document.createElement('div'); card.className = 'hot'; card.onclick = () => addToCart(p)
        const inCart = cart.filter(c => c.product_id === p.id).reduce((s, c) => s + c.qty, 0)
        card.innerHTML = (inCart > 0 ? '<div class="badge">' + inCart + '</div>' : '') +
          '<div class="ph" style="background:' + phColor(p) + '">' + phChar(p) + '</div>' +
          '<div class="nm">' + prodName(p) + '</div>' +
          '<div class="pr">' + fmt(p.suggest_price) + '</div>'
        grid.appendChild(card)
      })
      app.appendChild(grid)
    }

    // 购物车
    const cartDiv = document.createElement('div'); cartDiv.className = 'cart'
    cartDiv.innerHTML = '<h3>购物清单</h3>'
    if (cart.length === 0) {
      cartDiv.innerHTML += '<div class="empty">扫码或点热销榜加商品</div>'
    } else {
      cart.forEach(c => {
        const name = prodName(c.product)
        const line = document.createElement('div'); line.className = 'line'
        line.innerHTML =
          '<div class="ph" style="background:' + phColor(c.product) + '">' + phChar(c.product) + '</div>' +
          '<div class="info"><div class="n">' + name + '</div><div class="p">' + fmt(c.selling_price) + '</div></div>' +
          '<div class="qty"><button onclick="void(0)">−</button><span class="n">' + c.qty + '</span><button onclick="void(0)">+</button></div>'
        line.querySelectorAll('button')[0].onclick = () => { c.qty--; if (c.qty <= 0) cart.splice(cart.indexOf(c), 1); render() }
        line.querySelectorAll('button')[1].onclick = () => { c.qty++; render() }
        cartDiv.appendChild(line)
      })
    }
    app.appendChild(cartDiv)

    // 结账
    const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
    const chk = document.createElement('div'); chk.className = 'checkout'
    chk.innerHTML = '<div class="total"><span class="t">合计</span><span class="v">' + fmt(totalFen) + '</span></div>' +
      '<div class="payrow">' +
        '<button class="pay cash">现金</button>' +
        '<button class="pay wx">微信</button>' +
        '<button class="pay ali">支付宝</button>' +
        '<button class="pay credit">赊账</button>' +
      '</div>'
    if (!busy && cart.length > 0) {
      chk.querySelector('.pay.cash').onclick = () => checkout('现金')
      chk.querySelector('.pay.wx').onclick = () => checkout('微信')
      chk.querySelector('.pay.ali').onclick = () => checkout('支付宝')
      chk.querySelector('.pay.credit').onclick = () => creditCheckout()
    }
    app.appendChild(chk)
  }

  function addToCart(p) {
    const existing = cart.find(c => c.product_id === p.id)
    if (existing) { existing.qty++ }
    else { cart.push({ product_id: p.id, product: p, qty: 1, selling_price: p.suggest_price || p.cost_price || 0 }) }
    render()
  }

  async function handleScan(code) {
    if (!code) return
    try {
      const rows = await api('product:search', { keyword: code })
      if (!rows || rows.length === 0) {
        const p = await createOnTheFly(code); if (p) addToCart(p); return
      }
      addToCart(rows[0])
    } catch (e) { toast('查找失败: ' + e.message) }
  }

  async function handleSearch(kw) {
    try {
      const rows = await api('product:search', { keyword: kw })
      if (rows && rows.length > 0) addToCart(rows[0])
      else toast('没找到「' + kw + '」，扫码试试')
    } catch { toast('搜索失败') }
  }

  async function createOnTheFly(code) {
    const name = prompt('这个商品叫什么名字？（选填）', code)
    if (!name) return null
    // 进价必须填真实的，不能瞎猜——否则毛利报表全是错的
    const costStr = prompt('进价多少元？（毛利就靠它算，别乱填）', '')
    if (!costStr || !(parseFloat(costStr) > 0)) { toast('得填个真实进价，毛利才算得准'); return null }
    const cost = Math.round(parseFloat(costStr) * 100)
    const priceStr = prompt('卖多少钱？（元）例如 85', '')
    const price = priceStr ? Math.round(parseFloat(priceStr) * 100) : 0
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category: '其他', brand: '', model: name,
        cost_price: cost, suggest_price: price, status: '待盘点',
      })
      const qty = parseInt(prompt('大概多少个？不准没关系，以后盘点会校正', '1')) || 1
      await api('inbound:create', { product_id: r.id, quantity: qty, cost_price: cost, location: '', operator: '手机' })
      return { id: r.id, sku_code: code, brand: '', model: name, suggest_price: price, cost_price: cost }
    } catch (e) { toast('新建失败: ' + e.message); return null }
  }

  async function checkout(method) {
    if (cart.length === 0 || busy) return
    busy = true; render()
    try {
      await api('outbound:checkout', {
        items: cart.map(c => ({ product_id: c.product_id, quantity: c.qty, selling_price: c.selling_price })),
        method: method, operator: '手机',
      })
      const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
      showStamp('收讫', fmt(totalFen) + ' · ' + method, false)
      cart.length = 0
    } catch (e) { toast('结账失败: ' + e.message) } finally { busy = false; render() }
  }

  async function creditCheckout() {
    if (cart.length === 0 || busy) return
    try {
      const list = await api('customer:list')
      openCustomerPanel(list, async (customer) => {
        busy = true; render()
        const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
        try {
          await api('outbound:checkout', {
            items: cart.map(c => ({ product_id: c.product_id, quantity: c.qty, selling_price: c.selling_price })),
            method: '微信', operator: '手机',
            customer_id: customer.id, paid_amount: 0,
          })
          showStamp('已赊', fmt(totalFen) + ' · ' + customer.name, false)
          cart.length = 0
        } catch (e) { toast('赊账失败: ' + e.message) }
        finally { busy = false; render() }
      })
    } catch (e) { toast('加载客户失败: ' + e.message) }
  }

  // 客户选择面板：点选老客户，或新建客户（不用手打字找）
  function openCustomerPanel(list, onSelect) {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,22,40,.95);z-index:300;display:flex;flex-direction:column;padding:20px;color:#e6edf5'
    overlay.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
        '<div style="font-size:20px;font-weight:700">赊给谁？</div>' +
        '<button id="cust-close" style="width:40px;height:40px;border-radius:20px;background:rgba(255,255,255,.12);color:#fff;border:none;font-size:20px">✕</button>' +
      '</div>' +
      '<div id="cust-list" style="flex:1;overflow:auto"></div>' +
      '<button id="cust-new" style="height:56px;border-radius:14px;border:none;background:linear-gradient(135deg,#c9a55a,#d4af37);color:#0a1628;font-size:18px;font-weight:800;margin-top:10px">➕ 新建客户</button>'
    document.body.appendChild(overlay)
    document.getElementById('cust-close').onclick = () => overlay.remove()
    const listBox = document.getElementById('cust-list')
    if (list.length > 0) {
      listBox.innerHTML = list.map(c =>
        '<div data-cust="' + c.id + '" style="padding:14px 16px;border-radius:10px;background:rgba(255,255,255,.08);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">' +
          '<div style="font-size:18px;font-weight:700">' + c.name + '</div>' +
          (c.outstanding > 0 ? '<div style="color:#ff6b6b;font-weight:700">欠 ' + fmt(c.outstanding) + '</div>' : '<div style="color:#4ade80">无欠款</div>') +
        '</div>'
      ).join('')
      listBox.querySelectorAll('[data-cust]').forEach(el => {
        el.onclick = () => {
          const c = list.find(x => x.id === Number(el.getAttribute('data-cust')))
          if (c) { overlay.remove(); onSelect(c) }
        }
      })
    } else {
      listBox.innerHTML = '<div style="padding:10px;color:#8fa3c0">还没有客户，点下面新建</div>'
    }
    document.getElementById('cust-new').onclick = async () => {
      const name = prompt('新客户名字？')
      if (!name) return
      try {
        const r = await api('customer:create', { name, phone: '', notes: '' })
        overlay.remove()
        onSelect({ id: r.id, name })
      } catch (e) { toast('建客户失败: ' + e.message) }
    }
  }

  render()
})
