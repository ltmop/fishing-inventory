// 命令层：所有数据库写操作的业务逻辑，与 Electron 解耦（可被 IPC 层或 Node 测试脚本调用）
// 规则来源：架构文档 v1.0 + Claude v3.0 修订（金额用分、FIFO 先进先出、出库记实际售价）

// now() 保持 UTC ISO 时间戳不变；today() 用本地日期（批次号/盘点单号按门店本地日期取当天序号）
export const now = () => new Date().toISOString()
export const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)

/** 校验数量必须是正整数（拒绝 0/负数/小数/NaN/null/undefined） */
export function assertPositiveInt(v, name) {
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`${name}必须是正整数，收到：${v}`)
  }
}

/** 校验金额（单位：分）必须是非负整数 */
export function assertFen(v, name) {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`${name}必须是非负整数（单位：分），收到：${v}`)
  }
}

// 收款方式白名单（出库收款 / 退货退款 / 客户还款共用）
export const PAYMENT_METHODS = ['现金', '微信', '支付宝', '其他']

/** 校验收款方式：null/undefined 放行（表示未记录），给了必须在白名单里 */
export function assertPayMethod(v, name = '收款方式') {
  if (v == null) return null
  if (!PAYMENT_METHODS.includes(v)) {
    throw new Error(`${name}必须是：${PAYMENT_METHODS.join(' / ')}，收到：${v}`)
  }
  return v
}

/** 最低库存预警线归一：留空/null → NULL（用默认阈值 5），否则必须是非负整数 */
function minStockOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`最低库存预警线必须是非负整数或留空，收到：${v}`)
  }
  return n
}

// ---------- 操作日志（audit_log） ----------
// 埋点规则：日志 INSERT 与业务写入在同一事务里，一起提交/一起回滚；
// 校验失败/提前 return（库存不足等）时零写入，自然也不留日志。

/** 写一条操作日志（仅供各写命令在事务内调用） */
function logAudit(db, action, entity, detail, operator) {
  db.prepare(
    'INSERT INTO audit_log (action, entity, detail, operator, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    action,
    entity ?? null,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    operator ?? null,
    now(),
  )
}

/** 操作日志查询：按时间倒序，可按 action 筛选（如 '入库'/'改价'） */
export function auditLog(db, { limit = 200, action } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000)
  if (action != null && action !== '') {
    return db
      .prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(String(action), n)
  }
  return db
    .prepare('SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(n)
}

/** 商品显示名：品牌+型号，都没有回退 SKU（与 customerStatement / server.js 同口径） */
function productLabel(p) {
  return [p.brand, p.model].filter(Boolean).join(' ') || p.sku_code
}

function pad(n, w = 3) {
  return String(n).padStart(w, '0')
}

/** 批次号：PO{YYYYMMDD}-{当日序号} */
function nextBatchNo(db) {
  const prefix = `PO${today().replaceAll('-', '')}-`
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM inventory_batches WHERE batch_no LIKE ?')
    .get(`${prefix}%`)
  return `${prefix}${pad(row.n + 1)}`
}

/** 盘点单号：ST{YYYYMMDD}-{当日序号} */
function nextTakeNo(db) {
  const prefix = `ST${today().replaceAll('-', '')}-`
  const row = db.prepare('SELECT COUNT(*) AS n FROM stock_takes WHERE take_no LIKE ?').get(`${prefix}%`)
  return `${prefix}${pad(row.n + 1)}`
}

/** 多语句写操作的事务包装 */
function inTransaction(db, fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// 品类代码速查（与 src/types/index.ts 的 CATEGORY_CODES 保持一致）；SKU 规则简化后
// 这里只用于品类合法性校验（importBatch / createStockTake），不再参与 SKU 生成
const CATEGORY_CODES = {
  鱼竿: 'FG', 鱼线: 'XL', 鱼钩: 'YG', 渔轮: 'YL',
  浮漂: 'FP', 铅坠: 'QZ', 饵料: 'ER', 路亚假饵: 'JL',
  渔网: 'WL', 钓箱钓椅: 'ZX', '伞/遮阳': 'SP', 支架: 'ZJ',
  服装穿戴: 'FZ', 灯具: 'DJ', 工具配件: 'GJ', 收纳包具: 'BN',
  增氧保鲜: 'ZY', 活饵: 'HE', 小药: 'XY', 其他: 'QT',
}

/**
 * 生成纯数字 SKU（无条码商品用）：从 1001 开始，取现有纯数字 SKU 的 max+1。
 * 注意：条码直接当 SKU 的也是纯数字（EAN-13 是 13 位），不参与这个序列，
 * 所以只统计 6 位以内的纯数字编号；老五段式 SKU（JC-*）天然不含在内。
 * @param {Set<string>} [reserved] 本次导入已占用、尚未落库的编号（importBatch 用）
 */
function nextNumericSku(db, reserved) {
  const row = db
    .prepare(
      `SELECT MAX(CAST(sku_code AS INTEGER)) AS m FROM products
       WHERE sku_code <> '' AND sku_code NOT GLOB '*[^0-9]*' AND CAST(sku_code AS INTEGER) < 1000000`,
    )
    .get()
  let n = Math.max(1001, (row.m ?? 0) + 1)
  const exists = db.prepare('SELECT 1 FROM products WHERE sku_code = ?')
  while (exists.get(String(n)) || reserved?.has(String(n))) n++
  return String(n)
}

// ---------- 查询 ----------

export function loadAll(db) {
  const q = (sql) => db.prepare(sql).all()
  return {
    products: q('SELECT * FROM products ORDER BY id'),
    batches: q('SELECT * FROM inventory_batches ORDER BY id'),
    transactions: q('SELECT * FROM transactions ORDER BY timestamp DESC, id DESC'),
    suppliers: q('SELECT * FROM suppliers ORDER BY id'),
    stockTakes: q('SELECT * FROM stock_takes ORDER BY id DESC'),
    stockTakeItems: q('SELECT * FROM stock_take_items ORDER BY id'),
    priceTiers: q('SELECT * FROM price_tiers ORDER BY product_id, id'),
    expenses: q('SELECT * FROM expenses ORDER BY expense_date DESC, id DESC'),
  }
}

// ---------- 商品 ----------

// 渔具规格字段（v2.0 新增，全部可空）：鱼竿长度/调性/硬度/线号/钩号/颜色/材质/保质期
const SPEC_FIELDS = [
  'rod_length', 'rod_action', 'power_rating', 'line_number',
  'hook_size', 'color', 'material', 'expiry_date',
]

/** 规格字段归一：去首尾空白，空串/undefined 一律落 NULL（与 nullable 字段同口径） */
function specOrNull(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

export function createProduct(db, input) {
  const ts = now()
  const minStock = minStockOrNull(input.min_stock)
  // SKU 规则（简化版）：显式传入的原样用（如 CSV 导入、老五段式）；
  // 留空时有条码直接用条码（扫码枪扫出来就是它），无条码用纯数字编号（1001 起递增）
  let skuCode = input.sku_code?.trim()
  if (!skuCode && input.barcode?.trim()) {
    skuCode = input.barcode.trim()
    if (db.prepare('SELECT 1 FROM products WHERE sku_code = ?').get(skuCode)) {
      throw new Error(`该条码已被其他商品用作编码：${skuCode}`)
    }
  }
  if (!skuCode) skuCode = nextNumericSku(db)
  return inTransaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO products (sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, status, rod_length, rod_action, power_rating, line_number, hook_size, color, material, expiry_date, min_stock, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        skuCode,
        input.barcode ?? null,
        input.category,
        input.sub_category ?? null,
        input.brand ?? null,
        input.model ?? null,
        input.cost_price,
        input.suggest_price ?? null,
        input.location ?? null,
        input.status ?? '待盘点',
        ...SPEC_FIELDS.map((f) => specOrNull(input[f])),
        minStock,
        ts,
        ts,
      )
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid)
    logAudit(db, '新建商品', productLabel(row), { sku: row.sku_code, cost_price: row.cost_price, min_stock: minStock }, input.operator)
    return row
  })
}

