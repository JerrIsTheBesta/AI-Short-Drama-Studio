/** MiniMax H3 提示词：分镜默认 integrated_multimodal_description + 内部 [Shot N]；台词只进 <d>。 */

import type { AspectRatio, Shot } from '@/types'
import { englishOrOmit, h3NameMap, h3UniqueName } from '@/utils/h3Names'
import { normalizeCameraMovement, stripFrameLead, type VideoPromptStyle } from '@/utils/shotPrompt'
import { isPlaceholderSpokenLine, spokenTextOnly, stripSpokenStageDirection } from './dialogue'
import { normalizeForSpeech } from './tts'
import { callLLM, getAIMode } from './client'

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
  const outside = t.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
  return /[㐀-鿿]/.test(outside)
}

function cjkOutsideSpokenTags(text: string): boolean {
  return /[㐀-鿿]/.test(String(text || '').replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, ''))
}

/** 正文里的汉字一律删掉；只保留 <d> 里的台词。 */
export function stripCjkOutsideSpokenTags(text: string): string {
  const held: string[] = []
  const masked = String(text || '').replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, (block) => {
    held.push(block)
    return `__H3D${held.length - 1}__`
  })
  const cleaned = masked
    .replace(/[\u3400-\u9fff]+/g, '')
    .replace(/This shot is titled\s*\./gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.replace(/__H3D(\d+)__/g, (_, i) => held[Number(i)] || '')
}

function sanitizeDialogue(text: string): string {
  const line = stripSpokenStageDirection(
    normalizeForSpeech(spokenTextOnly(text))
      .replace(/<\/?d>/gi, '')
      .replace(/\[(?:Chinese|English|Japanese|Korean)\]/gi, '')
  )
    .replace(/\s+/g, ' ')
    .trim()
  if (!line || isPlaceholderSpokenLine(line)) return ''
  return line
}

