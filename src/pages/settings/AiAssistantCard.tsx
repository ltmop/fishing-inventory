import { ExternalLink, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface AiAssistantCardProps {
  hasBackend: boolean
  aiConfigured: boolean
  keyInput: string
  onKeyInputChange: (v: string) => void
  aiBusy: boolean
  aiMessage: { ok: boolean; text: string } | null
  online: boolean
  onSaveKey: () => void
  onClearKey: () => void
  onOpenExternal: (url: string) => void
}

/** AI 助手（BYOK）卡片：填 Kimi API Key 激活，Key 加密存本机 */
export function AiAssistantCard({
  hasBackend,
  aiConfigured,
  keyInput,
  onKeyInputChange,
  aiBusy,
  aiMessage,
  online,
  onSaveKey,
  onClearKey,
  onOpenExternal,
}: AiAssistantCardProps) {
  return (
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
            onChange={(e) => onKeyInputChange(e.target.value)}
            placeholder={aiConfigured ? '已保存 Key（输入新 Key 可替换）' : '粘贴 sk- 开头的 API Key'}
            className="w-96 font-mono text-xs"
            disabled={!hasBackend}
          />
          <Button
            onClick={onSaveKey}
            disabled={!hasBackend || aiBusy || !keyInput.trim() || !online}
            title={online ? undefined : '当前离线，验证 Key 需要联网'}
            className="bg-brand-600 hover:bg-brand-700"
          >
            {aiBusy ? '验证中...' : '保存并验证'}
          </Button>
          {aiConfigured && (
            <Button variant="outline" onClick={onClearKey}>
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
            onClick={() => onOpenExternal('https://platform.moonshot.cn/console/api-keys')}
          >
            <ExternalLink className="size-3" />
            打开 Kimi 开放平台申请页
          </button>
          <p>没填 Key 或断网时，AI 功能自动隐藏，进销存功能不受影响。</p>
        </div>
      </CardContent>
    </Card>
  )
}
