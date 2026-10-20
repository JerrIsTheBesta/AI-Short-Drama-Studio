/**
 * 探测视频 / 图片的元数据（浏览器原生实现，不依赖 FFmpeg）
 */

export interface MediaInfo {
  width: number
  height: number
  duration?: number
  hasAudio?: boolean
}

export async function probeMedia(blob: Blob): Promise<MediaInfo> {
  const typed = playableMediaBlob(blob)
  const url = URL.createObjectURL(typed)
  try {
    if (typed.type.startsWith('image/')) {
      const img = await loadImage(url)
      return { width: img.naturalWidth, height: img.naturalHeight }
    } else if (typed.type.startsWith('video/')) {
      try {
        return await probeVideo(url)
      } catch {
        return { width: 0, height: 0, duration: undefined, hasAudio: false }
      }
    } else if (typed.type.startsWith('audio/')) {
      return await probeAudio(url)
    }
    try {
      return await probeVideo(url)
    } catch {
      throw new Error('不支持的媒体类型: ' + (typed.type || '(empty)'))
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
}

function probeVideo(url: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('无法读取视频元数据'))
    }, 8000)
    const cleanup = () => {
      window.clearTimeout(timer)
      v.onloadedmetadata = null
      v.onerror = null
      v.removeAttribute('src')
      v.load()
    }
    v.onloadedmetadata = () => {
      const info = {
        width: v.videoWidth,
        height: v.videoHeight,
        duration: v.duration,
        hasAudio: false
      }
      cleanup()
      resolve(info)
    }
    v.onerror = () => {
      cleanup()
      reject(new Error('无法读取视频元数据'))
    }
    v.src = url
  })
}

function probeAudio(url: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    a.onloadedmetadata = () => {
      resolve({
        width: 0,
        height: 0,
        duration: a.duration
      })
    }
    a.onerror = () => reject(new Error('无法读取音频元数据'))
    a.src = url
  })
}

/** IndexedDB 里经常丢掉 MIME，浏览器会当成无法播放 */
export function playableMediaBlob(
  blob: Blob,
  kind?: 'image' | 'video' | 'audio',
  mimeType?: string
): Blob {
  const raw = (blob.type || mimeType || '').toLowerCase()
  if (raw && raw !== 'application/octet-stream') return blob
  const fallback =
    kind === 'video' || raw.startsWith('video')
      ? 'video/mp4'
      : kind === 'audio' || raw.startsWith('audio')
        ? 'audio/mpeg'
        : kind === 'image' || raw.startsWith('image')
          ? 'image/png'
          : mimeType || blob.type
  if (!fallback) return blob
  return blob.slice(0, blob.size, fallback)
}

function sniffContainerMime(bytes: Uint8Array, kind?: 'image' | 'video' | 'audio'): string | undefined {
  if (bytes.length < 12) return undefined
  const ascii = (n: number, m: number) => String.fromCharCode(...bytes.subarray(n, m))
  // 图片优先识别，避免空 MIME 的 JPEG 被强制标成 video/mp4
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    ascii(0, 4) === 'RIFF' &&
    ascii(8, 12) === 'WEBP'
  )
    return 'image/webp'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav'
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg'
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (ascii(0, 4) === 'OggS') return kind === 'video' ? 'video/ogg' : 'audio/ogg'
  if (ascii(4, 8) === 'ftyp') return kind === 'audio' ? 'audio/mp4' : 'video/mp4'
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'video/webm'
  }
  return undefined
}

/** 按文件头校正 MIME，避免口播 wav 被标成 mp3 后无法试听；也避免图片被误标成视频 */
export async function ensurePlayableBlob(
  blob: Blob,
  kind?: 'image' | 'video' | 'audio',
  mimeType?: string
): Promise<Blob> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  const sniffed = sniffContainerMime(head, kind)
  if (sniffed) {
    if (kind === 'video' && sniffed.startsWith('image/')) {
      // 留给上层抛错；这里先标回真实类型
      return blob.slice(0, blob.size, sniffed)
    }
    if (sniffed !== blob.type) return blob.slice(0, blob.size, sniffed)
    return blob
  }
  const typed = playableMediaBlob(blob, kind, mimeType)
  return typed
}

