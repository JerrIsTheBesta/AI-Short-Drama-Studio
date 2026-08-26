<script setup lang="ts">
import { normalizeVideoGenModel, type VideoGenModel } from '@/types'

const props = withDefaults(
  defineProps<{
    modelValue?: VideoGenModel | string
    label?: string
  }>(),
  { label: '模型' }
)

const emit = defineEmits<{ 'update:modelValue': [value: VideoGenModel] }>()

const options: { id: VideoGenModel; label: string }[] = [
  { id: 'h3', label: 'H3' },
  { id: 'wan-prime', label: '万相 3.0 Prime' }
]

function onChange(event: Event) {
  emit('update:modelValue', normalizeVideoGenModel((event.target as HTMLSelectElement).value))
}
</script>

<template>
  <label class="vid-model">
    <span>{{ label }}</span>
    <select :value="normalizeVideoGenModel(props.modelValue)" @change="onChange">
      <option v-for="m in options" :key="m.id" :value="m.id">{{ m.label }}</option>
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
  border-radius: 8px;
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
