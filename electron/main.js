// 主进程：窗口生命周期 + 数据库装配 + IPC 注册 + 退出收尾
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, finalCheckpoint } from './db.js'
import * as commands from './commands.js'
import * as ai from './ai.js'
import * as voice from './voice.js'
import * as tts from './tts.js'
import * as kws from './kws.js'
import { MODEL_NAME, ensureModel } from './modelManager.js'
import { TTS_MODEL_NAME, ensureTtsModel } from './ttsModelManager.js'
import { KWS_MODEL_NAME, ensureKwsModel } from './kwsModelManager.js'
import { backupNow, backupNowAsync, scheduleDailyBackup, restoreBackup } from './backup.js'
import * as feedback from './feedback.js'
import { createInventoryServer } from './server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 单实例：工控机/门店电脑上防止双击开出两个进程写同一个库
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const dataDir = path.join(app.getPath('appData'), 'fishing-inventory')
const dbPath = path.join(dataDir, 'data.db')
const backupDir = path.join(dataDir, 'backup')
ai.initAi(dataDir)
// 离线语音识别模型目录：首次启动后可经 voice:download 通道下载到本机
const voiceModelDir = path.join(dataDir, 'models', MODEL_NAME)
voice.initVoice(voiceModelDir)
// 模型下载中的进行中 Promise，防止渲染端连点触发并发下载
let voiceDownloading = null
// 离线语音合成（TTS）与唤醒词（KWS）模型：与识别模型平级目录、独立状态、独立下载通道
const ttsModelDir = path.join(dataDir, 'models', TTS_MODEL_NAME)
tts.initTts(ttsModelDir)
let ttsDownloading = null
const kwsModelDir = path.join(dataDir, 'models', KWS_MODEL_NAME)
kws.initKws(kwsModelDir)
let kwsDownloading = null

/** 注册"模型下载 + 进度推送"通道的公共骨架（voice/tts/kws 三模型同一模式） */
function registerModelDownload({ channel, progressEvent, isDownloading, setDownloading, ensure, dir, onDone }) {
  ipcMain.handle(channel, async (e) => {
    if (isDownloading()) return isDownloading()
    const p = ensure(dir, (prog) => {
      if (!e.sender.isDestroyed()) {
        e.sender.send(progressEvent, {
          file: prog.file,
          received: prog.received,
          total: prog.total,
          percent: Math.min(100, Math.round((prog.received / prog.total) * 100)),
        })
      }
    })
      .then((r) => {
        if (r.ok) onDone?.()
        return r
      })
      .finally(() => setDownloading(null))
    setDownloading(p)
    return p
  })
}

let db = null
let mainWindow = null
// 手机看店：局域网只读 HTTP 服务，app ready 且 db 打开后创建
let inventoryServer = null
// 恢复备份后为 true：旧 db 连接的视图已与被覆盖的库文件脱节，
// 退出收尾必须跳过备份/checkpoint，否则会把旧内存视图写回刚恢复的文件
let restoring = false

// 备份失败统一上报：写 backup-error.log 留痕（与退出备份同一模式）+ 弹错误框
function reportBackupError(label, e) {
  console.error(`[backup] ${label}:`, e)
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'backup-error.log'),
      `[${new Date().toISOString()}] ${label}: ${e.stack || e.message}\n`,
    )
  } catch {
    // 日志写不进去就算了，不再抛错
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '备份失败',
      message: `${label}`,
      detail: `错误信息：${e.message}\n失败记录已写入：${path.join(app.getPath('userData'), 'backup-error.log')}`,
    })
  }
}

