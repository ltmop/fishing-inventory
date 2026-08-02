// stock.js: 库存查询
page('stock', function (app) {
  let keyword = '', results = [], tmr = null

  async function search(kw) {
    keyword = kw
    clearTimeout(tmr)
    if (!kw) { results = []; render(); return }
    tmr = setTimeout(async () => {
      try { results = await api('product:search', { keyword: kw }) } catch { results = [] }
      render()
    }, 300)
  }

  function render() {
    app.innerHTML = ''
    const sr = document.createElement('div'); sr.className = 'scanrow'
    const inp = document.createElement('input'); inp.className = 'search'; inp.placeholder = '输入商品名/条码/SKU...'; inp.value = keyword; inp.style.width = '100%'
    inp.oninput = (e) => search(e.target.value.trim())
    sr.appendChild(inp); app.appendChild(sr)

    const btn = document.createElement('button'); btn.className = 'scanbtn'; btn.style.margin = '10px 16px'; btn.style.width = 'calc(100% - 32px)'
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M4 12h16"/></svg>扫码查库存'
    btn.onclick = () => openScanner((code) => { if (code) { if (inp) inp.value = code; search(code) } }, '扫码查库存')
    app.appendChild(btn)

    if (!keyword) return
    if (results.length === 0) {
      const empty = document.createElement('div'); empty.className = 'text-center text-muted'; empty.style.padding = '30px'; empty.textContent = '没有找到商品'
      app.appendChild(empty)
      return
    }
    results.forEach(p => {
      const total = p.total_stock || 0
      const low = total < (p.min_stock || 5)
      const card = document.createElement('div'); card.className = 'card'
      card.innerHTML =
        '<div class="split">' +
          '<div><div class="font-bold">' + prodName(p) + '</div><div class="text-xs text-muted mt-sm">' + (p.sku_code || '') + '</div></div>' +
          '<div class="text-right"><div class="text-lg ' + (low ? 'text-red' : 'text-green') + ' font-bold">' + total + ' 件</div><div class="text-xs text-muted mt-sm">' + (p.suggest_price ? fmt(p.suggest_price) : '未定价') + '</div></div>' +
        '</div>' +
        (p.location ? '<div class="text-xs text-muted mt-sm">库位: ' + p.location + '</div>' : '')
      app.appendChild(card)
    })
  }

  render()
})
