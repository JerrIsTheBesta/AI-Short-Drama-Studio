/** MiniMax H3 提示词：分镜默认 integrated_multimodal_description + 内部 [Shot N]；台词只进 <d>。 */

import type { AspectRatio, Shot } from '@/types'
import { englishOrOmit, h3NameMap, h3UniqueName } from '@/utils/h3Names'
import { normalizeCameraMovement, stripFrameLead, type VideoPromptStyle } from '@/utils/shotPrompt'
import {
  isPlaceholderSpokenLine,
  looksLikeShotDirection,
  spokenTextOnly,
  stripSpokenStageDirection
} from './dialogue'
import { normalizeForSpeech } from './tts'
import { callLLM, getAIMode } from './client'
import { importedDirectorForH3 } from '@/services/settings/directorSkill'
import { parseJsonRobust } from '@/utils/jsonRepair'

export interface H3ImageSlot {
  index: number
  kind: 'character' | 'scene' | 'board' | 'extra'
  name: string
  sourceName?: string
  job: string
}

export interface H3PromptInput {
  /** 中文内容表现，或用户已写好的官方全文。 */
  prompt: string
  aesthetic?: string
  audioDescription?: string
  voiceover?: string
  voiceMode?: 'dialogue' | 'voiceover' | 'none'
  speakerHint?: string
  /**
   * 说话角色的音色描述（中文，来自人物节点 voicePrompt）。
   * 台词本身是中文，所以这里不进 englishOrOmit，直接跟在说话人后面。
   */
  speakerVoice?: string
  /**
   * 本镜出场人物各自的声音描述（中文，来自人物卡 voicePrompt）。
   * 必须写在提示词最开头，紧跟「图几是谁」，否则会被正文中文清洗一起抹掉。
   */
  voiceRoster?: string
  speakerName?: string
  /** 画面里实际出镜的人，画外音时必须闭嘴。 */
  onScreenNames?: string[]
  sceneName?: string
  sceneDescription?: string
  sceneLighting?: string
  sceneAnchor?: string
  shotTitle?: string
  imageAssignments?: string[]
  /** 按提交顺序的图槽：图1是谁、哪张是场景、哪张是看板。 */
  imageSlots?: H3ImageSlot[]
  duration: number
  width?: number
  height?: number
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  shotSize?: string
  blocking?: string
  eyeline?: string
  continuity?: string
  purpose?: string
  mode?: 'I2VA' | 'T2VA' | 'R2VA'
  promptStyle?: VideoPromptStyle
  /** 分镜出片：只用 integrated_multimodal_description，内部可切 [Shot 2]/[Shot 3]。 */
  forceIntegrated?: boolean
  signal?: AbortSignal
}

type LabeledSlot = {
  kind: 'character' | 'scene' | 'board' | 'extra'
  picture: number
  subject?: number
  name: string
  sourceName?: string
}

/** 官方运镜三维：类型 + amplitude + speed，写成句内动作。 */
const CAMERA_EN: Record<NonNullable<Shot['cameraMovement']>, string> = {
  push: 'The camera pushes in with small amplitude at slow speed',
  pull: 'The camera pulls out with small amplitude at slow speed',
  pan: 'The camera pans right with small amplitude at slow speed',
  tilt: 'The camera tilts up with small amplitude at slow speed',
  static: 'The camera holds a static shot',
  orbit: 'The camera moves in an arc around the subject with small amplitude at slow speed'
}

export function detectDialogueLanguage(text: string): string {
  const value = text.trim()
  if (/[぀-ヿ]/.test(value)) return 'Japanese'
  if (/[가-힯]/.test(value)) return 'Korean'
  if (/[㐀-鿿]/.test(value)) return 'Chinese'
  return 'English'
}

/** 台词/旁白只允许进这个标签；中文原词固定 [Chinese]。 */
export function h3SpokenTag(spoken: string): string {
  const line = sanitizeDialogue(spoken)
  if (!line) return ''
  return `<d>[Chinese] ${line}</d>`
}

export function isOfficialH3Prompt(text: string): boolean {
  if (isMessyH3Prompt(text) || isH3FillTemplate(text)) return false
  const hasSound = /overall_soundscape\s*:/i.test(text)
  const hasI2va = /integrated_multimodal_description\s*:/i.test(text)
  const hasR2va = /subject_definitions\s*:/i.test(text) && /detailed_description\s*:/i.test(text)
  return hasSound && (hasI2va || hasR2va)
}

/** 官方 FL2VA 首行：Picture 1=0.00s，Picture 2=片尾。 */
export function ensureFl2vaLead(prompt: string, duration: number): string {
  const body = String(prompt || '').trim()
  if (/aligns with the 0\.00-second mark/i.test(body) && /Picture 2/i.test(body)) return body
  const end = Math.max(1, Number(duration) || 5).toFixed(2)
  const lead = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the ${end}-second mark of the target video.`
  return body ? `${lead}\n\n${body}` : lead
}

/** 只有槽位和套话、没有这一镜具体戏的空模板 */
export function isH3FillTemplate(text: string): boolean {
  const t = String(text || '')
  return (
    /hands, clothing and the air in the place start to move/i.test(t) ||
    /brows, eyes and mouth show a specific emotion, not a blank stare/i.test(t) ||
    /the core action completes, residual breath and eye motion remain/i.test(t) ||
    /Play the following director notes/i.test(t)
  )
}

/** 把中文场记原样塞进英文模板、或混用 Ref2VA 六段的脏稿。不能发给 H3。 */
export function isMessyH3Prompt(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (/Play the following director notes/i.test(t)) return true
  if (/subject_definitions\s*:/i.test(t)) return true
  if (/the place named in the director notes/i.test(t)) return true
  return /[㐀-鿿]/.test(stripAllowedCjk(t))
}

/**
 * 允许留在英文正文里的中文：台词 <d>、图号身份、被《》式书名号包的人名，
 * 以及开头那块「人物声音」（音色是中文，删了人物就没有声音了）。
 */
function stripAllowedCjk(text: string): string {
  return String(text || '')
    .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    .replace(/图\s*\d+\s*[是：:=]*/g, '')
    .replace(/「[^」]{1,24}」/g, '')
    .replace(/人物声音[^\n]*(?:\r?\n(?!\r?\n)[^\n]*)*/g, '')
}

function cjkOutsideSpokenTags(text: string): boolean {
  return /[㐀-鿿]/.test(stripAllowedCjk(text))
}

/** 正文里的汉字一律删掉；只保留 <d> 里的台词、图号/「人名」身份锁定和人物声音块。 */
export function stripCjkOutsideSpokenTags(text: string): string {
  const held: string[] = []
  const mask = (block: string) => {
    held.push(block)
    return `__H3KEEP${held.length - 1}__`
  }
  const masked = String(text || '')
    .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, mask)
    .replace(/图\s*\d+\s*[是：:=]*/g, mask)
    .replace(/「[^」]{1,24}」/g, mask)
    // 音色是中文：整块护住，否则会被下面的汉字清理删成空壳
    .replace(/人物声音[^\n]*(?:\r?\n(?!\r?\n)[^\n]*)*/g, mask)
    .replace(/voice\s*:\s*[^\n,]*/gi, mask)
  const cleaned = masked
    .replace(/[\u3400-\u9fff]+/g, '')
    .replace(/This shot is titled\s*\./gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.replace(/__H3KEEP(\d+)__/g, (_, i) => held[Number(i)] || '')
}

function looksLikeSpokenDialogue(text: string): boolean {
  const line = String(text || '').trim()
  if (!line || isPlaceholderSpokenLine(line) || looksLikeShotDirection(line)) return false
  if (line.length > 48) return false
  if (line.length >= 40 && !/[！？!?]/.test(line)) return false
  if (/图\s*\d+|Camera language|Performance direction|时长|画风|场记|integrated_multimodal|Reference pictures/i.test(line)) {
    return false
  }
  if (line.length <= 4 && !/[。！？!?，、]/.test(line)) return false
  return /[\u3400-\u9fff]/.test(line)
}

function sanitizeDialogue(text: string): string {
  const line = stripSpokenStageDirection(
    normalizeForSpeech(spokenTextOnly(text))
      .replace(/<\/?d>/gi, '')
      .replace(/\[[^\]]{0,120}\]/g, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
  if (!line || isPlaceholderSpokenLine(line) || looksLikeShotDirection(line)) return ''
  if (!looksLikeSpokenDialogue(line)) return ''
  return line
}

/** 已写成官方稿时，把 <d> 里的场记清掉；标本格式的说话人/口型提示保留在括号里。 */
export function sanitizeDTagContents(text: string): string {
  return String(text || '')
    .replace(/<d>\s*(\[[^\]]*\])?\s*([\s\S]*?)<\/d>/gi, (_, bracket, inner) => {
      const line = sanitizeDialogue(inner)
      if (!line) return ''
      const meta = String(bracket || '').trim()
      if (/^\[Chinese\b/i.test(meta) && /,/.test(meta)) return `<d>${meta} ${line}</d>`
      return `<d>[Chinese] ${line}</d>`
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按行拆对白，去掉「人物名：」后只留要进 <d> 的原词。场记/时长轴/图号不能当台词。 */
export function spokenCueLines(voiceover: string): string[] {
  return String(voiceover || '')
    .split(/\r?\n/)
    .map((line) => sanitizeDialogue(line))
    .filter((line) => line && !isPlaceholderSpokenLine(line) && !looksLikeShotDirection(line))
}

export function formatH3Timestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000))
  const m = Math.floor(totalMs / 60_000)
  const rest = totalMs % 60_000
  const s = Math.floor(rest / 1000)
  const ms = rest % 1000
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
}

/** 一条成片内部的 [Shot 1/2/3] 时间切分，不是画布上的多个分镜节点。 */
export function h3InternalShotPlan(
  duration: number,
  spokenCount = 0
): Array<{ index: number; at?: string; beat: string }> {
  const total = Math.max(5, Math.min(10, Number(duration) || 5))
  const want = spokenCount >= 3 ? 3 : spokenCount === 2 ? 2 : total >= 8 ? 3 : total >= 6 ? 2 : 1
  const count = Math.min(3, Math.max(1, want))
  if (count === 1) return [{ index: 1, beat: total.toFixed(2) }]
  if (count === 2) {
    const cut = Math.min(3, Math.max(2, Math.round(total / 2)))
    return [
      { index: 1, beat: cut.toFixed(2) },
      { index: 2, at: formatH3Timestamp(cut), beat: (total - cut).toFixed(2) }
    ]
  }
  return [
    { index: 1, beat: '3.00' },
    { index: 2, at: formatH3Timestamp(3), beat: '3.00' },
    { index: 3, at: formatH3Timestamp(6), beat: Math.max(1, total - 6).toFixed(2) }
  ]
}

function describeInternalShotPlan(duration: number, spokenCount: number): string {
  const plan = h3InternalShotPlan(duration, spokenCount)
  return plan
    .map((item, i, all) => {
      const last = i === all.length - 1
      const finish = last
        ? ` End this last beat with: The action develops continuously and finishes naturally within ${item.beat} seconds.`
        : ''
      if (item.index === 1) {
        return `[Shot 1] no timestamp; this beat is about ${item.beat}s.${finish}`
      }
      return `[Shot ${item.index}] At ${item.at}, ...; this beat is about ${item.beat}s.${finish}`
    })
    .join('\n')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractField(text: string, name: string): string {
  const re = new RegExp(
    `${name}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\\s*:|$)`,
    'i'
  )
  return (text.match(re)?.[1] || '').trim()
}

function durationText(input: H3PromptInput): string {
  return Math.max(4, Math.min(15, Number(input.duration) || 5)).toFixed(2)
}

function styleLead(aesthetic?: string): string {
  const a = aesthetic || ''
  if (/动漫|二次元|anime|2d/i.test(a)) return '2D-animated, cinematic'
  if (/3d|三维|cg/i.test(a)) return '3D CG, cinematic'
  if (/水彩|watercolor/i.test(a)) return 'watercolor, cinematic'
  return 'Cinematic, live-action'
}

function cameraBeatEn(
  movement: NonNullable<Shot['cameraMovement']>,
  index: number,
  total: number
): string {
  switch (movement) {
    case 'push':
      if (index === 0) return 'The camera starts slightly wider, then begins a slow small-amplitude push-in.'
      if (index === total - 1) return 'The push-in eases to a stop on a closer frame; no extra zoom.'
      return 'The camera continues the same slow small-amplitude push-in on one axis.'
    case 'pull':
      if (index === 0) return 'The camera starts closer, then begins a slow small-amplitude pull-out.'
      if (index === total - 1) return 'The pull-out eases to a stop, revealing more of the place.'
      return 'The camera continues the same slow small-amplitude pull-out on one axis.'
    case 'pan':
      if (index === 0) return 'The camera holds the opening frame, then begins a slow pan right with small amplitude at slow speed.'
      if (index === total - 1) return 'The pan eases to a stop on the end frame.'
      return 'The camera continues the same slow pan; no whip pan.'
    case 'tilt':
      if (index === 0) return 'The camera holds the opening frame, then begins a slow tilt up with small amplitude at slow speed.'
      if (index === total - 1) return 'The tilt eases to a stop on the end frame.'
      return 'The camera continues the same slow tilt.'
    case 'orbit':
      if (index === 0) return 'The camera begins a small-amplitude slow arc around the subject.'
      if (index === total - 1) return 'The arc eases to a stop; do not travel more than a short arc.'
      return 'The camera continues the same small-amplitude slow arc, axis unchanged.'
    default:
      return 'The camera holds a static shot with only subtle natural sway; no pan, tilt, or zoom.'
  }
}

export function buildH3ImageSlots(
  entries: Array<{ kind: 'character' | 'scene' | 'board' | 'extra' | 'keyframe'; name?: string }>
): H3ImageSlot[] {
  const map = h3NameMap(entries.filter((entry) => entry.kind === 'character').map((entry) => entry.name))
  let place = 0
  let extra = 0
  return entries.map((entry, i) => {
    const index = i + 1
    if (entry.kind === 'character') {
      const name = (entry.name && map[entry.name]) || h3UniqueName(entry.name, index, 'person')
      return {
        index,
        kind: 'character',
        name,
        sourceName: entry.name,
        job: `<Subject identity from Picture ${index}> ${name} is the person in <Picture ${index}>. Lock only this person's face, hair, body, age and outfit. Do not generate a four-view grid or extra people.`
      }
    }
    if (entry.kind === 'scene') {
      place += 1
      const name = h3UniqueName(entry.name, place, 'place')
      return {
        index,
        kind: 'scene',
        name,
        sourceName: entry.name,
        job: `${name} is the location in <Picture ${index}>. Lock only space, materials, weather and light. Use ONE unified place. Do not generate a four-panel grid.`
      }
    }
    if (entry.kind === 'keyframe') {
      return {
        index,
        kind: 'board' as const,
        name: 'the four-panel keyframe',
        sourceName: entry.name,
        job: `<Picture ${index}> is a 2x2 four-panel keyframe for [Shot 1] (exactly 4 cells). Action order only. Never copy the grid, borders, or play four stills as a slideshow.`
      }
    }
    if (entry.kind === 'extra') {
      extra += 1
      return {
        index,
        kind: 'extra',
        name: `user reference ${extra}`,
        sourceName: entry.name,
        job: `<Picture ${index}> is an additional user reference. Match people, clothing, product, setting or style from this image. Do not treat it as another first frame, a grid, or a slideshow.`
      }
    }
    return {
      index,
      kind: 'board',
      name: 'the storyboard',
      job: `<Picture ${index}> is a storyboard reference for [Shot 1], defining viewpoint, subject placement, and shot order. Never copy panels, borders, sketches, or a slideshow of stills.`
    }
  })
}

