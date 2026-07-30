import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import {
  Box,
  Package,
  PackagePlus,
  PackageMinus,
  ClipboardList,
  TriangleAlert,
  Snail,
  CircleDollarSign,
  Truck,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useAppStore } from '@/store/appStore'
import { formatPrice, formatTime, isToday, productName } from '@/lib/formatters'
import { useCountUp } from '@/lib/useCountUp'
import { backend } from '@/lib/api'
import { Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AiPanel } from '@/components/ai/AiPanel'

// 图表统一品牌深蓝系：主色 brand-600 起，同色系深浅递进，末尾两格留灰给"其他"
const PIE_COLORS = ['#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#0ea5e9', '#38bdf8', '#1e40af', '#818cf8', '#94a3b8']
const LOW_STOCK_THRESHOLD = 5
const SLOW_DAYS = 90

function dayLabel(offset: number): string {
  const d = new Date()
  d.setDate(d.getDate() - offset)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function sameDay(iso: string, offset: number): boolean {
  const d = new Date(iso)
  const target = new Date()
  target.setDate(target.getDate() - offset)
  return (
    d.getFullYear() === target.getFullYear() &&
    d.getMonth() === target.getMonth() &&
    d.getDate() === target.getDate()
  )
}

interface CardSpec {
  title: string
  value: number
  format: (v: number) => string
  unit: string
  icon: typeof Box
  cardClass: string
  iconClass: string
  numClass: string
  pulse?: boolean
  /** 点击跳转/动作：预警卡片必须能点进去处理，否则预警形同虚设 */
  action?: () => void
  actionHint?: string
  /** 主打卡片：占两列、数字更大（库存总值） */
  featured?: boolean
}

function StatCard({ spec, index }: { spec: CardSpec; index: number }) {
  const animated = useCountUp(spec.value)
  const Icon = spec.icon
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05, ease: 'easeOut' }}
      whileHover={{ y: -3 }}
      className={spec.featured ? 'col-span-2' : ''}
    >
      <Card
        onClick={spec.action}
        onKeyDown={
          spec.action
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  spec.action!()
                }
              }
            : undefined
        }
        role={spec.action ? 'button' : undefined}
        tabIndex={spec.action ? 0 : undefined}
        className={`h-full border-0 shadow-card transition-shadow hover:shadow-card-hover ${spec.cardClass} ${
          spec.pulse ? 'animate-pulse' : ''
        } ${spec.action ? 'cursor-pointer focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none' : ''}`}
      >
        <CardContent className={spec.featured ? 'flex h-full items-center gap-5 pt-6' : 'pt-6'}>
          <div className={`inline-flex rounded-full p-2.5 ${spec.iconClass} ${spec.featured ? 'mb-0 p-3.5' : 'mb-3'}`}>
            <Icon className={spec.featured ? 'size-7' : 'size-5'} />
          </div>
          <div>
            <div className={`text-xs ${spec.featured ? 'text-white/70' : 'text-slate-500'}`}>{spec.title}</div>
            <div
              className={`font-bold leading-tight tabular-nums ${spec.numClass} ${
                spec.featured ? 'text-[36px]' : 'text-[28px]'
              }`}
            >
              {spec.format(animated)}
            </div>
            <div className={`text-xs ${spec.featured ? 'text-white/60' : 'text-slate-400'}`}>
              {spec.unit}
              {spec.actionHint && (
                <span className={spec.featured ? 'ml-1 text-white/80' : 'ml-1 text-brand-500'}>
                  {spec.actionHint} →
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

export function DashboardPage() {
  const products = useAppStore((s) => s.products)
  const batches = useAppStore((s) => s.batches)
  const transactions = useAppStore((s) => s.transactions)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const purchaseOrders = useAppStore((s) => s.purchaseOrders)
  const loadPurchaseOrders = useAppStore((s) => s.loadPurchaseOrders)
  const navigate = useNavigate()

  // 待收采购单提醒需要订单列表（loadAll 不含采购单），进仪表盘拉一次
  useEffect(() => {
    void loadPurchaseOrders().catch(() => {})
  }, [loadPurchaseOrders])

  const pendingPOCount = useMemo(
    () => purchaseOrders.filter((o) => o.status === 'sent' || o.status === 'partial').length,
    [purchaseOrders],
  )

  const stats = useMemo(() => {
    const totalStock = batches.reduce((s, b) => s + b.quantity, 0)
    const todayIn = transactions
      .filter((t) => t.type === 'in' && isToday(t.timestamp))
      .reduce((s, t) => s + t.quantity, 0)
    const todayOut = transactions
      .filter((t) => t.type === 'out' && isToday(t.timestamp))
      .reduce((s, t) => s + t.quantity, 0)
    const pendingCount = products.filter((p) => p.status === '待盘点').length
    const lowStockCount = products.filter((p) => totalStockOf(p.id) < LOW_STOCK_THRESHOLD).length
    // 滞销：有库存但最近 90 天没有出库记录
    const slowCount = products.filter((p) => {
      if (totalStockOf(p.id) <= 0) return false
      const lastOut = transactions
        .filter((t) => t.type === 'out' && t.product_id === p.id)
        .map((t) => new Date(t.timestamp).getTime())
        .reduce((m, t) => Math.max(m, t), 0)
      const cutoff = Date.now() - SLOW_DAYS * 24 * 3600 * 1000
      return lastOut < cutoff
    }).length
    const stockValue = batches.reduce((s, b) => s + b.quantity * b.cost_price, 0)
    return { totalStock, todayIn, todayOut, pendingCount, lowStockCount, slowCount, stockValue }
  }, [products, batches, transactions, totalStockOf])

  // 今日经营小结：营业额/毛利按出库流水核算（selling_price=售价，unit_price=批次成本）；
  // 退货（不含换货退旧腿）按负收入冲减营业额和毛利——账要和抽屉里的钱对上
  const todaySales = useMemo(() => {
    const outs = transactions
      .filter((t) => t.type === 'out' && isToday(t.timestamp))
      .map((t) => {
        const p = products.find((x) => x.id === t.product_id)
        const revenue = t.selling_price != null ? t.selling_price * t.quantity : null
        const cost = t.unit_price != null ? t.unit_price * t.quantity : null
        return {
          id: t.id,
          kind: 'sale' as const,
          time: t.timestamp,
          name: p ? productName(p) : `#${t.product_id}`,
          sku: p?.sku_code ?? '',
          quantity: t.quantity,
          revenue,
          cost,
          profit: revenue !== null && cost !== null ? revenue - cost : null,
        }
      })
    const returns = transactions
      .filter((t) => t.type === 'return' && t.notes !== '换货退旧' && isToday(t.timestamp))
      .map((t) => {
        const p = products.find((x) => x.id === t.product_id)
        const refund = t.selling_price != null ? t.selling_price * t.quantity : null
        const cost = t.unit_price != null ? t.unit_price * t.quantity : null
        return {
          id: t.id,
          kind: 'return' as const,
          time: t.timestamp,
          name: p ? productName(p) : `#${t.product_id}`,
          sku: p?.sku_code ?? '',
          quantity: -t.quantity,
          revenue: refund !== null ? -refund : null,
          cost: cost !== null ? -cost : null,
          profit: refund !== null && cost !== null ? -(refund - cost) : null,
        }
      })
    const rows = [...outs, ...returns].sort((a, b) => b.time.localeCompare(a.time))
    const qty = outs.reduce((s, r) => s + r.quantity, 0)
    const revenue = rows.reduce((s, r) => s + (r.revenue ?? 0), 0)
    const profit = rows.reduce((s, r) => s + (r.profit ?? 0), 0)
    const margin = revenue > 0 ? profit / revenue : null
    return { rows, outs, qty, revenue, profit, margin }
  }, [transactions, products])

  // AI 一句话打烊日报：仅在已配置 Key 且有成交时请求；失败静默隐藏，数字报表兜底
  const [aiConfigured, setAiConfigured] = useState(false)
  const [aiText, setAiText] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)

  useEffect(() => {
    if (!backend) return
    backend
      .invoke('ai:status')
      .then((s) => setAiConfigured(!!s?.configured))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!backend || !aiConfigured || todaySales.outs.length === 0) return
    // 卖得最好的前 3 个（按件数）
    const byName = new Map<string, number>()
    for (const r of todaySales.outs) byName.set(r.name, (byName.get(r.name) ?? 0) + r.quantity)
    const topItems = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, quantity]) => ({ name, quantity }))
    // 库存告急的前 3 个
    const lowStock = products
      .filter((p) => p.status !== '停产')
      .map((p) => ({ name: productName(p), total: totalStockOf(p.id) }))
      .filter((x) => x.total < LOW_STOCK_THRESHOLD)
      .sort((a, b) => a.total - b.total)
      .slice(0, 3)
    setAiLoading(true)
    backend
      .invoke('ai:dailySummary', {
        stats: {
          date: new Date().toISOString().slice(0, 10),
          qty: todaySales.qty,
          revenue: todaySales.revenue,
          profit: todaySales.profit,
          topItems,
          lowStock,
        },
      })
      .then((r) => setAiText(r?.ok ? r.content : null))
      .catch(() => setAiText(null))
      .finally(() => setAiLoading(false))
  }, [aiConfigured, todaySales.qty, todaySales.revenue]) // eslint-disable-line react-hooks/exhaustive-deps

  const categoryData = useMemo(() => {
    const byCat = new Map<string, number>()
    for (const b of batches) {
      if (b.quantity <= 0) continue
      const p = products.find((x) => x.id === b.product_id)
      if (!p) continue
      byCat.set(p.category, (byCat.get(p.category) ?? 0) + b.quantity)
    }
    return [...byCat.entries()].map(([name, value]) => ({ name, value }))
  }, [products, batches])

  const trendData = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const offset = 6 - i
      const inQty = transactions
        .filter((t) => t.type === 'in' && sameDay(t.timestamp, offset))
        .reduce((s, t) => s + t.quantity, 0)
      const outQty = transactions
        .filter((t) => t.type === 'out' && sameDay(t.timestamp, offset))
        .reduce((s, t) => s + t.quantity, 0)
      return { day: dayLabel(offset), 入库: inQty, 出库: outQty }
    })
  }, [transactions])

  const int = (v: number) => String(Math.round(v))
  const cards: CardSpec[] = [
    { title: '总SKU', value: products.length, format: int, unit: '个商品', icon: Box,
      cardClass: 'bg-brand-50', iconClass: 'bg-brand-100 text-brand-600', numClass: 'text-brand-600',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '总库存', value: stats.totalStock, format: (v) => Math.round(v).toLocaleString(), unit: '件商品', icon: Package,
      cardClass: 'bg-green-50', iconClass: 'bg-green-100 text-green-600', numClass: 'text-green-600',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '今日入库', value: stats.todayIn, format: (v) => `+${Math.round(v)}`, unit: '件入库', icon: PackagePlus,
      cardClass: 'bg-purple-50', iconClass: 'bg-purple-100 text-purple-600', numClass: 'text-purple-600',
      action: () => navigate('/inbound'), actionHint: '去入库' },
    { title: '今日出库', value: stats.todayOut, format: (v) => `-${Math.round(v)}`, unit: '件出库', icon: PackageMinus,
      cardClass: 'bg-orange-50', iconClass: 'bg-orange-100 text-orange-600', numClass: 'text-orange-600',
      action: () => navigate('/outbound'), actionHint: '去出库' },
    { title: '待盘点', value: stats.pendingCount, format: int, unit: '个SKU', icon: ClipboardList,
      cardClass: 'bg-yellow-50', iconClass: 'bg-yellow-100 text-yellow-600', numClass: 'text-yellow-600',
      action: () => navigate('/inventory?status=' + encodeURIComponent('待盘点')), actionHint: '去处理' },
    { title: '低库存', value: stats.lowStockCount, format: int, unit: '个预警', icon: TriangleAlert,
      cardClass: 'bg-red-50', iconClass: 'bg-red-100 text-red-600', numClass: 'text-red-600',
      pulse: stats.lowStockCount > 0,
      action: () => navigate('/inventory?filter=low'), actionHint: '去补货' },
    { title: '滞销品', value: stats.slowCount, format: int, unit: `>${SLOW_DAYS}天未动销`, icon: Snail,
      cardClass: 'bg-slate-100', iconClass: 'bg-slate-200 text-slate-500', numClass: 'text-slate-500',
      action: () => navigate('/inventory'), actionHint: '查看' },
    { title: '库存总值', value: stats.stockValue, format: (v) => formatPrice(Math.round(v)), unit: '按批次进价核算', icon: CircleDollarSign,
      cardClass: 'bg-brand-700', iconClass: 'bg-white/15 text-white', numClass: 'text-white', featured: true,
      action: () => navigate('/inventory'), actionHint: '查看' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">仪表盘</h1>
        <p className="mt-1 text-[13px] text-slate-500">门店经营概览，数据实时来自库存与流水</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((spec, i) => (
          <StatCard key={spec.title} spec={spec} index={i} />
        ))}
      </div>

      {/* 有待收货的采购单时提醒一句，点一下跳到采购页收货 */}
      {pendingPOCount > 0 && (
        <Link
          to="/purchase"
          className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-3.5 text-sm text-amber-800 transition-colors hover:bg-amber-100"
        >
          <Truck className="size-5 shrink-0" />
          <span>
            有 <span className="font-bold">{pendingPOCount}</span> 张采购单待收货，货到了别忘了点「收货入库」
          </span>
          <span className="ml-auto font-medium">去收货 →</span>
        </Link>
      )}

      {/* 今日经营小结：打烊前看一眼，今天赚了多少 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">今日经营小结</CardTitle>
          <Link
            to="/outbound"
            className="text-xs font-normal text-brand-600 hover:underline"
          >
            查看全部 →
          </Link>
        </CardHeader>
        <CardContent className="space-y-4">
          {todaySales.rows.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              今天还没开单，第一单卖出去后这里会实时算出营业额和毛利
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div className="rounded-xl bg-slate-50 px-4 py-3">
                  <div className="text-xs text-slate-500">今日营业额</div>
                  <div className="text-xl font-bold text-slate-800 tabular-nums">
                    {formatPrice(todaySales.revenue)}
                  </div>
                </div>
                <div className="rounded-xl bg-green-50 px-4 py-3">
                  <div className="text-xs text-green-600">今日毛利</div>
                  <div className="text-xl font-bold text-green-700 tabular-nums">
                    {formatPrice(todaySales.profit)}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-50 px-4 py-3">
                  <div className="text-xs text-slate-500">毛利率</div>
                  <div className="text-xl font-bold text-slate-800 tabular-nums">
                    {todaySales.margin !== null ? `${(todaySales.margin * 100).toFixed(1)}%` : '-'}
                  </div>
                </div>
                <div className="rounded-xl bg-slate-50 px-4 py-3">
                  <div className="text-xs text-slate-500">售出件数</div>
                  <div className="text-xl font-bold text-slate-800 tabular-nums">
                    {todaySales.qty}
                  </div>
                </div>
              </div>
              {/* AI 一句话打烊日报（已激活且生成成功才显示，失败静默） */}
              {(aiLoading || aiText) && (
                <div className="flex items-start gap-3 rounded-xl bg-gradient-to-r from-brand-700 to-brand-600 px-5 py-4 text-white shadow-card">
                  <Sparkles className="mt-0.5 size-5 shrink-0 text-amber-300" />
                  <div>
                    <div className="text-xs text-white/70">AI 打烊日报 · 由 Kimi 生成</div>
                    <div className="mt-1 text-[15px] leading-relaxed">
                      {aiLoading ? 'AI 正在算今天的账…' : aiText}
                    </div>
                  </div>
                </div>
              )}
              {todaySales.rows.length > 6 && (
                <div className="text-xs text-muted-foreground">
                  共 {todaySales.rows.length} 条出入账记录，表格内下滑查看全部
                </div>
              )}
              <div className="max-h-80 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">时间</TableHead>
                      <TableHead>商品</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead className="text-right">营业额</TableHead>
                      <TableHead className="text-right">毛利</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {todaySales.rows.map((r) => (
                      <TableRow key={`${r.kind}-${r.id}`} className={r.kind === 'return' ? 'bg-red-50/60' : ''}>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatTime(r.time)}
                        </TableCell>
                        <TableCell>
                          {r.kind === 'return' && (
                            <span className="mr-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">
                              退货
                            </span>
                          )}
                          <span className="mr-2">{r.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{r.sku}</span>
                        </TableCell>
                        <TableCell
                          className={`text-right ${r.kind === 'return' ? 'text-red-600' : ''}`}
                        >
                          {r.quantity}
                        </TableCell>
                        <TableCell
                          className={`text-right tabular-nums ${r.kind === 'return' ? 'text-red-600' : ''}`}
                        >
                          {r.revenue !== null ? formatPrice(r.revenue) : '-'}
                        </TableCell>
                        <TableCell
                          className={`text-right font-medium tabular-nums ${
                            r.profit !== null && r.profit < 0 ? 'text-red-600' : 'text-green-700'
                          }`}
                        >
                          {r.profit !== null ? formatPrice(r.profit) : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* AI 问答面板：仅已激活时渲染（组件自检） */}
      <AiPanel />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">品类库存占比</CardTitle>
          </CardHeader>
          <CardContent>
            {categoryData.length === 0 ? (
              <div className="py-16 text-center text-sm text-muted-foreground">暂无库存数据</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={categoryData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={95}
                    paddingAngle={2}
                  >
                    {categoryData.map((entry, i) => (
                      <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, name) => [`${v} 件`, name]} />
                  <Legend layout="vertical" align="right" verticalAlign="middle" />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">最近 7 天出入库趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={trendData}>
                <XAxis dataKey="day" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis fontSize={10} allowDecimals={false} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(37, 99, 235, 0.06)' }} />
                <Legend />
                <Bar dataKey="入库" fill="#1d4ed8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="出库" fill="#7aa5f8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