/** 修改商品基本信息；SKU 一经创建不可修改（避免历史流水对不上） */
export function updateProduct(db, id, input) {
  const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
  if (!cur) throw new Error('商品不存在')
  // 与现有行合并，允许前端只传要改的字段；SKU 创建后不可改
  const v = { ...cur, ...input, id: cur.id, sku_code: cur.sku_code }
  const minStock = minStockOrNull(v.min_stock)
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE products SET category = ?, sub_category = ?, brand = ?, model = ?, cost_price = ?, suggest_price = ?, location = ?, status = ?, rod_length = ?, rod_action = ?, power_rating = ?, line_number = ?, hook_size = ?, color = ?, material = ?, expiry_date = ?, min_stock = ?, photo_path = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      v.category,
      v.sub_category ?? null,
      v.brand ?? null,
      v.model ?? null,
      v.cost_price,
      v.suggest_price ?? null,
      v.location ?? null,
      v.status ?? '待盘点',
      ...SPEC_FIELDS.map((f) => specOrNull(v[f])),
      minStock,
      // 图片相对文件名（images 目录内）；与现有行合并，不传 photo_path 时保持原值
      v.photo_path ?? null,
      now(),
      id,
    )
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
    logAudit(db, '改商品', productLabel(row), { sku: row.sku_code, cost_price: row.cost_price, min_stock: minStock }, input.operator)
    return row
  })
}

/** 仅允许删除没有任何批次和流水的商品，防止库存历史断链 */
export function deleteProduct(db, id, operator = null) {
  const exists = db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)
  if (!exists) return { ok: false, reason: '商品不存在或已被删除' }
  const batchCount = db.prepare('SELECT COUNT(*) AS n FROM inventory_batches WHERE product_id = ?').get(id).n
  const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE product_id = ?').get(id).n
  if (batchCount > 0 || txCount > 0) {
    return { ok: false, reason: `该商品存在 ${batchCount} 个批次、${txCount} 条流水，不能删除；可改为"停产"状态` }
  }
  return inTransaction(db, () => {
    const cur = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
    db.prepare('DELETE FROM products WHERE id = ?').run(id)
    if (cur) logAudit(db, '删商品', productLabel(cur), { sku: cur.sku_code }, operator)
    return { ok: true }
  })
}

// 商品状态枚举（与 schema CHECK 一致）
const PRODUCT_STATUSES = ['待盘点', '已盘点', '已上架虾皮', '已售罄', '停产']

/**
 * 批量修改商品：一次事务改一批商品的价格/状态，两者至少传一个。
 * priceMode（可省，二选一）：
 *   { kind: 'ratio', ratio } 统一打折：建议售价与"已设"的各档价格 ×ratio，
 *     分单位四舍五入（最低 1 分，防止打成 0）；没设建议售价/没设档次的保持原样（不补建档次）。
 *   { kind: 'fixed', priceFen } 统一改价：建议售价与已设的各档价格都改成 priceFen。
 * status（可省）：批量改状态，限 5 态之一。
 * 任一商品 id 不存在直接报错、整批回滚（不留半截修改）；
 * 价格/状态各记一条 audit_log（"批量改价 N 个商品"），与写入同事务。
 */
export function batchUpdateProducts(db, { ids, priceMode, status, operator }) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('批量修改的商品列表不能为空')
  if (priceMode == null && status == null) throw new Error('批量修改至少要做一件事（改价或改状态）')
  if (priceMode != null) {
    if (priceMode.kind === 'ratio') {
      if (typeof priceMode.ratio !== 'number' || !Number.isFinite(priceMode.ratio) || priceMode.ratio <= 0) {
        throw new Error(`折扣必须是大于 0 的数字（如 0.9 表示 9 折），收到：${priceMode.ratio}`)
      }
    } else if (priceMode.kind === 'fixed') {
      assertPositiveInt(priceMode.priceFen, '统一售价')
    } else {
      throw new Error(`批量改价方式必须是 ratio（打折）或 fixed（统一价），收到：${priceMode.kind}`)
    }
  }
  if (status != null && !PRODUCT_STATUSES.includes(status)) {
    throw new Error(`状态必须是：${PRODUCT_STATUSES.join(' / ')}，收到：${status}`)
  }
  return inTransaction(db, () => {
    const ts = now()
    let tiersUpdated = 0
    for (const id of ids) {
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(id)
      if (!prod) throw new Error(`商品不存在（ID：${id}）`)
      if (priceMode != null) {
        const convert = (p) =>
          priceMode.kind === 'ratio' ? Math.max(1, Math.round(p * priceMode.ratio)) : priceMode.priceFen
        db.prepare('UPDATE products SET suggest_price = ?, updated_at = ? WHERE id = ?').run(
          prod.suggest_price == null ? null : convert(prod.suggest_price),
          ts,
          id,
        )
        // 只动"已设"的档次价；没设档的商品不补建
        const tiers = db.prepare('SELECT * FROM price_tiers WHERE product_id = ?').all(id)
        for (const t of tiers) {
          db.prepare('UPDATE price_tiers SET price = ? WHERE id = ?').run(convert(t.price), t.id)
          tiersUpdated++
        }
      }
      if (status != null) {
        db.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id)
      }
    }
    if (priceMode != null) {
      logAudit(db, '批量改价', `批量改价 ${ids.length} 个商品`, {
        count: ids.length,
        mode: priceMode.kind,
        ratio: priceMode.kind === 'ratio' ? priceMode.ratio : null,
        priceFen: priceMode.kind === 'fixed' ? priceMode.priceFen : null,
        tiersUpdated,
      }, operator)
    }
    if (status != null) {
      logAudit(db, '批量改状态', `批量改状态 ${ids.length} 个商品 → ${status}`, { count: ids.length, status }, operator)
    }
    return { ok: true, updated: ids.length, tiersUpdated }
  })
}

// ---------- 入库 ----------

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

// ---------- 出库（FIFO） ----------

/**
 * 按入库日期升序扣减批次；跨批次拆成多条 transactions
 * unit_price 记批次成本价，selling_price 记实际售价（利润 = selling_price - unit_price）
 *
 * 赊账扩展（客户余额模型）：
 * - customerId 可选；散客（不传）必须全额付清，部分付款/纯赊账会报"赊账必须选客户"
 * - paidAmount=实收金额（分）。省略或等于应付总额 → 各流水 paid_amount 存 NULL（全额付清）；
 *   小于应付 → 每条流水记实收，按 FIFO 顺序分摊，未被覆盖的批次流水记 0（0 也是赊账，与 NULL 语义不同）；
 *   传 0 → 纯赊账。paidAmount 超过应付总额直接报错。
 * - 返回值带 totalDue / paidAmount / creditAmount（本单赊账金额），方便前端提示。
 * 多级定价扩展（v2.0）：tier 可选（retail/regular/VIP/wholesale/promo）。
 * 售价取值优先级：显式 sellingPrice > 该商品 tier 档次价 > 商品建议零售价（仅传了 tier 时才回退）。
 * 传了 tier 但该商品没设该档 → 回退 suggest_price（没有则记 NULL，前端应手填）；
 * 不传 tier → 行为与旧版完全一致。赊账/客户逻辑在售价定下来之后走，不受影响。
 * 收款方式扩展：payMethod 可选（现金/微信/支付宝/其他）。只有真正收到钱时才落库——
 * 全额付清记各条流水；部分付款且实收>0 同样记；纯赊账（paidAmount=0）强制记 NULL（没有现金移动）。
 * 老数据/未传的一律 NULL=未记录，日结拆分单独归入"未记录"。
 */
