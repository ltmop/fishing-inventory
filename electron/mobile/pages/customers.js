// customers.js: 客户欠款
page('customers', function (app) {
  let list = []
  async function load() { try { list = await api('customer:list') } catch { list = [] }; render() }
  async function recordPay(c) {
    const amt = prompt(c.name + ' 欠 ' + fmt(c.outstanding) + '，还多少元？', String(Math.round((c.outstanding || 0) / 100)))
    if (!amt) return
    try { await api('payment:record', { customer_id: c.id, amount: Math.round(parseFloat(amt) * 100), method: '微信', notes: null }); load(); toast('已收款') }
    catch (e) { toast('还款失败: ' + e.message) }
  }
  function render() {
    app.innerHTML = '<div class="sectitle"><span class="tag">👤 欠款客户</span></div>'
    const debtors = list.filter(c => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)
    if (!debtors.length) { const e = document.createElement('div'); e.className = 'text-center text-muted'; e.style.padding = '30px'; e.textContent = '没有欠款'; app.appendChild(e); return }
    debtors.forEach(c => {
      const card = document.createElement('div'); card.className = 'card'; card.style.cursor = 'pointer'
      card.innerHTML =
        '<div class="split">' +
          '<div><div class="font-bold">' + (c.name || '未命名') + '</div><div class="text-xs text-muted mt-sm">' + (c.phone || '') + '</div></div>' +
          '<div class="text-right"><div class="text-lg font-bold text-red">' + fmt(c.outstanding) + '</div><div class="text-xs text-muted">点此收款</div></div>' +
        '</div>'
      card.onclick = () => recordPay(c)
      app.appendChild(card)
    })
  }
  load()
})
