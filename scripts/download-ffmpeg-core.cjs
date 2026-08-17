/**
 * 下载 FFmpeg core 到 public/ffmpeg/
 *
 * 用法：
 *   node scripts/download-ffmpeg-core.cjs
 *   # 或指定源
 *   node scripts/download-ffmpeg-core.cjs --source=jsdelivr
 *
 * 源：jsdelivr | unpkg | npmmirror
 *
 * 首次加载失败时，最稳的修复方案就是跑这个脚本，
 * 把 core 放到 public 目录，完全离线用。
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

const CORE_VERSION = '0.12.10'
// 文件放到 src/assets/ffmpeg/，因为 Vite 禁止从 source code 引用 public/ 下的文件
// 用 ?url import 拿到 vite 处理过的 URL
const OUT_DIR = path.join(__dirname, '..', 'src', 'assets', 'ffmpeg')

const SOURCES = {
  jsdelivr: {
    base: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm']
  },
  unpkg: {
    base: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm']
  },
  npmmirror: {
    base: `https://registry.npmmirror.com/@ffmpeg/core@${CORE_VERSION}/files/dist/esm`,
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm']
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  const out = { source: 'jsdelivr' }
  for (const a of args) {
    if (a.startsWith('--source=')) out.source = a.slice(9)
    if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { headers: { 'User-Agent': 'node-ai-cut/0.1' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close()
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        file.close()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let downloaded = 0
      let lastLog = 0
      res.on('data', (chunk) => {
        downloaded += chunk.length
        const now = Date.now()
        if (now - lastLog > 500 && total > 0) {
          const pct = ((downloaded / total) * 100).toFixed(1)
          process.stdout.write(
            `\r  → ${path.basename(dest)}  ${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(
              total / 1024 / 1024
            ).toFixed(1)}MB  (${pct}%)`
          )
          lastLog = now
        }
      })
      res.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          process.stdout.write('\n')
          resolve()
        })
      })
    })
    req.on('error', (err) => {
      file.close()
      try {
        fs.unlinkSync(dest)
      } catch {}
      reject(err)
    })
    req.setTimeout(120000, () => {
      req.destroy(new Error('下载超时（120s）'))
    })
  })
}

async function main() {
  const args = parseArgs()
  if (args.help) {
    console.log(`
下载 FFmpeg core 到 public/ffmpeg/

用法：
  node scripts/download-ffmpeg-core.cjs
  node scripts/download-ffmpeg-core.cjs --source=jsdelivr
  node scripts/download-ffmpeg-core.cjs --source=unpkg
  node scripts/download-ffmpeg-core.cjs --source=npmmirror

源：
  - jsdelivr  (默认，cdn.jsdelivr.net)
  - unpkg     (unpkg.com)
  - npmmirror (国内镜像，registry.npmmirror.com)
`)
    return
  }

  const src = SOURCES[args.source]
  if (!src) {
    console.error(`❌ 未知源：${args.source}，可选：${Object.keys(SOURCES).join(', ')}`)
    process.exit(1)
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  }

  console.log(`\n🎬 下载 FFmpeg core v${CORE_VERSION}`)
  console.log(`📁 目标目录：${OUT_DIR}`)
  console.log(`🌐 使用源：${args.source}\n`)

  for (const file of src.files) {
    const url = `${src.base}/${file}`
    const dest = path.join(OUT_DIR, file)
    process.stdout.write(`下载 ${file}...\n`)
    try {
      await download(url, dest)
      const size = fs.statSync(dest).size
      console.log(`  ✓ ${file} (${(size / 1024 / 1024).toFixed(2)} MB)`)
    } catch (e) {
      console.error(`  ✗ ${file} 下载失败：${e.message}`)
      process.exit(1)
    }
  }

  // ESM 版 core 必须叫 .esm.js，否则 vite 会按 UMD 处理
  const esmSrc = path.join(OUT_DIR, 'ffmpeg-core.js')
  const esmDest = path.join(OUT_DIR, 'ffmpeg-core.esm.js')
  if (fs.existsSync(esmSrc) && !fs.existsSync(esmDest)) {
    fs.renameSync(esmSrc, esmDest)
    console.log(`  ↻ ffmpeg-core.js → ffmpeg-core.esm.js`)
  }

  console.log(`\n✅ 完成！文件已放到 public/ffmpeg/`)
  console.log(`\n下一步：重启 npm run dev，FFmpeg 会优先用本地文件。\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
