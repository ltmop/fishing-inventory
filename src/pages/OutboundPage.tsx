import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ArrowLeftRight, Loader2, PackageMinus, RotateCcw } from 'lucide-react'
import { PageHeader, SuccessBanner, ErrorBanner } from '@/components/feedback'
import { ScanHero } from '@/components/scan/ScanHero'
import { useAppStore } from '@/store/appStore'
import { previewFifo } from '@/lib/fifo'
import { playSound } from '@/lib/sounds'
import { formatDate, formatPrice, formatTime, isToday, productName } from '@/lib/formatters'
import type { CreditOptions } from '@/store/appStore'
import { PRICE_LEVEL_LABELS, type Customer, type PriceLevel, type Product } from '@/types'
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

function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

export function OutboundPage() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const transactions = useAppStore((s) => s.transactions)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const batchesOf = useAppStore((s) => s.batchesOf)
  const confirmOutbound = useAppStore((s) => s.confirmOutbound)
  const addReturn = useAppStore((s) => s.addReturn)
  const addExchange = useAppStore((s) => s.addExchange)
  const customers = useAppStore((s) => s.customers)
  const loadCustomers = useAppStore((s) => s.loadCustomers)
  const addCustomer = useAppStore((s) => s.addCustomer)
  // 多级定价：选中商品若设了档次价，确认出库时可一键带出
  const priceTiers = useAppStore((s) => s.priceTiers)

  // 赊账要选客户：进页面先拉客户列表（loadAll 不含客户）
  useEffect(() => {
    void loadCustomers().catch(() => {})
  }, [loadCustomers])

  const inputRef = useRef<HTMLInputElement>(null)
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Product | null>(null)
  const [quantity, setQuantity] = useState('')
  const [priceYuan, setPriceYuan] = useState('')
  // 当前售价来自哪个价格档（手动改价后为 null=自定义价）
  const [activeTier, setActiveTier] = useState<PriceLevel | null>(null)
  const [operator, setOperator] = useState('阿杜')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [executing, setExecuting] = useState(false)

  // 赊账包：确认出库时选客户 + 付款方式（散客只能全额收款）
  const WALK_IN = '__walkin__'
  const NEW_CUST = '__new__'
  const [custKey, setCustKey] = useState(WALK_IN)
  const [payMode, setPayMode] = useState<'full' | 'partial' | 'credit'>('full')
  const [paidYuan, setPaidYuan] = useState('')
  const [confirmError, setConfirmError] = useState('')
  // 「+ 新客户」快捷建档
  const [quickCustOpen, setQuickCustOpen] = useState(false)
  const [quickName, setQuickName] = useState('')
  const [quickPhone, setQuickPhone] = useState('')
  const [quickBusy, setQuickBusy] = useState(false)
  const [quickError, setQuickError] = useState('')

  // 退货登记（P2-1）：顾客退货重新入架，退款金额入账
  const [returnOpen, setReturnOpen] = useState(false)
  const [retKeyword, setRetKeyword] = useState('')
  const [retSelected, setRetSelected] = useState<Product | null>(null)
  const [retQty, setRetQty] = useState('')
  const [retRefund, setRetRefund] = useState('')
  const [retBusy, setRetBusy] = useState(false)
  // 赊账销售的退货：记到原赊账客户账上（后端冲减他的欠款），可手动取消
  const [retUseCredit, setRetUseCredit] = useState(true)

  // 换货登记（清单第 15 项）：先退旧货再出新货，同一事务
  const [exchOpen, setExchOpen] = useState(false)
  const [exchOld, setExchOld] = useState<Product | null>(null)
  const [exchNew, setExchNew] = useState<Product | null>(null)
  const [exchOldKw, setExchOldKw] = useState('')
  const [exchNewKw, setExchNewKw] = useState('')
  const [exchQty, setExchQty] = useState('')
  const [exchPrice, setExchPrice] = useState('')
  const [exchBusy, setExchBusy] = useState(false)

  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 搜索候选：条码精确匹配优先，其次 SKU/品牌/型号模糊匹配，最多 8 条
  const candidates = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw || selected) return []
    const exact = products.filter((p) => p.barcode === keyword.trim())
    if (exact.length > 0) return exact
    return products
      .filter((p) =>
        [p.sku_code, p.brand, p.model, p.barcode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
      .slice(0, 8)
  }, [keyword, products, selected])

  const productBatches = useMemo(
    () => (selected ? batchesOf(selected.id).filter((b) => b.quantity > 0) : []),
    [selected, batchesOf],
  )

  // 选中商品设了哪些档次价（没设档的商品不显示档位按钮）
  const selectedTiers = useMemo(
    () => (selected ? priceTiers.filter((t) => t.product_id === selected.id) : []),
    [selected, priceTiers],
  )

  const qty = Number(quantity)
  const qtyValid = Number.isInteger(qty) && qty > 0
  const totalStock = selected ? totalStockOf(selected.id) : 0
  const { plan, byBatch } = useMemo(
    () => (selected && qtyValid ? previewFifo(productBatches, qty) : { plan: null, byBatch: new Map<number, number>() }),
    [selected, qtyValid, productBatches, qty],
  )
  const overStock = qtyValid && plan !== null && !plan.ok

  const selectProduct = (p: Product) => {
    setSelected(p)
    setKeyword('')
    setQuantity('')
    // 默认带「零售」档价；没设零售档就用建议售价
    const retail = priceTiers.find((t) => t.product_id === p.id && t.tier === 'retail')
    const fallback = p.suggest_price
    const prefill = retail?.price ?? fallback
    setPriceYuan(prefill !== null && prefill !== undefined ? (prefill / 100).toFixed(2) : '')
    setActiveTier(retail ? 'retail' : null)
    setError('')
  }

  // 点了价格档：带出这档的价格（仍可手改）
  const applyTier = (tier: PriceLevel) => {
    const t = selectedTiers.find((x) => x.tier === tier)
    if (!t) return
    setPriceYuan((t.price / 100).toFixed(2))
    setActiveTier(tier)
  }

  const resetSelection = () => {
    setSelected(null)
    setQuantity('')
    setActiveTier(null)
    setError('')
    inputRef.current?.focus()
  }

  const handleConfirmClick = () => {
    if (!selected) return
    if (!qtyValid) {
      setError('出库数量必须是 ≥1 的整数')
      playSound('error')
      return
    }
    if (overStock) {
      setError(`出库数量超过当前库存（还差 ${plan!.shortage} 个）`)
      playSound('error')
      return
    }
    // 售价必填且必须大于 0（清单第 14 项）：营业额和毛利报表都靠它记账
    const price = yuanToCents(priceYuan)
    if (priceYuan.trim() === '' || price === null || price <= 0) {
      setError('请填写实际售价（必须大于 0 元）——营业额和毛利报表都靠它记账')
      playSound('error')
      return
    }
    setError('')
    // 打开确认框前重置赊账选项：默认散客全额收款，「付一部分」默认填应付总额
    setCustKey(WALK_IN)
    setPayMode('full')
    setPaidYuan(((qty * price) / 100).toFixed(2))
    setConfirmError('')
    setConfirmOpen(true)
  }

  // 确认框里选中「+ 新客户」：快捷建档，建完自动选中
  const handleQuickCreate = async () => {
    if (quickBusy) return
    if (!quickName.trim()) {
      setQuickError('客户姓名不能为空')
      return
    }
    setQuickBusy(true)
    try {
      const c: Customer = await addCustomer({ name: quickName, phone: quickPhone, notes: '' })
      setQuickCustOpen(false)
      setCustKey(String(c.id))
      playSound('success')
    } catch (e) {
      playSound('error')
      setQuickError(e instanceof Error ? e.message : String(e))
    } finally {
      setQuickBusy(false)
    }
  }

  const handleExecute = async () => {
    if (!selected || !qtyValid || executing) return
    const price = yuanToCents(priceYuan)
    if (priceYuan.trim() === '' || price === null || price <= 0) {
      setError('售价必须大于 0 元')
      setConfirmOpen(false)
      return
    }
    const total = qty * price
    const custId = custKey === WALK_IN || custKey === NEW_CUST ? null : Number(custKey)
    // 散客全额收款不传任何记账参数；客户「全额收款」只传 customerId（paidAmount 省略=全额）
    let credit: CreditOptions | undefined
    if (custId !== null) {
      if (payMode === 'credit') {
        credit = { customerId: custId, paidAmount: 0 }
      } else if (payMode === 'partial') {
        const paid = yuanToCents(paidYuan)
        if (paid === null || paid <= 0) {
          setConfirmError('请填写这次收了多少钱（大于 0 元）')
          return
        }
        if (paid > total) {
          setConfirmError(`收的钱不能超过应付总额 ${formatPrice(total)}`)
          return
        }
        credit = paid === total ? { customerId: custId } : { customerId: custId, paidAmount: paid }
      } else {
        credit = { customerId: custId }
      }
    }
    setExecuting(true)
    try {
      const result = await confirmOutbound(selected.id, qty, price, operator.trim() || '未署名', credit)
      setConfirmOpen(false)
      if (!result.ok) {
        playSound('error')
        setError(`库存不足，还差 ${result.shortage} 个`)
        return
      }
      playSound('success')
      const custName = custId !== null ? (customers.find((c) => c.id === custId)?.name ?? null) : null
      const owed = credit?.paidAmount != null ? total - credit.paidAmount : 0
      if (custName && owed > 0) {
        setSuccess(`已记账：${custName} 欠 ${formatPrice(owed)}（${productName(selected)} × ${qty}）`)
      } else if (custName) {
        setSuccess(`已出库：${productName(selected)} × ${qty}，${custName} 已全额付款`)
      } else {
        setSuccess(`已出库：${productName(selected)} × ${qty}`)
      }
      setSelected(null)
      setQuantity('')
      setActiveTier(null)
      inputRef.current?.focus()
    } catch (e) {
      setConfirmOpen(false)
      playSound('error')
      setError(`出库失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExecuting(false)
    }
  }

  // 今日流水：出库 + 退货 + 换货（换货双腿已按 return/out 记账，天然包含）
  const todayRecords = transactions.filter(
    (t) => (t.type === 'out' || t.type === 'return') && isToday(t.timestamp),
  )

  // 流水类型标签：优先用 notes 识别换货双腿
  const txKindLabel = (t: (typeof todayRecords)[number]): string => {
    if (t.notes === '换货出新') return '换货出新'
    if (t.notes === '换货退旧') return '换货退旧'
    return t.type === 'return' ? '退货' : '出库'
  }

  // 退货候选：与出库搜索同规则
  const retCandidates = useMemo(() => {
    const kw = retKeyword.trim().toLowerCase()
    if (!kw || retSelected) return []
    return products
      .filter((p) =>
        [p.sku_code, p.brand, p.model, p.barcode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw),
      )
      .slice(0, 6)
  }, [retKeyword, products, retSelected])

  // 该商品最近一次赊账出库的客户：退货记到他账上，后端冲减他的欠款
  const retCreditCustomer = useMemo(() => {
    if (!retSelected) return null
    let best: (typeof transactions)[number] | null = null
    for (const t of transactions) {
      if (t.type === 'out' && t.product_id === retSelected.id && t.customer_id != null) {
        if (!best || t.timestamp > best.timestamp) best = t
      }
    }
    if (!best) return null
    return customers.find((c) => c.id === best!.customer_id) ?? null
  }, [retSelected, transactions, customers])

  const openReturnDialog = () => {
    setRetKeyword('')
    setRetSelected(null)
    setRetQty('')
    setRetRefund('')
    setRetUseCredit(true)
    setError('')
    setReturnOpen(true)
  }

  const handleReturnSubmit = async () => {
    if (!retSelected || retBusy) return
    const q = Number(retQty)
    if (!Number.isInteger(q) || q < 1) {
      setError('退货数量必须是 ≥1 的整数')
      return
    }
    const refund = yuanToCents(retRefund)
    if (retRefund.trim() === '' || refund === null) {
      setError('请填写退款金额（元）——退给顾客多少钱要记账')
      return
    }
    const creditCust = retUseCredit ? retCreditCustomer : null
    setRetBusy(true)
    try {
      await addReturn(retSelected.id, q, refund, operator.trim() || '未署名', creditCust?.id ?? null)
      setReturnOpen(false)
      playSound('success')
      setSuccess(
        creditCust
          ? `已登记退货：${productName(retSelected)} × ${q}，库存已加回；退货后 ${creditCust.name} 少欠 ${formatPrice(refund * q)}`
          : `已登记退货：${productName(retSelected)} × ${q}，库存已加回`,
      )
      setRetSelected(null)
    } catch (e) {
      playSound('error')
      setError(`退货登记失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRetBusy(false)
    }
  }

  // 换货候选搜索（旧/新商品各自独立）
  const searchProducts = (kw: string, excludeId: number | null) => {
    const k = kw.trim().toLowerCase()
    if (!k) return []
    return products
      .filter((p) => p.id !== excludeId)
      .filter((p) =>
        [p.sku_code, p.brand, p.model, p.barcode]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(k),
      )
      .slice(0, 5)
  }

  const openExchangeDialog = () => {
    setExchOld(null)
    setExchNew(null)
    setExchOldKw('')
    setExchNewKw('')
    setExchQty('')
    setExchPrice('')
    setError('')
    setExchOpen(true)
  }

  const handleExchangeSubmit = async () => {
    if (!exchOld || !exchNew || exchBusy) return
    if (exchOld.id === exchNew.id) {
      setError('换货的旧商品和新商品不能是同一个')
      return
    }
    const q = Number(exchQty)
    if (!Number.isInteger(q) || q < 1) {
      setError('换货数量必须是 ≥1 的整数')
      return
    }
    const price = yuanToCents(exchPrice)
    if (exchPrice.trim() === '' || price === null || price <= 0) {
      setError('请填写新货售价（必须大于 0 元）')
      return
    }
    setExchBusy(true)
    try {
      const r = await addExchange(exchOld.id, exchNew.id, q, price, operator.trim() || '未署名')
      if (!r.ok) {
        playSound('error')
        setError(`新货「${productName(exchNew)}」库存不足，还差 ${r.shortage} 件，换货未记账`)
        return
      }
      setExchOpen(false)
      playSound('success')
      setSuccess(`换货完成：退回 ${productName(exchOld)} × ${q}，出新 ${productName(exchNew)} × ${q}`)
    } catch (e) {
      playSound('error')
      setError(`换货失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExchBusy(false)
    }
  }

  // 换货对话框里的商品选择器（搜索 → 点选）
  const renderExchPicker = (
    label: string,
    sel: Product | null,
    setSel: (p: Product | null) => void,
    kw: string,
    setKw: (v: string) => void,
    excludeId: number | null,
  ) => (
    <div className="relative space-y-1">
      <Label>{label} *</Label>
      {sel ? (
        <div className="flex items-center justify-between rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5">
          <div className="text-sm">
            <span className="font-medium text-slate-800">{productName(sel)}</span>
            <span className="ml-2 font-mono text-xs text-muted-foreground">{sel.sku_code}</span>
            <span className="ml-2 text-xs text-muted-foreground">库存 {totalStockOf(sel.id)}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setSel(null)}>
            换一个
          </Button>
        </div>
      ) : (
        <>
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="输入 SKU/品牌/型号搜索..." />
          {kw.trim() && (
            <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-white shadow-card-hover">
              {searchProducts(kw, excludeId).map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSel(p)
                    setKw('')
                  }}
                  className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand-50"
                >
                  <span>
                    {productName(p)}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{p.sku_code}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">库存 {totalStockOf(p.id)}</span>
                </button>
              ))}
              {searchProducts(kw, excludeId).length === 0 && (
                <div className="px-4 py-3 text-sm text-muted-foreground">没有匹配的商品</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="销售出库"
        subtitle="按先进先出（FIFO）规则扣减批次库存"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={openReturnDialog}>
              <RotateCcw className="size-4" />
              退货登记
            </Button>
            <Button variant="outline" onClick={openExchangeDialog}>
              <ArrowLeftRight className="size-4" />
              换货登记
            </Button>
          </div>
        }
      />

      {/* 搜索区：与入库页同款 ScanHero，回车选中首个候选（适配扫码枪） */}
      <ScanHero
        inputRef={inputRef}
        autoFocus
        icon="search"
        value={keyword}
        onChange={(v) => {
          setKeyword(v)
          if (selected) setSelected(null)
        }}
        onSubmit={() => {
          if (candidates.length > 0) {
            playSound('scan')
            selectProduct(candidates[0])
          } else if (keyword.trim()) {
            playSound('error')
          }
        }}
        placeholder="扫码或输入 SKU/品牌/型号搜索商品，按下 Enter 选中..."
        hint="提示：扫码枪扫条码后回车即选中商品；模糊搜索从下拉列表点选"
      >
        {candidates.length > 0 && (
          <div className="absolute inset-x-6 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-white shadow-card-hover">
            {candidates.map((p) => (
              <button
                key={p.id}
                onClick={() => selectProduct(p)}
                className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand-50"
              >
                <span>
                  {productName(p)}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {p.sku_code}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  库存 {totalStockOf(p.id)}
                </span>
              </button>
            ))}
          </div>
        )}
      </ScanHero>

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* 选中商品：与入库匹配卡片同款升舱处理 */}
      {selected && (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="h-1.5 bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700" />
          <CardHeader className="pt-5">
            <CardTitle className="flex items-center gap-3 text-lg">
              {productName(selected)}
              <Badge variant="secondary">{selected.category}</Badge>
              <span className="text-sm font-normal text-muted-foreground">
                当前总库存：<span className="font-semibold text-brand-600">{totalStock} 件</span>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pb-5">
            <div className="space-y-2">
              <div className="text-sm text-slate-600">批次库存（FIFO，按入库日期排列）：</div>
              {productBatches.length === 0 ? (
                <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  该商品暂无库存，无法出库
                </div>
              ) : (
                productBatches.map((b, idx) => {
                  const deduct = byBatch.get(b.id) ?? 0
                  return (
                    <div
                      key={b.id}
                      className={cn(
                        'relative flex items-center gap-4 rounded-md border px-4 py-2 text-sm',
                        idx === 0 && 'border-l-4 border-l-green-500',
                        deduct > 0 && 'bg-slate-100/70',
                      )}
                    >
                      <span className="font-mono text-xs">{b.batch_no}</span>
                      {idx === 0 && <Badge className="bg-green-600">最早批次</Badge>}
                      <span>库存 {b.quantity}</span>
                      <span>{formatPrice(b.cost_price)}</span>
                      <span className="text-muted-foreground">{b.location ?? '-'}</span>
                      <span className="text-muted-foreground">{formatDate(b.inbound_date)}</span>
                      {deduct > 0 && (
                        <span className="ml-auto font-medium text-red-600">
                          扣 {deduct} → 剩 {b.quantity - deduct}
                        </span>
                      )}
                    </div>
                  )
                })
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <div className="space-y-1">
                <Label>出库数量 *</Label>
                <Input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className={cn(overStock && 'border-red-500 focus-visible:ring-red-500')}
                />
                {overStock && (
                  <div className="text-xs text-red-600">
                    出库数量超过当前库存（还差 {plan!.shortage} 个）
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <Label>
                  售价（元）<span className="text-red-500">*</span>
                </Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={priceYuan}
                  onChange={(e) => {
                    setPriceYuan(e.target.value)
                    // 手动改价后：还和某档价格一致就算那档，否则算自定义价
                    const cents = yuanToCents(e.target.value)
                    setActiveTier(
                      cents !== null
                        ? (selectedTiers.find((t) => t.price === cents)?.tier ?? null)
                        : null,
                    )
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>操作人</Label>
                <Input value={operator} onChange={(e) => setOperator(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-3">
              <Button asChild onClick={handleConfirmClick} disabled={productBatches.length === 0}>
                <motion.button whileTap={{ scale: 0.96 }}>
                <PackageMinus className="size-4" />
                确认出库
                </motion.button>
              </Button>
              <Button variant="ghost" onClick={resetSelection}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 今日出入账记录（出库/退货/换货） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">今日出入账记录（{todayRecords.length} 条）</CardTitle>
        </CardHeader>
        <CardContent>
          {todayRecords.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">今日暂无出入账记录</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>品名</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead>批次号</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">成本价</TableHead>
                  <TableHead className="text-right">售价/退款</TableHead>
                  <TableHead className="text-right">毛利</TableHead>
                  <TableHead>操作人</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {todayRecords.map((t) => {
                  const p = products.find((x) => x.id === t.product_id)
                  const b = batches.find((x) => x.id === t.batch_id)
                  const isReturn = t.type === 'return'
                  // 退货按负毛利冲减：退款 − 批次成本，取负
                  const profit =
                    t.selling_price != null && t.unit_price != null
                      ? (t.selling_price - t.unit_price) * t.quantity * (isReturn ? -1 : 1)
                      : null
                  const kind = txKindLabel(t)
                  return (
                    <TableRow key={t.id}>
                      <TableCell>{formatTime(t.timestamp)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={isReturn ? 'destructive' : 'secondary'}
                          className={cn(kind.startsWith('换货') && !isReturn && 'bg-brand-100 text-brand-700')}
                        >
                          {kind}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {p ? productName(p) : `#${t.product_id}`}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const cust = t.customer_id != null ? customers.find((c) => c.id === t.customer_id) : null
                          // 赊账标：赊账单后端会写实收金额，欠 = 应付 − 实收
                          const owed =
                            !isReturn && t.paid_amount != null && t.selling_price != null
                              ? t.quantity * t.selling_price - t.paid_amount
                              : 0
                          return cust ? (
                            <span>
                              {cust.name}
                              {owed > 0 && (
                                <Badge variant="destructive" className="ml-2">
                                  赊 {formatPrice(owed)}
                                </Badge>
                              )}
                            </span>
                          ) : (
                            <span className="text-slate-400">散客</span>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{b?.batch_no ?? '-'}</TableCell>
                      <TableCell className={cn('text-right', isReturn && 'text-red-600')}>
                        {isReturn ? `-${t.quantity}` : t.quantity}
                      </TableCell>
                      <TableCell className="text-right">{formatPrice(t.unit_price)}</TableCell>
                      <TableCell className={cn('text-right', isReturn && 'text-red-600')}>
                        {formatPrice(t.selling_price)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          profit !== null && profit >= 0 ? 'text-green-700' : 'text-red-600',
                        )}
                      >
                        {profit !== null ? formatPrice(profit) : '-'}
                      </TableCell>
                      <TableCell>{t.operator ?? '-'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 出库确认 Dialog（危险操作二次确认） */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认出库</DialogTitle>
            <DialogDescription>
              {selected ? productName(selected) : ''} × {quantity}
              {qtyValid && yuanToCents(priceYuan) !== null && (
                <>
                  ，应付 <span className="font-semibold text-slate-700">{formatPrice(qty * (yuanToCents(priceYuan) ?? 0))}</span>
                </>
              )}
              ，将按 FIFO 扣减以下批次：
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {plan?.allocations.map((a) => (
              <div
                key={a.batch_id}
                className="flex items-center justify-between rounded-md border px-4 py-2 text-sm"
              >
                <span className="font-mono text-xs">{a.batch_no}</span>
                <span>
                  扣 <span className="font-medium text-red-600">{a.deduct}</span> → 剩{' '}
                  {a.remaining_after}
                </span>
              </div>
            ))}
          </div>

          {/* 价格档：该商品设了档次价才显示；点一下带出这档价格，售价仍可回主界面手改 */}
          {selectedTiers.length > 0 && (
            <div className="space-y-2">
              <Label>按哪档价格卖</Label>
              <div className="flex flex-wrap gap-2">
                {selectedTiers.map((t) => (
                  <button
                    key={t.tier}
                    onClick={() => applyTier(t.tier)}
                    className={cn(
                      'h-12 min-w-24 cursor-pointer rounded-xl border px-4 text-base font-medium transition-colors',
                      activeTier === t.tier
                        ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100',
                    )}
                  >
                    {PRICE_LEVEL_LABELS[t.tier]}{' '}
                    <span className="tabular-nums">{formatPrice(t.price)}</span>
                  </button>
                ))}
              </div>
              <div className="text-xs text-muted-foreground">
                当前售价 {formatPrice(yuanToCents(priceYuan))}
                {activeTier === null && yuanToCents(priceYuan) !== null && '（自定义价）'}
              </div>
            </div>
          )}

          {/* 买的人 + 付款方式：散客只能全额收款；选了客户可以赊账 */}
          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="space-y-1">
              <Label>买的人</Label>
              <Select
                value={custKey}
                onValueChange={(v) => {
                  if (v === NEW_CUST) {
                    setQuickName('')
                    setQuickPhone('')
                    setQuickError('')
                    setQuickCustOpen(true)
                  } else {
                    setCustKey(v)
                    setPayMode('full')
                    setConfirmError('')
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WALK_IN}>散客（不记账）</SelectItem>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                      {c.outstanding > 0 ? `（还欠 ${formatPrice(c.outstanding)}）` : ''}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_CUST}>+ 新客户</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {custKey === WALK_IN ? (
              <div className="text-sm text-slate-500">散客需全额收款，钱货两清</div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ['full', '全额收款'],
                      ['partial', '付一部分'],
                      ['credit', '先欠着'],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => {
                        setPayMode(mode)
                        setConfirmError('')
                      }}
                      className={cn(
                        'h-12 cursor-pointer rounded-xl border text-base font-medium transition-colors',
                        payMode === mode
                          ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {payMode === 'partial' && (
                  <div className="space-y-1">
                    <Label>这次收了多少钱（元）</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={paidYuan}
                      onChange={(e) => setPaidYuan(e.target.value)}
                      className="h-12 text-xl font-bold tabular-nums"
                    />
                  </div>
                )}
                {payMode !== 'full' && qtyValid && yuanToCents(priceYuan) !== null && (
                  <div className="text-sm text-red-600">
                    这次先欠{' '}
                    {formatPrice(
                      qty * (yuanToCents(priceYuan) ?? 0) -
                        (payMode === 'credit' ? 0 : Math.min(yuanToCents(paidYuan) ?? 0, qty * (yuanToCents(priceYuan) ?? 0))),
                    )}
                    ，记到「{customers.find((c) => String(c.id) === custKey)?.name ?? ''}」账上
                  </div>
                )}
              </div>
            )}
            {confirmError && <div className="text-sm text-red-600">{confirmError}</div>}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleExecute} disabled={executing}>
              {executing && <Loader2 className="size-4 animate-spin" />}
              {executing ? '执行中...' : '确认执行出库'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 「+ 新客户」快捷建档 Dialog：只填姓名电话，建完自动选中 */}
      <Dialog open={quickCustOpen} onOpenChange={setQuickCustOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新客户</DialogTitle>
            <DialogDescription>先建个简单的档案，回头可以在「客户」页补全资料</DialogDescription>
          </DialogHeader>
          {quickError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {quickError}
            </div>
          )}
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>姓名 *</Label>
              <Input
                autoFocus
                value={quickName}
                onChange={(e) => setQuickName(e.target.value)}
                placeholder="比如：老王"
              />
            </div>
            <div className="space-y-1">
              <Label>电话</Label>
              <Input value={quickPhone} onChange={(e) => setQuickPhone(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setQuickCustOpen(false)} disabled={quickBusy}>
              取消
            </Button>
            <Button onClick={handleQuickCreate} disabled={quickBusy}>
              {quickBusy && <Loader2 className="size-4 animate-spin" />}
              {quickBusy ? '保存中...' : '保存并选中'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 退货登记 Dialog：退回来的货重新入架，退款金额入账 */}
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="size-5 text-brand-500" />
              退货登记
            </DialogTitle>
            <DialogDescription>
              退回来的商品会加回库存（计入最近一次入库的批次），退款金额记入今日账目
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!retSelected ? (
              <div className="relative space-y-1">
                <Label>搜索退货商品 *</Label>
                <Input
                  autoFocus
                  value={retKeyword}
                  onChange={(e) => setRetKeyword(e.target.value)}
                  placeholder="输入 SKU/品牌/型号搜索..."
                />
                {retCandidates.length > 0 && (
                  <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-white shadow-card-hover">
                    {retCandidates.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setRetSelected(p)
                          setRetKeyword('')
                        }}
                        className="flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand-50"
                      >
                        <span>
                          {productName(p)}
                          <span className="ml-2 font-mono text-xs text-muted-foreground">
                            {p.sku_code}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          库存 {totalStockOf(p.id)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
                  <div className="text-sm">
                    <span className="font-medium text-slate-800">{productName(retSelected)}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {retSelected.sku_code}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setRetSelected(null)}>
                    换一个
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <Label>退货数量 *</Label>
                    <Input
                      type="number"
                      min={1}
                      value={retQty}
                      onChange={(e) => setRetQty(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>退款金额（元）*</Label>
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={retRefund}
                      onChange={(e) => setRetRefund(e.target.value)}
                      placeholder="退给顾客多少钱"
                    />
                  </div>
                </div>
                {/* 赊账销售的退货：记到原客户账上，退货后他少欠；不是他的可以点掉 */}
                {retCreditCustomer && (
                  <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
                    {retUseCredit ? (
                      <span>
                        「{retCreditCustomer.name}」赊账买过这个，这次退货记到他账上，退货后他少欠
                      </span>
                    ) : (
                      <span>这次退货不记到任何人账上</span>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setRetUseCredit(!retUseCredit)}>
                      {retUseCredit ? '不是他的' : '记到他账上'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReturnOpen(false)} disabled={retBusy}>
              取消
            </Button>
            <Button onClick={handleReturnSubmit} disabled={!retSelected || retBusy}>
              {retBusy && <Loader2 className="size-4 animate-spin" />}
              {retBusy ? '登记中...' : '确认退货入库'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 换货登记 Dialog：先退旧货再出新货，同一事务，失败整体回滚 */}
      <Dialog open={exchOpen} onOpenChange={setExchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="size-5 text-brand-500" />
              换货登记
            </DialogTitle>
            <DialogDescription>
              旧货退回库存、新货按 FIFO 出库，两步一笔账；新货库存不足时不会动账
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {renderExchPicker('退回的旧商品', exchOld, setExchOld, exchOldKw, setExchOldKw, exchNew?.id ?? null)}
            {renderExchPicker('换出的新商品', exchNew, setExchNew, exchNewKw, setExchNewKw, exchOld?.id ?? null)}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>数量 *</Label>
                <Input
                  type="number"
                  min={1}
                  value={exchQty}
                  onChange={(e) => setExchQty(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>
                  新货售价（元）<span className="text-red-500">*</span>
                </Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={exchPrice}
                  onChange={(e) => setExchPrice(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExchOpen(false)} disabled={exchBusy}>
              取消
            </Button>
            <Button onClick={handleExchangeSubmit} disabled={!exchOld || !exchNew || exchBusy}>
              {exchBusy && <Loader2 className="size-4 animate-spin" />}
              {exchBusy ? '换货中...' : '确认换货'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