export function confirmOutbound(db, { productId, quantity, sellingPrice, operator, customerId, paidAmount, tier, payMethod }) {
  // 入口先校验：数量为 0/负数时直接抛错，不再静默返回 { ok: true, allocations: [] }
  assertPositiveInt(quantity, '出库数量')
  if (sellingPrice != null) assertFen(sellingPrice, '出库售价')
  payMethod = assertPayMethod(payMethod)
  if (tier != null) {
    if (!PRICE_TIERS.includes(tier)) throw new Error(`价格档次必须是：${PRICE_TIERS.join(' / ')}，收到：${tier}`)
    if (sellingPrice == null) {
      const tierRow = db
        .prepare('SELECT price FROM price_tiers WHERE product_id = ? AND tier = ?')
        .get(productId, tier)
      sellingPrice = tierRow?.price ?? null
      // 该商品没设这档价 → 回退建议零售价
      if (sellingPrice == null) {
        const prod = db.prepare('SELECT suggest_price FROM products WHERE id = ?').get(productId)
        sellingPrice = prod?.suggest_price ?? null
      }
    }
  }
  if (paidAmount != null) {
    assertFen(paidAmount, '实收金额')
    if (sellingPrice == null) throw new Error('记实收金额时必须填写售价')
    const due = quantity * sellingPrice
    if (paidAmount > due) throw new Error(`实收金额不能超过应付总额（应付 ${due} 分，实收 ${paidAmount} 分）`)
    if (paidAmount < due && customerId == null) throw new Error('赊账必须选客户')
  }
  return inTransaction(db, () => {
    if (customerId != null) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
      if (!cust) throw new Error('客户不存在')
    }
    const batches = db
      .prepare(
        `SELECT * FROM inventory_batches
         WHERE product_id = ? AND quantity > 0
         ORDER BY inbound_date ASC, id ASC`,
      )
      .all(productId)
    const total = batches.reduce((s, b) => s + b.quantity, 0)
    if (total < quantity) return { ok: false, shortage: quantity - total }

    const ts = now()
    const totalDue = sellingPrice != null ? quantity * sellingPrice : null
    // 是否赊账单（部分付款/纯赊账）：只有赊账单才往 paid_amount 写实收，否则保持 NULL=全额付清
    const isCredit = totalDue != null && paidAmount != null && paidAmount < totalDue
    // 纯赊账没有现金移动，收款方式强制落空；部分付款实收>0 / 全额付清才记方式
    const methodForTx = isCredit && paidAmount === 0 ? null : payMethod
    let paidLeft = isCredit ? paidAmount : 0
    const allocations = []
    let remaining = quantity
    for (const b of batches) {
      if (remaining <= 0) break
      const deduct = Math.min(b.quantity, remaining)
      const after = b.quantity - deduct
      db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?').run(after, b.id)
      // 实收按 FIFO 顺序分摊到拆出来的每条流水；未覆盖到的记 0（纯赊那段）
      let paid = null
      if (isCredit) {
        paid = Math.min(deduct * sellingPrice, paidLeft)
        paidLeft -= paid
      }
      db.prepare(
        `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(productId, b.id, deduct, b.cost_price, sellingPrice ?? null, ts, operator ?? null, customerId ?? null, paid, methodForTx)
      allocations.push({
        batch_id: b.id,
        batch_no: b.batch_no,
        deduct,
        remaining_after: after,
        cost_price: b.cost_price,
      })
      remaining -= deduct
    }
    const outProd = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    logAudit(db, '出库', `${outProd ? productLabel(outProd) : `#${productId}`} x${quantity}`,
      { quantity, sellingPrice: sellingPrice ?? null, totalDue, paidAmount: isCredit ? paidAmount : null, creditAmount: isCredit ? totalDue - paidAmount : 0, customerId: customerId ?? null }, operator)
    return {
      ok: true,
      allocations,
      totalDue,
      paidAmount: isCredit ? paidAmount : null,
      creditAmount: isCredit ? totalDue - paidAmount : 0,
    }
  })
}

/**
 * 一单多商品收银台：一次开单出多种商品，所有行在同一事务里——
 * 任一行库存不足或校验失败，整单回滚不留半截（与盘点提交同原则）。
 * 行项目：{ productId, quantity, sellingPrice }，每行售价必填且 >0（收银台营业额/毛利全靠它）。
 * 收款口径与 confirmOutbound 一致：paidAmount 省略=全额付清（流水 paid_amount 记 NULL）；
 * 不满额=赊账必须选客户，实收按行顺序 + 行内 FIFO 逐条摊销；纯赊账（0）没有现金移动，pay_method 强制 NULL。
 * 返回 { ok, lines:[{productId, quantity, sellingPrice, allocations}], totalDue, paidAmount, creditAmount }
 * 或 { ok:false, shortages:[{productId, name, shortage}] }（哪几个商品不够、各差多少，一次说清）
 */
export function confirmCheckout(db, { items, customerId, paidAmount, payMethod, operator }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('开单商品列表不能为空')
  if (items.length > 50) throw new Error(`一单最多 50 种商品，收到：${items.length}`)
  payMethod = assertPayMethod(payMethod)
  const lines = items.map((it, i) => {
    assertPositiveInt(it.quantity, `第 ${i + 1} 行数量`)
    if (!Number.isInteger(it.sellingPrice) || it.sellingPrice <= 0) {
      throw new Error(`第 ${i + 1} 行售价必须大于 0（单位：分），收到：${it.sellingPrice}`)
    }
    return { productId: it.productId, quantity: it.quantity, sellingPrice: it.sellingPrice, due: it.quantity * it.sellingPrice }
  })
  const totalDue = lines.reduce((s, l) => s + l.due, 0)
  if (paidAmount != null) {
    assertFen(paidAmount, '实收金额')
    if (paidAmount > totalDue) throw new Error(`实收金额不能超过应付总额（应付 ${totalDue} 分，实收 ${paidAmount} 分）`)
    if (paidAmount < totalDue && customerId == null) throw new Error('赊账必须选客户')
  }
  return inTransaction(db, () => {
    if (customerId != null) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
      if (!cust) throw new Error('客户不存在')
    }
    // 先全部查库存（不改数据），不够的商品一次列清，收银员知道该从单子里拿掉哪样
    const planRows = []
    const shortages = []
    for (const l of lines) {
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(l.productId)
      if (!prod) throw new Error(`商品不存在（ID：${l.productId}）`)
      const batches = db
        .prepare(
          `SELECT * FROM inventory_batches
           WHERE product_id = ? AND quantity > 0
           ORDER BY inbound_date ASC, id ASC`,
        )
        .all(l.productId)
      const total = batches.reduce((s, b) => s + b.quantity, 0)
      if (total < l.quantity) {
        shortages.push({ productId: l.productId, name: productLabel(prod), shortage: l.quantity - total })
      }
      planRows.push({ line: l, batches })
    }
    if (shortages.length > 0) return { ok: false, shortages }
    const ts = now()
    const isCredit = paidAmount != null && paidAmount < totalDue
    // 纯赊账没有现金移动，收款方式强制落空；全额/部分收款才记方式
    const methodForTx = isCredit && paidAmount === 0 ? null : payMethod
    let paidLeft = isCredit ? paidAmount : 0
    const resultLines = []
    for (const { line: l, batches } of planRows) {
      let remaining = l.quantity
      const allocations = []
      for (const b of batches) {
        if (remaining <= 0) break
        const deduct = Math.min(b.quantity, remaining)
        db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?').run(b.quantity - deduct, b.id)
        // 实收按行顺序 + 行内 FIFO 摊销到每条流水；未覆盖到的记 0（赊的那段）
        let paid = null
        if (isCredit) {
          paid = Math.min(deduct * l.sellingPrice, paidLeft)
          paidLeft -= paid
        }
        db.prepare(
          `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method)
           VALUES (?, ?, 'out', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        ).run(l.productId, b.id, deduct, b.cost_price, l.sellingPrice, ts, operator ?? null, customerId ?? null, paid, methodForTx)
        allocations.push({ batch_id: b.id, batch_no: b.batch_no, deduct, remaining_after: b.quantity - deduct, cost_price: b.cost_price })
        remaining -= deduct
      }
      resultLines.push({ productId: l.productId, quantity: l.quantity, sellingPrice: l.sellingPrice, allocations })
    }
    const names = resultLines
      .map((rl) => {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(rl.productId)
        return `${p ? productLabel(p) : `#${rl.productId}`} x${rl.quantity}`
      })
      .join('，')
    logAudit(
      db,
      '收银开单',
      `${resultLines.length} 种商品：${names}`,
      { itemCount: resultLines.length, totalDue, paidAmount: isCredit ? paidAmount : null, creditAmount: isCredit ? totalDue - paidAmount : 0, customerId: customerId ?? null },
      operator,
    )
    return {
      ok: true,
      lines: resultLines,
      totalDue,
      paidAmount: isCredit ? paidAmount : null,
      creditAmount: isCredit ? totalDue - paidAmount : 0,
    }
  })
}

// ---------- 退货 ----------

