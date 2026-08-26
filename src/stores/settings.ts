/**
 * 全局应用设置（AI 模式、模型端点、UI 偏好）
 * 密钥只存在本机 localStorage，不进仓库。
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { envDefaults, migrateVideoBaseUrl, migrateVideoWorkflowId } from '@/services/ai/env'
import type { VideoPromptStyle } from '@/utils/shotPrompt'

const STORAGE_KEY = 'ai-cut:settings'

export type { VideoPromptStyle }

export type AIMode = 'mock' | 'real'

export interface ServiceEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  /** 配好后可在下拉里选 */
  models: string[]
  /** 设置页选中的接入方式 id，如 deepseek / apiyi / custom */
  provider?: string
}

/** 一套已保存的 LLM 接入（地址 + Key + 模型列表） */
export interface LlmProfile extends ServiceEndpoint {
  id: string
  name: string
}

export interface TtsEndpoint extends ServiceEndpoint {
  voice: string
}

export interface VideoEndpoint {
  baseUrl: string
  apiKey: string
  workflowId: string
  /**
   * scene-narrative：配图里已经有人，直接写谁是谁和怎么演（默认）。
   * formatted：人物图 + 空镜底板直接出视频，套 Aesthetic / SHOT 结构。
   */
  promptStyle: VideoPromptStyle
}

export interface AppSettings {
  theme: 'dark' | 'light'
  aiMode: AIMode
  debug: boolean
  defaultAspectRatio: string
  autoSaveInterval: number
  llm: ServiceEndpoint
  /** 已保存的多套 LLM，可随时切换 */
  llms: LlmProfile[]
  activeLlmId: string
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

/** 每个接入下可切换的模型名，给智能体 / 写剧本下拉用 */
export function llmModelGroups(llms: LlmProfile[]) {
  return (llms ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    models: uniq([p.model, ...(p.models ?? [])])
  }))
}

export function llmChoiceKey(profileId: string, model: string) {
  return `${profileId}::${model}`
}

export function parseLlmChoiceKey(key: string): { profileId: string; model: string } | null {
  const i = key.indexOf('::')
  if (i <= 0) return null
  return { profileId: key.slice(0, i), model: key.slice(i + 2) }
}

