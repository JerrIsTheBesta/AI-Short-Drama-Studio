<script setup lang="ts">
import type { VideoResolution } from '@/types'

defineProps<{
  modelValue: VideoResolution
  compact?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: VideoResolution] }>()
</script>

<template>
  <label v-if="compact" class="res-compact">
    <span>清晰度</span>
    <select
      :value="modelValue"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value as VideoResolution)"
    >
      <option value="768p">768p</option>
      <option value="1080p">1080p</option>
    </select>
  </label>
  <div v-else class="res-seg">
    <button type="button" :class="{ on: modelValue === '768p' }" @click="emit('update:modelValue', '768p')">
      768p
    </button>
    <button type="button" :class="{ on: modelValue === '1080p' }" @click="emit('update:modelValue', '1080p')">
      1080p
    </button>
  </div>
</template>

<style scoped>
.res-compact {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 10px;
  color: var(--color-text-4);
}
.res-compact select {
  height: 28px;
  padding: 0 22px 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 11px;
}
.res-seg {
  display: flex;
  gap: 6px;
}
.res-seg button {
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-2);
  color: var(--color-text-3);
  font-size: 11px;
}
.res-seg button.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
}
</style>
