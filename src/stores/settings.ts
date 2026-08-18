/**
 * 全局应用设置（AI 模式、模型端点、UI 偏好）
 * 密钥只存在本机 localStorage，不进仓库。
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { envDefaults } from '@/services/ai/env'

const STORAGE_KEY = 'ai-cut:settings'

export type AIMode = 'mock' | 'real'

export interface ServiceEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  /** 配好后可在下拉里选 */
  models: string[]
}

export interface TtsEndpoint extends ServiceEndpoint {
  voice: string
}

export interface VideoEndpoint {
  baseUrl: string
  apiKey: string
  workflowId: string
}

export interface AppSettings {
  theme: 'dark' | 'light'
  aiMode: AIMode
  debug: boolean
  defaultAspectRatio: string
  autoSaveInterval: number
  llm: ServiceEndpoint
  vision: ServiceEndpoint
  image: ServiceEndpoint
  tts: TtsEndpoint
  video: VideoEndpoint
  music: ServiceEndpoint
}

export const LLM_PRESETS = [
  'deepseek-v4-flash',
  'deepseek-chat',
  'deepseek-reasoner'
]

export const VISION_PRESETS = ['qwen3-vl-plus', 'qwen3.8-max']

export const IMAGE_PRESETS = [
  'seedream-4-5-251128',
  'gpt-image-2',
  'dall-e-3',
  'flux-1-pro'
]

export const TTS_PRESETS = ['qwen-audio-3.0-tts-flash', 'qwen3-tts-flash']

export const MUSIC_PRESETS = ['music-3.0']

function uniq(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

function endpoint(
  baseUrl: string,
  apiKey: string,
  model: string,
  presets: string[]
): ServiceEndpoint {
  return {
    baseUrl,
    apiKey,
    model,
    models: uniq([model, ...presets])
  }
}

function buildDefaults(): AppSettings {
  const env = envDefaults()
  return {
    theme: 'dark',
    aiMode: env.realMode ? 'real' : 'mock',
    debug: false,
    defaultAspectRatio: '16:9',
    autoSaveInterval: 0,
    llm: endpoint(env.llm.baseUrl, env.llm.apiKey, env.llm.model, LLM_PRESETS),
    vision: endpoint(env.vision.baseUrl, env.vision.apiKey, env.vision.model, VISION_PRESETS),
    image: endpoint(env.image.baseUrl, env.image.apiKey, env.image.model, IMAGE_PRESETS),
    tts: {
      ...endpoint(env.tts.baseUrl, env.tts.apiKey, env.tts.model, TTS_PRESETS),
      voice: env.tts.voice
    },
    video: {
      baseUrl: env.video.baseUrl,
      apiKey: env.video.apiKey,
      workflowId: env.video.workflowId
    },
    music: endpoint(env.music.baseUrl, env.music.apiKey, env.music.model, MUSIC_PRESETS)
  }
}

function load(): AppSettings {
  const defaults = buildDefaults()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    const savedLlm = parsed.llm
    const legacyQwenPrimary = /^qwen/i.test(savedLlm?.model ?? '')
    const llm = legacyQwenPrimary
      ? defaults.llm
      : {
          ...defaults.llm,
          ...savedLlm,
          models: uniq([...(savedLlm?.models ?? []), ...defaults.llm.models]).filter(
            (model) => !/^qwen/i.test(model)
          )
        }
    const savedVision = parsed.vision
    const legacyTextOnlyVision = /^(qwen3\.7|qwen-vl-)/i.test(savedVision?.model ?? '')
    const vision = {
      ...defaults.vision,
      ...savedVision,
      model: legacyTextOnlyVision ? defaults.vision.model : (savedVision?.model || defaults.vision.model),
      models: uniq([...(savedVision?.models ?? []), ...defaults.vision.models]).filter(
        (model) => !/^(qwen3\.7|qwen-vl-)/i.test(model)
      )
    }
    return {
      ...defaults,
      ...parsed,
      llm,
      vision,
      image: {
        ...defaults.image,
        ...parsed.image,
        models: uniq([...(parsed.image?.models ?? []), ...defaults.image.models])
      },
      tts: {
        ...defaults.tts,
        ...parsed.tts,
        models: uniq([...(parsed.tts?.models ?? []), ...defaults.tts.models])
      },
      video: { ...defaults.video, ...parsed.video },
      music: {
        ...defaults.music,
        ...parsed.music,
        models: uniq([...(parsed.music?.models ?? []), ...defaults.music.models])
      }
    }
  } catch {
    return defaults
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppSettings>(load())

  watch(
    config,
    (v) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
    },
    { deep: true }
  )

  function update(patch: Partial<AppSettings>) {
    config.value = { ...config.value, ...patch }
  }

  function patchLlm(patch: Partial<ServiceEndpoint>) {
    config.value = { ...config.value, llm: { ...config.value.llm, ...patch } }
  }

  function patchVision(patch: Partial<ServiceEndpoint>) {
    config.value = { ...config.value, vision: { ...config.value.vision, ...patch } }
  }

  function patchImage(patch: Partial<ServiceEndpoint>) {
    config.value = { ...config.value, image: { ...config.value.image, ...patch } }
  }

  function patchTts(patch: Partial<TtsEndpoint>) {
    config.value = { ...config.value, tts: { ...config.value.tts, ...patch } }
  }

  function patchVideo(patch: Partial<VideoEndpoint>) {
    config.value = { ...config.value, video: { ...config.value.video, ...patch } }
  }

  function addModel(kind: 'llm' | 'vision' | 'image' | 'tts' | 'music', name: string) {
    const n = name.trim()
    if (!n) return
    const cur = config.value[kind]
    const models = uniq([...cur.models, n])
    config.value = {
      ...config.value,
      [kind]: { ...cur, models, model: n }
    }
  }

  function removeModel(kind: 'llm' | 'vision' | 'image' | 'tts' | 'music', name: string) {
    const cur = config.value[kind]
    const models = cur.models.filter((m) => m !== name)
    if (!models.length) return
    const model = cur.model === name ? models[0] : cur.model
    config.value = { ...config.value, [kind]: { ...cur, models, model } }
  }

  return { config, update, patchLlm, patchVision, patchImage, patchTts, patchVideo, addModel, removeModel }
})
