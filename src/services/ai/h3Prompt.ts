/** MiniMax H3 多图参考提示词：Ref2VA 职责声明 + 英文正文，台词只进 <d>。 */

import type { AspectRatio, Shot } from '@/types'
import { englishOrOmit, h3RefName } from '@/utils/h3Names'
import { stripFrameLead, type VideoPromptStyle } from '@/utils/shotPrompt'
import { spokenTextOnly } from './dialogue'
import { callLLM, getAIMode } from './client'

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
  duration: number
  width?: number
  height?: number
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  mode?: 'I2VA' | 'T2VA' | 'R2VA'
  promptStyle?: VideoPromptStyle
  signal?: AbortSignal
}

const CAMERA_EN: Record<NonNullable<Shot['cameraMovement']>, string> = {
  push: 'The camera pushes in with small amplitude at slow speed',
  pull: 'The camera pulls out with small amplitude at slow speed',
  pan: 'The camera pans slowly',
  tilt: 'The camera tilts slowly',
  static: 'handheld with subtle natural sway',
  orbit: 'The camera orbits the subject with small amplitude at slow speed'
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

function sanitizeDialogue(text: string): string {
  return spokenTextOnly(text)
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

function cameraLead(input: H3PromptInput): string {
  return CAMERA_EN[input.cameraMovement || 'static']
}

function onScreenEnglish(input: H3PromptInput): string[] {
  return (input.onScreenNames ?? [])
    .map((name) => h3RefName(name, ''))
    .filter(Boolean)
}

function closedMouthLock(input: H3PromptInput): string {
  const people = onScreenEnglish(input)
  if (!people.length) return 'Every on-screen person keeps the mouth completely closed.'
  return `${people.join(' and ')} keep the mouth completely closed and only react. They are not speaking.`
}

function dialogueBlock(input: H3PromptInput, spoken: string): string {
  if (!spoken || input.voiceMode === 'none') return 'No dialogue. No lips moving.'
  const tag = h3SpokenTag(spoken)
  if (input.voiceMode === 'voiceover') {
    const speaker = h3RefName(input.speakerName, 'an off-screen voice')
    return `An off-screen voice, ${speaker} (S1), says in an off-screen voiceover: ${tag} ${closedMouthLock(input)} The words inside the d tag are being called from off-screen; nobody on screen mouths them.`
  }
  const speaker = h3RefName(input.speakerName, 'the on-screen speaker')
  const hint = englishOrOmit(input.speakerHint?.replace(/^\[|\]$/g, ''))
  const who = hint ? `${speaker} (S1), ${hint}` : `${speaker} (S1)`
  return `${who} says: ${tag} Other visible characters keep their mouths closed and react silently.`
}

function stripDialogueMentions(text: string): string {
  return text
    .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    .replace(/[^.]{0,100}\(S1\)[\s\S]{0,220}?(?:says in an off-screen voiceover|says):[\s\S]*?(?:closed\.|silently\.)/gi, '')
    .replace(/No dialogue\.?\s*(No lips moving\.?)?/gi, '')
    .replace(/On-screen lips remain completely closed\.?/gi, '')
    .replace(/Every on-screen person keeps the mouth completely closed\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function stripSpokenLeaks(text: string, spoken: string): string {
  let next = text
    .replace(/<d>\s*\[(?:Chinese|English|Japanese|Korean)\]\s*[\s\S]*?<\/d>/gi, '')
    .replace(/[“「][^”」]*[”」]/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, (chunk) => (/[㐀-鿿]/.test(chunk) ? '' : chunk))
  if (spoken && spoken.length >= 4) {
    next = next.replace(new RegExp(escapeRegExp(spoken), 'g'), '')
  }
  return next.replace(/\s{2,}/g, ' ').trim()
}

function subjectDefinitions(input: H3PromptInput): string {
  const assigns = input.imageAssignments ?? []
  if (!assigns.length) return ''
  const lines: string[] = []
  let subject = 0
  assigns.forEach((text, index) => {
    const pic = `<Picture ${index + 1}>`
    const cleaned = String(text || '').trim()
    if (/storyboard/i.test(cleaned)) {
      lines.push(
        `${pic} is a storyboard reference for [Shot 1]; it defines action, blocking and chronology from top-left to bottom-right. Do not copy panels, borders or sketches.`
      )
      return
    }
    subject += 1
    if (/scene plate|location/i.test(cleaned)) {
      lines.push(
        `<Subject ${subject}> is the location from ${pic}; lock space, materials and light only. Do not generate a four-panel grid.`
      )
      return
    }
    lines.push(
      `<Subject ${subject}> is the person from ${pic}; ${cleaned.replace(/\.+$/, '')}.`
    )
  })
  return lines.join('\n')
}

function assembleOfficial(desc: string, sound: string, music = 'N/A', input?: H3PromptInput): string {
  const defs = input ? subjectDefinitions(input) : ''
  const body = desc.trim()
  if (defs) {
    return `subject_definitions:
${defs}

summary:
[reference generation] One continuous full-frame shot synthesized from the character sheets, scene plate, and storyboard. Do not copy four-view sheets, scene grids, storyboard panels, collage, captions, or labels.

retention_analysis:
Referenced identities and the location stay fully_preserved. The storyboard is used only as an action plan.

detailed_description:
${body}

overall_soundscape:
${sound.trim()}

non_diegetic_music:
${music.trim() || 'N/A'}`
  }
  return `integrated_multimodal_description:
${body}

overall_soundscape:
${sound.trim()}

non_diegetic_music:
${music.trim() || 'N/A'}`
}

function ensureShotPrefix(desc: string): string {
  const body = desc.replace(/^\[Shot\s*1\]\s*/i, '').trim()
  return `[Shot 1] ${body}`
}

function finishLine(input: H3PromptInput): string {
  return `The action develops continuously and finishes naturally within ${durationText(input)} seconds.`
}

function applyDialogue(desc: string, input: H3PromptInput, spoken: string): string {
  if (spoken && input.voiceMode !== 'none') {
    const cleaned = stripDialogueMentions(stripSpokenLeaks(desc, spoken))
    const next = /no dialogue/i.test(cleaned)
      ? cleaned.replace(/no dialogue\.?\s*(no lips moving\.?)?/i, dialogueBlock(input, spoken))
      : `${cleaned} ${dialogueBlock(input, spoken)}`.trim()
    const withTag = forceChineseSpokenTag(next, spoken)
    const finished = new RegExp(escapeRegExp(finishLine(input).slice(0, 28)), 'i').test(withTag)
      ? withTag
      : `${withTag} ${finishLine(input)}`
    return ensureShotPrefix(finished)
  }
  const cleaned = stripSpokenLeaks(desc, '')
    .replace(/<d>\s*\[[^\]]+\]\s*[\s\S]*?<\/d>/gi, '')
    .trim()
  const next = /no dialogue/i.test(cleaned) ? cleaned : `${cleaned} No dialogue. No lips moving.`.trim()
  const finished = new RegExp(escapeRegExp(finishLine(input).slice(0, 28)), 'i').test(next)
    ? next
    : `${next} ${finishLine(input)}`
  return ensureShotPrefix(finished)
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

function fallbackDescription(input: H3PromptInput, spoken: string): string {
  const ratio = input.aspectRatio || '16:9'
  const lighting = englishOrOmit(input.sceneLighting) || 'Cinematic lighting'
  const camera = cameraLead(input)
  const place = englishOrOmit(input.sceneAnchor) || englishOrOmit(input.sceneName)
  return `[Shot 1] ${styleLead(input.aesthetic)}, ${camera}, framed in ${ratio} full-frame. ${lighting}.${place ? ` ${place}.` : ''} People match the character design sheets. The place matches the scene plate. Action, blocking and chronology come from the storyboard. This is one continuous full-frame shot, not a grid, four-view sheet, storyboard, or collage. ${camera.startsWith('The ') ? camera + '.' : `The camera holds ${camera}.`}`
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
  if (!/overall_soundscape\s*:/i.test(prompt)) issues.push('缺少 overall_soundscape')
  if (!/non_diegetic_music\s*:/i.test(prompt)) issues.push('缺少 non_diegetic_music')
  if ((prompt.match(/says in an off-screen voiceover:/gi) || []).length > 1) {
    issues.push('画外音台词被写了两次')
  }
  if (/【环境光影】|【画面演进】|【角色声音签名】/.test(prompt)) {
    issues.push('混入了中文分区，H3 不认这套格式')
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
  } else if (tagged.length) {
    issues.push('无对白镜头不得出现 <d> 台词标签')
  }
  return { valid: issues.length === 0, issues }
}

export function assertValidH3Prompt(prompt: string, expectedDialogue?: string): void {
  const result = validateH3Prompt(prompt, expectedDialogue)
  if (!result.valid) throw new Error(`H3 提示词自检未通过，已暂停生成：${result.issues.join('；')}`)
}

/** 按官方 I2VA 三段式生成最终提示词。用户已写官方格式时原样规范化。 */
export function composeH3VideoPrompt(input: H3PromptInput): string {
  const spoken = input.voiceMode === 'none' ? '' : sanitizeDialogue(input.voiceover || '')
  const source = stripFrameLead(input.prompt || '')

  if (isOfficialH3Prompt(source)) {
    const desc = applyDialogue(
      extractField(source, 'detailed_description') ||
        extractField(source, 'integrated_multimodal_description') ||
        source,
      input,
      spoken
    )
    const sound = extractField(source, 'overall_soundscape') || defaultSoundscape(input, spoken)
    const music = extractField(source, 'non_diegetic_music') || 'N/A'
    return assembleOfficial(desc, sound, music, input)
  }

  const notes = source.replace(/<d>[\s\S]*?<\/d>/gi, '').replace(/[“「][^”」]*[”」]/g, '').trim()
  const englishEnough = notes.length > 80 && !/[㐀-鿿]/.test(notes)
  const desc = englishEnough
    ? applyDialogue(notes, input, spoken)
    // 中文导演描述会使用确定性的英文画面模板，但仍必须经过对白注入；
    // 否则 voiceover 有值而最终 prompt 没有 <d>，会被自检正确拦下。
    : applyDialogue(fallbackDescription(input, spoken), input, spoken)
  return assembleOfficial(desc, defaultSoundscape(input, spoken), 'N/A', input)
}

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

/** 把中文场记编译成官方英文 I2VA；失败则回退确定性模板。 */
export async function compileH3OfficialPrompt(input: H3PromptInput): Promise<string> {
  const source = stripFrameLead(input.prompt || '')
  if (isOfficialH3Prompt(source) || getAIMode() === 'mock') {
    return composeH3VideoPrompt(input)
  }

  const spoken = input.voiceMode === 'none' ? '' : sanitizeDialogue(input.voiceover || '')
  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `You write MiniMax H3 reference-to-video prompts. Output JSON only:
{"detailed_description":"[Shot 1] ...","overall_soundscape":"..."}
Rules:
- English only except the exact spoken words inside <d>.
- One continuous full-frame shot. Never describe grids, four-view sheets, storyboards, panels, collage, captions, or labels.
- Do not treat any picture as a first frame to copy. Character sheets lock identity. The scene plate locks place. The storyboard is the action plan only.
- Read the storyboard from top-left to bottom-right and perform that action as one continuous full-frame shot.
- Camera motion must be natural English: type + amplitude + speed.
- Do not write Chinese names, Chinese voice notes, or Chinese place names in the description.
- Dialogue or voiceover MUST use this exact tag and nothing else: <d>[Chinese] 天还没亮，我就离开了家。</d>
- On-screen speech: Name (S1) says: <d>[Chinese] EXACT_WORDS</d>
- Off-screen voiceover: An off-screen voice (S1) says in an off-screen voiceover: <d>[Chinese] EXACT_WORDS</d> Every on-screen person keeps the mouth closed. If the spoken words are someone's name, that person is being called and must not mouth the words.
- If there is no spoken text: No dialogue. No lips moving. Do not output a d tag.
- Do not put shot directions, blocking, or camera notes inside <d> or quotation marks.
- End the description with: The action develops continuously and finishes naturally within ${durationText(input)} seconds.
- overall_soundscape: 1-4 English sentences of ambience and physical sound only. No lyrics, no quoted speech.
- No Chinese section headings.`
        },
        {
          role: 'user',
          content: `Style: ${input.aesthetic || 'Cinematic'}
Duration: ${durationText(input)}s
Aspect: ${input.aspectRatio || '16:9'} (${String(input.aspectRatio || '16:9') === '9:16' ? 'vertical portrait, taller than wide' : String(input.aspectRatio || '16:9') === '1:1' ? 'square' : 'horizontal landscape, wider than tall'})
Camera: ${input.cameraMovement || 'static'}
Scene: ${[englishOrOmit(input.sceneLighting), englishOrOmit(input.sceneAnchor), englishOrOmit(input.sceneDescription)].filter(Boolean).join(' / ') || 'from the scene plate'}
On-screen people: ${onScreenEnglish(input).join(', ') || 'from character sheets'}
Picture jobs: ${(input.imageAssignments || []).map((text, index) => `<Picture ${index + 1}> ${text}`).join(' | ') || 'character sheets + scene plate + storyboard'}
Speaker: ${h3RefName(input.speakerName, 'none')}
Voice mode: ${spoken ? input.voiceMode || 'dialogue' : 'none'}
Exact spoken words (verbatim or empty): ${spoken || '(none)'}
Sound notes: ${englishOrOmit(input.audioDescription) || '(from picture action)'}
Director notes in Chinese or mixed language (visual only, never speak these):
${source || '(follow the storyboard action; lock faces from character sheets and place from the scene plate)'}`
        }
      ],
      jsonMode: true,
      temperature: 0.3,
      maxTokens: 1600,
      signal: input.signal
    })
    const parsed = JSON.parse(stripJsonFence(resp.content)) as {
      detailed_description?: string
      integrated_multimodal_description?: string
      overall_soundscape?: string
    }
    const desc = String(parsed.detailed_description || parsed.integrated_multimodal_description || '').trim()
    const sound = String(parsed.overall_soundscape || '').trim()
    if (!desc || !sound) return composeH3VideoPrompt(input)
    return composeH3VideoPrompt({
      ...input,
      prompt: assembleOfficial(desc, sound, 'N/A', input),
      audioDescription: sound
    })
  } catch {
    return composeH3VideoPrompt(input)
  }
}
