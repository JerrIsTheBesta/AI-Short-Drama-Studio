/**
 * 全局应用设置（AI 模式、模型端点、UI 偏好）
 * 桌面端写入用户所选保存目录内的本机 SQLite，不走浏览器存储。
 * Web 端仍用 localStorage。
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { envDefaults, migrateVideoBaseUrl, migrateVideoWorkflowId } from '@/services/ai/env'
import { desktop, isDesktop } from '@/services/desktop'
import { stillModeForVideoModel, type VideoStillMode } from '@/types/canvas'
import type { VideoPromptStyle } from '@/utils/shotPrompt'
import type { AdapterConfig } from '@/services/ai/adapters'

export type { AdapterConfig }

const STORAGE_KEY = 'ai-cut:settings'
const SETTINGS_KV_KEY = 'settings'
const LEGACY_SETTINGS_FILE = 'settings.json'

export type { VideoPromptStyle }

export type AIMode = 'mock' | 'real'

export type SetupKind = 'llm' | 'vision' | 'image' | 'tts' | 'video' | 'music'

export interface ServiceEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  /** 配好后可在下拉里选 */
  models: string[]
  /** 设置页选中的接入方式 id，如 deepseek / dashscope / custom */
  provider?: string
  /** 自定义适配器：openai-compatible / openai-images / http-custom / comfyui-* */
  adapter?: AdapterConfig
}

/** 一套已保存的接入（地址 + Key + 模型列表） */
export interface NamedEndpoint extends ServiceEndpoint {
  id: string
  name: string
}

export interface LlmProfile extends NamedEndpoint {}

export interface TtsEndpoint extends ServiceEndpoint {
  voice: string
}

export interface TtsProfile extends TtsEndpoint {
  id: string
  name: string
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
  provider?: string
  /**
   * 出视频参考图。H3 / AutoDL 默认 identity（人设+场景）；万相及其他模型用 keyframe。
   * 画布是否铺分镜关键帧跟这个走，必须在出视频前定好。
   */
  stillMode: VideoStillMode
  /** 自定义适配器：comfyui-workflow（AutoDL）/ comfyui-prompt（自建）/ http-custom */
  adapter?: AdapterConfig
}

export interface VideoProfile extends VideoEndpoint {
  id: string
  name: string
}

export interface AppSettings {
  theme: 'dark' | 'light'
  aiMode: AIMode
  debug: boolean
  defaultAspectRatio: string
  autoSaveInterval: number
  llm: ServiceEndpoint
  llms: LlmProfile[]
  activeLlmId: string
  vision: ServiceEndpoint
  visions: NamedEndpoint[]
  activeVisionId: string
  image: ServiceEndpoint
  images: NamedEndpoint[]
  activeImageId: string
  tts: TtsEndpoint
  ttsProfiles: TtsProfile[]
  activeTtsId: string
  video: VideoEndpoint
  videos: VideoProfile[]
  activeVideoId: string
  music: ServiceEndpoint
  musics: NamedEndpoint[]
  activeMusicId: string
}

export const LLM_PRESETS = [
  'deepseek-v4-flash',
  'deepseek-chat',
  'deepseek-reasoner'
]

export const VISION_PRESETS = ['qwen-vl-max', 'qwen-vl-plus', 'gpt-4o']

export const IMAGE_PRESETS = [
  'doubao-seedream-4-0-250828',
  'gpt-image-1',
  'dall-e-3',
  'qwen-image-plus'
]

export const TTS_PRESETS = ['qwen-audio-3.0-tts-flash', 'qwen3-tts-flash']

export const MUSIC_PRESETS = ['music-3.0']

function uniq(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

export function uniqueProfileName(existing: string[], base: string): string {
  const names = new Set(existing)
  if (!names.has(base)) return base
  let i = 2
  while (names.has(`${base} ${i}`)) i += 1
  return `${base} ${i}`
}

export function endpointReady(ep?: {
  baseUrl?: string
  apiKey?: string
  model?: string
  workflowId?: string
  adapter?: AdapterConfig
  provider?: string
}) {
  if (!ep) return false
  const adapterType = ep.adapter?.type
  const localComfy =
    adapterType === 'comfyui-prompt' ||
    (/localhost|127\.0\.0\.1/i.test(ep.baseUrl || '') && ep.provider === 'custom')
  const hasEndpoint = Boolean(ep.baseUrl?.trim() && (ep.apiKey?.trim() || localComfy))
  const hasModel = Boolean(ep.model?.trim() || ep.workflowId?.trim() || adapterType === 'comfyui-prompt')
  return hasEndpoint && hasModel
}

export function isLlmConfigured(cfg: AppSettings) {
  return endpointReady(cfg.llm)
}

/** 每个接入下可切换的模型名，给智能体 / 写剧本下拉用 */
export function namedModelGroups(list: NamedEndpoint[] | TtsProfile[]) {
  return (list ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    models: uniq([p.model, ...(p.models ?? [])])
  }))
}

