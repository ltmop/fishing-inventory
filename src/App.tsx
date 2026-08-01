import { useEffect, useState } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { SplashScreen } from '@/components/SplashScreen'
import { Layout } from '@/components/layout/Layout'
import { DashboardPage } from '@/pages/DashboardPage'
import { InboundPage } from '@/pages/InboundPage'
import { OutboundPage } from '@/pages/OutboundPage'
import { InventoryPage } from '@/pages/InventoryPage'
import { StockTakePage } from '@/pages/StockTakePage'
import { PurchasePage } from '@/pages/PurchasePage'
import { SuppliersPage } from '@/pages/SuppliersPage'
import { CustomersPage } from '@/pages/CustomersPage'
import { ExpensesPage } from '@/pages/ExpensesPage'
import { AuditLogPage } from '@/pages/AuditLogPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { ImportPage } from '@/pages/ImportPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { ReportsPage } from '@/pages/ReportsPage'
import { computeCustomerStats, useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import {
  mockAuditLogs,
  mockBatches,
  mockCustomers,
  mockExpenses,
  mockPayments,
  mockPriceTiers,
  mockProducts,
  mockPurchaseOrderItems,
  mockPurchaseOrders,
  mockStockTakeItems,
  mockStockTakes,
  mockSuppliers,
  mockTransactions,
} from '@/lib/mock-data'

function App() {
  const loadAll = useAppStore((s) => s.loadAll)
  const loaded = useAppStore((s) => s.loaded)
  const fontSizeMode = useAppStore((s) => s.fontSizeMode)
  // 启动动画：数据就绪后播一次，播完才挂载路由（每次启动只播一次；点击或减弱动画直接跳过）
  const [splashDone, setSplashDone] = useState(false)

  // 大字模式：给 <html> 挂 text-large class，根字号提到 18px，全站 rem 字号整体放大
  useEffect(() => {
    document.documentElement.classList.toggle('text-large', fontSizeMode === 'large')
  }, [fontSizeMode])

  // Electron 环境启动时从 SQLite 拉全量数据；浏览器 dev 无后端则注入 mock（只跑一次，避免闪烁）
  useEffect(() => {
    if (backend) {
      loadAll()
    } else {
      useAppStore.setState({
        products: mockProducts,
        batches: mockBatches,
        transactions: mockTransactions,
        suppliers: mockSuppliers,
        stockTakes: mockStockTakes,
        stockTakeItems: mockStockTakeItems,
        customers: computeCustomerStats(mockCustomers, mockTransactions, mockPayments),
        payments: mockPayments,
        purchaseOrders: mockPurchaseOrders,
        purchaseOrderItems: mockPurchaseOrderItems,
        priceTiers: mockPriceTiers,
        expenses: mockExpenses,
        auditLogs: mockAuditLogs,
        loaded: true,
      })
    }
  }, [loadAll])

  // 数据未就绪时显示品牌加载屏，杜绝"先闪 mock 再跳真数据"
  if (!loaded) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#e8eef6]">
        <div className="text-2xl font-bold tracking-wide text-[#16355c]">渔具库存 AI 管理系统</div>
        <div className="mt-3 text-sm text-slate-500">正在加载本地数据…</div>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      {!splashDone && <SplashScreen onFinish={() => setSplashDone(true)} />}
      {splashDone && (
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="inbound" element={<InboundPage />} />
            <Route path="outbound" element={<OutboundPage />} />
            <Route path="inventory" element={<InventoryPage />} />
            <Route path="stock-take" element={<StockTakePage />} />
            <Route path="purchase" element={<PurchasePage />} />
            <Route path="suppliers" element={<SuppliersPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="expenses" element={<ExpensesPage />} />
            <Route path="audit" element={<AuditLogPage />} />
            <Route path="import" element={<ImportPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </HashRouter>
      )}
    </ErrorBoundary>
  )
}

export default App
