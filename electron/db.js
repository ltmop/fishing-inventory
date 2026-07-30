// 数据层：SQLite 初始化（WAL 模式）+ 建表 + 首次启动种子数据
// 使用 Electron 内置 Node 的 node:sqlite，零原生依赖，免编译
// 说明：架构文档原定 better-sqlite3，因开发机无 VS Build Tools 且其无 Electron 预编译产物，
//       改用 node:sqlite（API 同为同步风格，SQL schema 一字未动）
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku_code TEXT UNIQUE NOT NULL,
    barcode TEXT,
    category TEXT NOT NULL CHECK (category IN ('鱼竿','鱼线','鱼钩','渔轮','浮漂','铅坠','饵料','路亚假饵','渔网','钓箱钓椅','伞/遮阳','支架','服装穿戴','灯具','工具配件','收纳包具','增氧保鲜','活饵','小药','其他')),
    sub_category TEXT,
    brand TEXT,
    model TEXT,
    cost_price INTEGER NOT NULL,
    suggest_price INTEGER,
    location TEXT,
    photo_path TEXT,
    name_vi TEXT,
    status TEXT DEFAULT '待盘点' CHECK (status IN ('待盘点','已盘点','已上架虾皮','已售罄','停产')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact TEXT,
    phone TEXT,
    address TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    supplier_id INTEGER REFERENCES suppliers(id),
    batch_no TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    cost_price INTEGER NOT NULL,
    location TEXT,
    inbound_date DATE NOT NULL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 赊账包：客户档案（余额模型——"老王一共欠我多少钱"，不绑定单张订单）
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    -- 客户绑定价格档（可空，NULL=零售默认；老库由 migrateCustomerPriceLevel 补）
    price_level TEXT,
    created_at TEXT NOT NULL
);

-- 赊账包：还款记录（登记到客户头上；amount 单位：分）
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL DEFAULT '现金' CHECK (method IN ('现金','微信','支付宝','其他')),
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    batch_id INTEGER REFERENCES inventory_batches(id),
    type TEXT NOT NULL CHECK (type IN ('in', 'out', 'return', 'exchange')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER,
    selling_price INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    operator TEXT,
    notes TEXT,
    -- 赊账包两列（老库由 migrateCreditPack 补）：customer_id 可空（散客），
    -- paid_amount=实收金额（分），NULL 视为已全额付清（老数据不动即为此语义）
    customer_id INTEGER REFERENCES customers(id),
    paid_amount INTEGER
);

CREATE TABLE IF NOT EXISTS stock_takes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    take_no TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT '进行中' CHECK (status IN ('进行中','已完成','已审核')),
    location_filter TEXT,
    -- 赊账包新增两列（老库由 migrateCreditPack 补）：按品类/供应商盘点
    category_filter TEXT,
    supplier_filter INTEGER,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    operator TEXT
);

CREATE TABLE IF NOT EXISTS stock_take_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_take_id INTEGER NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    batch_id INTEGER REFERENCES inventory_batches(id),
    system_qty INTEGER NOT NULL,
    actual_qty INTEGER,
    difference INTEGER GENERATED ALWAYS AS (actual_qty - system_qty) STORED,
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_batches_product ON inventory_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_batch_no ON inventory_batches(batch_no);
CREATE INDEX IF NOT EXISTS idx_batches_supplier ON inventory_batches(supplier_id);
CREATE INDEX IF NOT EXISTS idx_transactions_product ON transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_transactions_batch ON transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_stock_take_items_take ON stock_take_items(stock_take_id);

-- 采购订单（v2.0）
CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_no TEXT UNIQUE NOT NULL,
    supplier_id INTEGER REFERENCES suppliers(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','partial','complete','cancelled')),
    expected_arrival DATE,
    total_cost INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    operator TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    product_desc TEXT,
    category TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    received_qty INTEGER NOT NULL DEFAULT 0,
    unit_cost INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 多级定价（v2.0）：零售/普通/VIP/批发/促销
CREATE TABLE IF NOT EXISTS price_tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    tier TEXT NOT NULL CHECK (tier IN ('retail','regular','VIP','wholesale','promo')),
    price INTEGER NOT NULL,
    UNIQUE(product_id, tier)
);

CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_price_tiers_product ON price_tiers(product_id);

-- AI 记忆：对话历史（只存 user/assistant）与自主沉淀的经营知识
CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`

/**
 * 打开（必要时创建）数据库，执行 schema，空库时写入种子数据
 * @param {string} dbPath 数据库文件绝对路径
 * @returns {DatabaseSync}
 */
export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  // 迁移安全网：老库做原地重建表前先把库文件拷贝留底（已存在不覆盖），
  // 迁移一旦失败可从 .pre-migration.bak 手动回退；拷贝失败只告警不阻断启动
  const bakPath = dbPath + '.pre-migration.bak'
  if (fs.existsSync(dbPath) && !fs.existsSync(bakPath)) {
    try {
      fs.copyFileSync(dbPath, bakPath)
    } catch (e) {
      console.error('[db] 迁移前留底备份失败:', e)
    }
  }
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA_SQL)
  migrateOldProductsTable(db)
  migrateCreditPack(db)
  migrateFishingAttrs(db)
  migrateCustomerPriceLevel(db)
  const row = db.prepare('SELECT COUNT(*) AS n FROM products').get()
  if (row.n === 0) seedDatabase(db)
  return db
}

// ---------- 旧库迁移：10 大类 schema（无 sub_category）→ 20 大类 + sub_category ----------
// 老用户的 data.db 是旧 10 类结构，直接启动会被新 CHECK 约束卡死，这里做原地重建表迁移。
// 品类映射：台钓竿/路亚竿/海竿 → 鱼竿（原名降级为 sub_category）、路亚饵 → 路亚假饵、
//           配件 → 工具配件，其余（渔轮/鱼线/鱼钩/浮漂/其他）同名保留；老 SKU（JD-*）不动。
const OLD_CATEGORY_MAP = `
  CASE category
    WHEN '台钓竿' THEN '鱼竿'
    WHEN '路亚竿' THEN '鱼竿'
    WHEN '海竿'   THEN '鱼竿'
    WHEN '路亚饵' THEN '路亚假饵'
    WHEN '配件'   THEN '工具配件'
    ELSE category
  END`

function migrateOldProductsTable(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'products'")
    .get()
  // 新库（无表）或已是新 schema（含 sub_category）都无需迁移
  if (!row || row.sql.includes('sub_category')) return

  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE products_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sku_code TEXT UNIQUE NOT NULL,
          barcode TEXT,
          category TEXT NOT NULL CHECK (category IN ('鱼竿','鱼线','鱼钩','渔轮','浮漂','铅坠','饵料','路亚假饵','渔网','钓箱钓椅','伞/遮阳','支架','服装穿戴','灯具','工具配件','收纳包具','增氧保鲜','活饵','小药','其他')),
          sub_category TEXT,
          brand TEXT,
          model TEXT,
          cost_price INTEGER NOT NULL,
          suggest_price INTEGER,
          location TEXT,
          photo_path TEXT,
          name_vi TEXT,
          status TEXT DEFAULT '待盘点' CHECK (status IN ('待盘点','已盘点','已上架虾皮','已售罄','停产')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO products_new
        (id, sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, photo_path, name_vi, status, created_at, updated_at)
      SELECT
        id, sku_code, barcode,
        ${OLD_CATEGORY_MAP},
        CASE WHEN category IN ('台钓竿','路亚竿','海竿') THEN category ELSE NULL END,
        brand, model, cost_price, suggest_price, location, photo_path, name_vi, status, created_at, updated_at
      FROM products;
      DROP TABLE products;
      ALTER TABLE products_new RENAME TO products;
    `)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    db.exec('PRAGMA foreign_keys = ON')
    throw e
  }
  db.exec('PRAGMA foreign_keys = ON')
  // DROP TABLE 会连带删掉 products 上的索引（SCHEMA_SQL 里的 IF NOT EXISTS 已先于迁移执行），需重建
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
  `)
}

// ---------- 渔具专用属性迁移（v2.0）：只增不改，老数据新列为 NULL ----------
function migrateFishingAttrs(db) {
  const addCol = (col, ddl) => {
    const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name)
    if (!cols.includes(col)) db.exec(`ALTER TABLE products ADD COLUMN ${ddl}`)
  }
  addCol('rod_length', 'rod_length TEXT')
  addCol('line_number', 'line_number TEXT')
  addCol('hook_size', 'hook_size TEXT')
  addCol('color', 'color TEXT')
  addCol('material', 'material TEXT')
  addCol('rod_action', 'rod_action TEXT')
  addCol('power_rating', 'power_rating TEXT')
  addCol('expiry_date', 'expiry_date TEXT')
}

// ---------- 赊账包迁移：老库补列（只增不改；新库 SCHEMA_SQL 已含这些列，ALTER 自动跳过） ----------
// 注意：两张新表（customers/payments）由 SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 建好，无需迁移；
// 这里只负责给老库的 transactions / stock_takes 补新列。
function migrateCreditPack(db) {
  const addColumn = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  addColumn('transactions', 'customer_id', 'customer_id INTEGER REFERENCES customers(id)')
  addColumn('transactions', 'paid_amount', 'paid_amount INTEGER')
  addColumn('stock_takes', 'category_filter', 'category_filter TEXT')
  addColumn('stock_takes', 'supplier_filter', 'supplier_filter INTEGER')
  // 索引放在迁移之后建：老库的 transactions 要等到 ALTER 之后才有 customer_id 列，
  // 若写进 SCHEMA_SQL 会在老库上报 "no such column" 导致启动失败
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
    CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
  `)
}

