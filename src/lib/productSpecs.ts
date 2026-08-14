// 渔具规格字段：品类 → 该显示的字段列表 + 中文标签 + 一行格式化
// 纯函数，不依赖 store / UI，InboundPage / InventoryPage / 导入导出共用
import type { Category } from '@/types'

export type SpecField =
  | 'rod_length'   // 鱼竿长度，如 3.6m
  | 'rod_action'   // 调性，如 28调
  | 'power_rating' // 硬度，如 H / ML
  | 'line_number'  // 线号，如 1.5号
  | 'hook_size'    // 钩号，如 伊势尼5号
  | 'color'        // 颜色
  | 'material'     // 材质
  | 'expiry_date'  // 保质期（鱼饵用），如 2027-06

export const SPEC_FIELDS: SpecField[] = [
  'rod_length', 'rod_action', 'power_rating', 'line_number',
  'hook_size', 'color', 'material', 'expiry_date',
]

export const SPEC_LABELS: Record<SpecField, string> = {
  rod_length: '长度',
  rod_action: '调性',
  power_rating: '硬度',
  line_number: '线号',
  hook_size: '钩号',
  color: '颜色',
  material: '材质',
  expiry_date: '保质期',
}

// 输入占位提示：老板手输，给个例子就知道填什么格式
export const SPEC_PLACEHOLDERS: Record<SpecField, string> = {
  rod_length: '如：3.6m',
  rod_action: '如：28调',
  power_rating: '如：H / ML',
  line_number: '如：1.5号',
  hook_size: '如：伊势尼5号',
  color: '如：黑 / 腥香',
  material: '如：碳素 / 高碳钢',
  expiry_date: '如：2027-06',
}

// 保质期必填的品类（v2.2）：饵料/小药/活饵/路亚假饵入库必须填该批次的到期日，
// 否则批次保质期管理白搭。与 specFieldsFor 返回 expiry_date 的那组保持一致。
export const EXPIRY_REQUIRED_CATEGORIES: Category[] = ['饵料', '小药', '活饵', '路亚假饵']

/** 该品类是否入库必填到期日（饵料/小药/活饵/路亚假饵） */
export function requiresExpiry(category: Category | string | null | undefined): boolean {
  return category != null && (EXPIRY_REQUIRED_CATEGORIES as string[]).includes(category)
}

/** 品类 → 表单该显示的规格字段（全部选填）；未列出的品类只给通用的颜色/材质 */
export function specFieldsFor(category: Category | string): SpecField[] {
  switch (category) {
    case '鱼竿':
      return ['rod_length', 'rod_action', 'power_rating']
    case '鱼钩':
      return ['hook_size', 'material', 'color']
    case '鱼线':
      return ['line_number', 'material', 'color']
    case '饵料':
    case '活饵':
    case '小药':
    case '路亚假饵':
      return ['expiry_date', 'color']
    default:
      return ['color', 'material']
  }
}

/** 把商品的非空规格拼成一行展示，如「3.6m · 28调 · 碳素」；全空返回空串 */
export function formatSpecs(
  p: Partial<Record<SpecField, string | null>>,
): string {
  return SPEC_FIELDS.map((f) => p[f]?.trim())
    .filter((v): v is string => !!v)
    .join(' · ')
}

/** 从表单字符串状态收集规格字段：空串归 null，直接可传给 addProduct/updateProduct */
export function collectSpecs(
  form: Record<SpecField, string>,
): Record<SpecField, string | null> {
  const out = {} as Record<SpecField, string | null>
  for (const f of SPEC_FIELDS) {
    const v = form[f]?.trim()
    out[f] = v ? v : null
  }
  return out
}

/** 从商品读出规格字段的表单字符串状态（null → ''），编辑弹窗初始化用 */
export function specsToForm(
  p: Partial<Record<SpecField, string | null>>,
): Record<SpecField, string> {
  const out = {} as Record<SpecField, string>
  for (const f of SPEC_FIELDS) out[f] = p[f] ?? ''
  return out
}
