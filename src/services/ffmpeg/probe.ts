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
      return await probeVideo(url)
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
    v.onloadedmetadata = () => {
      resolve({
        width: v.videoWidth,
        height: v.videoHeight,
        duration: v.duration,
        hasAudio: false // 浏览器无 API 检测音轨，做粗略判断
      })
    }
    v.onerror = () => reject(new Error('无法读取视频元数据'))
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
