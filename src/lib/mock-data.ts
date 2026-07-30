import type {
  AuditLogEntry,
  Customer,
  InventoryBatch,
  Payment,
  PriceTier,
  Product,
  PurchaseOrderItemDetail,
  PurchaseOrderListItem,
  StockTake,
  StockTakeItem,
  Supplier,
  Transaction,
} from '@/types'

// 近 7 天流水用运行当天为基准动态生成，保证仪表盘"今日入/出库"和 7 日趋势始终有数据
function daysAgo(n: number, hour = 10, minute = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}
function dateDaysAgo(n: number): string {
  return daysAgo(n).slice(0, 10)
}
// 相对今天 n 天后的日期串 YYYY-MM-DD（n 为负=已过期），给临期/过期 mock 商品用
function dateInDays(n: number): string {
  return dateDaysAgo(-n)
}

export const mockSuppliers: Supplier[] = [
  { id: 1, name: '威海光威渔具集团', contact: '王经理', phone: '0631-5628888', address: '山东省威海市环翠区渔具产业园', notes: '月结30天，主打台钓竿' },
  { id: 2, name: '广州钓之屋商贸', contact: '陈小姐', phone: '020-83456789', address: '广州市荔湾区芳村渔具批发市场A12', notes: '路亚饵/鱼钩走量大' },
  { id: 3, name: '宁波海伯渔具', contact: '李工', phone: '0574-87654321', address: '宁波市北仑区小港街道工业园区', notes: '渔轮一级代理' },
  { id: 4, name: '肃宁浮漂世家', contact: '赵老板', phone: '0317-5012345', address: '河北省沧州市肃宁县浮漂产业园', notes: '手工浮漂，起订量50支' },
]

