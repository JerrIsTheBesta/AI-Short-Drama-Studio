<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface NoticePayload {
  enabled?: boolean
  title?: string
  body?: string
  updatedAt?: string
}

const STORAGE_PREFIX = 'ai-cut:notice-dismissed:'

const visible = ref(false)
const title = ref('')
const body = ref('')
const updatedAt = ref('')

onMounted(async () => {
  try {
    const res = await fetch(`/notice.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return
    const data = (await res.json()) as NoticePayload
    if (!data?.enabled) return
    const stamp = String(data.updatedAt || data.title || data.body || '').trim()
    if (!stamp) return
    if (localStorage.getItem(STORAGE_PREFIX + stamp) === '1') return
    title.value = String(data.title || '公告').trim()
    body.value = String(data.body || '').trim()
    updatedAt.value = stamp
    visible.value = Boolean(title.value || body.value)
  } catch {
    /* 公告文件缺失时静默 */
  }
})

function dismiss() {
  if (updatedAt.value) {
    localStorage.setItem(STORAGE_PREFIX + updatedAt.value, '1')
  }
  visible.value = false
}
</script>

<template>
  <div v-if="visible" class="notice-banner" role="status">
    <div class="notice-inner">
      <div class="notice-text">
        <strong class="notice-title">{{ title }}</strong>
        <p v-if="body" class="notice-body">{{ body }}</p>
      </div>
      <button type="button" class="notice-close" title="关闭" aria-label="关闭公告" @click="dismiss">
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.notice-banner {
  position: relative;
  z-index: 40;
  flex-shrink: 0;
  background: linear-gradient(90deg, rgba(99, 102, 241, 0.22), rgba(14, 165, 233, 0.18));
  border-bottom: 1px solid rgba(148, 163, 184, 0.25);
  backdrop-filter: blur(8px);
}
.notice-inner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  max-width: 1100px;
  margin: 0 auto;
  padding: 10px 16px;
}
.notice-text {
  flex: 1;
  min-width: 0;
}
.notice-title {
  color: #e2e8f0;
  font-size: 13px;
  font-weight: 650;
}
.notice-body {
  margin: 4px 0 0;
  color: #cbd5e1;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}
.notice-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.35);
  color: #e2e8f0;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.notice-close:hover {
  background: rgba(15, 23, 42, 0.55);
}
</style>
