import { create } from 'zustand'
import type {
  Category,
  Customer,
  CustomerStatement,
  CustomerWithStats,
  InventoryBatch,
  Payment,
  PaymentMethod,
  PriceLevel,
  PriceTier,
  Product,
  ProductStatus,
  PurchaseOrderDetail,
  PurchaseOrderItemDetail,
  PurchaseOrderListItem,
  StatementSale,
  StockTake,
  StockTakeItem,
  Supplier,
  Transaction,
} from '@/types'
import { computeFifoPlan, type FifoAllocation } from '@/lib/fifo'
import { productName } from '@/lib/formatters'
import { backend } from '@/lib/api'

export interface InboundInput {
  productId: number
  quantity: number
  costPrice: number // 分
  location: string | null
  supplierId: number | null
  operator: string
}

export interface NewProductInput {
  sku_code: string
  barcode: string | null
  category: Category
  sub_category: string | null
  brand: string | null
  model: string | null
  cost_price: number
  suggest_price: number | null
  location: string | null
  status: ProductStatus
  // 渔具规格字段（v2.0 新增，全部选填）
  rod_length?: string | null
  rod_action?: string | null
  power_rating?: string | null
  line_number?: string | null
  hook_size?: string | null
  color?: string | null
  material?: string | null
  expiry_date?: string | null
}

export type FontSizeMode = 'normal' | 'large'

/** 赊账出库的记账参数：customerId=记账客户（散客为 null）；paidAmount=实收（分），省略=全额付清；
 * tier=价格档（可选）：显式售价优先，没传售价时按这档定价，没设这档回退建议零售价（与后端 confirmOutbound 口径一致） */
export interface CreditOptions {
  customerId?: number | null
  paidAmount?: number | null
  tier?: PriceLevel | null
}

/** 换货结果（与后端 createExchange 返回对齐）：diff>0 客户补钱，diff<0 退钱（refundHandling 说明实际处理方式） */
export type ExchangeResult =
  | {
      ok: true
      diff: number | null // 新腿售价合计 - 旧腿原售价合计（分）
      diffPaid: number | null // 差价实收（分）
      diffCredit: number // 差价赊欠额（分）
      oldUnitPrice: number // 旧腿原售价单价（分）
      oldPriceSource: 'transaction' | 'suggest' | 'none' // 旧价来源：最近售价流水 / 建议价 / 都没有按 0
      refund?: number // 退差价金额（分，diff<0 时）
      refundHandling?: 'credit_offset' | 'cash'
      refundCustomerId?: number
    }
  | { ok: false; shortage: number }

// 本机偏好设置持久化（本项目仅有的两个 localStorage 用途）；
// 读写都包 try/catch，隐私模式/异常环境下退回默认值而不是炸掉
const LS_SOUND = 'fi-sound'
const LS_FONT_SIZE = 'fi-font-size'

function readStorage(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, value)
  } catch {
    // 写不进去就算了，设置只在本次会话生效
  }
}

interface AppState {
  /** 操作提示音开关（成功/失败/扫码音），默认开 */
  soundEnabled: boolean
  /** 大字模式：根字号从默认提到 18px，全局 rem 生效 */
  fontSizeMode: FontSizeMode
  setSoundEnabled: (on: boolean) => void
  setFontSizeMode: (mode: FontSizeMode) => void

  products: Product[]
  batches: InventoryBatch[]
  transactions: Transaction[]
  suppliers: Supplier[]
  stockTakes: StockTake[]
  stockTakeItems: StockTakeItem[]
  /** 客户列表（带欠款统计）；loadAll 不含客户，Electron 环境由 loadCustomers 单独拉取 */
  customers: CustomerWithStats[]
  /** 还款记录：仅浏览器 mock 回退路径用来算欠款；Electron 环境欠款/对账一律以后端为准 */
  payments: Payment[]
  /** 采购订单列表（po:list 口径：带供应商名与收货进度）；Electron 由 loadPurchaseOrders 拉取 */
  purchaseOrders: PurchaseOrderListItem[]
  /** 采购单明细：仅浏览器 mock 回退路径使用；Electron 环境明细一律走 po:detail */
  purchaseOrderItems: PurchaseOrderItemDetail[]
  /** 全部商品的价格档次（loadAll 已带；mock 路径本地维护） */
  priceTiers: PriceTier[]
  /** Electron 环境下是否已从 SQLite 加载完数据 */
  loaded: boolean
  /** 数据加载/操作失败的提示，展示在布局顶部错误条 */
  error: string | null
  /** 低库存提醒弹窗开关（开机自动弹一次；之后可从仪表盘低库存卡片随时重开） */
  lowStockAlertOpen: boolean
  /** 本次启动是否已自动弹过，避免数据刷新时重复打扰 */
  lowStockAlertShown: boolean
  setLowStockAlertOpen: (open: boolean) => void

  /** Electron 环境启动时调用一次：从 SQLite 拉全量数据进 store */
  loadAll: () => Promise<void>

  findProductByBarcode: (barcode: string) => Product | undefined
  totalStockOf: (productId: number) => number
  batchesOf: (productId: number) => InventoryBatch[]
  lastCostOf: (productId: number) => number | null

  addProduct: (input: NewProductInput) => Promise<Product>
  /** 编辑商品资料；SKU 编码创建后不可改 */
  updateProduct: (id: number, input: Partial<NewProductInput>) => Promise<void>
  /** 删除商品；已有入库/出库记录的会被后端拒绝（应改「停产」） */
  deleteProduct: (id: number) => Promise<void>
  addInbound: (input: InboundInput) => Promise<void>
  confirmOutbound: (
    productId: number,
    quantity: number,
    unitPrice: number | null,
    operator: string,
    credit?: CreditOptions,
  ) => Promise<{ ok: true; allocations: FifoAllocation[] } | { ok: false; shortage: number }>
  /** 退货登记：库存加回最近批次，流水记 type='return'，refundPrice 为退款金额（分）；
   * customerId 仅在原流水是赊账销售时传（后端会冲减该客户欠款） */
  addReturn: (
    productId: number,
    quantity: number,
    refundPrice: number | null,
    operator: string,
    customerId?: number | null,
  ) => Promise<void>
  /** 换货登记：先退旧货再出新货（FIFO），sellingPrice 为新货售价（分）；新货库存不足返回 shortage。
   * opts.customerId=换货客户（差价赊账必传）；opts.diffPaidAmount=差价实收（分），省略=差价全额付清 */
  addExchange: (
    oldProductId: number,
    newProductId: number,
    quantity: number,
    sellingPrice: number | null,
    operator: string,
    opts?: { customerId?: number | null; diffPaidAmount?: number | null },
  ) => Promise<ExchangeResult>