export const mockProducts: Product[] = [
  { id: 1, sku_code: 'JC-FG-SG-GW-36', barcode: '6923456789012', category: '鱼竿', sub_category: '手竿', brand: '光威', model: '赤刃 3.6m 28调', cost_price: 4200, suggest_price: 8500, location: 'A区-东墙-第2层', photo_path: null, name_vi: null, rod_length: '3.6m', line_number: null, hook_size: null, color: null, material: '碳素', rod_action: '28调', power_rating: null, expiry_date: null, min_stock: null, status: '已盘点', created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 2, sku_code: 'JC-FG-SG-HS-45', barcode: '6923456789029', category: '鱼竿', sub_category: '手竿', brand: '化氏', model: '一味 4.5m 28调', cost_price: 6800, suggest_price: 12800, location: 'A区-东墙-第3层', photo_path: null, name_vi: null, rod_length: '4.5m', line_number: null, hook_size: null, color: null, material: '碳素', rod_action: '28调', power_rating: null, expiry_date: null, min_stock: null, status: '已盘点', created_at: daysAgo(28), updated_at: daysAgo(5) },
  { id: 3, sku_code: 'JC-FG-LY-DYW-21', barcode: '6923456789036', category: '鱼竿', sub_category: '路亚竿', brand: '达亿瓦', model: '一击 2.1m ML调 枪柄', cost_price: 15500, suggest_price: 26800, location: 'A区-西墙-第1层', photo_path: null, name_vi: null, rod_length: '2.1m', line_number: null, hook_size: null, color: null, material: null, rod_action: 'ML调', power_rating: 'ML', expiry_date: null, min_stock: null, status: '已上架虾皮', created_at: daysAgo(25), updated_at: daysAgo(3) },
  { id: 4, sku_code: 'JC-FG-HG-LW-30', barcode: '6923456789043', category: '鱼竿', sub_category: '海竿', brand: '狼王', model: '远投 3.0m', cost_price: 5500, suggest_price: 9900, location: 'B区-1号柜', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '待盘点', created_at: daysAgo(22), updated_at: daysAgo(8) },
  { id: 5, sku_code: 'JC-YL-FC-XMN-2500', barcode: '6923456789050', category: '渔轮', sub_category: '纺车轮', brand: '禧玛诺', model: '纳西 2500HG', cost_price: 32000, suggest_price: 49800, location: 'B区-3号柜', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '已上架虾皮', created_at: daysAgo(20), updated_at: daysAgo(1) },
  { id: 6, sku_code: 'JC-YL-SD-AB-001', barcode: '6923456789067', category: '渔轮', sub_category: '水滴轮', brand: '阿布加西亚', model: 'BMAX3 右握', cost_price: 21000, suggest_price: 33800, location: 'B区-3号柜', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '待盘点', created_at: daysAgo(18), updated_at: daysAgo(6) },
  { id: 7, sku_code: 'JC-XL-PE-YGK-1.5', barcode: '6923456789074', category: '鱼线', sub_category: 'PE线', brand: 'YGK', model: 'PE线 1.5号 200m', cost_price: 1800, suggest_price: 3500, location: 'C区-线材架-第1层', photo_path: null, name_vi: null, rod_length: null, line_number: '1.5号', hook_size: null, color: '五彩', material: 'PE', rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '已盘点', created_at: daysAgo(15), updated_at: daysAgo(2) },
  { id: 8, sku_code: 'JC-JL-MN-MB-009', barcode: '6923456789081', category: '路亚假饵', sub_category: '米诺', brand: 'Megabass', model: '米诺 9cm 金鳞', cost_price: 1200, suggest_price: 2800, location: 'C区-饵盒-A3', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '已上架虾皮', created_at: daysAgo(15), updated_at: daysAgo(4) },
  { id: 9, sku_code: 'JC-YG-YS-TFF-05', barcode: '6923456789098', category: '鱼钩', sub_category: '伊势尼', brand: '土肥富', model: '伊势尼 5号 10枚装', cost_price: 300, suggest_price: 800, location: 'C区-钩架-第2层', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: '5号', color: null, material: '高碳钢', rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '已盘点', created_at: daysAgo(14), updated_at: daysAgo(7) },
  { id: 10, sku_code: 'JC-FP-LP-AL-001', barcode: '6923456789104', category: '浮漂', sub_category: '立漂', brand: '阿卢', model: '巴尔杉木 LPA-01 3#', cost_price: 800, suggest_price: 1800, location: 'C区-漂盒-B1', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '待盘点', created_at: daysAgo(12), updated_at: daysAgo(3) },
  { id: 11, sku_code: 'JC-WL-CW-LQ-21', barcode: '6923456789111', category: '渔网', sub_category: '抄网', brand: '连球', model: '折叠抄网 2.1m', cost_price: 2500, suggest_price: 4800, location: 'B区-2号柜', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '已盘点', created_at: daysAgo(10), updated_at: daysAgo(9) },
  { id: 12, sku_code: 'JC-SP-YS-JDN-22', barcode: '6923456789128', category: '伞/遮阳', sub_category: '钓鱼伞', brand: '佳钓尼', model: '钓鱼伞 2.2m 万向', cost_price: 4500, suggest_price: 7900, location: 'D区-大件区', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: null, min_stock: null, status: '已售罄', created_at: daysAgo(40), updated_at: daysAgo(10) },
  // 临期/过期 mock：饵料 12 天后过期（琥珀预警）、小药已过期 5 天（红色预警），都有库存
  { id: 13, sku_code: 'JC-ER-SP-LG-918', barcode: '6923456789135', category: '饵料', sub_category: '商品饵', brand: '老鬼', model: '九一八 腥香 300g', cost_price: 900, suggest_price: 1800, location: 'C区-饵料架-第1层', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: dateInDays(12), min_stock: null, status: '已盘点', created_at: daysAgo(9), updated_at: daysAgo(1) },
  { id: 14, sku_code: 'JC-XY-XY-XBF-60', barcode: '6923456789142', category: '小药', sub_category: null, brand: '西部风', model: '牛B鲫 60ml', cost_price: 600, suggest_price: 1500, location: 'C区-饵料架-第2层', photo_path: null, name_vi: null, rod_length: null, line_number: null, hook_size: null, color: null, material: null, rod_action: null, power_rating: null, expiry_date: dateInDays(-5), min_stock: null, status: '已盘点', created_at: daysAgo(60), updated_at: daysAgo(2) },
]

