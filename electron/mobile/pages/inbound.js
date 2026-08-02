// inbound.js: 手机入库页 —— 扫码→命中选数量/未命中新建→确认入库
page('inbound', function (app) {
  function render() {
    app.innerHTML = ''
    app.appendChild(el('div', { className: 'mb' }, [
      el('button', { className: 'scan-btn', onclick: () => openScanner(onScan, '扫条码入库') }, ['📥 扫码入库']),
    ]))
    app.appendChild(el('div', { className: 'text-center text-sm text-muted', style: 'padding:20px' }, [
      el('div', {}, '扫码命中后选择数量并确认入库'),
      el('div', { className: 'mt-sm' }, '扫不到条码的商品可以用电脑批量导入'),
    ]))
  }

  async function onScan(code) {
    if (!code) return
    try {
      const rows = await api('product:search', { keyword: code })
      if (!rows || rows.length === 0) {
        // 边用边建：新建→入库一步完成
        await createAndInbound(code)
        return
      }
      const p = rows[0]
      const name = (p.brand || '') + ' ' + (p.model || '') || p.sku_code
      const qty = parseInt(prompt('「' + name + '」\n目前库存 ' + (p.total_stock || 0) + '，这次入多少个？', '1')) || 1
      if (qty <= 0) return
      const cost = parseInt(prompt('进价多少元？', String((p.cost_price || 0) / 100))) || (p.cost_price || 0)
      await api('inbound:create', { product_id: p.id, quantity: qty, cost_price: Math.round(cost * 100) || cost, location: p.location || '', operator: '手机' })
      alert('已入库 ' + qty + ' 个「' + name + '」')
    } catch (e) { alert('入库失败: ' + e.message) }
  }

  async function createAndInbound(code) {
    const name = prompt('这是什么商品？', code)
    if (!name) return
    const qty = parseInt(prompt('大概多少个？', '1')) || 1
    const price = prompt('进价多少元？（选填）', '')
    const cost = price ? Math.round(parseFloat(price) * 100) : 0
    try {
      const r = await api('product:create', {
        sku_code: code, barcode: code, category: '其他', brand: '', model: name,
        cost_price: cost, suggest_price: Math.round(cost * 1.5), status: '待盘点',
      })
      await api('inbound:create', { product_id: r.id, quantity: qty, cost_price: cost, location: '', operator: '手机' })
      alert('已新建「' + name + '」并入库 ' + qty + ' 个')
    } catch (e) { alert('新建失败: ' + e.message) }
  }

  render()
})
