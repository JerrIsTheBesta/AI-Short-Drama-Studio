<script setup lang="ts">
import { computed } from 'vue'
import ParamSelect from '@/components/common/ParamSelect.vue'
import { llmChoiceKey, namedModelGroups, parseLlmChoiceKey, useSettingsStore } from '@/stores'

withDefaults(
  defineProps<{
    label?: string
  }>(),
  { label: '出图' }
)

const settings = useSettingsStore()

const groups = computed(() => namedModelGroups(settings.config.images ?? []))

const model = computed({
  get() {
    const id = settings.config.activeImageId
    const name = settings.config.image.model
    return id && name ? llmChoiceKey(id, name) : ''
  },
  set(v: string) {
    const parsed = parseLlmChoiceKey(v)
    if (parsed) settings.selectImageModel(parsed.profileId, parsed.model)
  }
})
</script>

<template>
  <ParamSelect :label="label" :model-value="model" @update:model-value="model = $event">
    <option v-if="!groups.some((g) => g.models.length)" value="">请先在设置里添加出图模型</option>
    <optgroup v-for="g in groups" :key="g.id" :label="g.name">
      <option v-for="m in g.models" :key="g.id + m" :value="llmChoiceKey(g.id, m)">{{ m }}</option>
    </optgroup>
  </ParamSelect>
</template>