// 总库存 = 各批次 quantity 之和；product 12 无批次即 0 库存（已售罄）
export const mockBatches: InventoryBatch[] = [
  { id: 1, product_id: 1, batch_no: 'PO20260710-001', quantity: 8, cost_price: 4200, location: 'A区-东墙-第2层', inbound_date: dateDaysAgo(18), supplier_id: 1 },
  { id: 2, product_id: 1, batch_no: 'PO20260720-002', quantity: 4, cost_price: 4500, location: 'A区-东墙-第2层', inbound_date: dateDaysAgo(8), supplier_id: 1 },
  { id: 3, product_id: 2, batch_no: 'PO20260712-001', quantity: 3, cost_price: 6800, location: 'A区-东墙-第3层', inbound_date: dateDaysAgo(16), supplier_id: 1 },
  { id: 4, product_id: 3, batch_no: 'PO20260714-001', quantity: 6, cost_price: 15500, location: 'A区-西墙-第1层', inbound_date: dateDaysAgo(14), supplier_id: 3 },
  { id: 5, product_id: 4, batch_no: 'PO20260708-001', quantity: 9, cost_price: 5500, location: 'B区-1号柜', inbound_date: dateDaysAgo(20), supplier_id: 1 },
  { id: 6, product_id: 5, batch_no: 'PO20260705-001', quantity: 2, cost_price: 32000, location: 'B区-3号柜', inbound_date: dateDaysAgo(23), supplier_id: 3 },
  { id: 7, product_id: 5, batch_no: 'PO20260718-003', quantity: 3, cost_price: 31800, location: 'B区-3号柜', inbound_date: dateDaysAgo(10), supplier_id: 3 },
  { id: 8, product_id: 6, batch_no: 'PO20260716-001', quantity: 4, cost_price: 21000, location: 'B区-3号柜', inbound_date: dateDaysAgo(12), supplier_id: 3 },
  { id: 9, product_id: 7, batch_no: 'PO20260711-004', quantity: 25, cost_price: 1800, location: 'C区-线材架-第1层', inbound_date: dateDaysAgo(17), supplier_id: 2 },
  { id: 10, product_id: 7, batch_no: 'PO20260722-001', quantity: 20, cost_price: 1750, location: 'C区-线材架-第1层', inbound_date: dateDaysAgo(6), supplier_id: 2 },
  { id: 11, product_id: 8, batch_no: 'PO20260713-002', quantity: 35, cost_price: 1200, location: 'C区-饵盒-A3', inbound_date: dateDaysAgo(15), supplier_id: 2 },
  { id: 12, product_id: 8, batch_no: 'PO20260724-005', quantity: 25, cost_price: 1150, location: 'C区-饵盒-A3', inbound_date: dateDaysAgo(4), supplier_id: 2 },
  { id: 13, product_id: 9, batch_no: 'PO20260709-003', quantity: 30, cost_price: 300, location: 'C区-钩架-第2层', inbound_date: dateDaysAgo(19), supplier_id: 2 },
  { id: 14, product_id: 9, batch_no: 'PO20260721-006', quantity: 17, cost_price: 320, location: 'C区-钩架-第2层', inbound_date: dateDaysAgo(7), supplier_id: 2 },
  { id: 15, product_id: 10, batch_no: 'PO20260715-001', quantity: 30, cost_price: 800, location: 'C区-漂盒-B1', inbound_date: dateDaysAgo(13), supplier_id: 4 },
  { id: 16, product_id: 11, batch_no: 'PO20260717-002', quantity: 2, cost_price: 2500, location: 'B区-2号柜', inbound_date: dateDaysAgo(11), supplier_id: 1 },
  { id: 17, product_id: 13, batch_no: 'PO20260723-001', quantity: 20, cost_price: 900, location: 'C区-饵料架-第1层', inbound_date: dateDaysAgo(5), supplier_id: 2 },
  { id: 18, product_id: 14, batch_no: 'PO20260530-001', quantity: 8, cost_price: 600, location: 'C区-饵料架-第2层', inbound_date: dateDaysAgo(59), supplier_id: 2 },
]

