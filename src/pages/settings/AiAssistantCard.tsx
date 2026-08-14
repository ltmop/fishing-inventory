import { ExternalLink, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Provider {
  key: string
  name: string
  model: string
  keyPage: string
  configured: boolean
}

interface AiAssistantCardProps {
  hasBackend: boolean
  aiConfigured: boolean
  keyInput: string
  onKeyInputChange: (v: string) => void
  aiBusy: boolean
  aiMessage: { ok: boolean; text: string } | null
  online: boolean
  providers: Provider[]
  currentProvider: string
  onProviderChange: (p: string) => void
  onSaveKey: () => void
  onClearKey: () => void
  onOpenExternal: (url: string) => void
}

/** AI 助手（多模型提供商）卡片：选主力模型 → 填该模型的 Key 激活 */
export function AiAssistantCard({
  hasBackend,
  aiConfigured,
  keyInput,
  onKeyInputChange,
  aiBusy,
  aiMessage,
  online,
  providers,
  currentProvider,
  onProviderChange,
  onSaveKey,
  onClearKey,
  onOpenExternal,
}: AiAssistantCardProps) {
  const cur = providers.find((p) => p.key === currentProvider)
  const curName = cur?.name ?? currentProvider
  const curPage = cur?.keyPage ?? ''

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-5 text-brand-500" />
          AI 助手
          {aiConfigured ? (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-normal text-green-700">
              已激活（{curName}）
            </span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-normal text-amber-700">
              未配置
            </span>
          )}
        </CardTitle>
        <CardDescription>
          选一个模型作为 AI 主力（Kimi/豆包/GLM/通义都能选），填它的 API Key 激活 AI 打烊日报。
          Key 加密保存在本机，库存和经营数据不出本机。不填也不影响任何进销存功能。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 模型提供商选择 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-sm font-medium text-muted-foreground">主力模型</div>
          <Select value={currentProvider} onValueChange={onProviderChange} disabled={!hasBackend || aiBusy}>
            <SelectTrigger className="w-60">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.name}（{p.configured ? '已配Key' : '未配Key'}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 填当前模型的 Key */}
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="password"
            value={keyInput}
            onChange={(e) => onKeyInputChange(e.target.value)}
            placeholder={aiConfigured ? `已保存 ${curName} 的 Key（输入新 Key 可替换）` : `粘贴 ${curName} 的 API Key`}
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
          <p>没有 {curName} 的 Key？点这里申请（新用户有赠送额度）：</p>
          <button
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
            onClick={() => curPage && onOpenExternal(curPage)}
          >
            <ExternalLink className="size-3" />
            打开 {curName} 申请页
          </button>
          <p>切换模型后，AI 对话、打烊日报、进货单识别都会用选中的模型。没填 Key 或断网时 AI 功能自动隐藏。</p>
        </div>
      </CardContent>
    </Card>
  )
}