  addSupplier: (s: Omit<Supplier, 'id'>) => Promise<void>
  updateSupplier: (id: number, s: Omit<Supplier, 'id'>) => Promise<void>
  deleteSupplier: (id: number) => Promise<void>

  /** 拉取采购单列表（po:list）；mock 路径本地已有全量，无需拉取 */
  loadPurchaseOrders: (status?: string) => Promise<void>
  /** 新建采购单：items 为 [{productId, quantity, costPrice(分)}]，返回新单（含单号） */
  createPurchaseOrder: (input: {
    supplierId: number | null
    items: { productId: number; quantity: number; costPrice: number }[]
    notes?: string | null
  }) => Promise<{ id: number; po_no: string }>
  /** 采购单详情（含明细）；Electron 走 po:detail，mock 本地拼 */
  purchaseOrderDetail: (id: number) => Promise<PurchaseOrderDetail>
  /** 收货入库：items 为 [{itemId, quantity}]，逐条建批次加库存；返回本次共收了多少件 */
  receivePurchaseOrder: (
    id: number,
    items: { itemId: number; quantity: number }[],
  ) => Promise<{ receivedTotal: number }>
  /** 取消采购单：已收的部分保留，未收的作废 */
  cancelPurchaseOrder: (id: number) => Promise<void>

  /** 设置某商品某档价格（分）；已存在则覆盖 */
  setPriceTier: (productId: number, tier: PriceLevel, price: number) => Promise<void>
  /** 删除某商品某档价格 */
  deletePriceTier: (productId: number, tier: PriceLevel) => Promise<void>

  /** 拉取客户列表（带欠款统计）；Electron 走 customer:list，mock 路径本地重算 */
  loadCustomers: () => Promise<void>
  addCustomer: (input: {
    name: string
    phone: string | null
    notes: string | null
    price_level?: PriceLevel | null
  }) => Promise<Customer>
  updateCustomer: (
    id: number,
    input: { name: string; phone: string | null; notes: string | null; price_level?: PriceLevel | null },
  ) => Promise<void>
  /** 有流水/还款记录的客户后端会拒绝删除，原因经 Error.message 抛出 */
  deleteCustomer: (id: number) => Promise<void>
  /** 还账登记：amount 单位分；返回还完后的欠款、是否多还/预收 */
  recordPayment: (input: {
    customerId: number
    amount: number
    method: PaymentMethod
    notes?: string | null
  }) => Promise<{ outstanding: number; overpaid: boolean; prepaid: boolean }>
  /** 客户对账单：赊销明细 + 还款记录 + 汇总 */
  customerStatement: (customerId: number) => Promise<CustomerStatement>

  createStockTake: (
    locationFilter: string | null,
    operator: string,
    filters?: { category?: Category | null; supplierId?: number | null },
  ) => Promise<StockTake>
  updateStockTakeItem: (itemId: number, actualQty: number, reason: string) => Promise<void>
  completeStockTake: (takeId: number) => Promise<void>
  /** 盘点原子提交：实盘数写入 + 完成盘点一次完成（替代逐条 update + complete 的两段式） */
  submitStockTake: (
    takeId: number,
    items: { itemId: number; actualQty: number; reason: string }[],
  ) => Promise<void>
}

// 自增 id 基于当前数据最大值，避免与 mock 数据冲突（仅浏览器 mock 回退路径使用）
const nextId = (rows: { id: number }[]) => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1

// 浏览器 mock 回退路径的欠款统计（口径参照后端 listCustomers；生产环境一律以后端 customer:list 为准）
export function computeCustomerStats(
  customers: Customer[],
  transactions: Transaction[],
  payments: Payment[],
): CustomerWithStats[] {
  return customers.map((c) => {
    let totalCredit = 0
    let lastTxAt: string | null = null
    for (const t of transactions) {
      if (t.customer_id !== c.id) continue
      if (t.type === 'exchange') {
        // 换货退差价：paid_amount 为负退款额，记了 customer_id 的就是冲减欠款（与后端 netCreditOf 同口径）
        totalCredit += t.paid_amount ?? 0
      } else if (t.selling_price == null) {
        continue
      } else if (t.type === 'out') {
        totalCredit += t.quantity * t.selling_price - (t.paid_amount ?? t.quantity * t.selling_price)
      } else if (t.type === 'return') {
        totalCredit -= t.quantity * t.selling_price
      } else {
        continue
      }
      if (lastTxAt === null || t.timestamp > lastTxAt) lastTxAt = t.timestamp
    }
    let totalPaidBack = 0
    let lastPayAt: string | null = null
    for (const p of payments) {
      if (p.customer_id !== c.id) continue
      totalPaidBack += p.amount
      if (lastPayAt === null || p.created_at > lastPayAt) lastPayAt = p.created_at
    }
    const lasts = [lastTxAt, lastPayAt].filter((x): x is string => x !== null)
    return {
      ...c,
      total_credit: totalCredit,
      total_paid_back: totalPaidBack,
      outstanding: totalCredit - totalPaidBack,
      last_deal_at: lasts.length > 0 ? lasts.reduce((a, b) => (a > b ? a : b)) : null,
    }
  })
}

/** 客户价格档自动定价（与后端 confirmOutbound 的 tier 口径一致）：
 * 客户设了档且商品设了这档价 → 用档次价；商品没设这档 → 回退建议零售价（不报错）；
 * 散客/没设档的客户按零售档，零售档也没设 → 建议零售价 */