// 近 7 天出入库流水（含今天）+ 90 天前历史流水，供仪表盘趋势图与统计
// 口径与后端一致：out/return 的 unit_price=批次成本，selling_price=售价/退款
let tid = 1
const tx = (
  product_id: number,
  batch_id: number | null,
  type: Transaction['type'],
  quantity: number,
  unit_price: number | null,
  selling_price: number | null,
  daysBack: number,
  hour: number,
  operator: string,
  notes: string | null = null,
  // 赊账包：customer_id=记账客户；paid_amount=实收（null=全额付清）
  credit: { customerId: number; paidAmount: number | null } | null = null,
): Transaction => ({
  id: tid++,
  product_id,
  batch_id,
  type,
  quantity,
  unit_price,
  selling_price,
  timestamp: daysAgo(daysBack, hour),
  operator,
  notes,
  customer_id: credit?.customerId ?? null,
  paid_amount: credit ? credit.paidAmount : null,
})

export const mockTransactions: Transaction[] = [
  // 老王赊账买了 2 条赤刃：应付 ¥170，只付了 ¥100，欠 ¥70（之后微信还了 ¥50，见 mockPayments）
  tx(1, 1, 'out', 2, 4200, 8500, 6, 11, '阿杜', null, { customerId: 1, paidAmount: 10000 }),
  tx(7, 9, 'out', 5, 1800, 3500, 6, 15, '店员小李'),
  tx(9, 13, 'out', 10, 300, 800, 5, 10, '店员小李'),
  tx(11, 16, 'in', 2, 2500, null, 5, 14, '阿杜', '连球补货'),
  tx(5, 6, 'out', 1, 32000, 49800, 4, 16, '阿杜'),
  tx(8, 11, 'out', 8, 1200, 2800, 3, 9, '店员小李'),
  tx(12, null, 'return', 1, 4500, 7900, 3, 17, '阿杜', '客户退货：伞骨弯'),
  tx(1, 2, 'out', 1, 4500, 8500, 2, 14, '店员小李'),
  tx(7, 10, 'in', 20, 1750, null, 2, 10, '阿杜', 'YGK 补货'),
  tx(9, 14, 'out', 6, 320, 800, 1, 11, '店员小李'),
  tx(3, 4, 'out', 1, 15500, 26800, 1, 16, '阿杜'),
  tx(8, 12, 'out', 3, 1150, 2800, 0, 9, '店员小李'),
  tx(7, 10, 'out', 2, 1750, 3500, 0, 10, '店员小李'),
  tx(10, 15, 'in', 30, 800, null, 0, 11, '阿杜', '阿卢浮漂到货'),
  // ---- 90 天前的历史流水（与 electron/db.js 种子同源）：滞销统计和退货/换货类型覆盖 ----
  tx(2, 3, 'in', 3, 6800, null, 95, 10, '阿杜', '早期进货'),
  tx(1, 1, 'out', 3, 4200, 8500, 92, 15, '阿杜'),
  tx(7, 9, 'out', 10, 1800, 3500, 91, 11, '店员小李'),
  tx(9, 13, 'out', 20, 300, 800, 90, 16, '阿杜'),
  tx(5, 6, 'return', 1, 32000, 49800, 90, 14, '阿杜', '退货回补'),
  tx(8, 11, 'return', 2, 1200, null, 89, 10, '阿杜', '换货退旧'),
  tx(1, 1, 'out', 2, 4200, 8500, 89, 10, '阿杜', '换货出新'),
]

export const mockStockTakes: StockTake[] = [
  {
    id: 1,
    take_no: 'ST20260720-001',
    status: '已完成',
    location_filter: null,
    started_at: daysAgo(8, 10),
    completed_at: daysAgo(8, 17),
    operator: '阿杜',
  },
  {
    id: 2,
    take_no: 'ST20260728-001',
    status: '进行中',
    location_filter: 'A区',
    started_at: daysAgo(0, 10),
    completed_at: null,
    operator: '店员小李',
  },
]