/** 已写成官方稿时，把 <d> 里的表演提示、引号、空台词清掉，只留要念的原词。 */
export function sanitizeDTagContents(text: string): string {
  return String(text || '')
    .replace(/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*([\s\S]*?)<\/d>/gi, (_, inner) => {
      const line = sanitizeDialogue(inner)
      return line ? `<d>[Chinese] ${line}</d>` : ''
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按行拆对白，去掉「人物名：」后只留要进 <d> 的原词。 */
export function spokenCueLines(voiceover: string): string[] {
  return String(voiceover || '')
    .split(/\r?\n/)
    .map((line) => sanitizeDialogue(line))
    .filter((line) => line && !isPlaceholderSpokenLine(line))
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
  return labeledSlots(input)
    .map((slot) => {
      if (slot.kind === 'board') {
        return `<Picture ${slot.picture}> is a storyboard reference for [Shot 1], defining viewpoint, subject placement, and shot order. Identity-only images are not first frames.`
      }
      if (slot.kind === 'extra') {
        return `<Picture ${slot.picture}> is an additional user reference. Match people, clothing, product, setting or style from this image.`
      }
      if (slot.kind === 'scene') {
        return `<Subject ${slot.subject}> is ${slot.name} from <Picture ${slot.picture}>. Location only.`
      }
      return `<Subject ${slot.subject}> is ${slot.name}, the person in <Picture ${slot.picture}>. Character design sheet; identity only, not the first frame.`
    })
    .join('\n')
}

function onScreenEnglish(input: H3PromptInput): string[] {
  const fromSlots = slotsOf(input)
    .filter((slot) => slot.kind === 'character')
    .map((slot) => slot.name)
  if (fromSlots.length) return fromSlots
  const map = h3NameMap(input.onScreenNames ?? [])
  return (input.onScreenNames ?? []).map((name) => map[name]).filter(Boolean)
}

function englishSpeaker(input: H3PromptInput, fallback: string): string {
  const raw = String(input.speakerName || '').trim()
  if (!raw) return fallback
  const hit = slotsOf(input).find(
    (slot) => slot.kind === 'character' && (slot.sourceName === raw || slot.name === raw)
  )
  if (hit) return hit.name
  const map = h3NameMap([raw, ...(input.onScreenNames ?? [])])
  return map[raw] || h3UniqueName(raw, 1)
}

function speakerSubjectLabel(input: H3PromptInput): string {
  const raw = String(input.speakerName || '').trim()
  const labeled = labeledSlots(input)
  const hit = labeled.find(
    (slot) => slot.kind === 'character' && (slot.sourceName === raw || slot.name === raw)
  )
  if (hit?.subject) return `<Subject ${hit.subject}>`
  const first = labeled.find((slot) => slot.kind === 'character')
  if (first?.subject) return `<Subject ${first.subject}>`
  return englishSpeaker(input, 'the on-screen speaker')
}

function closedMouthLock(input: H3PromptInput): string {
  const people = labeledSlots(input)
    .filter((slot) => slot.kind === 'character')
    .map((slot) => `<Subject ${slot.subject}>`)
  if (!people.length) {
    const names = onScreenEnglish(input)
    if (!names.length) return 'Every on-screen person keeps the mouth completely closed.'
    return `${names.join(' and ')} keep the mouth completely closed and only react. They are not speaking.`
  }
  return `${people.join(' and ')} keep the mouth completely closed and only react. They are not speaking.`
}

function dialogueBlocks(input: H3PromptInput, lines: string[]): string {
  if (!lines.length || input.voiceMode === 'none') return 'No dialogue. No lips moving.'
  const who = speakerSubjectLabel(input)
  if (input.voiceMode === 'voiceover') {
    const spoken = lines
      .map((line, i) => `${who} (S${i + 1}) says in an off-screen voiceover: ${h3SpokenTag(line)}`)
      .join(' ')
    return `${spoken} while lips remain completely closed. ${closedMouthLock(input)} The words inside the d tag are being called from off-screen; nobody on screen mouths them.`
  }
  const hint = englishOrOmit(input.speakerHint?.replace(/^\[|\]$/g, ''))
  return lines
    .map((line, i) => {
      const id = `S${i + 1}`
      const lead = i === 0 && hint ? `${who} (${id}), ${hint},` : i === 0 ? `${who} (${id})` : `(${id})`
      return `${lead} says: ${h3SpokenTag(line)}`
    })
    .join(' ')
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
    .replace(/\b\d+(?:\.\d+)?s\s*(?:to|–|-)\s*\d+(?:\.\d+)?s:\s*/gi, '')
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
  const body = stripCjkOutsideSpokenTags(desc.trim())
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
  const existing = [...text.matchAll(/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*([\s\S]*?)<\/d>/gi)]
  if (existing.length === tags.length) {
    let i = 0
    return text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, () => tags[i++] || '')
  }
  const taggedText = existing.map((m) => sanitizeDialogue(m[1] || ''))
  const allPresent = lines.every((line) => taggedText.some((t) => t === line || t.includes(line) || line.includes(t)))
  if (allPresent && existing.length) {
    let i = 0
    const rewritten = text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, () => {
      const inner = sanitizeDialogue(existing[i]?.[1] || lines[i] || '')
      i += 1
      return inner ? `<d>[Chinese] ${inner}</d>` : ''
    })
    return sanitizeDTagContents(rewritten)
  }
  const missing = lines
    .filter((line) => !taggedText.some((t) => t === line || t.includes(line) || line.includes(t)))
    .map((line) => h3SpokenTag(line))
  if (!missing.length) {
    return sanitizeDTagContents(text)
  }
  const extra = missing.join(' ')
  if (/\[Shot\s*2\]/i.test(text)) {
    return sanitizeDTagContents(text.replace(/\[Shot\s*2\]/i, `${extra}\n\n[Shot 2]`))
  }
  return sanitizeDTagContents(`${text} ${extra}`.trim())
}

function extractQuotedSpeech(text: string): string[] {
  const out: string[] = []
  for (const match of String(text || '').matchAll(/[“「"'‘]([^”」"'’\n]{1,40})[”」"'’]/g)) {
    const line = sanitizeDialogue(match[1] || '')
    if (line && /[㐀-鿿]/.test(line) && !out.includes(line)) out.push(line)
  }
  return out
}

/** 从节点原文里抠台词：已有 d 标签、引号、台词/口播行、喊出「…」。 */
export function extractSpokenFromNotes(text: string): string[] {
  const raw = String(text || '')
  if (!raw.trim()) return []
  const fromTags = [...raw.matchAll(/<d>\s*\[[^\]]*\]\s*([\s\S]*?)<\/d>/gi)]
    .map((m) => sanitizeDialogue(m[1] || ''))
    .filter((line) => line && !isPlaceholderSpokenLine(line))
  if (fromTags.length) return [...new Set(fromTags)]
  const out = extractQuotedSpeech(raw)
  for (const match of raw.matchAll(/(?:^|\n)\s*(?:台词|对白|口播|旁白)\s*[：:]\s*(.+)$/gm)) {
    const line = sanitizeDialogue(match[1] || '')
    if (line && /[㐀-鿿]/.test(line) && !out.includes(line)) out.push(line)
  }
  for (const match of raw.matchAll(/(?:喊出|喊道|叫道|叫着|轻声说|小声说|小声喊)\s*[“「"'‘]?([\u3400-\u9fff，。！？!?、]{1,20})/g)) {
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
  const fromVo = input.voiceMode === 'none' ? [] : spokenCueLines(input.voiceover || '')
  const fromNotes = extractSpokenFromNotes(`${input.prompt || ''}\n${input.audioDescription || ''}`)
  const merged: string[] = []
  for (const line of [...fromVo, ...fromNotes]) {
    if (line && !merged.includes(line)) merged.push(line)
  }
  if (merged.length) return merged
  if (input.voiceMode === 'none') return []
  return []
}

function applyDialogue(desc: string, input: H3PromptInput): string {
  const llmLines = extractSpokenFromNotes(desc)
  const lines = spokenLinesForPrompt(input)
  const wanted = lines.length ? lines : llmLines
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
  const mapped = mapAmbience(input.audioDescription)
  const raw = (input.audioDescription || '')
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .replace(/(?:人声|旁白|台词|对白)\s*[：:][^\n]*/g, '')
    .trim()
  const english = mapped || (raw && !/[㐀-鿿]/.test(raw) ? raw : '')
  const base = english
    ? `${english.replace(/\.?$/, '')} stay synchronized with the picture.`
    : 'Diegetic ambience and physical action sounds stay synchronized with the picture: room tone, cloth, footsteps, and handled objects.'
  if (!spoken || input.voiceMode === 'none') {
    return `${base} No voices, no lips moving, no music.`
  }
  return `${base} Spoken words appear only inside the d tag. No music.`
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
    [/衣|布|织物/, 'cloth rustle'],
    [/呼吸/, 'close breath'],
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
    ? people.map((slot, i) => `${slot.name} (S${i + 1})`).join(' and ')
    : 'the on-screen people'
  const where = place
    ? place.name
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
  const { lighting, movement, who, where, extraHint, size, angle } = shotFrame(input)
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
    mapCinemaNotes(input.prompt) ||
    'The beat plays as one continuous take: start from a specific body state, let the change happen, and land on a clear end pose. No idle freeze and no character-sheet pose.'
  const mood = mapCinemaNotes(input.speakerHint) || purposeEn(input.purpose)
  const moodBit = mood
    ? ` Performance: ${mood}`
    : ' Faces show a specific reaction to this beat, not a blank stare.'
  const body = `${styleLead(input.aesthetic)}, ${size}${angleBit}, ${compositionEn(input.aspectRatio)}. ${who} in ${where}. Opening: ${openCam} ${blocking} ${eyes}.${moodBit} ${action} Then ${midCam} ${endCam} Lighting stays ${lighting}. Do not copy a character-sheet pose, a four-view grid, a storyboard, collage, caption, or label.${extraHint}`
  return `[Shot 1] ${body}`
}

/** 空台词套话或「says: 无」的旧稿，打开节点/出视频时重写成专业镜头语言。 */
export function compiledH3PromptNeedsRebuild(text: string | undefined): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  if (/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*(?:无|没有|无对白|无台词|none|N\/A)\s*<\/d>/i.test(t)) {
    return true
  }
  if (/says(?: in an off-screen voiceover)?:\s*<d>\s*\[Chinese\]\s*无\s*<\/d>/i.test(t)) return true
  if (/Person 1 \(S1\) in Place 1\.\s*The camera holds a static shot\.\s*Gaze stays on the scene/i.test(t)) {
    return true
  }
  return false
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
    !/at 0\.00 seconds into the target video/i.test(prompt)
  ) {
    issues.push('I2VA 缺少首帧对齐句：For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.')
  }
  if (!/overall_soundscape\s*:/i.test(prompt)) issues.push('缺少 overall_soundscape')
  if (!/non_diegetic_music\s*:/i.test(prompt)) issues.push('缺少 non_diegetic_music')
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

  const desc = applyDialogue(descriptionFromNotes(resolved), resolved)
  return assembleOfficial(desc, defaultSoundscape(resolved, spoken), 'N/A', resolved)
}

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
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
  const camera = CAMERA_EN[normalizeCameraMovement(resolved.cameraMovement)]
  const plan = describeInternalShotPlan(resolved.duration, cueLines.length)
  const lastBeat = h3InternalShotPlan(resolved.duration, cueLines.length).at(-1)?.beat || durationText(resolved)
  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You write MiniMax H3 shot-video prompts. Output JSON only:
{"integrated_multimodal_description":"...","overall_soundscape":"..."}

This is ONE generated clip. Inside it you MAY cut with [Shot 1] / [Shot 2] / [Shot 3]. Those are internal beats, not separate canvas shots.

Layout of integrated_multimodal_description (follow this specimen exactly):
[Shot 1] Cinematic, medium close-up, handheld with subtle natural sway, framed from a slight side angle so the man stands on the left of the frame and the boy on the right, with a soft shallow depth of field. Daylight in a narrow alley, low-key natural light. The man (S1), a lean, hard-faced young adult with a cold, controlled, low voice, stands in front of the boy (S2), a slight teenager with a soft, breathy, frightened voice. The man speaks first, his lips moving with a hard, flat delivery, and at the same time his open hand snaps across the boy's face in a sharp, fast slap: <d>[Chinese] 你知道我们为什么找你吗？</d>
The boy's head whips to the side from the impact, his body flinching back half a step. He slowly turns his head back to face the man, his eyes wide, his jaw trembling.

[Shot 2] At 00:03.000, the camera holds the same framing. The boy (S2) shakes his head slowly, his voice thin and breaking, the words barely louder than a whisper: <d>[Chinese] 我不知道啊。</d>
A short beat. The man (S1) does not let him finish; he steps in and delivers another sharp, fast slap across the boy's cheek, his lips moving again with the same hard, flat delivery: <d>[Chinese] 你很喜欢为朋友出头是吗？</d>
The boy stumbles back, both hands rising partway, but he does not raise them to fight back — only to brace himself against the wall behind him.

[Shot 3] At 00:06.000, the camera cuts to a slightly wider mid-shot from the same side angle. ... The action develops continuously and finishes naturally within 3.00 seconds.

Rules:
- Rewrite the user's node prompt into a professional shot: shot size, framing/composition, camera move (type + small amplitude + slow speed), blocking, eyeline, emotion, and diegetic sound. Do not replace their beat with a generic idle shot.
- English ONLY except the exact spoken words inside <d>[Chinese] ...</d>.
- Chinese is allowed ONLY inside <d> tags. No Chinese names, places, or stage directions outside <d>. Refer to people as "the man (S1)", "the boy (S2)" using English appearance + stable (S1)/(S2). Keep the same ID across internal shots.
- Dialogue follows the NODE TEXT, not an empty voiceover field. If the user described calling, shouting, speaking, 台词, 对白, or quoted Chinese, you MUST put those exact spoken words in <d>[Chinese] 原词</d>. One tag per line. Do not drop speech they wrote. Do not write No dialogue in that case.
- <d> may contain ONLY the words the mouth actually says. Never put 带着哭腔, 哽咽, 低声, speaker names, quotes, colons, or parentheticals inside the tag — the model would speak them. Write delivery in English outside the tag, e.g. her voice breaking through tears: <d>[Chinese] 救命——钟小哥？是你吗？</d>
- If they clearly wrote no speech (没有台词 / 不说话 / 无对白 / No dialogue) OR the voiceover is only 无 / none / N/A, write No dialogue. No lips moving. Do NOT output a d tag. Never put 无, 无对白, none, or N/A inside a d tag — the model would speak it.
- [Shot 1] has NO timestamp. Later shots MUST start with "At 00:03.000," (strictly increasing, inside the clip duration).
- Put cinematic style, shot size, camera, framing, light, and character appearance at the start of [Shot 1].
- Multiple speakers in one clip are allowed. Place each line at the moment that person speaks.
- If voice mode is voiceover: lips stay closed; write "says in an off-screen voiceover".
- Do not write subject_definitions, summary, retention_analysis, Picture 1 first-frame alignment, or "From 0.00s to 1.50s".
- Do not show grids, four-view sheets, storyboards, collage, captions, or labels on screen.
- Last internal shot MUST end with: The action develops continuously and finishes naturally within ${lastBeat} seconds.
- overall_soundscape: English ambience and physical action sounds only. If someone speaks, the voice is part of the picture; do not write "No voices". If nobody speaks, do not mention spoken words. No quoted Chinese, no lyrics.
- non_diegetic_music is always N/A.

Suggested internal shots for this ${durationText(resolved)}s clip:
${plan}`
        },
        {
          role: 'user',
          content: `Style: ${resolved.aesthetic || 'Cinematic'}
Duration: ${durationText(resolved)}s
Aspect: ${resolved.aspectRatio || '16:9'} (${String(resolved.aspectRatio || '16:9') === '9:16' ? 'vertical portrait, taller than wide' : String(resolved.aspectRatio || '16:9') === '1:1' ? 'square' : 'horizontal landscape, wider than tall'})
Camera family (written as a natural English action): ${camera}
Scene / light: ${[englishOrOmit(resolved.sceneLighting), englishOrOmit(resolved.sceneAnchor), englishOrOmit(resolved.sceneDescription)].filter(Boolean).join(' / ') || 'from director notes'}
On-screen people in S-order (Chinese names only to match dialogue speakers; in the prompt body use English appearance + (S1)/(S2)):
${(resolved.onScreenNames || []).map((name, i) => `S${i + 1} = ${name}`).join('\n') || onScreenEnglish(resolved).join(', ') || '(from director notes)'}
Picture roster (identity lock only, not first frames; do not copy into the prompt as Picture 1 alignment):
${pictureRoster(resolved) || 'no extra pictures'}
Voice mode: ${cueLines.length || nodeTextHasSpeech(source) ? resolved.voiceMode || 'dialogue' : 'none — only if the node text has nobody speaking'}
Spoken lines already extracted (may be incomplete; node text wins):
${cueLines.length ? cueLines.map((line, i) => `${i + 1}. ${line}`).join('\n') : '(none extracted yet)'}
Sound notes: ${englishOrOmit(resolved.audioDescription) || '(from the node text)'}
NODE PROMPT TO REWRITE (source of truth — action AND any dialogue the user wrote):
${source || '(perform the beat in this location)'}`
        }
      ],
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 3600,
      signal: resolved.signal
    })
    const parsed = JSON.parse(stripJsonFence(resp.content)) as {
      detailed_description?: string
      integrated_multimodal_description?: string
      overall_soundscape?: string
    }
    let desc = String(parsed.integrated_multimodal_description || parsed.detailed_description || '').trim()
    if (/overall_soundscape\s*:/i.test(desc)) {
      desc =
        extractField(desc, 'integrated_multimodal_description') ||
        extractField(desc, 'detailed_description') ||
        desc
    }
    const sound = String(parsed.overall_soundscape || '').trim()
    if (!desc || isH3FillTemplate(desc) || /Play the following director notes/i.test(desc)) {
      return composeH3VideoPrompt(resolved)
    }
    const resolvedWithSpeech: H3PromptInput = {
      ...resolved,
      voiceMode:
        extractSpokenFromNotes(desc).length || cueLines.length || nodeTextHasSpeech(source)
          ? resolved.voiceMode === 'none'
            ? 'dialogue'
            : resolved.voiceMode
          : resolved.voiceMode
    }
    const shaped = applyDialogue(desc, resolvedWithSpeech)
    const spoken = spokenLinesForPrompt(resolvedWithSpeech).join(' ') || extractSpokenFromNotes(shaped).join(' ')
    return assembleOfficial(shaped, sound || defaultSoundscape(resolvedWithSpeech, spoken), 'N/A', resolvedWithSpeech)
  } catch {
    return composeH3VideoPrompt(resolved)
  }
}
