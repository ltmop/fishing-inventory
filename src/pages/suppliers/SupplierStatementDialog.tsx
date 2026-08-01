import { Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Pagination } from '@/components/ui/pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate, formatPrice } from '@/lib/formatters'
import { usePagination } from '@/lib/usePagination'
import type { Supplier, SupplierStatement } from '@/types'

interface SupplierStatementDialogProps {
  stmtFor: Supplier | null
  stmt: SupplierStatement | null
  loading: boolean
  onClose: () => void
}

/** 供应商对账单 Dialog：汇总头 + 进货明细（样式参照客户对账单）；明细多了按页翻 */
export function SupplierStatementDialog({ stmtFor, stmt, loading, onClose }: SupplierStatementDialogProps) {
  // 换供应商/重新加载时回第 1 页
  const pg = usePagination(stmt?.lines ?? [], [stmt])
  return (
    <Dialog open={stmtFor !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {stmtFor?.name}
            {stmtFor?.phone && (
              <span className="text-sm font-normal text-muted-foreground">{stmtFor.phone}</span>
            )}
          </DialogTitle>
          <DialogDescription>从他家进的每一批货都在这儿</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在翻进货账...
          </div>
        )}

        {!loading && stmt && (
          <>
            {/* 汇总头：累计进货 / 件数 / 最近进货 / 待收货 */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-xs text-slate-500">累计进货</div>
                <div className="text-xl font-bold tabular-nums text-slate-800">
                  {formatPrice(stmt.totalAmount)}
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-xs text-slate-500">进货件数</div>
                <div className="text-xl font-bold tabular-nums text-slate-800">
                  共 {stmt.totalQty} 件
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="text-xs text-slate-500">最近进货</div>
                <div className="text-xl font-bold text-slate-800">
                  {stmt.lastInboundAt ? formatDate(stmt.lastInboundAt) : '没有进过货'}
                </div>
              </div>
              <div className={`rounded-xl px-4 py-3 ${stmt.pendingPoAmount > 0 ? 'bg-amber-50' : 'bg-slate-50'}`}>
                <div className={`text-xs ${stmt.pendingPoAmount > 0 ? 'text-amber-600' : 'text-slate-500'}`}>
                  待收货
                </div>
                <div
                  className={`text-xl font-bold tabular-nums ${
                    stmt.pendingPoAmount > 0 ? 'text-amber-700' : 'text-slate-400'
                  }`}
                >
                  {stmt.pendingPoAmount > 0 ? formatPrice(stmt.pendingPoAmount) : '没有待收'}
                </div>
              </div>
            </div>

            <div className="max-h-[46vh] overflow-y-auto pr-1">
              <div className="mb-2 text-sm font-medium text-slate-700">
                进货明细（共 {stmt.lines.length} 批）
              </div>
              {stmt.lines.length === 0 ? (
                <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  还没有从他家进过货
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>商品</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead className="text-right">单价</TableHead>
                      <TableHead className="text-right">金额</TableHead>
                      <TableHead>单号</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pg.pageItems.map((l) => (
                      <TableRow key={l.batch_id}>
                        <TableCell className="whitespace-nowrap">{formatDate(l.date)}</TableCell>
                        <TableCell>
                          <span className="mr-2">{l.product_name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{l.sku}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPrice(l.cost_price)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatPrice(l.amount)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {l.po_no ?? l.batch_no}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            {stmt.lines.length > 0 && (
              <Pagination {...pg} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
