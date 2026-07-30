import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { CheckCircle2, ClipboardList, Loader2, PackagePlus, Plus, Trash2, Truck } from 'lucide-react'
import { PageHeader, SuccessBanner, ErrorBanner } from '@/components/feedback'
import { useAppStore } from '@/store/appStore'
import { formatDateTime, formatPrice, productName } from '@/lib/formatters'
import { playSound } from '@/lib/sounds'
import {
  PO_STATUS_LABELS,
  type POStatus,
  type Product,
  type PurchaseOrderDetail,
  type PurchaseOrderListItem,
} from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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

const ALL = '__all__'
const NO_SUPPLIER = '__none__'

// 元字符串转分，非法输入返回 null
function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

// 状态徽章配色：待收货-黄、部分收货-蓝、已完成-绿、已取消-灰
const STATUS_BADGE_CLASS: Record<POStatus, string> = {
  draft: 'bg-slate-200 text-slate-500',
  sent: 'bg-yellow-100 text-yellow-700',
  partial: 'bg-blue-100 text-blue-700',
  complete: 'bg-green-100 text-green-700',
  cancelled: 'bg-slate-200 text-slate-500',
}

// 新建订单的商品行草稿
interface DraftItem {
  key: number
  product: Product
  quantity: string
  costYuan: string
}

