// restock.js: 补货清单
page('restock', function (app) {
  let items = []
  async function load() { try { items = await api('report:lowStock') } catch { items = [] }; render() }
  function render() {
    app.innerHTML = '<div class="sectitle"><span class="tag">⚠️ 补货清单</span></div>'
    if (items.length === 0) {
      const e = document.createElement('div'); e.className = 'text-center text-muted'; e.style.padding = '40px'; e.textContent = '库存健康，无需补货'; app.appendChild(e); load(); return
    }
    items.forEach(p => {
      const card = document.createElement('div'); card.className = 'card'
      const name = (p.brand || '') + ' ' + (p.model || '') || p.sku_code || ''
      card.innerHTML =
        '<div class="split">' +
          '<div><div class="font-bold">' + name + '</div><div class="text-xs text-muted mt-sm">近30天卖 ' + (p.sold30 || 0) + ' 件</div></div>' +
          '<div class="text-right"><span class="badge badge-red">剩 ' + (p.stock || 0) + ' 件</span>' + (p.suggested_qty ? '<div class="text-xs text-blue mt-sm">建议补 ' + p.suggested_qty + ' 件</div>' : '') + '</div>' +
        '</div>'
      app.appendChild(card)
    })
  }
  load()
})
