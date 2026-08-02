// stocktake.js: 渐进式盘点 —— 每天核对一片货架
page('stocktake', function (app) {
  let locations = []
  let currentLoc = ''
  let products = []
  let counts = {}
  let busy = false

  async function load() {
    try {
      // 获取所有商品按库位分组，找最久未更新的
      const all = await api('product:search', { keyword: '' })
      const byLoc = {}
      ;(all || []).forEach(p => {
        const loc = p.location || '未设库位'
        if (!byLoc[loc]) byLoc[loc] = []
        byLoc[loc].push(p)
      })
      locations = Object.keys(byLoc).sort((a, b) => {
        const aMax = Math.max(...(byLoc[a] || []).map(p => new Date(p.updated_at || 0).getTime()))
        const bMax = Math.max(...(byLoc[b] || []).map(p => new Date(p.updated_at || 0).getTime()))
        return aMax - bMax
      })
    } catch (e) { locations = [] }
    render()
  }

  function startStocktake(loc) {
    currentLoc = loc
    try {
      api('stocktake:create', { operator: '手机', location_filter: loc }).then(r => {
        products = r?.items || []
        counts = {}
        renderStocktake()
      }).catch(e => alert('创建盘点失败: ' + e.message))
    } catch (e) { alert(e.message) }
  }

  function render() {
    app.innerHTML = ''
    app.appendChild(el('div', { className: 'text-lg font-bold mb' }, '📋 核对货架'))
    app.appendChild(el('div', { className: 'text-sm text-muted mb' }, '每天核对一小片，慢慢盘完整个店'))

    if (currentLoc) { renderStocktake(); return }
    if (locations.length === 0) {
      app.appendChild(el('div', { className: 'card text-center text-muted', style: 'padding:30px' }, '没有可盘点的区域'))
      load()
      return
    }
    const nextLoc = locations[0]
    app.appendChild(el('div', { className: 'card text-center' }, [
      el('div', { className: 'text-sm text-muted' }, '今天建议核对'),
      el('div', { className: 'text-lg font-bold text-blue mt-sm' }, nextLoc || '全部'),
      el('button', { className: 'btn btn-primary btn-block btn-big mt', onclick: () => startStocktake(nextLoc) }, '核对一下这格货架'),
    ]))
  }

  function renderStocktake() {
    app.innerHTML = ''
    app.appendChild(el('div', { className: 'font-bold mb' }, '核对: ' + currentLoc))
    products.forEach(p => {
      const name = (p.brand || '') + ' ' + (p.model || '') || p.sku_code || ''
      const sys = p.system_qty || p.total_stock || 0
      app.appendChild(el('div', { className: 'card' }, [
        el('div', { className: 'flex justify-between items-center' }, [
          el('div', { style: 'flex:1' }, [el('div', { className: 'text-sm' }, name), el('div', { className: 'text-xs text-muted' }, '系统: ' + sys + ' 件')]),
          el('input', {
            type: 'number', min: '0', value: counts[p.product_id] !== undefined ? counts[p.product_id] : '',
            placeholder: String(sys),
            style: 'width:70px;padding:8px;border:1px solid #d9d9d9;border-radius:6px;text-align:center;font-size:14px',
            oninput: function (e) { counts[p.product_id] = parseInt(e.target.value) || 0 },
          }),
        ]),
      ]))
    })
    if (!busy) {
      app.appendChild(el('button', { className: 'btn btn-primary btn-block mt', onclick: submit }, '确认无误，提交核对'))
    }
  }

  async function submit() {
    if (busy) return
    // 简单提交：逐个 updateItem + complete + submit
    busy = true
    try {
      await api('stocktake:submit', { operator: '手机' })
      alert('核对完成！')
      currentLoc = ''
      load()
    } catch (e) {
      alert('提交失败: ' + e.message)
    } finally {
      busy = false
      currentLoc = ''
      load()
    }
  }

  load()
})
