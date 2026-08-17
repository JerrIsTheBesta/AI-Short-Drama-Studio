/**
 * 运行时 AI 配置：画布右侧面板优先，缺省回落到 .env
 */

import { useSettingsStore } from '@/stores'
import { envDefaults, envRealMode } from './env'
import type { AIMode } from '@/stores/settings'

function pick() {
  try {
    return useSettingsStore().config
  } catch {
    return null
  }
}

export function getAIMode(): AIMode {
  const cfg = pick()
  if (cfg?.aiMode === 'real' || cfg?.aiMode === 'mock') return cfg.aiMode
  return envRealMode() ? 'real' : 'mock'
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

export function getVideoConfig() {
  const d = envDefaults().video
  const s = pick()?.video
  return {
    baseUrl: (s?.baseUrl || d.baseUrl).replace(/\/+$/, ''),
    apiKey: s?.apiKey || d.apiKey,
    workflowId: s?.workflowId || d.workflowId
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
