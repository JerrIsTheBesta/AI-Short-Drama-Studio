<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@/stores'

withDefaults(
  defineProps<{
    label?: string
  }>(),
  { label: '出图' }
)

const settings = useSettingsStore()

const models = computed(() => {
  const cfg = settings.config.image
  return [...new Set([cfg.model, ...(cfg.models ?? [])].map((m) => m.trim()).filter(Boolean))]
})

const model = computed({
  get() {
    return settings.config.image.model
  },
  set(v: string) {
    if (v) settings.patchImage({ model: v })
  }
})
</script>

<template>
  <label class="img-model">
    <span>{{ label }}</span>
    <select v-model="model">
      <option v-if="!models.length" value="">请先在设置里添加出图模型</option>
      <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
    </select>
  </label>
</template>

<style scoped>
.img-model {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.img-model span {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-4);
}
.img-model select {
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
