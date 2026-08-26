/** 从 Vite .env 读默认值（不含 Pinia，避免和 settings store 循环依赖） */

function envStr(key: string, fallback = ''): string {
  const v = (import.meta.env as Record<string, string | undefined>)[key]
  const s = typeof v === 'string' ? v.trim() : ''
  return s || fallback
}

export const VIDEO_AUTODL_ROOT = 'https://autodl.art'
export const VIDEO_DEFAULT_WORKFLOW_ID = 'minimax_h3_image_audio_to_video_v2_15s'

export function isLegacyVideoConfig(value: string): boolean {
  return /seetacloud|:8443|\/api\/workflow|U09-API|U06-API|9图版|light2v-1|lightx2v_no_pic|lightx2v_v5/i.test(value)
}

export function migrateVideoBaseUrl(url: string): string {
  const raw = (url || '').trim().replace(/\/+$/, '')
  if (!raw || isLegacyVideoConfig(raw)) return VIDEO_AUTODL_ROOT
  return raw
}

export function migrateVideoWorkflowId(id: string): string {
  if (!id || isLegacyVideoConfig(id)) return VIDEO_DEFAULT_WORKFLOW_ID
  return id
}

export function envRealMode(): boolean {
  const flag = envStr('VITE_AI_REAL_MODE', 'false').toLowerCase()
  return flag === 'true' || flag === '1'
}

export function envDefaults() {
  return {
    realMode: envRealMode(),
    llm: {
      baseUrl: envStr('VITE_LLM_BASE_URL', 'https://api.deepseek.com'),
      apiKey: envStr('VITE_LLM_API_KEY'),
      model: envStr('VITE_LLM_MODEL', 'deepseek-v4-flash')
    },
    vision: {
      baseUrl: envStr('VITE_VISION_BASE_URL', envStr('VITE_IMAGE_BASE_URL', 'https://api.apiyi.com/v1')),
      apiKey: envStr('VITE_VISION_API_KEY') || envStr('VITE_IMAGE_API_KEY'),
      model: envStr('VITE_VISION_MODEL', 'qwen3-vl-plus')
    },
    remakeVisionModel: envStr('VITE_REMAKE_VISION_MODEL', 'qwen3.8-max'),
    remakeImageModel: envStr('VITE_REMAKE_IMAGE_MODEL', 'gpt-image-2'),
    image: {
      baseUrl: envStr('VITE_IMAGE_BASE_URL', 'https://api.apiyi.com/v1'),
      apiKey: envStr('VITE_IMAGE_API_KEY'),
      model: envStr('VITE_IMAGE_MODEL', 'seedream-4-5-251128')
    },
    tts: {
      baseUrl: envStr('VITE_TTS_BASE_URL', 'https://dashscope.aliyuncs.com/api/v1'),
      apiKey: envStr('VITE_TTS_API_KEY'),
      model: envStr('VITE_TTS_MODEL', 'qwen-audio-3.0-tts-flash'),
      voice: envStr('VITE_TTS_VOICE', 'longanhuan_v3.6')
    },
    video: {
      baseUrl: migrateVideoBaseUrl(envStr('VITE_VIDEO_BASE_URL', VIDEO_AUTODL_ROOT)),
      apiKey: envStr('VITE_VIDEO_API_KEY'),
      workflowId: migrateVideoWorkflowId(envStr('VITE_VIDEO_WORKFLOW_ID', VIDEO_DEFAULT_WORKFLOW_ID))
    },
    music: {
      baseUrl: envStr('VITE_MUSIC_BASE_URL', 'https://api.minimaxi.com/v1'),
      apiKey: envStr('VITE_MUSIC_API_KEY'),
      model: envStr('VITE_MUSIC_MODEL', 'music-3.0')
    }
  }
}
