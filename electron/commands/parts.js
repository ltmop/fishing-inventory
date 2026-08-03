// 配节管理：主竿-配节关联（断竿梢换节是渔具店售后刚需）。
// 一个商品可以是某主竿的配节（parent_id 指向主竿），配节类型用 part_type 标记（竿梢/手把节/中节等）。
// 配节页按主竿维度看各配节库存，低于预警提示补货。
import { inTransaction, now, productLabel, logAudit } from './helpers.js'

/** 设置/清除配节关系：productId 设为 parentId 的配节，partType 填配节类型；parentId=null 清除 */
export function setPart(db, { productId, parentId, partType, operator }) {
  return inTransaction(db, () => {
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    if (!prod) throw new Error('商品不存在')
    if (parentId != null) {
      const parent = db.prepare('SELECT * FROM products WHERE id = ?').get(parentId)
      if (!parent) throw new Error(`主竿商品不存在（ID：${parentId}）`)
      if (parentId === productId) throw new Error('配节不能指向自己')
    }
    const ts = now()
    db.prepare('UPDATE products SET parent_id = ?, part_type = ?, updated_at = ? WHERE id = ?').run(
      parentId ?? null,
      partType ? String(partType).trim() : null,
      ts,
      productId,
    )
    logAudit(db, '设配节',
      `${productLabel(prod)} → ${parentId != null ? `主竿#${parentId}` : '解除'}`,
      { parentId: parentId ?? null, partType: partType ?? null }, operator)
    return { ok: true }
  })
}

/** 查某主竿的所有配节 + 当前库存（配节页主维度） */
export function partsOf(db, { parentId }) {
  return db
    .prepare(
      `SELECT p.id, p.sku_code, p.brand, p.model, p.part_type, p.cost_price, p.suggest_price,
              COALESCE((SELECT SUM(quantity) FROM inventory_batches b WHERE b.product_id = p.id), 0) AS stock
       FROM products p WHERE p.parent_id = ? ORDER BY p.part_type, p.model`,
    )
    .all(parentId)
}

/** 所有"是配节"的商品（用于搜索/筛选），可按关键词过滤 */
export function allParts(db, { keyword } = {}) {
  const kw = keyword ? `%${String(keyword).trim()}%` : null
  const rows = kw
    ? db
        .prepare(
          `SELECT p.id, p.sku_code, p.brand, p.model, p.part_type, p.parent_id,
                  COALESCE((SELECT SUM(quantity) FROM inventory_batches b WHERE b.product_id = p.id), 0) AS stock
           FROM products p WHERE p.parent_id IS NOT NULL
             AND (p.sku_code LIKE ? OR p.brand LIKE ? OR p.model LIKE ?)
           ORDER BY p.part_type, p.model LIMIT 50`,
        )
        .all(kw, kw, kw)
    : db
        .prepare(
          `SELECT p.id, p.sku_code, p.brand, p.model, p.part_type, p.parent_id,
                  COALESCE((SELECT SUM(quantity) FROM inventory_batches b WHERE b.product_id = p.id), 0) AS stock
           FROM products p WHERE p.parent_id IS NOT NULL
           ORDER BY p.part_type, p.model LIMIT 200`,
        )
        .all()
  // 附带主竿名称
  const parentIds = [...new Set(rows.map((r) => r.parent_id))]
  const parents = {}
  if (parentIds.length > 0) {
    const ph = parentIds.map(() => '?').join(',')
    for (const p of db.prepare(`SELECT id, sku_code, brand, model FROM products WHERE id IN (${ph})`).all(...parentIds)) {
      parents[p.id] = [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code
    }
  }
  return rows.map((r) => ({ ...r, parent_name: parents[r.parent_id] ?? `#${r.parent_id}` }))
}