// ---------- 客户价格档迁移：老库 customers 补 price_level（只增不改；NULL=零售默认） ----------
function migrateCustomerPriceLevel(db) {
  const addCol = (table, column, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
  addCol('customers', 'price_level', 'price_level TEXT')
}

/** 软件正常退出时调用一次：收尾 checkpoint，截断 WAL */
export function finalCheckpoint(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    // 退出阶段失败不影响数据安全（WAL 下次启动自动恢复）
  }
}

// ---------- AI 记忆沉淀：对话历史 + 知识库（纯数据层，与 Electron 解耦，可单测） ----------

/** 落一条对话消息（只存 user/assistant，tool 中间步骤不存） */
export function saveAiMessage(db, role, content) {
  if (role !== 'user' && role !== 'assistant') return
  db.prepare('INSERT INTO ai_messages (role, content, created_at) VALUES (?, ?, ?)').run(
    role,
    String(content ?? ''),
    new Date().toISOString(),
  )
}

/** 最近 N 条对话，按时间正序返回（前端启动恢复用） */
export function listAiMessages(db, limit = 50) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  const rows = db.prepare('SELECT role, content FROM ai_messages ORDER BY id DESC LIMIT ?').all(n)
  return rows.reverse()
}

const INSIGHT_KINDS = new Set(['fact', 'preference', 'suggestion'])

/** AI 自主沉淀一条知识；kind 不在白名单里按 fact 存 */
export function saveInsight(db, kind, content) {
  const text = String(content ?? '').trim()
  if (!text) return { saved: false, reason: '内容为空' }
  const k = INSIGHT_KINDS.has(kind) ? kind : 'fact'
  db.prepare('INSERT INTO ai_insights (kind, content, created_at) VALUES (?, ?, ?)').run(
    k,
    text,
    new Date().toISOString(),
  )
  return { saved: true, kind: k }
}

