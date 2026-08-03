import { useEffect, useState } from 'react'
import { Fish, Link2, Plus, PackageX } from 'lucide-react'
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
}

const PART_TYPES = ['竿梢', '手把节', '中节', '后堵', '其他']

/** 配节管理：主竿-配节关联，断竿梢换节看库存 */
export function PartsPage() {
  const products = useAppStore((s) => s.products)
  const [parentKw, setParentKw] = useState('')
  const [parentId, setParentId] = useState<number | null>(null)
  const [parent, setParent] = useState<Product | null>(null)
  const [parts, setParts] = useState<PartRow[]>([])

  const [addKw, setAddKw] = useState('')
  const [addProductId, setAddProductId] = useState<number | null>(null)
  const [partType, setPartType] = useState('竿梢')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)

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
    ? products.filter((p) => p.id !== parentId && [p.sku_code, p.brand, p.model].filter(Boolean).join(' ').toLowerCase().includes(addKw.trim().toLowerCase())).slice(0, 8)
    : []

  const handlePickParent = (p: Product) => {
    setParentId(p.id)
    setParent(p)
    setParentKw(productName(p))
    setError('')
    setSuccess('')
  }

  const handleAddPart = async () => {
    if (!parentId || !addProductId || busy || !backend) return
    setBusy(true)
    setError('')
    try {
      await backend.invoke('part:set', { productId: addProductId, parentId, partType, operator: '阿东' })
      setSuccess(`已设「${productName(products.find((p) => p.id === addProductId)!)}」为${productName(parent!)}的${partType}`)
      setAddKw('')
      setAddProductId(null)
      loadParts(parentId)
    } catch (e) {
      setError(`设置失败：${e instanceof Error ? e.message : String(e)}`)
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

  return (
    <div className="space-y-6">
      <PageHeader title="配节管理" subtitle="断竿梢换节是售后刚需——按主竿看各配节库存，缺货早备" />

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
                <EmptyState compact title="这个主竿还没登记配节" desc="下面的表单可以把它店里的竿梢/手把节关联到这个主竿" />
              ) : (
                <div className="max-h-[360px] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>配节类型</TableHead>
                        <TableHead>商品</TableHead>
                        <TableHead className="text-right">库存</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parts.map((p) => {
                        const low = p.stock < 3
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
                              {p.stock}{low && ' 缺货'}
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

          {/* 添加配节 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plus className="size-5 text-brand-500" />
                添加配节
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>搜索要设为配节的商品（竿梢/手把节等）</Label>
                <Input value={addKw} onChange={(e) => { setAddKw(e.target.value); setAddProductId(null) }} placeholder="输入竿梢/手把节的名称或 SKU..." className="mt-1" />
                {addKw && !addProductId && addMatches.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-auto rounded-md border">
                    {addMatches.map((p) => (
                      <button key={p.id} onClick={() => { setAddProductId(p.id); setAddKw(productName(p)) }} className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                        <span>{productName(p)}</span>
                        <span className="text-xs text-slate-400">{p.sku_code}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <Label>配节类型</Label>
                  <select
                    value={partType}
                    onChange={(e) => setPartType(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                  >
                    {PART_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <Button onClick={handleAddPart} disabled={!addProductId || busy}>
                  <PackageX className="size-4" />
                  设为配节
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
