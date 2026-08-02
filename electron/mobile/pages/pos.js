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
    const priceStr = prompt('卖多少钱？（元）例如 85', '')
    const price = priceStr ? Math.round(parseFloat(priceStr) * 100) : 0
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category: '其他', brand: '', model: name,
        cost_price: Math.round(price * 0.6), suggest_price: price, status: '待盘点',
      })
      const qty = parseInt(prompt('大概多少个？不准没关系，以后盘点会校正', '1')) || 1
      await api('inbound:create', { product_id: r.id, quantity: qty, cost_price: Math.round(price * 0.6), location: '', operator: '手机' })
      return { id: r.id, sku_code: code, brand: '', model: name, suggest_price: price, cost_price: Math.round(price * 0.6) }
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
      const name = prompt('赊给谁？（输入客户名）')
      if (!name) return
      const customer = list.find(c => c.name === name)
      if (!customer) { toast('没找到客户「' + name + '」，先在电脑上建客户'); return }
      busy = true; render()
      const totalFen = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
      await api('outbound:checkout', {
        items: cart.map(c => ({ product_id: c.product_id, quantity: c.qty, selling_price: c.selling_price })),
        method: '微信', operator: '手机',
        customer_id: customer.id, paid_amount: 0,
      })
      showStamp('已赊', fmt(totalFen) + ' · ' + name, false)
      cart.length = 0
    } catch (e) { toast('赊账失败: ' + e.message) } finally { busy = false; render() }
  }

  render()
})