export function llmModelGroups(llms: LlmProfile[]) {
  return namedModelGroups(llms)
}

export function llmChoiceKey(profileId: string, model: string) {
  return `${profileId}::${model}`
}

export function parseLlmChoiceKey(key: string): { profileId: string; model: string } | null {
  const i = key.indexOf('::')
  if (i <= 0) return null
  return { profileId: key.slice(0, i), model: key.slice(i + 2) }
}

function newId(prefix = 'cfg') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function asEndpoint(ep: ServiceEndpoint): ServiceEndpoint {
  return {
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: ep.model,
    models: uniq(ep.models ?? []),
    provider: ep.provider,
    adapter: ep.adapter
  }
}

function asTts(ep: TtsEndpoint): TtsEndpoint {
  return {
    ...asEndpoint(ep),
    voice: ep.voice || 'longanhuan_v3.6'
  }
}

function asVideo(ep: VideoEndpoint): VideoEndpoint {
  return {
    baseUrl: (ep.baseUrl || '').trim(),
    apiKey: ep.apiKey || '',
    workflowId: (ep.workflowId || '').trim(),
    promptStyle: ep.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative',
    provider: ep.provider,
    stillMode: stillModeForVideoModel('h3', ep),
    adapter: ep.adapter
  }
}

function profileFromEndpoint(ep: ServiceEndpoint, name: string, id?: string): NamedEndpoint {
  return {
    id: id || newId('svc'),
    name,
    ...asEndpoint(ep)
  }
}

function ttsFromEndpoint(ep: TtsEndpoint, name: string, id?: string): TtsProfile {
  return {
    id: id || newId('tts'),
    name,
    ...asTts(ep)
  }
}

