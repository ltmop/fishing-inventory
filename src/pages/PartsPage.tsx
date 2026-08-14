import { useEffect, useState } from 'react'
import { CheckSquare, Fish, Link2, Plus, PackageX, Square } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import { productName } from '@/lib/formatters'
import { PageHeader, ErrorBanner, SuccessBanner } from '@/components/feedback'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/EmptyState'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { Product } from '@/types'

interface PartRow {
  id: number
  sku_code: string
  brand: string | null
  model: string | null
  part_type: string | null
  stock: number
  /** 缺货线（v2.2）：每件商品自己的安全库存，NULL=默认 5 */
  min_stock: number | null
}

const PART_TYPES = ['竿梢', '手把节', '中节', '后堵', '其他']
// 没单独设缺货线的配节按默认阈值 5 预警（与全站 LOW_STOCK_THRESHOLD 一致）
const DEFAULT_THRESHOLD = 5

/** 配节管理：主竿-配节关联，断竿梢换节看库存；缺货线每根竿自己定，可批量绑配节 */
export function PartsPage() {
  const products = useAppStore((s) => s.products)
  const updateProduct = useAppStore((s) => s.updateProduct)

  const [parentKw, setParentKw] = useState('')
  const [parentId, setParentId] = useState<number | null>(null)
  const [parent, setParent] = useState<Product | null>(null)
  const [parts, setParts] = useState<PartRow[]>([])

  // 批量绑定：搜索勾选多个商品 + 统一配节类型
  const [addKw, setAddKw] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [partType, setPartType] = useState('竿梢')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  // 行内改缺货线的本地暂存（partId → 输入值）
  const [thresholdDrafts, setThresholdDrafts] = useState<Record<number, string>>({})

  const loadParts = (pid: number) => {
    if (!backend) return
    backend.invoke('part:list', { parentId: pid }).then((r) => r && setParts(r)).catch(() => {})
  }
  useEffect(() => {
    if (parentId) loadParts(parentId)
  }, [parentId]) // eslint-disable-line react-hooks/exhaustive-deps

  const parentMatches = parentKw.trim()
    ? products.filter((p) => [p.sku_code, p.brand, p.model].filter(Boolean).join(' ').toLowerCase().includes(parentKw.trim().toLowerCase())).slice(0, 8)
    : []

  const addMatches = addKw.trim()
    ? products.filter(
        (p) =>
          p.id !== parentId &&
          !selectedIds.has(p.id) &&
          [p.sku_code, p.brand, p.model].filter(Boolean).join(' ').toLowerCase().includes(addKw.trim().toLowerCase()),
      ).slice(0, 12)
    : []

  const handlePickParent = (p: Product) => {
    setParentId(p.id)
    setParent(p)
    setParentKw(productName(p))
    setSelectedIds(new Set())
    setError('')
    setSuccess('')
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleBatchAdd = async () => {
    if (!parentId || selectedIds.size === 0 || busy || !backend) return
    setBusy(true)
    setError('')
    try {
      const partsPayload = [...selectedIds].map((pid) => ({ productId: pid, partType }))
      const r = await backend.invoke('part:setMany', { parentId, parts: partsPayload, operator: '阿东' })
      setSuccess(`已把 ${r?.count ?? partsPayload.length} 个商品设为${productName(parent!)}的${partType}`)
      setSelectedIds(new Set())
      setAddKw('')
      loadParts(parentId)
    } catch (e) {
      setError(`批量设置失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRemovePart = async (p: PartRow) => {
    if (!parentId || busy || !backend) return
    setBusy(true)
    setError('')
    try {
      await backend.invoke('part:set', { productId: p.id, parentId: null, operator: '阿东' })
      setSuccess(`已解除「${[p.brand, p.model].filter(Boolean).join(' ') || p.sku_code}」的配节关系`)
      loadParts(parentId)
    } catch (e) {
      setError(`解除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // 行内改缺货线：输入留本地，失焦/回车才落库（避免每次击键都刷新表格）
  const commitThreshold = async (p: PartRow) => {
    const raw = thresholdDrafts[p.id]?.trim() ?? ''
    let minStock: number | null = null
    if (raw !== '') {
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0) {
        setError('缺货线要是 0 或更大的整数（不想单独设就清空）')
        setThresholdDrafts((d) => ({ ...d, [p.id]: String(p.min_stock ?? '') }))
        return
      }
      minStock = n
    }
    if ((p.min_stock ?? null) === minStock) return
    try {
      await updateProduct(p.id, { min_stock: minStock })
      if (parentId) loadParts(parentId)
    } catch (e) {
      setError(`改缺货线失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="配节管理" subtitle="断竿梢换节是售后刚需——按主竿看各配节库存，缺货线每根竿自己定" />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* 选主竿 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Fish className="size-5 text-brand-500" />
            选择主竿
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            value={parentKw}
            onChange={(e) => { setParentKw(e.target.value); setParentId(null); setParent(null); setParts([]) }}
            placeholder="输入主竿名称 / SKU..."
          />
          {parentKw && !parent && parentMatches.length > 0 && (
            <div className="mt-2 max-h-48 overflow-auto rounded-md border">
              {parentMatches.map((p) => (
                <button key={p.id} onClick={() => handlePickParent(p)} className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                  <span>{productName(p)}</span>
                  <span className="text-xs text-slate-400">{p.sku_code}</span>
                </button>
              ))}
            </div>
          )}
          {parent && (
            <div className="mt-3 rounded-lg bg-slate-50 px-4 py-3 text-sm">
              当前主竿：<span className="font-semibold">{productName(parent)}</span>
              <span className="ml-2 font-mono text-xs text-slate-400">{parent.sku_code}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 配节列表 */}
      {parent && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Link2 className="size-5 text-lake-500" />
                {productName(parent)} 的配节
              </CardTitle>
            </CardHeader>
            <CardContent>
              {parts.length === 0 ? (
                <EmptyState compact title="这个主竿还没登记配节" desc="下面的表单可以一次勾选多个竿梢/手把节批量绑到这个主竿" />
              ) : (
                <div className="max-h-[360px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>配节类型</TableHead>
                        <TableHead>商品</TableHead>
                        <TableHead className="text-right">库存 / 缺货线</TableHead>
                        <TableHead className="w-24 text-right">改缺货线</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parts.map((p) => {
                        const threshold = p.min_stock ?? DEFAULT_THRESHOLD
                        const low = p.stock < threshold
                        const draft = thresholdDrafts[p.id] ?? ''
                        return (
                          <TableRow key={p.id}>
                            <TableCell>
                              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{p.part_type || '配节'}</span>
                            </TableCell>
                            <TableCell>
                              <span>{[p.brand, p.model].filter(Boolean).join(' ') || p.sku_code}</span>
                              <span className="ml-2 font-mono text-xs text-muted-foreground">{p.sku_code}</span>
                            </TableCell>
                            <TableCell className={`text-right font-medium ${low ? 'text-red-600' : ''}`}>
                              {p.stock} / {threshold}{low && ' 缺货'}
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                placeholder={`${DEFAULT_THRESHOLD}`}
                                value={draft}
                                onChange={(e) =>
                                  setThresholdDrafts((d) => ({ ...d, [p.id]: e.target.value }))
                                }
                                onBlur={() => commitThreshold(p)}
                                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                                className="ml-auto h-8 w-20 text-right"
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <button onClick={() => handleRemovePart(p)} className="text-xs text-slate-400 hover:text-red-500 cursor-pointer">解除</button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 批量添加配节 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plus className="size-5 text-brand-500" />
                批量添加配节
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>搜索要设为配节的商品（可勾选多个，一次绑好）</Label>
                <Input value={addKw} onChange={(e) => { setAddKw(e.target.value); setError('') }} placeholder="输入竿梢/手把节的名称或 SKU，勾选后批量绑定..." className="mt-1" />
                {addKw && addMatches.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-auto rounded-md border">
                    {addMatches.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => toggleSelect(p.id)}
                        className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer"
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-brand-500">
                            {selectedIds.has(p.id) ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
                          </span>
                          {productName(p)}
                        </span>
                        <span className="text-xs text-slate-400">{p.sku_code}</span>
                      </button>
                    ))}
                  </div>
                )}
                {addKw && addMatches.length === 0 && (
                  <p className="mt-2 text-xs text-slate-400">没找到符合条件的商品</p>
                )}
              </div>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <Label>配节类型（这次勾选的全部设成这个）</Label>
                  <select
                    value={partType}
                    onChange={(e) => setPartType(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                  >
                    {PART_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <Button onClick={handleBatchAdd} disabled={selectedIds.size === 0 || busy}>
                  <PackageX className="size-4" />
                  {busy ? '绑定中...' : `批量设为配节（已选 ${selectedIds.size}）`}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
