import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { motion } from 'motion/react'
import { Sidebar } from './Sidebar'
import { CommandPalette } from '@/components/CommandPalette'
import { LowStockAlert } from '@/components/LowStockAlert'
import { useAppStore } from '@/store/appStore'

export function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const location = useLocation()
  const error = useAppStore((s) => s.error)

  return (
    <div className="flex min-h-screen bg-gradient-to-br from-[#f2f6f9] via-[#eef3f8] to-[#e6eef5] dark:from-[#0f1b2d] dark:via-[#0f1b2d] dark:to-[#131f33]">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <main className="flex-1 overflow-auto p-6">
        {/* 数据层错误条：加载失败等全局问题在这里亮出来，而不是闷死 */}
        {error && (
          <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-sm">
            <span>{error}</span>
            <button
              className="shrink-0 font-medium text-red-500 hover:text-red-700"
              onClick={() => useAppStore.setState({ error: null })}
            >
              关闭
            </button>
          </div>
        )}
        {/* 路由切换时整页淡入上移，key 变化触发重挂载 */}
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <Outlet />
        </motion.div>
      </main>
      {/* 低库存开机提醒：每次启动弹一次 */}
      <LowStockAlert />
      {/* Ctrl+K 全局命令面板 */}
      <CommandPalette />
    </div>
  )
}
