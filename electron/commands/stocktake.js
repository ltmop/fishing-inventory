// 盘点
import {
  CATEGORY_CODES,
  inTransaction,
  now,
  nextTakeNo,
  logAudit,
} from './helpers.js'

/**
 * 创建盘点单：可按货位（locationFilter，前缀匹配）、品类（category，精确匹配）、
 * 供应商（supplierId，按批次的进货供应商匹配）筛选，三个条件取交集，都不传=全店盘点。
 * 筛选条件随盘点单落库（category_filter / supplier_filter / location_filter），方便事后回看盘点范围。
 */
export function createStockTake(db, { locationFilter, category, supplierId, operator }) {
  if (category != null && !CATEGORY_CODES[category]) throw new Error(`品类非法：${category}`)
  return inTransaction(db, () => {
    if (supplierId != null) {
      const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)
      if (!sup) throw new Error('供应商不存在')
    }
    const ts = now()
    const takeNo = nextTakeNo(db)
    const info = db
      .prepare(
        `INSERT INTO stock_takes (take_no, status, location_filter, category_filter, supplier_filter, started_at, completed_at, operator)
         VALUES (?, '进行中', ?, ?, ?, ?, NULL, ?)`,
      )
      .run(takeNo, locationFilter ?? null, category ?? null, supplierId ?? null, ts, operator ?? '')
    const takeId = Number(info.lastInsertRowid)

    // 按筛选条件取批次生成明细：货位匹配（批次货位或商品默认货位）+ 品类 + 供应商，三者取交集
    const inArea = (loc) => !locationFilter || (loc !== null && loc.startsWith(locationFilter))
    const batches = db
      .prepare(
        `SELECT b.id AS batch_id, b.product_id, b.quantity, b.location AS batch_loc, b.supplier_id,
                p.location AS product_loc, p.category
         FROM inventory_batches b JOIN products p ON p.id = b.product_id
         WHERE b.quantity > 0`,
      )
      .all()
      .filter(
        (r) =>
          (inArea(r.batch_loc) || inArea(r.product_loc)) &&
          (category == null || r.category === category) &&
          (supplierId == null || r.supplier_id === supplierId),
      )

    const insItem = db.prepare(
      `INSERT INTO stock_take_items (stock_take_id, product_id, batch_id, system_qty, actual_qty, reason)
       VALUES (?, ?, ?, ?, NULL, '')`,
    )
    for (const r of batches) insItem.run(takeId, r.product_id, r.batch_id, r.quantity)

    return db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(takeId)
  })
}

export function updateStockTakeItem(db, { itemId, actualQty, reason }) {
  // 与 submitStockTake 同一套校验：实盘数必须是非负整数，
  // 负数/小数/非数字一律拒绝，不允许落库
  const qty = Number(actualQty)
  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error(`实盘数量必须是非负整数，收到：${actualQty}`)
  }
  db.prepare('UPDATE stock_take_items SET actual_qty = ?, reason = ? WHERE id = ?').run(
    qty,
    reason ?? '',
    itemId,
  )
}

/** 完成盘点：把实盘数落实到批次库存，盘点单置为已完成 */
export function completeStockTake(db, takeId) {
  return inTransaction(db, () => {
    const items = db
      .prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ? AND actual_qty IS NOT NULL AND batch_id IS NOT NULL')
      .all(takeId)
    const upd = db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?')
    for (const it of items) upd.run(it.actual_qty, it.batch_id)
    db.prepare("UPDATE stock_takes SET status = '已完成', completed_at = ? WHERE id = ?").run(now(), takeId)
  })
}

/**
 * 盘点一次性原子提交：把前端暂存的实盘数写入明细 + 完成盘点，同一事务。
 * 替代"前端逐条 updateStockTakeItem + 最后 complete"的两段式流程——
 * 那种流程中途崩溃会留下改了明细没落实库存的半成品状态。
 * @param {{ takeId: number, items: Array<{ itemId: number, actualQty: number, reason: string }> }} payload
 */
export function submitStockTake(db, { takeId, items, operator }) {
  return inTransaction(db, () => {
    const updItem = db.prepare(
      'UPDATE stock_take_items SET actual_qty = ?, reason = ? WHERE id = ? AND stock_take_id = ?',
    )
    for (const it of items ?? []) {
      const qty = Number(it.actualQty)
      if (Number.isInteger(qty) && qty >= 0) {
        updItem.run(qty, String(it.reason ?? ''), it.itemId, takeId)
      }
    }
    const rows = db
      .prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ? AND actual_qty IS NOT NULL AND batch_id IS NOT NULL')
      .all(takeId)
    const updBatch = db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?')
    for (const r of rows) updBatch.run(r.actual_qty, r.batch_id)
    db.prepare("UPDATE stock_takes SET status = '已完成', completed_at = ? WHERE id = ?").run(now(), takeId)
    const take = db.prepare('SELECT take_no FROM stock_takes WHERE id = ?').get(takeId)
    logAudit(db, '盘点', take?.take_no ?? `盘点单#${takeId}`, { counted: rows.length }, operator)
  })
}
