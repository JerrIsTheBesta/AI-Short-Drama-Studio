import fs from 'node:fs'
import path from 'node:path'

const dirs = ['release/win-unpacked', 'release/win-unpacked.tmp']
const MAX_TRIES = 8

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function removeDir(target) {
  let last
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
      return
    } catch (error) {
      last = error
      const code = error && error.code
      if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY' || code === 'EACCES') {
        if (i < MAX_TRIES) sleep(400)
        continue
      }
      throw error
    }
  }
  const hint = [
    `[clean-unpacked] 删不掉 ${target}`,
    'Windows 报 EPERM，通常是 Cursor / 资源管理器 / 杀毒还握着上次打包的文件（常见是 resources/default_app.asar）。',
    '处理：把 release 加进文件监视排除后重载 Cursor 窗口，或关掉占用后再打包。'
  ].join('\n')
  const err = new Error(hint)
  err.cause = last
  throw err
}

for (const dir of dirs) {
  const target = path.resolve(dir)
  if (!fs.existsSync(target)) continue
  removeDir(target)
  console.log(`[clean-unpacked] removed ${dir}`)
}
