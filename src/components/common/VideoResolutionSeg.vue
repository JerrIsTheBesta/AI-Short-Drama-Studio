<script setup lang="ts">
import ParamSelect from '@/components/common/ParamSelect.vue'
import type { VideoResolution } from '@/types'

defineProps<{
  modelValue: VideoResolution
  compact?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: VideoResolution] }>()
</script>

<template>
  <ParamSelect
    v-if="compact"
    label="清晰度"
    width="92px"
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event as VideoResolution)"
  >
    <option value="768p">768p</option>
    <option value="1080p">1080p</option>
  </ParamSelect>
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