/** 退货/换货共用：把数量加回最近入库的批次；无批次则新建"退货回补"批次。返回 { batchId, unitCost } */
function addBackToLatestBatch(db, productId, quantity) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
  if (!product) throw new Error('商品不存在')
  const latest = db
    .prepare(
      `SELECT * FROM inventory_batches WHERE product_id = ?
       ORDER BY inbound_date DESC, id DESC LIMIT 1`,
    )
    .get(productId)
  if (latest) {
    db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?').run(
      latest.quantity + quantity,
      latest.id,
    )
    return { batchId: latest.id, unitCost: latest.cost_price }
  }
  const unitCost = product.cost_price ?? 0
  const batchNo = nextBatchNo(db)
  const info = db
    .prepare(
      `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
       VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(productId, batchNo, quantity, unitCost, today())
  return { batchId: Number(info.lastInsertRowid), unitCost }
}

/**
 * 退货登记：顾客退回来的货重新入架。
 * 库存加回最近一次入库的批次（成本口径一致，FIFO 队列不被退货打乱）；
 * 该商品没有任何批次时新建一条"退货回补"批次，成本取商品最近进价。
 * 流水 type='return'：unit_price=批次成本，selling_price=退款金额（分），
 * 退款记 selling_price 让"今日经营小结"能把退货从营业额里体现出来。
 *
 * 赊账口径（重要）：如果当初那笔出库是赊账卖的，退货要冲减客户欠款——
 * 前端传 customerId，退货流水记 customer_id、paid_amount 记 NULL，
 * 欠款计算时 return 类型按 quantity*selling_price 以负数计入该客户的赊销合计。
 * 已全额收款的退货不要传 customerId（退的是现金，与赊账余额无关）。
 * 退款方式扩展：payMethod 可选（现金/微信/支付宝/其他）。只有真退钱（不传 customerId）才落库；
 * 冲减欠款的退货没有现金移动，pay_method 强制记 NULL。
 */
export function createReturn(db, { productId, quantity, refundPrice, operator, customerId, payMethod }) {
  assertPositiveInt(quantity, '退货数量')
  if (refundPrice != null) assertFen(refundPrice, '退款金额')
  payMethod = assertPayMethod(payMethod, '退款方式')
  return inTransaction(db, () => {
    if (customerId != null) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
      if (!cust) throw new Error('客户不存在')
    }
    const ts = now()
    const { batchId, unitCost } = addBackToLatestBatch(db, productId, quantity)
    db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount, pay_method)
       VALUES (?, ?, 'return', ?, ?, ?, ?, ?, '退货回补', ?, NULL, ?)`,
    ).run(productId, batchId, quantity, unitCost, refundPrice ?? null, ts, operator ?? null, customerId ?? null, customerId == null ? payMethod : null)
    const retProd = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    logAudit(db, '退货', `${retProd ? productLabel(retProd) : `#${productId}`} x${quantity}`,
      { quantity, refundPrice: refundPrice ?? null, customerId: customerId ?? null }, operator)
    return { ok: true, batchId }
  })
}

// ---------- 换货 ----------

/**
 * 换货登记：先退旧货再出新货，同一事务，任一环节失败整体回滚。
 * 记账口径（重要）：退旧腿记 type='return'（notes='换货退旧'），出新腿记 type='out'
 * （notes='换货出新'，unit_price=批次成本，selling_price=新货售价）——
 * 与退货/正常出库同类型，全站的今日记录、营业额、毛利、趋势统计自动涵盖换货，
 * 不需要每个报表单独识别 exchange 类型。
 * 新货库存不足时不落任何写入，返回 shortage。
 *
 * 差价扩展（customerId / diffPaidAmount 均可空）：
 * - 差价 diff = 新腿售价合计 - 旧腿原售价合计；旧腿原售价取该商品最近一条带售价的出库流水，
 *   找不到回退商品建议零售价，都没有按 0 并在返回 oldPriceSource='none' 标注。
 * - diff > 0（客户补钱）：diffPaidAmount 省略=差价全额付清（新腿流水 paid_amount 保持 NULL）；
 *   部分付/0=差价赊账（必须传 customerId，否则报"赊账必须选客户"，口径照 confirmOutbound）。
 *   赊账时新腿流水记 customer_id + paid_amount（按 FIFO 分摊：旧货价值视为已付，
 *   即 Σpaid = 新腿应付 - 赊欠差额），返回值带 {diff, diffPaid, diffCredit}。
 * - diff < 0（退钱给客户）：记一条 type='exchange' 数量为正的流水，paid_amount 记负退款额、
 *   notes 标注"换货退差价"；若原购买是赊账且未付清（旧腿原流水有 customer_id 且有未付部分），
 *   优先冲减该客户欠款（exchange 流水记原 customer_id，欠款口径见 netCreditOf），
 *   否则退现金（customer_id 记 NULL）；返回值 refundHandling 说明实际处理方式。
 */
export function createExchange(db, { oldProductId, newProductId, quantity, sellingPrice, operator, customerId, diffPaidAmount }) {
  assertPositiveInt(quantity, '换货数量')
  if (sellingPrice != null) assertFen(sellingPrice, '换货售价')
  if (diffPaidAmount != null) assertFen(diffPaidAmount, '差价实收')
  return inTransaction(db, () => {
    if (customerId != null) {
      const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
      if (!cust) throw new Error('客户不存在')
    }
    // 先验新货库存，不够直接拒绝（尚未写入，事务提交等于空操作）
    const newBatches = db
      .prepare(
        `SELECT * FROM inventory_batches
         WHERE product_id = ? AND quantity > 0
         ORDER BY inbound_date ASC, id ASC`,
      )
      .all(newProductId)
    const total = newBatches.reduce((s, b) => s + b.quantity, 0)
    if (total < quantity) return { ok: false, shortage: quantity - total }

    // 旧腿原售价：最近一条带售价的出库流水 → 建议零售价 → 0（标注来源）
    const oldTx = db
      .prepare(
        `SELECT selling_price, customer_id, paid_amount, quantity FROM transactions
         WHERE product_id = ? AND type = 'out' AND selling_price IS NOT NULL
         ORDER BY timestamp DESC, id DESC LIMIT 1`,
      )
      .get(oldProductId)
    let oldUnitPrice
    let oldPriceSource
    if (oldTx) {
      oldUnitPrice = oldTx.selling_price
      oldPriceSource = 'transaction'
    } else {
      const prod = db.prepare('SELECT suggest_price FROM products WHERE id = ?').get(oldProductId)
      if (prod?.suggest_price != null) {
        oldUnitPrice = prod.suggest_price
        oldPriceSource = 'suggest'
      } else {
        oldUnitPrice = 0
        oldPriceSource = 'none'
      }
    }
    const oldTotal = oldUnitPrice * quantity
    const newTotal = sellingPrice != null ? sellingPrice * quantity : null
    const diff = newTotal != null ? newTotal - oldTotal : null

    // 差价实收校验（口径照 confirmOutbound：省略=全额付清；部分付/0=赊账，必须选客户）
    let diffPaid = null
    if (diffPaidAmount != null) {
      if (diff == null) throw new Error('记差价实收时必须填写新货售价')
      if (diff <= 0) {
        if (diffPaidAmount > 0) throw new Error('新货价格不高于旧货，无差价可收（应退差价）')
      } else {
        if (diffPaidAmount > diff) {
          throw new Error(`差价实收不能超过差价（差价 ${diff} 分，实收 ${diffPaidAmount} 分）`)
        }
        if (diffPaidAmount < diff && customerId == null) throw new Error('赊账必须选客户')
        diffPaid = diffPaidAmount
      }
    }
    // 本次换货的差价赊欠额（>0 才走赊账分摊）
    const diffCredit = diff != null && diff > 0 && diffPaid != null && diffPaid < diff ? diff - diffPaid : 0

    const ts = now()
    // 退旧：回补最近批次，按退货类型记账
    const back = addBackToLatestBatch(db, oldProductId, quantity)
    db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
       VALUES (?, ?, 'return', ?, ?, NULL, ?, ?, '换货退旧')`,
    ).run(oldProductId, back.batchId, quantity, back.unitCost, ts, operator ?? null)

    // 出新：FIFO 扣减，按正常出库类型记账（营业额/毛利统计自动涵盖）
    // 差价赊账时：旧货价值视为已付，实收分摊基数 = 新腿应付 - 赊欠差额，按 FIFO 顺序分摊
    let paidLeft = diffCredit > 0 ? newTotal - diffCredit : 0
    let remaining = quantity
    for (const b of newBatches) {
      if (remaining <= 0) break
      const deduct = Math.min(b.quantity, remaining)
      db.prepare('UPDATE inventory_batches SET quantity = ? WHERE id = ?').run(b.quantity - deduct, b.id)
      let paid = null
      if (diffCredit > 0) {
        paid = Math.min(deduct * sellingPrice, paidLeft)
        paidLeft -= paid
      }
      db.prepare(
        `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?, '换货出新', ?, ?)`,
      ).run(newProductId, b.id, deduct, b.cost_price, sellingPrice ?? null, ts, operator ?? null, customerId ?? null, paid)
      remaining -= deduct
    }

    const result = {
      ok: true,
      diff,
      diffPaid: diff == null ? null : diff > 0 ? (diffPaid ?? diff) : 0,
      diffCredit,
      oldUnitPrice,
      oldPriceSource,
    }

    // 退差价：退款 = -diff；原购买赊账未付清 → 冲减欠款，否则退现金
    if (diff != null && diff < 0) {
      const refund = -diff
      const oldUnpaid =
        oldTx && oldTx.customer_id != null
          ? oldTx.quantity * oldTx.selling_price -
            (oldTx.paid_amount ?? oldTx.quantity * oldTx.selling_price)
          : 0
      const offset = oldUnpaid > 0
      db.prepare(
        `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes, customer_id, paid_amount)
         VALUES (?, NULL, 'exchange', ?, NULL, NULL, ?, ?, '换货退差价', ?, ?)`,
      ).run(oldProductId, quantity, ts, operator ?? null, offset ? oldTx.customer_id : null, -refund)
      result.refund = refund
      result.refundHandling = offset ? 'credit_offset' : 'cash'
      if (offset) result.refundCustomerId = oldTx.customer_id
    }
    const oldProd = db.prepare('SELECT * FROM products WHERE id = ?').get(oldProductId)
    const newProd = db.prepare('SELECT * FROM products WHERE id = ?').get(newProductId)
    logAudit(db, '换货',
      `${oldProd ? productLabel(oldProd) : `#${oldProductId}`} → ${newProd ? productLabel(newProd) : `#${newProductId}`} x${quantity}`,
      { quantity, diff, diffCredit, customerId: customerId ?? null }, operator)
    return result
  })
}

// ---------- 供应商 ----------

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

// ---------- 客户与赊账（客户余额模型） ----------
//
// 欠款口径（全站统一，listCustomers / recordPayment / customerStatement 共用）：
//   赊销净额 = Σ out 流水(quantity*selling_price - COALESCE(paid_amount, quantity*selling_price))
//              - Σ return 流水(quantity*selling_price)
//              + Σ exchange 流水(paid_amount)
//   · out 流水 paid_amount 为 NULL = 全额付清，贡献 0（赊账前的老数据、散客单都是 NULL，天然不纳入）
//   · selling_price 为 NULL 的老流水不纳入（没有售价就谈不上赊销）
//   · return 流水只要带了 customer_id 且记了退款金额，就按负数冲减（见 createReturn 注释）
//   · exchange 流水=换货退差价（见 createExchange）：paid_amount 为负退款额，记了 customer_id
//     的就是冲减欠款（负贡献），退现金的记 customer_id=NULL 天然不纳入
//   当前欠款 outstanding = 赊销净额 - 还款累计；允许为负，负值即预收（老板多收/先收的钱）

/** 单个客户的赊销净额（分）：out 未付部分 - return 冲减 + exchange 退差价冲减 */
function netCreditOf(db, customerId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
         WHEN type = 'out' AND selling_price IS NOT NULL
           THEN quantity * selling_price - COALESCE(paid_amount, quantity * selling_price)
         WHEN type = 'return' AND selling_price IS NOT NULL
           THEN -quantity * selling_price
         WHEN type = 'exchange' AND paid_amount IS NOT NULL
           THEN paid_amount
         ELSE 0 END), 0) AS net
       FROM transactions WHERE customer_id = ?`,
    )
    .get(customerId)
  return row.net
}

