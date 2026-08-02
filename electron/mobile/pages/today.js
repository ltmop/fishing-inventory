// today.js: 今日经营小结 —— 单数/营收/毛利 + 收款方式 + 最近流水
page('today', function (app) {
  let data = null

  async function load() {
    try { data = await api('report:today') } catch (e) { data = null }
    render()
  }

  function render() {
    app.innerHTML = ''
    if (!data || data.revenue === undefined) {
      app.innerHTML = '<div class="text-center text-muted" style="padding:40px"><div class="icon">📊</div>加载中...</div>'
      load()
      return
    }

    const rev = data.revenue || 0
    const prof = data.profit || 0
    const margin = rev > 0 ? (prof / rev * 100).toFixed(1) : '-'
    const split = data.paySplit || {}
    const recv = data.receivable || 0

    // 三件套
    app.appendChild(el('div', { className: 'card' }, [
      el('div', { className: 'flex justify-between' }, [
        el('div', {}, [el('div', { className: 'text-sm text-muted' }, '营业额'), el('div', { className: 'text-xl font-bold text-blue' }, fmt(rev))]),
        el('div', { className: 'text-right' }, [el('div', { className: 'text-sm text-muted' }, '毛利'), el('div', { className: 'text-xl font-bold text-green' }, fmt(prof))]),
      ]),
      el('div', { className: 'text-xs text-muted mt-sm' }, '毛利率 ' + margin + '% · 应收 ' + fmt(recv)),
    ]))

    // 收款方式
    const methods = Object.entries(split.byMethod || {}).filter(([, v]) => v > 0)
    if (methods.length > 0) {
      const tags = methods.map(([k, v]) => el('span', { className: 'tag' }, k + ' ' + fmt(v)))
      app.appendChild(el('div', { className: 'card' }, [
        el('div', { className: 'text-sm font-bold mb-sm' }, '收款方式'),
        el('div', { className: 'flex gap-sm', style: 'flex-wrap:wrap' }, tags),
      ]))
    }

    // 最近流水
    const recent = data.recent || []
    if (recent.length > 0) {
      const list = el('div', { className: 'card' })
      list.appendChild(el('div', { className: 'text-sm font-bold mb-sm' }, '今日流水'))
      recent.slice(0, 20).forEach(t => {
        const name = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || '-'
        const time = (t.timestamp || '').slice(11, 16)
        const amt = t.type === 'out' ? fmt(t.selling_price * t.quantity) : (t.type === 'return' ? '退货' : '入库')
        list.appendChild(el('div', { className: 'flex justify-between', style: 'padding:4px 0;font-size:12px' }, [
          el('span', { className: 'text-muted', style: 'width:42px' }, time),
          el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, name),
          el('span', { className: t.type === 'out' ? 'text-blue' : 'text-red' }, amt),
        ]))
      })
      app.appendChild(list)
    }
  }

  load()
})
