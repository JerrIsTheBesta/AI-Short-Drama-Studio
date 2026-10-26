<script setup lang="ts">
defineProps<{ modelValue?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    type="button"
    class="audio-toggle"
    :class="{ on: modelValue }"
    :title="modelValue ? '这一镜出视频带音频' : '这一镜出视频不带音频'"
    @click="emit('update:modelValue', !modelValue)"
  >
    {{ modelValue ? '有声' : '无声' }}
  </button>
</template>

<style scoped>
.audio-toggle {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  cursor: pointer;
}
.audio-toggle.on {
  color: var(--color-text-1);
  border-color: var(--color-text-3);
}
</style>
