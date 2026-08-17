/**
 * 整片背景音乐（纯音乐，无人声）
 *
 * 分镜视频自带的配乐切来切去不流畅，导出时会丢掉。
 * 这里按主题/风格生成一段 BGM，循环铺满成片，再叠口播。
 *
 * MiniMax Music 3.0：
 *   POST https://api.minimaxi.com/v1/music_generation
 *   is_instrumental: true  → 纯音乐，不跟口播抢人声
 * （lyrics_generation 只写词，不出音频）
 */

import { getAIMode, callLLM } from './client'
import type { Project, VisualStyle } from '@/types'

export interface MusicGenInput {
  prompt: string
  /** 目标时长（秒），生成结果会在导出时循环/裁切对齐 */
  duration?: number
}

export interface MusicGenOutput {
  blob: Blob
  mimeType: string
  prompt: string
  model: string
}

const log = (msg: string) =>
  console.log('%c[music]', 'color:#10b981;font-weight:600', msg)

const STYLE_MUSIC: Record<VisualStyle, string> = {
  cinematic: '电影感配乐，温暖弦乐与轻电子铺底，节奏平稳',
  anime: '日系动画风轻快配乐，钢琴与合成器，明亮但不吵',
  photorealistic: '现代纪录片感原声，木吉他与氛围垫音',
  '3d-render': '科技感电子氛围，干净低频，节奏克制',
  'oil-painting': '古典油画气质，轻弦乐与钢琴，舒缓',
  watercolor: '清新水彩感，木吉他与长笛，轻柔',
  'pixel-art': '复古游戏风芯片音乐，轻快但音量克制',
  'ink-wash': '中国风水墨，古筝笛箫点到为止，留白多'
}

export function buildMusicPrompt(project: Project): string {
  const topic = project.script?.topic || project.name || '短视频'
  const style = project.script?.style ?? 'cinematic'
  const aesthetic = (project.script?.aesthetic || '').replace(/\s+/g, ' ').slice(0, 180)
  const titles = project.shots
    .slice(0, 8)
    .map((s) => s.title)
    .filter(Boolean)
    .join('、')
  const mood = STYLE_MUSIC[style] || STYLE_MUSIC.cinematic
  return [
    `纯音乐背景，绝对无人声、无歌词、无对白。`,
    `主题：${topic}。`,
    titles ? `画面段落：${titles}。` : '',
    `音乐风格：${mood}。`,
    aesthetic ? `整体氛围：${aesthetic}。` : '',
    `适合短视频 BGM：音量铺底、不要抢人声口播，节奏连贯可循环，淡入淡出自然。`
  ]
    .filter(Boolean)
    .join('')
}

export async function refineMusicPrompt(project: Project): Promise<string> {
  const fallback = buildMusicPrompt(project)
  if (getAIMode() !== 'real') return fallback
  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content:
            '你是专业的短视频配乐导演。根据项目信息用简体中文写一段 80-180 字的纯音乐提示词。必须强调：仅器乐、无人声、无歌词，适合口播铺底。只输出提示词本身，不要解释。'
        },
        { role: 'user', content: fallback }
      ],
      temperature: 0.7,
      maxTokens: 400
    })
    const text = (resp.content || '').replace(/```[\s\S]*?```/g, '').trim()
    if (text.length >= 20 && text.length <= 2000) return text
  } catch (e) {
    log(`润色提示词失败，用模板：${e}`)
  }
  return fallback
}