/** 单个客户的当前欠款（分）= 赊销净额 - 还款累计；可为负（预收） */
function outstandingOf(db, customerId) {
  const paid = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE customer_id = ?')
    .get(customerId).total
  return netCreditOf(db, customerId) - paid
}

/** 新建客户：姓名去空白后非空；同名客户拒绝建档（老板容易重复建）；price_level 可空（NULL=零售默认） */
export function createCustomer(db, { name, phone, notes, price_level }) {
  const n = name?.trim()
  if (!n) throw new Error('客户姓名不能为空')
  assertPriceLevel(price_level)
  return inTransaction(db, () => {
    const dup = db.prepare('SELECT id FROM customers WHERE name = ?').get(n)
    if (dup) throw new Error(`已存在同名客户「${n}」，请勿重复建档`)
    const info = db
      .prepare('INSERT INTO customers (name, phone, notes, price_level, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(n, phone?.trim() || null, notes?.trim() || null, price_level ?? null, now())
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid)
    logAudit(db, '新建客户', n, { phone: row.phone, price_level: row.price_level }, null)
    return row
  })
}

/** 修改客户资料：只传要改的字段；改名时同样做同名查重（排除自己）；price_level 传 null 清除（回零售默认） */
export function updateCustomer(db, { id, name, phone, notes, price_level }) {
  assertPriceLevel(price_level)
  return inTransaction(db, () => {
    const cur = db.prepare('SELECT * FROM customers WHERE id = ?').get(id)
    if (!cur) throw new Error('客户不存在')
    const n = name !== undefined ? name.trim() : cur.name
    if (!n) throw new Error('客户姓名不能为空')
    if (n !== cur.name) {
      const dup = db.prepare('SELECT id FROM customers WHERE name = ? AND id != ?').get(n, id)
      if (dup) throw new Error(`已存在同名客户「${n}」`)
    }
    db.prepare('UPDATE customers SET name = ?, phone = ?, notes = ?, price_level = ? WHERE id = ?').run(
      n,
      phone !== undefined ? phone?.trim() || null : cur.phone,
      notes !== undefined ? notes?.trim() || null : cur.notes,
      price_level !== undefined ? price_level ?? null : cur.price_level,
      id,
    )
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(id)
  })
}

/** 删除客户：有流水或还款记录的拒绝删除（删了赊账历史就对不上账了） */
export function deleteCustomer(db, { id }) {
  return inTransaction(db, () => {
    const cur = db.prepare('SELECT id FROM customers WHERE id = ?').get(id)
    if (!cur) return { ok: false, reason: '客户不存在' }
    const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE customer_id = ?').get(id).n
    const payCount = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE customer_id = ?').get(id).n
    if (txCount > 0 || payCount > 0) {
      return { ok: false, reason: `该客户有 ${txCount} 条流水、${payCount} 条还款记录，不能删除（删除会弄丢赊账历史）` }
    }
    db.prepare('DELETE FROM customers WHERE id = ?').run(id)
    return { ok: true }
  })
}

/**
 * 客户列表：每个客户带 outstanding（当前欠款，分；负=预收）、total_credit（赊销净额）、
 * total_paid_back（累计还款）、last_deal_at（最近交易/还款时间）
 */
export function listCustomers(db) {
  const creditRows = db
    .prepare(
      `SELECT customer_id,
         SUM(CASE
           WHEN type = 'out' AND selling_price IS NOT NULL
             THEN quantity * selling_price - COALESCE(paid_amount, quantity * selling_price)
           WHEN type = 'return' AND selling_price IS NOT NULL
             THEN -quantity * selling_price
           WHEN type = 'exchange' AND paid_amount IS NOT NULL
             THEN paid_amount
           ELSE 0 END) AS net_credit,
         MAX(timestamp) AS last_tx_at
       FROM transactions WHERE customer_id IS NOT NULL GROUP BY customer_id`,
    )
    .all()
  const payRows = db
    .prepare(
      `SELECT customer_id, SUM(amount) AS total_paid_back, MAX(created_at) AS last_pay_at
       FROM payments GROUP BY customer_id`,
    )
    .all()
  const creditMap = new Map(creditRows.map((r) => [r.customer_id, r]))
  const payMap = new Map(payRows.map((r) => [r.customer_id, r]))
  return db
    .prepare('SELECT * FROM customers ORDER BY id')
    .all()
    .map((c) => {
      const cr = creditMap.get(c.id)
      const pb = payMap.get(c.id)
      const total_credit = cr?.net_credit ?? 0
      const total_paid_back = pb?.total_paid_back ?? 0
      const lasts = [cr?.last_tx_at, pb?.last_pay_at].filter(Boolean)
      return {
        ...c,
        total_credit,
        total_paid_back,
        outstanding: total_credit - total_paid_back,
        last_deal_at: lasts.length > 0 ? lasts.reduce((a, b) => (a > b ? a : b)) : null,
      }
    })
}

/**
 * 还款登记：金额必须正整数（分）；方式限 现金/微信/支付宝/其他，默认现金。
 * 允许还款超过当前欠款（老板可能多收/预收），返回值里用 overpaid/prepaid 标注，
 * outstanding 为还款后的欠款（负值=预收）。
 */
