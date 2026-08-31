/**
 * 口播 TTS：按分镜字幕生成人声
 *
 * 对接阿里云百炼语音合成（文档 2938790 / 实时与非实时 SpeechSynthesizer）：
 *   POST {origin}/api/v1/services/audio/tts/SpeechSynthesizer
 * 默认模型：qwen-audio-3.0-tts-flash（同系列，视频配音用非实时 HTTP）
 * 生成视频时顺带合成，导出时叠到对应片段上。
 */

import { getAIMode } from './client'
import { spokenTextOnly } from './dialogue'
import { getTtsConfig } from './runtime'

export interface TTSInput {
  text: string
  voice?: string
  language?: 'Chinese' | 'English' | 'Auto'
  /** 自然语言语气指令；不应包含要朗读的正文 */
  instruction?: string
  signal?: AbortSignal
}

export interface TTSOutput {
  blob: Blob
  mimeType: string
  duration?: number
  model: string
}

const MAX_CHARS = 580

const log = (msg: string) =>
  console.log('%c[tts]', 'color:#06b6d4;font-weight:600', msg)

/** qwen-audio-3.0-tts-flash 系统音色（百炼音色列表） */
export const TTS_VOICES: { id: string; label: string }[] = [
  { id: 'longanhuan_v3.6', label: '龙安欢（女·自然普通话）' },
  { id: 'longjielidou_v3.6', label: '龙杰力豆（男童）' },
  { id: 'longpaopao_v3.6', label: '龙泡泡（女童）' },
  { id: 'longhuohuo_v3.6', label: '龙火火（顽皮少年）' },
  { id: 'longchuanshu_v3.6', label: '龙川叔（男）' },
  { id: 'loongeva_v3.6', label: 'loongeva（女·美音）' }
]

/** 这些仍按缩写处理（可以逐字母或习惯读法） */
const SPELL_ACRONYMS = new Set([
  'VIP',
  'SKU',
  'UV',
  'UVA',
  'UVB',
  'LED',
  'USB',
  'CPU',
  'GPU',
  'PDF',
  'QR',
  'ID',
  'TV',
  'AI',
  'SPF',
  '3C',
  'OK'
])

const DIGIT_CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const DIGIT_YAO = ['零', '幺', '二', '三', '四', '五', '六', '七', '八', '九']

function spellDigits(digits: string, yao = false): string {
  const table = yao ? DIGIT_YAO : DIGIT_CN
  return [...digits].map((ch) => (/[0-9]/.test(ch) ? table[Number(ch)] : '')).join('')
}

/**
 * 平台号 / 客服号 / 活动日：必须按位读。
 * 否则 1688 会被念成「一千六百八十八」或「一千六百88」。
 */
const SPELLED_NUMBER_CODES: Array<{ pattern: RegExp; spoken?: string; yao?: boolean }> = [
  { pattern: /1688/g, spoken: '一六八八' },
  { pattern: /12306/g, yao: true },
  { pattern: /10086/g, yao: true },
  { pattern: /10010/g, yao: true },
  { pattern: /10000(?![元万亿])/g, yao: true },
  { pattern: /95588/g, yao: true },
  { pattern: /95533/g, yao: true },
  { pattern: /95566/g, yao: true },
  { pattern: /(?<!\d)618(?!\d)/g, spoken: '六一八' },
  { pattern: /(?<!\d)1111(?!\d)/g, spoken: '双十一' },
  { pattern: /(?<!\d)1212(?!\d)/g, spoken: '双十二' },
  { pattern: /58(?=同城)/g, spoken: '五八' },
  { pattern: /(?<!\d)(?:110|119|120|122|114)(?!\d)/g, yao: true }
]

function normalizeSpokenNumbers(text: string): string {
  let next = text
  for (const item of SPELLED_NUMBER_CODES) {
    next = next.replace(item.pattern, (match) => item.spoken || spellDigits(match.replace(/\D/g, ''), item.yao))
  }
  next = next.replace(/(?<!\d)([48]00)[- ]?(\d{3,4})[- ]?(\d{3,4})(?!\d)/g, (_all, a, b, c) =>
    `${spellDigits(a, true)}，${spellDigits(b, true)}，${spellDigits(c, true)}`
  )
  return next
}

/**
 * 送给 TTS / 口播模型的文本预处理，字幕原文不改，只影响发音。
 * 中文模型遇到 POLO / NIKE 这种全大写，会当成缩写念成 P-O-L-O。
 * 有元音、长度≥3 的全大写词改成首字母大写（Polo），按单词读。
 * 1688、12306 这类平台号按位读，避免念成一千六百八十八。
 */
