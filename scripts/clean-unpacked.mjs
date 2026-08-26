import fs from 'node:fs'
import path from 'node:path'

const dirs = ['release/win-unpacked', 'release/win-unpacked.tmp']
for (const dir of dirs) {
  const target = path.resolve(dir)
  if (!fs.existsSync(target)) continue
  fs.rmSync(target, { recursive: true, force: true })
  console.log(`[clean-unpacked] removed ${dir}`)
}