function registerIpc() {
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (_e, payload) => fn(db, payload ?? {}))

  handle('data:loadAll', (d) => commands.loadAll(d))
  handle('product:create', (d, p) => commands.createProduct(d, p))
  handle('product:update', (d, p) => commands.updateProduct(d, p.id, p))
  handle('product:delete', (d, p) => commands.deleteProduct(d, p.id))
  handle('inbound:create', (d, p) => commands.createInbound(d, p))
  handle('outbound:confirm', (d, p) => commands.confirmOutbound(d, p))
  handle('outbound:return', (d, p) => commands.createReturn(d, p))
  handle('outbound:exchange', (d, p) => commands.createExchange(d, p))
  handle('supplier:create', (d, p) => commands.createSupplier(d, p))
  handle('supplier:update', (d, p) => commands.updateSupplier(d, p.id, p))
  handle('supplier:delete', (d, p) => commands.deleteSupplier(d, p.id))
  handle('stocktake:create', (d, p) => commands.createStockTake(d, p))
  handle('stocktake:updateItem', (d, p) => commands.updateStockTakeItem(d, p))
  handle('stocktake:complete', (d, p) => commands.completeStockTake(d, p.takeId))
  handle('stocktake:submit', (d, p) => commands.submitStockTake(d, p))
  handle('import:batch', (d, p) => commands.importBatch(d, p))
  // 赊账包：客户档案 / 还款 / 对账单
  handle('customer:create', (d, p) => commands.createCustomer(d, p))
  handle('customer:update', (d, p) => commands.updateCustomer(d, p))
  handle('customer:delete', (d, p) => commands.deleteCustomer(d, p))
  handle('customer:list', (d) => commands.listCustomers(d))
  handle('customer:statement', (d, p) => commands.customerStatement(d, p))
  handle('payment:record', (d, p) => commands.recordPayment(d, p))
  // 采购订单：建单/列表/详情/收货入库/取消
  handle('po:create', (d, p) => commands.createPurchaseOrder(d, p))
  handle('po:list', (d, p) => commands.listPurchaseOrders(d, p))
  handle('po:detail', (d, p) => commands.purchaseOrderDetail(d, p))
  handle('po:receive', (d, p) => commands.receivePurchaseOrder(d, p))
  handle('po:cancel', (d, p) => commands.cancelPurchaseOrder(d, p))
  // 多级定价：档次价设/删/查（商品列表的各档价格随 data:loadAll 的 priceTiers 下发）
  handle('priceTier:set', (d, p) => commands.setPriceTier(d, p))
  handle('priceTier:delete', (d, p) => commands.deletePriceTier(d, p))
  handle('priceTier:list', (d, p) => commands.getPriceTiers(d, p))
  handle('backup:now', (d) => backupNowAsync(d, dbPath, backupDir))
  // 从备份恢复：选文件 → 二次确认 → 覆盖 data.db → 重启应用让新库生效
  ipcMain.handle('backup:restore', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '选择要恢复的备份文件',
      defaultPath: backupDir,
      filters: [
        { name: '数据库备份', extensions: ['db', 'bak'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (canceled || filePaths.length === 0) return { ok: false, cancelled: true }
    const backupPath = filePaths[0]
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '从备份恢复',
      message: '确定要用这份备份替换当前的全部数据吗？',
      detail:
        `当前店里的数据会被备份里的内容整个替换掉。` +
        `替换前系统会自动把当前数据留底（data.db.pre-restore.bak），选错了还能找回来。` +
        `恢复完成后软件会自动重启。\n\n备份文件：${backupPath}`,
      buttons: ['取消', '确认恢复并重启'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response !== 1) return { ok: false, cancelled: true }
    restoreBackup(db, backupPath, dbPath)
    restoring = true
    app.relaunch()
    app.exit(0)
    // app.exit 同步终止进程，正常走不到这里
    return { ok: true }
  })
  // AI 助手（BYOK，Kimi）：密钥管理与一句话日报，全部失败静默降级
  handle('ai:status', () => ai.aiStatus())
  handle('ai:setKey', (d, p) => ai.setApiKey(p.key))
  handle('ai:clearKey', () => ai.clearApiKey())
  handle('ai:test', () => ai.testConnection())
  handle('ai:dailySummary', (d, p) => ai.dailySummary(p.stats ?? p))
  handle('ai:chat', (d, p) => ai.agentChat(p.messages ?? []))
  handle('ai:parseInboundNote', (d, p) => ai.parseInboundNote(p))
  handle('ai:transcribe', (d, p) => ai.transcribeAudio(p))
  // 离线语音识别（sherpa-onnx 本地模型）：模型就绪时渲染端走 voice:transcribe（PCM 本地识别），
  // 未就绪时渲染端自动回退 ai:transcribe（base64 云端识别），两条通道并存互不干扰
  handle('voice:status', () => ({ ...voice.voiceStatus(), downloading: !!voiceDownloading }))
  handle('voice:transcribe', (d, p) => voice.transcribePcm(p))
  // 下载模型：进度经 webContents.send('voice:progress') 推送，渲染端 preload 订阅。
  // 下载成功立刻预加载识别器，首次按住说话不用等 1s 模型加载
  registerModelDownload({
    channel: 'voice:download',
    progressEvent: 'voice:progress',
    isDownloading: () => voiceDownloading,
    setDownloading: (p) => { voiceDownloading = p },
    ensure: ensureModel,
    dir: voiceModelDir,
    onDone: () => voice.preloadRecognizer(),
  })
  // 离线语音合成（TTS）：主进程合成 wav，渲染进程播放；失败时前端自动回退系统语音
  handle('tts:status', () => ({ ...tts.ttsStatus(), downloading: !!ttsDownloading }))
  ipcMain.handle('tts:speak', (_e, p) => tts.synthesizeAsync(p ?? {}))
  registerModelDownload({
    channel: 'tts:download',
    progressEvent: 'tts:progress',
    isDownloading: () => ttsDownloading,
    setDownloading: (p) => { ttsDownloading = p },
    ensure: ensureTtsModel,
    dir: ttsModelDir,
    onDone: () => tts.preloadTts(),
  })
  // 唤醒词（KWS）：渲染进程常驻推 16kHz PCM 小块，主进程流式检测「小杜小杜」
  handle('kws:status', () => ({ ...kws.kwsStatus(), downloading: !!kwsDownloading }))
  handle('kws:push', (d, p) => kws.pushPcm(p))
  handle('kws:reset', () => kws.resetKws())
  registerModelDownload({
    channel: 'kws:download',
    progressEvent: 'kws:progress',
    isDownloading: () => kwsDownloading,
    setDownloading: (p) => { kwsDownloading = p },
    ensure: ensureKwsModel,
    dir: kwsModelDir,
    // KWS 引擎等渲染端开启监听后首次推送时懒加载，不在下载完成时预加载
  })
    handle('ai:history', (d, p) => ai.aiHistory(p.limit ?? 50))
  handle('ai:insights', (d, p) => ai.aiInsights(p.limit ?? 50))
  // 外部链接（如 Kimi 开放平台）用系统浏览器打开，仅放行 https
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url)
  })
  // 意见反馈：POST 到飞书机器人 webhook（地址由设置页填写、随反馈一起提交）；
  // 日志指向备份错误日志，反馈时自动附末尾几行
  feedback.initFeedback({
    logFile: path.join(app.getPath('userData'), 'backup-error.log'),
    version: app.getVersion(),
  })
  handle('feedback:send', (d, p) => feedback.sendFeedback(p))
  // 手机看店：局域网只读服务的状态/开关/换 token（inventoryServer 在 app ready 后创建）
  ipcMain.handle('server:status', () => inventoryServer?.status() ?? { enabled: false, running: false })
  ipcMain.handle('server:toggle', (_e, p) =>
    inventoryServer ? inventoryServer.setEnabled(!!p?.enabled) : { enabled: false, running: false },
  )
  ipcMain.handle('server:regenerateToken', () => inventoryServer?.regenerateToken() ?? null)
  // 应用信息（设置页展示数据位置 + 最近备份时间：扫描备份目录最新文件）
  ipcMain.handle('app:info', () => {
    let lastBackupAt = null
    try {
      const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'))
      if (files.length > 0) {
        lastBackupAt = files
          .map((f) => fs.statSync(path.join(backupDir, f)).mtimeMs)
          .reduce((a, b) => Math.max(a, b), 0)
      }
    } catch {
      // 备份目录还没建（首次启动）就当没有备份
    }
    return { dataDir, dbPath, backupDir, version: app.getVersion(), lastBackupAt }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: '渔具库存 AI 管理系统',
    backgroundColor: '#e8eef6',
    // 窗口图标：electron/icon.png 随 electron/** 打进 asar，开发/打包路径一致
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用 contextBridge/ipcRenderer，可安全开沙箱
      sandbox: true,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  // 窗口关闭后清空引用，second-instance / activate 里判空才不会拿到已销毁对象
  mainWindow.on('closed', () => { mainWindow = null })
  // 安全基线：渲染进程一律禁止弹新窗口；页面内导航只放行本地页面，其余全部拦截
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL
    const isLocal = url.startsWith('file://') || (devUrl && url.startsWith(devUrl))
    if (!isLocal) event.preventDefault()
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  // 麦克风权限（按住说话/唤醒词监听用）：只对本应用自己的页面放行 'media'，其余一律拒绝
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL()
    const devUrl = process.env.VITE_DEV_SERVER_URL
    const isLocal = url.startsWith('file://') || (devUrl && url.startsWith(devUrl))
    callback(permission === 'media' && !!isLocal)
  })
    // 启动崩溃防护：数据库打不开（如老库迁移失败）时给出明确提示再退出，不无声崩溃
  try {
    db = openDatabase(dbPath)
  } catch (e) {
    const bakPath = dbPath + '.pre-migration.bak'
    const bakHint = fs.existsSync(bakPath)
      ? `\n迁移前的数据已留底：${bakPath}\n可将它改回 data.db 恢复旧数据。`
      : ''
    dialog.showErrorBox(
      '数据库打开失败',
      `程序无法启动，错误信息：${e.message}\n数据文件位置：${dbPath}${bakHint}`,
    )
    app.exit(1)
    return
  }
  ai.bindDb(db)
  registerIpc()
  // 手机看店服务：db 就绪后随备份调度一起启动；失败只告警不阻断桌面端
  inventoryServer = createInventoryServer({ db, dataDir })
  inventoryServer.start().catch((e) => console.error('[server] 启动失败:', e))
  const stopScheduler = scheduleDailyBackup(db, dbPath, backupDir, (e) =>
    reportBackupError('自动备份失败', e),
  )
  createWindow()
  // 模型已就绪则在启动时预加载识别器（约 1s），首次按住说话零等待；模型缺失静默跳过
  voice.preloadRecognizer()
  // TTS 模型已就绪同样预加载合成器，首次播报零等待；缺失静默跳过（播报回退系统语音）
  tts.preloadTts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('will-quit', () => {
    stopScheduler()
    inventoryServer?.stop()
    // 恢复备份重启：旧连接视图已脱节，跳过收尾备份/checkpoint
    if (restoring) return
    // 退出收尾：备份一次 + checkpoint 截断 WAL
    try {
      backupNow(db, dbPath, backupDir)
    } catch (e) {
      // 退出阶段用户看不到任何界面，只写日志文件留痕，不弹框
      reportBackupError('退出备份失败', e)
    }
    finalCheckpoint(db)
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