function slotsOf(input: H3PromptInput): H3ImageSlot[] {
  if (input.imageSlots?.length) return input.imageSlots
  const assigns = input.imageAssignments ?? []
  if (!assigns.length) return []
  return assigns.map((text, i) => {
    const index = i + 1
    const cleaned = String(text || '').trim()
    if (/storyboard/i.test(cleaned)) {
      return { index, kind: 'board' as const, name: 'the storyboard', job: cleaned }
    }
    if (/scene plate|location|SCENE PLATE/i.test(cleaned)) {
      return { index, kind: 'scene' as const, name: `Place ${index}`, job: cleaned }
    }
    return { index, kind: 'character' as const, name: `Person ${index}`, job: cleaned }
  })
}

function labeledSlots(input: H3PromptInput): LabeledSlot[] {
  let subject = 0
  return slotsOf(input).map((slot) => {
    if (slot.kind === 'board' || slot.kind === 'extra') {
      return { kind: slot.kind, picture: slot.index, name: slot.name, sourceName: slot.sourceName }
    }
    subject += 1
    return {
      kind: slot.kind,
      picture: slot.index,
      subject,
      name: slot.name,
      sourceName: slot.sourceName
    }
  })
}

/** 人设/场景/看板多图参考走 Ref2VA；单张作为成片第一帧才走 I2VA。 */
export function isRef2VA(input?: H3PromptInput): boolean {
  if (!input) return false
  if (input.mode === 'T2VA' || input.mode === 'I2VA') return false
  if (input.mode === 'R2VA') return true
  const slots = slotsOf(input)
  if (slots.some((slot) => slot.kind === 'board')) return true
  return slots.filter((slot) => slot.kind === 'character' || slot.kind === 'scene').length >= 2
}

function pictureRoster(input: H3PromptInput): string {
  return pictureIdentityBlock(input)
}

function identityLabel(slot: LabeledSlot): string {
  const source = String(slot.sourceName || '').trim()
  const en = String(slot.name || '').trim()
  const zh = source && /[㐀-鿿]/.test(source) ? `「${source}」` : ''
  if (zh && (!en || /^Person\s+\d+$/i.test(en) || /^Place\s+\d+$/i.test(en))) return zh
  if (zh) return `${en}${zh}`
  if (source && source !== en) return `${en}「${source}」`
  return en || `reference ${slot.picture}`
}

/** 人物图用 (S1)(S2) 固定绑到对应 Picture。S 号跟人物走，不跟台词顺序走。 */
export function pictureIdentityBlock(input: H3PromptInput): string {
  const slots = labeledSlots(input)
  if (!slots.length) return ''
  const lines = ['Speaker lock (these labels are the pictures):']
  let speaker = 0
  for (const slot of slots) {
    const who = identityLabel(slot)
    if (slot.kind === 'character') {
      speaker += 1
      lines.push(
        `(S${speaker}) is ${who} / <Picture ${slot.picture}>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.`
      )
      continue
    }
    if (slot.kind === 'scene') {
      lines.push(`<Picture ${slot.picture}> is the location ${who}. Lock space, materials, weather and light. One unified place.`)
      continue
    }
    if (slot.kind === 'board') {
      lines.push(
        `<Picture ${slot.picture}> is a storyboard or keyframe for blocking and order only. Never show the grid, panels or labels on screen.`
      )
      continue
    }
    lines.push(`<Picture ${slot.picture}> is additional reference ${who}. Match people, clothing, product, setting or style from this image.`)
  }
  if (speaker >= 2) {
    lines.push(
      'Only one (S#) speaks at a time, and each person says their own line once. Everyone else keeps their lips completely closed. No overlap, no chorus, no second person repeating the same line.'
    )
  } else if (speaker === 1) {
    lines.push('Only (S1) may speak. Every other mouth stays completely closed.')
  }
  return lines.join('\n')
}

export function promptHasPictureIdentity(text: string, count: number): boolean {
  if (count <= 0) return true
  const src = String(text || '')
  for (let i = 1; i <= count; i++) {
    const hit = new RegExp(
      `(?:图\\s*${i}\\s*[/：:=是]|\\(S\\d+\\)\\s+is\\b[^\\n]*<Picture\\s*${i}>|<Picture\\s*${i}>\\s+is\\b)`,
      'i'
    ).test(src)
    if (!hit) return false
  }
  return true
}

