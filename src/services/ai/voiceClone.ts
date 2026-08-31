/** Qwen3-TTS 声音复刻与非实时合成。复用设置页中的百炼 TTS 地址和 API Key。 */
import { getTtsConfig } from './runtime'
import { normalizeForSpeech } from './tts'

const CLONE_MODEL = 'qwen3-tts-vc-2026-01-22'

function apiRoot(baseUrl: string): string {
  let value = baseUrl.trim().replace(/\/+$/, '')
  value = value.replace(/\/compatible-mode\/v1$/i, '/api/v1')
  if (/\/api\/v1$/i.test(value)) return value
  if (/^https?:\/\//i.test(value) && !/\/api\//i.test(value)) return `${value}/api/v1`
  return value
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${blob.type || 'audio/mpeg'};base64,${btoa(binary)}`
}

function audioFromBase64(value: string, mime = 'audio/mpeg'): Blob {
  const raw = value.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '')
  const binary = atob(raw)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

async function downloadAudio(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`下载克隆语音失败：HTTP ${response.status}`)
  const type = response.headers.get('content-type') || 'audio/mpeg'
  return new Blob([await response.arrayBuffer()], { type })
}

async function request(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const config = getTtsConfig()
  if (!config.apiKey.trim()) throw new Error('未配置百炼 API Key，请先到设置页配置“口播 TTS”')
  const response = await fetch(`${apiRoot(config.baseUrl)}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  })
  const raw = await response.text()
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`声音服务返回异常：HTTP ${response.status} ${raw.slice(0, 180)}`)
  }
  if (!response.ok || data?.code) {
    throw new Error(`声音服务失败：${data?.message || data?.code || response.status}`)
  }
  return data
}

export interface CloneVoiceOutput {
  voiceId: string
  model: string
  fallbackMode?: boolean
  fallbackReason?: string
}

export async function cloneVoiceFromSample(
  sample: Blob,
  preferredName: string,
  signal?: AbortSignal
): Promise<CloneVoiceOutput> {
  if (sample.size > 10 * 1024 * 1024) throw new Error('声音样本不能超过 10 MB')
  const safeName = preferredName.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'aicutvoice'
  const data = await request(
    '/services/audio/tts/customization',
    {
      model: 'qwen-voice-enrollment',
      input: {
        action: 'create',
        target_model: CLONE_MODEL,
        preferred_name: safeName,
        audio: { data: await blobToDataUrl(sample) }
      }
    },
    signal
  )
  const voiceId = String(data?.output?.voice || '').trim()
  if (!voiceId) throw new Error('声音复刻成功响应中没有 voice ID')
  return {
    voiceId,
    model: String(data?.output?.target_model || CLONE_MODEL),
    fallbackMode: data?.output?.fallback_mode,
    fallbackReason: data?.output?.fallback_reason
  }
}

export async function synthesizeClonedSpeech(
  text: string,
  voiceId: string,
  model = CLONE_MODEL,
  signal?: AbortSignal
): Promise<Blob> {
  const data = await request(
    '/services/aigc/multimodal-generation/generation',
    { model, input: { text: normalizeForSpeech(text.trim()), voice: voiceId } },
    signal
  )
  const audio = data?.output?.audio ?? data?.audio
  if (audio?.data) return audioFromBase64(String(audio.data), audio?.mime_type || 'audio/mpeg')
  const url = String(audio?.url || data?.output?.audio_url || '').trim()
  if (!url) throw new Error(`克隆语音响应中没有音频：${JSON.stringify(data).slice(0, 220)}`)
  return downloadAudio(url, signal)
}

