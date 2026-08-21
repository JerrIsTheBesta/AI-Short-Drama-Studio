/**
 * MiniMax H3 ComfyUI 提示词组装
 * 场景叙事：两段中文（配图里已有人）。
 * 格式化：Aesthetic / SHOT / Visual Prompt；环境音 overall_soundscape（英文）；台词进 <d>。
 */

import type { AspectRatio, Shot } from '@/types'
import { spokenTextOnly } from './dialogue'
import type { VideoPromptStyle } from '@/utils/shotPrompt'

export interface H3PromptInput {
  /** 分镜视觉描述（可中文；会写入英文结构句中） */
  prompt: string
  aesthetic?: string
  audioDescription?: string
  /** 口播/台词原文，必须原样进 <d>，禁止翻译改写 */
  voiceover?: string
  /**
   * dialogue = 出镜说话（默认）；voiceover = 画外配音
   */
  voiceMode?: 'dialogue' | 'voiceover' | 'none'
  /** 说话人外貌/音色提示，不含台词 */
  speakerHint?: string
  duration: number
  width?: number
  height?: number
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  /** 默认 I2VA：图生视频 */
  mode?: 'I2VA' | 'T2VA'
  /**
   * scene-narrative：只送两段中文叙事（配图里已有人）。
   * formatted：套 Aesthetic / SHOT 结构（人物图+空镜底板）。
   */
  promptStyle?: VideoPromptStyle
}

const CAMERA_PHRASE: Record<NonNullable<Shot['cameraMovement']>, string> = {
  push: 'Subtle handheld push-in, small amplitude at slow speed',
  pull: 'Very slow handheld pull-back, keeping the main subject centered',
  pan: 'Slow handheld pan, small amplitude with stable subject tracking',
  tilt: 'Slow handheld tilt, small amplitude with controlled framing',
  static: 'Static handheld shot, subtle natural frame tremor',
  orbit: 'Slow handheld arc shot, small amplitude around the main subject'
}

/** 检测 <d> 语言标签；台词本身不翻译 */
export function detectDialogueLanguage(text: string): string {
  const t = text.trim()
  if (!t) return 'Chinese'
  if (/[\u3040-\u30ff]/.test(t)) return 'Japanese'
  if (/[\uac00-\ud7af]/.test(t)) return 'Korean'
  if (/[\u4e00-\u9fff]/.test(t)) return 'Chinese'
  return 'English'
}

function styleLead(aesthetic?: string): string {
  const a = (aesthetic || '').toLowerCase()
  if (/anime|动画|二次元/.test(a)) return '2D-animated, cinematic'
  if (/3d|cgi|渲染/.test(a)) return '3D CG, cinematic'
  if (/watercolor|水彩/.test(a)) return 'watercolor, cinematic'
  if (/clay|粘土/.test(a)) return 'claymation, cinematic'
  if (/ink|水墨/.test(a)) return 'ink-wash, cinematic'
  if (/live.?action|实拍|真人|photoreal|写实/.test(a)) return 'Live-action, cinematic'
  return 'Live-action, cinematic'
}

function sanitizeVoiceover(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[~～…·•]+/g, ' ')
    .trim()
}

function formatDialogueBlock(voiceover: string): string {
  const line = sanitizeVoiceover(spokenTextOnly(voiceover))
  const lang = detectDialogueLanguage(line)
  let inner = line
  if (!/[.!?。！？]$/.test(inner)) {
    inner = /[?？]/.test(inner) ? `${inner}?` : `${inner}.`
  }
  return `<d>[${lang}] ${inner}</d>`
}

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}