function videoFromEndpoint(ep: VideoEndpoint, name: string, id?: string): VideoProfile {
  return {
    id: id || newId('vid'),
    name,
    ...asVideo(ep)
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

function hydrateNamed(
  saved: unknown,
  fallback: ServiceEndpoint,
  defaultName: string,
  savedActiveId?: string,
  prefix = 'svc'
): { list: NamedEndpoint[]; activeId: string; active: ServiceEndpoint } {
  const savedList = Array.isArray(saved)
    ? saved.filter((p): p is NamedEndpoint => Boolean(p && p.id && p.name))
    : []
  const list = savedList.length
    ? savedList.map((p) =>
        profileFromEndpoint(
          {
            ...fallback,
            ...p,
            models: uniq([...(p.models ?? []), ...(p.model ? [p.model] : [])])
          },
          p.name,
          p.id
        )
      )
    : [profileFromEndpoint(fallback, defaultName, newId(prefix))]
  const activeId = list.some((p) => p.id === savedActiveId) ? (savedActiveId as string) : list[0].id
  const active = list.find((p) => p.id === activeId) || list[0]
  return { list, activeId: active.id, active: asEndpoint(active) }
}

function hydrateTts(
  saved: unknown,
  fallback: TtsEndpoint,
  savedActiveId?: string
): { list: TtsProfile[]; activeId: string; active: TtsEndpoint } {
  const savedList = Array.isArray(saved)
    ? saved.filter((p): p is TtsProfile => Boolean(p && p.id && p.name))
    : []
  const list = savedList.length
    ? savedList.map((p) =>
        ttsFromEndpoint(
          {
            ...fallback,
            ...p,
            models: uniq([...(p.models ?? []), ...(p.model ? [p.model] : [])])
          },
          p.name,
          p.id
        )
      )
    : [ttsFromEndpoint(fallback, '默认配音')]
  const activeId = list.some((p) => p.id === savedActiveId) ? (savedActiveId as string) : list[0].id
  const active = list.find((p) => p.id === activeId) || list[0]
  return { list, activeId: active.id, active: asTts(active) }
}

function hydrateVideo(
  saved: unknown,
  fallback: VideoEndpoint,
  savedActiveId?: string
): { list: VideoProfile[]; activeId: string; active: VideoEndpoint } {
  const savedList = Array.isArray(saved)
    ? saved.filter((p): p is VideoProfile => Boolean(p && p.id && p.name))
    : []
  const list = savedList.length
    ? savedList.map((p) => videoFromEndpoint({ ...fallback, ...p }, p.name, p.id))
    : [videoFromEndpoint(fallback, '默认视频')]
  const activeId = list.some((p) => p.id === savedActiveId) ? (savedActiveId as string) : list[0].id
  const active = list.find((p) => p.id === activeId) || list[0]
  return { list, activeId: active.id, active: asVideo(active) }
}

function buildDefaults(): AppSettings {
  const env = envDefaults()
  const llm = endpoint(env.llm.baseUrl, env.llm.apiKey, env.llm.model, LLM_PRESETS)
  const first = profileFromEndpoint(llm, '默认 LLM', newId('llm'))
  const vision = endpoint(env.vision.baseUrl, env.vision.apiKey, env.vision.model, VISION_PRESETS)
  const visionFirst = profileFromEndpoint(vision, '默认视觉', newId('vis'))
  const image = endpoint(env.image.baseUrl, env.image.apiKey, env.image.model, IMAGE_PRESETS)
  const imageFirst = profileFromEndpoint(image, '默认生图', newId('img'))
  const tts: TtsEndpoint = {
    ...endpoint(env.tts.baseUrl, env.tts.apiKey, env.tts.model, TTS_PRESETS),
    voice: env.tts.voice
  }
  const ttsFirst = ttsFromEndpoint(tts, '默认配音')
  const video: VideoEndpoint = {
    baseUrl: env.video.baseUrl,
    apiKey: env.video.apiKey,
    workflowId: env.video.workflowId,
    promptStyle: 'scene-narrative',
    stillMode: 'identity'
  }
  const videoFirst = videoFromEndpoint(video, '默认视频')
  const music = endpoint(env.music.baseUrl, env.music.apiKey, env.music.model, MUSIC_PRESETS)
  const musicFirst = profileFromEndpoint(music, '默认配乐', newId('mus'))
  return {
    theme: 'dark',
    aiMode: 'real',
    debug: false,
    defaultAspectRatio: '16:9',
    autoSaveInterval: 0,
    llm: asEndpoint(first),
    llms: [first],
    activeLlmId: first.id,
    vision: asEndpoint(visionFirst),
    visions: [visionFirst],
    activeVisionId: visionFirst.id,
    image: asEndpoint(imageFirst),
    images: [imageFirst],
    activeImageId: imageFirst.id,
    tts: asTts(ttsFirst),
    ttsProfiles: [ttsFirst],
    activeTtsId: ttsFirst.id,
    video: asVideo(videoFirst),
    videos: [videoFirst],
    activeVideoId: videoFirst.id,
    music: asEndpoint(musicFirst),
    musics: [musicFirst],
    activeMusicId: musicFirst.id
  }
}

function parseSettings(raw: string | null): AppSettings {
  const defaults = buildDefaults()
  if (!raw) return defaults
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    const savedLlm = parsed.llm
    const legacyQwenPrimary = /^qwen/i.test(savedLlm?.model ?? '')
    const llmSnap = legacyQwenPrimary
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
    const visionSnap = {
      ...defaults.vision,
      ...savedVision,
      model: legacyTextOnlyVision ? defaults.vision.model : (savedVision?.model || defaults.vision.model),
      models: uniq([...(savedVision?.models ?? []), ...defaults.vision.models]).filter(
        (model) => !/^(qwen3\.7|qwen-vl-)/i.test(model)
      )
    }
    const llm = hydrateNamed(parsed.llms, llmSnap, '默认 LLM', parsed.activeLlmId, 'llm')
    const vision = hydrateNamed(parsed.visions, visionSnap, '默认视觉', parsed.activeVisionId, 'vis')
    const image = hydrateNamed(
      parsed.images,
      {
        ...defaults.image,
        ...parsed.image,
        models: uniq([...(parsed.image?.models ?? []), ...defaults.image.models])
      },
      '默认生图',
      parsed.activeImageId,
      'img'
    )
    const tts = hydrateTts(
      parsed.ttsProfiles,
      {
        ...defaults.tts,
        ...parsed.tts,
        models: uniq([...(parsed.tts?.models ?? []), ...defaults.tts.models])
      },
      parsed.activeTtsId
    )
    const video = hydrateVideo(
      parsed.videos,
      {
        ...defaults.video,
        ...parsed.video,
        baseUrl: migrateVideoBaseUrl(parsed.video?.baseUrl || defaults.video.baseUrl),
        apiKey: parsed.video?.apiKey || defaults.video.apiKey,
        workflowId: migrateVideoWorkflowId(parsed.video?.workflowId || defaults.video.workflowId),
        promptStyle:
          parsed.video?.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative',
        stillMode: stillModeForVideoModel('h3', {
          stillMode: parsed.video?.stillMode,
          workflowId: parsed.video?.workflowId,
          provider: parsed.video?.provider
        })
      },
      parsed.activeVideoId
    )
    const music = hydrateNamed(
      parsed.musics,
      {
        ...defaults.music,
        ...parsed.music,
        models: uniq([...(parsed.music?.models ?? []), ...defaults.music.models])
      },
      '默认配乐',
      parsed.activeMusicId,
      'mus'
    )

    return {
      ...defaults,
      ...parsed,
      theme: 'dark',
      aiMode: 'real',
      llm: llm.active,
      llms: llm.list,
      activeLlmId: llm.activeId,
      vision: vision.active,
      visions: vision.list,
      activeVisionId: vision.activeId,
      image: image.active,
      images: image.list,
      activeImageId: image.activeId,
      tts: tts.active,
      ttsProfiles: tts.list,
      activeTtsId: tts.activeId,
      video: video.active,
      videos: video.list,
      activeVideoId: video.activeId,
      music: music.active,
      musics: music.list,
      activeMusicId: music.activeId
    }
  } catch {
    return defaults
  }
}

function loadFromLocal(): AppSettings {
  try {
    return parseSettings(localStorage.getItem(STORAGE_KEY))
  } catch {
    return buildDefaults()
  }
}

function writeLocal(v: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
  } catch {
    /* quota / private mode */
  }
}