export function recordPayment(db, { customerId, amount, method, notes }) {
  assertPositiveInt(amount, '还款金额')
  const m = method ?? '现金'
  if (!PAYMENT_METHODS.includes(m)) {
    throw new Error(`还款方式必须是：${PAYMENT_METHODS.join(' / ')}`)
  }
  return inTransaction(db, () => {
    const cust = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)
    if (!cust) throw new Error('客户不存在')
    const before = outstandingOf(db, customerId)
    const info = db
      .prepare('INSERT INTO payments (customer_id, amount, method, notes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(customerId, amount, m, notes?.trim() || null, now())
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(info.lastInsertRowid)
    const outstanding = before - amount
    const custName = db.prepare('SELECT name FROM customers WHERE id = ?').get(customerId).name
    logAudit(db, '还账', `${custName} 还 ${(amount / 100).toFixed(2)} 元`,
      { amount, method: m, before, outstanding }, null)
    return {
      ok: true,
      payment,
      outstanding,
      overpaid: amount > Math.max(before, 0), // 本次还款超过了之前欠的钱
      prepaid: outstanding < 0, // 还完后变成预收
    }
  })
}

/**
 * 客户对账单：
 * - sales：该客户全部带售价的 out/return 流水明细（时间/商品/数量/应付/已付/欠），
 *   out 行 欠=应付-实收（全额付清的为 0），return 行 欠=-退款额（冲减），按时间倒序
 * - payments：还款记录（时间/金额/方式/备注），按时间倒序
 * - 汇总字段与 listCustomers 同口径
 */
export function customerStatement(db, { customerId }) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId)
  if (!customer) throw new Error('客户不存在')
  const sales = db
    .prepare(
      `SELECT t.id, t.timestamp, t.type, t.product_id, t.quantity, t.selling_price, t.paid_amount,
              p.brand, p.model, p.sku_code
       FROM transactions t JOIN products p ON p.id = t.product_id
       WHERE t.customer_id = ? AND t.type IN ('out', 'return') AND t.selling_price IS NOT NULL
       ORDER BY t.timestamp DESC, t.id DESC`,
    )
    .all(customerId)
    .map((r) => {
      const due = r.quantity * r.selling_price
      const paid = r.type === 'out' ? (r.paid_amount ?? due) : 0
      return {
        id: r.id,
        timestamp: r.timestamp,
        type: r.type,
        product_id: r.product_id,
        product_name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code,
        quantity: r.quantity,
        due,
        paid,
        owed: r.type === 'out' ? due - paid : -due,
      }
    })
  const payments = db
    .prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at DESC, id DESC')
    .all(customerId)
  const summary = listCustomers(db).find((c) => c.id === customerId)
  return {
    customer,
    sales,
    payments,
    total_credit: summary.total_credit,
    total_paid_back: summary.total_paid_back,
    outstanding: summary.outstanding,
  }
}

// ---------- 盘点 ----------

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

// ---------- 采购订单（v2.0） ----------
//
// 状态机（schema CHECK：draft/sent/partial/complete/cancelled）：
//   建单即 sent（待收货：货已向供应商订出，draft 预留给以后的草稿功能）
//   sent --收货(未收齐)--> partial --收货(收齐)--> complete
//   sent/partial --取消--> cancelled（partial 取消：已收的部分保留，剩余未收作废）
//   complete/cancelled 为终态：不能再收货、不能再取消（重复收货/重复取消报中文错）

/** 采购单号：PO{YYYYMMDD}-{当日序号}（与批次号同风格，独立序号互不影响） */
function nextPoNo(db) {
  const prefix = `PO${today().replaceAll('-', '')}-`
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM purchase_orders WHERE po_no LIKE ?')
    .get(`${prefix}%`)
  return `${prefix}${pad(row.n + 1)}`
}

/**
 * 新建采购订单：供应商/商品必须存在；数量正整数、进价非负整数分；
 * 初始状态 sent（待收货），total_cost = Σ 数量×进价（分）
 */
export function createPurchaseOrder(db, { supplierId, items, notes, expectedDate, operator }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('采购明细不能为空')
  return inTransaction(db, () => {
    const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)
    if (!sup) throw new Error('供应商不存在')
    const ts = now()
    const poNo = nextPoNo(db)
    let totalCost = 0
    const lines = []
    for (const it of items) {
      assertPositiveInt(it.quantity, '采购数量')
      assertFen(it.costPrice, '采购进价')
      const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(it.productId)
      if (!prod) throw new Error(`商品不存在（ID：${it.productId}）`)
      totalCost += it.quantity * it.costPrice
      lines.push({ prod, quantity: it.quantity, unitCost: it.costPrice })
    }
    const info = db
      .prepare(
        `INSERT INTO purchase_orders (po_no, supplier_id, status, expected_arrival, total_cost, created_at, updated_at, operator, notes)
         VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?)`,
      )
      .run(poNo, supplierId, expectedDate ?? null, totalCost, ts, ts, operator ?? null, notes ?? null)
    const poId = Number(info.lastInsertRowid)
    const insItem = db.prepare(
      `INSERT INTO purchase_order_items (po_id, product_id, product_desc, category, quantity, received_qty, unit_cost, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    for (const l of lines) {
      const desc = [l.prod.brand, l.prod.model].filter(Boolean).join(' ') || l.prod.sku_code
      insItem.run(poId, l.prod.id, desc, l.prod.category, l.quantity, l.unitCost, ts)
    }
    return db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId)
  })
}

/** 采购单列表：按时间倒序，带供应商名/明细条数/总金额/已收进度 */
export function listPurchaseOrders(db, { status } = {}) {
  const rows = db
    .prepare(
      `SELECT po.*, s.name AS supplier_name,
              (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS item_count,
              (SELECT COALESCE(SUM(i.quantity), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS total_qty,
              (SELECT COALESCE(SUM(i.received_qty), 0) FROM purchase_order_items i WHERE i.po_id = po.id) AS received_qty
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
       ORDER BY po.created_at DESC, po.id DESC`,
    )
    .all()
  return status == null ? rows : rows.filter((r) => r.status === status)
}

/** 采购单详情：订单头 + 明细（每条带商品名/SKU/订了多少/已收多少） */
export function purchaseOrderDetail(db, { id }) {
  const order = db
    .prepare(
      `SELECT po.*, s.name AS supplier_name
       FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
       WHERE po.id = ?`,
    )
    .get(id)
  if (!order) throw new Error('采购订单不存在')
  const items = db
    .prepare(
      `SELECT i.*, p.sku_code, p.brand, p.model
       FROM purchase_order_items i LEFT JOIN products p ON p.id = i.product_id
       WHERE i.po_id = ? ORDER BY i.id`,
    )
    .all(id)
    .map((r) => ({
      ...r,
      product_name: [r.brand, r.model].filter(Boolean).join(' ') || r.sku_code || r.product_desc,
    }))
  return { order, items }
}

/**
 * 采购收货入库（核心）：每条明细本次收货数量 > 0 且 ≤ 剩余待收，超订报错；
 * 每条收货建独立批次（成本=订单进价、供应商=订单供应商）+ type='in' 流水（notes 标注采购单号），
 * 并同步商品最近进价（与手动入库同口径）；收齐 → complete，部分 → partial。
 * 整个操作同一事务：任一明细失败整单不记（批次/流水零写入）。
 */
export function receivePurchaseOrder(db, { id, items, operator }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('收货明细不能为空')
  return inTransaction(db, () => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id)
    if (!po) throw new Error('采购订单不存在')
    if (po.status === 'complete') throw new Error(`采购单 ${po.po_no} 已完成，不能重复收货`)
    if (po.status === 'cancelled') throw new Error(`采购单 ${po.po_no} 已取消，不能收货`)

    const ts = now()
    for (const it of items) {
      assertPositiveInt(it.quantity, '收货数量')
      const line = db.prepare('SELECT * FROM purchase_order_items WHERE id = ?').get(it.itemId)
      if (!line || line.po_id !== id) throw new Error(`明细 ${it.itemId} 不属于采购单 ${po.po_no}`)
      const remaining = line.quantity - line.received_qty
      if (it.quantity > remaining) {
        throw new Error(
          `超订：明细「${line.product_desc}」订 ${line.quantity} 已收 ${line.received_qty}，本次收 ${it.quantity} 超出剩余待收 ${remaining}`,
        )
      }
      // 入库：批次成本=订单进价，流水 notes 标注采购单号（与 createInbound 同口径，内联避免嵌套事务）
      const batchNo = nextBatchNo(db)
      const batchInfo = db
        .prepare(
          `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(line.product_id, batchNo, it.quantity, line.unit_cost, today(), po.supplier_id)
      const batchId = Number(batchInfo.lastInsertRowid)
      db.prepare(
        `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
         VALUES (?, ?, 'in', ?, ?, NULL, ?, ?, ?)`,
      ).run(line.product_id, batchId, it.quantity, line.unit_cost, ts, operator ?? null, `采购收货 ${po.po_no}`)
      db.prepare('UPDATE products SET cost_price = ?, updated_at = ? WHERE id = ?').run(line.unit_cost, ts, line.product_id)
      db.prepare('UPDATE purchase_order_items SET received_qty = ? WHERE id = ?').run(
        line.received_qty + it.quantity,
        line.id,
      )
      logAudit(db, '采购收货', `${line.product_desc} x${it.quantity}`,
        { poNo: po.po_no, batchNo, quantity: it.quantity, unitCost: line.unit_cost }, operator)
    }

    // 全部明细收齐 → 已完成，否则 → 部分收货
    const left = db
      .prepare('SELECT COALESCE(SUM(quantity - received_qty), 0) AS n FROM purchase_order_items WHERE po_id = ?')
      .get(id).n
    const status = left === 0 ? 'complete' : 'partial'
    db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id)
    return { ok: true, status, poNo: po.po_no }
  })
}

/**
 * 取消采购订单：仅 sent（待收货）/partial（部分收货）可取消；complete/cancelled 报中文错。
 * partial 取消时剩余未收部分作废、已收的部分保留（返回值 message 明示）。
 */
export function cancelPurchaseOrder(db, { id }) {
  return inTransaction(db, () => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id)
    if (!po) throw new Error('采购订单不存在')
    if (po.status === 'complete') throw new Error(`采购单 ${po.po_no} 已完成，不能取消`)
    if (po.status === 'cancelled') throw new Error(`采购单 ${po.po_no} 已取消，不能重复取消`)
    const hadReceived = po.status === 'partial'
    db.prepare("UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), id)
    return {
      ok: true,
      poNo: po.po_no,
      message: hadReceived ? '采购单已取消：已收的部分保留，剩余未收部分作废' : '采购单已取消',
    }
  })
}

