import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')
const electronExe = path.join(electronDist, 'electron.exe')

/**
 * electron-builder 默认会把 zip 解到 win-unpacked.tmp，再 rename 成 win-unpacked。
 * Windows 搜索 / Defender 会立刻锁住里面的 default_app.asar，rename 必 EPERM。
 * 改用本机已解压的 Electron 做文件复制，并每次打到全新输出目录，避开改名和清残留。
 */
if (!fs.existsSync(electronExe)) {
  console.error(`[pack] 找不到已解压的 Electron：${electronExe}`)
  console.error('[pack] 请先执行 npm install')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const output = path.posix.join('release', `pack-${stamp}`)
fs.mkdirSync(path.join(root, output), { recursive: true })

console.log('[pack] 跳过 zip 解压改名，复制 node_modules/electron/dist')
console.log(`[pack] electronDist = ${electronDist}`)
console.log(`[pack] output = ${output}`)

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'electron-builder',
    `--config.electronDist=${electronDist}`,
    `--config.directories.output=${output}`
  ],
  { stdio: 'inherit', shell: true, cwd: root }
)

const code = await new Promise((resolve) => {
  child.on('exit', (c) => resolve(c ?? 1))
  child.on('error', () => resolve(1))
})

if (code === 0) {
  const absOut = path.join(root, output)
  const installers = fs.readdirSync(absOut).filter((name) => name.toLowerCase().endsWith('.exe'))
  if (installers.length) {
    console.log('[pack] 安装包：')
    for (const name of installers) console.log(`  ${path.join(absOut, name)}`)
  }
}

process.exit(code)
