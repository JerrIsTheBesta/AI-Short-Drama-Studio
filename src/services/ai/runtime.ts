/**
 * 运行时 AI 配置：设置页保存值优先，缺省回落到 .env
 */

import { useSettingsStore } from '@/stores'
import { envDefaults, migrateVideoBaseUrl, migrateVideoWorkflowId } from './env'
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
    model: s?.model || d.model
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
    model: /^(qwen3\.7|qwen-vl-)/i.test(selectedModel) ? 'qwen3-vl-plus' : selectedModel
  }
}

export function getImageConfig() {
  const d = envDefaults().image
  const s = pick()?.image
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    model: s?.model || d.model
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

export function getVideoConfig() {
  const d = envDefaults().video
  const s = pick()?.video
  return {
    baseUrl: migrateVideoBaseUrl(s?.baseUrl || d.baseUrl),
    apiKey: s?.apiKey || d.apiKey,
    workflowId: migrateVideoWorkflowId(s?.workflowId || d.workflowId),
    promptStyle: getVideoPromptStyle()
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
