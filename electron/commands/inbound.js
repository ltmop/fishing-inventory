// 入库
import {
  assertPositiveInt,
  assertFen,
  inTransaction,
  now,
  nextBatchNo,
  today,
  productLabel,
  logAudit,
} from './helpers.js'

export function createInbound(db, { productId, quantity, costPrice, location, supplierId, operator }) {
  assertPositiveInt(quantity, '入库数量')
  assertFen(costPrice, '入库成本价')
  return inTransaction(db, () => {
    const ts = now()
    const batchNo = nextBatchNo(db)
    const batchInfo = db
      .prepare(
        `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(productId, batchNo, quantity, costPrice, location ?? null, today(), supplierId ?? null)
    const batchId = Number(batchInfo.lastInsertRowid)

    db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
       VALUES (?, ?, 'in', ?, ?, NULL, ?, ?, NULL)`,
    ).run(productId, batchId, quantity, costPrice, ts, operator ?? null)

    // 商品主表同步最近进价
    db.prepare('UPDATE products SET cost_price = ?, updated_at = ? WHERE id = ?').run(
      costPrice,
      ts,
      productId,
    )
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    logAudit(db, '入库', `${prod ? productLabel(prod) : `#${productId}`} x${quantity}`,
      { batchNo, quantity, costPrice, supplierId: supplierId ?? null }, operator)
    return { batchId, batchNo }
  })
}
