/** 从 Vite .env 读默认值（不含 Pinia，避免和 settings store 循环依赖） */

function envStr(key: string, fallback = ''): string {
  const v = (import.meta.env as Record<string, string | undefined>)[key]
  const s = typeof v === 'string' ? v.trim() : ''
  return s || fallback
}

export function envRealMode(): boolean {
  const flag = envStr('VITE_AI_REAL_MODE', 'false').toLowerCase()
  return flag === 'true' || flag === '1'
}

export function envDefaults() {
  return {
    realMode: envRealMode(),
    llm: {
      baseUrl: envStr('VITE_LLM_BASE_URL', 'https://api.apiyi.com/v1'),
      apiKey: envStr('VITE_LLM_API_KEY'),
      model: envStr('VITE_LLM_MODEL', 'qwen3.7-max')
    },
    image: {
      baseUrl: envStr('VITE_IMAGE_BASE_URL', 'https://api.apiyi.com/v1'),
      apiKey: envStr('VITE_IMAGE_API_KEY'),
      model: envStr('VITE_IMAGE_MODEL', 'seedream-4-5-251128')
    },
    tts: {
      baseUrl: envStr('VITE_TTS_BASE_URL', 'https://dashscope.aliyuncs.com/api/v1'),
      apiKey: envStr('VITE_TTS_API_KEY') || envStr('VITE_LLM_API_KEY'),
      model: envStr('VITE_TTS_MODEL', 'qwen-audio-3.0-tts-flash'),
      voice: envStr('VITE_TTS_VOICE', 'longanhuan_v3.6')
    },
    video: {
      baseUrl: envStr('VITE_VIDEO_BASE_URL'),
      apiKey: envStr('VITE_VIDEO_API_KEY'),
      workflowId: envStr('VITE_VIDEO_WORKFLOW_ID', 'minimax_h3_light2v-1')
    },
    music: {
      baseUrl: envStr('VITE_MUSIC_BASE_URL', 'https://api.minimaxi.com/v1'),
      apiKey: envStr('VITE_MUSIC_API_KEY'),
      model: envStr('VITE_MUSIC_MODEL', 'music-3.0')
    }
  }
}
