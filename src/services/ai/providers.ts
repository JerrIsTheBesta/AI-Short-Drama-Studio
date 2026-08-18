/**
 * 设置页常用接入方式。都按 OpenAI 兼容 /chat/completions 来填，
 * 选好后自动带上 Base URL 和常用模型名，用户只需填 Key。
 */

export interface ProviderPreset {
  id: string
  name: string
  hint: string
  baseUrl: string
  models: string[]
  defaultModel: string
  keyPlaceholder?: string
}

function uniq(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

export const CUSTOM_PROVIDER: ProviderPreset = {
  id: 'custom',
  name: '自定义（OpenAI 兼容）',
  hint: '自己填 Base URL 和模型名，路径要能接到 /chat/completions',
  baseUrl: '',
  models: [],
  defaultModel: '',
  keyPlaceholder: 'sk-…'
}

export const LLM_PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    hint: '写剧本 / 智能体推荐。官方 OpenAI 兼容接口。',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-v4-flash'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    hint: '官方 GPT。Base URL 已含 /v1。',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-4o-mini'
  },
  {
    id: 'apiyi',
    name: 'APIYI 聚合',
    hint: '一套 Key 调多家模型，国内常用中转。',
    baseUrl: 'https://api.apiyi.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-chat', 'gpt-4o', 'qwen-plus'],
    defaultModel: 'deepseek-v4-flash'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    hint: 'DeepSeek / Qwen 等开源模型，按量计费。',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-72B-Instruct'
    ],
    defaultModel: 'deepseek-ai/DeepSeek-V3'
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    hint: 'Qwen 兼容模式。写剧本也可用。',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max'],
    defaultModel: 'qwen-plus'
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    hint: '长上下文，适合整本剧本。',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-turbo-preview', 'moonshot-v1-auto', 'moonshot-v1-128k'],
    defaultModel: 'kimi-k2-turbo-preview'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    hint: '智谱 OpenAI 兼容接口。',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4-plus', 'glm-4-flash'],
    defaultModel: 'glm-4-flash'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    hint: '一个入口选很多家模型，模型名带厂商前缀。',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini', 'qwen/qwen-2.5-72b-instruct'],
    defaultModel: 'deepseek/deepseek-chat'
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    hint: '本机 11434。Key 可填 ollama。',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5', 'llama3.1', 'deepseek-r1'],
    defaultModel: 'qwen2.5',
    keyPlaceholder: 'ollama'
  },
  CUSTOM_PROVIDER
]

export const VISION_PROVIDERS: ProviderPreset[] = [
  {
    id: 'apiyi',
    name: 'APIYI 聚合',
    hint: '看图 / 质检推荐。',
    baseUrl: 'https://api.apiyi.com/v1',
    models: ['qwen3-vl-plus', 'qwen3.8-max'],
    defaultModel: 'qwen3-vl-plus'
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    hint: 'Qwen-VL 官方兼容模式。',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-vl-max', 'qwen-vl-plus', 'qwen3-vl-plus'],
    defaultModel: 'qwen-vl-max'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    hint: 'GPT 多模态看图。',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4.1'],
    defaultModel: 'gpt-4o'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    hint: '开源视觉模型。',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen/Qwen2-VL-72B-Instruct'],
    defaultModel: 'Qwen/Qwen2.5-VL-72B-Instruct'
  },
  CUSTOM_PROVIDER
]

export const IMAGE_PROVIDERS: ProviderPreset[] = [
  {
    id: 'apiyi',
    name: 'APIYI 聚合',
    hint: 'Seedream / GPT Image 常用。',
    baseUrl: 'https://api.apiyi.com/v1',
    models: ['seedream-4-5-251128', 'gpt-image-2', 'dall-e-3', 'flux-1-pro'],
    defaultModel: 'seedream-4-5-251128'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    hint: '官方 Images API。',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-image-1', 'dall-e-3'],
    defaultModel: 'gpt-image-1'
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    hint: 'Flux 等开源生图。',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['black-forest-labs/FLUX.1-schnell', 'black-forest-labs/FLUX.1-dev'],
    defaultModel: 'black-forest-labs/FLUX.1-schnell'
  },
  CUSTOM_PROVIDER
]

export const TTS_PROVIDERS: ProviderPreset[] = [
  {
    id: 'dashscope',
    name: '阿里云百炼',
    hint: '口播 TTS 走百炼语音合成，不是 /chat/completions。',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    models: ['qwen-audio-3.0-tts-flash', 'qwen3-tts-flash'],
    defaultModel: 'qwen-audio-3.0-tts-flash'
  },
  CUSTOM_PROVIDER
]

export const MUSIC_PROVIDERS: ProviderPreset[] = [
  {
    id: 'minimax',
    name: 'MiniMax',
    hint: '整片配乐。',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['music-3.0'],
    defaultModel: 'music-3.0'
  },
  CUSTOM_PROVIDER
]

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase()
  } catch {
    return url.trim().replace(/\/+$/, '').toLowerCase()
  }
}

export function matchProviderId(baseUrl: string, presets: ProviderPreset[]): string {
  const host = hostOf(baseUrl)
  if (!host) return 'custom'
  const found = presets.find((p) => p.id !== 'custom' && p.baseUrl && hostOf(p.baseUrl) === host)
  return found?.id || 'custom'
}

export function findProvider(id: string, presets: ProviderPreset[]): ProviderPreset {
  return presets.find((p) => p.id === id) || CUSTOM_PROVIDER
}

export function applyProviderPreset(
  current: { baseUrl: string; model: string; models: string[] },
  preset: ProviderPreset
): { provider: string; baseUrl: string; model: string; models: string[] } {
  const keepUrl = preset.id === 'custom'
  const model = preset.defaultModel || current.model
  return {
    provider: preset.id,
    baseUrl: keepUrl ? current.baseUrl : preset.baseUrl || current.baseUrl,
    model,
    models: uniq([...preset.models, ...current.models, model])
  }
}