export const mockStockTakeItems: StockTakeItem[] = [  { id: 1, stock_take_id: 1, product_id: 1, batch_id: 1, system_qty: 10, actual_qty: 10, difference: 0, reason: '' },
  { id: 2, stock_take_id: 1, product_id: 5, batch_id: 6, system_qty: 3, actual_qty: 2, difference: -1, reason: '样机损耗' },
  { id: 3, stock_take_id: 1, product_id: 9, batch_id: 13, system_qty: 38, actual_qty: 40, difference: 2, reason: '漏记入库' },
  // 进行中的盘点单（A区）：actual_qty 为空表示尚未点数
  { id: 4, stock_take_id: 2, product_id: 1, batch_id: 1, system_qty: 8, actual_qty: null, difference: null, reason: '' },
  { id: 5, stock_take_id: 2, product_id: 1, batch_id: 2, system_qty: 4, actual_qty: null, difference: null, reason: '' },
  { id: 6, stock_take_id: 2, product_id: 2, batch_id: 3, system_qty: 3, actual_qty: null, difference: null, reason: '' },
  { id: 7, stock_take_id: 2, product_id: 3, batch_id: 4, system_qty: 6, actual_qty: null, difference: null, reason: '' },
]

// ---------- 赊账包 mock：客户与还款 ----------
// 老王（id=1）有一笔赊账流水（见 mockTransactions 第一条）：欠 ¥70，微信还了 ¥50，还欠 ¥20
export const mockCustomers: Customer[] = [
  { id: 1, name: '老王', phone: '13812345678', notes: '老钓友，常赊账，月底结', price_level: 'regular', created_at: daysAgo(20) },
  { id: 2, name: '小刘', phone: '13987654321', notes: null, price_level: null, created_at: daysAgo(12) },
  // 张老板是批发客户：出库选他自动按批发价出
  { id: 3, name: '码头张老板', phone: null, notes: '包船出海的，拿货量大', price_level: 'wholesale', created_at: daysAgo(9) },
]

export const mockPayments: Payment[] = [
  { id: 1, customer_id: 1, amount: 5000, method: '微信', notes: null, created_at: daysAgo(2, 15) },
]

// ---------- 采购订单 + 多级定价 mock（浏览器 dev 用；生产环境一律以后端 po:* / priceTier:* 为准） ----------

function poNoDaysAgo(n: number, seq: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `PO${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${String(seq).padStart(3, '0')}`
}

// 两张示例单：一张待收货（整单没收）、一张部分收货（已收一部分）
export const mockPurchaseOrders: PurchaseOrderListItem[] = [
  {
    id: 1,
    po_no: poNoDaysAgo(1, 1),
    supplier_id: 2,
    status: 'sent',
    expected_arrival: null,
    total_cost: 50 * 1150 + 100 * 320,
    created_at: daysAgo(1, 9),
    updated_at: daysAgo(1, 9),
    operator: '阿杜',
    notes: '米诺和鱼钩补货',
    supplier_name: '广州钓之屋商贸',
    item_count: 2,
    total_qty: 150,
    received_qty: 0,
  },
  {
    id: 2,
    po_no: poNoDaysAgo(4, 1),
    supplier_id: 1,
    status: 'partial',
    expected_arrival: null,
    total_cost: 10 * 4200 + 5 * 2500,
    created_at: daysAgo(4, 10),
    updated_at: daysAgo(2, 15),
    operator: '阿杜',
    notes: null,
    supplier_name: '威海光威渔具集团',
    item_count: 2,
    total_qty: 15,
    received_qty: 9,
  },
]

