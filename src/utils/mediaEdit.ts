import { concatVideos } from '@/services/ffmpeg'

function even(n: number) {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v + 1
}

export interface NormRect {
  x: number
  y: number
  w: number
  h: number
}

/** 把 object-fit:contain 的裁剪框（相对容器 0–1）映射到原图像素并裁出 */
export async function cropContainedImage(
  blob: Blob,
  box: { width: number; height: number },
  crop: NormRect
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(box.width / bitmap.width, box.height / bitmap.height)
  const dw = bitmap.width * scale
  const dh = bitmap.height * scale
  const dx = (box.width - dw) / 2
  const dy = (box.height - dh) / 2
  const rx = crop.x * box.width
  const ry = crop.y * box.height
  const rw = crop.w * box.width
  const rh = crop.h * box.height
  const ix = Math.max(0, (Math.max(rx, dx) - dx) / scale)
  const iy = Math.max(0, (Math.max(ry, dy) - dy) / scale)
  const ix2 = Math.min(bitmap.width, (Math.min(rx + rw, dx + dw) - dx) / scale)
  const iy2 = Math.min(bitmap.height, (Math.min(ry + rh, dy + dh) - dy) / scale)
  const cw = Math.max(2, even(ix2 - ix))
  const ch = Math.max(2, even(iy2 - iy))
  if (cw < 8 || ch < 8) {
    bitmap.close()
    throw new Error('裁剪区域太小')
  }
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('无法裁剪')
  }
  ctx.drawImage(bitmap, ix, iy, cw, ch, 0, 0, cw, ch)
  bitmap.close()
  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('裁剪转码失败'))),
      blob.type.includes('png') ? 'image/png' : 'image/jpeg',
      0.92
    )
  })
}

export async function trimVideoBlob(
  blob: Blob,
  start: number,
  duration: number,
  width: number,
  height: number,
  fps: number,
  onProgress?: (msg: string) => void
): Promise<Blob> {
  const t = Math.max(0.2, duration)
  return concatVideos(
    [{ blob, sourceIn: Math.max(0, start), duration: t, enabled: true }],
    { width, height, fps, onProgress }
  )
}

export function clampRect(r: NormRect): NormRect {
  const w = Math.min(1, Math.max(0.12, r.w))
  const h = Math.min(1, Math.max(0.12, r.h))
  const x = Math.min(1 - w, Math.max(0, r.x))
  const y = Math.min(1 - h, Math.max(0, r.y))
  return { x, y, w, h }
}
