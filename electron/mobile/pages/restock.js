// restock.js: 补货清单 —— 低库存红标 + 近30天销量 + 建议补货量
page('restock', function (app) {
  let items = []

  async function load() {
    try { items = await api('report:lowStock') } catch { items = [] }
    render()
  }

  function render() {
    app.innerHTML = ''
    app.appendChild(el('div', { className: 'text-lg font-bold mb' }, '⚠️ 补货清单'))
    if (items.length === 0) {
      app.innerHTML += '<div class="card text-center text-muted" style="padding:30px">库存健康，无需补货</div>'
      load()
      return
    }
    items.forEach(p => {
      const name = (p.brand || '') + ' ' + (p.model || '') || p.sku_code || ''
      app.appendChild(el('div', { className: 'card' }, [
        el('div', { className: 'flex justify-between items-center' }, [
          el('div', {}, [
            el('div', { className: 'text-sm font-bold' }, name),
            el('div', { className: 'text-xs text-muted' }, '近30天卖 ' + (p.sold30 || 0) + ' 件'),
          ]),
          el('div', { className: 'text-right' }, [
            el('div', { className: 'badge badge-red text-sm' }, '剩 ' + (p.stock || 0) + ' 件'),
            p.suggested_qty ? el('div', { className: 'text-xs text-blue mt-sm' }, '建议补 ' + p.suggested_qty + ' 件') : null,
          ]),
        ]),
      ]))
    })
    load()
  }

  render()
})
