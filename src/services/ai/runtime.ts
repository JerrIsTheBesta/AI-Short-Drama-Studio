/**
 * 运行时 AI 配置：设置页保存值优先，缺省回落到 .env
 */

import { useSettingsStore } from '@/stores'
import { isAutodlHost, normalizeStoredVideoEndpoint } from './adapters'
import { envDefaults, migrateVideoBaseUrl, migrateVideoWorkflowId } from './env'
import { zealmanWorkflowById } from './zealman'
import type { AIMode } from '@/stores/settings'
import type { VideoPromptStyle } from '@/utils/shotPrompt'

function pick() {
  try {
    return useSettingsStore().config
  } catch {
    return null
  }
}

export function getAIMode(): AIMode {
  return 'real'
}

export function getLlmConfig() {
  const d = envDefaults().llm
  const s = pick()?.llm
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model,
    adapter: s?.adapter,
    provider: s?.provider
  }
}

export function getVisionConfig() {
  const d = envDefaults().vision
  const s = pick()?.vision
  const selectedModel = s?.model || d.model
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    // 旧视觉配置自动迁移到项目指定的 Qwen3-VL。
    model: /^(qwen3\.7|qwen-vl-)/i.test(selectedModel) ? 'qwen3-vl-plus' : selectedModel,
    adapter: s?.adapter,
    provider: s?.provider
  }
}

export function getImageConfig() {
  const d = envDefaults().image
  const s = pick()?.image
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model,
    adapter: s?.adapter,
    provider: s?.provider,
    options: s?.options
  }
}

export function getTtsConfig() {
  const d = envDefaults().tts
  const s = pick()?.tts
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model,
    voice: s?.voice || d.voice
  }
}

export function getVideoPromptStyle(): VideoPromptStyle {
  return pick()?.video?.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative'
}

/** 内置 H3 要用 AutoDL 令牌。当前项若是 Zealman，不能拿来冒充 AutoDL。 */
export function autodlVideoProfileId(): string | undefined {
  const settings = pick()
  const list = (settings?.videos || []).filter((profile) => {
    const normalized = normalizeStoredVideoEndpoint(profile)
    if (normalized.provider === 'zealman') return false
    if (normalized.adapter?.type === 'zealman-workflow' && zealmanWorkflowById(normalized.workflowId || '')) return false
    return normalized.provider === 'autodl' || isAutodlHost(normalized.baseUrl || '')
  })
  const active = list.find((profile) => profile.id === settings?.activeVideoId)
  return (active || list[0])?.id
}

function isAutodlVideoProfile(profile: { provider?: string; baseUrl?: string }): boolean {
  return profile.provider === 'autodl' || isAutodlHost(profile.baseUrl || '')
}

/** 非 AutoDL 接入如果存进了 AutoDL 令牌，生成时丢掉，不拿去请求别的供应商。 */
function videoKeyForProfile(
  profile: { id?: string; provider?: string; baseUrl?: string; apiKey?: string } | undefined,
  envKey: string
): string {
  const key = String(profile?.apiKey || '').trim()
  if (!profile) return envKey
  if (isAutodlVideoProfile(profile)) return key || envKey
  const settings = pick()
  const stolen = (settings?.videos || []).some((item) => {
    if (item.id === profile.id) return false
    return isAutodlVideoProfile(item) && String(item.apiKey || '').trim() === key && Boolean(key)
  })
  return stolen ? '' : key
}

export function getVideoConfig(profileId?: string) {
  const d = envDefaults().video
  const settings = pick()
  let s = profileId
    ? settings?.videos?.find((profile) => profile.id === profileId) || settings?.video
    : settings?.video
  if (s) s = normalizeStoredVideoEndpoint(s)
  // 只有这条接入本身就是 Zealman，且工作流 id 也是内置 U 系列时，才允许把误填的 autodl.art 换回镜像地址。
  // 不能因为残留 adapter 就把用户选中的 AutoDL 整份换成 SeetaCloud。
  if (
    s?.provider === 'zealman' &&
    s.adapter?.type === 'zealman-workflow' &&
    zealmanWorkflowById(s.workflowId || '') &&
    isAutodlHost(s.baseUrl || '')
  ) {
    const videos = (settings?.videos || []).map((profile) => normalizeStoredVideoEndpoint(profile))
    s = videos.find(
      (profile) =>
        profile.provider === 'zealman' &&
        profile.workflowId === s?.workflowId &&
        !isAutodlHost(profile.baseUrl || '')
    ) || videos.find(
      (profile) =>
        profile.provider === 'zealman' &&
        Boolean(zealmanWorkflowById(profile.workflowId || '')) &&
        !isAutodlHost(profile.baseUrl || '')
    ) || s
  }
  return {
    baseUrl: migrateVideoBaseUrl(s?.baseUrl || d.baseUrl),
    apiKey: videoKeyForProfile(s, d.apiKey),
    workflowId: migrateVideoWorkflowId(s?.workflowId || d.workflowId),
    promptStyle: getVideoPromptStyle(),
    adapter: s?.adapter,
    provider: s?.provider,
    options: s?.options,
    zealmanBaseUrl: settings?.zealmanBaseUrl || ''
  }
}

export function getMusicConfig() {
  const d = envDefaults().music
  const s = pick()?.music
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model
  }
}

export function getRemakeVisionModel() {
  return envDefaults().remakeVisionModel || 'qwen-vl-max'
}

export function getRemakeImageModel() {
  return envDefaults().remakeImageModel || 'gpt-image-1'
}

/** 出图模型：设置页当前选中的；没配时复刻项目回落到 GPT Image */
export function imageModelForProject(pipelineMode?: string) {
  const selected = pick()?.image?.model?.trim()
  if (selected) return selected
  return pipelineMode === 'remake' ? getRemakeImageModel() : undefined
}
