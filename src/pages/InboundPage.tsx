import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Camera, Loader2, PackagePlus, CheckCircle2, CircleAlert, Sparkles } from 'lucide-react'
import { PageHeader, SuccessBanner, ErrorBanner } from '@/components/feedback'
import { ScanHero } from '@/components/scan/ScanHero'
import { useAppStore } from '@/store/appStore'
import { formatPrice, formatTime, isToday, productName } from '@/lib/formatters'
import { backend } from '@/lib/api'
import { playSound } from '@/lib/sounds'
import { useOnline } from '@/lib/useOnline'
import { CATEGORIES, type Category, type Product } from '@/types'
import {
  SPEC_FIELDS, SPEC_LABELS, SPEC_PLACEHOLDERS, specFieldsFor,
  type SpecField,
} from '@/lib/productSpecs'
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

const NO_SUPPLIER = '__none__'

// 品牌预选列表（常见渔具品牌），"自定义"选项触发自由输入
const BRAND_PRESETS = [
  '__custom__', '光威', '汉鼎', '化氏', '天元', '宝飞龙', '名伦', '开沃',
  '达亿瓦', '禧玛诺', '伽玛卡兹', '钓鱼王', '佳钓尼', '狼王', '海伯',
  '阿布加西亚', '美人鱼', '大力马', 'YGK', '东丽', '龙王恨', '老鬼',
  '西部风', '丸九', '土肥富', '欧娜', '慕斯达', '千秋', 'BKK',
  'Megabass', '连球', '阿卢', 'Shimano', 'Abu Garcia',
]

// 元字符串转分，非法输入返回 null
function yuanToCents(v: string): number | null {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n) || n < 0) return null
  return Math.round(n * 100)
}

// 规格表单初始状态：8 个字段全空串
function emptySpecs(): Record<SpecField, string> {
  return Object.fromEntries(SPEC_FIELDS.map((f) => [f, ''])) as Record<SpecField, string>
}

// 拍照压缩：最长边 1280px、JPEG 0.85，控制发给视觉模型的体积
async function compressImage(file: File): Promise<{ base64: string; mime: string }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return { base64: dataUrl.split(',')[1] ?? '', mime: 'image/jpeg' }
}

interface PhotoDraftItem {
  key: number
  product_id: number | null // null = 新商品，确认时自动建档
  brand: string | null
  model: string | null
  category: string
  quantity: number
  costYuan: string // 可编辑，元
}