function newId() {
  return `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function asEndpoint(ep: ServiceEndpoint): ServiceEndpoint {
  return {
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: ep.model,
    models: uniq(ep.models ?? []),
    provider: ep.provider
  }
}

function profileFromEndpoint(ep: ServiceEndpoint, name: string, id?: string): LlmProfile {
  return {
    id: id || newId(),
    name,
    ...asEndpoint(ep)
  }
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
  const llm = endpoint(env.llm.baseUrl, env.llm.apiKey, env.llm.model, LLM_PRESETS)
  const first = profileFromEndpoint(llm, '默认 LLM')
  return {
    theme: 'dark',
    aiMode: 'real',
    debug: false,
    defaultAspectRatio: '16:9',
    autoSaveInterval: 0,
    llm,
    llms: [first],
    activeLlmId: first.id,
    vision: endpoint(env.vision.baseUrl, env.vision.apiKey, env.vision.model, VISION_PRESETS),
    image: endpoint(env.image.baseUrl, env.image.apiKey, env.image.model, IMAGE_PRESETS),
    tts: {
      ...endpoint(env.tts.baseUrl, env.tts.apiKey, env.tts.model, TTS_PRESETS),
      voice: env.tts.voice
    },
    video: {
      baseUrl: env.video.baseUrl,
      apiKey: env.video.apiKey,
      workflowId: env.video.workflowId,
      promptStyle: 'scene-narrative'
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
    const savedProfiles = Array.isArray(parsed.llms)
      ? parsed.llms.filter((p): p is LlmProfile => Boolean(p && p.id && p.name))
      : []
    const llms = savedProfiles.length
      ? savedProfiles.map((p) =>
          profileFromEndpoint(
            {
              ...llm,
              ...p,
              models: uniq([...(p.models ?? []), ...(p.model ? [p.model] : [])])
            },
            p.name,
            p.id
          )
        )
      : [profileFromEndpoint(llm, '默认 LLM')]
    const activeLlmId = llms.some((p) => p.id === parsed.activeLlmId)
      ? (parsed.activeLlmId as string)
      : llms[0].id
    const active = llms.find((p) => p.id === activeLlmId) || llms[0]

    return {
      ...defaults,
      ...parsed,
      theme: 'dark',
      aiMode: 'real',
      llm: asEndpoint(active),
      llms,
      activeLlmId: active.id,
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
      video: {
        ...defaults.video,
        ...parsed.video,
        baseUrl: migrateVideoBaseUrl(parsed.video?.baseUrl || defaults.video.baseUrl),
        apiKey: parsed.video?.apiKey || defaults.video.apiKey,
        workflowId: migrateVideoWorkflowId(parsed.video?.workflowId || defaults.video.workflowId),
        promptStyle:
          parsed.video?.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative'
      },
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

  function syncActive(next: LlmProfile, list?: LlmProfile[]) {
    const llms = (list ?? config.value.llms).map((p) => (p.id === next.id ? next : p))
    config.value = {
      ...config.value,
      llms,
      activeLlmId: next.id,
      llm: asEndpoint(next)
    }
  }

  function patchLlm(patch: Partial<LlmProfile>) {
    const id = config.value.activeLlmId
    const cur =
      config.value.llms.find((p) => p.id === id) || profileFromEndpoint(config.value.llm, '默认 LLM', id)
    syncActive({
      ...cur,
      ...patch,
      models: uniq(patch.models ?? cur.models)
    })
  }

  function addLlm(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider
      },
      seed.name
    )
    syncActive(profile, [...config.value.llms, profile])
  }

  function selectLlm(id: string) {
    const profile = config.value.llms.find((p) => p.id === id)
    if (profile) syncActive(profile)
  }

  /** 切到某套接入，并指定其中的模型名 */
  function selectLlmModel(profileId: string, model: string) {
    const profile = config.value.llms.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncActive({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeLlm(id: string) {
    if (config.value.llms.length <= 1) return
    const llms = config.value.llms.filter((p) => p.id !== id)
    const next = llms.find((p) => p.id === config.value.activeLlmId) || llms[0]
    syncActive(next, llms)
  }

  function renameLlm(name: string) {
    const n = name.trim()
    if (!n) return
    patchLlm({ name: n })
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

  function patchMusic(patch: Partial<ServiceEndpoint>) {
    config.value = { ...config.value, music: { ...config.value.music, ...patch } }
  }

  function addModel(kind: 'llm' | 'vision' | 'image' | 'tts' | 'music', name: string) {
    const n = name.trim()
    if (!n) return
    if (kind === 'llm') {
      patchLlm({ models: uniq([...config.value.llm.models, n]), model: n })
      return
    }
    const cur = config.value[kind]
    const models = uniq([...cur.models, n])
    config.value = {
      ...config.value,
      [kind]: { ...cur, models, model: n }
    }
  }

  function removeModel(kind: 'llm' | 'vision' | 'image' | 'tts' | 'music', name: string) {
    if (kind === 'llm') {
      const models = config.value.llm.models.filter((m) => m !== name)
      if (!models.length) return
      patchLlm({
        models,
        model: config.value.llm.model === name ? models[0] : config.value.llm.model
      })
      return
    }
    const cur = config.value[kind]
    const models = cur.models.filter((m) => m !== name)
    if (!models.length) return
    const model = cur.model === name ? models[0] : cur.model
    config.value = { ...config.value, [kind]: { ...cur, models, model } }
  }

  return {
    config,
    update,
    patchLlm,
    addLlm,
    selectLlm,
    selectLlmModel,
    removeLlm,
    renameLlm,
    patchVision,
    patchImage,
    patchTts,
    patchVideo,
    patchMusic,
    addModel,
    removeModel
  }
})