/** 用代码写死的图1/图2/图3 身份块覆盖模型稿；不依赖模型自觉写。 */
export function ensurePictureIdentity(prompt: string, input: H3PromptInput): string {
  const block = pictureIdentityBlock(input)
  if (!block) return String(prompt || '').trim()
  let src = String(prompt || '').trim()
  // 清掉旧的 Reference pictures / 残缺图号段，再强制插入权威映射
  src = src
    .replace(/Reference pictures\s*\([^)]*\)\s*:[\s\S]*?(?=\n\s*\[Shot\s*\d+\]|\n\s*(?:镜头|景别与运镜|画面与动作依据)\s*[：:]|\n\s*Camera language\s*:|\n\s*overall_soundscape\s*:|$)/i, '')
    .replace(/Speaker lock \(these labels are the pictures\):[\s\S]*?(?=\n\s*\[Shot\s*\d+\]|\n\s*Camera language\s*:|\n\s*overall_soundscape\s*:|$)/i, '')
    .replace(/(?:^|\n)(?:图\s*\d+\s*[/：:=是][^\n]*\n)+/g, '\n')
    .replace(/(?:^|\n)\(S\d+\)\s+is\b[^\n]*\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (/integrated_multimodal_description\s*:/i.test(src)) {
    return src.replace(/(integrated_multimodal_description\s*:\s*)/i, `$1${block}\n\n`)
  }
  return `${block}\n\n${src}`
}

/**
 * 人物声音必须紧跟「图几是谁」写清楚：谁的声音是什么样，开口就按这个来。
 * 用代码插入，不依赖模型自觉，也不让旧稿里残缺的音色段落留在正文中间。
 */
export function ensureVoiceRoster(prompt: string, roster: string): string {
  const block = String(roster || '').trim()
  if (!block) return String(prompt || '')
  const src = String(prompt || '')
    .replace(/人物声音[^\n]*(?:\r?\n(?!\r?\n)[^\n]*)*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!src) return block
  const lines = src.split('\n')
  let last = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*图\s*\d+\s*[/：:=是]/.test(line) || /^\s*\(S\d+\)\s+is\b/.test(line) || /^\s*<Picture\s+\d+>\s+is\b/i.test(line)) {
      last = i
      continue
    }
    // 图号块结束（遇到空行或正文起手）就停，别把正文里的图号也算进来
    if (last >= 0 && (!line.trim() || /^\[Shot\s*\d+\]/i.test(line))) break
  }
  if (last >= 0) {
    lines.splice(last + 1, 0, '', block)
    return lines.join('\n').replace(/\n{3,}/g, '\n\n')
  }
  return `${block}\n\n${src}`
}

function onScreenEnglish(input: H3PromptInput): string[] {
  const fromSlots = slotsOf(input)
    .filter((slot) => slot.kind === 'character')
    .map((slot) => slot.name)
  if (fromSlots.length) return fromSlots
  const map = h3NameMap(input.onScreenNames ?? [])
  return (input.onScreenNames ?? []).map((name) => map[name]).filter(Boolean)
}

function characterPeople(input: H3PromptInput): LabeledSlot[] {
  return labeledSlots(input).filter((slot) => slot.kind === 'character')
}

function bareSpeakerName(raw?: string): string {
  return String(raw || '')
    .replace(/[（(][^）)]{0,16}[）)]/g, '')
    .replace(/[「」]/g, '')
    .trim()
}

/** (S1) 永远是第一张人物图，不按台词先后重新编号。 */
function speakerCode(input: H3PromptInput, raw?: string): string {
  const people = characterPeople(input)
  const wanted = [bareSpeakerName(raw), bareSpeakerName(input.speakerName)].filter(Boolean)
  for (const name of wanted) {
    const hit = people.findIndex((slot) => {
      const src = bareSpeakerName(slot.sourceName)
      const en = bareSpeakerName(slot.name)
      return src === name || en === name || (!!src && (name.includes(src) || src.includes(name)))
    })
    if (hit >= 0) return `S${hit + 1}`
  }
  return 'S1'
}

function quietOthers(input: H3PromptInput, code: string): string {
  const others = characterPeople(input)
    .map((_, index) => `S${index + 1}`)
    .filter((id) => id !== code)
  if (!others.length) return `Only (${code}) speaks. Every other mouth stays completely closed.`
  const rest = others.map((id) => `(${id})`).join(' and ')
  const verb = others.length === 1 ? 'keeps' : 'keep'
  const voice = others.length === 1 ? 'makes' : 'make'
  return `Only (${code}) speaks in this shot. ${rest} ${verb} their lips completely closed and ${voice} no voice.`
}

function dialogueBlocks(input: H3PromptInput, lines: string[]): string {
  if (!lines.length || input.voiceMode === 'none') return 'No dialogue. No lips moving.'
  const cues = dialogueCuesForPrompt(input)
  const voiceTag = String(input.speakerVoice || '').trim().replace(/[；;]+$/, '')
  if (input.voiceMode === 'voiceover') {
    const spoken = lines
      .map((line, i) => {
        const cue = cues.find((item) => item.text === line) || cues[i]
        const code = speakerCode(input, cue?.speaker)
        return `(${code})${voiceTag ? `, voice: ${voiceTag}` : ''} says in an off-screen voiceover: ${h3SpokenTag(line)} ${quietOthers(input, code)}`
      })
      .join('\n\n')
    return `${spoken} The words inside the d tag are being called from off-screen; nobody on screen mouths them.`
  }
  const hint = englishOrOmit(input.speakerHint?.replace(/^\[|\]$/g, ''))
  return lines
    .map((line, i) => {
      const cue = cues.find((item) => item.text === line) || cues[i]
      const code = speakerCode(input, cue?.speaker)
      const extra = [i === 0 && voiceTag ? `voice: ${voiceTag}` : '', i === 0 ? hint : ''].filter(Boolean).join(', ')
      const lead = extra ? `(${code}), ${extra},` : `(${code})`
      return `${lead} says: ${h3SpokenTag(line)} ${quietOthers(input, code)}`
    })
    .join('\n\n')
}

