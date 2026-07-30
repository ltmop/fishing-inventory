// 自动备份：每天凌晨 3:00 + 软件正常退出前 + 设置页手动按钮
// 备份路径 %APPDATA%/fishing-inventory/backup/，保留最近 7 份
// 备份前先 checkpoint(TRUNCATE)，保证拷贝的是完整单文件数据库
import fs from 'node:fs'
import path from 'node:path'

const KEEP = 7

export function backupNow(db, dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const dest = path.join(backupDir, backupName())
  fs.copyFileSync(dbPath, dest)
  // 校验备份完整性：坏备份（空文件/大小不符）直接删掉并抛错，不留假备份
  verifyBackup(dbPath, dest)
  rotateBackups(backupDir)
  return dest
}

// 设置页手动备份走异步拷贝，避免大库 copyFileSync 卡住主进程 UI；
// 定时/退出备份必须保持同步：退出阶段事件循环即将结束，异步拷贝可能来不及写完
export async function backupNowAsync(db, dbPath, backupDir) {
  await fs.promises.mkdir(backupDir, { recursive: true })
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const dest = path.join(backupDir, backupName())
  await fs.promises.copyFile(dbPath, dest)
  // 校验不过时 verifyBackup 会删坏备份并抛错，错误经 IPC 抛回设置页展示
  verifyBackup(dbPath, dest)
  rotateBackups(backupDir)
  return dest
}

function backupName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `inventory_backup_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`
}

// 备份后校验：目标文件非空且与源文件大小一致，否则删除坏备份并抛错
function verifyBackup(dbPath, dest) {
  const srcSize = fs.statSync(dbPath).size
  const destSize = fs.statSync(dest).size
  if (destSize <= 0 || destSize !== srcSize) {
    fs.rmSync(dest, { force: true })
    throw new Error(`备份校验失败：源 ${srcSize} 字节，备份 ${destSize} 字节，已删除不完整备份`)
  }
}

function rotateBackups(backupDir) {
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith('inventory_backup_') && f.endsWith('.db'))
    .sort()
  // 文件名含时间戳，字典序即时间序；删掉最旧的
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    fs.rmSync(path.join(backupDir, f), { force: true })
  }
}

/** 调度每天凌晨 3:00 自动备份，返回停止函数。
 * onError：备份失败时回调（由 main.js 负责弹错误框 + 写 backup-error.log），
 * 不传则只打 console（保持原行为，便于无 Electron 环境测试） */
export function scheduleDailyBackup(db, dbPath, backupDir, onError = null) {
  let timer = null
  const arm = () => {
    const next = new Date()
    next.setHours(3, 0, 0, 0)
    if (next <= new Date()) next.setDate(next.getDate() + 1)
    timer = setTimeout(() => {
      try {
        backupNow(db, dbPath, backupDir)
      } catch (e) {
        console.error('[backup] 自动备份失败:', e)
        try {
          onError?.(e)
        } catch {
          // 错误通知本身失败不再抛，避免影响下一轮调度
        }
      }
      arm()
    }, next.getTime() - Date.now())
  }
  arm()
  return () => clearTimeout(timer)
}

/**
 * 从备份文件恢复数据库：把备份文件拷贝覆盖 dbPath。
 * 只负责文件层面的恢复（校验 + 兜底留底 + 覆盖），不重启应用——
 * 调用方（main.js 的 backup:restore handler）必须在恢复后立刻
 * app.relaunch() + app.exit(0)，让进程重开新库，且退出时不得再对旧连接
 * 做 checkpoint/备份（旧连接的内存视图已与新文件脱节）。
 * @param {DatabaseSync} db 当前打开的数据库连接
 * @param {string} backupPath 用户选择的备份文件绝对路径
 * @param {string} dbPath 当前库文件绝对路径
 */
export function restoreBackup(db, backupPath, dbPath) {
  // 校验备份文件存在且非空，拒绝拿坏文件覆盖好库
  if (!fs.existsSync(backupPath)) {
    throw new Error(`备份文件不存在：${backupPath}`)
  }
  if (fs.statSync(backupPath).size <= 0) {
    throw new Error(`备份文件为空，无法恢复：${backupPath}`)
  }
  // 先把 WAL 落盘截断，保证 .pre-restore.bak 留底的是完整单文件库
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  // 兜底留底：覆盖前把当前库拷一份 .pre-restore.bak（参照 db.js 迁移留底的模式），
  // 恢复选错文件时可手动改回 data.db
  fs.copyFileSync(dbPath, dbPath + '.pre-restore.bak')
  fs.copyFileSync(backupPath, dbPath)
}
