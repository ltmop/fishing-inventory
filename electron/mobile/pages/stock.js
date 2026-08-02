// stock.js: 库存查询页 —— 搜索/扫码 → 商品卡（库存+批次+建议售价+库位）
page('stock', function (app) {
  let keyword = ''
  let results = []

  async function search(kw) {
    keyword = kw
    if (!kw) { results = []; render(); return }
    try {
      results = await api('product:search', { keyword: kw })
    } catch { results = [] }
    render()
  }

  function render() {
    app.innerHTML = ''
    const searchBox = el('input', { className: 'input mb', placeholder: '输入商品名/条码/SKU...', oninput: (e) => search(e.target.value.trim()), value: keyword })
    app.appendChild(searchBox)
    app.appendChild(el('button', { className: 'scan-btn mb', onclick: () => openScanner(onScan, '扫码查库存') }, ['📷 扫码查库存']))

    if (results.length === 0 && keyword) {
      app.appendChild(el('div', { className: 'card text-center text-muted', style: 'padding:30px' }, '没有找到商品'))
      return
    }
    results.forEach(p => {
      const name = (p.brand || '') + ' ' + (p.model || '') || p.sku_code
      const total = p.total_stock || 0
      const low = total < (p.min_stock || 5)
      app.appendChild(el('div', { className: 'card' }, [
        el('div', { className: 'flex justify-between items-center' }, [
          el('div', {}, [
            el('div', { className: 'font-bold' }, name),
            el('div', { className: 'text-xs text-muted' }, p.sku_code),
          ]),
          el('div', { className: 'text-right' }, [
            el('div', { className: low ? 'text-red font-bold' : 'font-bold' }, String(total) + ' 件'),
            el('div', { className: 'text-xs text-muted' }, p.suggest_price ? fmt(p.suggest_price) : '未定价'),
          ]),
        ]),
        p.location ? el('div', { className: 'text-xs text-muted mt-sm' }, '库位: ' + p.location) : null,
      ]))
    })
  }

  async function onScan(code) {
    if (code) { search(code); document.querySelector('.input').value = code }
  }

  render()
})
