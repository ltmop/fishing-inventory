import { useAppStore } from '@/store/appStore'
import { backend } from '@/lib/api'
import { useEffect } from 'react'

export interface LicenseState {
  activated: boolean
  level: 'free' | 'pro'
  expiresAt: string | null
  machineId: string
  daysLeft: number | null
}

/** 前端授权 hook：Electron 走 IPC，浏览器 mock 默认免费 */
export function useLicense(): LicenseState & {
  activate: (code: string) => Promise<{ ok: boolean; error?: string }>
  isPro: boolean
} {
  const license = useAppStore((s) => s.license)
  const setLicense = useAppStore((s) => s.setLicense)

  useEffect(() => {
    if (!backend) return
    backend.invoke('license:status').then((s) => {
      if (s) setLicense(s)
    }).catch(() => {})
  }, [setLicense])

  const activate = async (code: string) => {
    if (!backend) return { ok: false, error: '仅在桌面端支持激活' }
    try {
      const r = await backend.invoke('license:activate', { code })
      if (r?.ok) {
        setLicense(r.license)
        return { ok: true }
      }
      return { ok: false, error: r?.error || '激活失败' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  return {
    ...license,
    activate,
    isPro: license.activated && license.daysLeft !== null && license.daysLeft > 0,
  }
}

/** 格式化剩余天数 */
export function daysText(daysLeft: number | null): string {
  if (daysLeft === null) return '未激活'
  if (daysLeft <= 0) return '已到期，请续费'
  if (daysLeft > 365 * 50) return '永久有效'
  if (daysLeft > 365) return `剩余 ${Math.floor(daysLeft / 365)} 年 ${daysLeft % 365} 天`
  return `剩余 ${daysLeft} 天`
}
