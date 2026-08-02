// customers.js: 客户欠款列表 + 收款
page('customers', function (app) {
  let list = []

  async function load() {
    try { list = await api('customer:list') } catch { list = [] }
    render()
  }

  async function recordPay(c) {
    const amt = prompt(c.name + ' 欠 ' + fmt(c.outstanding) + '，还多少元？', String(Math.round((c.outstanding || 0) / 100)))
    if (!amt) return
    const method = prompt('收款方式？（微信/支付宝/现金）', '微信') || '微信'
    try {
      await api('payment:record', { customer_id: c.id, amount: Math.round(parseFloat(amt) * 100), method, notes: null })
      load()
    } catch (e) { alert('还款失败: ' + e.message) }
  }

  function render() {
    app.innerHTML = ''
    app.appendChild(el('div', { className: 'text-lg font-bold mb' }, '👤 客户欠款'))
    const debtors = list.filter(c => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)
    if (debtors.length === 0) {
      app.appendChild(el('div', { className: 'card text-center text-muted', style: 'padding:30px' }, '没有欠款'))
    }
    debtors.forEach(c => {
      app.appendChild(el('div', { className: 'card', onclick: () => recordPay(c) }, [
        el('div', { className: 'flex justify-between items-center' }, [
          el('div', {}, [el('div', { className: 'font-bold' }, c.name || '未命名'), el('div', { className: 'text-xs text-muted' }, c.phone || '')]),
          el('div', { className: 'text-right' }, [el('div', { className: 'text-lg font-bold text-red' }, fmt(c.outstanding)), el('div', { className: 'text-xs text-muted' }, '点此收款')]),
        ]),
      ]))
    })
  }

  load()
})