function musicConfig() {
  const apiKey = import.meta.env.VITE_MUSIC_API_KEY
  const model = import.meta.env.VITE_MUSIC_MODEL || 'music-3.0'
  const baseUrl = String(
    import.meta.env.VITE_MUSIC_BASE_URL || 'https://api.minimaxi.com/v1'
  ).replace(/\/+$/, '')
  return { apiKey, model, baseUrl }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '').replace(/\s/g, '')
  if (clean.length < 8 || clean.length % 2 !== 0) {
    throw new Error('[music] hex 音频数据异常')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function mockBgm(durationSec: number): Blob {
  const duration = Math.min(48, Math.max(12, durationSec || 24))
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
    const env = Math.min(1, t * 0.6) * Math.min(1, (duration - t) * 0.6)
    const s =
      Math.sin(2 * Math.PI * 110 * t) * 0.07 +
      Math.sin(2 * Math.PI * 164.81 * t) * 0.05 +
      Math.sin(2 * Math.PI * 196 * t) * 0.035
    view.setInt16(44 + i * 2, Math.round(s * env * 32767), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

async function downloadAudio(url: string): Promise<Blob> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`[music] 下载失败 ${resp.status}`)
  const buf = await resp.arrayBuffer()
  const ct = (resp.headers.get('content-type') || '').toLowerCase()
  return new Blob([buf], {
    type: ct.includes('wav') ? 'audio/wav' : 'audio/mpeg'
  })
}

function audioFromPayload(audio: string, format: string): Promise<Blob> | Blob {
  if (/^https?:\/\//i.test(audio)) {
    return downloadAudio(audio)
  }
  const bytes = hexToBytes(audio)
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  const mime = format === 'wav' ? 'audio/wav' : 'audio/mpeg'
  return new Blob([copy], { type: mime })
}

async function realMinimaxMusic(prompt: string, model: string): Promise<MusicGenOutput> {
  const { apiKey, baseUrl } = musicConfig()
  if (!apiKey) {
    throw new Error(
      '[music] 未配置 VITE_MUSIC_API_KEY（MiniMax API Key）\n' +
        '在 .env 里填写后重启 npm run dev'
    )
  }

  const format = 'mp3'
  log(`→ MiniMax ${model} instrumental`)
  const resp = await fetch(`${baseUrl}/music_generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt: prompt.slice(0, 2000),
      is_instrumental: true,
      output_format: 'hex',
      audio_setting: {
        sample_rate: 44100,
        bitrate: 256000,
        format
      }
    })
  })
  const raw = await resp.text()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`[music] ${resp.status} ${raw.slice(0, 240)}`)
  }

  const code = data.base_resp?.status_code
  if (code !== 0 && code !== undefined) {
    throw new Error(
      `[music] MiniMax ${code} ${data.base_resp?.status_msg || raw.slice(0, 200)}`
    )
  }
  if (!resp.ok) {
    throw new Error(`[music] ${resp.status} ${raw.slice(0, 240)}`)
  }

  const audio = data.data?.audio ?? data.audio
  const status = data.data?.status
  if (status === 1) {
    throw new Error('[music] MiniMax 仍在合成中，请稍后重试')
  }
  if (!audio) {
    throw new Error(`[music] 响应无音频：${raw.slice(0, 240)}`)
  }

  const blob = await audioFromPayload(String(audio), format)
  if (blob.size < 400) throw new Error('[music] 音频过短，可能失败')
  log(`✓ ${(blob.size / 1024).toFixed(1)} KB`)
  return { blob, mimeType: blob.type, prompt, model }
}

export async function generateMusic(input: MusicGenInput): Promise<MusicGenOutput> {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('没有配乐提示词')

  if (getAIMode() !== 'real') {
    log('演示模式：生成占位配乐')
    const blob = mockBgm(input.duration ?? 24)
    return { blob, mimeType: blob.type, prompt, model: 'mock-music' }
  }

  const preferred = musicConfig().model
  const models = [...new Set([preferred, 'music-3.0', 'music-3.0-free'])]
  const errors: string[] = []
  for (const model of models) {
    try {
      return await realMinimaxMusic(prompt, model)
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      errors.push(`${model}: ${msg}`)
      log(`${model} 失败：${msg}`)
    }
  }
  throw new Error(errors.join('\n'))
}