function stripDialogueMentions(text: string): string {
  return text
    .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    .replace(/[^.]{0,120}\(S1\)[\s\S]{0,260}?(?:says in an off-screen voiceover|says):[\s\S]*?(?:closed\.|silently\.)/gi, '')
    .replace(/No dialogue\.?\s*(No lips moving\.?)?/gi, '')
    .replace(/On-screen lips remain completely closed\.?/gi, '')
    .replace(/while (?:his|her|their) lips remain completely closed\.?/gi, '')
    .replace(/Every on-screen person keeps the mouth completely closed\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function stripSpokenLeaks(text: string, spoken: string): string {
  let next = text.replace(/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*[\s\S]*?<\/d>/gi, '')
  const lines = spokenCueLines(spoken)
  const all = lines.length ? lines : spoken ? [sanitizeDialogue(spoken)].filter(Boolean) : []
  if (!all.length) return next.replace(/\s{2,}/g, ' ').trim()
  for (const line of all) {
    const quoted = (chunk: string) => {
      const inner = chunk.slice(1, -1)
      return inner.includes(line) || line.includes(inner) ? '' : chunk
    }
    next = next
      .replace(/[“「][^”」]*[”」]/g, quoted)
      .replace(/"(?:[^"\\]|\\.)*"/g, (chunk) => (/[㐀-鿿]/.test(chunk) ? quoted(chunk) : chunk))
    if (line.length >= 4) {
      next = next.replace(new RegExp(escapeRegExp(line), 'g'), '')
    }
  }
  return next
    .replace(/(?:台词|对白|旁白|口播)\s*[：:]\s*[^：:\n]{0,16}\s*[：:]\s*(?=\n|$|Location facts)/gi, '')
    .replace(/\s*Location facts\s*:[^\n]*/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripSpokenLeaksOutsideTags(text: string, voiceover: string): string {
  const held: string[] = []
  const masked = text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, (block) => {
    held.push(block)
    return `__H3D${held.length - 1}__`
  })
  return stripSpokenLeaks(masked, voiceover).replace(/__H3D(\d+)__/g, (_, i) => held[Number(i)] || '')
}

function stripUnofficialBeatHeadings(text: string): string {
  return text
    .replace(/\bFrom\s+\d+(?:\.\d+)?s?\s+to\s+\d+(?:\.\d+)?s:\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function subjectDefinitions(input: H3PromptInput): string {
  const lines: string[] = []
  for (const slot of labeledSlots(input)) {
    const pic = `<Picture ${slot.picture}>`
    if (slot.kind === 'board') {
      lines.push(
        `${pic} is a storyboard reference for [Shot 1], defining viewpoint, subject placement, and shot order.`
      )
      continue
    }
    if (slot.kind === 'extra') {
      lines.push(
        `${pic} is an additional user reference. Match people, clothing, product, setting or style from this image. Do not copy a grid or treat it as another first frame.`
      )
      continue
    }
    if (slot.kind === 'scene') {
      const extra = englishOrOmit(input.sceneLighting)
      lines.push(
        extra
          ? `<Subject ${slot.subject}> is ${slot.name} in ${pic}, a unified location with ${extra}.`
          : `<Subject ${slot.subject}> is ${slot.name} in ${pic}, the location for [Shot 1].`
      )
      continue
    }
    lines.push(
      `<Subject ${slot.subject}> is ${slot.name} in ${pic}, the person whose face, hair, body, age and outfit must stay locked.`
    )
  }
  return lines.join('\n')
}

function summaryBlock(input: H3PromptInput): string {
  const labeled = labeledSlots(input)
  const people = labeled.filter((slot) => slot.kind === 'character')
  const place = labeled.find((slot) => slot.kind === 'scene')
  const board = labeled.find((slot) => slot.kind === 'board')
  const who = people.map((slot) => `<Subject ${slot.subject}>`).join(' and ') || 'the referenced people'
  const where = place ? `<Subject ${place.subject}>` : 'the referenced location'
  const boardLine = board
    ? ` <Picture ${board.picture}> is a storyboard reference for [Shot 1] only.`
    : ''
  const extraCount = labeled.filter((slot) => slot.kind === 'extra').length
  const extraLine = extraCount
    ? ` Also lock ${extraCount} additional user reference image${extraCount > 1 ? 's' : ''}.`
    : ''
  return `[reference generation] The target video is one continuous [Shot 1] of ${who} in ${where}.${boardLine}${extraLine} Character sheets lock identity only. The location plate locks space and light only. The storyboard never appears on screen.`
}

function retentionAnalysis(input: H3PromptInput): string {
  return labeledSlots(input)
    .map((slot) => {
      if (slot.kind === 'board') {
        return `<Picture ${slot.picture}> (storyboard for [Shot 1]): weak_reference - viewpoint, blocking and order only; the panel grid never appears on screen.`
      }
      if (slot.kind === 'extra') {
        return `<Picture ${slot.picture}> (additional user reference): fully_preserved - people, clothing, product, setting or style from this image.`
      }
      if (slot.kind === 'scene') {
        return `<Subject ${slot.subject}> (appears in [Shot 1]): fully_preserved - space, materials, weather and light from <Picture ${slot.picture}>.`
      }
      return `<Subject ${slot.subject}> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture ${slot.picture}>.`
    })
    .join('\n')
}

function assembleOfficial(desc: string, sound: string, music = 'N/A', input?: H3PromptInput): string {
  let body = stripCjkOutsideSpokenTags(desc.trim())
  if (input) {
    body = ensurePictureIdentity(body, input)
    body = ensureVoiceRoster(body, input.voiceRoster || '')
  }
  const extraJobs = input
    ? slotsOf(input)
        .filter((slot) => slot.kind === 'extra' && slot.index > 1)
        .map((slot) => slot.job)
        .join('\n')
    : ''
  const alignment =
    input &&
    input.mode === 'I2VA' &&
    !input.forceIntegrated &&
    slotsOf(input).length &&
    !/\[Shot\s*[2-9]\]/i.test(body)
      ? `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.${extraJobs ? `\n${extraJobs}` : ''}\n\n`
      : ''
  return stripCjkOutsideSpokenTags(`${alignment}integrated_multimodal_description:
${sanitizeDTagContents(body)}

overall_soundscape:
${stripCjkOutsideSpokenTags(sound.trim())}

non_diegetic_music:
${(music.trim() || 'N/A')}`)
}

function finishLine(input: H3PromptInput): string {
  return `The action develops continuously and finishes naturally within ${durationText(input)} seconds.`
}

function ensureOfficialBody(desc: string, input: H3PromptInput): string {
  const cleaned = stripUnofficialBeatHeadings(desc)
  const match = cleaned.match(/^([\s\S]*?)(\[Shot\s*1\][\s\S]*)$/i)
  const style = (match?.[1] || '').trim()
  const shot = (match?.[2] || cleaned).trim()
  let body = shot.replace(/^\[Shot\s*1\]\s*/i, '').trim()
  const lead = styleLead(input.aesthetic)
  if (!/\b(cinematic|live-action|2d-animated|3d cg|watercolor)/i.test(`${style}\n${body}`)) {
    body = `${lead}, ${body}`
  }
  return `[Shot 1] ${body}`
}

function ensureSpokenTags(text: string, lines: string[]): string {
  if (!lines.length) return sanitizeDTagContents(text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '').trim())
  const tags = lines.map((line) => h3SpokenTag(line)).filter(Boolean)
  if (!tags.length) return sanitizeDTagContents(text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '').trim())
  const existing = [...text.matchAll(/<d>\s*(\[[^\]]*\])?\s*([\s\S]*?)<\/d>/gi)]
  const taggedText = existing.map((m) => sanitizeDialogue(m[2] || ''))
  const exactMatch =
    taggedText.length === lines.length &&
    lines.every((line, i) => taggedText[i] === line)
  if (exactMatch) {
    return sanitizeDTagContents(text)
  }
  // 与可信台词不一致时：清空旧 <d>，再按可信列表重写，避免场记残留
  let cleaned = text.replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '').trim()
  const extra = tags.join('\n\n')
  if (/\[\d{2}:\d{2}\.\d{3}\s*[–-]/i.test(cleaned)) {
    // 插到第一个时间轴段落后
    const rebuilt = cleaned.replace(
      /(\[\d{2}:\d{2}\.\d{3}\s*[–-][^\]]+\][\s\S]*?)(?=\n\s*\[\d{2}:\d{2}\.\d{3}|\n\s*Camera language\s*:|$)/i,
      (chunk) => `${chunk.trim()}\n\n${extra}\n`
    )
    if (rebuilt !== cleaned) return sanitizeDTagContents(rebuilt)
  }
  if (/\[Shot\s*2\]/i.test(cleaned)) {
    return sanitizeDTagContents(cleaned.replace(/\[Shot\s*2\]/i, `${extra}\n\n[Shot 2]`))
  }
  if (/Camera language\s*:/i.test(cleaned)) {
    return sanitizeDTagContents(cleaned.replace(/Camera language\s*:/i, `${extra}\n\nCamera language:`))
  }
  return sanitizeDTagContents(`${cleaned}\n\n${extra}`.trim())
}

function extractQuotedSpeech(text: string): string[] {
  const out: string[] = []
  for (const match of String(text || '').matchAll(/[“「"'‘]([^”」"'’\n]{1,40})[”」"'’]/g)) {
    const line = sanitizeDialogue(match[1] || '')
    if (line && looksLikeSpokenDialogue(line) && !out.includes(line)) out.push(line)
  }
  return out
}

/** 从节点原文里抠台词：只认 d 标签、引号、「台词/对白」行、喊出「…」。整段场记绝不拆成台词。 */
export function extractSpokenFromNotes(text: string): string[] {
  const raw = String(text || '')
  if (!raw.trim()) return []
  const fromTags = [...raw.matchAll(/<d>\s*\[[^\]]*\]\s*([\s\S]*?)<\/d>/gi)]
    .map((m) => sanitizeDialogue(m[1] || ''))
    .filter((line) => line && !isPlaceholderSpokenLine(line) && looksLikeSpokenDialogue(line))
  if (fromTags.length) return [...new Set(fromTags)]

  const out = extractQuotedSpeech(raw)
  for (const match of raw.matchAll(/(?:^|\n)\s*(?:台词|对白|口播|旁白)\s*[：:]\s*(.+)$/gm)) {
    const body = String(match[1] || '').trim()
    if (looksLikeShotDirection(body)) continue
    const line = sanitizeDialogue(body)
    if (line && /[㐀-鿿]/.test(line) && !out.includes(line)) out.push(line)
  }
  for (const match of raw.matchAll(
    /(?:^|\n)\s*([\u3400-\u9fff]{1,8})(?:[（(][^）)\n]{0,16}[）)])?\s*[：:]\s*([^\n]+)/g
  )) {
    const label = String(match[1] || '').trim()
    if (/^(?:场景|音效|镜头|景别|时长|画风|站位|地点|道具|场记|画面|动作|运镜|机位|构图|环境|光影|备注|说明)$/.test(label)) {
      continue
    }
    const line = sanitizeDialogue(match[2] || '')
    if (line && looksLikeSpokenDialogue(line) && !out.includes(line)) out.push(line)
  }
  for (const match of raw.matchAll(
    /(?:喊出|喊道|叫道|叫着|轻声说|小声说|小声喊)\s*[“「"'‘]([\u3400-\u9fff，。！？!?、]{1,24})[”」"'’]/g
  )) {
    const line = sanitizeDialogue(match[1] || '')
    if (line && !out.includes(line)) out.push(line)
  }
  return out
}

export function nodeTextHasSpeech(text: string): boolean {
  const t = String(text || '')
  if (extractSpokenFromNotes(t).length) return true
  if (/没有台词|无对白|不说话|无口播|No dialogue/i.test(t)) return false
  if (/<d\s*>/i.test(t) && !/<d>\s*\[[^\]]+\]\s*(?:无|没有|无对白|none|N\/A)\s*<\/d>/i.test(t)) return true
  return /(?:喊出|喊道|叫道|叫着|轻声说|小声说|小声喊)/.test(t)
}

export function nodeTextForbidsSpeech(text: string): boolean {
  const t = String(text || '')
  if (extractSpokenFromNotes(t).length) return false
  return /没有台词|无对白|不说话|无口播|No dialogue/i.test(t)
}

function spokenLinesForPrompt(input: H3PromptInput): string[] {
  // 口播栏一旦有内容，它就是唯一台词来源。人物小传里的「欲望」「弧光」等引号
  // 不是对白，不能再从整包场记中二次抽取。
  if (input.voiceMode === 'none') return []
  const fromVo = spokenCueLines(input.voiceover || '')
  if (fromVo.length) return [...new Set(fromVo)]
  const fromNotes = extractSpokenFromNotes(
    String(input.prompt || '')
      .replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '')
      .replace(/【(?:节点当前提示词|本镜场记|分镜字段|口播栏)[^】]*】/g, '')
  )
  const merged: string[] = []
  for (const line of [...fromVo, ...fromNotes]) {
    if (line && looksLikeSpokenDialogue(line) && !looksLikeShotDirection(line) && !merged.includes(line)) {
      merged.push(line)
    }
  }
  return merged
}