export function normalizeForSpeech(text: string): string {
  const branded = normalizeSpokenNumbers(text)
  return branded.replace(/[A-Za-z][A-Za-z0-9]*/g, (word) => {
    if (!/^[A-Z0-9]+$/.test(word)) return word
    if (SPELL_ACRONYMS.has(word)) return word
    if (word.length <= 2) return word
    if (/[AEIOUY]/.test(word)) {
      return word.charAt(0) + word.slice(1).toLowerCase()
    }
    return word
  })
}

export function detectSpeechLanguage(text: string): 'Chinese' | 'English' | 'Auto' {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (text.match(/[A-Za-z]/g) || []).length
  if (cjk > 0 && latin > 0) return 'Auto'
  if (cjk >= latin && cjk > 0) return 'Chinese'
  if (latin > 0 && cjk === 0) return 'English'
  return 'Auto'
}

function ttsConfig() {
  return getTtsConfig()
}

/** 解析出可请求 SpeechSynthesizer 的 origin（含 /api/v1） */
function speechApiRoot(baseUrl: string): string {
  let u = baseUrl.replace(/\/+$/, '')
  // compatible-mode / chat 兼容地址 → 切回原生 api/v1
  u = u.replace(/\/compatible-mode\/v1$/i, '/api/v1')
  if (/\/api\/v1$/i.test(u)) return u
  // 仅给了域名时补 /api/v1
  if (/^https?:\/\//i.test(u) && !/\/api\//i.test(u)) {
    return `${u}/api/v1`
  }
  return u
}

function clipText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= MAX_CHARS) return t
  const slice = t.slice(0, MAX_CHARS)
  const cut = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('.')
  )
  return (cut > 40 ? slice.slice(0, cut + 1) : slice).trim()
}

function languageHint(language: string): string | undefined {
  if (language === 'Chinese') return 'zh'
  if (language === 'English') return 'en'
  return undefined
}

async function downloadAudioUrl(audioUrl: string, signal?: AbortSignal): Promise<Blob> {
  const aResp = await fetch(audioUrl, { signal })
  if (!aResp.ok) throw new Error(`[TTS] 下载音频失败 ${aResp.status}`)
  const buf = await aResp.arrayBuffer()
  const ct = (aResp.headers.get('content-type') || '').toLowerCase()
  const mime =
    ct.includes('mpeg') || ct.includes('mp3')
      ? 'audio/mpeg'
      : ct.includes('wav')
        ? 'audio/wav'
        : 'audio/mpeg'
  return new Blob([buf], { type: mime })
}

function blobFromBase64(data: string, mime = 'audio/wav'): Blob {
  const bin = atob(String(data).replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * 百炼 SpeechSynthesizer（非实时 HTTP）
 * 文档：https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
 * 对应控制台文档 url=2938790 同系列模型
 */
async function speechSynthesizer(
  apiRoot: string,
  apiKey: string,
  model: string,
  text: string,
  voice: string,
  language: string,
  instruction?: string,
  signal?: AbortSignal
): Promise<Blob> {
  const hint = languageHint(language)
  const input: Record<string, unknown> = {
    text,
    voice,
    format: 'wav',
    sample_rate: 24000
  }
  if (hint) input.language_hints = [hint]
  if (instruction) input.instruction = instruction

  const resp = await fetch(`${apiRoot}/services/audio/tts/SpeechSynthesizer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input }),
    signal
  })
  const raw = await resp.text()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`[TTS] SpeechSynthesizer ${resp.status} ${raw.slice(0, 200)}`)
  }
  if (!resp.ok || data.code) {
    throw new Error(
      `[TTS] SpeechSynthesizer ${data.code || resp.status} ${data.message || raw.slice(0, 200)}`
    )
  }

  const audio = data.output?.audio ?? data.audio
  if (audio?.data) {
    return blobFromBase64(String(audio.data), 'audio/wav')
  }
  const audioUrl = audio?.url
  if (!audioUrl) {
    throw new Error(`[TTS] SpeechSynthesizer 无音频：${JSON.stringify(data).slice(0, 240)}`)
  }
  return downloadAudioUrl(audioUrl, signal)
}

/** 旧版 Qwen3-TTS multimodal-generation（兜底） */
async function nativeQwen3Speech(
  origin: string,
  apiKey: string,
  model: string,
  text: string,
  voice: string,
  language: string,
  signal?: AbortSignal
): Promise<Blob> {
  const apiRoot = origin.replace(/\/api\/v1$/i, '') + '/api/v1'
  const resp = await fetch(`${apiRoot}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: {
        text,
        voice,
        language_type: language
      }
    }),
    signal
  })
  const raw = await resp.text()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`[TTS] native ${resp.status} ${raw.slice(0, 200)}`)
  }
  if (!resp.ok || data.code) {
    throw new Error(`[TTS] native ${data.code || resp.status} ${data.message || raw.slice(0, 200)}`)
  }
  const audio = data.output?.audio ?? data.audio
  if (audio?.data) return blobFromBase64(String(audio.data), 'audio/wav')
  const audioUrl = audio?.url
  if (!audioUrl) {
    throw new Error(`[TTS] native 无音频：${JSON.stringify(data).slice(0, 240)}`)
  }
  return downloadAudioUrl(audioUrl, signal)
}

