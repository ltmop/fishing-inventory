// suppliers.js: 供应商列表（轻量，看应付总额）
page('suppliers', function (app) {
  let list = []

  async function load() {
    try { list = await api('supplier:list') } catch { list = [] }
    render()
  }

  function render() {
    app.innerHTML = ''
    app.appendChild(el('div', { className: 'text-lg font-bold mb' }, '🏭 供应商'))
    if (list.length === 0) {
      app.innerHTML += '<div class="card text-center text-muted" style="padding:30px">暂无供应商</div>'
      load()
      return
    }
    list.forEach(s => {
      app.appendChild(el('div', { className: 'card' }, [
        el('div', { className: 'flex justify-between items-center' }, [
          el('div', {}, [el('div', { className: 'font-bold text-sm' }, s.name), s.phone ? el('div', { className: 'text-xs text-muted' }, s.phone) : null]),
          el('div', { className: 'text-right text-sm text-muted' }, '货款 ' + fmt(s.total_cost)),
        ]),
      ]))
    })
    app.appendChild(el('div', { className: 'text-center text-xs text-muted mt', style: 'padding:12px' }, '详细对账请在电脑上操作'))
  }

  load()
})