export async function isMostlyDarkImage(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob)
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.drawImage(img, 0, 0, 32, 32)
    const data = ctx.getImageData(0, 0, 32, 32).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] + data[i + 1] + data[i + 2]
    }
    return sum / (32 * 32 * 3) < 18
  } finally {
    URL.revokeObjectURL(url)
  }
}

function canvasIsDark(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const sampleW = Math.min(48, w)
  const sampleH = Math.min(48, h)
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i] + data[i + 1] + data[i + 2]
  }
  return sum / ((data.length / 4) * 3) < 18
}

function seekTo(v: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('seek timeout')), 4000)
    const done = () => {
      window.clearTimeout(timer)
      v.removeEventListener('seeked', done)
      resolve()
    }
    v.addEventListener('seeked', done)
    v.currentTime = time
  })
}

/** 提取视频封面帧（避开片头黑场） */
export async function extractVideoThumbnail(blob: Blob): Promise<Blob> {
  const typed = playableMediaBlob(blob, 'video')
  const url = URL.createObjectURL(typed)
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('视频元数据超时')), 10000)
      v.onloadedmetadata = () => {
        window.clearTimeout(timer)
        resolve()
      }
      v.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('视频加载失败'))
      }
    })
    try {
      await v.play()
      v.pause()
    } catch {
      /* 有的浏览器不允许自动播放，继续 seek */
    }
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1
    const candidates = [
      Math.min(1.0, dur * 0.25),
      Math.min(2.0, dur * 0.4),
      dur * 0.5,
      Math.min(0.4, dur * 0.1),
      Math.max(0.08, dur - 0.35)
    ]
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法绘制封面')
    let lastJpeg: Blob | null = null
    for (const t of candidates) {
      const target = Math.min(Math.max(0.04, t), Math.max(0.04, dur - 0.05))
      try {
        await seekTo(v, target)
      } catch {
        continue
      }
      if (!v.videoWidth) continue
      const w = 480
      const ratio = v.videoWidth / v.videoHeight || 16 / 9
      canvas.width = w
      canvas.height = Math.max(1, Math.round(w / ratio))
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
      const jpeg = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('封面为空'))), 'image/jpeg', 0.82)
      })
      lastJpeg = jpeg
      if (!canvasIsDark(ctx, canvas.width, canvas.height)) return jpeg
    }
    if (lastJpeg) return lastJpeg
    throw new Error('无法绘制封面')
  } finally {
    v.pause()
    v.removeAttribute('src')
    v.load()
    URL.revokeObjectURL(url)
  }
}

/** 提取视频最后一帧（首尾帧连拍模式：上一镜的末帧 = 下一镜的首帧） */
export async function extractVideoLastFrame(blob: Blob): Promise<Blob> {
  const typed = playableMediaBlob(blob, 'video')
  const url = URL.createObjectURL(typed)
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.preload = 'auto'
  v.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('视频元数据超时')), 10000)
      v.onloadedmetadata = () => {
        window.clearTimeout(timer)
        resolve()
      }
      v.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('视频加载失败'))
      }
    })
    try {
      await v.play()
      v.pause()
    } catch {
      /* 有的浏览器不允许自动播放，继续 seek */
    }
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法绘制末帧')
    // 末帧附近可能有编码噪声，向前微退半帧并在两个采样点里取非黑的那帧。
    const candidates = [Math.max(0.04, dur - 0.08), Math.max(0.04, dur - 0.25)]
    let lastJpeg: Blob | null = null
    for (const t of candidates) {
      try {
        await seekTo(v, t)
      } catch {
        continue
      }
      if (!v.videoWidth) continue
      const w = Math.min(1280, v.videoWidth)
      const ratio = v.videoWidth / v.videoHeight || 16 / 9
      canvas.width = Math.max(1, Math.round(w))
      canvas.height = Math.max(1, Math.round(w / ratio))
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
      const jpeg = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('末帧为空'))), 'image/jpeg', 0.9)
      })
      lastJpeg = jpeg
      if (!canvasIsDark(ctx, canvas.width, canvas.height)) return jpeg
    }
    if (lastJpeg) return lastJpeg
    throw new Error('无法绘制末帧')
  } finally {
    v.pause()
    v.removeAttribute('src')
    v.load()
    URL.revokeObjectURL(url)
  }
}
