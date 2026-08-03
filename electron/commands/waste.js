// 报损登记：活饵死亡 / 饵料临期报废 / 破损等损耗。
// 报损 = 从批次扣库存（优先最早到期批次，临期先处理）+ 记 waste_logs，供成本报表单独统计。
import { assertPositiveInt, inTransaction, now, productLabel, logAudit } from './helpers.js'

/** 登记报损：减少批次库存 + 记损耗。数量必须 ≥1，库存不足直接拒绝 */
export function createWaste(db, { productId, quantity, reason, operator }) {
  assertPositiveInt(quantity, '报损数量')
  return inTransaction(db, () => {
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    if (!prod) throw new Error('商品不存在')
    // 优先扣最早到期的批次（临期先报废，别把新鲜的先报损了）
    const batches = db
      .prepare(
        `SELECT * FROM inventory_batches WHERE product_id = ? AND quantity > 0
         ORDER BY
           CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
           expiry_date ASC,
           id ASC`,
      )
      .all(productId)
    const total = batches.reduce((s, b) => s + b.quantity, 0)
    if (total < quantity) throw new Error(`库存不足：${productLabel(prod)} 只有 ${total} 件，报损不了 ${quantity} 件`)
    let remaining = quantity
    let firstBatchId = null
    for (const b of batches) {
      if (remaining <= 0) break
      const deduct = Math.min(b.quantity, remaining)
      db.prepare('UPDATE inventory_batches SET quantity = quantity - ? WHERE id = ?').run(deduct, b.id)
      if (firstBatchId === null) firstBatchId = b.id
      remaining -= deduct
    }
    db.prepare(
      `INSERT INTO waste_logs (product_id, batch_id, quantity, reason, operator, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(productId, firstBatchId, quantity, String(reason ?? '').trim(), operator ?? null, now())
    logAudit(db, '报损', `${productLabel(prod)} x${quantity}`,
      { quantity, reason: String(reason ?? '').trim(), costPrice: prod.cost_price }, operator)
    return { ok: true, batchId: firstBatchId }
  })
}

/** 报损记录（带商品信息），按时间倒序 */
export function listWastes(db, { limit = 100 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)
  return db
    .prepare(
      `SELECT w.*, p.sku_code, p.brand, p.model, p.cost_price
       FROM waste_logs w JOIN products p ON p.id = w.product_id
       ORDER BY w.created_at DESC, w.id DESC LIMIT ?`,
    )
    .all(n)
}

/** 损耗成本汇总：某时间段内报损数量 × 商品最近进价（按天分组，供报表/图表） */
export function wasteSummary(db, { from, to } = {}) {
  const conds = []
  const args = []
  if (from) { conds.push("date(w.created_at) >= date(?)"); args.push(from) }
  if (to) { conds.push("date(w.created_at) <= date(?)"); args.push(to) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT w.product_id, p.sku_code, p.brand, p.model, p.cost_price,
              SUM(w.quantity) AS total_qty,
              SUM(w.quantity * p.cost_price) AS total_cost
       FROM waste_logs w JOIN products p ON p.id = w.product_id
       ${where}
       GROUP BY w.product_id ORDER BY total_cost DESC`,
    )
    .all(...args)
  const totalQty = rows.reduce((s, r) => s + r.total_qty, 0)
  const totalCost = rows.reduce((s, r) => s + r.total_cost, 0)
  return { totalQty, totalCost, items: rows }
}
