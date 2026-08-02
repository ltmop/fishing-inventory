// today.js: 今日经营小结
page('today', function (app) {
  let data = null

  async function load() {
    try { data = await api('report:today') } catch { data = null }
    render()
  }

  function render() {
    app.innerHTML = ''
    if (!data || data.revenue === undefined) { app.innerHTML = '<div class="text-center text-muted" style="padding:40px">加载中...</div>'; load(); return }

    const rev = data.revenue || 0, prof = data.profit || 0
    const margin = rev > 0 ? (prof / rev * 100).toFixed(1) : '-'
    const split = data.paySplit || {}, recv = data.receivable || 0
    const methods = Object.entries(split.byMethod || {}).filter(([, v]) => v > 0)

    // 三件套卡片
    const c1 = document.createElement('div'); c1.className = 'card'
    c1.innerHTML =
      '<div class="split">' +
        '<div><div class="text-sm" style="color:var(--sub)">营业额</div><div class="text-2xl font-bolder" style="color:var(--blue)">' + fmt(rev) + '</div></div>' +
        '<div class="text-right"><div class="text-sm" style="color:var(--sub)">毛利</div><div class="text-2xl font-bolder" style="color:var(--green)">' + fmt(prof) + '</div></div>' +
      '</div>' +
      '<div class="text-xs text-muted mt-sm">毛利率 ' + margin + '% · 应收 ' + fmt(recv) + '</div>'
    app.appendChild(c1)

    // 收款方式
    if (methods.length > 0) {
      const c2 = document.createElement('div'); c2.className = 'card'
      const tags = document.createElement('div'); tags.className = 'gap wrap'
      tags.style.marginTop = '6px'
      methods.forEach(([k, v]) => {
        const t = document.createElement('span'); t.className = 'tag'; t.textContent = k + ' ' + fmt(v); tags.appendChild(t)
      })
      c2.innerHTML = '<div class="font-bold mb-sm">收款方式</div>'
      c2.appendChild(tags)
      app.appendChild(c2)
    }

    // 最近流水
    const recent = data.recent || []
    if (recent.length > 0) {
      const c3 = document.createElement('div'); c3.className = 'card'
      c3.innerHTML = '<div class="font-bold mb-sm">今日流水</div>'
      recent.slice(0, 20).forEach(t => {
        const name = (t.brand || '') + ' ' + (t.model || '') || t.sku_code || '-'
        const time = (t.timestamp || '').slice(11, 16)
        const amt = t.type === 'out' ? fmt(t.selling_price * t.quantity) : (t.type === 'return' ? '退货' : '入库')
        const line = document.createElement('div'); line.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid var(--line)'
        line.innerHTML = '<span style="color:var(--sub);width:42px">' + time + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + name + '</span><span class="' + (t.type === 'out' ? 'text-blue' : 'text-red') + '">' + amt + '</span>'
        c3.appendChild(line)
      })
      app.appendChild(c3)
    }
  }

  load()
})
