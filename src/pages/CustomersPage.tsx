import { useEffect, useMemo, useState } from 'react'
import { HandCoins, Loader2, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { formatDateTime, formatPrice } from '@/lib/formatters'
import { playSound } from '@/lib/sounds'
import { PAYMENT_METHODS, PRICE_LEVELS, PRICE_LEVEL_LABELS, type CustomerStatement, type CustomerWithStats, type PaymentMethod, type PriceLevel } from '@/types'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ErrorBanner, PageHeader, SuccessBanner } from '@/components/feedback'
import { cn } from '@/lib/utils'

// price_level 为空字符串 = 零售默认（不设档）
const EMPTY_FORM: { name: string; phone: string; notes: string; price_level: PriceLevel | '' } = {
  name: '',
  phone: '',
  notes: '',
  price_level: '',
}

function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

/** 欠款列：欠钱红字大字；不欠钱灰色；多还了（预收）绿色 */
function OutstandingCell({ outstanding }: { outstanding: number }) {
  if (outstanding > 0) {
    return <span className="text-lg font-bold tabular-nums text-red-600">{formatPrice(outstanding)}</span>
  }
  if (outstanding < 0) {
    return <span className="tabular-nums text-emerald-600">预收 {formatPrice(-outstanding)}</span>
  }
  return <span className="text-slate-400">不欠钱</span>
}

