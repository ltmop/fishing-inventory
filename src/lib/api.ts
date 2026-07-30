// 后端桥：Electron 环境经 preload 暴露 window.fi 走 IPC；
// 纯浏览器 dev（npm run dev）没有 preload，backend 为 null，store 自动回退到本地 mock 逻辑
export interface VoiceProgress {
  file: string
  received: number
  total: number
  percent: number
}

export interface FiBridge {
  invoke(channel: string, payload?: unknown): Promise<any>
  /** 订阅语音模型下载进度，返回取消订阅函数（preload 暴露，浏览器 dev 模式没有） */
  onVoiceProgress?(callback: (p: VoiceProgress) => void): () => void
  /** 订阅语音合成模型下载进度 */
  onTtsProgress?(callback: (p: VoiceProgress) => void): () => void
  /** 订阅唤醒词模型下载进度 */
  onKwsProgress?(callback: (p: VoiceProgress) => void): () => void
}

declare global {
  interface Window {
    fi?: FiBridge
  }
}

export const backend: FiBridge | null =
  typeof window !== 'undefined' && window.fi ? window.fi : null
