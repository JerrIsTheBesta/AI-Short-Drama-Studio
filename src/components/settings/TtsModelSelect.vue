<script setup lang="ts">
import { computed } from 'vue'
import { llmChoiceKey, namedModelGroups, parseLlmChoiceKey, useSettingsStore } from '@/stores'

withDefaults(
  defineProps<{
    label?: string
  }>(),
  { label: '配音' }
)

const settings = useSettingsStore()
const groups = computed(() => namedModelGroups(settings.config.ttsProfiles ?? []))

const model = computed({
  get() {
    const id = settings.config.activeTtsId
    const name = settings.config.tts.model
    return id && name ? llmChoiceKey(id, name) : ''
  },
  set(v: string) {
    const parsed = parseLlmChoiceKey(v)
    if (parsed) settings.selectTtsModel(parsed.profileId, parsed.model)
  }
})
</script>

<template>
  <label class="tts-model">
    <span>{{ label }}</span>
    <select v-model="model">
      <option v-if="!groups.some((g) => g.models.length)" value="">请先在设置里添加配音模型</option>
      <optgroup v-for="g in groups" :key="g.id" :label="g.name">
        <option v-for="m in g.models" :key="g.id + m" :value="llmChoiceKey(g.id, m)">{{ m }}</option>
      </optgroup>
    </select>
  </label>
</template>

<style scoped>
.tts-model {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.tts-model span {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-4);
}
.tts-model select {
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
