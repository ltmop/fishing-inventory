// 与后端数据库 Schema 一一对应的类型契约，字段名不可改

// 20大类，与知识库品类层级匹配
export type Category =
  | '鱼竿'
  | '鱼线'
  | '鱼钩'
  | '渔轮'
  | '浮漂'
  | '铅坠'
  | '饵料'
  | '路亚假饵'
  | '渔网'
  | '钓箱钓椅'
  | '伞/遮阳'
  | '支架'
  | '服装穿戴'
  | '灯具'
  | '工具配件'
  | '收纳包具'
  | '增氧保鲜'
  | '活饵'
  | '小药'
  | '其他'

export const CATEGORIES: Category[] = [
  '鱼竿',
  '鱼线',
  '鱼钩',
  '渔轮',
  '浮漂',
  '铅坠',
  '饵料',
  '路亚假饵',
  '渔网',
  '钓箱钓椅',
  '伞/遮阳',
  '支架',
  '服装穿戴',
  '灯具',
  '工具配件',
  '收纳包具',
  '增氧保鲜',
  '活饵',
  '小药',
  '其他',
]

// 品类代码速查（用于SKU自动生成）
export const CATEGORY_CODES: Record<Category, string> = {
  '鱼竿': 'FG', '鱼线': 'XL', '鱼钩': 'YG', '渔轮': 'YL',
  '浮漂': 'FP', '铅坠': 'QZ', '饵料': 'ER', '路亚假饵': 'JL',
  '渔网': 'WL', '钓箱钓椅': 'ZX', '伞/遮阳': 'SP', '支架': 'ZJ',
  '服装穿戴': 'FZ', '灯具': 'DJ', '工具配件': 'GJ', '收纳包具': 'BN',
  '增氧保鲜': 'ZY', '活饵': 'HE', '小药': 'XY', '其他': 'QT',
}

export type ProductStatus = '待盘点' | '已盘点' | '已上架虾皮' | '已售罄' | '停产'

export const PRODUCT_STATUSES: ProductStatus[] = [
  '待盘点',
  '已盘点',
  '已上架虾皮',
  '已售罄',
  '停产',
]

export interface Product {
  id: number
  sku_code: string
  barcode: string | null
  category: Category
  sub_category: string | null  // 子类，如"手竿""PE线""伊势尼""抄网"
  brand: string | null
  model: string | null
  cost_price: number // 单位：分
  suggest_price: number | null // 单位：分
  location: string | null
  photo_path: string | null
  name_vi: string | null
  rod_length: string | null
  line_number: string | null
  hook_size: string | null
  color: string | null
  material: string | null
  rod_action: string | null
  power_rating: string | null
  expiry_date: string | null
  status: ProductStatus
  created_at: string
  updated_at: string
}

export interface InventoryBatch {
  id: number
  product_id: number
  batch_no: string
  quantity: number
  cost_price: number // 单位：分
  location: string | null
  inbound_date: string // YYYY-MM-DD
  supplier_id: number | null
  notes?: string | null
  created_at?: string
}

export type TransactionType = 'in' | 'out' | 'return' | 'exchange'

export interface Transaction {
  id: number
  product_id: number
  batch_id: number | null
  type: TransactionType
  quantity: number
  unit_price: number | null // 单位：分；入库=进价，出库=批次成本价
  selling_price?: number | null // 单位：分；出库时的实际售价，入库/退货为 null
  timestamp: string
  operator: string | null
  notes: string | null
  customer_id?: number | null // 赊账包：赊账/记账客户；散客为 null
  paid_amount?: number | null // 单位：分；实收金额，null=已全额付清（含赊账前的老数据）
}

// ---------- 赊账包：客户与还款（客户余额模型） ----------

export interface Customer {
  id: number
  name: string
  phone: string | null
  notes: string | null
  created_at: string
}

/** 客户 + 赊账汇总（customer:list 返回）：outstanding 为负=预收 */
export interface CustomerWithStats extends Customer {
  outstanding: number // 当前欠款，单位：分
  total_credit: number // 赊销净额（赊销 - 赊账退货冲减），单位：分
  total_paid_back: number // 累计还款，单位：分
  last_deal_at: string | null // 最近交易/还款时间
}

