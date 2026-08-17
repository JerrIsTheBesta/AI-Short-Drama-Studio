/**
 * 字幕相关
 *
 * - SRT 解析/生成
 * - 把字幕烧录进视频（FFmpeg drawtext / ass）
 *
 * 注：FFmpeg.wasm 默认不包含 libass，所以用 drawtext 单条字幕动态绘制。
 *     大量字幕建议用 WebVTT + canvas overlay（性能更好）。
 */

import type { CaptionStyle } from '@/types'

export interface SubtitleCue {
  id: number
  start: number
  end: number
  text: string
}

export function parseSRT(srt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = srt
    .replace(/\r/g, '')
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.length < 2) continue

    let id = cues.length + 1
    let timeLineIdx = 0
    if (/^\d+$/.test(lines[0])) {
      id = parseInt(lines[0], 10)
      timeLineIdx = 1
    }

    const timeLine = lines[timeLineIdx]
    const m = timeLine.match(
      /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/
    )
    if (!m) continue

    const start =
      parseInt(m[1]) * 3600 +
      parseInt(m[2]) * 60 +
      parseInt(m[3]) +
      parseInt(m[4]) / 1000
    const end =
      parseInt(m[5]) * 3600 +
      parseInt(m[6]) * 60 +
      parseInt(m[7]) +
      parseInt(m[8]) / 1000

    const text = lines.slice(timeLineIdx + 1).join('\n')

    cues.push({ id, start, end, text })
  }

  return cues
}

export function toSRT(cues: SubtitleCue[]): string {
  return cues
    .map((c) => {
      return `${c.id}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`
    })
    .join('\n')
}

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

/** 把字幕按片段时间映射（每个 clip 一个 cue） */
export function buildCuesFromClips(
  clips: Array<{ startTime: number; duration: number; text: string }>
): SubtitleCue[] {
  return clips.map((c, i) => ({
    id: i + 1,
    start: c.startTime,
    end: c.startTime + c.duration,
    text: c.text
  }))
}

/** 为 FFmpeg drawtext 转义特殊字符 */
export function escapeDrawText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\n/g, '\\n')
}

/** 把 Cue 列表 + 样式 → FFmpeg drawtext 滤镜（多段叠加） */
export function cuesToDrawTextFilter(
  cues: SubtitleCue[],
  style: CaptionStyle,
  videoHeight: number
): string {
  const fontSize = Math.round(videoHeight * style.fontSizeRatio)
  const y = calcY(style.position, videoHeight, fontSize)
  const fontFile = ''
  // 字号 / 颜色 / 描边 / 位置
  const base = (text: string) =>
    [
      `text='${escapeDrawText(text)}'`,
      `fontsize=${fontSize}`,
      `fontcolor=${style.color}`,
      style.strokeWidth > 0
        ? `borderw=${style.strokeWidth}:bordercolor=${style.strokeColor}`
        : '',
      `x=(w-text_w)/2`,
      `y=${y}`,
      style.bold ? 'bold=true' : ''
    ]
      .filter(Boolean)
      .join(':')

  return cues
    .map((c) => {
      const enable = `enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'`
      return `drawtext=${base(c.text)}:${enable}`
    })
    .join(',')
}

const CJK_FONT =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Noto Sans CJK SC", "Hiragino Sans GB", sans-serif'

function wrapCaptionLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const paragraphs = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0)
  const lines: string[] = []
  for (const para of paragraphs.length ? paragraphs : [text]) {
    let current = ''
    for (const ch of para) {
      const trial = current + ch
      if (ctx.measureText(trial).width > maxWidth && current) {
        lines.push(current)
        current = ch
      } else {
        current = trial
      }
    }
    if (current) lines.push(current)
  }
  return lines.slice(0, 6)
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '')
  const n =
    m.length === 3
      ? m.split('').map((c) => parseInt(c + c, 16))
      : [
          parseInt(m.slice(0, 2), 16),
          parseInt(m.slice(2, 4), 16),
          parseInt(m.slice(4, 6), 16)
        ]
  return `rgba(${n[0] || 0},${n[1] || 0},${n[2] || 0},${alpha})`
}

/**
 * 用浏览器 Canvas 把一句字幕画成整帧透明 PNG。
 * ffmpeg.wasm 没有 freetype，drawtext 烧中文会失败；overlay PNG 才能真正叠字。
 */
export async function renderCaptionPng(
  text: string,
  style: CaptionStyle,
  width: number,
  height: number,
  captionBg: boolean
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建字幕画布')
  ctx.clearRect(0, 0, width, height)

  const fontSize = Math.max(18, Math.round(height * style.fontSizeRatio))
  const family = style.fontFamily
    ? `"${style.fontFamily.replace(/"/g, '')}", ${CJK_FONT}`
    : CJK_FONT
  ctx.font = `${style.bold ? 'bold ' : ''}${fontSize}px ${family}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const maxWidth = width * 0.86
  const lines = wrapCaptionLines(ctx, text.trim(), maxWidth)
  if (lines.length === 0) {
    return new Blob([], { type: 'image/png' })
  }

  const lineHeight = fontSize * 1.4
  const blockHeight = lines.length * lineHeight
  const padX = Math.round(fontSize * 0.7)
  const padY = Math.round(fontSize * 0.35)
  const blockWidth = Math.max(...lines.map((l) => ctx.measureText(l).width))

  let midY: number
  switch (style.position) {
    case 'top':
      midY = height * 0.1 + blockHeight / 2
      break
    case 'center':
      midY = height / 2
      break
    default:
      midY = height - height * 0.1 - blockHeight / 2
  }

  if (captionBg && style.bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(style.bgColor || '#000000', style.bgOpacity)
    const x = (width - blockWidth) / 2 - padX
    const y = midY - blockHeight / 2 - padY
    const w = blockWidth + padX * 2
    const h = blockHeight + padY * 2
    const r = 8
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
    ctx.fill()
  }

  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  lines.forEach((line, i) => {
    const ly = midY - blockHeight / 2 + lineHeight * i + lineHeight / 2
    if (style.strokeWidth > 0) {
      ctx.lineWidth = Math.max(2, style.strokeWidth * 2)
      ctx.strokeStyle = style.strokeColor || '#000'
      ctx.strokeText(line, width / 2, ly)
    }
    ctx.fillStyle = style.color || '#fff'
    ctx.fillText(line, width / 2, ly)
  })

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('字幕 PNG 生成失败'))), 'image/png')
  })
  return blob
}

function calcY(
  position: CaptionStyle['position'],
  videoHeight: number,
  fontSize: number
): string {
  switch (position) {
    case 'top':
      return String(Math.round(videoHeight * 0.08))
    case 'center':
      return '(h-text_h)/2'
    case 'bottom':
    default:
      return String(videoHeight - Math.round(videoHeight * 0.12) - fontSize)
  }
}