export const mockPurchaseOrderItems: PurchaseOrderItemDetail[] = [
  { id: 1, po_id: 1, product_id: 8, product_desc: null, category: '路亚假饵', quantity: 50, received_qty: 0, unit_cost: 1150, created_at: daysAgo(1, 9), sku_code: 'JC-JL-MN-MB-009', brand: 'Megabass', model: '米诺 9cm 金鳞', product_name: 'Megabass 米诺 9cm 金鳞' },
  { id: 2, po_id: 1, product_id: 9, product_desc: null, category: '鱼钩', quantity: 100, received_qty: 0, unit_cost: 320, created_at: daysAgo(1, 9), sku_code: 'JC-YG-YS-TFF-05', brand: '土肥富', model: '伊势尼 5号 10枚装', product_name: '土肥富 伊势尼 5号 10枚装' },
  { id: 3, po_id: 2, product_id: 1, product_desc: null, category: '鱼竿', quantity: 10, received_qty: 4, unit_cost: 4200, created_at: daysAgo(4, 10), sku_code: 'JC-FG-SG-GW-36', brand: '光威', model: '赤刃 3.6m 28调', product_name: '光威 赤刃 3.6m 28调' },
  { id: 4, po_id: 2, product_id: 11, product_desc: null, category: '渔网', quantity: 5, received_qty: 5, unit_cost: 2500, created_at: daysAgo(4, 10), sku_code: 'JC-WL-CW-LQ-21', brand: '连球', model: '折叠抄网 2.1m', product_name: '连球 折叠抄网 2.1m' },
]

// 给两个商品设几档示例价：出库确认时能看到价格档大按钮
export const mockPriceTiers: PriceTier[] = [
  { id: 1, product_id: 1, tier: 'retail', price: 8500 },
  { id: 2, product_id: 1, tier: 'regular', price: 8000 },
  { id: 3, product_id: 1, tier: 'wholesale', price: 7200 },
  { id: 4, product_id: 7, tier: 'retail', price: 3500 },
  { id: 5, product_id: 7, tier: 'promo', price: 2990 },
]

// ---------- 操作日志 mock（浏览器 dev 用；生产环境一律以后端 audit_log 表 / audit:list 为准） ----------
// 时间倒序；mock 路径下入库/出库/还账还会由 appStore 顺手往这里追加新记录
export const mockAuditLogs: AuditLogEntry[] = [
  { id: 8, action: '出库', entity: '光威 赤刃 3.6m 28调 x2', detail: JSON.stringify({ quantity: 2, sellingPrice: 8500, totalDue: 17000, paidAmount: null, creditAmount: 0 }), operator: '阿杜', created_at: daysAgo(0, 15) },
  { id: 7, action: '还账', entity: '老王 还 50.00 元', detail: JSON.stringify({ amount: 5000, method: '微信', before: 7000, outstanding: 2000 }), operator: '阿杜', created_at: daysAgo(2, 15) },
  { id: 6, action: '入库', entity: '阿卢 巴尔杉木 LPA-01 3# x30', detail: JSON.stringify({ quantity: 30, costPrice: 800 }), operator: '阿杜', created_at: daysAgo(0, 11) },
  { id: 5, action: '改价', entity: '禧玛诺 纳西 2500HG', detail: JSON.stringify({ tier: 'wholesale', price: 46000 }), operator: '阿杜', created_at: daysAgo(2, 16) },
  { id: 4, action: '退货', entity: '佳钓尼 钓鱼伞 2.2m 万向 x1', detail: JSON.stringify({ quantity: 1, refundPrice: 7900 }), operator: '阿杜', created_at: daysAgo(3, 17) },
  { id: 3, action: '新建商品', entity: '老鬼 九一八 腥香 300g', detail: JSON.stringify({ sku: 'JC-ER-SP-LG-918', cost_price: 900 }), operator: '阿杜', created_at: daysAgo(9, 9) },
  { id: 2, action: '盘点', entity: 'ST20260720-001', detail: JSON.stringify({ counted: 3 }), operator: '阿杜', created_at: daysAgo(8, 17) },
  { id: 1, action: '新建客户', entity: '老王', detail: JSON.stringify({ phone: '13812345678', price_level: 'regular' }), operator: null, created_at: daysAgo(20, 10) },
]