export type PaymentMethod = '现金' | '微信' | '支付宝' | '其他'

export const PAYMENT_METHODS: PaymentMethod[] = ['现金', '微信', '支付宝', '其他']

export interface Payment {
  id: number
  customer_id: number
  amount: number // 单位：分
  method: PaymentMethod
  notes: string | null
  created_at: string
}

/** 对账单赊销明细行（customer:statement 的 sales 元素）；退货行 owed 为负（退货后少欠） */
export interface StatementSale {
  id: number
  timestamp: string
  type: 'out' | 'return'
  product_id: number
  product_name: string
  quantity: number
  due: number // 应付，单位：分
  paid: number // 已付，单位：分
  owed: number // 欠，单位：分
}

/** 客户对账单（customer:statement 返回） */
export interface CustomerStatement {
  customer: Customer
  sales: StatementSale[]
  payments: Payment[]
  total_credit: number
  total_paid_back: number
  outstanding: number
}

// ---------- 采购订单（v2.0） ----------

export type POStatus = 'draft' | 'sent' | 'partial' | 'complete' | 'cancelled'
export const PO_STATUSES: POStatus[] = ['draft', 'sent', 'partial', 'complete', 'cancelled']

/** 采购单状态中文名（数据库存英文枚举，界面只显示中文） */
export const PO_STATUS_LABELS: Record<POStatus, string> = {
  draft: '草稿',
  sent: '待收货',
  partial: '部分收货',
  complete: '已完成',
  cancelled: '已取消',
}

export interface PurchaseOrder {
  id: number
  po_no: string
  supplier_id: number | null
  status: POStatus
  expected_arrival: string | null
  total_cost: number | null
  created_at: string
  updated_at: string
  operator: string | null
  notes: string | null
}

export interface PurchaseOrderItem {
  id: number
  po_id: number
  product_id: number | null
  product_desc: string | null
  category: string | null
  quantity: number
  received_qty: number
  unit_cost: number
  created_at: string
}

/** 采购单列表行（po:list 返回）：在订单头基础上带供应商名与收货进度 */
export interface PurchaseOrderListItem extends PurchaseOrder {
  supplier_name: string | null
  item_count: number // 明细条数
  total_qty: number // 应收总数量
  received_qty: number // 已收总数量
}

/** 采购单明细行（po:detail 返回）：带商品名与 SKU，方便前端展示 */
export interface PurchaseOrderItemDetail extends PurchaseOrderItem {
  sku_code: string | null
  brand: string | null
  model: string | null
  product_name: string
}

/** 采购单详情（po:detail 返回） */
export interface PurchaseOrderDetail {
  order: PurchaseOrder & { supplier_name: string | null }
  items: PurchaseOrderItemDetail[]
}

// ---------- 多级定价（v2.0） ----------

export type PriceLevel = 'retail' | 'regular' | 'VIP' | 'wholesale' | 'promo'
export const PRICE_LEVELS: PriceLevel[] = ['retail', 'regular', 'VIP', 'wholesale', 'promo']

/** 价格档位中文名（数据库存英文枚举，界面只显示中文） */
export const PRICE_LEVEL_LABELS: Record<PriceLevel, string> = {
  retail: '零售',
  regular: '常客',
  VIP: '会员',
  wholesale: '批发',
  promo: '促销',
}

export interface PriceTier {
  id: number
  product_id: number
  tier: PriceLevel
  price: number
}

export interface Supplier {
  id: number
  name: string
  contact: string
  phone: string
  address: string
  notes: string
  created_at?: string
}

export type StockTakeStatus = '进行中' | '已完成' | '已审核'

export interface StockTake {
  id: number
  take_no: string
  status: StockTakeStatus
  location_filter: string | null
  category_filter?: Category | null // 赊账包新增：按品类盘点（与货位/供应商取交集）
  supplier_filter?: number | null // 赊账包新增：按供应商盘点
  started_at: string
  completed_at: string | null
  operator: string
}

export interface StockTakeItem {
  id: number
  stock_take_id: number
  product_id: number
  batch_id: number | null
  system_qty: number
  actual_qty: number | null
  difference: number | null
  reason: string
}