function isStructuredShotBody(text: string): boolean {
  return (
    /\[Shot\s*1\]/i.test(text) ||
    /\[\d{2}:\d{2}\.\d{3}\s*[–-]/i.test(text) ||
    /Camera language\s*:/i.test(text) ||
    /Performance direction\s*:/i.test(text)
  )
}

function applyDialogue(desc: string, input: H3PromptInput): string {
  // 可信台词：口播栏 / 引号 / 「台词：」。没有就强制无对白，丢掉模型胡写的 <d>。
  const wanted = spokenLinesForPrompt(input)
  if (isStructuredShotBody(desc)) {
    let body = desc.trim()
    if (wanted.length) {
      const owned = dialogueCuesForPrompt(input).filter((cue) => wanted.includes(cue.text))
      const turnIssue = dialogueTurnIssue(body, owned.length ? owned : wanted.map((text) => ({ text })))
      const spokenTurns = [...body.matchAll(/\(S(\d+)\)[^<\n]{0,160}\b(?:says?|asks?|shouts?|replies?|exclaims?|yells?|whispers?)\b[\s\S]{0,80}<d>/gi)]
      const codesMatch = wanted.every((line, index) => {
        const cue = owned.find((item) => item.text === line) || owned[index]
        const code = speakerCode(input, cue?.speaker).replace(/^S/, '')
        return spokenTurns[index]?.[1] === code
      })
      if (turnIssue || !codesMatch || !/<d>\s*\[/i.test(body)) {
        body = `${body.replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '').trim()}\n\n${dialogueBlocks(input, wanted)}`.trim()
      } else {
        body = ensureSpokenTags(body, wanted)
      }
    } else {
      body = sanitizeDTagContents(
        body
          .replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '')
          .replace(/\bNo dialogue\.?\s*(No lips moving\.?)?/gi, '')
      )
      if (!/no dialogue/i.test(body)) body = `${body}\n\nNo dialogue. No lips moving.`.trim()
    }
    return body
  }
  const shaped = ensureOfficialBody(desc, input)
  const match = shaped.match(/^([\s\S]*?)(\[Shot\s*1\][\s\S]*)$/i)
  let body = (match?.[2] || shaped).replace(/^\[Shot\s*1\]\s*/i, '').trim()
  if (wanted.length) {
    const hasTags = /<d>\s*\[/.test(body)
    if (!hasTags) {
      const cleaned = stripDialogueMentions(stripSpokenLeaks(body, wanted.join('\n')))
      const next = /no dialogue/i.test(cleaned)
        ? cleaned.replace(/no dialogue\.?\s*(no lips moving\.?)?/i, dialogueBlocks(input, wanted))
        : `${cleaned} ${dialogueBlocks(input, wanted)}`.trim()
      body = next
    } else {
      body = stripSpokenLeaksOutsideTags(body, wanted.join('\n'))
    }
    body = ensureSpokenTags(body, wanted)
    body = body.replace(/No dialogue\.?\s*(No lips moving\.?)?/gi, '').trim()
  } else {
    const cleaned = stripDialogueMentions(stripSpokenLeaks(body, ''))
      .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
      .replace(/[^.]{0,80}\(S\d+\)[^.]{0,60}says(?: in an off-screen voiceover)?:\s*/gi, '')
      .trim()
    body = /no dialogue/i.test(cleaned) ? cleaned : `${cleaned} No dialogue. No lips moving.`.trim()
  }
  if (!/finishes naturally within/i.test(body)) {
    body = `${body} ${finishLine(input)}`
  }
  return `[Shot 1] ${sanitizeDTagContents(body)}`
}

function defaultSoundscape(input: H3PromptInput, spoken: string): string {
  const audio = String(input.audioDescription || '').trim()
  const notes = String(input.prompt || '')
  const mapped = [mapAmbience(audio), /[㐀-鿿]/.test(notes) ? mapAmbience(notes) : '']
    .flatMap((part) => part.split(/[;；]/))
    .map((part) => part.trim())
    .filter((part, index, all) => part && all.indexOf(part) === index)
    .join('; ')
  const raw = audio
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .replace(/(?:人声|旁白|台词|对白)\s*[：:][^\n]*/g, '')
    .trim()
  const english = mapped || (raw && !/[㐀-鿿]/.test(raw) && raw.length < 180 ? raw : '')
  const base = english
    ? `${english.replace(/\.?$/, '')}, synchronized with the picture.`
    : 'Quiet room tone, cloth, footsteps and handled objects, synchronized with the picture.'
  if (!spoken || input.voiceMode === 'none') {
    return `${base} No voices and no music.`
  }
  return `${base} Only the speaking (S#) is heard, and only the words inside the d tag. No music.`
}

function subjectPhrase(slot: LabeledSlot): string {
  return slot.subject ? `<Subject ${slot.subject}>` : slot.name
}

function shotSizeEn(raw?: string): string {
  const t = String(raw || '')
  if (/特写/.test(t)) return 'close-up'
  if (/中近/.test(t)) return 'medium close-up'
  if (/近景/.test(t)) return 'close-up'
  if (/中全|全景/.test(t)) return 'medium-wide shot'
  if (/中景/.test(t)) return 'medium shot'
  if (/大远/.test(t)) return 'extreme wide shot'
  if (/远景/.test(t)) return 'wide shot'
  if (/medium close-up|close-up|wide shot|medium shot|medium-wide/i.test(t)) {
    return t.replace(/[㐀-鿿].*$/, '').trim() || 'medium shot'
  }
  return 'medium shot'
}

function angleEn(raw?: string): string {
  const t = String(raw || '')
  if (/过肩/.test(t)) return 'over-the-shoulder'
  if (/俯/.test(t)) return 'slight high angle'
  if (/仰/.test(t)) return 'slight low angle'
  if (/45|侧/.test(t)) return 'framed from a slight side angle'
  return 'framed from a slight three-quarter angle'
}

function mapNotePhrases(text: string | undefined, rules: Array<[RegExp, string]>): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  if (!/[㐀-鿿]/.test(raw)) return raw
  const hits: string[] = []
  for (const [re, en] of rules) {
    if (re.test(raw) && !hits.includes(en)) hits.push(en)
  }
  return hits.join('; ')
}

function mapCinemaNotes(text?: string): string {
  return mapNotePhrases(text, [
    [/特写/, 'tight close-up'],
    [/中近/, 'medium close-up'],
    [/近景/, 'close shot'],
    [/中全|全身/, 'full-length medium-wide'],
    [/全景/, 'wide full shot of the place'],
    [/远景|大远/, 'wide establishing view'],
    [/中景/, 'medium shot'],
    [/过肩/, 'over-the-shoulder framing'],
    [/俯拍|俯视/, 'slight high angle'],
    [/仰拍|仰视/, 'slight low angle'],
    [/侧对|四分之三|3\s*\/\s*4/, 'three-quarter bodies, not square to camera'],
    [/不看镜头|禁止看镜头|别看镜头/, 'gaze stays inside the scene, never into the lens'],
    [/回头|侧头/, 'a glance or turn toward the other person'],
    [/低头/, 'eyes drop'],
    [/对峙|对视/, 'a charged look held between them'],
    [/紧张|慌/, 'tension in the jaw and shoulders'],
    [/害怕|惊/, 'a held, frightened breath'],
    [/怒|冷/, 'a cold, controlled face'],
    [/笑|温柔/, 'a restrained human expression, not a blank stare'],
    [/推近|缓推|慢推/, 'a slow small-amplitude push-in'],
    [/拉开|缓拉|慢拉/, 'a slow small-amplitude pull-out'],
    [/固定|静止|锁死/, 'locked-off camera with only subtle sway']
  ])
}

function mapAmbience(text?: string): string {
  return mapNotePhrases(text, [
    [/雨/, 'rain on surfaces'],
    [/风/, 'light wind in the space'],
    [/脚步|走/, 'footsteps'],
    [/门/, 'wood or a door shifting'],
    [/水|溪|河/, 'water movement'],
    [/虫|蝉/, 'insects'],
    [/车|街/, 'distant street'],
    [/火|柴/, 'fire crackle'],
    [/薯片|咔嚓|咀嚼|零食/, 'crisp chip crunch'],
    [/靠垫|翻找|哗啦/, 'cushion and fabric rustle'],
    [/拖鞋/, 'slipper scuff'],
    [/衣|布|织物/, 'cloth rustle'],
    [/呼吸|鼻息/, 'close breath'],
    [/房间|室内|屋/, 'interior room tone'],
    [/田|稻|村|室外/, 'open outdoor air and foliage']
  ])
}

function purposeEn(raw?: string): string {
  const t = String(raw || '')
  if (/钩子|开场|建立/.test(t)) return 'This beat establishes the space and the first visible tension.'
  if (/对峙|冲突/.test(t)) return 'This beat holds a confrontation; bodies stay charged, not idle.'
  if (/反应/.test(t)) return 'This beat is a reaction: face and breath change with what just happened.'
  if (/揭示/.test(t)) return 'This beat reveals new information through look and body, not exposition.'
  if (/转场/.test(t)) return 'This beat bridges the moment; motion and eyeline carry us forward.'
  if (/收口|结束/.test(t)) return 'This beat lands the scene; hold the last expression and let the frame breathe.'
  return ''
}

function compositionEn(aspect?: string): string {
  if (aspect === '9:16') return 'vertical portrait composition, subject weighted in the upper third, clear headroom'
  if (aspect === '1:1') return 'square composition with the subject held on a stable central axis'
  return 'landscape composition with readable foreground, midground and background depth'
}

function shotFrame(input: H3PromptInput) {
  const ratio = input.aspectRatio || '16:9'
  const lighting = englishOrOmit(input.sceneLighting) || 'available light'
  const movement = normalizeCameraMovement(input.cameraMovement)
  const labeled = labeledSlots(input)
  const people = labeled.filter((slot) => slot.kind === 'character')
  const place = labeled.find((slot) => slot.kind === 'scene')
  const who = people.length
    ? people.map((slot, i) => `${identityLabel(slot)} (S${i + 1})`).join(' and ')
    : 'the on-screen people'
  const where = place
    ? identityLabel(place)
    : englishOrOmit(input.sceneName) || 'the location'
  const extras = labeled.filter((slot) => slot.kind === 'extra')
  const extraHint = extras.length
    ? ` Extra refs ${extras.map((slot) => `<Picture ${slot.picture}>`).join(' and ')} lock identity or setting only.`
    : ''
  const size = shotSizeEn(input.shotSize)
  const angle = angleEn(input.shotSize)
  return { ratio, lighting, movement, who, where, extraHint, size, angle }
}

function descriptionFromNotes(input: H3PromptInput): string {
  const roster = pictureIdentityBlock(input)
  const { lighting, who, where, extraHint, size, angle } = shotFrame(input)
  const notedMove = `${input.prompt || ''}\n${input.blocking || ''}`
  const movement =
    normalizeCameraMovement(input.cameraMovement) !== 'static'
      ? normalizeCameraMovement(input.cameraMovement)
      : /慢推|缓推|推近|推进/.test(notedMove)
        ? 'push'
        : /慢拉|拉远|拉开/.test(notedMove)
          ? 'pull'
          : /上摇|俯仰/.test(notedMove)
            ? 'tilt'
            : /横摇|摇镜|横移/.test(notedMove)
              ? 'pan'
              : 'static'
  const total = Number(durationText(input))
  const t0 = formatH3Timestamp(0)
  const tOpen = formatH3Timestamp(Math.min(1.2, Math.max(0.8, total * 0.2)))
  const tHold = formatH3Timestamp(Math.max(total - 0.8, total * 0.85))
  const tEnd = formatH3Timestamp(total)
  const lastBeat = Math.max(0.8, total - Number((total * 0.85).toFixed(2))).toFixed(2)
  const angleBit = angle ? `, ${angle}` : ''
  const openCam = cameraBeatEn(movement, 0, 3)
  const midCam = cameraBeatEn(movement, 1, 3)
  const endCam = cameraBeatEn(movement, 2, 3)
  const blocking =
    mapCinemaNotes(input.blocking) ||
    'Bodies sit in a three-quarter stance with clear near/far depth, not a lineup facing the lens.'
  const eyes =
    mapCinemaNotes(input.eyeline) ||
    'Gaze stays on the other person or the object of attention inside the scene, never into the lens.'
  const action =
    mapCinemaNotes(input.continuity) ||
    'Bodies, props and eyelines change across the clip, and the last pose is different from the first.'
  const mood = mapCinemaNotes(input.speakerHint) || purposeEn(input.purpose)
  const moodBit = mood ? ` ${mood}` : ''
  const lines = spokenLinesForPrompt(input)
  const plan = h3InternalShotPlan(total, lines.length)
  const beats = plan
    .map((shot, index) => {
      const start = index === 0 ? t0 : shot.at || tOpen
      const end = index === plan.length - 1 ? tEnd : plan[index + 1]?.at || tHold
      const line = lines[index]
      const code = line ? speakerCode(input, dialogueCuesForPrompt(input).find((cue) => cue.text === line)?.speaker) : ''
      const speech = line
        ? `(${code || 'S1'}) says: ${h3SpokenTag(line)} ${quietOthers(input, code || 'S1')}`
        : 'No one speaks in this range. Mouths stay closed.'
      if (index === 0) {
        return `[${start}–${end}]\n${openCam} ${who} in ${where}. ${blocking} ${eyes.replace(/\.$/, '.')}${moodBit} ${speech}`.trim()
      }
      if (index === plan.length - 1) {
        return `[${start}–${end}]\n${endCam} ${action} The action develops continuously and finishes naturally within ${lastBeat} seconds. ${speech}`.trim()
      }
      return `[${start}–${end}]\n${midCam} ${action} Lighting stays ${lighting}.${extraHint} ${speech}`.trim()
    })
    .join('\n\n')
  const body = `[Shot 1] ${styleLead(input.aesthetic)}, ${size}${angleBit}, ${compositionEn(input.aspectRatio)}. Clean low-noise digital cinema image, natural skin texture. ${who} in ${where}. One ${total.toFixed(0)}-second clip. Each spoken line belongs to exactly one (S#) and one time range. Listeners keep their lips closed.

${beats}

Camera language:
${size}. ${openCam} Then ${midCam} Then ${endCam}

Performance direction:
Keep faces, hair and clothes locked to the speaker pictures. One person speaks at a time. No subtitles, no visible text, no extra people.`
  return roster ? `${roster}\n\n${body}` : body
}

/** 空台词套话、脏稿或缺图号身份时，打开节点/出视频要重写。 */
export function compiledH3PromptNeedsRebuild(text: string | undefined): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  if (isLifelessH3Prompt(t)) return true
  if (/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*(?:无|没有|无对白|无台词|none|N\/A)\s*<\/d>/i.test(t)) {
    return true
  }
  if (/says(?: in an off-screen voiceover)?:\s*<d>\s*\[Chinese\]\s*无\s*<\/d>/i.test(t)) return true
  if (/Person 1 \(S1\) in Place 1\.\s*The camera holds a static shot\.\s*Gaze stays on the scene/i.test(t)) {
    return true
  }
  // 只有人物名单、没有 [Shot 1] 的空壳，或还在用旧的「图1 是人设」而没有 (S1) 绑定
  if (/integrated_multimodal_description\s*:/i.test(t) && !/\[Shot\s*1\]/i.test(t)) return true
  if (/is this person's character design/i.test(t) && !/\(S1\)\s+is\b/.test(t)) return true
  return false
}

/** 中文场面被清掉以后，如果正文里几乎没有英文镜头，就不能只剩人物名单。 */
function shotProseTooThin(desc: string): boolean {
  if (!/\[Shot\s*1\]/i.test(desc)) return true
  const prose = stripCjkOutsideSpokenTags(desc)
    .replace(/<d>[\s\S]*?<\/d>/gi, ' ')
    .replace(/Speaker lock \(these labels are the pictures\):[\s\S]*?(?=\[Shot\s*1\])/i, ' ')
  const words = prose.match(/[A-Za-z]{4,}/g) || []
  return words.length < 35
}

function fallbackDescription(input: H3PromptInput, _spoken: string): string {
  return descriptionFromNotes(input)
}

function isGenericActionDump(desc: string): boolean {
  return (
    /action, blocking and chronology come from the storyboard/i.test(desc) ||
    /people match the character design sheets/i.test(desc) ||
    /Play the following director notes/i.test(desc) ||
    isH3FillTemplate(desc) ||
    cjkOutsideSpokenTags(desc)
  )
}

type DialogueCue = { text: string; speaker?: string }

/** 保留“谁说哪句”。旧逻辑只保留台词文字，多角色时模型无法建立独占口型。 */
function dialogueCuesForPrompt(input: H3PromptInput): DialogueCue[] {
  const wanted = spokenLinesForPrompt(input)
  const raw = `${input.voiceover || ''}\n${input.prompt || ''}`
  return wanted.map((text) => {
    const escaped = escapeRegExp(text)
    const name = `(?:「([^」]{1,24})」|([\\u3400-\\u9fffA-Za-z][\\u3400-\\u9fffA-Za-z0-9 _-]{0,12})(?:[（(][^）)\\n]{0,16}[）)])?)`
    const tagged = raw.match(
      new RegExp(`${name}\\s*(?:说|说道|问|喊|叫|答|says?y?|asks?|shouts?|replies?)?\\s*[：:]?\\s*(?:<d>\\s*\\[[^\\]]*\\]\\s*)?${escaped}`, 'i')
    )
    const line = raw.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*[：:]\\s*${escaped}`, 'im'))
    const speaker = String(tagged?.[1] || tagged?.[2] || line?.[1] || line?.[2] || '').trim()
    return { text, speaker: speaker || undefined }
  })
}

function dialogueTurnIssue(desc: string, expected: DialogueCue[]): string {
  if (!expected.length) return ''
  const tags = [...String(desc || '').matchAll(/<d>\s*\[[^\]]*\]\s*([\s\S]*?)<\/d>/gi)]
  if (tags.length !== expected.length) return `台词标签数量应为 ${expected.length}，实际为 ${tags.length}`
  for (let i = 0; i < tags.length; i += 1) {
    const index = tags[i].index || 0
    const lead = desc.slice(Math.max(0, index - 260), index)
    if (!/\(S\d+\)[^.\n]{0,180}\b(?:says?|asks?|shouts?|replies?|exclaims?|yells?|whispers?)\b[^.\n]{0,120}[:，,]?\s*$/i.test(lead)) {
      return `第 ${i + 1} 句台词没有紧邻的唯一说话人 (S#) 和说话动作`
    }
  }
  return ''
}

/** 识别旧版“按模板填词”的无生机成片稿。 */
export function isLifelessH3Prompt(text: string | undefined): boolean {
  const t = String(text || '')
  if (!t.trim()) return true
  const repeatedStatic = (t.match(/camera holds a static shot/gi) || []).length >= 2
  const genericTimeline =
    /Begin with the opening frame[\s\S]*Faces show a specific reaction[\s\S]*Hold the last expression and let the frame breathe/i.test(t)
  const restrainedConflict =
    /no pan, tilt, or zoom/i.test(t) && /restrained camera move|push-in|pull-out|pan right|tilt up|arc around/i.test(t)
  const genericPerformance =
    /Play the emotional change of this beat in order[\s\S]*Avoid calm exposition/i.test(t)
  return isH3FillTemplate(t) || (repeatedStatic && genericTimeline) || genericPerformance || restrainedConflict
}

export interface H3PromptValidation {
  valid: boolean
  issues: string[]
}

export function validateH3Prompt(prompt: string, expectedDialogue?: string): H3PromptValidation {
  const issues: string[] = []
  const hasI2va = /integrated_multimodal_description\s*:/i.test(prompt)
  const hasR2va = /subject_definitions\s*:/i.test(prompt) && /detailed_description\s*:/i.test(prompt)
  if (!hasI2va && !hasR2va) issues.push('缺少 detailed_description 或 integrated_multimodal_description')
  if (hasR2va) {
    if (!/summary\s*:/i.test(prompt)) issues.push('Ref2VA 缺少 summary')
    if (!/retention_analysis\s*:/i.test(prompt)) issues.push('Ref2VA 缺少 retention_analysis')
    if (!/\[reference generation\]/i.test(prompt)) issues.push('summary 必须以 [reference generation] 开头')
  }
  if (
    hasI2va &&
    /<Picture\s*1>/i.test(prompt) &&
    !/\[Shot\s*[2-9]\]/i.test(prompt) &&
    !/at 0\.00 seconds into the target video/i.test(prompt) &&
    !/Identity reference only, not the first frame/i.test(prompt) &&
    !/图\s*1\s*[/：:=是]/i.test(prompt)
  ) {
    issues.push('I2VA 缺少首帧对齐句：For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.')
  }
  if (!/overall_soundscape\s*:/i.test(prompt)) issues.push('缺少 overall_soundscape')
  if (!/non_diegetic_music\s*:/i.test(prompt)) issues.push('缺少 non_diegetic_music')
  if (isLifelessH3Prompt(prompt)) {
    issues.push('镜头稿仍是机械时间槽或存在静态/运镜冲突，缺少由剧情动作驱动的镜头语言')
  }
  if (!/\[Shot\s*1\]/i.test(prompt)) issues.push('正文必须以 [Shot 1] 开镜，且第一镜不加时间戳')
  if (/\[Shot\s*1\][^\n]*At\s+\d{2}:\d{2}/i.test(prompt)) {
    issues.push('[Shot 1] 不得加时间戳；后续镜才写 [Shot 2] At 00:03.000')
  }
  if (/from\s+\d+(?:\.\d+)?s?\s+to\s+\d+(?:\.\d+)?s/i.test(prompt)) {
    issues.push('H3 正文不要写 From 0.00s to …；用连续叙事写开幅、动作起幅、发展和收住')
  }
  if (/【环境光影】|【画面演进】|【角色声音签名】/.test(prompt)) {
    issues.push('混入了中文分区，H3 不认这套格式')
  }
  if (/\bThis shot is\s*\./i.test(prompt)) issues.push('镜头标题形成残句 This shot is.')
  if (/\bLocation facts\s*:/i.test(prompt)) issues.push('场景资料被重复追加为 Location facts')
  if (/(?:台词|对白|旁白|口播)\s*[：:]\s*[^：:\n]{0,16}\s*[：:]\s*(?:$|\n|Location facts)/i.test(prompt)) {
    issues.push('正文残留空台词标签；台词只能出现在 d 标签内')
  }

  const expectedLines = spokenCueLines(expectedDialogue || '')
  const expectedJoined = expectedLines.join(' ') || sanitizeDialogue(expectedDialogue || '')
  const tagged = [...prompt.matchAll(/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*([\s\S]*?)<\/d>/gi)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim()
  )
  if (expectedJoined) {
    if (!/<d>\s*\[Chinese\]/i.test(prompt) && /[㐀-鿿]/.test(expectedJoined)) {
      issues.push('中文台词/旁白必须写成 <d>[Chinese] 原词</d>')
    }
    const wanted = expectedLines.length ? expectedLines : [expectedJoined]
    if (wanted.some((line) => !tagged.some((t) => t === line))) {
      issues.push('台词必须写在 <d>[Chinese] 原词</d> 里，且与口播原文一致')
    }
    if (tagged.some((line) => !wanted.some((e) => e === line))) {
      issues.push('d 标签里出现了不该朗读的内容')
    }
    const outsideTags = prompt.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    if (wanted.some((line) => line.length >= 4 && outsideTags.includes(line))) {
      issues.push('台词原文在 d 标签外重复出现')
    }
  } else if (tagged.length) {
    issues.push('无对白镜头不得出现 <d> 台词标签')
  }
  return { valid: issues.length === 0, issues }
}

function resolvePromptInput(input: H3PromptInput, source: string): H3PromptInput {
  if (/subject_definitions\s*:/i.test(source)) return { ...input, mode: 'R2VA' }
  if (/at 0\.00 seconds into the target video/i.test(source)) return { ...input, mode: 'I2VA' }
  return input
}

/** 按官方 I2VA 三段生成最终提示词。中文场记不得进正文。 */
export function composeH3VideoPrompt(input: H3PromptInput): string {
  const source = stripFrameLead(input.prompt || '')
  const resolved = resolvePromptInput(input, source)
  const spoken = spokenLinesForPrompt(resolved).join(' ')

  if (isOfficialH3Prompt(source) && !isH3FillTemplate(source) && !isMessyH3Prompt(source)) {
    const desc = applyDialogue(
      extractField(source, 'detailed_description') ||
        extractField(source, 'integrated_multimodal_description') ||
        source,
      resolved
    )
    const sound = extractField(source, 'overall_soundscape') || defaultSoundscape(resolved, spoken)
    const music = extractField(source, 'non_diegetic_music') || 'N/A'
    return assembleOfficial(desc, sound, music, resolved)
  }

  if (isStructuredShotBody(source) && !isMessyH3Prompt(source)) {
    const desc = applyDialogue(
      extractField(source, 'integrated_multimodal_description') || source,
      resolved
    )
    const sound = extractField(source, 'overall_soundscape') || defaultSoundscape(resolved, spoken)
    const music = extractField(source, 'non_diegetic_music') || 'N/A'
    return assembleOfficial(desc, sound, music, resolved)
  }

  const desc = applyDialogue(descriptionFromNotes(resolved), resolved)
  return assembleOfficial(desc, defaultSoundscape(resolved, spoken), 'N/A', resolved)
}

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

type H3PromptJson = {
  detailed_description?: string
  integrated_multimodal_description?: string
  overall_soundscape?: string
}

function extractPossiblyTruncatedJsonString(text: string, field: string): string {
  const source = stripJsonFence(text)
  const match = new RegExp(`"${field}"\\s*:\\s*"`, 'i').exec(source)
  if (!match) return ''
  const start = match.index + match[0].length
  let escaped = false
  let raw = ''
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (!escaped && char === '"') break
    raw += char
    if (escaped) escaped = false
    else if (char === '\\') escaped = true
  }
  if (raw.endsWith('\\')) raw = raw.slice(0, -1)
  try {
    return JSON.parse(`"${raw.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`)
  } catch {
    return raw
      .replace(/\\([^"\\/bfnrtu])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim()
  }
}

function parseH3PromptJson(content: string): { parsed: H3PromptJson; truncated: boolean } {
  try {
    return { parsed: parseJsonRobust(content) as H3PromptJson, truncated: false }
  } catch (error) {
    const parsed: H3PromptJson = {
      integrated_multimodal_description: extractPossiblyTruncatedJsonString(
        content,
        'integrated_multimodal_description'
      ),
      detailed_description: extractPossiblyTruncatedJsonString(content, 'detailed_description'),
      overall_soundscape: extractPossiblyTruncatedJsonString(content, 'overall_soundscape')
    }
    if (parsed.integrated_multimodal_description || parsed.detailed_description) {
      return { parsed, truncated: true }
    }
    throw error
  }
}

/**
 * 只有真正的接口故障才应中断优化。模型偶发的 JSON、措辞或导演格式问题
 * 都可以由本地编译器降级成可提交稿，不能让用户因为质量启发式规则而卡住。
 */
function isLLMRequestFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '')
  return /(?:\b401\b|\b403\b|\b408\b|\b409\b|\b429\b|\b5\d\d\b|鉴权|Authentication|api.?key|rate.?limit|限流|余额|timeout|timed out|网络|network|fetch failed|ECONN|ENOTFOUND|socket)/i.test(
    message
  )
}

/** 把中文场记编译成 H3 官方英文：integrated_multimodal_description + 内部切镜；失败则回退模板。 */
export async function compileH3OfficialPrompt(input: H3PromptInput): Promise<string> {
  const resolved: H3PromptInput = { ...input, forceIntegrated: input.forceIntegrated !== false }
  const source = stripFrameLead(resolved.prompt || '')
  if (getAIMode() === 'mock') {
    return composeH3VideoPrompt(resolved)
  }
  if (isOfficialH3Prompt(source) && !input.forceIntegrated) {
    return composeH3VideoPrompt(resolved)
  }

  const cueLines = spokenLinesForPrompt(resolved)
  const dialogueCues = dialogueCuesForPrompt(resolved)
  const camera = CAMERA_EN[normalizeCameraMovement(resolved.cameraMovement)]
  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You write MiniMax / Seedance shot-video prompts. Output JSON only:
{"integrated_multimodal_description":"...","overall_soundscape":"..."}

This is ONE generated clip. The field format is fixed, but the filmmaking is NOT a fill-in template. Read the dramatic event first, then author the shot around its unique action and emotional causality.

Required output structure:
1) START by copying the speaker lock verbatim. (S1) is permanently the first character picture, (S2) the second. Never renumber S by dialogue order, and never write 图1 or "this person's character design" instead of (S#).
(S1) is 「中文名」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「中文名」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location 「场景名」. Lock space, materials, weather and light.
Only one (S#) speaks at a time. Everyone else keeps their lips completely closed.
These images are identity/location locks, NOT first frames. Do not write "Picture 1 is the first frame" or "Picture 1 aligns with 0.00 seconds".

2) After the speaker lock, write [Shot 1]. Add [Shot 2] At 00:SS.mmm and [Shot 3] only when a cut, reframe, reveal, impact, or change of dramatic focus genuinely earns them. A quiet reaction may remain one shot; a doorway-to-desk action, supernatural reveal, chase, fight, or large-scale effect usually needs changing framing. Never divide time into automatic opening/middle/hold slots.

3) Build a visible cause-and-effect chain specific to this scene: opening physical state -> trigger -> immediate bodily response -> purposeful action -> visible result -> final continuity state. Name the actual door, switch, key ring, statue, wardrobe, rain-streaked window, weapon, debris, or other story prop. Make the environment respond where appropriate: light flickers, fabric trails, rain reflections shift, dust lifts, furniture jolts, or sound changes. Every sentence must describe something filmable.

4) Camera movement must be motivated by what the audience needs to discover. State where the camera begins, what action or reveal makes it move, what foreground/background parallax or focus change occurs, and where it lands. The supplied camera family is only a preference, not a command. Static is valid only when stillness creates tension; do not repeat a static-camera sentence in every beat. Never combine “no pan, tilt, or zoom” with a push, pull, pan, tilt, or arc.

5) Direct performance through observable behavior and progression, not emotion labels: weight in the steps, a delayed glance, fingers missing the switch, breath catching, shoulders releasing, jaw tightening, or attention shifting to a sound. Derive the exact emotion from this beat; never turn every 怒 into “cold and controlled,” and never use generic instructions such as “faces show a specific reaction,” “play the emotional change,” or “hold the last expression and let the frame breathe.”