async function settingsFilePath(): Promise<string> {
  const api = desktop()
  return api.join(await api.getRoot(), LEGACY_SETTINGS_FILE)
}

let writeChain: Promise<void> = Promise.resolve()
let queued: AppSettings | null = null

async function persistToDisk(v: AppSettings) {
  if (!isDesktop()) return
  const api = desktop()
  if (typeof api.kvSet === 'function') {
    await api.kvSet(SETTINGS_KV_KEY, JSON.stringify(v))
  } else {
    const file = await settingsFilePath()
    await api.writeText(file, JSON.stringify(v, null, 2))
  }
}

function writeDisk(v: AppSettings) {
  queued = v
  writeChain = writeChain.catch(() => {}).then(async () => {
    if (!queued) return
    try {
      while (queued) {
        const snap = queued
        queued = null
        await persistToDisk(snap)
      }
    } catch (e) {
      console.warn('[settings] 写入本地库失败', e)
      throw e
    }
  })
  return writeChain
}

export const useSettingsStore = defineStore('settings', () => {
  const config = ref<AppSettings>(loadFromLocal())
  const persistPath = ref('')
  const diskReady = ref(false)
  const lastSavedAt = ref(0)
  let skipDisk = false
  let hydratePromise: Promise<void> | null = null
  let pendingDisk: AppSettings | null = null
  let userEdited = false

  function touch() {
    userEdited = true
  }

  watch(
    config,
    (v) => {
      writeLocal(v)
      if (skipDisk) return
      if (!diskReady.value) {
        pendingDisk = v
        return
      }
      void writeDisk(v).then(() => {
        lastSavedAt.value = Date.now()
      }).catch(() => {})
    },
    { deep: true }
  )

  async function ensureHydrated() {
    if (diskReady.value) return
    if (hydratePromise) return hydratePromise
    hydratePromise = (async () => {
      if (!isDesktop()) {
        diskReady.value = true
        return
      }
      try {
        const api = desktop()
        persistPath.value = typeof api.dbPath === 'function' ? await api.dbPath() : await settingsFilePath()
        let raw: string | null = null
        if (typeof api.kvGet === 'function') raw = await api.kvGet(SETTINGS_KV_KEY)
        if (!raw) {
          const file = await settingsFilePath()
          if (await api.exists(file)) raw = await api.readText(file)
        }
        if (raw) {
          skipDisk = true
          if (!userEdited) {
            config.value = parseSettings(raw)
            writeLocal(config.value)
          }
          skipDisk = false
          await writeDisk(config.value)
          lastSavedAt.value = Date.now()
        } else {
          await writeDisk(config.value)
          lastSavedAt.value = Date.now()
        }
      } catch (e) {
        console.warn('[settings] 读取本地库失败', e)
      } finally {
        diskReady.value = true
        const extra = pendingDisk
        pendingDisk = null
        if (extra) await writeDisk(extra)
      }
    })().finally(() => {
      hydratePromise = null
    })
    return hydratePromise
  }

  void ensureHydrated()

  if (typeof window !== 'undefined') {
    const flushOnLeave = () => {
      writeLocal(config.value)
      if (diskReady.value) void writeDisk(config.value)
    }
    window.addEventListener('beforeunload', flushOnLeave)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnLeave()
    })
  }

  async function flush() {
    writeLocal(config.value)
    await writeDisk(config.value)
    lastSavedAt.value = Date.now()
  }

  function update(patch: Partial<AppSettings>) {
    touch()
    config.value = { ...config.value, ...patch }
  }

  function syncLlm(next: LlmProfile, list?: LlmProfile[]) {
    touch()
    const llms = (list ?? config.value.llms).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, llms, activeLlmId: next.id, llm: asEndpoint(next) }
  }

  function syncVision(next: NamedEndpoint, list?: NamedEndpoint[]) {
    touch()
    const visions = (list ?? config.value.visions).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, visions, activeVisionId: next.id, vision: asEndpoint(next) }
  }

  function syncImage(next: NamedEndpoint, list?: NamedEndpoint[]) {
    touch()
    const images = (list ?? config.value.images).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, images, activeImageId: next.id, image: asEndpoint(next) }
  }

  function syncTts(next: TtsProfile, list?: TtsProfile[]) {
    touch()
    const ttsProfiles = (list ?? config.value.ttsProfiles).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, ttsProfiles, activeTtsId: next.id, tts: asTts(next) }
  }

  function syncVideo(next: VideoProfile, list?: VideoProfile[]) {
    touch()
    const videos = (list ?? config.value.videos).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, videos, activeVideoId: next.id, video: asVideo(next) }
  }

  function syncMusic(next: NamedEndpoint, list?: NamedEndpoint[]) {
    touch()
    const musics = (list ?? config.value.musics).map((p) => (p.id === next.id ? next : p))
    config.value = { ...config.value, musics, activeMusicId: next.id, music: asEndpoint(next) }
  }

  function patchLlm(patch: Partial<LlmProfile>) {
    const id = config.value.activeLlmId
    const cur =
      config.value.llms.find((p) => p.id === id) || profileFromEndpoint(config.value.llm, '默认 LLM', id)
    syncLlm({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addLlm(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    adapter?: AdapterConfig
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        adapter: seed.adapter
      },
      seed.name
    )
    syncLlm(profile, [...config.value.llms, profile])
    return profile.id
  }

  function selectLlm(id: string) {
    const profile = config.value.llms.find((p) => p.id === id)
    if (profile) syncLlm(profile)
  }

  function selectLlmModel(profileId: string, model: string) {
    const profile = config.value.llms.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncLlm({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeLlm(id: string) {
    if (config.value.llms.length <= 1) return
    const llms = config.value.llms.filter((p) => p.id !== id)
    const next = llms.find((p) => p.id === config.value.activeLlmId) || llms[0]
    syncLlm(next, llms)
  }

  function renameLlm(name: string) {
    const n = name.trim()
    if (!n) return
    patchLlm({ name: n })
  }

  function patchVision(patch: Partial<NamedEndpoint>) {
    const id = config.value.activeVisionId
    const cur =
      config.value.visions.find((p) => p.id === id) ||
      profileFromEndpoint(config.value.vision, '默认视觉', id)
    syncVision({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addVision(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    adapter?: AdapterConfig
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        adapter: seed.adapter
      },
      seed.name
    )
    syncVision(profile, [...config.value.visions, profile])
    return profile.id
  }

  function selectVision(id: string) {
    const profile = config.value.visions.find((p) => p.id === id)
    if (profile) syncVision(profile)
  }

  function selectVisionModel(profileId: string, model: string) {
    const profile = config.value.visions.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncVision({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeVision(id: string) {
    if (config.value.visions.length <= 1) return
    const visions = config.value.visions.filter((p) => p.id !== id)
    const next = visions.find((p) => p.id === config.value.activeVisionId) || visions[0]
    syncVision(next, visions)
  }

  function renameVision(name: string) {
    const n = name.trim()
    if (!n) return
    patchVision({ name: n })
  }

  function patchImage(patch: Partial<NamedEndpoint>) {
    const id = config.value.activeImageId
    const cur =
      config.value.images.find((p) => p.id === id) ||
      profileFromEndpoint(config.value.image, '默认生图', id)
    syncImage({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addImage(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    adapter?: AdapterConfig
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        adapter: seed.adapter
      },
      seed.name
    )
    syncImage(profile, [...config.value.images, profile])
    return profile.id
  }

  function selectImage(id: string) {
    const profile = config.value.images.find((p) => p.id === id)
    if (profile) syncImage(profile)
  }

  function selectImageModel(profileId: string, model: string) {
    const profile = config.value.images.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncImage({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeImage(id: string) {
    if (config.value.images.length <= 1) return
    const images = config.value.images.filter((p) => p.id !== id)
    const next = images.find((p) => p.id === config.value.activeImageId) || images[0]
    syncImage(next, images)
  }

  function renameImage(name: string) {
    const n = name.trim()
    if (!n) return
    patchImage({ name: n })
  }

  function patchTts(patch: Partial<TtsProfile>) {
    const id = config.value.activeTtsId
    const cur =
      config.value.ttsProfiles.find((p) => p.id === id) || ttsFromEndpoint(config.value.tts, '默认配音', id)
    syncTts({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addTts(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    voice?: string
    adapter?: AdapterConfig
  }) {
    const profile = ttsFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        voice: seed.voice || config.value.tts.voice || 'longanhuan_v3.6',
        adapter: seed.adapter
      },
      seed.name
    )
    syncTts(profile, [...config.value.ttsProfiles, profile])
    return profile.id
  }

  function selectTts(id: string) {
    const profile = config.value.ttsProfiles.find((p) => p.id === id)
    if (profile) syncTts(profile)
  }

  function selectTtsModel(profileId: string, model: string) {
    const profile = config.value.ttsProfiles.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncTts({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeTts(id: string) {
    if (config.value.ttsProfiles.length <= 1) return
    const ttsProfiles = config.value.ttsProfiles.filter((p) => p.id !== id)
    const next = ttsProfiles.find((p) => p.id === config.value.activeTtsId) || ttsProfiles[0]
    syncTts(next, ttsProfiles)
  }

  function renameTts(name: string) {
    const n = name.trim()
    if (!n) return
    patchTts({ name: n })
  }

  function patchVideo(patch: Partial<VideoProfile>) {
    const id = config.value.activeVideoId
    const cur =
      config.value.videos.find((p) => p.id === id) || videoFromEndpoint(config.value.video, '默认视频', id)
    syncVideo({ ...cur, ...patch })
  }

  function addVideo(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    workflowId: string
    promptStyle?: VideoPromptStyle
    provider?: string
    stillMode?: VideoStillMode
    adapter?: AdapterConfig
  }) {
    const profile = videoFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        workflowId: seed.workflowId,
        promptStyle: seed.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative',
        provider: seed.provider,
        stillMode: stillModeForVideoModel('h3', seed),
        adapter: seed.adapter
      },
      seed.name
    )
    syncVideo(profile, [...config.value.videos, profile])
    return profile.id
  }

  function selectVideo(id: string) {
    const profile = config.value.videos.find((p) => p.id === id)
    if (profile) syncVideo(profile)
  }

  function removeVideo(id: string) {
    if (config.value.videos.length <= 1) return
    const videos = config.value.videos.filter((p) => p.id !== id)
    const next = videos.find((p) => p.id === config.value.activeVideoId) || videos[0]
    syncVideo(next, videos)
  }

  function renameVideo(name: string) {
    const n = name.trim()
    if (!n) return
    patchVideo({ name: n })
  }

  function patchMusic(patch: Partial<NamedEndpoint>) {
    const id = config.value.activeMusicId
    const cur =
      config.value.musics.find((p) => p.id === id) ||
      profileFromEndpoint(config.value.music, '默认配乐', id)
    syncMusic({ ...cur, ...patch, models: uniq(patch.models ?? cur.models) })
  }

  function addMusic(seed: {
    name: string
    baseUrl: string
    apiKey?: string
    model: string
    models: string[]
    provider?: string
    adapter?: AdapterConfig
  }) {
    const profile = profileFromEndpoint(
      {
        baseUrl: seed.baseUrl,
        apiKey: seed.apiKey ?? '',
        model: seed.model,
        models: seed.models,
        provider: seed.provider,
        adapter: seed.adapter
      },
      seed.name
    )
    syncMusic(profile, [...config.value.musics, profile])
    return profile.id
  }

  function selectMusic(id: string) {
    const profile = config.value.musics.find((p) => p.id === id)
    if (profile) syncMusic(profile)
  }

  function selectMusicModel(profileId: string, model: string) {
    const profile = config.value.musics.find((p) => p.id === profileId)
    const name = model.trim()
    if (!profile || !name) return
    syncMusic({
      ...profile,
      model: name,
      models: uniq([...(profile.models ?? []), name, profile.model])
    })
  }

  function removeMusic(id: string) {
    if (config.value.musics.length <= 1) return
    const musics = config.value.musics.filter((p) => p.id !== id)
    const next = musics.find((p) => p.id === config.value.activeMusicId) || musics[0]
    syncMusic(next, musics)
  }

  function renameMusic(name: string) {
    const n = name.trim()
    if (!n) return
    patchMusic({ name: n })
  }

  function addModel(kind: 'llm' | 'vision' | 'image' | 'tts' | 'music', name: string) {
    const n = name.trim()
    if (!n) return
    if (kind === 'llm') {
      patchLlm({ models: uniq([...config.value.llm.models, n]), model: n })
      return
    }
    if (kind === 'vision') {
      patchVision({ models: uniq([...config.value.vision.models, n]), model: n })
      return
    }
    if (kind === 'image') {
      patchImage({ models: uniq([...config.value.image.models, n]), model: n })
      return
    }
    if (kind === 'tts') {
      patchTts({ models: uniq([...config.value.tts.models, n]), model: n })
      return
    }
    patchMusic({ models: uniq([...config.value.music.models, n]), model: n })
  }

  function removeModel(kind: 'llm' | 'vision' | 'image' | 'tts' | 'music', name: string) {
    const drop = (models: string[], current: string) => {
      const next = models.filter((m) => m !== name)
      if (!next.length) return null
      return { models: next, model: current === name ? next[0] : current }
    }
    if (kind === 'llm') {
      const next = drop(config.value.llm.models, config.value.llm.model)
      if (next) patchLlm(next)
      return
    }
    if (kind === 'vision') {
      const next = drop(config.value.vision.models, config.value.vision.model)
      if (next) patchVision(next)
      return
    }
    if (kind === 'image') {
      const next = drop(config.value.image.models, config.value.image.model)
      if (next) patchImage(next)
      return
    }
    if (kind === 'tts') {
      const next = drop(config.value.tts.models, config.value.tts.model)
      if (next) patchTts(next)
      return
    }
    const next = drop(config.value.music.models, config.value.music.model)
    if (next) patchMusic(next)
  }

  return {
    config,
    persistPath,
    diskReady,
    lastSavedAt,
    ensureHydrated,
    flush,
    update,
    patchLlm,
    addLlm,
    selectLlm,
    selectLlmModel,
    removeLlm,
    renameLlm,
    patchVision,
    addVision,
    selectVision,
    selectVisionModel,
    removeVision,
    renameVision,
    patchImage,
    addImage,
    selectImage,
    selectImageModel,
    removeImage,
    renameImage,
    patchTts,
    addTts,
    selectTts,
    selectTtsModel,
    removeTts,
    renameTts,
    patchVideo,
    addVideo,
    selectVideo,
    removeVideo,
    renameVideo,
    patchMusic,
    addMusic,
    selectMusic,
    selectMusicModel,
    removeMusic,
    renameMusic,
    addModel,
    removeModel
  }
})
