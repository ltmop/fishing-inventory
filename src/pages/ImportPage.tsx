import { useState, useRef } from 'react'
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Download } from 'lucide-react'
import { PageHeader, SuccessBanner } from '@/components/feedback'
import { useAppStore } from '@/store/appStore'
import { CATEGORIES } from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { backend } from '@/lib/api'
import {
  parseCSVText, parseXlsxBuffer, buildTemplateBlob, type ImportRow,
} from '@/lib/importParse'

export function ImportPage() {
  const loadAll = useAppStore((s) => s.loadAll)
  const products = useAppStore((s) => s.products)
  const fileRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<ImportRow[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [success, setSuccess] = useState('')
  const [importing, setImporting] = useState(false)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setErrors([])
    setSuccess('')
    const file = e.target.files?.[0]
    if (!file) return
    const isExcel = /\.xlsx$/i.test(file.name)
    try {
      const parsed = isExcel
        ? await parseXlsxBuffer(await file.arrayBuffer())
        : parseCSVText(await file.text())
      setRows(parsed)
      const errs = parsed.filter((r) => r.__errors.length > 0)
      if (errs.length > 0) {
        setErrors(errs.map((r) => `第${r.__line}行: ${r.__errors.join('; ')}`))
      }
    } catch (err: any) {
      setErrors([err.message || '文件读取失败，请换一个文件试试'])
      setRows([])
    }
    // 重置 input 以便重复选择同一文件
    e.target.value = ''
  }

  async function handleImport() {
    const valid = rows.filter((r) => r.__errors.length === 0)
    if (valid.length === 0) {
      setErrors(['没有可以导入的有效行'])
      return
    }
    setImporting(true)
    setErrors([])
    setSuccess('')
    try {
      if (backend) {
        const result = await backend.invoke('import:batch', { rows: valid })
        setSuccess(`成功导入 ${result.imported} 个商品，已生成批次和入库记录`)
        setRows([])
        await loadAll()
      } else {
        // 浏览器 mock 路径：逐个调用 addProduct + addInbound
        let ok = 0
        for (const r of valid) {
          try {
            const p = await useAppStore.getState().addProduct({
              sku_code: r.sku_code,
              barcode: r.barcode ?? null,
              category: r.category,
              sub_category: r.sub_category ?? null,
              brand: r.brand ?? null,
              model: r.model ?? null,
              cost_price: r.cost_price,
              suggest_price: r.suggest_price ?? null,
              location: r.location ?? null,
              status: '待盘点',
              rod_length: r.rod_length ?? null,
              rod_action: r.rod_action ?? null,
              power_rating: r.power_rating ?? null,
              line_number: r.line_number ?? null,
              hook_size: r.hook_size ?? null,
              color: r.color ?? null,
              material: r.material ?? null,
              expiry_date: r.expiry_date ?? null,
            })
            if (r.quantity > 0) {
              await useAppStore.getState().addInbound({
                productId: p.id,
                quantity: r.quantity,
                costPrice: r.cost_price,
                location: r.location ?? null,
                supplierId: null,
                operator: r.operator ?? '导入',
              })
            }
            ok++
          } catch (e: any) {
            setErrors((prev) => [...prev, `${r.sku_code}: ${e.message}`])
          }
        }
        setSuccess(`成功导入 ${ok}/${valid.length} 个商品`)
        setRows([])
      }
    } catch (e: any) {
      setErrors([e.message || '导入失败'])
    } finally {
      setImporting(false)
    }
  }

  async function handleDownloadTemplate() {
    try {
      const blob = await buildTemplateBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = '渔具库存导入模板.xlsx'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      setErrors(['模板生成失败，请刷新页面后再试'])
    }
  }

  const errorCount = rows.filter((r) => r.__errors.length > 0).length
  const validCount = rows.length - errorCount
  const existingSkus = new Set(products.map((p) => p.sku_code))
  const duplicateCount = rows.filter((r) => existingSkus.has(r.sku_code)).length

  return (
    <div className="space-y-6">
      <PageHeader title="批量导入" subtitle="从 Excel 或 CSV 文件批量导入商品和库存" />

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {errors.length > 0 && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-3">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
              <div className="text-sm text-red-700">
                <div className="font-medium mb-1">发现 {errors.length} 个问题：</div>
                {errors.slice(0, 10).map((e, i) => (
                  <div key={i}>- {e}</div>
                ))}
                {errors.length > 10 && <div>... 还有 {errors.length - 10} 个问题</div>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 操作区 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. 准备 Excel 或 CSV 文件</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={handleDownloadTemplate}>
              <Download className="size-4" />
              下载导入模板
            </Button>
            <Button onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" />
              选择 Excel / CSV 文件
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx"
              className="hidden"
              onChange={handleFile}
            />
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>支持 .xlsx / .csv 文件（老版 .xls 请先在 Excel 里另存为 .xlsx）；表头支持中英文（如"sku编码"或"sku_code"）。</p>
            <p>必要列：sku编码、品类、进价(元)、数量。可选列：条码、子类、品牌、型号、建议售价、货位，以及渔具规格列（长度、调性、硬度、线号、钩号、颜色、材质、保质期，空着也能导入）。</p>
            <p><strong>进价和售价单位为元</strong>（如 45.00），系统自动转换为分存储。</p>
            <p>品类须为以下之一：{CATEGORIES.join('、')}</p>
          </div>
        </CardContent>
      </Card>

      {/* 预览区 */}
      {rows.length > 0 && (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">
                2. 预览导入数据（{rows.length} 条）
                {validCount > 0 && (
                  <span className="ml-2 text-green-600">
                    <CheckCircle2 className="inline size-4" /> {validCount} 条有效
                  </span>
                )}
                {errorCount > 0 && (
                  <span className="ml-2 text-red-600">
                    <AlertCircle className="inline size-4" /> {errorCount} 条有误
                  </span>
                )}
                {duplicateCount > 0 && (
                  <span className="ml-2 text-amber-600">
                    {duplicateCount} 条SKU已存在（将跳过）
                  </span>
                )}
              </CardTitle>
              <Button onClick={handleImport} disabled={validCount === 0 || importing}>
                <FileSpreadsheet className="size-4" />
                {importing ? '导入中...' : `确认导入 ${validCount} 条`}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="max-h-96 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>品类</TableHead>
                      <TableHead>子类</TableHead>
                      <TableHead>品牌</TableHead>
                      <TableHead>型号</TableHead>
                      <TableHead className="text-right">进价</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead>货位</TableHead>
                      <TableHead className="w-10">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, 200).map((r, i) => {
                      const hasDup = existingSkus.has(r.sku_code)
                      return (
                        <TableRow key={i} className={r.__errors.length > 0 ? 'bg-red-50' : hasDup ? 'bg-amber-50' : ''}>
                          <TableCell className="text-xs text-muted-foreground">{r.__line}</TableCell>
                          <TableCell className="font-mono text-xs">{r.sku_code}</TableCell>
                          <TableCell>{r.category}</TableCell>
                          <TableCell>{r.sub_category || '-'}</TableCell>
                          <TableCell>{r.brand || '-'}</TableCell>
                          <TableCell className="max-w-32 truncate">{r.model || '-'}</TableCell>
                          <TableCell className="text-right">{(r.cost_price / 100).toFixed(2)}</TableCell>
                          <TableCell className="text-right">{r.quantity}</TableCell>
                          <TableCell>{r.location || '-'}</TableCell>
                          <TableCell>
                            {r.__errors.length > 0 ? (
                              <span className="text-red-500 text-xs" title={r.__errors.join('; ')}>❌</span>
                            ) : hasDup ? (
                              <span className="text-amber-500 text-xs" title="SKU已存在">⚠️</span>
                            ) : (
                              <span className="text-green-500 text-xs">✅</span>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {rows.length > 200 && (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center text-muted-foreground">
                          ... 还有 {rows.length - 200} 条（预览仅显示前200条）
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