/** 知识列表查询（ai:insights 通道备用） */
export function listInsights(db, { limit = 50, activeOnly = false } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)
  const rows = activeOnly
    ? db.prepare('SELECT id, kind, content, created_at, active FROM ai_insights WHERE active = 1 ORDER BY id DESC LIMIT ?').all(n)
    : db.prepare('SELECT id, kind, content, created_at, active FROM ai_insights ORDER BY id DESC LIMIT ?').all(n)
  return rows
}

const KIND_LABEL = { fact: '事实', preference: '偏好', suggestion: '建议' }
// 注入系统提示的记忆片段总长上限（与 ai.js 单条消息 4000 字截断同思路）
const MAX_MEMORY_CHARS = 1500

/**
 * 组装注入系统提示词的记忆片段：active=1 的最近 N 条，超出长度上限的截掉。
 * 无记忆时返回空串，调用方拼提示词时跳过。
 */
export function buildInsightsContext(db, limit = 20) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)
  const rows = db
    .prepare('SELECT kind, content FROM ai_insights WHERE active = 1 ORDER BY id DESC LIMIT ?')
    .all(n)
  if (rows.length === 0) return ''
  let out = '你之前记住的店里的事（回答时可以参考）：'
  for (const r of rows.reverse()) {
    const line = `\n- [${KIND_LABEL[r.kind] ?? '事实'}] ${r.content}`
    if (out.length + line.length > MAX_MEMORY_CHARS) break
    out += line
  }
  return out
}

// ---------- 种子数据（与前端 mock-data.ts 同源，空库首次启动写入） ----------

function daysAgo(n, hour = 10, minute = 0) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}
const dateDaysAgo = (n) => daysAgo(n).slice(0, 10)

