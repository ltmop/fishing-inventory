// 授权系统：Ed25519 非对称验签 + 年费订阅制
// 铁律：try/catch 全部包裹，任何环节挂掉静默降级为 free 版——绝不阻断软件启动
// 公钥嵌客户端只验签，私钥只在老板的 scripts/gen-license.js 发码器里

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Ed25519 公钥（PEM 格式，嵌在代码里；私钥绝不近客户端）
// 生成命令：openssl genpkey -algorithm ed25519 -out private.pem && openssl pkey -in private.pem -pubout -out public.pem
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAo9q3xL8kF2mN1pV7bW6cR0eT4yU5hJ2dA8fG3sH1wK0=
-----END PUBLIC KEY-----`

// 备用：如果找不到公钥文件，回退到内置占位公钥（老板换成真实公钥后删除此注释行）
// 占位公钥的验签永远失败 → 所有用户都是免费版，安全兜底
const PUBLIC_KEY_FILE = path.join(os.homedir(), '.fishing-inventory', 'license-public.pem')

/** 计算机器指纹：hostname + CPU 型号 + 网络 MAC → SHA256 前12位大写 */
export function machineFingerprint(): string {
  try {
    const parts = [
      os.hostname(),
      os.cpus()[0]?.model ?? 'unknown',
    ]
    // 加第一块非回环网卡 MAC
    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
      for (const iface of nets[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          parts.push(iface.mac.replace(/:/g, ''))
          break
        }
      }
    }
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12).toUpperCase()
  } catch {
    return 'UNKNOWN0000'
  }
}

interface LicenseInfo {
  activated: boolean
  level: 'free' | 'pro'
  expiresAt: string | null // ISO 8601
  machineId: string
  daysLeft: number | null
}

/** 读取公钥（优先外部文件，可热升级） */
function loadPublicKey(): string {
  try {
    if (fs.existsSync(PUBLIC_KEY_FILE)) {
      return fs.readFileSync(PUBLIC_KEY_FILE, 'utf8')
    }
  } catch { /* 读不到文件用内置 */ }
  return PUBLIC_KEY_PEM
}

/** Ed25519 验签激活码是否有效 */
export function verifyLicenseCode(code: string, machineId: string): { valid: boolean; level?: 'pro'; expiresAt?: string; error?: string } {
  try {
    // 格式：ADU-FISH-{指纹前6位}-{到期日YYMMDD}-{产品等级}-{Ed25519签名B64}
    const parts = code.split('-')
    if (parts.length < 6 || parts[0] !== 'ADU' || parts[1] !== 'FISH') {
      return { valid: false, error: '激活码格式不正确' }
    }

    const codeFingerprint = parts[2] // 6位十六进制
    const expireYYMMDD = parts[3]    // YYMMDD
    const level = parts[4]           // P=Pro
    const signatureB64 = parts.slice(5).join('-') // 签名可能含 - 号

    // 校验机器指纹
    if (codeFingerprint.toUpperCase() !== machineId.slice(0, 6)) {
      return { valid: false, error: '激活码与当前机器不匹配，请确认机器ID' }
    }

    // 构造被签名消息
    const message = `ADU-FISH-${codeFingerprint}-${expireYYMMDD}-${level}`
    const signature = Buffer.from(signatureB64, 'base64')

    // Ed25519 验签
    const pubKey = loadPublicKey()
    const isValid = crypto.verify(
      null,
      Buffer.from(message),
      pubKey,
      signature,
    )

    if (!isValid) {
      return { valid: false, error: '激活码无效' }
    }

    // 解析到期日
    const yy = parseInt(expireYYMMDD.slice(0, 2), 10) + 2000
    const mm = parseInt(expireYYMMDD.slice(2, 4), 10) - 1
    const dd = parseInt(expireYYMMDD.slice(4, 6), 10)
    const expiresAt = new Date(yy, mm, dd, 23, 59, 59).toISOString()

    return { valid: true, level: 'pro', expiresAt }
  } catch (e) {
    return { valid: false, error: e.message }
  }
}

const LICENSE_FILE = 'license.json'

/** 读取本地授权状态 */
export function loadLicense(dataDir: string): LicenseInfo {
  const mid = machineFingerprint()
  try {
    const raw = fs.readFileSync(path.join(dataDir, LICENSE_FILE), 'utf8')
    const saved = JSON.parse(raw)
    const now = Date.now()
    const expiresAt = saved.expiresAt ? new Date(saved.expiresAt).getTime() : 0

    if (saved.machineId !== mid) {
      return { activated: false, level: 'free', expiresAt: null, machineId: mid, daysLeft: null }
    }

    if (now > expiresAt) {
      return { activated: false, level: 'free', expiresAt: saved.expiresAt, machineId: mid, daysLeft: 0 }
    }

    const daysLeft = Math.ceil((expiresAt - now) / (24 * 3600 * 1000))
    return { activated: true, level: saved.level, expiresAt: saved.expiresAt, machineId: mid, daysLeft }
  } catch {
    return { activated: false, level: 'free', expiresAt: null, machineId: mid, daysLeft: null }
  }
}

/** 激活授权（验签 + 写 license.json） */
export function activateLicense(dataDir: string, code: string): { ok: boolean; error?: string; license?: LicenseInfo } {
  const mid = machineFingerprint()
  const result = verifyLicenseCode(code, mid)

  if (!result.valid) {
    return { ok: false, error: result.error }
  }

  const license: LicenseInfo = {
    activated: true,
    level: result.level ?? 'pro',
    expiresAt: result.expiresAt ?? null,
    machineId: mid,
    daysLeft: null,
  }

  const now = Date.now()
  const exp = new Date(license.expiresAt!).getTime()
  license.daysLeft = Math.ceil((exp - now) / (24 * 3600 * 1000))

  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, LICENSE_FILE), JSON.stringify(license), 'utf8')
    return { ok: true, license }
  } catch (e) {
    return { ok: false, error: `保存授权文件失败: ${e.message}` }
  }
}
