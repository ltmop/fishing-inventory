import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store/appStore'
import { formatPrice, productName } from '@/lib/formatters'
import type { Supplier } from '@/types'
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

const EMPTY_FORM = { name: '', contact: '', phone: '', address: '', notes: '' }

export function SuppliersPage() {
  const suppliers = useAppStore((s) => s.suppliers)
  const batches = useAppStore((s) => s.batches)
  const products = useAppStore((s) => s.products)
  const addSupplier = useAppStore((s) => s.addSupplier)
  const updateSupplier = useAppStore((s) => s.updateSupplier)
  const deleteSupplier = useAppStore((s) => s.deleteSupplier)

  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<Supplier | null>(null)
  // P0-1：保存/删除按钮统一忙碌态 + 成功绿条 + 失败红条
  const [saving, setSaving] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [success, setSuccess] = useState('')
  const [pageError, setPageError] = useState('')
  // 按名称/联系人搜索（清单第 19 项）
  const [keyword, setKeyword] = useState('')

  const filteredSuppliers = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return suppliers
    return suppliers.filter((s) =>
      [s.name, s.contact, s.phone].filter(Boolean).join(' ').toLowerCase().includes(kw),
    )
  }, [suppliers, keyword])

  // 成功提示 3 秒后自动消失
  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => setSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [success])

  // 每个供应商关联的商品（经批次反查，去重）
  const productsBySupplier = useMemo(() => {
    const map = new Map<number, number[]>()
    for (const b of batches) {
      if (b.supplier_id === null) continue
      const list = map.get(b.supplier_id) ?? []
      if (!list.includes(b.product_id)) list.push(b.product_id)
      map.set(b.supplier_id, list)
    }
    return map
  }, [batches])

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setError('')
    setFormOpen(true)
  }

  const openEdit = (s: Supplier) => {
    setEditingId(s.id)
    setForm({ name: s.name, contact: s.contact, phone: s.phone, address: s.address, notes: s.notes })
    setError('')
    setFormOpen(true)
  }

  const handleSave = async () => {
    if (saving) return
    if (!form.name.trim()) {
      setError('供应商名称不能为空')
      return
    }
    const payload = {
      name: form.name.trim(),
      contact: form.contact.trim(),
      phone: form.phone.trim(),
      address: form.address.trim(),
      notes: form.notes.trim(),
    }
    setSaving(true)
    try {
      if (editingId === null) await addSupplier(payload)
      else await updateSupplier(editingId, payload)
      setFormOpen(false)
      setSuccess(editingId === null ? `已新增供应商「${payload.name}」` : `已保存「${payload.name}」的修改`)
    } catch (e) {
      setFormOpen(false)
      setPageError(`保存供应商失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    try {
      await deleteSupplier(deleting.id)
      setSuccess(`已删除供应商「${deleting.name}」，历史批次保留`)
      setDeleting(null)
    } catch (e) {
      setDeleting(null)
      setPageError(`删除供应商失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="供应商管理"
        subtitle="维护供应商档案，与入库批次关联追溯"
        action={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            新增供应商
          </Button>
        }
      />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {pageError && <ErrorBanner>{pageError}</ErrorBanner>}

      <Card>
        <CardContent className="pt-6">
          {/* 搜索框：按名称/联系人/电话过滤 */}
          <div className="relative mb-4 w-72">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索供应商名称/联系人..."
              className="pl-9"
            />
          </div>
          {filteredSuppliers.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {suppliers.length === 0 ? '暂无供应商，点击右上角新增' : '没有符合条件的供应商'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>名称</TableHead>
                  <TableHead>联系人</TableHead>
                  <TableHead>电话</TableHead>
                  <TableHead>地址</TableHead>
                  <TableHead className="text-right">关联商品数</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSuppliers.map((s) => {
                  const productIds = productsBySupplier.get(s.id) ?? []
                  const isOpen = expanded.has(s.id)
                  return (
                    <Fragment key={s.id}>
                      <TableRow>
                        <TableCell>
                          <button
                            onClick={() => toggleExpand(s.id)}
                            className="text-slate-500 hover:text-slate-900 cursor-pointer"
                            title={isOpen ? '收起' : '展开供应商品'}
                          >
                            {isOpen ? (
                              <ChevronDown className="size-4" />
                            ) : (
                              <ChevronRight className="size-4" />
                            )}
                          </button>
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => toggleExpand(s.id)}
                            className="font-medium text-sky-700 hover:underline cursor-pointer"
                          >
                            {s.name}
                          </button>
                          {s.notes && (
                            <div className="text-xs text-muted-foreground">{s.notes}</div>
                          )}
                        </TableCell>
                        <TableCell>{s.contact || '-'}</TableCell>
                        <TableCell>{s.phone || '-'}</TableCell>
                        <TableCell>{s.address || '-'}</TableCell>
                        <TableCell className="text-right">{productIds.length}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => openEdit(s)}>
                              <Pencil className="size-3" />
                              编辑
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-red-600 hover:text-red-700"
                              onClick={() => setDeleting(s)}
                            >
                              <Trash2 className="size-3" />
                              删除
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="bg-slate-50 hover:bg-slate-50">
                          <TableCell />
                          <TableCell colSpan={6} className="py-3">
                            {productIds.length === 0 ? (
                              <div className="text-xs text-muted-foreground">
                                该供应商暂无供货记录
                              </div>
                            ) : (
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>SKU</TableHead>
                                    <TableHead>品名</TableHead>
                                    <TableHead>品类</TableHead>
                                    <TableHead className="text-right">当前库存</TableHead>
                                    <TableHead className="text-right">最近进价</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {productIds.map((pid) => {
                                    const p = products.find((x) => x.id === pid)
                                    if (!p) return null
                                    const stock = batches
                                      .filter((b) => b.product_id === pid)
                                      .reduce((sum, b) => sum + b.quantity, 0)
                                    return (
                                      <TableRow key={pid}>
                                        <TableCell className="font-mono text-xs">
                                          {p.sku_code}
                                        </TableCell>
                                        <TableCell>{productName(p)}</TableCell>
                                        <TableCell>{p.category}</TableCell>
                                        <TableCell className="text-right">{stock}</TableCell>
                                        <TableCell className="text-right">
                                          {formatPrice(p.cost_price)}
                                        </TableCell>
                                      </TableRow>
                                    )
                                  })}
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

      {/* 新增/编辑 Dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId === null ? '新增供应商' : '编辑供应商'}</DialogTitle>
            <DialogDescription>带 * 为必填项</DialogDescription>
          </DialogHeader>
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-1">
              <Label>名称 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>联系人</Label>
              <Input
                value={form.contact}
                onChange={(e) => setForm({ ...form, contact: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>电话</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>地址</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label>备注</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="账期、主营品类等..."
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

      {/* 删除确认 Dialog（危险操作二次确认） */}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除供应商</DialogTitle>
            <DialogDescription>
              确定要删掉供应商「{deleting?.name}」吗？删掉后，它名下的进货记录还在，
              只是记录里不再显示这个供应商的名字。这个操作找不回来。
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
    </div>
  )
}
