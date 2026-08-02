// 一键打包：先构建前端，再用 electron-builder 打出 NSIS 安装包
// 注意：输出目录必须避开工作区（工作区文件监控会锁定解压目录导致 EPERM），
//       因此先输出到临时目录，再把安装包拷回 release/
const { build, Platform } = require('electron-builder')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
// electron-builder 内部会 spawn npm.CMD（经 PowerShell），精简 PATH 环境下需补回系统目录
const windir = process.env.SystemRoot || 'C:\\Windows'
process.env.PATH = `${windir}\\System32;${windir}\\System32\\WindowsPowerShell\\v1.0;${process.env.PATH}`

const tmpOut = path.join(os.tmpdir(), 'fi-release')

/** 打包前哨兵：主进程所有 .js/.cjs 必须过 node --check（tsc/vitest 都覆盖不到 electron/） */
function syntaxCheckMainProcess() {
  const dir = path.resolve('electron')
  const files = []
  for (const f of fs.readdirSync(dir)) {
    if (/\.(js|cjs)$/.test(f)) files.push(path.join(dir, f))
  }
  for (const f of fs.readdirSync(path.join(dir, 'lib')).map((f) => path.join(dir, 'lib', f))) {
    if (/\.(js|cjs)$/.test(f)) files.push(f)
  }
  for (const f of files) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' })
    } catch (e) {
      throw new Error(`主进程语法检查失败: ${f}\n${e.stderr?.toString() ?? e.message}`)
    }
  }
  console.log(`✓ 主进程 ${files.length} 个文件语法检查通过`)
}

;(async () => {
  syntaxCheckMainProcess()
  execSync('npm.cmd run build', { stdio: 'inherit' })

  await build({
    targets: Platform.WINDOWS.createTarget(),
    config: { directories: { output: tmpOut } },
  })

  // 按 package.json 的 version 精确挑安装包：临时目录是复用的，
  // 直接 find('Setup') 可能命中上次构建留下的旧版本安装包
  const { version } = require('../package.json')
  const releaseDir = path.resolve('release')
  fs.mkdirSync(releaseDir, { recursive: true })
  const installer = fs
    .readdirSync(tmpOut)
    .find((f) => f.endsWith('.exe') && f.includes(`Setup ${version}`))
  if (!installer) throw new Error(`未找到安装包产物（期望文件名含 "Setup ${version}"）`)
  fs.copyFileSync(path.join(tmpOut, installer), path.join(releaseDir, installer))
  console.log(`\n安装包已就绪: release/${installer}`)
})().catch((e) => {
  console.error('打包失败:', e.message)
  process.exit(1)
})
