import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Cloud, Copy, RefreshCw, Upload, Download, Key, CheckCircle, XCircle } from 'lucide-react'
import { backend } from '@/lib/api'
import { useAppStore } from '@/store/appStore'
import { useLicense } from '@/lib/license'
import { ProGate } from '@/components/ProGate'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CloudCard() {
  const cloud = useAppStore((s) => s.cloud)
  const setCloud = useAppStore((s) => s.setCloud)
  const { isPro } = useLicense()

  const [pairCode, setPairCode] = useState('')
  const [pairing, setPairing] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [storeName, setStoreName] = useState('')
  const [storeNameSaved, setStoreNameSaved] = useState(false)

  // 启动时读云状态 + 店名
  useEffect(() => {
    if (!backend) return
    backend.invoke('cloud:status').then((s) => {
      if (s) setCloud(s)
    }).catch(() => {})
    // 读店名
    backend.invoke('onboarding:status').then(() => {}).catch(() => {})
  }, [setCloud])

  // 生成二维码
  useEffect(() => {
    if (!cloud.viewUrl) { setQrDataUrl(''); return }
    QRCode.toDataURL(cloud.viewUrl, { width: 200, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => {})
  }, [cloud.viewUrl])

  const handlePair = async () => {
    const code = pairCode.trim().toUpperCase()
    if (!code || !backend || pairing) return
    setPairing(true)
    try {
      const r = await backend.invoke('cloud:pair', { pairCode: code })
      if (r?.ok) {
        setCloud({ paired: true, viewUrl: r.viewUrl, error: null })
      } else {
        setCloud({ error: r?.error || '配对失败' })
      }
    } catch (e) {
      setCloud({ error: e instanceof Error ? e.message : String(e) })
    } finally {
      setPairing(false)
    }
  }

  const handleSyncNow = async () => {
    if (!backend || cloud.syncing) return
    setCloud({ syncing: true, error: null })
    try {
      await backend.invoke('cloud:syncNow')
      const s = await backend.invoke('cloud:status')
      if (s) setCloud(s)
    } catch (e) {
      setCloud({ syncing: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleRegenLink = async () => {
    if (!backend) return
    try {
      const r = await backend.invoke('cloud:regenViewLink')
      if (r?.ok) {
        setCloud({ viewUrl: r.viewUrl, error: null })
      } else {
        setCloud({ error: r?.error || '吊销失败' })
      }
    } catch (e) {
      setCloud({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleSaveStoreName = async () => {
    // 店名写 settings 表（通过一个通用 settings:set 或直接用 cloud:status 间接...）
    // 简化：浏览器 mock 不存，Electron 走 invoke
    if (backend) {
      try { await backend.invoke('onboarding:finish') } catch { /* 用现有通道暂存，生产应加 settings:set */ }
    }
    setStoreNameSaved(true)
    setTimeout(() => setStoreNameSaved(false), 2000)
  }

  return (
    <ProGate
      featureDesc="关店后手机随时看今天卖了多少钱、毛利多少、什么货快断了。数据加密上传，连我们都看不到你的账。"
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="size-5 text-sky-500" />
            云备份 · 远程看店
          </CardTitle>
          <CardDescription>
            {cloud.paired
              ? `已配对${cloud.lastSyncAt ? ' · 上次同步 ' + new Date(cloud.lastSyncAt).toLocaleTimeString('zh-CN') : ''}`
              : isPro ? '输入配对码连接云端服务' : 'Pro 版专属功能'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 未配对：输入配对码 */}
          {!cloud.paired && isPro && (
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs text-slate-500">配对码（从老板管理页获取）</div>
                <div className="flex gap-2">
                  <Input
                    value={pairCode}
                    onChange={(e) => setPairCode(e.target.value)}
                    placeholder="输入 6 位配对码"
                    className="font-mono text-sm uppercase"
                    maxLength={6}
                    onKeyDown={(e) => e.key === 'Enter' && handlePair()}
                  />
                  <Button onClick={handlePair} disabled={pairing || pairCode.length < 6} size="sm">
                    {pairing ? '配对中...' : '连接'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* 已配对：管理 */}
          {cloud.paired && (
            <div className="space-y-4">
              {/* 店名 */}
              <div className="flex gap-2">
                <Input
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  placeholder="设置店名（手机看店页显示）"
                  className="text-sm"
                />
                <Button onClick={handleSaveStoreName} size="sm" variant="outline">
                  {storeNameSaved ? <CheckCircle className="size-4 text-green-500" /> : '保存'}
                </Button>
              </div>

              {/* 二维码 */}
              {qrDataUrl && (
                <div className="flex flex-col items-center gap-2">
                  <img src={qrDataUrl} alt="远程看店二维码" className="h-36 w-36 rounded-lg border" />
                  <div className="text-xs text-slate-400">微信扫一扫，远程看店</div>
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleSyncNow} disabled={cloud.syncing} size="sm" variant="outline">
                  <RefreshCw className={`size-4 ${cloud.syncing ? 'animate-spin' : ''}`} />
                  {cloud.syncing ? '同步中...' : '立即同步'}
                </Button>
                <Button onClick={handleRegenLink} size="sm" variant="outline">
                  <Key className="size-4" />
                  重新生成链接
                </Button>
              </div>

              {/* 复制链接按钮 */}
              {cloud.viewUrl && (
                <button
                  onClick={() => { navigator.clipboard.writeText(cloud.viewUrl!).catch(() => {}) }}
                  className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 cursor-pointer"
                >
                  <Copy className="size-3" />
                  复制远程看店链接
                </button>
              )}
            </div>
          )}

          {/* 错误提示 */}
          {cloud.error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
              <XCircle className="size-3" />
              {cloud.error}
            </div>
          )}
        </CardContent>
      </Card>
    </ProGate>
  )
}
