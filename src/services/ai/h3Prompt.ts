/** MiniMax H3 提示词：多图走官方 Ref2VA 六段；单张首帧走 I2VA。台词只进 <d>。 */

import type { AspectRatio, Shot } from '@/types'
import { englishOrOmit, h3NameMap, h3UniqueName } from '@/utils/h3Names'
import { normalizeCameraMovement, stripFrameLead, type VideoPromptStyle } from '@/utils/shotPrompt'
import { spokenTextOnly } from './dialogue'
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
  mode?: 'I2VA' | 'T2VA' | 'R2VA'
  promptStyle?: VideoPromptStyle
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

function forceChineseSpokenTag(text: string, spoken: string): string {
  const tag = h3SpokenTag(spoken)
  if (!tag) return text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '').trim()
  const next = text.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, tag)
  return /<d>\s*\[/.test(next) ? next : `${next} ${tag}`.trim()
}

export function isOfficialH3Prompt(text: string): boolean {
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
    /the core action completes, residual breath and eye motion remain/i.test(t)
  )
}

function sanitizeDialogue(text: string): string {
  return normalizeForSpeech(spokenTextOnly(text))
    .replace(/<\/?d>/gi, '')
    .replace(/\[(?:Chinese|English|Japanese|Korean)\]/gi, '')
    .replace(/^[“”「」'"]+|[“”「」'"]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
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
  entries: Array<{ kind: 'character' | 'scene' | 'board' | 'extra'; name?: string }>
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

function dialogueBlock(input: H3PromptInput, spoken: string): string {
  if (!spoken || input.voiceMode === 'none') return 'No dialogue. No lips moving.'
  const tag = h3SpokenTag(spoken)
  const who = speakerSubjectLabel(input)
  if (input.voiceMode === 'voiceover') {
    return `${who} (S1) says in an off-screen voiceover: ${tag} while his lips remain completely closed. ${closedMouthLock(input)} The words inside the d tag are being called from off-screen; nobody on screen mouths them.`
  }
  const hint = englishOrOmit(input.speakerHint?.replace(/^\[|\]$/g, ''))
  const lead = hint ? `${who} (S1), ${hint},` : `${who} (S1)`
  return `${lead} says: ${tag} Other visible characters keep their mouths closed and react silently.`
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
  if (!spoken) return next.replace(/\s{2,}/g, ' ').trim()
  const quoted = (chunk: string) => {
    const inner = chunk.slice(1, -1)
    return inner.includes(spoken) || spoken.includes(inner) ? '' : chunk
  }
  next = next
    .replace(/[“「][^”」]*[”」]/g, quoted)
    .replace(/"(?:[^"\\]|\\.)*"/g, (chunk) => (/[㐀-鿿]/.test(chunk) ? quoted(chunk) : chunk))
  if (spoken.length >= 4) {
    next = next.replace(new RegExp(escapeRegExp(spoken), 'g'), '')
  }
  return next
    .replace(/(?:台词|对白|旁白|口播)\s*[：:]\s*[^：:\n]{0,16}\s*[：:]\s*(?=\n|$|Location facts)/gi, '')
    .replace(/\s*Location facts\s*:[^\n]*/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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
  const body = desc.trim()
  const defs = input ? subjectDefinitions(input) : ''
  if (input && isRef2VA(input) && defs) {
    return `subject_definitions:
${defs}

summary:
${summaryBlock(input)}

retention_analysis:
${retentionAnalysis(input)}

detailed_description:
${body}

overall_soundscape:
${sound.trim()}

non_diegetic_music:
${music.trim() || 'N/A'}`
  }
  const extraJobs = input
    ? slotsOf(input)
        .filter((slot) => slot.kind === 'extra' && slot.index > 1)
        .map((slot) => slot.job)
        .join('\n')
    : ''
  const alignment =
    input && input.mode !== 'T2VA' && slotsOf(input).length
      ? `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.${extraJobs ? `\n${extraJobs}` : ''}\n\n`
      : ''
  return `${alignment}integrated_multimodal_description:
${body}

overall_soundscape:
${sound.trim()}

non_diegetic_music:
${music.trim() || 'N/A'}`
}

function finishLine(input: H3PromptInput): string {
  return `The action develops continuously and finishes naturally within ${durationText(input)} seconds.`
}

function ensureOfficialBody(desc: string, input: H3PromptInput): string {
  const cleaned = stripUnofficialBeatHeadings(desc)
  const match = cleaned.match(/^([\s\S]*?)(\[Shot\s*1\][\s\S]*)$/i)
  let style = (match?.[1] || '').trim()
  let shot = (match?.[2] || cleaned).trim()
  let body = shot.replace(/^\[Shot\s*1\]\s*/i, '').trim()
  if (isRef2VA(input)) {
    if (!style) style = `The target video is in a ${styleLead(input.aesthetic)} style.`
    return `${style}\n[Shot 1] ${body}`
  }
  const lead = styleLead(input.aesthetic)
  if (!new RegExp(escapeRegExp(lead), 'i').test(body)) {
    body = `${lead}, ${body}`
  }
  return `[Shot 1] ${body}`
}

function applyDialogue(desc: string, input: H3PromptInput, spoken: string): string {
  const shaped = ensureOfficialBody(desc, input)
  const match = shaped.match(/^([\s\S]*?)(\[Shot\s*1\][\s\S]*)$/i)
  const style = (match?.[1] || '').trim()
  let body = (match?.[2] || shaped).replace(/^\[Shot\s*1\]\s*/i, '').trim()
  if (spoken && input.voiceMode !== 'none') {
    const cleaned = stripDialogueMentions(stripSpokenLeaks(body, spoken))
    const next = /no dialogue/i.test(cleaned)
      ? cleaned.replace(/no dialogue\.?\s*(no lips moving\.?)?/i, dialogueBlock(input, spoken))
      : `${cleaned} ${dialogueBlock(input, spoken)}`.trim()
    body = forceChineseSpokenTag(next, spoken)
  } else {
    const cleaned = stripSpokenLeaks(body, '')
      .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
      .trim()
    body = /no dialogue/i.test(cleaned) ? cleaned : `${cleaned} No dialogue. No lips moving.`.trim()
  }
  if (!new RegExp(escapeRegExp(finishLine(input).slice(0, 28)), 'i').test(body)) {
    body = `${body} ${finishLine(input)}`
  }
  const shot = `[Shot 1] ${body}`
  return isRef2VA(input) && style ? `${style}\n${shot}` : shot
}

function defaultSoundscape(input: H3PromptInput, spoken: string): string {
  const raw = (input.audioDescription || '')
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .replace(/(?:人声|旁白|台词|对白)\s*[：:][^\n]*/g, '')
    .trim()
  const english = raw && !/[㐀-鿿]/.test(raw)
    ? raw
    : 'Natural room tone and physical action sounds stay synchronized with the picture.'
  if (!spoken || input.voiceMode === 'none') {
    return `${english} No voices, no music, no lips moving.`
  }
  return `${english} Spoken words appear only inside the d tag. No music.`
}

function subjectPhrase(slot: LabeledSlot): string {
  return slot.subject ? `<Subject ${slot.subject}>` : slot.name
}

function shotFrame(input: H3PromptInput) {
  const ratio = input.aspectRatio || '16:9'
  const lighting = englishOrOmit(input.sceneLighting) || 'available light'
  const movement = normalizeCameraMovement(input.cameraMovement)
  const labeled = labeledSlots(input)
  const people = labeled.filter((slot) => slot.kind === 'character')
  const place = labeled.find((slot) => slot.kind === 'scene')
  const board = labeled.find((slot) => slot.kind === 'board')
  const who = people.length ? people.map(subjectPhrase).join(' and ') : 'the on-screen people'
  const where = place
    ? subjectPhrase(place)
    : input.sceneName?.trim() || 'the place named in the director notes'
  const boardHint = board
    ? ` Use <Picture ${board.picture}> only as blocking and order; never show the panel grid.`
    : ''
  const extras = labeled.filter((slot) => slot.kind === 'extra')
  const extraHint = extras.length
    ? ` Extra refs ${extras.map((slot) => `<Picture ${slot.picture}>`).join(' and ')} lock identity or setting only.`
    : ''
  const title = input.shotTitle?.trim() ? ` This shot is titled ${input.shotTitle.trim()}.` : ''
  return { ratio, lighting, movement, who, where, boardHint, extraHint, title }
}

function descriptionFromNotes(input: H3PromptInput, notes: string): string {
  const { ratio, lighting, movement, who, where, boardHint, extraHint, title } = shotFrame(input)
  const shot = `A continuous full-frame ${ratio} take of ${who} in ${where}.${title} ${CAMERA_EN[movement]}. Play the following director notes as the actual on-screen action, blocking, eyelines, props and emotion. Do not replace them with idle standing, blank faces, or generic hand-and-cloth motion.

${notes.trim()}

Finish this exact beat within ${durationText(input)} seconds.${boardHint}${extraHint} Never show a grid, four-view sheet, storyboard, collage, caption, or label. Lighting stays ${lighting}.`
  if (isRef2VA(input)) {
    return `The target video is in a ${styleLead(input.aesthetic)} style with ${lighting}.\n[Shot 1] ${shot}`
  }
  return `[Shot 1] ${styleLead(input.aesthetic)}, ${shot}`
}

function fallbackDescription(input: H3PromptInput, _spoken: string): string {
  return descriptionFromNotes(
    input,
    input.shotTitle?.trim()
      ? `这一镜的戏是「${input.shotTitle.trim()}」。按场记把动作、站位和视线演完，不要只摆姿势。`
      : '按本镜场记把具体动作演完，不要只让人站着换表情。'
  )
}

function isGenericActionDump(desc: string): boolean {
  return (
    /action, blocking and chronology come from the storyboard/i.test(desc) ||
    /people match the character design sheets/i.test(desc) ||
    isH3FillTemplate(desc)
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
  if (hasI2va && /<Picture\s*1>/i.test(prompt) && !/at 0\.00 seconds into the target video/i.test(prompt)) {
    issues.push('I2VA 缺少首帧对齐句：For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.')
  }
  if (!/overall_soundscape\s*:/i.test(prompt)) issues.push('缺少 overall_soundscape')
  if (!/non_diegetic_music\s*:/i.test(prompt)) issues.push('缺少 non_diegetic_music')
  if (!/\[Shot\s*1\]/i.test(prompt)) issues.push('正文必须以 [Shot 1] 开镜，且第一镜不加时间戳')
  if (/\[Shot\s*1\][^\n]*At\s+\d{2}:\d{2}/i.test(prompt)) {
    issues.push('[Shot 1] 不得加时间戳；后续镜才写 [Shot 2] At 00:03.500')
  }
  if (/from\s+\d+(?:\.\d+)?s?\s+to\s+\d+(?:\.\d+)?s/i.test(prompt)) {
    issues.push('H3 正文不要写 From 0.00s to …；用连续叙事写开幅、动作起幅、发展和收住')
  }
  if ((prompt.match(/says in an off-screen voiceover:/gi) || []).length > 1) {
    issues.push('画外音台词被写了两次')
  }
  if (/【环境光影】|【画面演进】|【角色声音签名】/.test(prompt)) {
    issues.push('混入了中文分区，H3 不认这套格式')
  }
  if (/\bThis shot is\s*\./i.test(prompt)) issues.push('镜头标题形成残句 This shot is.')
  if (/\bLocation facts\s*:/i.test(prompt)) issues.push('场景资料被重复追加为 Location facts')
  if (/(?:台词|对白|旁白|口播)\s*[：:]\s*[^：:\n]{0,16}\s*[：:]\s*(?:$|\n|Location facts)/i.test(prompt)) {
    issues.push('正文残留空台词标签；台词只能出现在 d 标签内')
  }

  const sourceSpeakers = [...(expectedDialogue || '').matchAll(/(?:^|[\n。！？!?])\s*([^：:\n。！？!?]{1,12})[：:]\s*/g)]
    .map((match) => match[1].trim())
    .filter((label, index, all) => label && all.indexOf(label) === index)
  if (sourceSpeakers.length > 1) {
    issues.push(`同一 H3 镜头含多个说话者（${sourceSpeakers.join('、')}），请按说话轮次拆镜`)
  }

  const expected = sanitizeDialogue(expectedDialogue || '')
  const tagged = [...prompt.matchAll(/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*([\s\S]*?)<\/d>/gi)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim()
  )
  if (expected) {
    if (!/<d>\s*\[Chinese\]/i.test(prompt) && /[㐀-鿿]/.test(expected)) {
      issues.push('中文台词/旁白必须写成 <d>[Chinese] 原词</d>')
    }
    if (!tagged.includes(expected)) issues.push('台词必须写在 <d>[Chinese] 原词</d> 里，且与口播原文一致')
    if (tagged.some((line) => line !== expected)) issues.push('d 标签里出现了不该朗读的内容')
    const outsideTags = prompt.replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    if (expected.length >= 4 && outsideTags.includes(expected)) issues.push('台词原文在 d 标签外重复出现')
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

/** 按官方 Ref2VA / I2VA 生成最终提示词。用户已写官方格式时原样规范化。 */
export function composeH3VideoPrompt(input: H3PromptInput): string {
  const spoken = input.voiceMode === 'none' ? '' : sanitizeDialogue(input.voiceover || '')
  const source = stripFrameLead(input.prompt || '')
  const resolved = resolvePromptInput(input, source)

  if (isOfficialH3Prompt(source) && !isH3FillTemplate(source)) {
    const desc = applyDialogue(
      extractField(source, 'detailed_description') ||
        extractField(source, 'integrated_multimodal_description') ||
        source,
      resolved,
      spoken
    )
    const sound = extractField(source, 'overall_soundscape') || defaultSoundscape(resolved, spoken)
    const music = extractField(source, 'non_diegetic_music') || 'N/A'
    return assembleOfficial(desc, sound, music, resolved)
  }

  const notes = source
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .replace(/subject_definitions:[\s\S]*?(?=detailed_description:|\[Shot\s*1\])/i, '')
    .replace(/summary:[\s\S]*?(?=detailed_description:|\[Shot\s*1\])/i, '')
    .replace(/retention_analysis:[\s\S]*?(?=detailed_description:|\[Shot\s*1\])/i, '')
    .trim()
  const usableNotes = notes.length >= 12 && !isH3FillTemplate(notes) && !isGenericActionDump(notes)
  const desc = applyDialogue(
    usableNotes ? descriptionFromNotes(resolved, notes) : fallbackDescription(resolved, spoken),
    resolved,
    spoken
  )
  return assembleOfficial(desc, defaultSoundscape(resolved, spoken), 'N/A', resolved)
}

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

/** 把中文场记编译成官方英文 Ref2VA / I2VA；失败则回退确定性模板。 */
export async function compileH3OfficialPrompt(input: H3PromptInput): Promise<string> {
  const source = stripFrameLead(input.prompt || '')
  if (isOfficialH3Prompt(source) || getAIMode() === 'mock') {
    return composeH3VideoPrompt(input)
  }

  const spoken = input.voiceMode === 'none' ? '' : sanitizeDialogue(input.voiceover || '')
  const refMode = isRef2VA(input)
  const camera = CAMERA_EN[normalizeCameraMovement(input.cameraMovement)]
  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You write MiniMax H3 ${refMode ? 'Ref2VA (full-reference)' : 'I2VA'} prompts from the official English writing guides. Output JSON only:
{"detailed_description":"...","overall_soundscape":"..."}
Rules from MiniMax-H3 VIDEO_PROMPT_WRITING_GUIDE:
- English only except the exact spoken words inside <d>.
- ${refMode ? 'detailed_description starts with 1-2 English style sentences, THEN [Shot 1] with NO timestamp. Example: "The target video is in a cinematic, live-action style with soft lighting.\\n[Shot 1] A medium-wide shot frames..."' : 'detailed_description is [Shot 1] Live-action, cinematic, a medium-wide shot frames... Style sits AFTER [Shot 1].'}
- Do NOT add a timestamp to [Shot 1]. Do NOT write "From 0.00s to 1.50s". Do NOT invent [Shot 2] cuts. This task is ONE continuous shot; if only distance or a slight angle changes, use camera motion, not a cut.
- Develop along the timeline in continuous prose: opening composition → action onset → continuous development → result or reaction, finishing within ${durationText(input)} seconds.
- For this generation task write 350-500 English words. Every phase must include: composition; subject appearance and position using <Subject N>; environment and lighting; face (brows, eyes, mouth, a specific emotion that CHANGES); hands and body; camera motion; where referenced labels apply.
- Camera is written as a natural English action inside the shot, with type + amplitude + speed. Use this family only: ${camera}. Start the move, continue it, ease to a stop. Do not switch camera type. Do not whip-pan or slam-zoom.
- Insert <Subject N> at first appearance. Character sheets lock identity only and are NOT the first frame. Do NOT copy the frontal portrait pose from character sheets. The scene plate locks place only. A storyboard <Picture N> is planning only and must never appear as a grid, animatic, or slideshow.
- For EVERY on-screen person, state: foreground vs behind; body facing (profile or three-quarter, never square to camera); eyeline target (named person or object). If the speaker is behind, people in front turn their heads or look over the shoulder at the speaker or at what he points to. Never a group photo looking into the lens.
- People from different Pictures are different people. Never swap faces.
- Translate the director notes into that continuous [Shot 1] prose. Director notes may list seconds in Chinese; convert them into opening / then / toward the end language, not "From Xs to Ys" headings.
- Do NOT write "action comes from the storyboard" or "people match the character design sheets".
- Never describe grids, four-view sheets, storyboards on screen, panels, collage, captions, or labels.
- Do not write Chinese names, Chinese voice notes, or Chinese place names. Use the <Subject N> labels from the picture roster.
- Dialogue: <Subject N> (S1) says: <d>[Chinese] EXACT_WORDS</d>
- Voiceover: <Subject N> (S1) says in an off-screen voiceover: <d>[Chinese] EXACT_WORDS</d> while his lips remain completely closed.
- If there is no spoken text: No dialogue. No lips moving. Do not output a d tag.
- Do not put shot directions, blocking, or camera notes inside <d> or quotation marks.
- End with: The action develops continuously and finishes naturally within ${durationText(input)} seconds.
- overall_soundscape: 1-4 English sentences of ambience and physical sound only. No lyrics, no quoted speech, no mood-only words if music is N/A.
- non_diegetic_music is N/A. No Chinese section headings.`
        },
        {
          role: 'user',
          content: `Style: ${input.aesthetic || 'Cinematic'}
Duration: ${durationText(input)}s
Aspect: ${input.aspectRatio || '16:9'} (${String(input.aspectRatio || '16:9') === '9:16' ? 'vertical portrait, taller than wide' : String(input.aspectRatio || '16:9') === '1:1' ? 'square' : 'horizontal landscape, wider than tall'})
Camera family (one only, official phrasing): ${camera}
Mode: ${refMode ? 'Ref2VA full-reference; pictures are identity / location / storyboard, NOT I2VA first frames' : 'I2VA; Picture 1 is the actual first frame at 0.00s'}
Scene: ${[englishOrOmit(input.sceneLighting), englishOrOmit(input.sceneAnchor), englishOrOmit(input.sceneDescription)].filter(Boolean).join(' / ') || 'from the location plate'}
On-screen people: ${onScreenEnglish(input).join(', ') || 'from character sheets'}
Picture roster (use these labels verbatim):
${pictureRoster(input) || 'no extra pictures'}
Speaker label: ${speakerSubjectLabel(input)}
Voice mode: ${spoken ? input.voiceMode || 'dialogue' : 'none'}
Exact spoken words (verbatim or empty): ${spoken || '(none)'}
Sound notes: ${englishOrOmit(input.audioDescription) || '(from picture action)'}
Director notes in Chinese or mixed language (translate into official [Shot 1] continuous prose, never speak these):
${source || '(perform a continuous action in the location; lock faces from character sheets)'}`
        }
      ],
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 2800,
      signal: input.signal
    })
    const parsed = JSON.parse(stripJsonFence(resp.content)) as {
      detailed_description?: string
      integrated_multimodal_description?: string
      overall_soundscape?: string
    }
    const desc = String(parsed.detailed_description || parsed.integrated_multimodal_description || '').trim()
    const sound = String(parsed.overall_soundscape || '').trim()
    if (!desc || !sound || isGenericActionDump(desc)) return composeH3VideoPrompt(input)
    return composeH3VideoPrompt({
      ...input,
      prompt: assembleOfficial(desc, sound, 'N/A', input),
      audioDescription: sound
    })
  } catch {
    return composeH3VideoPrompt(input)
  }
}
