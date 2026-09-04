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

export interface CaptionHighlightOptions {
  enabled?: boolean
  color?: string
  scale?: number
  /** 可选人工覆盖；为空时自动提取 */
  words?: string[]
}

const EMPHASIS_WORDS = [
  '超级工厂', '产业带', '运营中心', '诚信通', '外贸版', '黑五', '圣诞',
  '出海', '合规', '现货', '利润', '增长', '机会', '资源', '流量', 'AI能力',
  '关键', '核心', '重点', '第一', '必须', '一定', '直接', '提前', '稳定出货',
  '售后保障', '点击下方', '锁定席位', '不见不散'
]

const HIGHLIGHT_STOP_WORDS = new Set([
  '这个', '那个', '这些', '那些', '我们', '你们', '他们', '自己', '一个', '一些',
  '就是', '还是', '已经', '现在', '今年', '这里', '这样', '那样', '如果', '因为',
  '所以', '但是', '而且', '可以', '可能', '开始', '之后', '之前', '时候', '怎么',
  '什么', '很多', '越来越', '一下', '一条', '一波', '起来', '下来', '出来'
])

interface HighlightCandidate {
  word: string
  score: number
  start: number
}

/**
 * 为一条字幕自动挑出最多两个重点词。
 * 优先级：完整日期/时间与数字 → 营销实体/结论词 → 中文分词中的高信息词。
 */
