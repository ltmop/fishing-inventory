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
 *
 * mode（盘点模式，v2.1）：
 * - 'batch'（默认）：按批次逐行生成明细，店员分别填每个批次的实盘数（多批次商品拆多行）
 * - 'sku'：按商品合并成一行（batch_id 记 NULL），店员只填"这个商品一共多少个"，
 *   提交时系统把差异按各批次数量比例摊到批次。适合货架上分不清批次的场景。
 */
export function createStockTake(db, { locationFilter, category, supplierId, operator, mode }) {
  if (category != null && !CATEGORY_CODES[category]) throw new Error(`品类非法：${category}`)
  const takeMode = mode === 'sku' ? 'sku' : 'batch'
  return inTransaction(db, () => {
    if (supplierId != null) {
      const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)
      if (!sup) throw new Error('供应商不存在')
    }
    const ts = now()
    const takeNo = nextTakeNo(db)
    const info = db
      .prepare(
        `INSERT INTO stock_takes (take_no, status, location_filter, category_filter, supplier_filter, started_at, completed_at, operator, mode)
         VALUES (?, '进行中', ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(takeNo, locationFilter ?? null, category ?? null, supplierId ?? null, ts, operator ?? '', takeMode)
    const takeId = Number(info.lastInsertRowid)

    // 按筛选条件取批次：货位匹配（批次货位或商品默认货位）+ 品类 + 供应商，三者取交集
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

    if (takeMode === 'sku') {
      // 按商品合并：一个商品一行，system_qty = 该商品符合条件的所有批次数量之和，batch_id 记 NULL
      const byProduct = new Map()
      for (const r of batches) {
        byProduct.set(r.product_id, (byProduct.get(r.product_id) ?? 0) + r.quantity)
      }
      const insItem = db.prepare(
        `INSERT INTO stock_take_items (stock_take_id, product_id, batch_id, system_qty, actual_qty, reason)
         VALUES (?, ?, NULL, ?, NULL, '')`,
      )
      for (const [pid, qty] of byProduct) insItem.run(takeId, pid, qty)
    } else {
      const insItem = db.prepare(
        `INSERT INTO stock_take_items (stock_take_id, product_id, batch_id, system_qty, actual_qty, reason)
         VALUES (?, ?, ?, ?, NULL, '')`,
      )
      for (const r of batches) insItem.run(takeId, r.product_id, r.batch_id, r.quantity)
    }

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
    const take = db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(takeId)
    if (!take) throw new Error('盘点单不存在')
    const isSkuMode = take.mode === 'sku'
    const updItem = db.prepare(
      'UPDATE stock_take_items SET actual_qty = ?, reason = ? WHERE id = ? AND stock_take_id = ?',
    )
    for (const it of items ?? []) {
      const qty = Number(it.actualQty)
      if (Number.isInteger(qty) && qty >= 0) {
        updItem.run(qty, String(it.reason ?? ''), it.itemId, takeId)
      }
    }
    if (isSkuMode) {
      // 按 SKU 合并：一个商品一行（batch_id NULL），把商品实盘总数按各批次数量比例摊回批次库存
      const skuRows = db
        .prepare(
          `SELECT id, product_id, system_qty, actual_qty FROM stock_take_items
           WHERE stock_take_id = ? AND actual_qty IS NOT NULL AND batch_id IS NULL`,
        )
        .all(takeId)
      const updBatch = db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?')
      let batchCount = 0
      for (const r of skuRows) {
        const target = r.actual_qty
        const sys = r.system_qty || 0
        const batchList = db
          .prepare(
            'SELECT id, quantity FROM inventory_batches WHERE product_id = ? ORDER BY id ASC',
          )
          .all(r.product_id)
        if (batchList.length === 0) continue
        if (sys <= 0) {
          // 系统库存为 0 但盘出有货：全部记到第一个批次（新建时 batch_id 若为空则无法落，仅标记差异）
          updBatch.run(target, batchList[0].id)
          batchCount++
          continue
        }
        let allocated = 0
        for (let i = 0; i < batchList.length; i++) {
          const b = batchList[i]
          // 按数量比例分摊，最后一个批次补平取整误差
          const share =
            i === batchList.length - 1
              ? target - allocated
              : Math.round((target * b.quantity) / sys)
          updBatch.run(Math.max(0, share), b.id)
          allocated += share
          batchCount++
        }
      }
      db.prepare("UPDATE stock_takes SET status = '已完成', completed_at = ? WHERE id = ?").run(now(), takeId)
      logAudit(db, '盘点', take.take_no ?? `盘点单#${takeId}`, { counted: skuRows.length, mode: 'sku' }, operator)
      return
    }
    const rows = db
      .prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ? AND actual_qty IS NOT NULL AND batch_id IS NOT NULL')
      .all(takeId)
    const updBatch = db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?')
    for (const r of rows) updBatch.run(r.actual_qty, r.batch_id)
    db.prepare("UPDATE stock_takes SET status = '已完成', completed_at = ? WHERE id = ?").run(now(), takeId)
    logAudit(db, '盘点', take.take_no ?? `盘点单#${takeId}`, { counted: rows.length, mode: 'batch' }, operator)
  })
}
