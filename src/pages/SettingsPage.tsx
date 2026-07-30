import { useEffect, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { DatabaseBackup, FolderOpen, Info, CheckCircle2, Sparkles, ExternalLink, Volume2, Type, AudioLines, Mic, Ear, Loader2, MessageSquarePlus, Send, QrCode, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/feedback'
import { backend } from '@/lib/api'
import { APP_VERSION } from '@/lib/version'
import { readTtsEnabled, writeTtsEnabled } from '@/lib/tts'
import { readWakeEnabled, writeWakeEnabled, startWakeListener, stopWakeListener } from '@/lib/wakeWord'
import { useVoiceModel, useTtsModel, useKwsModel } from '@/lib/useModelDownload'
import { useOnline } from '@/lib/useOnline'
import { useAppStore } from '@/store/appStore'
import { formatDateTime } from '@/lib/formatters'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

interface AppInfo {
  dataDir: string
  dbPath: string
  backupDir: string
  version: string
  lastBackupAt?: number | null
}

/** 手机看店服务状态（server:status 通道返回） */
interface ServerStatus {
  enabled: boolean
  running: boolean
  port: number | null
  ip: string
  url: string | null
  error?: string | null
}

export function SettingsPage() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [backing, setBacking] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [backupResult, setBackupResult] = useState('')
  const [error, setError] = useState('')

  // 使用偏好（本机保存，刷新/重启后仍生效）
  const soundEnabled = useAppStore((s) => s.soundEnabled)
  const setSoundEnabled = useAppStore((s) => s.setSoundEnabled)
  const fontSizeMode = useAppStore((s) => s.fontSizeMode)
  const setFontSizeMode = useAppStore((s) => s.setFontSizeMode)
  // 语音播报开关：与 AiPanel 头部喇叭按钮共享同一份 localStorage（'fi-tts'）
  const [ttsOn, setTtsOn] = useState(readTtsEnabled)
  const toggleTts = () => {
    const next = !ttsOn
    setTtsOn(next)
    writeTtsEnabled(next)
  }

  // AI 助手（BYOK）
  const [aiConfigured, setAiConfigured] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMessage, setAiMessage] = useState<{ ok: boolean; text: string } | null>(null)
  // 离线时联网功能（AI 验证、申请 Key）置灰
  const online = useOnline()

  // 语音识别模型状态（本地 sherpa-onnx 离线识别）
  const voice = useVoiceModel()
  // 语音合成模型状态（本地 sherpa-onnx 离线播报）
  const ttsModel = useTtsModel()
  // 唤醒词模型状态 + 实验性常驻监听开关（默认关，开启才申请麦克风常驻权限）
  const kws = useKwsModel()
  const [wakeOn, setWakeOn] = useState(readWakeEnabled)
  const [wakeError, setWakeError] = useState<string | null>(null)
  const toggleWake = async () => {
    const next = !wakeOn
    setWakeError(null)
    if (!next) {
      writeWakeEnabled(false)
      stopWakeListener()
      setWakeOn(false)
      return
    }
    const r = await startWakeListener()
    if (r.ok) {
      writeWakeEnabled(true)
      setWakeOn(true)
    } else {
      setWakeError(r.reason ?? '唤醒词监听开启失败')
    }
  }

  // 意见反馈：接收地址（飞书机器人 webhook）存本机 localStorage，提交时随内容一起发给主进程
  const [fbWebhook, setFbWebhook] = useState(() => localStorage.getItem('fi-feedback-webhook') ?? '')
  const [fbMessage, setFbMessage] = useState('')
  const [fbContact, setFbContact] = useState('')
  const [fbBusy, setFbBusy] = useState(false)
  const [fbResult, setFbResult] = useState<{ ok: boolean; text: string } | null>(null)
  const handleSendFeedback = async () => {
    if (!backend) return
    setFbBusy(true)
    setFbResult(null)
    try {
      const r = await backend.invoke('feedback:send', {
        webhook: fbWebhook.trim(),
        message: fbMessage.trim(),
        contact: fbContact.trim(),
      })
      if (r?.ok) {
        setFbResult({ ok: true, text: '已收到，谢谢！' })
        setFbMessage('')
      } else {
        const reason = r?.reason ?? ''
        // 网络类失败说大白话，其余原样带出（如机器人拒收原因）
        const friendly = /timeout|fetch|network|ECONN|ENOTFOUND|ETIMEDOUT|abort/i.test(reason)
          ? '没发出去，检查网络后再试'
          : `没发出去：${reason || '未知原因'}`
        setFbResult({ ok: false, text: friendly })
      }
    } catch {
      setFbResult({ ok: false, text: '没发出去，检查网络后再试' })
    } finally {
      setFbBusy(false)
    }
  }

  // 手机看店：局域网只读服务状态 + 二维码（URL 含访问 token）
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [serverBusy, setServerBusy] = useState(false)
  const applyServerStatus = (s: ServerStatus | null) => {
    setServerStatus(s)
    if (s?.url) {
      QRCode.toDataURL(s.url, { width: 220, margin: 1 })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(''))
    } else {
      setQrDataUrl('')
    }
  }
  const handleServerToggle = async () => {
    if (!backend || !serverStatus) return
    setServerBusy(true)
    try {
      applyServerStatus(await backend.invoke('server:toggle', { enabled: !serverStatus.enabled }))
    } finally {
      setServerBusy(false)
    }
  }
  const handleRegenerateToken = async () => {
    if (!backend) return
    // 二次确认：旧二维码/书签会一起失效，必须让老板知道后果
    if (!window.confirm('重新生成访问密码后，之前保存的二维码和手机书签都会失效，需要用新二维码重新扫码。确定要换吗？')) return
    setServerBusy(true)
    try {
      applyServerStatus(await backend.invoke('server:regenerateToken'))
    } finally {
      setServerBusy(false)
    }
  }

  useEffect(() => {
    if (backend) {
      backend.invoke('app:info').then(setInfo).catch(() => {})
      backend
        .invoke('ai:status')
        .then((s) => setAiConfigured(!!s?.configured))
        .catch(() => {})
      backend
        .invoke('server:status')
        .then(applyServerStatus)
        .catch(() => {})
    }
  }, [])

  const handleSaveKey = async () => {
    if (!backend) return
    setAiBusy(true)
    setAiMessage(null)
    try {
      await backend.invoke('ai:setKey', { key: keyInput })
      // 保存后立刻发一个最小请求验证 Key 真能用
      const t = await backend.invoke('ai:test')
      if (t?.ok) {
        setAiConfigured(true)
        setKeyInput('')
        setAiMessage({ ok: true, text: '验证通过，AI 助手已激活。仪表盘今日经营小结会自动生成 AI 打烊日报。' })
      } else {
        setAiMessage({ ok: false, text: `Key 已保存但验证失败（${t?.reason ?? '未知原因'}），请检查 Key 是否正确、账户是否有余额` })
      }
    } catch (e) {
      setAiMessage({ ok: false, text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setAiBusy(false)
    }
  }

  const handleClearKey = async () => {
    if (!backend) return
    await backend.invoke('ai:clearKey').catch(() => {})
    setAiConfigured(false)
    setAiMessage({ ok: true, text: '已停用 AI 助手，Key 已从本机删除' })
  }

  const handleBackup = async () => {
    if (!backend) return
    setBacking(true)
    setError('')
    setBackupResult('')
    try {
      const dest = await backend.invoke('backup:now')
      setBackupResult(dest)
      // 刷新"最近备份时间"显示
      backend.invoke('app:info').then(setInfo).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : '备份失败')
    } finally {
      setBacking(false)
    }
  }

  const handleRestore = async () => {
    if (!backend) return
    setRestoring(true)
    setError('')
    setBackupResult('')
    try {
      const r = await backend.invoke('backup:restore')
      // 用户取消选文件或取消二次确认：静默返回，不算错误
      if (r?.cancelled) return
      // 确认恢复后主进程会立刻 relaunch + exit，正常走不到这里
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复失败')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="设置" subtitle="数据备份、存储位置与系统信息" />

      {/* 使用偏好：提示音 + 大字模式，本机保存 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Volume2 className="size-5 text-brand-500" />
            使用偏好
          </CardTitle>
          <CardDescription>只存在这台电脑上，不影响数据，随时可以改回来。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <PreferenceRow
            icon={<Volume2 className="size-4 text-slate-500" />}
            title="操作提示音"
            description="入库、出库、盘点成功/失败，扫码识别到商品时都有声音，不用盯着屏幕看成败"
            checked={soundEnabled}
            onToggle={() => setSoundEnabled(!soundEnabled)}
          />
          <PreferenceRow
            icon={<Type className="size-4 text-slate-500" />}
            title="大字模式（看得更清楚）"
            description="全站字号放大一档，适合离屏幕远一点操作"
            checked={fontSizeMode === 'large'}
            onToggle={() => setFontSizeMode(fontSizeMode === 'large' ? 'normal' : 'large')}
          />
          <PreferenceRow
            icon={<AudioLines className="size-4 text-slate-500" />}
            title="语音播报"
            description="AI 助手的答复自动读出来，忙着手头活不用盯着屏幕看；仪表盘 AI 面板上的喇叭按钮控制的是同一个开关"
            checked={ttsOn}
            onToggle={toggleTts}
          />
        </CardContent>
      </Card>

      {/* 数据备份 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <DatabaseBackup className="size-5 text-brand-500" />
            数据备份
          </CardTitle>
          <CardDescription>
            系统每天凌晨 3:00 自动备份，并在软件正常退出前再备份一次，只保留最近 7 份。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-4">
            <Button
              onClick={handleBackup}
              disabled={!backend || backing}
              className="bg-brand-600 hover:bg-brand-700"
            >
              <DatabaseBackup className="size-4" />
              {backing ? '备份中...' : '立即备份'}
            </Button>
            <Button
              variant="outline"
              onClick={handleRestore}
              disabled={!backend || restoring || backing}
            >
              {restoring ? '恢复中...' : '从备份恢复'}
            </Button>
            <span className="text-sm text-muted-foreground">
              {!backend
                ? '浏览器开发模式使用 mock 数据，备份功能请在 Electron 应用中使用'
                : info?.lastBackupAt
                  ? `最近备份：${formatDateTime(new Date(info.lastBackupAt).toISOString())}`
                  : '还没有备份过，建议现在备份一次'}
            </span>
          </div>
          {backupResult && (
            <div className="flex items-start gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <span>
                备份成功：<span className="font-mono text-xs">{backupResult}</span>
              </span>
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}
        </CardContent>
      </Card>

      {/* 手机看店：局域网只读服务，微信扫码看账 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <QrCode className="size-5 text-brand-500" />
            手机看店
            {serverStatus?.running && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
                运行中
              </span>
            )}
          </CardTitle>
          <CardDescription>
            出门或在家用手机看店里的账：今日营业额、低库存、查货位、今日流水。只读，手机上改不了数据。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <PreferenceRow
            icon={<QrCode className="size-4 text-slate-500" />}
            title="手机看店服务"
            description="开启后，连同一个 WiFi 的手机扫码就能看店里的账；关掉后手机立即访问不了"
            checked={!!serverStatus?.enabled}
            onToggle={() => void handleServerToggle()}
          />
          {serverStatus?.running && serverStatus.url && (
            <div className="flex flex-wrap items-start gap-5 rounded-lg bg-slate-50 px-4 py-4">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="手机看店二维码" className="size-[180px] rounded-lg border bg-white p-1" />
              ) : (
                <div className="flex size-[180px] items-center justify-center rounded-lg border bg-white text-xs text-muted-foreground">
                  二维码生成中…
                </div>
              )}
              <div className="space-y-2 text-sm">
                <div className="font-medium text-slate-800">微信「扫一扫」扫这个二维码，直接打开看店页面</div>
                <div className="text-muted-foreground">
                  服务地址：<span className="font-mono text-xs text-brand-700">{`http://${serverStatus.ip}:${serverStatus.port}`}</span>
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>· 手机要和这台电脑连同一个 WiFi 才打得开。</p>
                  <p>· 首次使用如弹出 Windows 防火墙提示，请点「允许」。</p>
                  <p>· 页面每 30 秒自动刷新；可以把页面「添加到主屏幕」，像个小的看店 App。</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRegenerateToken}
                  disabled={serverBusy}
                >
                  <RefreshCw className="size-3.5" />
                  重新生成访问密码
                </Button>
                <p className="text-xs text-muted-foreground">
                  怀疑链接泄露时点这个；旧二维码和手机书签会一起失效。
                </p>
              </div>
            </div>
          )}
          {serverStatus?.enabled && !serverStatus.running && (
            <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              服务已开启但当前没在运行{serverStatus.error ? `：${serverStatus.error}` : '（端口可能被占用，重启软件试试）'}
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI 助手（BYOK） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-5 text-brand-500" />
            AI 助手（Kimi）
            {aiConfigured && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
                已激活
              </span>
            )}
          </CardTitle>
          <CardDescription>
            填入你自己的 Kimi API Key 即可激活 AI 打烊日报。Key 加密保存在本机；
            你的库存和经营数据不出本机，只有日报数字会发给 Kimi 润色成一句话。
            不填也不影响任何进销存功能。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={aiConfigured ? '已保存 Key（输入新 Key 可替换）' : '粘贴 sk- 开头的 API Key'}
              className="w-96 font-mono text-xs"
              disabled={!backend}
            />
            <Button
              onClick={handleSaveKey}
              disabled={!backend || aiBusy || !keyInput.trim() || !online}
              title={online ? undefined : '当前离线，验证 Key 需要联网'}
              className="bg-brand-600 hover:bg-brand-700"
            >
              {aiBusy ? '验证中...' : '保存并验证'}
            </Button>
            {aiConfigured && (
              <Button variant="outline" onClick={handleClearKey}>
                停用并删除 Key
              </Button>
            )}
            {!online && (
              <span className="text-xs text-amber-600">当前离线：AI 相关操作需要联网后可用</span>
            )}
          </div>
          {aiMessage && (
            <div
              className={`rounded-lg px-4 py-3 text-sm ${
                aiMessage.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}
            >
              {aiMessage.text}
            </div>
          )}
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>没有 Key？点这里一分钟免费申请（新用户有赠送额度，日常用每月几块钱）：</p>
            <button
              className="inline-flex items-center gap-1 text-brand-600 hover:underline"
              onClick={() => backend?.invoke('app:openExternal', 'https://platform.moonshot.cn/console/api-keys')}
            >
              <ExternalLink className="size-3" />
              打开 Kimi 开放平台申请页
            </button>
            <p>没填 Key 或断网时，AI 功能自动隐藏，进销存功能不受影响。</p>
          </div>
        </CardContent>
      </Card>

      {/* 语音识别模型（本地离线识别） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mic className="size-5 text-brand-500" />
            语音识别模型
            {voice.ready === true && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
                已就绪
              </span>
            )}
          </CardTitle>
          <CardDescription>
            AI 助手"按住说话"用的识别模型，下载后完全离线识别，没网也能用，说话内容不出本机。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {voice.ready === true ? (
            <div className="flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
              <CheckCircle2 className="size-4 shrink-0" />
              模型已就绪（约78MB），按住说话走本地离线识别。
            </div>
          ) : voice.downloading ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 className="size-4 animate-spin" />
                正在下载语音识别模型… {voice.percent}%
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full bg-brand-600 transition-all"
                  style={{ width: `${voice.percent}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={voice.startDownload}
                disabled={!backend || !online}
                title={online ? undefined : '当前离线，下载模型需要联网'}
                className="bg-brand-600 hover:bg-brand-700"
              >
                下载模型（约78MB）
              </Button>
              <span className="text-sm text-muted-foreground">
                {voice.ready === null
                  ? '正在检查模型状态…'
                  : '未下载：按住说话暂时走在线识别，下载后自动切换为离线识别'}
              </span>
            </div>
          )}
          {voice.error && !voice.downloading && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{voice.error}</div>
          )}
        </CardContent>
      </Card>

      {/* 语音合成模型（本地离线播报） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AudioLines className="size-5 text-brand-500" />
            语音合成模型
            {ttsModel.ready === true && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
                已就绪
              </span>
            )}
          </CardTitle>
          <CardDescription>
            AI 助手"语音播报"用的合成模型，下载后完全离线合成，没网也能播报，比系统自带语音更自然。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {ttsModel.ready === true ? (
            <div className="flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
              <CheckCircle2 className="size-4 shrink-0" />
              模型已就绪（约42MB），语音播报走本地离线合成。
            </div>
          ) : ttsModel.downloading ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Loader2 className="size-4 animate-spin" />
                正在下载语音合成模型… {ttsModel.percent}%
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full bg-brand-600 transition-all"
                  style={{ width: `${ttsModel.percent}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={ttsModel.startDownload}
                disabled={!backend || !online}
                title={online ? undefined : '当前离线，下载模型需要联网'}
                className="bg-brand-600 hover:bg-brand-700"
              >
                下载模型（约42MB）
              </Button>
              <span className="text-sm text-muted-foreground">
                {ttsModel.ready === null
                  ? '正在检查模型状态…'
                  : '未下载：语音播报暂时用系统自带语音，下载后自动切换为离线合成'}
              </span>
            </div>
          )}
          {ttsModel.error && !ttsModel.downloading && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{ttsModel.error}</div>
          )}
        </CardContent>
      </Card>

      {/* 唤醒词监听（实验，默认关闭） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Ear className="size-5 text-brand-500" />
            唤醒词监听（实验）
            {kws.ready === true && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
                模型已就绪
              </span>
            )}
          </CardTitle>
          <CardDescription>
            喊「小杜小杜」就能唤醒 AI 助手并自动开始录音，手上有活不用点鼠标。
            实验功能，默认关闭；开启后麦克风会一直保持开启（系统会显示麦克风使用指示），说话内容只在本机检测，不出本机。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {kws.ready !== true && (
            kws.downloading ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="size-4 animate-spin" />
                  正在下载唤醒词模型… {kws.percent}%
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full bg-brand-600 transition-all"
                    style={{ width: `${kws.percent}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={kws.startDownload}
                  disabled={!backend || !online}
                  title={online ? undefined : '当前离线，下载模型需要联网'}
                  className="bg-brand-600 hover:bg-brand-700"
                >
                  下载唤醒词模型（约5MB）
                </Button>
                <span className="text-sm text-muted-foreground">
                  {kws.ready === null ? '正在检查模型状态…' : '先下载模型，才能开启唤醒词监听'}
                </span>
              </div>
            )
          )}
          {kws.error && !kws.downloading && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{kws.error}</div>
          )}
          <div className={kws.ready === true ? '' : 'pointer-events-none opacity-50'}>
            <PreferenceRow
              icon={<Ear className="size-4 text-slate-500" />}
              title="监听「小杜小杜」"
              description="开启后麦克风一直保持开启，随时喊「小杜小杜」唤起 AI 助手；关闭后立即释放麦克风"
              checked={wakeOn}
              onToggle={() => void toggleWake()}
            />
          </div>
          {wakeOn && (
            <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
              监听已开启：麦克风保持开启中，喊「小杜小杜」试试。不用时建议关掉省电省资源。
            </div>
          )}
          {wakeError && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{wakeError}</div>
          )}
        </CardContent>
      </Card>

      {/* 意见反馈 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquarePlus className="size-5 text-brand-500" />
            意见反馈
          </CardTitle>
          <CardDescription>
            用得不顺手、想要新功能，写两句直接发给我们。提交时会自动带上软件版本和系统信息，方便排查。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            value={fbMessage}
            onChange={(e) => setFbMessage(e.target.value)}
            placeholder="哪里不好用？想要什么功能？写几句就行"
            rows={4}
            disabled={!backend}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={fbContact}
              onChange={(e) => setFbContact(e.target.value)}
              placeholder="留个电话/微信，方便我们回复你（选填）"
              className="w-80"
              disabled={!backend}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={fbWebhook}
              onChange={(e) => {
                setFbWebhook(e.target.value)
                localStorage.setItem('fi-feedback-webhook', e.target.value)
              }}
              placeholder="反馈接收地址（找阿杜要这个地址）"
              className="w-96 font-mono text-xs"
              disabled={!backend}
            />
            <Button
              onClick={handleSendFeedback}
              disabled={!backend || fbBusy || !fbWebhook.trim() || !fbMessage.trim()}
              title={!fbWebhook.trim() ? '先填反馈接收地址（找阿杜要）' : undefined}
              className="bg-brand-600 hover:bg-brand-700"
            >
              {fbBusy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {fbBusy ? '发送中...' : '提交反馈'}
            </Button>
            {!fbWebhook.trim() && (
              <span className="text-xs text-amber-600">还没填反馈接收地址，找阿杜要了填上就能提交</span>
            )}
          </div>
          {fbResult && (
            <div
              className={`flex items-start gap-2 rounded-lg px-4 py-3 text-sm ${
                fbResult.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}
            >
              {fbResult.ok && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
              {fbResult.text}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 数据位置 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="size-5 text-brand-500" />
            数据位置
          </CardTitle>
          <CardDescription>
            数据库为单文件 SQLite（WAL 模式），迁移门店电脑时复制整个数据目录即可。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {info ? (
            <div className="space-y-2 text-sm">
              <div className="grid grid-cols-[90px_1fr] gap-y-2">
                <span className="text-muted-foreground">数据库</span>
                <span className="font-mono text-xs break-all">{info.dbPath}</span>
                <span className="text-muted-foreground">备份目录</span>
                <span className="font-mono text-xs break-all">{info.backupDir}</span>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {backend ? '读取中...' : '浏览器开发模式暂无本地数据文件'}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 关于 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Info className="size-5 text-brand-500" />
            关于
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-slate-600">
          <div>渔具库存 AI 管理系统 v{APP_VERSION} · 阿杜 © 2026</div>
          <div className="text-xs text-muted-foreground">
            Electron + React + SQLite（WAL）· 本地单机部署 · 断电不丢数据
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** 偏好设置行：标题 + 说明 + 右侧开关（整行可点） */
function PreferenceRow({
  icon,
  title,
  description,
  checked,
  onToggle,
}: {
  icon: ReactNode
  title: string
  description: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-slate-50"
    >
      {icon}
      <span className="flex-1">
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-brand-600' : 'bg-slate-300'
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}
