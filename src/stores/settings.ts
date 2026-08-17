/**
 * 全局应用设置（AI mode、UI 偏好等）
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const STORAGE_KEY = 'ai-cut:settings'

export interface AppSettings {
  /** UI 主题 */
  theme: 'dark' | 'light'
  /** AI 模式 */
  aiMode: 'mock' | 'real'
  /** 是否显示调试信息 */
  debug: boolean
  /** 默认视频比例 */
  defaultAspectRatio: string
  /** 自动保存间隔（秒，0 = 仅手动） */
  autoSaveInterval: number
}

const defaults: AppSettings = {
  theme: 'dark',
  aiMode: 'mock',
  debug: false,
  defaultAspectRatio: '16:9',
  autoSaveInterval: 0
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaults }
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return { ...defaults }
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

  return { config, update }
})