export function pickCaptionHighlights(text: string, limit = 2): string[] {
  const source = text.replace(/\s+/g, '')
  if (source.length < 4 || limit <= 0) return []
  const candidates: HighlightCandidate[] = []
  const add = (word: string, score: number, start = source.indexOf(word)) => {
    const clean = word.replace(/^[，。！？；：、,.!?;:]+|[，。！？；：、,.!?;:]+$/g, '')
    if (!clean || clean.length > 12 || start < 0 || HIGHLIGHT_STOP_WORDS.has(clean)) return
    if (clean.length >= Math.max(8, Math.ceil(source.length * 0.65))) return
    candidates.push({ word: clean, score, start })
  }

  const priorityPatterns = [
    /\d{2,4}年\d{1,2}月\d{1,2}[日号]?/g,
    /\d{1,2}月\d{1,2}[日号]/g,
    /\d{1,2}[点时]\s*\d{0,2}分?/g,
    /\d+(?:\.\d+)?(?:%|％|万|亿|千|百|元|天|月|年|号|日|点|分|秒|个|条|家|次|倍|成|以上|以下)/g,
    /(?:AI|AIGC|Q[1-4]|B2B|B2C|1688|Amazon|亚马逊)/gi
  ]
  priorityPatterns.forEach((pattern, patternIndex) => {
    for (const match of source.matchAll(pattern)) {
      add(match[0], 120 - patternIndex * 5 + Math.min(match[0].length, 8), match.index ?? 0)
    }
  })

  EMPHASIS_WORDS.forEach((word) => {
    let start = source.indexOf(word)
    while (start >= 0) {
      add(word, 88 + Math.min(word.length, 8), start)
      start = source.indexOf(word, start + word.length)
    }
  })

  try {
    const Segmenter = (Intl as typeof Intl & {
      Segmenter?: new (locale?: string, options?: { granularity: 'word' }) => {
        segment(input: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>
      }
    }).Segmenter
    if (Segmenter) {
      const segmenter = new Segmenter('zh-CN', { granularity: 'word' })
      for (const part of segmenter.segment(source)) {
        const word = part.segment.replace(/[，。！？；：、,.!?;:]/g, '')
        if (part.isWordLike === false || word.length < 2 || word.length > 7) continue
        const verbBoost = /增长|提升|降低|决定|锁定|发布|成立|出海|下单|备货|发货/.test(word) ? 12 : 0
        add(word, 42 + word.length * 3 + verbBoost, part.index)
      }
    }
  } catch {
    /* 不支持 Intl.Segmenter 时，数字和词典规则仍然可用 */
  }

  const ranked = candidates.sort((a, b) => b.score - a.score || a.start - b.start)
  const selected: HighlightCandidate[] = []
  for (const candidate of ranked) {
    if (selected.some((item) => item.word === candidate.word)) continue
    const end = candidate.start + candidate.word.length
    const overlaps = selected.some((item) => {
      const itemEnd = item.start + item.word.length
      return candidate.start < itemEnd && end > item.start
    })
    if (overlaps) continue
    selected.push(candidate)
    if (selected.length >= limit) break
  }
  return selected.sort((a, b) => a.start - b.start).map((item) => item.word)
}

interface CaptionRun {
  text: string
  highlighted: boolean
}

function splitHighlightRuns(line: string, words: string[]): CaptionRun[] {
  if (!words.length) return [{ text: line, highlighted: false }]
  const runs: CaptionRun[] = []
  let cursor = 0
  while (cursor < line.length) {
    let nextWord = ''
    let nextAt = -1
    for (const word of words) {
      const at = line.indexOf(word, cursor)
      if (at >= 0 && (nextAt < 0 || at < nextAt || (at === nextAt && word.length > nextWord.length))) {
        nextAt = at
        nextWord = word
      }
    }
    if (nextAt < 0) {
      runs.push({ text: line.slice(cursor), highlighted: false })
      break
    }
    if (nextAt > cursor) runs.push({ text: line.slice(cursor, nextAt), highlighted: false })
    runs.push({ text: nextWord, highlighted: true })
    cursor = nextAt + nextWord.length
  }
  return runs.filter((run) => run.text.length > 0)
}

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
  captionBg: boolean,
  highlight: CaptionHighlightOptions = {}
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

  const highlightScale = Math.max(1, Math.min(1.5, highlight.scale ?? 1.2))
  const highlightWords = highlight.enabled
    ? (highlight.words?.filter(Boolean) ?? pickCaptionHighlights(text))
    : []
  // 重点词会变大，换行时预留少量宽度，避免靠近安全区边缘。
  const maxWidth = width * (highlightWords.length ? 0.82 : 0.86)
  const lines = wrapCaptionLines(ctx, text.trim(), maxWidth)
  if (lines.length === 0) {
    return new Blob([], { type: 'image/png' })
  }

  const lineHeight = fontSize * (highlightWords.length ? Math.max(1.45, highlightScale * 1.24) : 1.4)
  const blockHeight = lines.length * lineHeight
  const padX = Math.round(fontSize * 0.7)
  const padY = Math.round(fontSize * 0.35)
  const fontFor = (highlighted: boolean) =>
    `${style.bold ? 'bold ' : ''}${Math.round(fontSize * (highlighted ? highlightScale : 1))}px ${family}`
  const measureLine = (line: string) =>
    splitHighlightRuns(line, highlightWords).reduce((sum, run) => {
      ctx.font = fontFor(run.highlighted)
      return sum + ctx.measureText(run.text).width
    }, 0)
  const blockWidth = Math.max(...lines.map(measureLine))

  let midY: number
  if (style.yRatio != null) {
    midY = Math.max(blockHeight / 2, Math.min(height - blockHeight / 2, height * style.yRatio))
  } else {
    switch (style.position) {
      case 'top': midY = height * 0.1 + blockHeight / 2; break
      case 'center': midY = height / 2; break
      default: midY = height - height * 0.1 - blockHeight / 2
    }
  }
  const midX = width * Math.max(0.07, Math.min(0.93, style.xRatio ?? 0.5))

  if (captionBg && style.bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(style.bgColor || '#000000', style.bgOpacity)
    const x = midX - blockWidth / 2 - padX
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
    const runs = splitHighlightRuns(line, highlightWords)
    const runWidths = runs.map((run) => {
      ctx.font = fontFor(run.highlighted)
      return ctx.measureText(run.text).width
    })
    let x = midX - runWidths.reduce((sum, value) => sum + value, 0) / 2
    ctx.textAlign = 'left'
    runs.forEach((run, runIndex) => {
      ctx.font = fontFor(run.highlighted)
      if (style.strokeWidth > 0) {
        ctx.lineWidth = Math.max(2, style.strokeWidth * 2)
        ctx.strokeStyle = style.strokeColor || '#000'
        ctx.strokeText(run.text, x, ly)
      }
      ctx.fillStyle = run.highlighted ? (highlight.color || '#ffd84d') : (style.color || '#fff')
      ctx.fillText(run.text, x, ly)
      x += runWidths[runIndex]
    })
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
