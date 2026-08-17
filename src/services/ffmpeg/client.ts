/**
 * FFmpeg.wasm 包装
 *
 * 加载策略（按优先级）：
 *   1. 本地 /ffmpeg/*  （完全离线，推荐国内用户）
 *   2. jsDelivr CDN   （比 unpkg 稳）
 *   3. unpkg CDN      （兜底）
 *
 * 注意：浏览器需要 cross-origin isolation（COOP/COEP headers）
 * 才会启用 SharedArrayBuffer。Vite 配置里已经设置。
 *
 * 实现：直接给 ffmpeg.load() 传 URL，不用 toBlobURL。
 * 这样 ffmpeg 内部 worker 会自己去 fetch，比 toBlobURL 链路更短、更稳。
 */

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
// 用 Vite ?url import 拿到本地 core 文件的 URL
// 之前放 public/ 被 Vite 禁止从 source code 引用（"cannot be imported from source code"）
// 移到 src/assets/ 用 ?url 解决
import coreJsUrl from '@/assets/ffmpeg/ffmpeg-core.esm.js?url'
import coreWasmUrl from '@/assets/ffmpeg/ffmpeg-core.wasm?url'

let _ffmpeg: FFmpeg | null = null
let _loading: Promise<FFmpeg> | null = null

const CORE_VERSION = '0.12.10'

/** 多个 CDN 源，按顺序尝试
 * 注意：用 ESM 版 ffmpeg-core，因为 @ffmpeg/ffmpeg 0.12.10 强制 module worker
 *       module worker 不支持 importScripts（UMD 用），必须用 ESM 版才能 dynamic import
 */
const CDN_SOURCES = [
  {
    name: '本地',
    base: '(vite ?url)',
    urls: {
      js: coreJsUrl,
      wasm: coreWasmUrl
    }
  },
  {
    name: 'jsDelivr',
    base: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
    urls: {
      js: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.js`,
      wasm: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.wasm`
    }
  },
  {
    name: 'unpkg',
    base: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
    urls: {
      js: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.js`,
      wasm: `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm/ffmpeg-core.wasm`
    }
  },
  {
    name: '国内镜像 npmmirror',
    base: `https://registry.npmmirror.com/@ffmpeg/core@${CORE_VERSION}/files/dist/esm`,
    urls: {
      js: `https://registry.npmmirror.com/@ffmpeg/core@${CORE_VERSION}/files/dist/esm/ffmpeg-core.js`,
      wasm: `https://registry.npmmirror.com/@ffmpeg/core@${CORE_VERSION}/files/dist/esm/ffmpeg-core.wasm`
    }
  }
]

/** 测一个 URL 是否能访问（用 HEAD），返回 ms 耗时或 -1 */
async function probeUrl(url: string, timeout = 8000): Promise<number> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const t0 = performance.now()
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: ctl.signal,
      cache: 'no-store'
    })
    clearTimeout(timer)
    if (resp.ok) return performance.now() - t0
    return -1
  } catch {
    clearTimeout(timer)
    return -1
  }
}

/** 选最快的源 */
async function pickBestSource(onLog?: (msg: string) => void): Promise<typeof CDN_SOURCES[0] | null> {
  for (const src of CDN_SOURCES) {
    const ms = await probeUrl(src.urls.js)
    if (ms > 0) {
      onLog?.(`✓ ${src.name} 可用 (${Math.round(ms)}ms)`)
      return src
    } else {
      onLog?.(`✗ ${src.name} 不可用`)
    }
  }
  return null
}

