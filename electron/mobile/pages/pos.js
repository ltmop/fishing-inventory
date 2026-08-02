// pos.js: 手机开单页 —— 扫码→购物车→三键结账（全店使用频率 80%）
page('pos', function (app) {
  const cart = [] // { product_id, product, qty, selling_price }
  let busy = false

  function render() {
    app.innerHTML = ''
    app.appendChild(el('div', { className: 'mb' }, [
      el('button', { className: 'scan-btn', onclick: () => openScanner(handleScan, '扫条码或手输商品') }, ['📷 点这里扫码或输入商品']),
    ]))

    if (cart.length === 0) {
      app.appendChild(el('div', { className: 'card text-center' }, [
        el('div', { className: 'text-lg text-muted' }, '购物车是空的'),
        el('div', { className: 'text-sm text-muted mt-sm' }, '扫码或输入商品开始卖货'),
      ]))
      return
    }

    // 购物车
    const total = cart.reduce((s, c) => s + c.selling_price * c.qty, 0)
    const cartDiv = el('div', { className: 'card' })
    cartDiv.appendChild(el('div', { className: 'font-bold text-sm mb-sm' }, '购物车 ' + cart.reduce((s, c) => s + c.qty, 0) + ' 件'))
    cart.forEach((c, i) => {
      const name = (c.product.brand || '') + ' ' + (c.product.model || '') || c.product.sku_code
      cartDiv.appendChild(el('div', { className: 'cart-item' }, [
        el('span', { style: 'flex:1' }, [
          el('span', { className: 'text-sm' }, name),
          el('span', { className: 'text-xs text-muted', style: 'display:block' }, fmt(c.selling_price, null) + ' × ' + c.qty),
        ]),
        el('span', { className: 'qty' }, String(c.qty)),
        el('button', {
          className: 'text-sm text-red', style: 'background:none;border:none;cursor:pointer;padding:4px',
          onclick: () => { cart.splice(i, 1); render() }
        }, '✕'),
      ]))
    })
    cartDiv.appendChild(el('div', { className: 'cart-total divider pt' }, [
      el('span', {}, '合计'),
      el('span', { className: 'text-blue' }, fmt(total)),
    ]))
    app.appendChild(cartDiv)

    // 三键结账
    if (!busy) {
      const payDiv = el('div', { className: 'pay-btns' })
      ;[
        ['微信', 'wechat'], ['支付宝', 'alipay'], ['现金', 'cash'],
      ].forEach(([label, cls]) => {
        payDiv.appendChild(el('button', { className: 'pay-btn ' + cls, onclick: () => checkout(label) }, label))
      })
      app.appendChild(payDiv)
      app.appendChild(el('button', {
        className: 'btn btn-outline btn-block mt',
        onclick: () => openScanner(handleScan, '搜索客户')
      }, '赊账 → 选客户（先扫商品）'))
    } else {
      app.appendChild(el('div', { className: 'text-center text-muted mt', style: 'padding:12px' }, '结账中...'))
    }
  }

  async function handleScan(code) {
    if (!code) return
    try {
      const rows = await api('product:search', { keyword: code })
      if (!rows || rows.length === 0) {
        // 边用边建：扫码未命中 → 新建商品
        const p = await createOnTheFly(code)
        if (p) addToCart(p)
        return
      }
      const prod = rows[0]
      // 去重：已在购物车 → 数量+1
      const exist = cart.find(c => c.product_id === prod.id)
      if (exist) { exist.qty++; render(); return }
      addToCart(prod)
    } catch (e) {
      alert('查找商品失败: ' + e.message)
    }
  }

  function addToCart(prod) {
    cart.push({ product_id: prod.id, product: prod, qty: 1, selling_price: prod.suggest_price || prod.cost_price || 0 })
    render()
  }

  async function createOnTheFly(code) {
    const name = prompt('这个商品叫什么名字？（选填，至少填一条）', code)
    if (!name) return null
    const priceStr = prompt('卖多少钱？（元）例如 85', '')
    const price = priceStr ? Math.round(parseFloat(priceStr) * 100) : 0
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category: '其他', brand: '', model: name,
        cost_price: Math.round(price * 0.6), suggest_price: price, status: '待盘点',
      })
      // 快速入库
      await api('inbound:create', { product_id: r.id, quantity: parseInt(prompt('大概多少个？不准没关系，以后盘点会校正', '1')) || 1, cost_price: Math.round(price * 0.6), location: '', operator: '手机' })
      return { id: r.id, sku_code: code, brand: '', model: name, suggest_price: price, cost_price: Math.round(price * 0.6) }
    } catch (e) {
      alert('新建失败: ' + e.message)
      return null
    }
  }

  async function checkout(method) {
    if (cart.length === 0 || busy) return
    const map = { '现金': '现金', '微信': '微信', '支付宝': '支付宝' }
    busy = true; render()
    try {
      await api('outbound:checkout', {
        items: cart.map(c => ({ product_id: c.product_id, quantity: c.qty, selling_price: c.selling_price })),
        method: map[method] || '现金',
        operator: '手机',
      })
      cart.length = 0
      // 音效反馈
      try { navigator.vibrate(100) } catch (e) {}
    } catch (e) {
      alert('结账失败: ' + e.message)
    } finally {
      busy = false; render()
    }
  }

  render()
})