// ---------- 多级定价（v2.0） ----------
// tier 取值与 schema CHECK 一致：retail/regular/VIP/wholesale/promo；价格正整数分；
// 同商品同 tier 覆盖更新（UPSERT）。标准零售价仍走 products.suggest_price，price_tiers 只存额外档次。

const PRICE_TIERS = ['retail', 'regular', 'VIP', 'wholesale', 'promo']

/** 客户价格档校验：NULL=零售默认，否则必须是五档之一 */
function assertPriceLevel(v) {
  if (v != null && !PRICE_TIERS.includes(v)) {
    throw new Error(`价格档次必须是：${PRICE_TIERS.join(' / ')}，收到：${v}`)
  }
}

export function setPriceTier(db, { productId, tier, price, operator }) {
  if (!PRICE_TIERS.includes(tier)) throw new Error(`价格档次必须是：${PRICE_TIERS.join(' / ')}，收到：${tier}`)
  assertPositiveInt(price, '档次价格')
  const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
  if (!prod) throw new Error('商品不存在')
  return inTransaction(db, () => {
    db.prepare(
      `INSERT INTO price_tiers (product_id, tier, price) VALUES (?, ?, ?)
       ON CONFLICT(product_id, tier) DO UPDATE SET price = excluded.price`,
    ).run(productId, tier, price)
    logAudit(db, '改价', productLabel(prod), { tier, price }, operator)
    return db.prepare('SELECT * FROM price_tiers WHERE product_id = ? AND tier = ?').get(productId, tier)
  })
}

export function deletePriceTier(db, { productId, tier }) {
  if (!PRICE_TIERS.includes(tier)) throw new Error(`价格档次必须是：${PRICE_TIERS.join(' / ')}，收到：${tier}`)
  const info = db.prepare('DELETE FROM price_tiers WHERE product_id = ? AND tier = ?').run(productId, tier)
  return { ok: info.changes > 0 }
}

export function getPriceTiers(db, { productId }) {
  return db.prepare('SELECT * FROM price_tiers WHERE product_id = ? ORDER BY id').all(productId)
}

// ---------- 批量导入 ----------

/**
 * 批量导入商品 + 批次，每条商品自动生成批次入库记录。
 * 逐行校验：坏行（数量非法、缺成本价、品类不在 20 大类内）记入 errors 并跳过该行，
 * 不再让一行坏数据导致整批回滚。
 * SKU 规则与手动新建一致：显式 SKU 原样用 > 有条码用条码 > 无条码自动编纯数字号（1001 起）。
 * 合法行仍在同一事务里整体提交，批次号与手动入库同规则。
 *
 * mode：
 * - 'skip'（默认，向后兼容）：已存在的 SKU 跳过（含本次导入内部的重复行）。
 * - 'update'：SKU 已存在 → 更新该商品的可写字段（品牌/型号/成本价/建议售价/规格/状态/min_stock；
 *   SKU 本身、库存数量、批次一律不动），表里留空的列保持原值不覆盖；
 *   SKU 不存在 → 照常按新商品导入（带批次入库）。更新记一条 audit_log（"Excel 更新 N 个商品"）。
 * 返回 { ok, imported, updated, skipped, results, errors }。
 * @param {{ rows: Array<{sku_code?, barcode?, category, sub_category?, brand?, model?, cost_price, suggest_price?, quantity, location?, operator?, rod_length?, rod_action?, power_rating?, line_number?, hook_size?, color?, material?, expiry_date?, status?, min_stock?}>, mode?: 'skip' | 'update' }} input
 */
export function importBatch(db, { rows, mode = 'skip' }) {
  if (mode !== 'skip' && mode !== 'update') {
    throw new Error(`导入模式必须是 skip（只加新商品）或 update（更新老商品），收到：${mode}`)
  }
  return inTransaction(db, () => {
    const ts = now()
    // 先过滤已存在的 SKU（含本次导入内部的重复行）
    const prodBySku = new Map(
      db.prepare('SELECT * FROM products').all().map((r) => [r.sku_code, r]),
    )
    const existing = new Set(prodBySku.keys())
    // 本次导入已处理的 SKU：文件内部重复行只处理第一次（update 模式也只更新一次）
    const seenInFile = new Set()
    const newRows = []
    const updateRows = []
    const errors = []
    let skipped = 0
    for (const [i, r] of rows.entries()) {
      // 逐行校验：坏行记入 errors 并跳过，合法行继续走导入
      try {
        assertPositiveInt(r.quantity, '数量')
        assertFen(r.cost_price, '成本价')
        if (!CATEGORY_CODES[r.category]) throw new Error(`品类非法：${r.category}`)
      } catch (e) {
        errors.push({ row: i + 1, sku_code: r.sku_code ?? null, reason: e.message })
        skipped++
        continue
      }
      // SKU：显式 > 条码 > 纯数字自动编号（existing 兼作本次导入的已占用编号集合）
      let sku = r.sku_code?.trim() || r.barcode?.trim() || nextNumericSku(db, existing)
      if (seenInFile.has(sku)) {
        skipped++ // 文件内部重复
      } else if (existing.has(sku)) {
        // update 模式且是店里已有的 SKU → 更新老商品；其余（skip 模式）跳过
        const prod = prodBySku.get(sku)
        if (mode === 'update' && prod) {
          updateRows.push({ ...r, sku_code: sku, __product: prod })
          seenInFile.add(sku)
        } else {
          skipped++
        }
      } else {
        existing.add(sku)
        seenInFile.add(sku)
        newRows.push({ ...r, sku_code: sku })
      }
    }

    const insProduct = db.prepare(
      `INSERT INTO products (sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, status, rod_length, rod_action, power_rating, line_number, hook_size, color, material, expiry_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '待盘点', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insBatch = db.prepare(
      `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    const insTx = db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, timestamp, operator, notes)
       VALUES (?, ?, 'in', ?, ?, ?, ?, '批量导入')`,
    )

    const results = []
    for (const r of newRows) {
      const info = insProduct.run(
        r.sku_code, r.barcode ?? null, r.category, r.sub_category ?? null,
        r.brand ?? null, r.model ?? null, r.cost_price, r.suggest_price ?? null,
        r.location ?? null, ...SPEC_FIELDS.map((f) => specOrNull(r[f])), ts, ts,
      )
      const productId = Number(info.lastInsertRowid)
      const batchNo = nextBatchNo(db) // 与手动入库同一套批次号规则
      const qty = r.quantity ?? 0
      const batchInfo = insBatch.run(productId, batchNo, qty, r.cost_price, r.location ?? null, today())
      const batchId = Number(batchInfo.lastInsertRowid)
      insTx.run(productId, batchId, qty, r.cost_price, ts, r.operator ?? '导入')
      results.push({ productId, batchId, batchNo, sku_code: r.sku_code })
    }

    // update 模式：按 SKU 匹配更新老商品资料。空着的列不动原值；SKU/库存/批次一律不碰。
    const updatedSkus = []
    for (const r of updateRows) {
      const prod = r.__product
      const upd = {}
      if (r.brand != null && String(r.brand).trim() !== '') upd.brand = String(r.brand).trim()
      if (r.model != null && String(r.model).trim() !== '') upd.model = String(r.model).trim()
      if (r.cost_price != null) upd.cost_price = r.cost_price
      if (r.suggest_price != null) upd.suggest_price = r.suggest_price
      for (const f of SPEC_FIELDS) {
        const v = specOrNull(r[f])
        if (v != null) upd[f] = v
      }
      if (r.status != null) {
        if (!PRODUCT_STATUSES.includes(r.status)) {
          throw new Error(`状态必须是：${PRODUCT_STATUSES.join(' / ')}，收到：${r.status}（SKU：${r.sku_code}）`)
        }
        upd.status = r.status
      }
      if (r.min_stock != null) upd.min_stock = minStockOrNull(r.min_stock)
      const keys = Object.keys(upd)
      if (keys.length > 0) {
        db.prepare(
          `UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ).run(...keys.map((k) => upd[k]), ts, prod.id)
      }
      updatedSkus.push(r.sku_code)
    }
    if (updatedSkus.length > 0) {
      logAudit(db, 'Excel更新', `Excel 更新 ${updatedSkus.length} 个商品`, { updated: updatedSkus.length, skus: updatedSkus }, rows[0]?.operator ?? '导入')
    }
    return { ok: true, imported: results.length, updated: updatedSkus.length, skipped, results, errors }
  })
}

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
 * 解析保质期文本为本地日期（只认两种写法，其余返回 null 跳过）：
 * 'YYYY-MM' → 当月最后一天（保质"到几月"的常识口径）；'YYYY-MM-DD' → 当天
 */