/** 获取或初始化 FFmpeg（单例） */
export async function getFFmpeg(
  onProgress?: (msg: string) => void
): Promise<FFmpeg> {
  if (_ffmpeg) return _ffmpeg
  if (_loading) return _loading

  _loading = (async () => {
    const log = (msg: string) => {
      console.log('[FFmpeg]', msg)
      onProgress?.(msg)
    }

    // 检查浏览器支持
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error(
        '浏览器不支持 SharedArrayBuffer。请用 Chrome 92+ / Edge 92+ / Firefox 89+，并确保通过 http://localhost 访问（不是 file://）。'
      )
    }
    if (!self.crossOriginIsolated) {
      throw new Error(
        '当前页面未启用 cross-origin isolation。请确认 Vite 启动时设置了 COOP/COEP headers。'
      )
    }

    const ffmpeg = new FFmpeg()

    ffmpeg.on('log', ({ message }) => {
      if (
        message.includes('frame=') ||
        message.includes('error') ||
        message.includes('Error') ||
        message.includes('Conversion')
      ) {
        log(message.slice(0, 200))
      }
    })
    ffmpeg.on('progress', ({ progress }) => {
      if (progress > 0) {
        log(`处理中 ${Math.round(progress * 100)}%`)
      }
    })

    log('探测 FFmpeg 核心源...')
    const src = await pickBestSource(log)
    if (!src) {
      throw new Error(
        '所有 FFmpeg 源都不可用。\n' +
          '可能原因：\n' +
          '1) 网络问题（被墙/超时）\n' +
          '2) COEP 阻止了 cross-origin 资源\n' +
          '3) CDN 资源不存在\n' +
          '解决：手动下载 ffmpeg core 到 public/ffmpeg/ 目录。\n' +
          '查看 public/ffmpeg/README.md 了解怎么放。'
      )
    }
    log(`使用源：${src.name}`)

    try {
      // 1) 先 HEAD 探活 + 检查 MIME，明确报错
      log(`检查 ffmpeg-core.js: ${src.urls.js}`)
      const headJs = await fetch(src.urls.js, { method: 'HEAD' })
      log(`  → ${headJs.status} ${headJs.statusText}, type=${headJs.headers.get('content-type')}`)
      if (!headJs.ok) {
        throw new Error(
          `core.js 不可访问：HTTP ${headJs.status} ${headJs.statusText}\n` +
            `URL: ${src.urls.js}\n` +
            (headJs.status === 404
              ? '提示：404 说明 vite 没找到 public/ffmpeg/ 下的文件，确认 ffmpeg-core.js 存在'
              : '')
        )
      }

      log(`检查 ffmpeg-core.wasm: ${src.urls.wasm}`)
      const headWasm = await fetch(src.urls.wasm, { method: 'HEAD' })
      log(`  → ${headWasm.status} ${headWasm.statusText}, type=${headWasm.headers.get('content-type')}`)
      if (!headWasm.ok) {
        throw new Error(
          `core.wasm 不可访问：HTTP ${headWasm.status} ${headWasm.statusText}\nURL: ${src.urls.wasm}`
        )
      }
      const wasmMime = headWasm.headers.get('content-type') || ''
      if (wasmMime && !wasmMime.includes('wasm') && !wasmMime.includes('octet')) {
        throw new Error(
          `core.wasm 的 MIME 类型不对：${wasmMime}\n` +
            '期望 application/wasm 或 application/octet-stream。\n' +
            '修复：Vite 配置里加 assets 识别，或用 vite preview 看是否正常。'
        )
      }

      // 2) 直接传 URL 给 ffmpeg.load()，不用 toBlobURL
      //    ffmpeg.wasm 0.12+ 接受 string URL，内部 worker 会自己 fetch
      //    ESM core + module worker + dynamic import(.default) 这条链路是通的
      log('使用直接 URL 模式（不走 toBlobURL，ESM core）')

      log('初始化 FFmpeg core...')
      await ffmpeg.load({
        coreURL: src.urls.js,
        wasmURL: src.urls.wasm
      })
      log('FFmpeg 就绪')
      _ffmpeg = ffmpeg
      return ffmpeg
    } catch (e: any) {
      throw new Error(
        `FFmpeg core 加载失败（${src.name}）：${e.message}\n` +
          '可能原因：\n' +
          '1) COEP=require-corp 阻止了无 CORP 头的 CDN 资源\n' +
          '2) Worker 文件加载失败\n' +
          '3) WASM MIME 类型不匹配\n' +
          '推荐：把 core 文件下载到 public/ffmpeg/ 目录使用本地源。'
      )
    }
  })().catch((e) => {
    _loading = null
    throw e
  })

  return _loading
}

/** 是否已加载 */
export function isFFmpegReady(): boolean {
  return _ffmpeg !== null
}

/** 强制重置（用于切换源后重试） */
export function resetFFmpeg() {
  if (_ffmpeg) {
    try {
      _ffmpeg.terminate()
    } catch {}
  }
  _ffmpeg = null
  _loading = null
}

/** 写文件到 FFmpeg 虚拟 FS */
export async function writeFile(
  ffmpeg: FFmpeg,
  name: string,
  data: Blob | File | Uint8Array | string
) {
  let payload: Uint8Array | string
  if (typeof data === 'string') {
    payload = data
  } else if (data instanceof Uint8Array) {
    payload = new Uint8Array(data)
  } else {
    const raw = await fetchFile(data)
    payload = new Uint8Array(raw)
  }
  await ffmpeg.writeFile(name, payload)
}

/** 尽量清掉 MEMFS 里的中间文件，避免二次导出撑爆虚拟磁盘 */
export async function clearFS(ffmpeg: FFmpeg) {
  try {
    const entries = await ffmpeg.listDir('/')
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.isDir) continue
      try {
        await ffmpeg.deleteFile(entry.name)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** 从 FFmpeg 虚拟 FS 读文件 */
export async function readFile(ffmpeg: FFmpeg, name: string): Promise<Uint8Array> {
  const data = await ffmpeg.readFile(name)
  // ffmpeg.readFile 在 web 上返回 Uint8Array，node 上返回 string；统一处理
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }
  return data as Uint8Array
}

/** 把 Uint8Array 包装成 Blob（带 MIME） */
export function toBlob(data: Uint8Array, mime: string): Blob {
  // 复制成 ArrayBuffer-backed Uint8Array，避免 SharedArrayBuffer 类型冲突
  const buf = new ArrayBuffer(data.byteLength)
  new Uint8Array(buf).set(data)
  return new Blob([buf], { type: mime })
}

/** 公共 fetchFile */
export { fetchFile }
