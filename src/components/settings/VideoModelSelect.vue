<script setup lang="ts">
import { computed } from 'vue'
import { normalizeVideoGenModel, stillModeForVideoModel, type VideoGenModel } from '@/types'
import { useSettingsStore } from '@/stores'

const props = withDefaults(
  defineProps<{
    modelValue?: VideoGenModel | string
    label?: string
  }>(),
  { label: '模型' }
)

const emit = defineEmits<{ 'update:modelValue': [value: VideoGenModel] }>()
const settings = useSettingsStore()

const value = computed(() => {
  const m = normalizeVideoGenModel(props.modelValue)
  if (m === 'wan-prime' || m === 'h3-v5') return m
  return settings.config.activeVideoId || 'h3'
})

function onChange(event: Event) {
  const v = (event.target as HTMLSelectElement).value
  if (v === 'wan-prime' || v === 'h3-v5' || v === 'h3') {
    emit('update:modelValue', v)
    return
  }
  settings.selectVideo(v)
  emit('update:modelValue', 'h3')
}
</script>

<template>
  <label class="vid-model">
    <span>{{ label }}</span>
    <select :value="value" @change="onChange">
      <optgroup v-if="settings.config.videos.length" label="已配置的视频接入">
        <option v-for="p in settings.config.videos" :key="p.id" :value="p.id">
          {{ p.name }}{{ stillModeForVideoModel('h3', p) === 'keyframe' ? ' · 关键帧' : stillModeForVideoModel('h3', p) === 'storyboard' ? ' · 看板' : '' }}
        </option>
      </optgroup>
      <optgroup label="工作流（用设置里的 AutoDL 令牌）">
        <option value="h3">
          H3 v5 · 15秒{{ stillModeForVideoModel('h3', settings.config.video) === 'keyframe' ? '（需关键帧）' : stillModeForVideoModel('h3', settings.config.video) === 'storyboard' ? '（需看板）' : '（人设+场景）' }}
        </option>
        <option value="h3-v5">H3 v5 · 10秒 1080p（人设+场景）</option>
        <option value="wan-prime">万相 3.0 Prime（需关键帧）</option>
      </optgroup>
    </select>
  </label>
</template>

<style scoped>
.vid-model {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 240px;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.vid-model span {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-4);
}
.vid-model select {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 26px 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background-color: var(--color-bg-2);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%23f5f5fa' d='M1.2 1.2L6 6l4.8-4.8' stroke='%23f5f5fa' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
  color: var(--color-text-1);
  font-size: 11px;
  appearance: none;
  outline: none;
  cursor: pointer;
}
</style>
