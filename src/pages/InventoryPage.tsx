import { Fragment, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, CalendarClock, Download, Loader2, Pencil, Search, Tag, Trash2, TriangleAlert, ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { PriceLabelDialog } from '@/components/PriceLabel'
import { formatDate, formatPrice, productName, csvCell } from '@/lib/formatters'
import { computeExpiring } from '@/lib/expiry'
import {
  SPEC_FIELDS, SPEC_LABELS, SPEC_PLACEHOLDERS, collectSpecs, formatSpecs,
  specFieldsFor, specsToForm, type SpecField,
} from '@/lib/productSpecs'
import { CATEGORIES, PRICE_LEVELS, PRICE_LEVEL_LABELS, PRODUCT_STATUSES, type Category, type InventoryBatch, type PriceLevel, type Product, type ProductStatus } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { ErrorBanner, PageHeader, SuccessBanner } from '@/components/feedback'

const ALL = '__all__'
const LOW_STOCK_THRESHOLD = 5

// 状态标签配色，一眼区分商品状态
const STATUS_BADGE_CLASS: Record<ProductStatus, string> = {
  已盘点: 'bg-green-100 text-green-700',
  待盘点: 'bg-yellow-100 text-yellow-700',
  已上架虾皮: 'bg-purple-100 text-purple-700',
  已售罄: 'bg-red-100 text-red-700',
  停产: 'bg-slate-200 text-slate-500',
}

type SortDir = 'asc' | 'desc'
type BatchSortKey = 'quantity' | 'cost_price' | 'inbound_date'

// 排序循环：未排序 → 升序 → 降序 → 取消排序（恢复默认顺序）
function cycleDir(dir: SortDir | null): SortDir | null {
  return dir === null ? 'asc' : dir === 'asc' ? 'desc' : null
}

// 表头排序方向小箭头：未排序时显示灰色双向箭头，提示这一列可以点
function SortIcon({ dir }: { dir: SortDir | null }) {
  if (dir === 'asc') return <ArrowUp className="size-3.5" />
  if (dir === 'desc') return <ArrowDown className="size-3.5" />
  return <ArrowUpDown className="size-3.5 opacity-40" />
}

export function InventoryPage() {
  const products = useAppStore((s) => s.products)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const batchesOf = useAppStore((s) => s.batchesOf)
  const suppliers = useAppStore((s) => s.suppliers)
  const batches = useAppStore((s) => s.batches)

  const [keyword, setKeyword] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  const [category, setCategory] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  // 低库存快捷筛选：仪表盘「低库存」卡片跳转过来时自动开启
  const [lowOnly, setLowOnly] = useState(false)
  // 临期快捷筛选：仪表盘「临期商品」卡片跳转过来时自动开启
  const [expiringOnly, setExpiringOnly] = useState(false)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [searchParams] = useSearchParams()

  // 临期/过期商品（productId → 详情）：行徽章 + 临期筛选共用；与后端 product:expiring 同口径本地算
  const expiringMap = useMemo(
    () => new Map(computeExpiring(products, totalStockOf, 30).map((e) => [e.id, e])),
    [products, batches, totalStockOf], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // 仪表盘跳转参数：?filter=low 只看低库存；?filter=expiring 只看临期；?status=待盘点 按状态筛选（仅初始化一次）
  useEffect(() => {
    const f = searchParams.get('filter')
    if (f === 'low') setLowOnly(true)
    if (f === 'expiring') setExpiringOnly(true)
    const st = searchParams.get('status')
    if (st && (PRODUCT_STATUSES as string[]).includes(st)) setStatus(st)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 命令面板跳转参数：?q=关键词 带入搜索框定位商品。
  // 依赖 searchParams 而非只跑一次：已在库存页时再选另一个商品也能生效；
  // 同时清掉其他筛选，避免"跳过来却看不到货"
  useEffect(() => {
    const q = searchParams.get('q')
    if (q !== null) {
      setKeyword(q)
      setCategory(ALL)
      setStatus(ALL)
      setLowOnly(false)
      setExpiringOnly(false)
    }
  }, [searchParams])

  // 编辑/删除（MISSING-3 前端入口）
  const updateProduct = useAppStore((s) => s.updateProduct)
  const deleteProduct = useAppStore((s) => s.deleteProduct)
  // 多级定价：编辑弹窗里的五档价格（空着=没设这档）
  const priceTiers = useAppStore((s) => s.priceTiers)
  const setPriceTier = useAppStore((s) => s.setPriceTier)
  const deletePriceTier = useAppStore((s) => s.deletePriceTier)
  const [editing, setEditing] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState<Product | null>(null)
  // 价格标签打印：点商品行里的「打标签」打开预览
  const [labeling, setLabeling] = useState<Product | null>(null)
  // 保存防重复：await 期间置 busy，双击不会并发触发两次 updateProduct
  const [saving, setSaving] = useState(false)
  const [pageError, setPageError] = useState('')
  // P0-1：编辑/删除成功也要给绿条反馈
  const [pageSuccess, setPageSuccess] = useState('')

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!pageSuccess) return
    const t = setTimeout(() => setPageSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [pageSuccess])
  const [form, setForm] = useState({
    category: '' as Category | '',
    sub_category: '',
    brand: '',
    model: '',
    cost_price: '',
    suggest_price: '',
    location: '',
    status: '' as ProductStatus | '',
    min_stock: '', // 安全库存：空串=不单独设，按默认 5 预警
  })
  // 渔具规格表单（按品类出不同字段，全部选填）
  const [specForm, setSpecForm] = useState<Record<SpecField, string>>(
    () => specsToForm({}),
  )
  // 价格档次表单：五档各一个元字符串，空串=没设这档
  const emptyTierForm = (): Record<PriceLevel, string> =>
    Object.fromEntries(PRICE_LEVELS.map((t) => [t, ''])) as Record<PriceLevel, string>
  const [tierForm, setTierForm] = useState<Record<PriceLevel, string>>(emptyTierForm)

  const openEdit = (p: Product) => {
    setPageError('')
    setForm({
      category: p.category,
      sub_category: p.sub_category ?? '',
      brand: p.brand ?? '',
      model: p.model ?? '',
      cost_price: (p.cost_price / 100).toString(),
      suggest_price: p.suggest_price !== null ? (p.suggest_price / 100).toString() : '',
      location: p.location ?? '',
      status: p.status,
      min_stock: p.min_stock !== null ? String(p.min_stock) : '',
    })
    setSpecForm(specsToForm(p))
    const tiers = emptyTierForm()
    for (const t of priceTiers.filter((x) => x.product_id === p.id)) {
      tiers[t.tier] = (t.price / 100).toString()
    }
    setTierForm(tiers)
    setEditing(p)
  }

  const saveEdit = async () => {
    if (!editing || saving) return
    const cost = Math.round(parseFloat(form.cost_price) * 100)
    if (!Number.isFinite(cost) || cost <= 0) {
      setPageError('最近进价格式不正确')
      return
    }
    const suggest = form.suggest_price.trim()
      ? Math.round(parseFloat(form.suggest_price) * 100)
      : null
    if (form.suggest_price.trim() && !Number.isFinite(suggest)) {
      setPageError('建议售价格式不正确')
      return
    }
    if (!form.category || !form.status) {
      setPageError('品类和状态不能为空')
      return
    }
    // 安全库存：留空=不单独设（按默认 5）；填了必须是 ≥0 的整数
    const minStockRaw = form.min_stock.trim()
    let minStock: number | null = null
    if (minStockRaw !== '') {
      const n = Number(minStockRaw)
      if (!Number.isInteger(n) || n < 0) {
        setPageError('安全库存要是 0 或更大的整数（不想单独设就留空）')
        return
      }
      minStock = n
    }
    // 价格档次校验：空着=没设这档；填了必须是 >0 的数
    const tierPrices = new Map<PriceLevel, number>()
    for (const t of PRICE_LEVELS) {
      const raw = tierForm[t].trim()
      if (raw === '') continue
      const cents = Math.round(parseFloat(raw) * 100)
      if (!Number.isFinite(cents) || cents <= 0) {
        setPageError(`「${PRICE_LEVEL_LABELS[t]}价」格式不正确（要大于 0 元；不设这档就留空）`)
        return
      }
      tierPrices.set(t, cents)
    }
    setSaving(true)
    try {
      await updateProduct(editing.id, {
        category: form.category as Category,
        sub_category: form.sub_category.trim() || null,
        brand: form.brand.trim() || null,
        model: form.model.trim() || null,
        cost_price: cost,
        suggest_price: suggest,
        location: form.location.trim() || null,
        status: form.status as ProductStatus,
        min_stock: minStock,
        ...collectSpecs(specForm),
      })
      // 价格档次落库：填了的 set（新增/覆盖），清空了的 delete
      for (const t of PRICE_LEVELS) {
        const existing = priceTiers.find((x) => x.product_id === editing.id && x.tier === t)
        const next = tierPrices.get(t)
        if (next !== undefined) {
          if (!existing || existing.price !== next) await setPriceTier(editing.id, t, next)
        } else if (existing) {
          await deletePriceTier(editing.id, t)
        }
      }
      setPageSuccess(`已保存「${productName(editing)}」的修改`)
      setEditing(null)
    } catch (e) {
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    const target = deleting
    setDeleting(null)
    try {
      await deleteProduct(target.id)
      setPageSuccess(`已删除「${productName(target)}」`)
    } catch (e) {
      // 后端会拒绝有批次/流水的商品，提示引导改「停产」
      setPageError(e instanceof Error ? e.message : String(e))
    }
  }

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKeyword(keyword.trim()), 300)
    return () => clearTimeout(t)
  }, [keyword])

  const filtered = useMemo(() => {
    return products.filter((p) => {
      if (category !== ALL && p.category !== (category as Category)) return false
      if (status !== ALL && p.status !== (status as ProductStatus)) return false
      if (lowOnly && totalStockOf(p.id) >= (p.min_stock ?? LOW_STOCK_THRESHOLD)) return false
      if (expiringOnly && !expiringMap.has(p.id)) return false
      if (debouncedKeyword) {
        const kw = debouncedKeyword.toLowerCase()
        // 规格字段（长度/调性/线号等）也纳入搜索：搜"3.6"能找到 3.6m 的竿
        const haystack = [
          p.sku_code, p.barcode, p.brand, p.model, p.category,
          ...SPEC_FIELDS.map((f) => p[f]),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(kw)) return false
      }
      return true
    })
  }, [products, category, status, debouncedKeyword, lowOnly, expiringOnly, expiringMap, totalStockOf])

  // 表头排序（纯前端，不动数据层）：主表按总库存，批次子表按数量/单价/入库日期
  const [stockSort, setStockSort] = useState<SortDir | null>(null)
  const [batchSort, setBatchSort] = useState<{ key: BatchSortKey; dir: SortDir } | null>(null)

  const toggleBatchSort = (key: BatchSortKey) =>
    setBatchSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: 'asc' }
      return cur.dir === 'asc' ? { key, dir: 'desc' } : null
    })

  // 先筛选后排序：排序只作用在筛选结果上
  const sorted = useMemo(() => {
    if (!stockSort) return filtered
    return [...filtered].sort((a, b) => {
      const d = totalStockOf(a.id) - totalStockOf(b.id)
      return (stockSort === 'asc' ? d : -d) || a.id - b.id
    })
  }, [filtered, stockSort, totalStockOf])

  const sortBatchList = (list: InventoryBatch[]) => {
    if (!batchSort) return list
    return [...list].sort((a, b) => {
      const d =
        batchSort.key === 'inbound_date'
          ? a.inbound_date.localeCompare(b.inbound_date)
          : a[batchSort.key] - b[batchSort.key]
      return (batchSort.dir === 'asc' ? d : -d) || a.id - b.id
    })
  }

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // csvCell 已从 @/lib/formatters 导入（含逗号/引号/换行的字段包引号、引号双写）

  const exportCsv = () => {
    const header = 'SKU,条码,品类,品牌,型号,状态,总库存,货位,最近进价(元),长度,调性,硬度,线号,钩号,颜色,材质,保质期'
    const rows = filtered.map((p) =>
      [
        p.sku_code,
        p.barcode ?? '',
        p.category,
        p.brand ?? '',
        p.model ?? '',
        p.status,
        totalStockOf(p.id),
        p.location ?? '',
        (p.cost_price / 100).toFixed(2),
        p.rod_length ?? '',
        p.rod_action ?? '',
        p.power_rating ?? '',
        p.line_number ?? '',
        p.hook_size ?? '',
        p.color ?? '',
        p.material ?? '',
        p.expiry_date ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
    // 加 BOM 让 Excel 正确识别中文
    const blob = new Blob(['﻿' + [header, ...rows].join('\n')], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `库存导出-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="库存查询"
        subtitle="按商品、批次、货位多维度查询当前库存"
        action={
          <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="size-4" />
            导出CSV
          </Button>
        }
      />

      {pageSuccess && <SuccessBanner>{pageSuccess}</SuccessBanner>}
      {pageError && <ErrorBanner>{pageError}</ErrorBanner>}

      {/* 筛选区 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索SKU/品牌/型号/条码..."
              className="pl-9"
            />
          </div>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="品类" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部品类</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部状态</SelectItem>
              {PRODUCT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant={lowOnly ? 'destructive' : 'outline'}
            onClick={() => setLowOnly((v) => !v)}
            title="只看库存低于预警线的商品（未单独设置预警线的按 5 件算）"
          >
            <TriangleAlert className="size-4" />
            低库存
          </Button>
          <Button
            variant="outline"
            className={expiringOnly ? 'border-amber-500 bg-amber-500 text-white hover:bg-amber-600 hover:text-white' : ''}
            onClick={() => setExpiringOnly((v) => !v)}
            title="只看 30 天内到期或已经过期的商品"
          >
            <CalendarClock className="size-4" />
            临期
          </Button>
          <span className="text-sm text-muted-foreground">共 {filtered.length} 个商品</span>
        </CardContent>
      </Card>

      {/* 库存表格 */}
      <Card>
        <CardContent className="pt-6">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {products.length === 0
                ? '还没有商品，点左边菜单的「扫码入库」，扫一下商品条码就能录入第一件货'
                : '没有符合条件的商品，换个关键词或筛选条件试试'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>SKU</TableHead>
                  <TableHead>品类</TableHead>
                  <TableHead>品牌</TableHead>
                  <TableHead>型号规格</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">
                    <button
                      onClick={() => setStockSort((d) => cycleDir(d))}
                      className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground/60"
                      title="点击按库存数量排序"
                    >
                      总库存
                      <SortIcon dir={stockSort} />
                    </button>
                  </TableHead>
                  <TableHead>货位</TableHead>
                  <TableHead className="w-28 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((p) => {
                  const total = totalStockOf(p.id)
                  const low = total < (p.min_stock ?? LOW_STOCK_THRESHOLD)
                  const isOpen = expanded.has(p.id)
                  return (
                    <Fragment key={p.id}>
                      {/* 行高压到 py-1.5 + 小号操作按钮：一屏能多看几行货，又不至于挤 */}
                      <TableRow className={cn(low && 'bg-red-50 hover:bg-red-100')}>
                        <TableCell className="py-1.5">
                          <button
                            onClick={() => toggleExpand(p.id)}
                            className="text-slate-500 hover:text-slate-900 cursor-pointer"
                            title={isOpen ? '收起批次' : '展开批次'}
                          >
                            {isOpen ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                          </button>
                        </TableCell>
                        <TableCell className="py-1.5 font-mono text-xs">{p.sku_code}</TableCell>
                        <TableCell className="py-1.5">{p.category}</TableCell>
                        <TableCell className="py-1.5">{p.brand ?? '—'}</TableCell>
                        <TableCell className="py-1.5">
                          {p.model ?? '—'}
                          {(() => {
                            const ex = expiringMap.get(p.id)
                            if (!ex) return null
                            return (
                              <Badge
                                className={`ml-2 ${ex.expired ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}
                                title={`保质期到 ${ex.expiry_date}`}
                              >
                                {ex.expired
                                  ? '已过期'
                                  : ex.daysLeft === 0
                                    ? '今天过期'
                                    : `${ex.daysLeft} 天后过期`}
                              </Badge>
                            )
                          })()}
                        </TableCell>
                        <TableCell className="py-1.5">
                          <Badge className={STATUS_BADGE_CLASS[p.status]}>{p.status}</Badge>
                        </TableCell>
                        <TableCell
                          className={cn('py-1.5 text-right font-medium', low && 'text-red-600')}
                        >
                          {total}
                        </TableCell>
                        <TableCell className="py-1.5">{p.location ?? '-'}</TableCell>
                        <TableCell className="py-1.5 text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="打印价格标签"
                              onClick={() => setLabeling(p)}
                            >
                              <Tag className="size-4 text-brand-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="编辑商品"
                              onClick={() => openEdit(p)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="删除商品"
                              onClick={() => {
                                setPageError('')
                                setDeleting(p)
                              }}
                            >
                              <Trash2 className="size-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${p.id}-batches`} className="bg-slate-50 hover:bg-slate-50">
                          <TableCell />
                          <TableCell colSpan={8} className="py-3">
                            {formatSpecs(p) && (
                              <div className="mb-2 text-xs text-slate-500">
                                规格：<span className="font-medium text-slate-700">{formatSpecs(p)}</span>
                              </div>
                            )}
                            {batchesOf(p.id).length === 0 ? (
                              <div className="text-xs text-muted-foreground">无批次库存</div>
                            ) : (
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>批次号</TableHead>
                                    <TableHead className="text-right">
                                      <button
                                        onClick={() => toggleBatchSort('quantity')}
                                        className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground/60"
                                        title="点击按数量排序"
                                      >
                                        数量
                                        <SortIcon
                                          dir={batchSort?.key === 'quantity' ? batchSort.dir : null}
                                        />
                                      </button>
                                    </TableHead>
                                    <TableHead className="text-right">
                                      <button
                                        onClick={() => toggleBatchSort('cost_price')}
                                        className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground/60"
                                        title="点击按成本价排序"
                                      >
                                        单价
                                        <SortIcon
                                          dir={
                                            batchSort?.key === 'cost_price' ? batchSort.dir : null
                                          }
                                        />
                                      </button>
                                    </TableHead>
                                    <TableHead>
                                      <button
                                        onClick={() => toggleBatchSort('inbound_date')}
                                        className="flex cursor-pointer items-center gap-1 hover:text-foreground/60"
                                        title="点击按入库日期排序"
                                      >
                                        入库日期
                                        <SortIcon
                                          dir={
                                            batchSort?.key === 'inbound_date'
                                              ? batchSort.dir
                                              : null
                                          }
                                        />
                                      </button>
                                    </TableHead>
                                    <TableHead>货位</TableHead>
                                    <TableHead>供应商</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {sortBatchList(batchesOf(p.id)).map((b) => (
                                    <TableRow key={b.id}>
                                      <TableCell className="font-mono text-xs">
                                        {b.batch_no}
                                      </TableCell>
                                      <TableCell className="text-right">{b.quantity}</TableCell>
                                      <TableCell className="text-right">
                                        {formatPrice(b.cost_price)}
                                      </TableCell>
                                      <TableCell>{formatDate(b.inbound_date)}</TableCell>
                                      <TableCell>{b.location ?? '-'}</TableCell>
                                      <TableCell>
                                        {suppliers.find((s) => s.id === b.supplier_id)?.name ??
                                          '-'}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 编辑商品 Dialog：SKU 创建后不可改 */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑商品</DialogTitle>
            <DialogDescription>
              SKU <span className="font-mono">{editing?.sku_code}</span> 创建后不可修改
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>品类 *</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v as Category }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择品类" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>子类</Label>
              <Input
                value={form.sub_category}
                onChange={(e) => setForm((f) => ({ ...f, sub_category: e.target.value }))}
                placeholder="如：手竿 / 纺车轮"
              />
            </div>
            <div className="space-y-2">
              <Label>品牌</Label>
              <Input
                value={form.brand}
                onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>型号规格</Label>
              <Input
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>最近进价（元）*</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.cost_price}
                onChange={(e) => setForm((f) => ({ ...f, cost_price: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>建议售价（元）</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.suggest_price}
                onChange={(e) => setForm((f) => ({ ...f, suggest_price: e.target.value }))}
              />
              <div className="text-xs text-muted-foreground">这是默认价，卖货时先带出它</div>
            </div>
            <div className="space-y-2">
              <Label>货位</Label>
              <Input
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
              />
            </div>
            {/* 安全库存：饵料/鱼钩这类消耗快的老板可以自己调大；留空按默认 5 */}
            <div className="space-y-2">
              <Label>安全库存</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={form.min_stock}
                onChange={(e) => setForm((f) => ({ ...f, min_stock: e.target.value }))}
                placeholder="低于这个数就提醒你，默认 5"
              />
            </div>
            <div className="space-y-2">
              <Label>状态 *</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v as ProductStatus }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择状态" />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* 价格档次：五档各一个价，空着=没设这档；卖货时在出库确认里一键带出 */}
            <div className="col-span-2 space-y-2 border-t pt-3">
              <div className="text-xs text-muted-foreground">
                价格档次（选填，单位：元；空着表示没设这档。卖货时点一下档位就自动带出价格）
              </div>
              <div className="grid grid-cols-3 gap-3 md:grid-cols-5">
                {PRICE_LEVELS.map((t) => (
                  <div key={t} className="space-y-1">
                    <Label>{PRICE_LEVEL_LABELS[t]}价</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={tierForm[t]}
                      onChange={(e) =>
                        setTierForm((s) => ({ ...s, [t]: e.target.value }))
                      }
                      placeholder="没设"
                    />
                  </div>
                ))}
              </div>
            </div>
            {/* 渔具规格：按品类出不同字段，全部选填 */}
            {form.category && (
              <div className="col-span-2 space-y-2 border-t pt-3">
                <div className="text-xs text-muted-foreground">规格（选填，随品类变化）</div>
                <div className="grid grid-cols-3 gap-3">
                  {specFieldsFor(form.category).map((f) => (
                    <div key={f} className="space-y-1">
                      <Label>{SPEC_LABELS[f]}</Label>
                      <Input
                        value={specForm[f]}
                        onChange={(e) =>
                          setSpecForm((s) => ({ ...s, [f]: e.target.value }))
                        }
                        placeholder={SPEC_PLACEHOLDERS[f]}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 价格标签预览/打印 Dialog：点商品行的「打标签」打开 */}
      <PriceLabelDialog
        product={labeling}
        open={labeling !== null}
        onOpenChange={(open) => !open && setLabeling(null)}
      />

      {/* 删除确认 Dialog（危险操作二次确认） */}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除商品</DialogTitle>
            <DialogDescription>
              确定要删掉「{deleting ? productName(deleting) : ''}」（{deleting?.sku_code}
              ）吗？删掉就找不回来了。如果这个商品有过入库/出库记录，系统会拦着不让删
              ——只是以后不卖了的话，建议改成「停产」，记录都还在。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