function parseExpiryDate(s) {
  const text = String(s ?? '').trim()
  let m = /^(\d{4})-(\d{2})$/.exec(text)
  if (m) return new Date(Number(m[1]), Number(m[2]), 0) // 当月最后一天
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return null
}

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

// ---------- 供应商对账 ----------

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

// ---------- 支出记账（v1.10） ----------
// 口径：净利 = 毛利 − 支出。支出按 expense_date（本地日期）归属到当天，
// 与经营报表"赚了多少"同区间相减；只记钱出去，不影响库存和批次。

// 支出分类白名单（个体户常见科目，杂项兜底）
export const EXPENSE_CATEGORIES = ['进货付款', '房租', '水电', '运费', '人工', '杂项']

const EXPENSE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 支出字段公共校验：分类/金额/方式/日期/供应商，返回归一后的字段 */
function normalizeExpense(db, { category, amount, method, supplierId, expenseDate, note }) {
  if (!EXPENSE_CATEGORIES.includes(category)) {
    throw new Error(`支出分类必须是：${EXPENSE_CATEGORIES.join(' / ')}，收到：${category}`)
  }
  assertPositiveInt(amount, '支出金额')
  const m = method ?? '现金'
  if (!PAYMENT_METHODS.includes(m)) {
    throw new Error(`付款方式必须是：${PAYMENT_METHODS.join(' / ')}，收到：${method}`)
  }
  const date = expenseDate ?? today()
  if (!EXPENSE_DATE_RE.test(date)) {
    throw new Error(`支出日期必须是 YYYY-MM-DD 格式，收到：${expenseDate}`)
  }
  let sid = null
  if (supplierId != null) {
    const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)
    if (!sup) throw new Error('供应商不存在')
    sid = supplierId
  }
  return { category, amount, method: m, supplierId: sid, expenseDate: date, note: note?.trim() || null }
}

/** 记一笔支出：金额单位分；返回完整行（含关联供应商名） */
export function createExpense(db, input) {
  const v = normalizeExpense(db, input)
  return inTransaction(db, () => {
    const info = db
      .prepare(
        `INSERT INTO expenses (category, amount, method, supplier_id, note, expense_date, operator, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(v.category, v.amount, v.method, v.supplierId, v.note, v.expenseDate, input.operator ?? null, now())
    const row = getExpense(db, info.lastInsertRowid)
    logAudit(db, '记支出', `${v.category} ${(v.amount / 100).toFixed(2)} 元`,
      { id: row.id, ...v }, input.operator)
    return row
  })
}

/** 改支出：整单字段全量替换（简单账目不做部分更新） */
export function updateExpense(db, input) {
  const { id } = input
  const old = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id)
  if (!old) throw new Error('支出记录不存在或已被删除')
  const v = normalizeExpense(db, input)
  return inTransaction(db, () => {
    db.prepare(
      `UPDATE expenses SET category = ?, amount = ?, method = ?, supplier_id = ?, note = ?, expense_date = ?
       WHERE id = ?`,
    ).run(v.category, v.amount, v.method, v.supplierId, v.note, v.expenseDate, id)
    const row = getExpense(db, id)
    logAudit(db, '改支出', `${v.category} ${(v.amount / 100).toFixed(2)} 元`,
      { id, before: { category: old.category, amount: old.amount }, after: v }, input.operator)
    return row
  })
}

/** 删支出：账目可删（不像客户有引用完整性问题），留审计日志 */
export function deleteExpense(db, { id, operator }) {
  const old = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id)
  if (!old) throw new Error('支出记录不存在或已被删除')
  return inTransaction(db, () => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id)
    logAudit(db, '删支出', `${old.category} ${(old.amount / 100).toFixed(2)} 元`,
      { id, category: old.category, amount: old.amount, expense_date: old.expense_date }, operator)
    return { ok: true }
  })
}

/** 单条支出（含供应商名） */
function getExpense(db, id) {
  return db
    .prepare(
      `SELECT e.*, s.name AS supplier_name
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id
       WHERE e.id = ?`,
    )
    .get(id)
}

/**
 * 支出列表：可按日期区间 [from, to]（YYYY-MM-DD，含两端）和分类筛选，
 * 按日期倒序返回（含供应商名，直接给页面渲染）
 */
export function listExpenses(db, { from, to, category, limit = 500 } = {}) {
  const conds = []
  const args = []
  if (from) { conds.push('e.expense_date >= ?'); args.push(from) }
  if (to) { conds.push('e.expense_date <= ?'); args.push(to) }
  if (category) {
    if (!EXPENSE_CATEGORIES.includes(category)) {
      throw new Error(`支出分类必须是：${EXPENSE_CATEGORIES.join(' / ')}，收到：${category}`)
    }
    conds.push('e.category = ?')
    args.push(category)
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
  return db
    .prepare(
      `SELECT e.*, s.name AS supplier_name
       FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id
       ${where}
       ORDER BY e.expense_date DESC, e.id DESC
       LIMIT ?`,
    )
    .all(...args, Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000))
}

/** 新手引导：清空演示数据正式开张。
 *  铁律：清空前强制跑一次自动备份（数据一旦删除不可恢复）。
 *  清空范围：流水、批次、商品、供应商、盘点单和明细（保留 settings 表） */
export function resetDemoData(db) {
  return inTransaction(db, () => {
    // 删除顺序按外键依赖：先删子表再删主表
    db.exec('DELETE FROM stock_take_items')
    db.exec('DELETE FROM stock_takes')
    db.exec('DELETE FROM transactions')
    db.exec('DELETE FROM inventory_batches')
    db.exec('DELETE FROM expenses')
    db.exec('DELETE FROM payments')
    db.exec('DELETE FROM purchase_order_items')
    db.exec('DELETE FROM purchase_orders')
    db.exec('DELETE FROM price_tiers')
    db.exec('DELETE FROM products')
    db.exec('DELETE FROM suppliers')
    db.exec('DELETE FROM customers')
    // 标记新手引导已完成（下次启动不再弹出）
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('fi-onboarded', '1')
    return { ok: true, message: '演示数据已清空，可以开始录入真实库存了' }
  })
}

/** 完成新手引导（不删数据，只标记已完成） */
export function finishOnboarding(db) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('fi-onboarded', '1')
  return { ok: true }
}

/** 检查新手引导是否已完成 */
export function onboardingStatus(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'fi-onboarded'").get()
    return { completed: row?.value === '1' }
  } catch {
    return { completed: false }
  }
}