export function priceForCustomer(
  product: Product,
  tiers: PriceTier[],
  customer: Pick<Customer, 'price_level'> | null,
): { price: number | null; tier: PriceLevel | null } {
  const level: PriceLevel = customer?.price_level ?? 'retail'
  const row = tiers.find((t) => t.product_id === product.id && t.tier === level)
  if (row) return { price: row.price, tier: level }
  return { price: product.suggest_price, tier: null }
}

function genBatchNo(seq: number): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `PO${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${String(seq).padStart(3, '0')}`
}

// 浏览器 mock 回退路径的 SKU 自动生成，与 electron/commands.js 同规则：
// 显式 SKU 原样用 > 有条码直接用条码 > 无条码纯数字编号（1001 起，6 位以内纯数字取 max+1；
// 条码当 SKU 的也是纯数字但超过 6 位，不参与编号序列）
function genSkuCode(products: Product[], input: NewProductInput): string {
  const existing = new Set(products.map((p) => p.sku_code))
  const barcode = input.barcode?.trim()
  if (barcode) {
    if (existing.has(barcode)) throw new Error(`该条码已被其他商品用作编码：${barcode}`)
    return barcode
  }
  let max = 1000
  for (const p of products) {
    if (/^\d{1,6}$/.test(p.sku_code)) max = Math.max(max, parseInt(p.sku_code, 10))
  }
  let n = max + 1
  while (existing.has(String(n))) n++
  return String(n)
}

