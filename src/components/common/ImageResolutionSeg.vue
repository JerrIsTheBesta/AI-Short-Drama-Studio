<script setup lang="ts">
import ParamSelect from '@/components/common/ParamSelect.vue'
import { docImageResolutionLabel, type DocImageResolution } from '@/services/ai/modelOptions'

defineProps<{
  modelValue: DocImageResolution
  choices: DocImageResolution[]
}>()

const emit = defineEmits<{ 'update:modelValue': [value: DocImageResolution] }>()
</script>

<template>
  <ParamSelect
    label="分辨率"
    width="88px"
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event as DocImageResolution)"
  >
    <option v-for="item in choices" :key="item" :value="item">{{ docImageResolutionLabel(item) }}</option>
  </ParamSelect>
</template>
