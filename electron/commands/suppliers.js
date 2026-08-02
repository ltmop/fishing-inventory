// 供应商 CRUD 与对账
import { inTransaction } from './helpers.js'

export function createSupplier(db, s) {
  const info = db
    .prepare('INSERT INTO suppliers (name, contact, phone, address, notes) VALUES (?, ?, ?, ?, ?)')
    .run(s.name ?? '', s.contact ?? '', s.phone ?? '', s.address ?? '', s.notes ?? '')
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid)
}

export function updateSupplier(db, id, s) {
  db.prepare('UPDATE suppliers SET name = ?, contact = ?, phone = ?, address = ?, notes = ? WHERE id = ?').run(
    s.name ?? '', s.contact ?? '', s.phone ?? '', s.address ?? '', s.notes ?? '', id,
  )
}

export function deleteSupplier(db, id) {
  return inTransaction(db, () => {
    // 批次的外键置空而不是删除批次，保留入库历史
    db.prepare('UPDATE inventory_batches SET supplier_id = NULL WHERE supplier_id = ?').run(id)
    db.prepare('DELETE FROM suppliers WHERE id = ?').run(id)
  })
}

/**
 * 供应商对账单：
 * - lines：该供应商的进货批次明细（时间/商品/进货数量/成本价/金额/批次号/关联采购单号）。
 *   进货数量取 type='in' 的入库流水（批次原始数量），批次当前剩余另附 remaining；
 *   采购收货的流水 notes 形如"采购收货 PO20260728-001"，从中提取关联采购单号。
 * - 汇总：总进货金额/总件数/最近一次进货时间/待收采购单金额
 *   （待收=状态 sent/partial 的采购单里 Σ(订-已收)×进价，单位分）。
 */
export function supplierStatement(db, { supplierId }) {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId)
  if (!supplier) throw new Error('供应商不存在')
  const lines = db
    .prepare(
      `SELECT b.id AS batch_id, b.batch_no, b.inbound_date, b.cost_price, b.quantity AS remaining,
              p.id AS product_id, p.brand, p.model, p.sku_code,
              t.quantity AS in_qty, t.timestamp, t.notes
       FROM inventory_batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN transactions t ON t.batch_id = b.id AND t.type = 'in'
       WHERE b.supplier_id = ?
       ORDER BY b.inbound_date ASC, b.id ASC`,
    )
    .all(supplierId)
    .map((r) => {
      const quantity = r.in_qty ?? r.remaining // 找不到入库流水时退化为批次当前剩余
      const poMatch = /采购收货\s+(PO\d{8}-\d{3})/.exec(r.notes ?? '')
      return {
        batch_id: r.batch_id,
        batch_no: r.batch_no,
        date: r.inbound_date,
        product_id: r.product_id,
        product_name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
        sku: r.sku_code,
        quantity,
        remaining: r.remaining,
        cost_price: r.cost_price,
        amount: quantity * r.cost_price,
        po_no: poMatch ? poMatch[1] : null,
      }
    })
  const pending = db
    .prepare(
      `SELECT COALESCE(SUM((i.quantity - i.received_qty) * i.unit_cost), 0) AS amount
       FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.po_id
       WHERE po.supplier_id = ? AND po.status IN ('sent', 'partial')`,
    )
    .get(supplierId).amount
  return {
    supplier,
    lines,
    totalAmount: lines.reduce((s, l) => s + l.amount, 0),
    totalQty: lines.reduce((s, l) => s + l.quantity, 0),
    lastInboundAt: lines.length > 0 ? lines[lines.length - 1].date : null,
    pendingPoAmount: pending,
  }
}
