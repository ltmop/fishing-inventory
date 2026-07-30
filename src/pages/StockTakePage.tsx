import { useMemo, useState } from 'react'
import { ArrowLeft, CircleCheck, ClipboardCheck, Loader2, Play, Search } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { formatDateTime, productName } from '@/lib/formatters'
import { CATEGORIES, type Category, type StockTake, type Supplier } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
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
import { PageHeader } from '@/components/feedback'
import { playSound } from '@/lib/sounds'

const WHOLE_SHOP = '__all__'

/** 盘点单范围的大白话描述：「A区 · 品类：鱼钩 · 供应商：XX渔具」，无筛选就是「全店」 */
export function takeScopeLabel(t: StockTake, suppliers: Supplier[]): string {
  const parts: string[] = []
  if (t.location_filter) parts.push(t.location_filter)
  if (t.category_filter) parts.push(`品类：${t.category_filter}`)
  if (t.supplier_filter != null) {
    parts.push(`供应商：${suppliers.find((s) => s.id === t.supplier_filter)?.name ?? `#${t.supplier_filter}`}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '全店'
}

export function StockTakePage() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const suppliers = useAppStore((s) => s.suppliers)
  const stockTakes = useAppStore((s) => s.stockTakes)
  const stockTakeItems = useAppStore((s) => s.stockTakeItems)
  const createStockTake = useAppStore((s) => s.createStockTake)
  const submitStockTake = useAppStore((s) => s.submitStockTake)

  const [activeTakeId, setActiveTakeId] = useState<number | null>(null)
  const [keyword, setKeyword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pageError, setPageError] = useState('')
  // 提交进度展示："正在保存第 X 项，共 Y 项"（实际写入是单事务，失败整体回滚）
  const [progress, setProgress] = useState<{ cur: number; total: number } | null>(null)

  // 新建盘点 Dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [area, setArea] = useState(WHOLE_SHOP)
  const [category, setCategory] = useState(WHOLE_SHOP)
  const [supplierKey, setSupplierKey] = useState(WHOLE_SHOP)
  const [operator, setOperator] = useState('阿杜')

  // 完成盘点确认 Dialog
  const [finishOpen, setFinishOpen] = useState(false)

  // 盘点录入的本地暂存，完成时统一提交
  const [edits, setEdits] = useState<Record<number, { qty: string; reason: string }>>({})

  // 从现有货位提取区域前缀（如 "A区"）
  const areas = useMemo(() => {
    const set = new Set<string>()
    for (const loc of [...products.map((p) => p.location), ...batches.map((b) => b.location)]) {
      const m = loc?.match(/^.+?区/)
      if (m) set.add(m[0])
    }
    return [...set].sort()
  }, [products, batches])

  const activeTake = stockTakes.find((t) => t.id === activeTakeId) ?? null
  const activeItems = useMemo(
    () => stockTakeItems.filter((it) => it.stock_take_id === activeTakeId),
    [stockTakeItems, activeTakeId],
  )

  const openTake = (t: StockTake) => {
    setActiveTakeId(t.id)
    setKeyword('')
    const init: Record<number, { qty: string; reason: string }> = {}
    for (const it of stockTakeItems) {
      if (it.stock_take_id === t.id) {
        init[it.id] = { qty: it.actual_qty === null ? '' : String(it.actual_qty), reason: it.reason }
      }
    }
    setEdits(init)
  }

  const handleCreate = async () => {
    if (submitting) return
    setSubmitting(true)
    setPageError('')
    try {
      const take = await createStockTake(area === WHOLE_SHOP ? null : area, operator.trim() || '未署名', {
        category: category === WHOLE_SHOP ? null : (category as Category),
        supplierId: supplierKey === WHOLE_SHOP ? null : Number(supplierKey),
      })
      setCreateOpen(false)
      openTake(take)
    } catch (e) {
      setCreateOpen(false)
      setPageError(`创建盘点单失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  const filteredItems = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return activeItems
    return activeItems.filter((it) => {
      const p = products.find((x) => x.id === it.product_id)
      return [p?.sku_code, p?.brand, p?.model, p?.barcode]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(kw)
    })
  }, [activeItems, keyword, products])

  // 差异汇总（基于本地录入）
  const summary = useMemo(() => {
    let counted = 0
    let surplus = 0
    let shortage = 0
    for (const it of activeItems) {
      const edit = edits[it.id]
      if (!edit || edit.qty.trim() === '') continue
      const actual = Number(edit.qty)
      if (!Number.isInteger(actual) || actual < 0) continue
      counted++
      const diff = actual - it.system_qty
      if (diff > 0) surplus += diff
      else shortage += diff
    }
    return { counted, surplus, shortage, total: surplus + shortage }
  }, [activeItems, edits])

  const uncounted = activeItems.length - summary.counted

  const handleFinish = async () => {
    if (!activeTake || submitting) return
    setSubmitting(true)
    setPageError('')
    // 原子提交：实盘数 + 完成盘点一个事务搞定，中途失败整体回滚
    const items = activeItems.flatMap((it) => {
      const edit = edits[it.id]
      if (!edit || edit.qty.trim() === '') return []
      const actual = Number(edit.qty)
      return Number.isInteger(actual) && actual >= 0
        ? [{ itemId: it.id, actualQty: actual, reason: edit.reason.trim() }]
        : []
    })
    // 进度呈现：单事务写入很快，这里用匀速计数让老板看到"正在一条条存"
    setProgress({ cur: 1, total: Math.max(items.length, 1) })
    const timer = setInterval(() => {
      setProgress((p) => (p && p.cur < p.total ? { ...p, cur: p.cur + 1 } : p))
    }, 90)
    try {
      await submitStockTake(activeTake.id, items)
      playSound('success')
      setFinishOpen(false)
      setActiveTakeId(null)
    } catch (e) {
      setFinishOpen(false)
      playSound('error')
      setPageError(`盘点提交失败：${e instanceof Error ? e.message : String(e)}（已整体回滚，库存未被改动）`)
    } finally {
      clearInterval(timer)
      setProgress(null)
      setSubmitting(false)
    }
  }

  const statusBadge = (s: StockTake['status']) =>
    s === '进行中' ? (
      <Badge className="bg-amber-500">{s}</Badge>
    ) : (
      <Badge variant="secondary">{s}</Badge>
    )

  // ───────── 盘点执行视图 ─────────
  if (activeTake) {
    const readOnly = activeTake.status !== '进行中'
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setActiveTakeId(null)}>
            <ArrowLeft className="size-5" />
          </Button>
          <h1 className="text-2xl font-bold text-slate-800">盘点执行：{activeTake.take_no}</h1>
          <span className="text-sm text-muted-foreground">
            范围：{takeScopeLabel(activeTake, suppliers)}
          </span>
          {statusBadge(activeTake.status)}
        </div>

        {/* 搜索过滤：进行中用于快速定位录入，已完成用于翻查历史明细，都可用 */}
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <Search className="size-5 shrink-0 text-sky-600" />
            <Input
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索/扫码商品（SKU/品牌/型号/条码）..."
              className="text-base"
            />
          </CardContent>
        </Card>

        {pageError && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {pageError}
          </div>
        )}

        <Card>
          <CardContent className="pt-6">
            {filteredItems.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {activeItems.length === 0 ? '该盘点单没有明细' : '没有符合条件的商品'}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>品名</TableHead>
                    <TableHead className="text-right">系统库存</TableHead>
                    <TableHead className="w-28 text-right">实际数量</TableHead>
                    <TableHead className="text-right">差异</TableHead>
                    <TableHead>原因</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((it) => {
                    const p = products.find((x) => x.id === it.product_id)
                    const edit = edits[it.id] ?? { qty: '', reason: '' }
                    const actual = edit.qty.trim() === '' ? null : Number(edit.qty)
                    const valid = actual === null || (Number.isInteger(actual) && actual >= 0)
                    const diff = valid && actual !== null ? actual - it.system_qty : null
                    return (
                      <TableRow key={it.id}>
                        <TableCell className="font-mono text-xs">{p?.sku_code ?? '-'}</TableCell>
                        <TableCell>
                          {p ? productName(p) : `#${it.product_id}`}
                        </TableCell>
                        <TableCell className="text-right">{it.system_qty}</TableCell>
                        <TableCell className="text-right">
                          {readOnly ? (
                            (it.actual_qty ?? '-')
                          ) : (
                            <Input
                              type="number"
                              min={0}
                              value={edit.qty}
                              onChange={(e) =>
                                setEdits((prev) => ({
                                  ...prev,
                                  [it.id]: { ...edit, qty: e.target.value },
                                }))
                              }
                              className={cn(
                                'ml-auto w-24 text-right',
                                !valid && 'border-red-500 focus-visible:ring-red-500',
                              )}
                            />
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-medium',
                            diff !== null && diff > 0 && 'text-green-600',
                            diff !== null && diff < 0 && 'text-red-600',
                          )}
                        >
                          {diff === null ? '-' : diff > 0 ? `+${diff}` : diff}
                        </TableCell>
                        <TableCell>
                          {readOnly ? (
                            (it.reason || '-')
                          ) : (
                            <Input
                              value={edit.reason}
                              onChange={(e) =>
                                setEdits((prev) => ({
                                  ...prev,
                                  [it.id]: { ...edit, reason: e.target.value },
                                }))
                              }
                              placeholder="差异原因..."
                              className="w-40"
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center justify-between pt-6">
            <div className="text-sm text-slate-600">
              差异汇总：已盘 {summary.counted}/{activeItems.length} 项 ｜ 差异总数{' '}
              {summary.total >= 0 ? `+${summary.total}` : summary.total} ｜ 盘盈{' '}
              <span className="text-green-600">+{summary.surplus}</span> ｜ 盘亏{' '}
              <span className="text-red-600">{summary.shortage}</span>
            </div>
            {!readOnly && (
              <Button onClick={() => setFinishOpen(true)} disabled={summary.counted === 0 || submitting}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
                {submitting ? '提交中...' : '完成盘点'}
              </Button>
            )}
          </CardContent>
        </Card>

        <Dialog open={finishOpen} onOpenChange={setFinishOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>完成盘点</DialogTitle>
              <DialogDescription>
                将把 {summary.counted} 项盘点结果落实到批次库存，差异不可撤销。
                {uncounted > 0 && `另有 ${uncounted} 项未录入实际数量，将保持系统库存不变。`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setFinishOpen(false)}>
                再想想
              </Button>
              <Button variant="destructive" onClick={handleFinish} disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {submitting
                  ? progress
                    ? `正在保存第 ${progress.cur} 项，共 ${progress.total} 项`
                    : '提交中...'
                  : '确认完成盘点'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  // ───────── 盘点单列表视图 ─────────
  return (
    <div className="space-y-6">
      <PageHeader
        title="盘点管理"
        subtitle="创建盘点单、录入实盘数量、差异落实到批次库存"
        action={<Button onClick={() => setCreateOpen(true)}>+ 新建盘点</Button>}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">盘点单（{stockTakes.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {stockTakes.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无盘点单，点击右上角新建
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>盘点单号</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>盘点范围</TableHead>
                  <TableHead>开始时间</TableHead>
                  <TableHead>完成时间</TableHead>
                  <TableHead>操作人</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stockTakes.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs">{t.take_no}</TableCell>
                    <TableCell>{statusBadge(t.status)}</TableCell>
                    <TableCell>{takeScopeLabel(t, suppliers)}</TableCell>
                    <TableCell>{formatDateTime(t.started_at)}</TableCell>
                    <TableCell>{formatDateTime(t.completed_at)}</TableCell>
                    <TableCell>{t.operator}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => openTake(t)}>
                        {t.status === '进行中' ? (
                          <>
                            <Play className="size-3" />
                            进入盘点
                          </>
                        ) : (
                          '查看'
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新建盘点 Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建盘点</DialogTitle>
            <DialogDescription>
              选好范围（区域/品类/供应商可以组合）后，系统按当前批次库存生成盘点明细
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>盘点区域</Label>
              <Select value={area} onValueChange={setArea}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WHOLE_SHOP}>全店</SelectItem>
                  {areas.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>品类</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WHOLE_SHOP}>全部品类</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>供应商</Label>
              <Select value={supplierKey} onValueChange={setSupplierKey}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WHOLE_SHOP}>全部供应商</SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>操作人</Label>
              <Input value={operator} onChange={(e) => setOperator(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={submitting}>
              <CircleCheck className="size-4" />
              {submitting ? '创建中...' : '创建并开始盘点'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
