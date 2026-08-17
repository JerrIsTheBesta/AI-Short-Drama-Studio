/**
 * 全局 toast / 通知
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
  duration: number
}

let _id = 0

export const useToastStore = defineStore('toast', () => {
  const items = ref<Toast[]>([])

  function push(message: string, kind: ToastKind = 'info', duration = 3000) {
    const id = ++_id
    items.value.push({ id, kind, message, duration })
    if (duration > 0) {
      setTimeout(() => {
        items.value = items.value.filter((t) => t.id !== id)
      }, duration)
    }
    return id
  }

  function dismiss(id: number) {
    items.value = items.value.filter((t) => t.id !== id)
  }

  return {
    items,
    push,
    dismiss,
    info: (m: string, d?: number) => push(m, 'info', d),
    success: (m: string, d?: number) => push(m, 'success', d),
    warn: (m: string, d?: number) => push(m, 'warning', d),
    error: (m: string, d?: number) => push(m, 'error', d)
  }
})
