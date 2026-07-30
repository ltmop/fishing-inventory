// 意见反馈：渲染端提交 → 主进程 POST 到飞书自定义机器人 webhook
// 注意：飞书自定义机器人有频率限制（约 100 条/分钟）和安全设置（自定义关键词/签名校验），
// 若机器人配了关键词，下面文案里的「意见反馈」必须包含该关键词，否则会被拒收
import fs from 'node:fs'
import os from 'node:os'

let logFilePath = null
let appVersion = ''

export function initFeedback({ logFile, version }) {
  logFilePath = logFile
  appVersion = version
}

/** 读 backup-error.log 末尾几行随反馈附上；文件不存在/读失败都静默返回 null */
function readLogTail(maxLines = 20) {
  try {
    if (!logFilePath || !fs.existsSync(logFilePath)) return null
    const text = fs.readFileSync(logFilePath, 'utf8').trim()
    if (!text) return null
    return text.split('\n').slice(-maxLines).join('\n')
  } catch {
    return null
  }
}

export async function sendFeedback(payload = {}) {
  const webhook = typeof payload.webhook === 'string' ? payload.webhook.trim() : ''
  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  const contact = typeof payload.contact === 'string' ? payload.contact.trim() : ''
  if (!/^https:\/\//.test(webhook)) return { ok: false, reason: '反馈接收地址无效' }
  if (!message) return { ok: false, reason: '反馈内容为空' }

  const lines = [
    '【渔具库存·意见反馈】',
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `软件版本：v${appVersion}`,
    `系统：Windows ${os.release()} (${os.arch()})`,
    contact ? `联系方式：${contact}` : null,
    '',
    message,
  ].filter((l) => l !== null)
  const logTail = readLogTail()
  if (logTail) lines.push('', '—— 最近错误日志 ——', logTail)

  // 30s 超时，网络差时不能让设置页一直转圈
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: lines.join('\n') } }),
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const data = await res.json().catch(() => null)
    // 飞书机器人响应：新版 {code:0} / 旧版 {StatusCode:0} 才算真正送达
    const code = data?.code ?? data?.StatusCode
    if (code != null && code !== 0) {
      return { ok: false, reason: data?.msg || data?.StatusMessage || '机器人拒收' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message || '网络错误' }
  } finally {
    clearTimeout(timer)
  }
}