export const useAppStore = create<AppState>((set, get) => ({
  soundEnabled: readStorage(LS_SOUND) !== 'off',
  fontSizeMode: readStorage(LS_FONT_SIZE) === 'large' ? 'large' : 'normal',
  setSoundEnabled: (on) => {
    writeStorage(LS_SOUND, on ? 'on' : 'off')
    set({ soundEnabled: on })
  },
  setFontSizeMode: (mode) => {
    writeStorage(LS_FONT_SIZE, mode)
    set({ fontSizeMode: mode })
  },

  // 初始为空：Electron 由 loadAll 填充，浏览器 dev 由 App.tsx 注入 mock（避免先闪 mock 再跳真数据）
  products: [],
  batches: [],
  transactions: [],
  suppliers: [],
  stockTakes: [],
  stockTakeItems: [],
  customers: [],
  payments: [],
  purchaseOrders: [],
  purchaseOrderItems: [],
  priceTiers: [],
  loaded: false,
  error: null,
  lowStockAlertOpen: false,
  lowStockAlertShown: false,
  setLowStockAlertOpen: (open) => set({ lowStockAlertOpen: open }),

  loadAll: async () => {
    if (!backend) return
    try {
      const data = await backend.invoke('data:loadAll')
      set({ ...data, loaded: true, error: null })
    } catch (e) {
      // 失败也要结束骨架屏，把错误亮出来而不是白屏转圈
      set({ loaded: true, error: `数据加载失败：${e instanceof Error ? e.message : String(e)}` })
    }
  },

  findProductByBarcode: (barcode) =>
    get().products.find((p) => p.barcode === barcode.trim()),

  totalStockOf: (productId) =>
    get()
      .batches.filter((b) => b.product_id === productId)
      .reduce((s, b) => s + b.quantity, 0),

  batchesOf: (productId) =>
    get()
      .batches.filter((b) => b.product_id === productId)
      .sort((a, b) => a.inbound_date.localeCompare(b.inbound_date) || a.id - b.id),

  lastCostOf: (productId) => {
    const batches = get().batchesOf(productId)
    if (batches.length > 0) return batches[batches.length - 1].cost_price
    const p = get().products.find((x) => x.id === productId)
    return p ? p.cost_price : null
  },

  addProduct: async (input) => {
    if (backend) {
      const product = await backend.invoke('product:create', input)
      await get().loadAll()
      return product
    }
    const now = new Date().toISOString()
    const product: Product = {
      id: nextId(get().products),
      ...input,
      sku_code: input.sku_code?.trim() || genSkuCode(get().products, input),
      photo_path: null,
      name_vi: null,
      // 规格字段（v2.0 新增）：表单传了就透传，没传默认空
      rod_length: input.rod_length ?? null,
      line_number: input.line_number ?? null,
      hook_size: input.hook_size ?? null,
      color: input.color ?? null,
      material: input.material ?? null,
      rod_action: input.rod_action ?? null,
      power_rating: input.power_rating ?? null,
      expiry_date: input.expiry_date ?? null,
      created_at: now,
      updated_at: now,
    }
    set((s) => ({ products: [...s.products, product] }))
    return product
  },

  updateProduct: async (id, input) => {
    if (backend) {
      await backend.invoke('product:update', { id, ...input })
      await get().loadAll()
      return
    }
    set((s) => ({
      products: s.products.map((p) =>
        p.id === id
          ? { ...p, ...input, id: p.id, sku_code: p.sku_code, updated_at: new Date().toISOString() }
          : p,
      ),
    }))
  },

  deleteProduct: async (id) => {
    if (backend) {
      const r = await backend.invoke('product:delete', { id })
      if (!r?.ok) throw new Error(r?.reason ?? '删除失败')
      await get().loadAll()
      return
    }
    const s = get()
    if (s.batches.some((b) => b.product_id === id) || s.transactions.some((t) => t.product_id === id)) {
      throw new Error('该商品已有入库/出库记录，不能删除；如不再经营请将状态改为「停产」')
    }
    set((st) => ({ products: st.products.filter((p) => p.id !== id) }))
  },

  addInbound: async ({ productId, quantity, costPrice, location, supplierId, operator }) => {
    if (backend) {
      await backend.invoke('inbound:create', { productId, quantity, costPrice, location, supplierId, operator })
      await get().loadAll()
      return
    }
    const state = get()
    const batchId = nextId(state.batches)
    const batch: InventoryBatch = {
      id: batchId,
      product_id: productId,
      batch_no: genBatchNo(batchId),
      quantity,
      cost_price: costPrice,
      location,
      inbound_date: new Date().toISOString().slice(0, 10),
      supplier_id: supplierId,
    }
    const transaction: Transaction = {
      id: nextId(state.transactions),
      product_id: productId,
      batch_id: batchId,
      type: 'in',
      quantity,
      unit_price: costPrice,
      timestamp: new Date().toISOString(),
      operator,
      notes: null,
    }
    set((s) => ({
      batches: [...s.batches, batch],
      transactions: [transaction, ...s.transactions],
      products: s.products.map((p) =>
        p.id === productId ? { ...p, cost_price: costPrice, updated_at: transaction.timestamp } : p,
      ),
    }))
  },

  confirmOutbound: async (productId, quantity, unitPrice, operator, credit) => {
    if (backend) {
      const result = await backend.invoke('outbound:confirm', {
        productId,
        quantity,
        sellingPrice: unitPrice,
        operator,
        customerId: credit?.customerId ?? null,
        paidAmount: credit?.paidAmount ?? null,
        tier: credit?.tier ?? null,
      })
      if (result.ok) {
        await get().loadAll()
        // 赊账/部分付款会改客户欠款，单独刷新客户列表（loadAll 不含客户）
        if (credit?.customerId != null) await get().loadCustomers()
      }
      return result
    }
    const state = get()
    // 多级定价（与后端同口径）：没传显式售价但传了价格档 → 该档定价，没设这档回退建议零售价
    let price = unitPrice
    if (price == null && credit?.tier != null) {
      const tierRow = state.priceTiers.find((t) => t.product_id === productId && t.tier === credit.tier)
      price = tierRow?.price ?? state.products.find((p) => p.id === productId)?.suggest_price ?? null
    }
    const plan = computeFifoPlan(state.batchesOf(productId), quantity)
    if (!plan.ok) return { ok: false, shortage: plan.shortage }

    // 赊账校验与后端 confirmOutbound 一致：实收不能超过应付，不满额必须选客户
    const totalDue = price != null ? quantity * price : null
    const paidAmount = credit?.paidAmount ?? null
    if (paidAmount != null && totalDue != null) {
      if (paidAmount > totalDue) throw new Error('实收金额不能超过应付总额')
      if (paidAmount < totalDue && credit?.customerId == null) throw new Error('赊账必须选客户')
    }
    const isCredit = totalDue != null && paidAmount != null && paidAmount < totalDue

    let txId = nextId(state.transactions)
    const now = new Date().toISOString()
    let paidLeft = isCredit ? paidAmount! : 0
    const newTxs: Transaction[] = plan.allocations.map((a) => {
      // 实收按批次行顺序摊销（与后端口径一致）；非赊账单 paid_amount 保持 null=全额付清
      const lineDue = price != null ? a.deduct * price : 0
      const linePaid = isCredit ? Math.min(paidLeft, lineDue) : null
      if (linePaid !== null) paidLeft -= linePaid
      return {
        id: txId++,
        product_id: productId,
        batch_id: a.batch_id,
        type: 'out',
        quantity: a.deduct,
        unit_price: a.cost_price, // 批次成本价（与后端语义一致）
        selling_price: price ?? null, // 实际售价
        timestamp: now,
        operator,
        notes: null,
        customer_id: credit?.customerId ?? null,
        paid_amount: linePaid,
      }
    })
    const deductBy = new Map(plan.allocations.map((a) => [a.batch_id, a.remaining_after]))
    const transactions = [...newTxs].reverse().concat(state.transactions)
    set((s) => ({
      batches: s.batches.map((b) =>
        deductBy.has(b.id) ? { ...b, quantity: deductBy.get(b.id)! } : b,
      ),
      transactions,
      customers:
        credit?.customerId != null
          ? computeCustomerStats(s.customers, transactions, s.payments)
          : s.customers,
    }))
    return { ok: true, allocations: plan.allocations }
  },

  addReturn: async (productId, quantity, refundPrice, operator, customerId) => {
    if (backend) {
      await backend.invoke('outbound:return', { productId, quantity, refundPrice, operator, customerId: customerId ?? null })
      await get().loadAll()
      // 赊账销售的退货会冲减客户欠款，单独刷新客户列表
      if (customerId != null) await get().loadCustomers()
      return
    }
    // mock 路径与后端 createReturn 同逻辑：加回最近批次，无批次则新建"退货回补"批次
    const state = get()
    const product = state.products.find((p) => p.id === productId)
    if (!product) throw new Error('商品不存在')
    const now = new Date().toISOString()
    const sorted = [...state.batchesOf(productId)].reverse() // batchesOf 已按入库日期升序
    const latest = sorted[0]
    let batchId: number
    let unitCost: number
    let newBatches = state.batches
    if (latest) {
      batchId = latest.id
      unitCost = latest.cost_price
      newBatches = state.batches.map((b) =>
        b.id === batchId ? { ...b, quantity: b.quantity + quantity } : b,
      )
    } else {
      batchId = nextId(state.batches)
      unitCost = product.cost_price
      newBatches = [
        ...state.batches,
        {
          id: batchId,
          product_id: productId,
          batch_no: genBatchNo(batchId),
          quantity,
          cost_price: unitCost,
          location: null,
          inbound_date: now.slice(0, 10),
          supplier_id: null,
        },
      ]
    }
    const tx: Transaction = {
      id: nextId(state.transactions),
      product_id: productId,
      batch_id: batchId,
      type: 'return',
      quantity,
      unit_price: unitCost,
      selling_price: refundPrice ?? null,
      timestamp: now,
      operator,
      notes: '退货回补',
      customer_id: customerId ?? null,
      paid_amount: null,
    }
    set((s) => ({
      batches: newBatches,
      transactions: [tx, ...s.transactions],
      customers:
        customerId != null
          ? computeCustomerStats(s.customers, [tx, ...s.transactions], s.payments)
          : s.customers,
    }))
  },

  addExchange: async (oldProductId, newProductId, quantity, sellingPrice, operator, opts) => {
    if (backend) {
      const r = await backend.invoke('outbound:exchange', {
        oldProductId,
        newProductId,
        quantity,
        sellingPrice,
        operator,
        customerId: opts?.customerId ?? null,
        diffPaidAmount: opts?.diffPaidAmount ?? null,
      })
      if (r?.ok) {
        await get().loadAll()
        // 差价赊账/退差价冲减都会改客户欠款，单独刷新客户列表（loadAll 不含客户）
        if (opts?.customerId != null || r?.refundHandling === 'credit_offset') {
          await get().loadCustomers()
        }
      }
      return r
    }
    // mock 路径与后端 createExchange 同逻辑（简化版，生产以后端为准）：
    // 先验新货库存，再一次 set 完成退旧+出新+差价记账
    const state = get()
    const old = state.products.find((p) => p.id === oldProductId)
    if (!old) throw new Error('旧商品不存在')
    if (opts?.customerId != null && !state.customers.some((c) => c.id === opts.customerId)) {
      throw new Error('客户不存在')
    }
    const plan = computeFifoPlan(state.batchesOf(newProductId), quantity)
    if (!plan.ok) return { ok: false, shortage: plan.shortage }

    // 旧腿原售价：最近一条带售价的出库流水 → 建议零售价 → 0（标注来源，与后端同口径）
    const oldTx =
      state.transactions.find(
        (t) => t.product_id === oldProductId && t.type === 'out' && t.selling_price != null,
      ) ?? null // transactions 新→旧排列，find 即最近一条
    let oldUnitPrice: number
    let oldPriceSource: 'transaction' | 'suggest' | 'none'
    if (oldTx) {
      oldUnitPrice = oldTx.selling_price!
      oldPriceSource = 'transaction'
    } else if (old.suggest_price != null) {
      oldUnitPrice = old.suggest_price
      oldPriceSource = 'suggest'
    } else {
      oldUnitPrice = 0
      oldPriceSource = 'none'
    }
    const oldTotal = oldUnitPrice * quantity
    const newTotal = sellingPrice != null ? sellingPrice * quantity : null
    const diff = newTotal != null ? newTotal - oldTotal : null

    // 差价实收校验（口径照后端：省略=全额付清；部分付/0=差价赊账，必须选客户）
    let diffPaid: number | null = null
    if (opts?.diffPaidAmount != null) {
      if (diff == null) throw new Error('记差价实收时必须填写新货售价')
      if (diff <= 0) {
        if (opts.diffPaidAmount > 0) throw new Error('新货价格不高于旧货，无差价可收（应退差价）')
      } else {
        if (opts.diffPaidAmount > diff) throw new Error('差价实收不能超过差价')
        if (opts.diffPaidAmount < diff && opts.customerId == null) throw new Error('赊账必须选客户')
        diffPaid = opts.diffPaidAmount
      }
    }
    // 本次换货的差价赊欠额（>0 才走赊账分摊：旧货价值视为已付）
    const diffCredit = diff != null && diff > 0 && diffPaid != null && diffPaid < diff ? diff - diffPaid : 0

    const now = new Date().toISOString()
    let txId = nextId(state.transactions)
    const newTxs: Transaction[] = []
    let newBatches = [...state.batches]

    // 退旧：回补最近批次（无批次则新建），按退货类型记账（与后端口径一致）
    const latestOld = [...state.batchesOf(oldProductId)].reverse()[0]
    if (latestOld) {
      newBatches = newBatches.map((b) =>
        b.id === latestOld.id ? { ...b, quantity: b.quantity + quantity } : b,
      )
      newTxs.push({
        id: txId++, product_id: oldProductId, batch_id: latestOld.id, type: 'return',
        quantity, unit_price: latestOld.cost_price, selling_price: null,
        timestamp: now, operator, notes: '换货退旧',
      })
    } else {
      const nbId = nextId(state.batches)
      newBatches = [
        ...newBatches,
        {
          id: nbId, product_id: oldProductId, batch_no: genBatchNo(nbId), quantity,
          cost_price: old.cost_price, location: null,
          inbound_date: now.slice(0, 10), supplier_id: null,
        },
      ]
      newTxs.push({
        id: txId++, product_id: oldProductId, batch_id: nbId, type: 'return',
        quantity, unit_price: old.cost_price, selling_price: null,
        timestamp: now, operator, notes: '换货退旧',
      })
    }

    // 出新：按 FIFO 方案扣减，按正常出库类型记账（报表自动涵盖）；
    // 差价赊账时实收分摊基数 = 新腿应付 - 赊欠差额，按 FIFO 顺序分摊
    const deductBy = new Map(plan.allocations.map((a) => [a.batch_id, a.remaining_after]))
    newBatches = newBatches.map((b) =>
      deductBy.has(b.id) ? { ...b, quantity: deductBy.get(b.id)! } : b,
    )
    let paidLeft = diffCredit > 0 ? newTotal! - diffCredit : 0
    for (const a of plan.allocations) {
      let linePaid: number | null = null
      if (diffCredit > 0) {
        linePaid = Math.min(a.deduct * sellingPrice!, paidLeft)
        paidLeft -= linePaid
      }
      newTxs.push({
        id: txId++, product_id: newProductId, batch_id: a.batch_id, type: 'out',
        quantity: a.deduct, unit_price: a.cost_price, selling_price: sellingPrice ?? null,
        timestamp: now, operator, notes: '换货出新',
        customer_id: opts?.customerId ?? null, paid_amount: linePaid,
      })
    }

    // 退差价：退款 = -diff；原购买赊账未付清 → 冲减该客户欠款，否则退现金（与后端同口径）
    let refund: number | undefined
    let refundHandling: 'credit_offset' | 'cash' | undefined
    let refundCustomerId: number | undefined
    if (diff != null && diff < 0) {
      refund = -diff
      const oldUnpaid =
        oldTx && oldTx.customer_id != null
          ? oldTx.quantity * oldTx.selling_price! -
            (oldTx.paid_amount ?? oldTx.quantity * oldTx.selling_price!)
          : 0
      refundHandling = oldUnpaid > 0 ? 'credit_offset' : 'cash'
      refundCustomerId = refundHandling === 'credit_offset' ? oldTx!.customer_id! : undefined
      newTxs.push({
        id: txId++, product_id: oldProductId, batch_id: null, type: 'exchange',
        quantity, unit_price: null, selling_price: null,
        timestamp: now, operator, notes: '换货退差价',
        customer_id: refundCustomerId ?? null, paid_amount: -refund,
      })
    }

    const transactions = [...newTxs].reverse().concat(state.transactions)
    set((s) => ({
      batches: newBatches,
      transactions,
      customers:
        opts?.customerId != null || refundHandling === 'credit_offset'
          ? computeCustomerStats(s.customers, transactions, s.payments)
          : s.customers,
    }))
    return {
      ok: true,
      diff,
      diffPaid: diff == null ? null : diff > 0 ? (diffPaid ?? diff) : 0,
      diffCredit,
      oldUnitPrice,
      oldPriceSource,
      refund,
      refundHandling,
      refundCustomerId,
    }
  },

  addSupplier: async (input) => {
    if (backend) {
      await backend.invoke('supplier:create', input)
      await get().loadAll()
      return
    }
    set((s) => ({ suppliers: [...s.suppliers, { id: nextId(s.suppliers), ...input }] }))
  },

  updateSupplier: async (id, input) => {
    if (backend) {
      await backend.invoke('supplier:update', { id, ...input })
      await get().loadAll()
      return
    }
    set((s) => ({
      suppliers: s.suppliers.map((x) => (x.id === id ? { ...x, ...input } : x)),
    }))
  },

  deleteSupplier: async (id) => {
    if (backend) {
      await backend.invoke('supplier:delete', { id })
      await get().loadAll()
      return
    }
    set((s) => ({
      suppliers: s.suppliers.filter((x) => x.id !== id),
      // 批次的外键置空而不是删除批次，保留入库历史
      batches: s.batches.map((b) => (b.supplier_id === id ? { ...b, supplier_id: null } : b)),
    }))
  },

  loadPurchaseOrders: async (status) => {
    if (backend) {
      const list = await backend.invoke('po:list', status ? { status } : {})
      set({ purchaseOrders: list })
    }
    // mock 回退路径：purchaseOrders 已在 state 里本地维护，无需拉取
  },

  createPurchaseOrder: async ({ supplierId, items, notes }) => {
    if (backend) {
      const po = await backend.invoke('po:create', { supplierId, items, notes: notes ?? null })
      await get().loadPurchaseOrders()
      return po
    }
    const state = get()
    const id = nextId(state.purchaseOrders)
    const now = new Date().toISOString()
    const po_no = genBatchNo(id)
    let itemId = nextId(state.purchaseOrderItems)
    const newItems: PurchaseOrderItemDetail[] = items.map((it) => {
      const p = state.products.find((x) => x.id === it.productId)
      return {
        id: itemId++,
        po_id: id,
        product_id: it.productId,
        product_desc: null,
        category: p?.category ?? null,
        quantity: it.quantity,
        received_qty: 0,
        unit_cost: it.costPrice,
        created_at: now,
        sku_code: p?.sku_code ?? null,
        brand: p?.brand ?? null,
        model: p?.model ?? null,
        product_name: p ? productName(p) : `#${it.productId}`,
      }
    })
    const order: PurchaseOrderListItem = {
      id,
      po_no,
      supplier_id: supplierId,
      status: 'sent',
      expected_arrival: null,
      total_cost: items.reduce((s, it) => s + it.quantity * it.costPrice, 0),
      created_at: now,
      updated_at: now,
      operator: null,
      notes: notes?.trim() || null,
      supplier_name: state.suppliers.find((s) => s.id === supplierId)?.name ?? null,
      item_count: items.length,
      total_qty: items.reduce((s, it) => s + it.quantity, 0),
      received_qty: 0,
    }
    set((s) => ({
      purchaseOrders: [order, ...s.purchaseOrders],
      purchaseOrderItems: [...s.purchaseOrderItems, ...newItems],
    }))
    return { id, po_no }
  },

  purchaseOrderDetail: async (id) => {
    if (backend) return backend.invoke('po:detail', { id })
    // mock 回退路径本地拼详情（口径参照后端 po:detail；生产环境以后端为准）
    const s = get()
    const order = s.purchaseOrders.find((o) => o.id === id)
    if (!order) throw new Error('采购单不存在')
    const { item_count: _ic, total_qty: _tq, received_qty: _rq, ...head } = order
    return {
      order: head,
      items: s.purchaseOrderItems.filter((it) => it.po_id === id),
    }
  },

  receivePurchaseOrder: async (id, items) => {
    const receivedTotal = items.reduce((s, it) => s + it.quantity, 0)
    if (backend) {
      await backend.invoke('po:receive', { id, items })
      // 收货会建批次、改库存和商品最近进价，全量刷新 + 重拉订单列表
      await get().loadAll()
      await get().loadPurchaseOrders()
      return { receivedTotal }
    }
    // mock 回退路径：真的建批次、记入库流水、推进收货进度（生产环境以后端 po:receive 为准）
    const state = get()
    const order = state.purchaseOrders.find((o) => o.id === id)
    if (!order) throw new Error('采购单不存在')
    if (order.status !== 'sent' && order.status !== 'partial') {
      throw new Error('这张单子已经收完或取消了，不能再收货')
    }
    const nowIso = new Date().toISOString()
    const today = nowIso.slice(0, 10)
    let batchId = nextId(state.batches)
    let txId = nextId(state.transactions)
    const newBatches: InventoryBatch[] = []
    const newTxs: Transaction[] = []
    const costByProduct = new Map<number, number>()
    const receivedByItem = new Map(items.map((i) => [i.itemId, i.quantity]))
    const updatedItems = state.purchaseOrderItems.map((it) => {
      const qty = receivedByItem.get(it.id)
      if (qty === undefined || it.po_id !== id) return it
      if (!Number.isInteger(qty) || qty < 1) throw new Error('收货数量必须是 ≥1 的整数')
      const remaining = it.quantity - it.received_qty
      if (qty > remaining) throw new Error(`「${it.product_name}」最多还能收 ${remaining} 件`)
      const product = state.products.find((p) => p.id === it.product_id)
      const bid = batchId++
      newBatches.push({
        id: bid,
        product_id: it.product_id!,
        batch_no: order.po_no,
        quantity: qty,
        cost_price: it.unit_cost,
        location: product?.location ?? null,
        inbound_date: today,
        supplier_id: order.supplier_id,
      })
      newTxs.push({
        id: txId++,
        product_id: it.product_id!,
        batch_id: bid,
        type: 'in',
        quantity: qty,
        unit_price: it.unit_cost,
        timestamp: nowIso,
        operator: order.operator,
        notes: `采购收货 ${order.po_no}`,
      })
      costByProduct.set(it.product_id!, it.unit_cost)
      return { ...it, received_qty: it.received_qty + qty }
    })
    const orderItems = updatedItems.filter((it) => it.po_id === id)
    const receivedQty = orderItems.reduce((s, it) => s + it.received_qty, 0)
    const totalQty = orderItems.reduce((s, it) => s + it.quantity, 0)
    const status = receivedQty >= totalQty ? ('complete' as const) : ('partial' as const)
    set((s) => ({
      purchaseOrderItems: updatedItems,
      purchaseOrders: s.purchaseOrders.map((o) =>
        o.id === id ? { ...o, status, received_qty: receivedQty, updated_at: nowIso } : o,
      ),
      batches: [...s.batches, ...newBatches],
      transactions: [...newTxs].reverse().concat(s.transactions),
      products: s.products.map((p) =>
        costByProduct.has(p.id)
          ? { ...p, cost_price: costByProduct.get(p.id)!, updated_at: nowIso }
          : p,
      ),
    }))
    return { receivedTotal }
  },

  cancelPurchaseOrder: async (id) => {
    if (backend) {
      await backend.invoke('po:cancel', { id })
      await get().loadPurchaseOrders()
      return
    }
    const order = get().purchaseOrders.find((o) => o.id === id)
    if (!order) throw new Error('采购单不存在')
    if (order.status !== 'sent' && order.status !== 'partial') {
      throw new Error('只有待收货/部分收货的单子才能取消')
    }
    set((st) => ({
      purchaseOrders: st.purchaseOrders.map((o) =>
        o.id === id
          ? { ...o, status: 'cancelled' as const, updated_at: new Date().toISOString() }
          : o,
      ),
    }))
  },

  setPriceTier: async (productId, tier, price) => {
    if (backend) {
      await backend.invoke('priceTier:set', { productId, tier, price })
      await get().loadAll()
      return
    }
    set((s) => {
      const existing = s.priceTiers.find((t) => t.product_id === productId && t.tier === tier)
      return {
        priceTiers: existing
          ? s.priceTiers.map((t) => (t.id === existing.id ? { ...t, price } : t))
          : [...s.priceTiers, { id: nextId(s.priceTiers), product_id: productId, tier, price }],
      }
    })
  },

  deletePriceTier: async (productId, tier) => {
    if (backend) {
      await backend.invoke('priceTier:delete', { productId, tier })
      await get().loadAll()
      return
    }
    set((s) => ({
      priceTiers: s.priceTiers.filter((t) => !(t.product_id === productId && t.tier === tier)),
    }))
  },

  loadCustomers: async () => {
    if (backend) {
      const customers = await backend.invoke('customer:list')
      set({ customers })
      return
    }
    const s = get()
    set({ customers: computeCustomerStats(s.customers, s.transactions, s.payments) })
  },

  addCustomer: async (input) => {
    const payload = {
      name: input.name.trim(),
      phone: input.phone?.trim() || null,
      notes: input.notes?.trim() || null,
      price_level: input.price_level ?? null,
    }
    if (!payload.name) throw new Error('客户姓名不能为空')
    if (backend) {
      const customer = await backend.invoke('customer:create', payload)
      await get().loadCustomers()
      return customer
    }
    if (get().customers.some((c) => c.name === payload.name)) {
      throw new Error(`已存在同名客户「${payload.name}」，请勿重复建档`)
    }
    const customer: Customer = {
      id: nextId(get().customers),
      ...payload,
      created_at: new Date().toISOString(),
    }
    set((s) => ({
      customers: computeCustomerStats([...s.customers, customer], s.transactions, s.payments),
    }))
    return customer
  },

  updateCustomer: async (id, input) => {
    const payload = {
      name: input.name.trim(),
      phone: input.phone?.trim() || null,
      notes: input.notes?.trim() || null,
      // 传 null=清除档位回零售默认（后端 updateCustomer 同口径）
      price_level: input.price_level ?? null,
    }
    if (!payload.name) throw new Error('客户姓名不能为空')
    if (backend) {
      await backend.invoke('customer:update', { id, ...payload })
      await get().loadCustomers()
      return
    }
    const s = get()
    if (!s.customers.some((c) => c.id === id)) throw new Error('客户不存在')
    if (s.customers.some((c) => c.id !== id && c.name === payload.name)) {
      throw new Error(`已存在同名客户「${payload.name}」`)
    }
    set((st) => ({
      customers: computeCustomerStats(
        st.customers.map((c) => (c.id === id ? { ...c, ...payload } : c)),
        st.transactions,
        st.payments,
      ),
    }))
  },

  deleteCustomer: async (id) => {
    if (backend) {
      const r = await backend.invoke('customer:delete', { id })
      if (!r?.ok) throw new Error(r?.reason ?? '删除失败')
      await get().loadCustomers()
      return
    }
    const s = get()
    const txCount = s.transactions.filter((t) => t.customer_id === id).length
    const payCount = s.payments.filter((p) => p.customer_id === id).length
    if (txCount > 0 || payCount > 0) {
      throw new Error(`该客户有 ${txCount} 条流水、${payCount} 条还款记录，不能删除（删除会弄丢赊账历史）`)
    }
    set((st) => ({ customers: st.customers.filter((c) => c.id !== id) }))
  },

  recordPayment: async ({ customerId, amount, method, notes }) => {
    if (backend) {
      const r = await backend.invoke('payment:record', { customerId, amount, method, notes })
      await get().loadCustomers()
      return { outstanding: r.outstanding as number, overpaid: !!r.overpaid, prepaid: !!r.prepaid }
    }
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('还款金额必须大于 0')
    const s = get()
    const cust = s.customers.find((c) => c.id === customerId)
    if (!cust) throw new Error('客户不存在')
    const payment: Payment = {
      id: nextId(s.payments),
      customer_id: customerId,
      amount,
      method,
      notes: notes?.trim() || null,
      created_at: new Date().toISOString(),
    }
    const payments = [...s.payments, payment]
    const customers = computeCustomerStats(s.customers, s.transactions, payments)
    set({ payments, customers })
    const outstanding = customers.find((c) => c.id === customerId)!.outstanding
    return { outstanding, overpaid: amount > Math.max(cust.outstanding, 0), prepaid: outstanding < 0 }
  },

  customerStatement: async (customerId) => {
    if (backend) return backend.invoke('customer:statement', { customerId })
    // mock 回退路径本地拼对账单（口径参照后端 customerStatement；生产环境以后端为准）
    const s = get()
    const cust = s.customers.find((c) => c.id === customerId)
    if (!cust) throw new Error('客户不存在')
    const sales: StatementSale[] = s.transactions
      .filter(
        (t) =>
          t.customer_id === customerId &&
          (t.type === 'out' || t.type === 'return') &&
          t.selling_price != null,
      )
      .map((t) => {
        const p = s.products.find((x) => x.id === t.product_id)
        const due = t.quantity * t.selling_price!
        const paid = t.type === 'out' ? (t.paid_amount ?? due) : 0
        return {
          id: t.id,
          timestamp: t.timestamp,
          type: t.type as 'out' | 'return',
          product_id: t.product_id,
          product_name: p ? productName(p) : `#${t.product_id}`,
          quantity: t.quantity,
          due,
          paid,
          owed: t.type === 'out' ? due - paid : -due,
        }
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id - a.id)
    const payments = s.payments
      .filter((p) => p.customer_id === customerId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    return {
      customer: cust,
      sales,
      payments,
      total_credit: cust.total_credit,
      total_paid_back: cust.total_paid_back,
      outstanding: cust.outstanding,
    }
  },

  createStockTake: async (locationFilter, operator, filters) => {
    if (backend) {
      const take = await backend.invoke('stocktake:create', {
        locationFilter,
        operator,
        category: filters?.category ?? null,
        supplierId: filters?.supplierId ?? null,
      })
      await get().loadAll()
      return take
    }
    const state = get()
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const id = nextId(state.stockTakes)
    const take: StockTake = {
      id,
      take_no: `ST${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${String(id).padStart(3, '0')}`,
      status: '进行中',
      location_filter: locationFilter,
      category_filter: filters?.category ?? null,
      supplier_filter: filters?.supplierId ?? null,
      started_at: d.toISOString(),
      completed_at: null,
      operator,
    }
    // 按筛选条件取批次生成明细：货位（批次货位或商品默认货位）+ 品类 + 供应商，三者取交集；
    // 批次数为 0 的商品也纳入（系统库存 0）
    const inArea = (loc: string | null) =>
      !locationFilter || (loc !== null && loc.startsWith(locationFilter))
    const itemBatches = state.batches.filter((b) => {
      if (b.quantity <= 0) return false
      const p = state.products.find((x) => x.id === b.product_id)
      if (!inArea(b.location) && !inArea(p?.location ?? null)) return false
      if (filters?.category != null && p?.category !== filters.category) return false
      if (filters?.supplierId != null && b.supplier_id !== filters.supplierId) return false
      return true
    })
    let itemId = nextId(state.stockTakeItems)
    const items: StockTakeItem[] = itemBatches.map((b) => ({
      id: itemId++,
      stock_take_id: id,
      product_id: b.product_id,
      batch_id: b.id,
      system_qty: b.quantity,
      actual_qty: null,
      difference: null,
      reason: '',
    }))
    set((s) => ({
      stockTakes: [take, ...s.stockTakes],
      stockTakeItems: [...s.stockTakeItems, ...items],
    }))
    return take
  },

  updateStockTakeItem: async (itemId, actualQty, reason) => {
    if (backend) {
      await backend.invoke('stocktake:updateItem', { itemId, actualQty, reason })
      await get().loadAll()
      return
    }
    set((s) => ({
      stockTakeItems: s.stockTakeItems.map((it) =>
        it.id === itemId
          ? { ...it, actual_qty: actualQty, difference: actualQty - it.system_qty, reason }
          : it,
      ),
    }))
  },

  completeStockTake: async (takeId) => {
    if (backend) {
      await backend.invoke('stocktake:complete', { takeId })
      await get().loadAll()
      return
    }
    const state = get()
    const items = state.stockTakeItems.filter((it) => it.stock_take_id === takeId)
    const now = new Date().toISOString()
    // 把盘点差异落实到批次库存，差异数按盘点单为准
    const qtyBy = new Map<number, number>()
    for (const it of items) {
      if (it.batch_id !== null && it.actual_qty !== null) qtyBy.set(it.batch_id, it.actual_qty)
    }
    set((s) => ({
      stockTakes: s.stockTakes.map((t) =>
        t.id === takeId ? { ...t, status: '已完成' as const, completed_at: now } : t,
      ),
      batches: s.batches.map((b) => (qtyBy.has(b.id) ? { ...b, quantity: qtyBy.get(b.id)! } : b)),
    }))
  },

  submitStockTake: async (takeId, items) => {
    if (backend) {
      await backend.invoke('stocktake:submit', { takeId, items })
      await get().loadAll()
      return
    }
    const now = new Date().toISOString()
    const submitted = new Map(items.map((i) => [i.itemId, i]))
    // 单次 set 完成全部写入，内存层面也是原子的
    set((s) => {
      const mergedItems = s.stockTakeItems.map((it) => {
        const sub = submitted.get(it.id)
        return sub && it.stock_take_id === takeId
          ? { ...it, actual_qty: sub.actualQty, difference: sub.actualQty - it.system_qty, reason: sub.reason }
          : it
      })
      const qtyByBatch = new Map<number, number>()
      for (const it of mergedItems) {
        if (it.stock_take_id === takeId && it.batch_id !== null && it.actual_qty !== null) {
          qtyByBatch.set(it.batch_id, it.actual_qty)
        }
      }
      return {
        stockTakeItems: mergedItems,
        stockTakes: s.stockTakes.map((t) =>
          t.id === takeId ? { ...t, status: '已完成' as const, completed_at: now } : t,
        ),
        batches: s.batches.map((b) =>
          qtyByBatch.has(b.id) ? { ...b, quantity: qtyByBatch.get(b.id)! } : b,
        ),
      }
    })
  },
}))