export function InboundPage() {
  const findProductByBarcode = useAppStore((s) => s.findProductByBarcode)
  const totalStockOf = useAppStore((s) => s.totalStockOf)
  const lastCostOf = useAppStore((s) => s.lastCostOf)
  const addInbound = useAppStore((s) => s.addInbound)
  const addProduct = useAppStore((s) => s.addProduct)
  const suppliers = useAppStore((s) => s.suppliers)
  const transactions = useAppStore((s) => s.transactions)
  const batches = useAppStore((s) => s.batches)
  const products = useAppStore((s) => s.products)

  const inputRef = useRef<HTMLInputElement>(null)
  const [barcode, setBarcode] = useState('')
  const [matched, setMatched] = useState<Product | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  // P0-1：所有写库按钮统一防重复 + 失败兜底
  const [submitting, setSubmitting] = useState(false)

  // 入库表单
  const [quantity, setQuantity] = useState('1')
  const [costYuan, setCostYuan] = useState('')
  const [location, setLocation] = useState('')
  const [supplierId, setSupplierId] = useState(NO_SUPPLIER)
  const [operator, setOperator] = useState('阿杜')

  // 新建商品 Dialog
  const [dialogOpen, setDialogOpen] = useState(false)
  const [npCategory, setNpCategory] = useState<Category>('其他')
  const [npSubCategory, setNpSubCategory] = useState('')
  const [npBrand, setNpBrand] = useState('')
  const [npBrandCustom, setNpBrandCustom] = useState('')
  const [npModel, setNpModel] = useState('')
  const [npCostYuan, setNpCostYuan] = useState('')
  const [npSuggestYuan, setNpSuggestYuan] = useState('')
  const [npLocation, setNpLocation] = useState('')
  // 安全库存：空串=不单独设，按默认 5 预警（饵料/鱼钩这类消耗快的老板自己调大）
  const [npMinStock, setNpMinStock] = useState('')
  // 渔具规格（按品类出不同字段，全部选填）
  const [npSpecs, setNpSpecs] = useState<Record<SpecField, string>>(emptySpecs)

  // 拍送货单（AI 多模态识别 → 入库草稿，人工逐行核对后落库）
  const [aiEnabled, setAiEnabled] = useState(false)
  const [photoParsing, setPhotoParsing] = useState(false)
  const [photoDraft, setPhotoDraft] = useState<PhotoDraftItem[] | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)
  // AI 识别需要联网，离线时按钮置灰
  const online = useOnline()

  useEffect(() => {
    if (!backend) return
    backend
      .invoke('ai:status')
      .then((s) => setAiEnabled(!!s?.configured))
      .catch(() => {})
  }, [])

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  const focusInput = () => inputRef.current?.focus()

  const prefillForm = (p: Product) => {
    const last = lastCostOf(p.id)
    setQuantity('1')
    setCostYuan(last !== null ? (last / 100).toFixed(2) : '')
    setLocation(p.location ?? '')
    setSupplierId(NO_SUPPLIER)
  }

  const handleSearch = () => {
    const code = barcode.trim()
    setError('')
    if (!code) return
    const p = findProductByBarcode(code)
    if (p) {
      playSound('scan')
      setMatched(p)
      setNotFound(false)
      prefillForm(p)
    } else {
      playSound('error')
      setMatched(null)
      setNotFound(true)
    }
  }

  const handleConfirm = async () => {
    if (!matched || submitting) return
    const qty = Number(quantity)
    if (!Number.isInteger(qty) || qty < 1) {
      setError('入库数量必须是 ≥1 的整数')
      playSound('error')
      return
    }
    const cost = yuanToCents(costYuan)
    if (cost === null) {
      setError('进价格式不正确')
      playSound('error')
      return
    }
    setSubmitting(true)
    try {
      await addInbound({
        productId: matched.id,
        quantity: qty,
        costPrice: cost,
        location: location.trim() || null,
        supplierId: supplierId === NO_SUPPLIER ? null : Number(supplierId),
        operator: operator.trim() || '未署名',
      })
      playSound('success')
      setSuccess(`已入库：${productName(matched)} × ${qty}`)
      setMatched(null)
      setNotFound(false)
      setBarcode('')
      setError('')
      focusInput()
    } catch (e) {
      playSound('error')
      setError(`入库失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = () => {
    setMatched(null)
    setNotFound(false)
    setError('')
    focusInput()
  }

  const handleCreateProduct = async () => {
    if (submitting) return
    const cost = yuanToCents(npCostYuan)
    if (cost === null) {
      setError('新建商品：进价格式不正确')
      return
    }
    const suggest = npSuggestYuan.trim() === '' ? null : yuanToCents(npSuggestYuan)
    if (npSuggestYuan.trim() !== '' && suggest === null) {
      setError('新建商品：建议售价格式不正确')
      return
    }
    // 安全库存：留空=默认 5；填了必须是 ≥0 的整数
    const minStockRaw = npMinStock.trim()
    let minStock: number | null = null
    if (minStockRaw !== '') {
      const n = Number(minStockRaw)
      if (!Number.isInteger(n) || n < 0) {
        setError('新建商品：安全库存要是 0 或更大的整数（不想单独设就留空）')
        return
      }
      minStock = n
    }
    // SKU 留空，由后端（浏览器预览时为 mock 路径）按统一的五段式规则自动生成
    const brand = npBrand === '__custom__'
      ? (npBrandCustom.trim() || null)
      : (npBrand.trim() || null)

    setSubmitting(true)
    try {
      const p = await addProduct({
        sku_code: '',
        barcode: barcode.trim() || null,
        category: npCategory,
        sub_category: npSubCategory.trim() || null,
        brand,
        model: npModel.trim() || null,
        cost_price: cost,
        suggest_price: suggest,
        location: npLocation.trim() || null,
        status: '待盘点',
        min_stock: minStock,
        // 只提交当前品类展示的规格字段，避免切换品类后残留旧值混进来
        ...Object.fromEntries(
          specFieldsFor(npCategory).map((f) => [f, npSpecs[f].trim() || null]),
        ),
      })
      setDialogOpen(false)
      setNotFound(false)
      setMatched(p)
      prefillForm(p)
      setError('')
    } catch (e) {
      setError(`新建商品失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  // 拍送货单：选图 → 压缩 → AI 识别 → 草稿 Dialog
  const handlePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !backend) return
    setPhotoParsing(true)
    setError('')
    try {
      const { base64, mime } = await compressImage(file)
      const r = await backend.invoke('ai:parseInboundNote', { imageBase64: base64, mimeType: mime })
      if (!r?.ok) {
        setError(
          r?.reason === 'no-key'
            ? '请先到设置页填入 Kimi API Key 激活 AI'
            : r?.reason === 'timeout' || r?.reason === 'network'
              ? 'AI 暂时不可用，请检查网络后重试'
              : '没识别出有效内容，换一张更清晰、正对单据的照片试试',
        )
        return
      }
      setPhotoDraft(
        r.items.map((it: any, i: number) => ({
          key: i,
          product_id: it.product_id,
          brand: it.brand,
          model: it.model,
          category: it.category ?? '其他',
          quantity: it.quantity,
          costYuan: it.cost_price_fen ? (it.cost_price_fen / 100).toFixed(2) : '',
        })),
      )
    } catch {
      setError('照片识别失败，请重试')
    } finally {
      setPhotoParsing(false)
    }
  }

  const patchDraftItem = (key: number, patch: Partial<PhotoDraftItem>) =>
    setPhotoDraft((prev) => prev?.map((it) => (it.key === key ? { ...it, ...patch } : it)) ?? null)

  // 确认草稿：已有商品直接入库；新商品先自动建档（SKU 自动生成）再入库
  const confirmPhotoDraft = async () => {
    if (!photoDraft) return
    setPhotoBusy(true)
    setError('')
    let okCount = 0
    const fails: string[] = []
    for (const it of photoDraft) {
      const label = [it.brand, it.model].filter(Boolean).join(' ') || '未命名商品'
      const cost = it.costYuan.trim() ? Math.round(parseFloat(it.costYuan) * 100) : NaN
      if (!Number.isFinite(cost) || cost <= 0) {
        fails.push(`${label}：进价无效`)
        continue
      }
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        fails.push(`${label}：数量无效`)
        continue
      }
      try {
        let pid = it.product_id
        if (!pid) {
          const p = await addProduct({
            sku_code: '',
            barcode: null,
            category: (CATEGORIES as string[]).includes(it.category) ? (it.category as Category) : '其他',
            sub_category: null,
            brand: it.brand,
            model: it.model,
            cost_price: cost,
            suggest_price: null,
            location: null,
            status: '待盘点',
          })
          pid = p.id
        }
        await addInbound({
          productId: pid,
          quantity: it.quantity,
          costPrice: cost,
          location: null,
          supplierId: null,
          operator,
        })
        okCount++
      } catch (err) {
        fails.push(`${label}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setPhotoBusy(false)
    setPhotoDraft(null)
    if (okCount > 0) setSuccess(`已从送货单入库 ${okCount} 项`)
    if (fails.length > 0) setError(fails.join('；'))
  }

  const todayInbounds = transactions.filter((t) => t.type === 'in' && isToday(t.timestamp))

  return (
    <div className="space-y-6">
      <PageHeader
        title="扫码入库"
        subtitle="管理商品入库、新建 SKU 和库存批次"
        action={
          <>
            <Button
              variant="outline"
              onClick={() => photoRef.current?.click()}
              disabled={!aiEnabled || photoParsing || !online}
              title={
                !aiEnabled
                  ? '未配置 AI：请先到「设置」页填入 Kimi API Key'
                  : !online
                    ? '当前离线，AI 识别需要联网'
                    : '拍送货单，AI 自动识别入库'
              }
            >
              {photoParsing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Camera className="size-4" />
              )}
              {photoParsing ? 'AI 识别中...' : '拍送货单'}
            </Button>
            <input
              ref={photoRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhoto}
            />
          </>
        }
      />
      {(!aiEnabled || !online) && (
        <div className="-mt-3 text-xs text-muted-foreground">
          {!aiEnabled
            ? '「拍送货单」需要先配置 AI：到「设置」页填入 Kimi API Key 即可启用'
            : '当前离线：「拍送货单」需要联网，恢复网络后可用'}
        </div>
      )}

      {/* 扫码区：全站使用频率最高的交互点，视觉 C 位 */}
      <ScanHero
        inputRef={inputRef}
        autoFocus
        value={barcode}
        onChange={setBarcode}
        onSubmit={handleSearch}
        placeholder="请扫描商品条码或输入条码号，按下 Enter 确认搜索"
        hint="USB 扫码枪即插即用，扫描后自动回车"
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* 搜索结果：已匹配商品 —— 全站第二重要界面，视觉升舱 */}
      {matched && (
        <Card className="gap-0 overflow-hidden py-0">
          {/* 品牌色顶条：一眼区别于普通卡片 */}
          <div className="h-1.5 bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700" />
          <CardHeader className="pt-5">
            <CardTitle className="flex items-center gap-3 text-lg">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700">
                <CheckCircle2 className="size-3.5" />
                匹配成功
              </span>
              {productName(matched)}
              <span className="text-sm font-normal text-muted-foreground">
                {matched.category}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pb-5">
            {/* 商品信息区：灰底分区，与表单区拉开层级 */}
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 rounded-xl bg-slate-50 px-5 py-4 text-sm text-slate-600 md:grid-cols-4">
              <div>
                <div className="text-xs text-slate-400">SKU</div>
                <div className="font-mono font-medium text-slate-800">{matched.sku_code}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">条码</div>
                <div className="font-mono font-medium text-slate-800">{matched.barcode ?? '-'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">当前库存</div>
                <div className="font-semibold text-brand-600">{totalStockOf(matched.id)} 件</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">最近进价</div>
                <div className="font-semibold text-slate-800">{formatPrice(lastCostOf(matched.id))}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <div className="space-y-1">
                <Label>入库数量 *</Label>
                <Input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>进价（元）*</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={costYuan}
                  onChange={(e) => setCostYuan(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>货位</Label>
                <Input value={location} onChange={(e) => setLocation(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>供应商</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger>
                    <SelectValue placeholder="不指定" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SUPPLIER}>不指定</SelectItem>
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
            {/* 操作区沉底：与信息区分层 */}
            <div className="-mx-6 -mb-5 mt-2 flex gap-3 border-t bg-slate-50/60 px-6 py-4">
              <Button
                asChild
                onClick={handleConfirm}
                disabled={submitting}
                className="bg-brand-600 hover:bg-brand-700"
              >
                <motion.button whileTap={{ scale: 0.96 }}>
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <PackagePlus className="size-4" />
                )}
                {submitting ? '入库中...' : '确认入库'}
                </motion.button>
              </Button>
              <Button variant="outline" onClick={() => setDialogOpen(true)}>
                新建商品
              </Button>
              <Button variant="ghost" onClick={handleCancel}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 搜索结果：未找到 */}
      {notFound && (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="h-1.5 bg-gradient-to-r from-amber-400 to-amber-500" />
          <CardContent className="flex items-center justify-between py-5">
            <div className="flex items-center gap-3 text-sm text-slate-600">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">
                <CircleAlert className="size-3.5" />
                未找到该商品
              </span>
              <span>
                条码 <span className="font-mono font-medium">{barcode.trim()}</span>{' '}
                不在库存中，是否新建？
              </span>
            </div>
            <div className="flex gap-3">
              <Button onClick={() => setDialogOpen(true)}>新建商品</Button>
              <Button variant="ghost" onClick={handleCancel}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 今日入库记录 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">今日入库记录（{todayInbounds.length} 条）</CardTitle>
        </CardHeader>
        <CardContent>
          {todayInbounds.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">今日暂无入库记录</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>品名</TableHead>
                  <TableHead>批次号</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="text-right">进价</TableHead>
                  <TableHead>货位</TableHead>
                  <TableHead>操作人</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {todayInbounds.map((t) => {
                  const p = products.find((x) => x.id === t.product_id)
                  const b = batches.find((x) => x.id === t.batch_id)
                  return (
                    <TableRow key={t.id}>
                      <TableCell>{formatTime(t.timestamp)}</TableCell>
                      <TableCell>
                        {p ? productName(p) : `#${t.product_id}`}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{b?.batch_no ?? '-'}</TableCell>
                      <TableCell className="text-right">{t.quantity}</TableCell>
                      <TableCell className="text-right">{formatPrice(t.unit_price)}</TableCell>
                      <TableCell>{b?.location ?? '-'}</TableCell>
                      <TableCell>{t.operator ?? '-'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新建商品 Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建商品</DialogTitle>
            <DialogDescription>条码 {barcode.trim() || '-'} 将自动关联到新商品</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>品类 *</Label>
              <Select value={npCategory} onValueChange={(v) => setNpCategory(v as Category)}>
                <SelectTrigger>
                  <SelectValue />
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
            <div className="space-y-1">
              <Label>子类</Label>
              <Input
                value={npSubCategory}
                onChange={(e) => setNpSubCategory(e.target.value)}
                placeholder="如：手竿、PE线、伊势尼..."
              />
            </div>
            <div className="space-y-1">
              <Label>品牌</Label>
              <Select value={npBrand} onValueChange={(v) => setNpBrand(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择品牌..." />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {BRAND_PRESETS.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b === '__custom__' ? '+ 自定义品牌' : b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {npBrand === '__custom__' && (
                <Input
                  className="mt-1"
                  value={npBrandCustom}
                  onChange={(e) => setNpBrandCustom(e.target.value)}
                  placeholder="输入自定义品牌名"
                />
              )}
            </div>
            <div className="space-y-1">
              <Label>型号/规格</Label>
              <Input value={npModel} onChange={(e) => setNpModel(e.target.value)} placeholder="如：3.6m 28调" />
            </div>
            <div className="space-y-1">
              <Label>进价（元）*</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={npCostYuan}
                onChange={(e) => setNpCostYuan(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>建议售价（元）</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={npSuggestYuan}
                onChange={(e) => setNpSuggestYuan(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>货位</Label>
              <Input value={npLocation} onChange={(e) => setNpLocation(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>安全库存</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={npMinStock}
                onChange={(e) => setNpMinStock(e.target.value)}
                placeholder="低于这个数就提醒你，默认 5"
              />
            </div>
            {/* 渔具规格：按品类出不同字段，全部选填，不填也能入库 */}
            <div className="col-span-2 space-y-2 border-t pt-3">
              <div className="text-xs text-muted-foreground">
                规格（选填，随品类变化，如味型/备注可写进颜色或型号里）
              </div>
              <div className="grid grid-cols-3 gap-3">
                {specFieldsFor(npCategory).map((f) => (
                  <div key={f} className="space-y-1">
                    <Label>{SPEC_LABELS[f]}</Label>
                    <Input
                      value={npSpecs[f]}
                      onChange={(e) =>
                        setNpSpecs((s) => ({ ...s, [f]: e.target.value }))
                      }
                      placeholder={SPEC_PLACEHOLDERS[f]}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreateProduct} disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {submitting ? '创建中...' : '创建并入库'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 拍送货单识别草稿：人工逐行核对后确认入库 */}
      <Dialog open={photoDraft !== null} onOpenChange={(open) => !open && setPhotoDraft(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-brand-500" />
              送货单识别结果（{photoDraft?.length ?? 0} 项）
            </DialogTitle>
            <DialogDescription>
              AI 识别可能有误，请逐行核对数量和进价。标「新商品」的确认时会自动建档（编号自动生成）。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>商品</TableHead>
                  <TableHead>品类</TableHead>
                  <TableHead className="w-24 text-right">数量</TableHead>
                  <TableHead className="w-32 text-right">进价（元）</TableHead>
                  <TableHead className="w-24">匹配</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {photoDraft?.map((it) => (
                  <TableRow key={it.key}>
                    <TableCell>
                      {[it.brand, it.model].filter(Boolean).join(' ') || (
                        <span className="text-muted-foreground">未识别名称</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{it.category}</TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        min={1}
                        value={it.quantity}
                        onChange={(e) =>
                          patchDraftItem(it.key, { quantity: parseInt(e.target.value, 10) || 0 })
                        }
                        className="h-8 w-20 text-right"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={it.costYuan}
                        onChange={(e) => patchDraftItem(it.key, { costYuan: e.target.value })}
                        placeholder="必填"
                        className="h-8 w-28 text-right"
                      />
                    </TableCell>
                    <TableCell>
                      {it.product_id ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                          已有商品
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                          新商品
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPhotoDraft(null)} disabled={photoBusy}>
              取消
            </Button>
            <Button onClick={confirmPhotoDraft} disabled={photoBusy}>
              {photoBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              {photoBusy ? '入库中...' : `核对无误，确认入库 ${photoDraft?.length ?? 0} 项`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