function seedDatabase(db) {
  const suppliers = [
    ['威海光威渔具集团', '王经理', '0631-5628888', '山东省威海市环翠区渔具产业园', '月结30天，主打台钓竿'],
    ['广州钓之屋商贸', '陈小姐', '020-83456789', '广州市荔湾区芳村渔具批发市场A12', '路亚饵/鱼钩走量大'],
    ['宁波海伯渔具', '李工', '0574-87654321', '宁波市北仑区小港街道工业园区', '渔轮一级代理'],
    ['肃宁浮漂世家', '赵老板', '0317-5012345', '河北省沧州市肃宁县浮漂产业园', '手工浮漂，起订量50支'],
  ]
  // [sku, barcode, category, sub_category, brand, model, cost, suggest, location, status, createdDaysAgo, updatedDaysAgo]
  const products = [
    ['JC-FG-SG-GW-36', '6923456789012', '鱼竿', '手竿', '光威', '赤刃 3.6m 28调', 4200, 8500, 'A区-东墙-第2层', '已盘点', 30, 2],
    ['JC-FG-SG-HS-45', '6923456789029', '鱼竿', '手竿', '化氏', '一味 4.5m 28调', 6800, 12800, 'A区-东墙-第3层', '已盘点', 28, 5],
    ['JC-FG-LY-DYW-21', '6923456789036', '鱼竿', '路亚竿', '达亿瓦', '一击 2.1m ML调 枪柄', 15500, 26800, 'A区-西墙-第1层', '已上架虾皮', 25, 3],
    ['JC-FG-HG-LW-30', '6923456789043', '鱼竿', '海竿', '狼王', '远投 3.0m', 5500, 9900, 'B区-1号柜', '待盘点', 22, 8],
    ['JC-YL-FC-XMN-2500', '6923456789050', '渔轮', '纺车轮', '禧玛诺', '纳西 2500HG', 32000, 49800, 'B区-3号柜', '已上架虾皮', 20, 1],
    ['JC-YL-SD-AB-001', '6923456789067', '渔轮', '水滴轮', '阿布加西亚', 'BMAX3 右握', 21000, 33800, 'B区-3号柜', '待盘点', 18, 6],
    ['JC-XL-PE-YGK-1.5', '6923456789074', '鱼线', 'PE线', 'YGK', 'PE线 1.5号 200m', 1800, 3500, 'C区-线材架-第1层', '已盘点', 15, 2],
    ['JC-JL-MN-MB-009', '6923456789081', '路亚假饵', '米诺', 'Megabass', '米诺 9cm 金鳞', 1200, 2800, 'C区-饵盒-A3', '已上架虾皮', 15, 4],
    ['JC-YG-YS-TFF-05', '6923456789098', '鱼钩', '伊势尼', '土肥富', '伊势尼 5号 10枚装', 300, 800, 'C区-钩架-第2层', '已盘点', 14, 7],
    ['JC-FP-LP-AL-001', '6923456789104', '浮漂', '立漂', '阿卢', '巴尔杉木 LPA-01 3#', 800, 1800, 'C区-漂盒-B1', '待盘点', 12, 3],
    ['JC-WL-CW-LQ-21', '6923456789111', '渔网', '抄网', '连球', '折叠抄网 2.1m', 2500, 4800, 'B区-2号柜', '已盘点', 10, 9],
    ['JC-SP-YS-JDN-22', '6923456789128', '伞/遮阳', '钓鱼伞', '佳钓尼', '钓鱼伞 2.2m 万向', 4500, 7900, 'D区-大件区', '已售罄', 40, 10],
  ]
  // [product_id, batch_no, qty, cost, location, inboundDaysAgo, supplier_id]
  const batches = [
    [1, 'PO20260710-001', 8, 4200, 'A区-东墙-第2层', 18, 1],
    [1, 'PO20260720-002', 4, 4500, 'A区-东墙-第2层', 8, 1],
    [2, 'PO20260712-001', 3, 6800, 'A区-东墙-第3层', 16, 1],
    [3, 'PO20260714-001', 6, 15500, 'A区-西墙-第1层', 14, 3],
    [4, 'PO20260708-001', 9, 5500, 'B区-1号柜', 20, 1],
    [5, 'PO20260705-001', 2, 32000, 'B区-3号柜', 23, 3],
    [5, 'PO20260718-003', 3, 31800, 'B区-3号柜', 10, 3],
    [6, 'PO20260716-001', 4, 21000, 'B区-3号柜', 12, 3],
    [7, 'PO20260711-004', 25, 1800, 'C区-线材架-第1层', 17, 2],
    [7, 'PO20260722-001', 20, 1750, 'C区-线材架-第1层', 6, 2],
    [8, 'PO20260713-002', 35, 1200, 'C区-饵盒-A3', 15, 2],
    [8, 'PO20260724-005', 25, 1150, 'C区-饵盒-A3', 4, 2],
    [9, 'PO20260709-003', 30, 300, 'C区-钩架-第2层', 19, 2],
    [9, 'PO20260721-006', 17, 320, 'C区-钩架-第2层', 7, 2],
    [10, 'PO20260715-001', 30, 800, 'C区-漂盒-B1', 13, 4],
    [11, 'PO20260717-002', 2, 2500, 'B区-2号柜', 11, 1],
  ]
  // 出库流水 unit_price=批次成本价、selling_price=实际售价（最终 schema 约定）
  // [product_id, batch_id, type, qty, unit_price, selling_price, daysBack, hour, operator, notes]
  const txs = [
    [1, 1, 'out', 2, 4200, 8500, 6, 11, '阿杜', null],
    [7, 9, 'out', 5, 1800, 3500, 6, 15, '店员小李', null],
    [9, 13, 'out', 10, 300, 800, 5, 10, '店员小李', null],
    [11, 16, 'in', 2, 2500, null, 5, 14, '阿杜', '连球补货'],
    [5, 6, 'out', 1, 32000, 49800, 4, 16, '阿杜', null],
    [8, 11, 'out', 8, 1200, 2800, 3, 9, '店员小李', null],
    [12, null, 'return', 1, 7900, null, 3, 17, '阿杜', '客户退货：伞骨弯'],
    [1, 2, 'out', 1, 4500, 8500, 2, 14, '店员小李', null],
    [7, 10, 'in', 20, 1750, null, 2, 10, '阿杜', 'YGK 补货'],
    [9, 14, 'out', 6, 320, 800, 1, 11, '店员小李', null],
    [3, 4, 'out', 1, 15500, 26800, 1, 16, '阿杜', null],
    [8, 12, 'out', 3, 1150, 2800, 0, 9, '店员小李', null],
    [7, 10, 'out', 2, 1750, 3500, 0, 10, '店员小李', null],
    [10, 15, 'in', 30, 800, null, 0, 11, '阿杜', '阿卢浮漂到货'],
    // ---- 90 天前的历史流水（让滞销统计、长期趋势和退货/换货报表都有据可依） ----
    [2, 3, 'in', 3, 6800, null, 95, 10, '阿杜', '早期进货'],
    [1, 1, 'out', 3, 4200, 8500, 92, 15, '阿杜', null],
    [7, 9, 'out', 10, 1800, 3500, 91, 11, '店员小李', null],
    [9, 13, 'out', 20, 300, 800, 90, 16, '阿杜', null],
    [5, 6, 'return', 1, 32000, 49800, 90, 14, '阿杜', '退货回补'],
    [8, 11, 'return', 2, 1200, null, 89, 10, '阿杜', '换货退旧'],
    [1, 1, 'out', 2, 4200, 8500, 89, 10, '阿杜', '换货出新'],
  ]
  const stockTakes = [
    // [take_no, status, location_filter, startedDaysAgo, startedHour, completedDaysAgo, completedHour, operator]
    ['ST20260720-001', '已完成', null, 8, 10, 8, 17, '阿杜'],
    ['ST20260728-001', '进行中', 'A区', 0, 10, null, null, '店员小李'],
  ]
  // [stock_take_id, product_id, batch_id, system_qty, actual_qty, reason]
  const stockTakeItems = [
    [1, 1, 1, 10, 10, ''],
    [1, 5, 6, 3, 2, '样机损耗'],
    [1, 9, 13, 38, 40, '漏记入库'],
    [2, 1, 1, 8, null, ''],
    [2, 1, 2, 4, null, ''],
    [2, 2, 3, 3, null, ''],
    [2, 3, 4, 6, null, ''],
  ]

  db.exec('BEGIN')
  try {
    const insSupplier = db.prepare(
      'INSERT INTO suppliers (name, contact, phone, address, notes) VALUES (?, ?, ?, ?, ?)',
    )
    for (const s of suppliers) insSupplier.run(...s)

    const insProduct = db.prepare(
      `INSERT INTO products (sku_code, barcode, category, sub_category, brand, model, cost_price, suggest_price, location, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const p of products)
      insProduct.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], daysAgo(p[10]), daysAgo(p[11]))

    const insBatch = db.prepare(
      `INSERT INTO inventory_batches (product_id, batch_no, quantity, cost_price, location, inbound_date, supplier_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const b of batches) insBatch.run(b[0], b[1], b[2], b[3], b[4], dateDaysAgo(b[5]), b[6])

    const insTx = db.prepare(
      `INSERT INTO transactions (product_id, batch_id, type, quantity, unit_price, selling_price, timestamp, operator, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const t of txs)
      insTx.run(t[0], t[1], t[2], t[3], t[4], t[5], daysAgo(t[6], t[7]), t[8], t[9])

    const insTake = db.prepare(
      `INSERT INTO stock_takes (take_no, status, location_filter, started_at, completed_at, operator)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const st of stockTakes)
      insTake.run(
        st[0], st[1], st[2],
        daysAgo(st[3], st[4]),
        st[5] === null ? null : daysAgo(st[5], st[6]),
        st[7],
      )

    const insItem = db.prepare(
      `INSERT INTO stock_take_items (stock_take_id, product_id, batch_id, system_qty, actual_qty, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const it of stockTakeItems) insItem.run(...it)

    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
