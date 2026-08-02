// 报表：分级库存预警 / 今日收款方式拆分 / 过期预警
import { parseExpiryDate } from './helpers.js'

// ---------- 分级库存预警 ----------
// 口径（全站统一）：商品总库存 < COALESCE(products.min_stock, 默认阈值) 即预警；
// min_stock 为 NULL 表示没单独设过，用默认阈值。仪表盘/库存页/手机端共用这一口径。

export const DEFAULT_MIN_STOCK = 5

/** 低库存商品列表：总库存 < 各自预警线（min_stock ?? 默认），升序，最缺的在前 */
export function lowStockProducts(db) {
  return db
    .prepare(
      `SELECT p.id, p.sku_code, p.brand, p.model, p.location, p.min_stock,
              COALESCE(s.q, 0) AS stock, COALESCE(p.min_stock, ?) AS threshold
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s
         ON s.product_id = p.id
       WHERE COALESCE(s.q, 0) < COALESCE(p.min_stock, ?)
       ORDER BY stock ASC, p.id ASC`,
    )
    .all(DEFAULT_MIN_STOCK, DEFAULT_MIN_STOCK)
}

// ---------- 今日收款方式拆分（日结对账用） ----------

/**
 * 今日收款方式拆分（单位：分），桌面仪表盘与手机看店共用同一口径：
 * - byMethod：按流水 pay_method 聚合——出库实收记正、退货退款记负（换货退旧腿、冲减欠款的退货不算现金移动）
 * - unrecorded：收到钱但没记方式的净额（老数据/未选方式）
 * - credit：今日新增赊账（应付 − 实收）
 */
export function todayPaymentSplit(db) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const rows = db
    .prepare(
      `SELECT type, quantity, selling_price, paid_amount, pay_method, notes FROM transactions
       WHERE timestamp >= ? AND selling_price IS NOT NULL AND type IN ('out', 'return')`,
    )
    .all(start.toISOString())
  const byMethod = {}
  let unrecorded = 0
  let credit = 0
  for (const t of rows) {
    if (t.type === 'return') {
      if (t.notes === '换货退旧' || t.pay_method == null) continue
      byMethod[t.pay_method] = (byMethod[t.pay_method] ?? 0) - t.quantity * t.selling_price
      continue
    }
    const due = t.quantity * t.selling_price
    const paid = t.paid_amount == null ? due : t.paid_amount // NULL=全额付清
    credit += due - paid
    if (paid > 0) {
      if (t.pay_method == null) unrecorded += paid
      else byMethod[t.pay_method] = (byMethod[t.pay_method] ?? 0) + paid
    }
  }
  return { byMethod, unrecorded, credit }
}

// ---------- 过期预警（饵料等保质期商品） ----------

/**
 * 临期/过期商品：expiry_date 在未来 N 天内（含已过期），且当前库存 > 0，按过期日升序。
 * 返回：名称/SKU/过期日/剩余天数（负=已过期）/库存量/expired 标记
 */
export function expiringProducts(db, { days = 30 } = {}) {
  const n = Math.max(parseInt(days, 10) || 30, 0)
  const rows = db
    .prepare(
      `SELECT p.id, p.sku_code, p.brand, p.model, p.expiry_date, COALESCE(s.q, 0) AS stock
       FROM products p
       LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_batches GROUP BY product_id) s
         ON s.product_id = p.id
       WHERE p.expiry_date IS NOT NULL AND p.expiry_date <> '' AND COALESCE(s.q, 0) > 0`,
    )
    .all()
  const todayMid = new Date()
  todayMid.setHours(0, 0, 0, 0)
  const out = []
  for (const r of rows) {
    const exp = parseExpiryDate(r.expiry_date)
    if (!exp) continue // 无法识别的保质期写法不参与预警
    const daysLeft = Math.round((exp.getTime() - todayMid.getTime()) / 86400000)
    if (daysLeft > n) continue
    out.push({
      id: r.id,
      name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
      sku: r.sku_code,
      expiry_date: r.expiry_date,
      daysLeft,
      expired: daysLeft < 0,
      stock: r.stock,
      _sort: exp.getTime(),
    })
  }
  out.sort((a, b) => a._sort - b._sort)
  return out.map(({ _sort, ...rest }) => rest)
}