6) Treat each reference character according to the state described in the scene: living body, carved statue, portrait, reflection, shadow, off-screen voice, hidden presence, or absent identity reference. A character reference does NOT prove that a full living person is physically present. Do not duplicate a referenced identity as both a person and a prop unless the action explicitly shows a transformation.

7) Dialogue ONLY inside <d>. Each trusted line is spoken once, by its own (S#), in its own time range. Never let two people talk at once, and never let a second person repeat the line. Use exactly:
(S1) says: <d>[Chinese] 原词</d> Only (S1) speaks in this shot. (S2) keeps their lips completely closed and makes no voice.
The tag contains ONLY the spoken words. Never dump 场记, timestamps, style, picture labels, or Camera language into <d>. A bare <d> tag is forbidden. The listener stays in the blocking with a closed mouth. Do not split a clip merely because its dialogue is fast when the user's timing explicitly fits it.

Timeline writing standard:
- Use the user's timing when supplied; otherwise divide the full duration according to action and dialogue, never into generic equal thirds.
- Write 2–4 filmable sentences per time range. This is richer than an outline but shorter and clearer than a screenplay paragraph.
- Preserve spatial blocking throughout: who is foreground/background, left/right, seated/standing, and exactly whom each person looks at. Nobody looks into the camera unless the story explicitly demands it.
- Expressions must evolve from a visible trigger: eyes refocus, brows tighten or release, jaw sets, breath catches, a hand hesitates, weight shifts. Avoid abstract emotion labels without behavior.
- Use at most one primary camera move per range. Motivate it through a hand movement, eyeline, reveal or emotional turn; state where it starts and where it lands. Keep screen direction and axis continuous unless an explicit cut is needed.
- Mention only story-relevant wardrobe, props, light and environmental motion. Do not repeat complete character-sheet descriptions in every beat.
- Every range must advance the event. No idle posing, no generic “clothes and air move,” and no slideshow-like sequence of reference images.

Rules:
- Subject universe lock: the source material and the reference pictures contain the ONLY subjects that may appear. Never add any character, animal, object, or plot event that is not present in them. Never resolve idioms, fables, or cultural associations literally (for example, a rabbit must NEVER gain a tortoise, a race, or any storybook framing unless the source says so). When the source is sparse, animate exactly the referenced subject(s) doing exactly what was asked, inside the referenced setting and style — do not invent narrative context to fill the runtime.
- Preserve the user's event. Expand only what is already explicitly implied by the script, and never invent a different incident or new characters.
- STYLE LOCK: when reference pictures are supplied, their art style is authoritative. Match the reference pictures' rendering (medium, palette, texture, character design) exactly. Ignore the Style line above if it conflicts; never switch the referenced subject to a different medium such as live-action, CG, or a generic "cinematic" look.
- Write direct, decisive filmmaking prose like a director describing the finished moving image. The format is a container, not a prose template.
- English for action, camera, light, performance. Chinese is allowed ONLY inside <d> and inside 「source names」 in the speaker lock. Any other Chinese is deleted, so a Chinese scene description will ship as an empty roster. Write the actual blocking in English: who is left/right, what they hold, what a prop does over time.
- In action prose, call people (S1), (S2) exactly as the speaker lock defines them. Do not invent a new S number per line. Do not anonymize a known character as “the man.”
- Spoken lines already extracted below are the ONLY dialogue. If the list is empty, write No dialogue. No lips moving. NEVER invent speech from 场记, timestamps, style, or the speaker lock. Never put 无 or director notes inside a d tag.
- MUST COPY the speaker-lock block below verbatim at the start of integrated_multimodal_description. Do not invent, omit, or reorder (S1)/(S2)/<Picture N>.
- overall_soundscape names the script's real sounds (chip crunch, cushion rustle, room tone). Do not write a generic sentence such as "close breath stay synchronized with the picture. Spoken words appear only inside the d tag."
- Do not write subject_definitions, summary, retention_analysis.
- Do not show grids, four-view sheets, storyboards, collage, captions, subtitles, or labels on screen.
- End the visual description once with: The complete action develops continuously and finishes naturally within ${durationText(resolved)} seconds.
- overall_soundscape must follow the visible chronology and name the exact synchronized sounds of each action. English ambience and physical sounds only; spoken words are represented by their d tags and should not be quoted again. No music.
- non_diegetic_music is always N/A.
Before returning JSON, silently reject and rewrite your draft if it contains generic time slots, repeated static-camera instructions, camera contradictions, a reference identity shown in the wrong physical form, unmotivated close-ups, idle posing, or sound effects unrelated to visible actions.`
        },
        {
          role: 'user',
          content: `${importedDirectorForH3()}Style: ${resolved.aesthetic || 'Cinematic'} (when reference pictures are supplied, their art style overrides this line)
Duration: ${durationText(resolved)}s
Aspect: ${resolved.aspectRatio || '16:9'} (${String(resolved.aspectRatio || '16:9') === '9:16' ? 'vertical portrait, taller than wide' : String(resolved.aspectRatio || '16:9') === '1:1' ? 'square' : 'horizontal landscape, wider than tall'})
Camera preference (override it when the event needs a motivated reframe or cut): ${camera}
Scene / light: ${[englishOrOmit(resolved.sceneLighting), englishOrOmit(resolved.sceneAnchor), englishOrOmit(resolved.sceneDescription)].filter(Boolean).join(' / ') || 'from director notes'}
Available character identity references. (S1) stays (S1) for the whole clip. Do not assume every one is a living body in this beat; infer the actual visible form from the scene:
${characterPeople(resolved).map((slot, i) => `(S${i + 1}) = ${slot.sourceName || slot.name} = <Picture ${slot.picture}>`).join('\n') || onScreenEnglish(resolved).map((name, i) => `(S${i + 1}) = ${name}`).join('\n') || '(from director notes)'}
MUST COPY this speaker lock verbatim (identity/location lock, not first frames):
${pictureRoster(resolved) || 'no extra pictures'}
Voice mode: ${cueLines.length ? resolved.voiceMode || 'dialogue' : 'none — no trusted spoken lines; do NOT invent dialogue'}
Character voice (this speaker's own timbre, kept verbatim as delivery inside each <d> bracket; do not reinterpret or translate it away): ${resolved.speakerVoice || '(not set — infer a natural timbre that fits the character)'}
Spoken lines already extracted (quotes / 台词 / 口播栏 only; director notes are NOT speech):
${cueLines.length ? cueLines.map((line, i) => `${i + 1}. ${line}`).join('\n') : '(none — write No dialogue. No lips moving.)'}
Dialogue ownership recovered from the source (each item is one exclusive turn; preserve this order):
${dialogueCues.length ? dialogueCues.map((cue, i) => `${i + 1}. (${speakerCode(resolved, cue.speaker)}) speaker=${cue.speaker || 'unassigned'} | words=${cue.text}`).join('\n') : '(none)'}
Sound notes: ${englishOrOmit(resolved.audioDescription) || '(from the node text)'}
NODE MATERIAL TO DIRECT (source of truth for event, props, blocking and continuity; 场记/时长/画风 are not speech):
${source || '(perform the beat in this location)'}`
        }
      ],
      jsonMode: true,
      temperature: 0.62,
      maxTokens: 4800,
      timeoutMs: 240_000,
      signal: resolved.signal
    })
    const firstResult = parseH3PromptJson(resp.content)
    let parsed = firstResult.parsed
    let desc = String(parsed.integrated_multimodal_description || parsed.detailed_description || '').trim()
    if (/overall_soundscape\s*:/i.test(desc)) {
      desc =
        extractField(desc, 'integrated_multimodal_description') ||
        extractField(desc, 'detailed_description') ||
        desc
    }
    let sound = String(parsed.overall_soundscape || '').trim()
    const firstDialogueIssue = dialogueTurnIssue(desc, dialogueCues)
    if (
      firstResult.truncated ||
      !desc ||
      isGenericActionDump(desc) ||
      isLifelessH3Prompt(desc) ||
      firstDialogueIssue
    ) {
      const repair = await callLLM({
        messages: [
          {
            role: 'system',
            content: `Rewrite a rejected shot-video prompt as JSON only: {"integrated_multimodal_description":"...","overall_soundscape":"..."}.
The rejected draft was lifeless because it used a reusable timing template, repeated static-camera instructions, or failed to preserve the actual event.
Write the moving image itself. Preserve the exact speaker lock and trusted dialogue. (S1) is the first character picture for the whole clip. Subject universe lock: only subjects present in the source material and reference pictures may appear — never add new characters, animals, or plot events, and never turn idioms or fables into literal content. The visual style must match the reference pictures exactly. Build a concrete cause-and-effect action chain with named props, motivated camera changes, observable performance, environmental reaction, and a visible final state. Give each spoken line its own time range. Never create generic opening/middle/hold slots. Never treat a statue, portrait, reflection, hidden presence, or off-screen identity as a living body. English action prose; Chinese only inside 「names」 and trusted <d> dialogue. A Chinese scene body will be deleted.

Dialogue is exclusive turn-taking. Immediately before every <d>, write the stable (S#) and says/asks/replies. Form: (S1) says: <d>[Chinese] 原词</d> Only (S1) speaks in this shot. (S2) keeps their lips completely closed. Bare <d> tags are forbidden. Do not split the clip merely because the delivery is fast.

Rebuild the prompt as a concise cinematic timeline, not a four-line outline and not a dense screenplay paragraph. For every range write 2–4 filmable sentences covering framing or one motivated camera move, active body action and eyeline, a trigger-based facial change, listener blocking/reaction, and dialogue when present. Preserve foreground/background and left/right positions, keep the camera axis continuous, prevent anyone from staring into the lens, and use only story-relevant props, light and environmental motion. Every range must visibly advance the event. End once with the full ${durationText(resolved)}-second completion sentence.`
          },
          {
            role: 'user',
            content: `${importedDirectorForH3()}Speaker lock (copy verbatim):
${pictureRoster(resolved) || 'no extra pictures'}

Trusted dialogue:
${cueLines.length ? cueLines.join('\n') : '(none; no dialogue and no lips moving)'}

Required dialogue ownership and order:
${dialogueCues.length ? dialogueCues.map((cue, i) => `${i + 1}. (${speakerCode(resolved, cue.speaker)}) speaker=${cue.speaker || 'unassigned'} | words=${cue.text}`).join('\n') : '(none)'}

Rejected-draft dialogue defect:
${firstResult.truncated ? 'The previous JSON response was cut off mid-string. Reconstruct the complete shot; do not merely close the broken sentence.' : firstDialogueIssue || '(none; repair the visual-action defect)'}

Original scene material:
${source}

Rejected draft (diagnose it silently; do not imitate its structure):
${desc || '(empty)'}`
          }
        ],
        jsonMode: true,
        temperature: 0.72,
        maxTokens: 4800,
        timeoutMs: 240_000,
        signal: resolved.signal
      })
      const repairResult = parseH3PromptJson(repair.content)
      if (repairResult.truncated) return composeH3VideoPrompt(resolved)
      parsed = repairResult.parsed
      desc = String(parsed.integrated_multimodal_description || parsed.detailed_description || '').trim()
      sound = String(parsed.overall_soundscape || '').trim()
    }
    // 第二稿不再被质量启发式规则硬拦截。它们适合触发一次修稿，但不适合
    // 判定用户完全无法继续；模型稿只要有正文，就交给后面的确定性清洗器。
    if (!desc) return composeH3VideoPrompt(resolved)
    // 台词以入口 cueLines / voiceover 为准；禁止因模型乱写 <d> 就强行改成 dialogue
    const trusted = spokenLinesForPrompt(resolved)
    const resolvedWithSpeech: H3PromptInput = {
      ...resolved,
      voiceMode: trusted.length
        ? resolved.voiceMode === 'none'
          ? 'dialogue'
          : resolved.voiceMode || 'dialogue'
        : 'none',
      voiceover: trusted.length ? trusted.join('\n') : ''
    }
    let shaped = applyDialogue(desc, resolvedWithSpeech)
    if (shotProseTooThin(shaped)) {
      shaped = applyDialogue(descriptionFromNotes(resolvedWithSpeech), resolvedWithSpeech)
    }
    const spoken = trusted.join(' ')
    const assembled = assembleOfficial(
      shaped,
      sound || defaultSoundscape(resolvedWithSpeech, spoken),
      'N/A',
      resolvedWithSpeech
    )
    return assembled
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (!isLLMRequestFailure(error)) return composeH3VideoPrompt(resolved)
    const reason = error instanceof Error ? error.message : String(error || '')
    throw new Error(`没有生成可用的电影化镜头稿：${reason || '请重试'}`)
  }
}