export function CustomersPage() {
  const customers = useAppStore((s) => s.customers)
  const loadCustomers = useAppStore((s) => s.loadCustomers)
  const addCustomer = useAppStore((s) => s.addCustomer)
  const updateCustomer = useAppStore((s) => s.updateCustomer)
  const deleteCustomer = useAppStore((s) => s.deleteCustomer)
  const recordPayment = useAppStore((s) => s.recordPayment)
  const customerStatement = useAppStore((s) => s.customerStatement)

  const [success, setSuccess] = useState('')
  const [pageError, setPageError] = useState('')

  // 新增/编辑客户
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  // 删除确认
  const [deleting, setDeleting] = useState<CustomerWithStats | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  // 客户详情（对账单）
  const [detail, setDetail] = useState<CustomerWithStats | null>(null)
  const [statement, setStatement] = useState<CustomerStatement | null>(null)
  const [statementLoading, setStatementLoading] = useState(false)

  // 还账
  const [payOpen, setPayOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('现金')
  const [payBusy, setPayBusy] = useState(false)
  const [payError, setPayError] = useState('')

  // Electron 环境 loadAll 不含客户，进页面先拉一次（mock 路径本地重算）
  useEffect(() => {
    void loadCustomers().catch((e) =>
      setPageError(`客户列表加载失败：${e instanceof Error ? e.message : String(e)}`),
    )
  }, [loadCustomers])

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 讨债清单：欠钱的排最前，按欠款从多到少
  const sorted = useMemo(() => [...customers].sort((a, b) => b.outstanding - a.outstanding), [customers])
  const debtors = sorted.filter((c) => c.outstanding > 0)
  const totalOwed = debtors.reduce((s, c) => s + c.outstanding, 0)

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (c: CustomerWithStats) => {
    setEditingId(c.id)
    setForm({ name: c.name, phone: c.phone ?? '', notes: c.notes ?? '', price_level: c.price_level ?? '' })
    setFormError('')
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (saving) return
    if (!form.name.trim()) {
      setFormError('客户姓名不能为空')
      return
    }
    setSaving(true)
    try {
      const payload = { name: form.name, phone: form.phone, notes: form.notes, price_level: form.price_level || null }
      if (editingId === null) await addCustomer(payload)
      else await updateCustomer(editingId, payload)
      setFormOpen(false)
      playSound('success')
      setSuccess(editingId === null ? `已新增客户「${form.name.trim()}」` : `已保存「${form.name.trim()}」的修改`)
    } catch (e) {
      setFormOpen(false)
      playSound('error')
      setPageError(`保存客户失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await deleteCustomer(deleting.id)
      playSound('success')
      setSuccess(`已删除客户「${deleting.name}」`)
      setDeleting(null)
    } catch (e) {
      // 有流水/还款记录会被拒，把后端原因原样亮出来
      setDeleting(null)
      playSound('error')
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleteBusy(false)
    }
  }

  const refreshStatement = async (customerId: number) => {
    setStatementLoading(true)
    try {
      setStatement(await customerStatement(customerId))
    } catch (e) {
      setPageError(`对账单加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setStatementLoading(false)
    }
  }

  const openDetail = (c: CustomerWithStats) => {
    setDetail(c)
    setStatement(null)
    void refreshStatement(c.id)
  }

  const openPay = () => {
    if (!detail) return
    // 默认填当前欠款（欠 0 或预收时留空让老板自己填）
    setPayAmount(detail.outstanding > 0 ? (detail.outstanding / 100).toFixed(2) : '')
    setPayMethod('现金')
    setPayError('')
    setPayOpen(true)
  }

  const handlePay = async () => {
    if (!detail || payBusy) return
    const amount = yuanToCents(payAmount)
    if (amount === null || amount <= 0) {
      setPayError('请填写还款金额（必须大于 0 元）')
      return
    }
    setPayBusy(true)
    try {
      const r = await recordPayment({ customerId: detail.id, amount, method: payMethod })
      setPayOpen(false)
      playSound('success')
      if (r.outstanding > 0) {
        setSuccess(`已记还账：${detail.name} 还了 ${formatPrice(amount)}，还欠 ${formatPrice(r.outstanding)}`)
      } else if (r.outstanding === 0) {
        setSuccess(`账清了：${detail.name} 欠的钱全部还清`)
      } else {
        setSuccess(`${detail.name} 还多了，预收 ${formatPrice(-r.outstanding)}（下次拿货抵）`)
      }
      void refreshStatement(detail.id)
    } catch (e) {
      playSound('error')
      setPayError(`还账失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPayBusy(false)
    }
  }

  // 详情弹窗里的客户用最新的 store 数据（还账后欠款即时刷新）
  const detailFresh = detail ? (customers.find((c) => c.id === detail.id) ?? detail) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="客户"
        subtitle="谁欠我钱，一眼看清；点客户名字看对账单、记还账"
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            新增客户
          </Button>
        }
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {pageError && <ErrorBanner>{pageError}</ErrorBanner>}

      {debtors.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-3 text-[15px] text-red-700">
          有 <span className="font-bold">{debtors.length}</span> 人欠钱，合计欠{' '}
          <span className="text-lg font-bold tabular-nums">{formatPrice(totalOwed)}</span>
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          {sorted.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Users className="mx-auto mb-3 size-8 text-slate-300" />
              还没有客户，点右上角「新增客户」建一个；赊账卖货时就能记到他名下
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead>电话</TableHead>
                  <TableHead className="text-right">欠的钱</TableHead>
                  <TableHead>最近交易</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => openDetail(c)}>
                    <TableCell>
                      <button className="font-medium text-sky-700 hover:underline cursor-pointer">
                        {c.name}
                      </button>
                      {c.notes && <div className="text-xs text-muted-foreground">{c.notes}</div>}
                    </TableCell>
                    <TableCell>{c.phone ?? '-'}</TableCell>
                    <TableCell className="text-right">
                      <OutstandingCell outstanding={c.outstanding} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.last_deal_at ? formatDateTime(c.last_deal_at) : '没有交易'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                        <Button variant="outline" size="sm" onClick={() => openEdit(c)}>
                          <Pencil className="size-3" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => setDeleting(c)}
                        >
                          <Trash2 className="size-3" />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新增/编辑客户 Dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId === null ? '新增客户' : '编辑客户'}</DialogTitle>
            <DialogDescription>带 * 为必填项</DialogDescription>
          </DialogHeader>
          {formError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>姓名 *</Label>
              <Input
                autoFocus
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="比如：老王"
              />
            </div>
            <div className="space-y-1">
              <Label>电话</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="方便催账时联系"
              />
            </div>
            {/* 默认价格档：选了他来买货自动按这个价，伙计不用手动输价 */}
            <div className="space-y-2">
              <Label>默认价格档</Label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, price_level: '' })}
                  className={cn(
                    'h-12 cursor-pointer rounded-xl border text-base font-medium transition-colors',
                    form.price_level === ''
                      ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  )}
                >
                  零售
                </button>
                {PRICE_LEVELS.filter((l) => l !== 'retail').map((l) => (
                  <button
                    type="button"
                    key={l}
                    onClick={() => setForm({ ...form, price_level: l })}
                    className={cn(
                      'h-12 cursor-pointer rounded-xl border text-base font-medium transition-colors',
                      form.price_level === l
                        ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                    )}
                  >
                    {PRICE_LEVEL_LABELS[l]}
                  </button>
                ))}
              </div>
              <div className="text-xs text-muted-foreground">
                选了他来买货自动按这个价（商品设了这档价才生效，没设就按建议价），卖货时还能临时改
              </div>
            </div>
            <div className="space-y-1">
              <Label>备注</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="比如：老钓友，月底结账..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 Dialog */}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除客户</DialogTitle>
            <DialogDescription>
              确定要删掉客户「{deleting?.name}」吗？这个操作找不回来。
              如果他有过买卖或还账记录，系统会拒绝删除，免得赊账历史对不上。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteBusy}>
              {deleteBusy && <Loader2 className="size-4 animate-spin" />}
              {deleteBusy ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 客户详情（对账单）Dialog */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              {detailFresh?.name}
              {detailFresh?.phone && (
                <span className="text-sm font-normal text-muted-foreground">{detailFresh.phone}</span>
              )}
            </DialogTitle>
            <DialogDescription>他名下的每一笔赊账和还账都在这儿</DialogDescription>
          </DialogHeader>

          {detailFresh && (
            <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-5 py-4">
              <div>
                <div className="text-sm text-slate-500">当前欠的钱</div>
                <div
                  className={cn(
                    'text-3xl font-bold tabular-nums',
                    detailFresh.outstanding > 0
                      ? 'text-red-600'
                      : detailFresh.outstanding < 0
                        ? 'text-emerald-600'
                        : 'text-slate-400',
                  )}
                >
                  {detailFresh.outstanding > 0
                    ? formatPrice(detailFresh.outstanding)
                    : detailFresh.outstanding < 0
                      ? `预收 ${formatPrice(-detailFresh.outstanding)}`
                      : '不欠钱'}
                </div>
              </div>
              <Button size="lg" className="h-12 px-6 text-base" onClick={openPay}>
                <HandCoins className="size-5" />
                还账
              </Button>
            </div>
          )}

          {statementLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在翻账本...
            </div>
          )}

          {!statementLoading && statement && (
            <div className="max-h-[46vh] space-y-5 overflow-y-auto pr-1">
              <div>
                <div className="mb-2 text-sm font-medium text-slate-700">
                  拿货明细（共 {statement.sales.length} 笔）
                </div>
                {statement.sales.length === 0 ? (
                  <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    还没有拿过货
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>时间</TableHead>
                        <TableHead>商品</TableHead>
                        <TableHead className="text-right">数量</TableHead>
                        <TableHead className="text-right">应付</TableHead>
                        <TableHead className="text-right">已付</TableHead>
                        <TableHead className="text-right">欠</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statement.sales.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="whitespace-nowrap">{formatDateTime(s.timestamp)}</TableCell>
                          <TableCell>
                            {s.product_name}
                            {s.type === 'return' && (
                              <Badge variant="destructive" className="ml-2">退货</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {s.type === 'return' ? `-${s.quantity}` : s.quantity}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatPrice(s.due)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {s.type === 'return' ? '-' : formatPrice(s.paid)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right font-medium tabular-nums',
                              s.owed > 0 ? 'text-red-600' : s.owed < 0 ? 'text-emerald-600' : 'text-slate-400',
                            )}
                          >
                            {s.owed > 0 ? formatPrice(s.owed) : s.owed < 0 ? `少欠 ${formatPrice(-s.owed)}` : '付清'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              <div>
                <div className="mb-2 text-sm font-medium text-slate-700">
                  还账记录（共 {statement.payments.length} 笔，累计还了 {formatPrice(statement.total_paid_back)}）
                </div>
                {statement.payments.length === 0 ? (
                  <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                    还没有还过钱
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>时间</TableHead>
                        <TableHead className="text-right">金额</TableHead>
                        <TableHead>方式</TableHead>
                        <TableHead>备注</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statement.payments.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="whitespace-nowrap">{formatDateTime(p.created_at)}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums text-emerald-700">
                            {formatPrice(p.amount)}
                          </TableCell>
                          <TableCell>{p.method}</TableCell>
                          <TableCell className="text-muted-foreground">{p.notes ?? '-'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 还账 Dialog：大金额输入 + 四个大按钮选方式 */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detailFresh?.name} 还账</DialogTitle>
            <DialogDescription>
              {detailFresh && detailFresh.outstanding > 0
                ? `他目前还欠 ${formatPrice(detailFresh.outstanding)}，可以全还也可以先还一部分`
                : '可以记一笔还款，多还的钱算预收，下次拿货抵'}
            </DialogDescription>
          </DialogHeader>
          {payError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {payError}
            </div>
          )}
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>还了多少钱（元）*</Label>
              <Input
                autoFocus
                type="number"
                min={0}
                step="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                className="h-14 text-2xl font-bold tabular-nums"
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1">
              <Label>怎么给的</Label>
              <div className="grid grid-cols-4 gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m}
                    onClick={() => setPayMethod(m)}
                    className={cn(
                      'h-12 cursor-pointer rounded-xl border text-base font-medium transition-colors',
                      payMethod === m
                        ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayOpen(false)} disabled={payBusy}>
              取消
            </Button>
            <Button size="lg" onClick={handlePay} disabled={payBusy}>
              {payBusy && <Loader2 className="size-4 animate-spin" />}
              {payBusy ? '记账中...' : '记上'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