function stripCjk(text: string): string {
  return text.replace(/[\u3400-\u9fff]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * H3 会把 <d> 之外的中文当成台词念出来。
 * overall_soundscape 只允许英文 foley / ambience。
 */
const SFX_PHRASES: Array<[RegExp, string]> = [
  [/衣衫摩擦|衣料摩擦|衣服摩擦|布料摩擦|织物摩擦/g, 'clothes rustling'],
  [/梨子轻碰盘底|梨轻碰盘底/g, 'pears lightly tapping the plate'],
  [/轻碰盘底/g, 'lightly tapping the plate'],
  [/远处传来铜铃声|远处铜铃声|铜铃声/g, 'a distant bronze bell ringing'],
  [/铜铃/g, 'bronze bell'],
  [/环境底噪|自然环境底噪|环境音|环境声|环境音乐|氛围音|底噪/g, 'quiet natural room tone'],
  [/轻微衣料摩擦声|衣料声/g, 'soft fabric rustle'],
  [/与画面动作同步的细微声音/g, 'subtle foley synced to the on-screen action'],
  [/雨打[棚窗屋]?(?:声|布)?|雨声/g, 'rain tapping nearby surfaces'],
  [/脚步声|脚步/g, 'footsteps'],
  [/风声|微风/g, 'light wind'],
  [/水声|流水|溪水/g, 'flowing water'],
  [/锅铲|油锅|炒菜/g, 'wok and spatula sizzle'],
  [/碗筷|杯盘|瓷器/g, 'light ceramic clink'],
  [/盘底/g, 'plate'],
  [/梨子|梨/g, 'pears'],
  [/轻碰/g, 'lightly tapping'],
  [/摩擦/g, 'rustling'],
  [/铃声/g, 'bell ringing'],
  [/鸟鸣|鸟叫/g, 'birds'],
  [/车流|街道/g, 'distant street traffic'],
  [/呼吸|喘息/g, 'soft breathing'],
  [/笑声/g, 'laughter'],
  [/远处传来/g, 'distant'],
  [/轻微/g, 'soft']
]

const MUSIC_PHRASES: Array<[RegExp, string]> = [
  [/温暖弦乐|弦乐铺底|弦乐/g, 'warm sustained strings at a slow tempo'],
  [/钢琴/g, 'sparse piano notes'],
  [/吉他/g, 'soft acoustic guitar'],
  [/氛围音乐|背景音乐|配乐|BGM|bgm/g, 'restrained ambient underscore']
]

function translatePhrases(raw: string, table: Array<[RegExp, string]>): string[] {
  let text = raw
  for (const [pattern, en] of table) {
    text = text.replace(pattern, ` ${en} `)
  }
  const parts = text
    .split(/[,，、;；|/]+/)
    .map((part) =>
      stripCjk(part)
        .replace(/^[.。,，]+|[.。,，]+$/g, '')
        .trim()
    )
    .filter(Boolean)

  const unique: string[] = []
  for (const part of parts) {
    if (!unique.includes(part)) unique.push(part)
  }
  return unique
}

export function toEnglishSoundscape(audioDescription?: string): string {
  const raw = audioDescription?.trim()
  if (!raw) {
    return 'Quiet natural room tone and soft fabric rustle continue throughout, with subtle physical foley synchronized to the visible action.'
  }

  const withoutMusic = raw
    .replace(/温暖弦乐|弦乐铺底|弦乐|钢琴|吉他|氛围音乐|背景音乐|配乐|BGM|bgm/gi, ' ')
    .trim()
  const parts = withoutMusic
    ? hasCjk(withoutMusic)
      ? translatePhrases(withoutMusic, SFX_PHRASES)
      : [withoutMusic.replace(/[.。]+$/g, '').trim()].filter(Boolean)
    : []
  const body = parts.length
    ? parts.join(', ')
    : 'quiet natural room tone and subtle physical foley synchronized to the visible action'
  const sentence = body.endsWith('.') ? body : `${body}.`
  return stripCjk(sentence) || 'Quiet natural room tone continues throughout the shot.'
}

export function toEnglishScore(audioDescription?: string): string {
  const raw = audioDescription?.trim()
  if (!raw) return 'N/A'
  if (!/(温暖弦乐|弦乐|钢琴|吉他|氛围音乐|背景音乐|配乐|BGM)/i.test(raw)) return 'N/A'
  const parts = translatePhrases(raw, MUSIC_PHRASES)
  const music = parts.filter((p) =>
    /string|piano|guitar|underscore|score|music|tempo/i.test(p)
  )
  if (!music.length) return 'N/A'
  return stripCjk(music.join(', ')) || 'N/A'
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const remain = total % 60
  return `${minutes}:${String(remain).padStart(2, '0')}`
}

function aestheticBlock(aesthetic?: string): string {
  const raw = aesthetic?.trim()
  const lead = styleLead(raw)
  if (!raw) return `${lead}, cinematic lighting, realistic texture, coherent color palette`
  const text = hasCjk(raw) ? `${lead}, ${stripCjk(raw) || 'coherent color palette'}` : raw.slice(0, 800)
  if (text.toLowerCase().includes(lead.toLowerCase())) return text.slice(0, 800)
  return `${lead}, ${text.slice(0, 760)}`
}

function speakerCue(voiceover: string, speakerHint?: string): string {
  const hint = speakerHint?.replace(/^\[|\]$/g, '').trim() || ''
  if (hint && !hasCjk(hint)) return hint

  const traits: string[] = []
  let voice = 'natural conversational voice'
  if (/稚嫩|童声|儿童|男童|女童/.test(hint)) voice = 'young child voice'
  else if (/少年|少女/.test(hint)) voice = 'youthful voice'
  else if (/老年|老人|年迈/.test(hint) && /女/.test(hint)) voice = 'elderly female voice'
  else if (/老年|老人|年迈/.test(hint) && /男/.test(hint)) voice = 'elderly male voice'
  else if (/老年|老人|年迈/.test(hint)) voice = 'elderly voice'
  else if (/女声|女性/.test(hint)) voice = /年轻/.test(hint) ? 'young female voice' : 'female voice'
  else if (/男声|男性/.test(hint)) voice = /年轻/.test(hint) ? 'young male voice' : 'male voice'

  if (/温柔|温软|轻柔/.test(hint)) traits.push('gentle')
  if (/自然|口语/.test(hint)) traits.push('natural')
  if (/清楚|清晰/.test(hint)) traits.push('clear')
  if (/认真|坚定/.test(hint)) traits.push('earnest')
  if (/惊喜/.test(hint)) traits.push('pleasantly surprised')
  if (/活泼|欢快/.test(hint)) traits.push('lively')
  if (/平静|沉稳|克制/.test(hint)) traits.push('calm')
  if (/笑|微笑/.test(hint)) traits.push('lightly smiling')

  const language = detectDialogueLanguage(voiceover) === 'Chinese' ? 'Mandarin ' : ''
  const delivery = traits.length ? ` with ${traits.join(', ')} delivery` : ''
  return `${language}${voice}${delivery}`
}

function dialogueLine(input: H3PromptInput): string {
  const voiceover = input.voiceover?.trim() || ''
  const mode = input.voiceMode ?? 'dialogue'
  if (!voiceover || mode === 'none') return ''
  if (mode === 'voiceover') {
    return `The narrator (S1) says in an off-screen voiceover using a ${speakerCue(voiceover, input.speakerHint)}: ${formatDialogueBlock(voiceover)}`
  }
  return `The on-screen speaker (S1) says in a ${speakerCue(voiceover, input.speakerHint)}: ${formatDialogueBlock(voiceover)}`
}

/**
 * 组装传给 ComfyUI / MiniMax H3 的最终 prompt
 */
export function composeH3VideoPrompt(input: H3PromptInput): string {
  const style = input.promptStyle ?? 'scene-narrative'
  if (style === 'scene-narrative') return composeSceneNarrativePrompt(input)
  return composeFormattedPrompt(input)
}

/** 配图里已经有人：从第一帧接着演。画面中谁是谁 + 连续演戏。不要套英文标签。 */
function composeSceneNarrativePrompt(input: H3PromptInput): string {
  const visual = (input.prompt || '').trim()
  if (!visual) return '从第一帧接着演。'
  if (/^从第一帧接着演/.test(visual)) return visual
  return `从第一帧接着演。${visual}`
}

/** 人物图 + 空镜底板：按 MiniMax H3 制作模板组装 */
function composeFormattedPrompt(input: H3PromptInput): string {
  const mode = input.mode ?? 'I2VA'
  const visual = (input.prompt || '').trim() || 'the scene continues from the first frame'
  const camera =
    (input.cameraMovement && CAMERA_PHRASE[input.cameraMovement]) ||
    CAMERA_PHRASE.static
  const dur = Math.max(4, Math.min(15, Number(input.duration) || 5))
  const referenceLead =
    mode === 'I2VA' ? '从第一帧接着演。' : ''
  const ratio = input.aspectRatio ? `\nAspect Ratio: ${input.aspectRatio}` : ''
  const spoken = dialogueLine(input)
  const soundscape = toEnglishSoundscape(input.audioDescription)
  const score = toEnglishScore(input.audioDescription)

  return `Aesthetic

${aestheticBlock(input.aesthetic)}${ratio}

[SHOT 1]

Duration: 0:00 - ${formatTime(dur)}
Camera Motion: ${camera}

Visual Prompt:
${referenceLead}${visual}
${spoken ? `\n${spoken}` : ''}

overall_soundscape: ${soundscape}

non_diegetic_music: ${score}`
}
