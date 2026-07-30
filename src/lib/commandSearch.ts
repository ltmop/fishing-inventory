// Ctrl+K 命令面板的匹配逻辑（纯函数，方便单测）。
// 面向不懂电脑的店主：只做简单的包含匹配，按字段精度排序，不搞模糊算法。

import type { Product } from '@/types'

export interface ProductMatch {
  product: Product
  /** 命中的字段，面板里用作小字提示 */
  matchedField: 'sku' | 'barcode' | 'brand' | 'model' | 'category'
}

// 字段优先级：SKU/条码最精确（扫码场景），其次品牌、型号、品类
const FIELD_GETTERS: Array<[ProductMatch['matchedField'], (p: Product) => string | null]> = [
  ['sku', (p) => p.sku_code],
  ['barcode', (p) => p.barcode],
  ['brand', (p) => p.brand],
  ['model', (p) => p.model],
  ['category', (p) => p.category],
]

/**
 * 在商品列表里按关键词匹配 SKU/条码/品牌/型号/品类（大小写不敏感的包含匹配）。
 * 排序规则：字段优先级高的在前；同字段内，前缀命中的排在中间包含命中的前面。
 */
export function searchProducts(products: Product[], query: string, limit = 8): ProductMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const scored: Array<{ match: ProductMatch; rank: number }> = []
  for (const p of products) {
    for (let fi = 0; fi < FIELD_GETTERS.length; fi++) {
      const [field, get] = FIELD_GETTERS[fi]
      const value = get(p)
      if (value && value.toLowerCase().includes(q)) {
        const prefixBonus = value.toLowerCase().startsWith(q) ? 0 : 1
        scored.push({ match: { product: p, matchedField: field }, rank: fi * 2 + prefixBonus })
        break // 一个商品只取最高优先级的命中字段
      }
    }
  }
  scored.sort((a, b) => a.rank - b.rank || a.match.product.id - b.match.product.id)
  return scored.slice(0, limit).map((s) => s.match)
}

export interface CommandItem {
  id: string
  label: string
  path: string
  /** 额外可匹配的关键词（含别名，方便记不清菜单名的用户） */
  keywords: string[]
}

// 与侧边栏菜单一一对应的静态命令
export const STATIC_COMMANDS: CommandItem[] = [
  { id: 'go-inbound', label: '去扫码入库', path: '/inbound', keywords: ['入库', '扫码', '进货'] },
  { id: 'go-outbound', label: '去销售出库', path: '/outbound', keywords: ['出库', '销售', '卖货'] },
  { id: 'go-stock-take', label: '去盘点', path: '/stock-take', keywords: ['盘点', '盘库'] },
  { id: 'go-dashboard', label: '去仪表盘', path: '/', keywords: ['仪表盘', '首页', '报表'] },
]

/** 空关键词返回全部命令；否则按命令名/关键词包含匹配 */
export function searchCommands(query: string): CommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return STATIC_COMMANDS
  return STATIC_COMMANDS.filter(
    (c) =>
      c.label.toLowerCase().includes(q) || c.keywords.some((k) => k.toLowerCase().includes(q)),
  )
}