/** 模型和音色版本不匹配时，服务偶尔不报错但输出异常发音；这里改成稳定安全音色。 */
export function compatibleVoice(model: string, requested?: string): string {
  const voice = (requested || '').trim()
  if (/^qwen-audio-3\.0-tts-flash/i.test(model)) {
    const safe = new Set([
      'longanhuan_v3.6',
      'longjielidou_v3.6',
      'longpaopao_v3.6',
      'longhuohuo_v3.6',
      'longchuanshu_v3.6',
      'loongeva_v3.6'
    ])
    return safe.has(voice) ? voice : 'longanhuan_v3.6'
  }
  return voice || 'longanhuan_v3.6'
}

function mockSpeechWav(text: string): Blob {
  const chars = Math.max(1, text.replace(/\s/g, '').length)
  const duration = Math.min(10, Math.max(1.2, chars / 4.5))
  const sampleRate = 22050
  const n = Math.ceil(duration * sampleRate)
  const dataSize = n * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const env = Math.min(1, t * 8) * Math.min(1, (duration - t) * 8)
    const sample = Math.sin(2 * Math.PI * 196 * t) * 0.12 * env
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

export async function generateSpeech(input: TTSInput): Promise<TTSOutput> {
  const text = normalizeForSpeech(clipText(spokenTextOnly(input.text || '')))
  if (!text) throw new Error('没有口播文案，无法配音')

  const cfg = ttsConfig()
  const voice = compatibleVoice(cfg.model, input.voice || cfg.voice)
  const language = input.language || detectSpeechLanguage(text)
  log(`口播文本：${text.slice(0, 80)}${text.length > 80 ? '…' : ''}  lang=${language}`)

  if (getAIMode() !== 'real' || !cfg.apiKey) {
    log('演示模式：生成占位音轨')
    const blob = mockSpeechWav(text)
    return { blob, mimeType: blob.type, model: 'mock-tts' }
  }

  const apiRoot = speechApiRoot(cfg.baseUrl)
  const errors: string[] = []

  try {
    log(`→ SpeechSynthesizer (${cfg.model}, ${voice})`)
    const blob = await speechSynthesizer(
      apiRoot,
      cfg.apiKey,
      cfg.model,
      text,
      voice,
      language,
      input.instruction,
      input.signal
    )
    log(`✓ ${(blob.size / 1024).toFixed(1)} KB`)
    return { blob, mimeType: blob.type, model: cfg.model }
  } catch (e: any) {
    errors.push(e?.message ?? String(e))
    log(`SpeechSynthesizer 失败：${e?.message ?? e}`)
  }

  // 若仍配置了旧版 qwen3-tts-*，再试 multimodal 兜底
  if (/^qwen3-tts/i.test(cfg.model) || /^qwen-tts/i.test(cfg.model)) {
    try {
      const origin = apiRoot.replace(/\/api\/v1$/i, '')
      log(`→ multimodal 兜底 (${cfg.model}, ${voice})`)
      const blob = await nativeQwen3Speech(
        origin,
        cfg.apiKey,
        cfg.model,
        text,
        voice,
        language,
        input.signal
      )
      log(`✓ ${(blob.size / 1024).toFixed(1)} KB`)
      return { blob, mimeType: blob.type, model: cfg.model }
    } catch (e: any) {
      errors.push(e?.message ?? String(e))
    }
  }

  throw new Error(errors.join('\n') || 'TTS 失败')
}
