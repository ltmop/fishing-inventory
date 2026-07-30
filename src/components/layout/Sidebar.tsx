import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  ScanBarcode,
  PackageSearch,
  ClipboardCheck,
  ClipboardList,
  Factory,
  Users,
  PackageMinus,
  BarChart3,
  Fish,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { APP_VERSION } from '@/lib/version'

// 一级：每天用的进/销/存；二级：偶尔用的管理功能
const DAILY_ITEMS = [
  { to: '/inbound', label: '扫码入库', icon: ScanBarcode, iconColor: 'text-sky-400' },
  { to: '/outbound', label: '销售出库', icon: PackageMinus, iconColor: 'text-orange-400' },
  { to: '/inventory', label: '库存查询', icon: PackageSearch, iconColor: 'text-emerald-400' },
]

const ADMIN_ITEMS = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, end: true },
  { to: '/reports', label: '经营报表', icon: BarChart3 },
  { to: '/purchase', label: '采购订货', icon: ClipboardList },
  { to: '/stock-take', label: '盘点管理', icon: ClipboardCheck },
  { to: '/customers', label: '客户', icon: Users },
  { to: '/suppliers', label: '供应商', icon: Factory },
  { to: '/settings', label: '设置', icon: Settings },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  iconColor,
  collapsed,
  large,
}: {
  to: string
  label: string
  icon: typeof Fish
  end?: boolean
  iconColor?: string
  collapsed: boolean
  large?: boolean
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md text-sm font-medium transition-all duration-150',
          collapsed ? 'justify-center px-0 py-2.5' : large ? 'px-3 py-2.5' : 'px-3 py-2',
          isActive
            ? 'bg-white/15 text-white shadow-[inset_3px_0_0_0] shadow-sky-400'
            : 'text-white/70 hover:bg-white/10 hover:text-white',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn(
              'shrink-0',
              large ? 'size-5' : 'size-4.5',
              isActive ? 'text-white' : iconColor,
            )}
          />
          {!collapsed && <span className={large ? 'text-[15px]' : ''}>{label}</span>}
        </>
      )}
    </NavLink>
  )
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className={cn(
        'flex h-screen flex-col bg-gradient-to-b from-brand-800 to-brand-900 transition-all duration-200',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className={cn('flex items-center gap-2.5 px-4 py-5', collapsed && 'justify-center px-0')}>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-400/20">
          <Fish className="size-5 text-sky-400" />
        </div>
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-sm font-bold text-white">渔具库存</div>
            <div className="text-xs text-white/60">AI 管理系统</div>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2">
        <div className="space-y-1">
          {!collapsed && (
            <div className="px-3 pb-1 text-[11px] font-medium tracking-wider text-white/40">
              日常操作
            </div>
          )}
          {DAILY_ITEMS.map((item) => (
            <NavItem key={item.to} {...item} collapsed={collapsed} large />
          ))}
        </div>
        <div className="space-y-1 border-t border-white/10 pt-3">
          {!collapsed && (
            <div className="px-3 pb-1 text-[11px] font-medium tracking-wider text-white/40">
              管理
            </div>
          )}
          {ADMIN_ITEMS.map((item) => (
            <NavItem key={item.to} {...item} collapsed={collapsed} />
          ))}
        </div>
      </nav>

      {!collapsed && (
        <div className="px-4 pb-1 text-[11px] text-white/40">v{APP_VERSION} · 阿杜 © 2026</div>
      )}
      <button
        onClick={onToggle}
        className="m-2 flex items-center justify-center rounded-md p-2 text-white/60 hover:bg-white/10 hover:text-white cursor-pointer"
        title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
      </button>
    </aside>
  )
}
