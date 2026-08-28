/**
 * 设置页内置接入：只放大厂官方。中转 / 聚合请用「自定义」。
 * LLM / 视觉按 OpenAI 兼容 /chat/completions 填。
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
    name: 'DeepSeek',
    hint: '写剧本 / 智能体。官方 OpenAI 兼容接口。',
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
    id: 'dashscope',
    name: '阿里云百炼',
    hint: '通义千问官方兼容模式。',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max'],
    defaultModel: 'qwen-plus'
  },
  {
    id: 'volcengine',
    name: '字节跳动 火山方舟',
    hint: '豆包官方 OpenAI 兼容。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k', 'doubao-1-5-lite-32k'],
    defaultModel: 'doubao-1-5-pro-32k'
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
    hint: '智谱官方 OpenAI 兼容接口。',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4-plus', 'glm-4-flash'],
    defaultModel: 'glm-4-flash'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    hint: '海螺官方 OpenAI 兼容。',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-Text-01', 'MiniMax-M1'],
    defaultModel: 'MiniMax-Text-01'
  },
  CUSTOM_PROVIDER
]

export const VISION_PROVIDERS: ProviderPreset[] = [
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
    id: 'volcengine',
    name: '字节跳动 火山方舟',
    hint: '豆包视觉官方兼容。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-1-5-vision-pro-32k', 'doubao-seed-1-6-vision-250815'],
    defaultModel: 'doubao-1-5-vision-pro-32k'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    hint: 'GLM 多模态看图。',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5v', 'glm-4v-plus'],
    defaultModel: 'glm-4v-plus'
  },
  CUSTOM_PROVIDER
]

export const IMAGE_PROVIDERS: ProviderPreset[] = [
  {
    id: 'volcengine',
    name: '字节跳动 火山方舟',
    hint: 'Seedream 官方生图。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415'],
    defaultModel: 'doubao-seedream-4-0-250828'
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
    id: 'dashscope',
    name: '阿里云百炼',
    hint: '通义万相 / Qwen-Image 官方。',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-image-plus', 'wan2.5-t2i-preview'],
    defaultModel: 'qwen-image-plus'
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    hint: 'CogView 官方生图。',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['cogview-4', 'cogview-3-flash'],
    defaultModel: 'cogview-4'
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    hint: '海螺官方生图。',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['image-01'],
    defaultModel: 'image-01'
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
    hint: '整片配乐官方接口。',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['music-3.0'],
    defaultModel: 'music-3.0'
  },
  CUSTOM_PROVIDER
]

export const VIDEO_PROVIDERS: ProviderPreset[] = [
  {
    id: 'minimax',
    name: 'MiniMax',
    hint: '海螺图生视频官方接口。工作流 ID 可留空或按控制台填写。',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-Hailuo-2.3'],
    defaultModel: 'MiniMax-Hailuo-2.3',
    keyPlaceholder: 'MiniMax API Key'
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    hint: '万相视频。节点里选「万相 3.0 Prime」时与配音共用这套百炼 Key。',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    models: ['wan2.6-t2v', 'wan2.5-t2v-preview'],
    defaultModel: 'wan2.6-t2v'
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