export function PurchasePage() {
  const products = useAppStore((s) => s.products)
  const suppliers = useAppStore((s) => s.suppliers)
  const purchaseOrders = useAppStore((s) => s.purchaseOrders)
  const lastCostOf = useAppStore((s) => s.lastCostOf)
  const loadPurchaseOrders = useAppStore((s) => s.loadPurchaseOrders)
  const createPurchaseOrder = useAppStore((s) => s.createPurchaseOrder)
  const purchaseOrderDetail = useAppStore((s) => s.purchaseOrderDetail)
  const receivePurchaseOrder = useAppStore((s) => s.receivePurchaseOrder)
  const cancelPurchaseOrder = useAppStore((s) => s.cancelPurchaseOrder)

  const [statusFilter, setStatusFilter] = useState(ALL)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 新建订单 Dialog
  const [createOpen, setCreateOpen] = useState(false)
  const [supplierId, setSupplierId] = useState(NO_SUPPLIER)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([])
  const [itemKey, setItemKey] = useState(1)
  const [pickerKw, setPickerKw] = useState('')
  const [notes, setNotes] = useState('')
  const [createError, setCreateError] = useState('')

  // 详情 Dialog
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null)

  // 收货 Dialog
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrderDetail | null>(null)
  const [receiveQty, setReceiveQty] = useState<Record<number, string>>({})
  const [receiveError, setReceiveError] = useState('')

  // 取消订单二次确认
  const [cancelTarget, setCancelTarget] = useState<PurchaseOrderDetail | null>(null)

  // Electron 环境进页面拉一次采购单列表（loadAll 不含采购单）
  useEffect(() => {
    void loadPurchaseOrders().catch(() => {})
  }, [loadPurchaseOrders])

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 列表按时间倒序 + 状态筛选
  const shown = useMemo(() => {
    return [...purchaseOrders]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
      .filter((o) => statusFilter === ALL || o.status === statusFilter)
  }, [purchaseOrders, statusFilter])

  // 新建订单：商品搜索候选（已加进单子的不再出现）
  const pickerCandidates = useMemo(() => {
    const kw = pickerKw.trim().toLowerCase()
    if (!kw) return []
    const inDraft = new Set(draftItems.map((d) => d.product.id))
    return products
      .filter((p) => !inDraft.has(p.id))
      .filter((p) =>
        [p.sku_code, p.brand, p.model, p.barcode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
      .slice(0, 6)
  }, [pickerKw, products, draftItems])

  const draftTotal = draftItems.reduce((s, d) => {
    const qty = Number(d.quantity)
    const cost = yuanToCents(d.costYuan)
    return s + (Number.isInteger(qty) && qty > 0 && cost !== null ? qty * cost : 0)
  }, 0)

  const openCreate = () => {
    setSupplierId(NO_SUPPLIER)
    setDraftItems([])
    setPickerKw('')
    setNotes('')
    setCreateError('')
    setCreateOpen(true)
  }

  const addDraftItem = (p: Product) => {
    const last = lastCostOf(p.id)
    setDraftItems((prev) => [
      ...prev,
      {
        key: itemKey,
        product: p,
        quantity: '1',
        // 默认带该商品最近进价
        costYuan: last !== null ? (last / 100).toFixed(2) : '',
      },
    ])
    setItemKey((k) => k + 1)
    setPickerKw('')
  }

  const patchDraft = (key: number, patch: Partial<DraftItem>) =>
    setDraftItems((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))

  const handleCreate = async () => {
    if (busy) return
    if (supplierId === NO_SUPPLIER) {
      setCreateError('先选一个供应商——没有的话去「供应商」页加一个')
      playSound('error')
      return
    }
    if (draftItems.length === 0) {
      setCreateError('还没加商品——在上面搜一下要订的货')
      playSound('error')
      return
    }
    const items: { productId: number; quantity: number; costPrice: number }[] = []
    for (const d of draftItems) {
      const qty = Number(d.quantity)
      if (!Number.isInteger(qty) || qty < 1) {
        setCreateError(`「${productName(d.product)}」的数量必须是 ≥1 的整数`)
        playSound('error')
        return
      }
      const cost = yuanToCents(d.costYuan)
      if (cost === null || cost <= 0) {
        setCreateError(`「${productName(d.product)}」的进价没填或不对（要大于 0 元）`)
        playSound('error')
        return
      }
      items.push({ productId: d.product.id, quantity: qty, costPrice: cost })
    }
    setBusy(true)
    try {
      const po = await createPurchaseOrder({
        supplierId: Number(supplierId),
        items,
        notes: notes.trim() || null,
      })
      playSound('success')
      setSuccess(`采购单 ${po.po_no} 已建好，货到了点「收货入库」就行`)
      setCreateOpen(false)
    } catch (e) {
      playSound('error')
      setCreateError(`建单失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (o: PurchaseOrderListItem) => {
    setError('')
    try {
      setDetail(await purchaseOrderDetail(o.id))
    } catch (e) {
      setError(`打开订单失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 刷新详情（收货/取消后弹窗里的数字要跟着变）
  const refreshDetail = async (id: number) => {
    try {
      setDetail(await purchaseOrderDetail(id))
    } catch {
      setDetail(null)
    }
  }

  const openReceive = (d: PurchaseOrderDetail) => {
    // 每条明细默认填剩余待收数量，可改小（分批收货）
    const qty: Record<number, string> = {}
    for (const it of d.items) {
      const remaining = it.quantity - it.received_qty
      if (remaining > 0) qty[it.id] = String(remaining)
    }
    setReceiveQty(qty)
    setReceiveError('')
    setReceiveTarget(d)
  }

  const handleReceive = async () => {
    if (!receiveTarget || busy) return
    const items: { itemId: number; quantity: number }[] = []
    for (const it of receiveTarget.items) {
      const raw = (receiveQty[it.id] ?? '').trim()
      if (raw === '') continue
      const qty = Number(raw)
      const remaining = it.quantity - it.received_qty
      if (!Number.isInteger(qty) || qty < 1) {
        setReceiveError(`「${it.product_name}」的收货数量必须是 ≥1 的整数；这次不收就留空`)
        playSound('error')
        return
      }
      if (qty > remaining) {
        setReceiveError(`「${it.product_name}」最多还能收 ${remaining} 件，不能多收`)
        playSound('error')
        return
      }
      items.push({ itemId: it.id, quantity: qty })
    }
    if (items.length === 0) {
      setReceiveError('这次一件都不收吗？不收就直接关掉这个窗口')
      playSound('error')
      return
    }
    setBusy(true)
    try {
      const r = await receivePurchaseOrder(receiveTarget.order.id, items)
      playSound('success')
      setSuccess(`已入库 ${r.receivedTotal} 件，库存已更新`)
      setReceiveTarget(null)
      await refreshDetail(receiveTarget.order.id)
    } catch (e) {
      playSound('error')
      setReceiveError(`收货失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async () => {
    if (!cancelTarget || busy) return
    setBusy(true)
    try {
      await cancelPurchaseOrder(cancelTarget.order.id)
      playSound('success')
      setSuccess(`采购单 ${cancelTarget.order.po_no} 已取消`)
      setCancelTarget(null)
      await refreshDetail(cancelTarget.order.id)
    } catch (e) {
      playSound('error')
      setError(`取消失败：${e instanceof Error ? e.message : String(e)}`)
      setCancelTarget(null)
    } finally {
      setBusy(false)
    }
  }

  const canReceive = (status: POStatus) => status === 'sent' || status === 'partial'

  return (
    <div className="space-y-6">
      <PageHeader
        title="采购订货"
        subtitle="给供应商下单订货，货到了点「收货入库」自动加库存"
        action={
          <Button onClick={openCreate} className="bg-brand-600 hover:bg-brand-700">
            <Plus className="size-4" />
            新建采购单
          </Button>
        }
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* 订单列表 */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-center gap-3">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部状态</SelectItem>
                <SelectItem value="sent">待收货</SelectItem>
                <SelectItem value="partial">部分收货</SelectItem>
                <SelectItem value="complete">已完成</SelectItem>
                <SelectItem value="cancelled">已取消</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">共 {shown.length} 张单</span>
          </div>
          {shown.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {purchaseOrders.length === 0
                ? '还没有采购单，点右上角「新建采购单」给供应商下第一张订货单'
                : '这个状态下没有单子，换个筛选看看'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>单号</TableHead>
                  <TableHead>供应商</TableHead>
                  <TableHead className="text-right">订了几种货</TableHead>
                  <TableHead className="text-right">总金额</TableHead>
                  <TableHead>收货进度</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>下单时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((o) => (
                  <TableRow
                    key={o.id}
                    className="cursor-pointer"
                    onClick={() => void openDetail(o)}
                    title="点开看明细、收货"
                  >
                    <TableCell className="font-mono text-xs">{o.po_no}</TableCell>
                    <TableCell>{o.supplier_name ?? '未指定'}</TableCell>
                    <TableCell className="text-right">{o.item_count} 种</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPrice(o.total_cost)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'tabular-nums',
                          o.received_qty >= o.total_qty ? 'text-green-700' : 'text-slate-700',
                        )}
                      >
                        已收 {o.received_qty}/{o.total_qty} 件
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge className={STATUS_BADGE_CLASS[o.status]}>
                        {PO_STATUS_LABELS[o.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(o.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新建采购单 Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>新建采购单</DialogTitle>
            <DialogDescription>
              选供应商、加要订的货，提交后货到了到列表里点「收货入库」
            </DialogDescription>
          </DialogHeader>
          {createError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {createError}
            </div>
          )}
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>供应商 *</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择供应商..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SUPPLIER} disabled>
                      选择供应商...
                    </SelectItem>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>备注</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="比如：月底结账、急用先发货"
                />
              </div>
            </div>

            {/* 加商品：搜索下拉点选 */}
            <div className="relative space-y-1">
              <Label>加商品</Label>
              <Input
                value={pickerKw}
                onChange={(e) => setPickerKw(e.target.value)}
                placeholder="输入 SKU/品牌/型号搜索，点一下加进单子..."
              />
              {pickerKw.trim() && (
                <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-white shadow-card-hover">
                  {pickerCandidates.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => addDraftItem(p)}
                      className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand-50"
                    >
                      <span>
                        {productName(p)}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {p.sku_code}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        最近进价 {formatPrice(lastCostOf(p.id))}
                      </span>
                    </button>
                  ))}
                  {pickerCandidates.length === 0 && (
                    <div className="px-4 py-3 text-sm text-muted-foreground">没有匹配的商品</div>
                  )}
                </div>
              )}
            </div>

            {/* 已加的商品行 */}
            {draftItems.length > 0 && (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>商品</TableHead>
                      <TableHead className="w-24 text-right">数量</TableHead>
                      <TableHead className="w-32 text-right">进价（元）</TableHead>
                      <TableHead className="w-28 text-right">小计</TableHead>
                      <TableHead className="w-14" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {draftItems.map((d) => {
                      const qty = Number(d.quantity)
                      const cost = yuanToCents(d.costYuan)
                      const sub =
                        Number.isInteger(qty) && qty > 0 && cost !== null ? qty * cost : null
                      return (
                        <TableRow key={d.key}>
                          <TableCell>
                            {productName(d.product)}
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {d.product.sku_code}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              min={1}
                              value={d.quantity}
                              onChange={(e) => patchDraft(d.key, { quantity: e.target.value })}
                              className="h-8 w-20 text-right"
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              value={d.costYuan}
                              onChange={(e) => patchDraft(d.key, { costYuan: e.target.value })}
                              className="h-8 w-28 text-right"
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {sub !== null ? formatPrice(sub) : '-'}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="删掉这行"
                              onClick={() =>
                                setDraftItems((prev) => prev.filter((x) => x.key !== d.key))
                              }
                            >
                              <Trash2 className="size-4 text-red-500" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                <div className="flex justify-end border-t bg-slate-50 px-4 py-2.5 text-sm">
                  合计：<span className="ml-1 text-base font-bold text-brand-600 tabular-nums">{formatPrice(draftTotal)}</span>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button asChild onClick={handleCreate} disabled={busy}>
              <motion.button whileTap={{ scale: 0.96 }}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? '提交中...' : '提交订货单'}
              </motion.button>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 订单详情 Dialog */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              <ClipboardList className="size-5 text-brand-500" />
              采购单 <span className="font-mono">{detail?.order.po_no}</span>
              {detail && (
                <Badge className={STATUS_BADGE_CLASS[detail.order.status]}>
                  {PO_STATUS_LABELS[detail.order.status]}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              供应商：{detail?.order.supplier_name ?? '未指定'} · 下单：
              {detail ? formatDateTime(detail.order.created_at) : ''}
              {detail?.order.notes ? ` · 备注：${detail.order.notes}` : ''}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>商品</TableHead>
                      <TableHead className="text-right">订了多少</TableHead>
                      <TableHead className="text-right">已收</TableHead>
                      <TableHead className="text-right">还差</TableHead>
                      <TableHead className="text-right">进价</TableHead>
                      <TableHead className="text-right">小计</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.items.map((it) => {
                      const remaining = it.quantity - it.received_qty
                      return (
                        <TableRow key={it.id}>
                          <TableCell>
                            {it.product_name}
                            {it.sku_code && (
                              <span className="ml-2 font-mono text-xs text-muted-foreground">
                                {it.sku_code}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">{it.quantity}</TableCell>
                          <TableCell className="text-right">{it.received_qty}</TableCell>
                          <TableCell
                            className={cn(
                              'text-right font-medium',
                              remaining > 0 ? 'text-amber-600' : 'text-green-700',
                            )}
                          >
                            {remaining > 0 ? remaining : '收齐了'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPrice(it.unit_cost)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatPrice(it.quantity * it.unit_cost)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                <div className="flex justify-end border-t bg-slate-50 px-4 py-2.5 text-sm">
                  总金额：<span className="ml-1 text-base font-bold text-brand-600 tabular-nums">{formatPrice(detail.order.total_cost)}</span>
                </div>
              </div>
              <div className="flex gap-3">
                {canReceive(detail.order.status) && (
                  <Button
                    asChild
                    onClick={() => openReceive(detail)}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <motion.button whileTap={{ scale: 0.96 }}>
                      <Truck className="size-4" />
                      收货入库
                    </motion.button>
                  </Button>
                )}
                {canReceive(detail.order.status) && (
                  <Button
                    variant="outline"
                    className="text-red-600"
                    onClick={() => setCancelTarget(detail)}
                  >
                    取消订单
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 收货 Dialog：每条明细默认填剩余待收数量，可改小分批收 */}
      <Dialog
        open={receiveTarget !== null}
        onOpenChange={(open) => !open && setReceiveTarget(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="size-5 text-green-600" />
              收货入库
            </DialogTitle>
            <DialogDescription>
              数一下实际到了多少件，填进去；这次没收到的行留空就行，下次再收
            </DialogDescription>
          </DialogHeader>
          {receiveError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {receiveError}
            </div>
          )}
          <div className="space-y-3">
            {receiveTarget?.items
              .filter((it) => it.quantity - it.received_qty > 0)
              .map((it) => {
                const remaining = it.quantity - it.received_qty
                return (
                  <div
                    key={it.id}
                    className="flex items-center justify-between gap-4 rounded-xl border px-4 py-3"
                  >
                    <div className="text-sm">
                      <div className="font-medium text-slate-800">{it.product_name}</div>
                      <div className="text-xs text-muted-foreground">
                        订了 {it.quantity} 件，已收 {it.received_qty} 件，还差 {remaining} 件
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label className="text-sm whitespace-nowrap">这次收</Label>
                      <Input
                        type="number"
                        min={0}
                        max={remaining}
                        value={receiveQty[it.id] ?? ''}
                        onChange={(e) =>
                          setReceiveQty((q) => ({ ...q, [it.id]: e.target.value }))
                        }
                        className="h-11 w-24 text-right text-lg font-bold tabular-nums"
                      />
                      <span className="text-sm text-muted-foreground">件</span>
                    </div>
                  </div>
                )
              })}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReceiveTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button
              asChild
              onClick={handleReceive}
              disabled={busy}
              className="bg-green-600 hover:bg-green-700"
            >
              <motion.button whileTap={{ scale: 0.96 }}>
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-4" />
                )}
                {busy ? '入库中...' : '确认收货入库'}
              </motion.button>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 取消订单二次确认（大白话说明后果） */}
      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(open) => !open && setCancelTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>取消这张采购单？</DialogTitle>
            <DialogDescription>
              取消后：已经收进库的货会保留，还没收的部分就作废了，供应商再送货来也入不了这张单。
              确定要取消「{cancelTarget?.order.po_no}」吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelTarget(null)} disabled={busy}>
              再想想
            </Button>
            <Button variant="destructive" onClick={handleCancel} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? '取消中...' : '确定取消订单'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 空状态下的小提示：没商品时引导先入库 */}
      {products.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <PackagePlus className="size-4" />
          还没有商品档案，先去「扫码入库」录入商品，再来下采购单
        </div>
      )}
    </div>
  )
}
