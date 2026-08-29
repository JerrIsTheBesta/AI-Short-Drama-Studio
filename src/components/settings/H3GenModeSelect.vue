<script setup lang="ts">
import { computed } from 'vue'
import { normalizeH3GenMode, type H3VideoGenMode } from '@/types'

const props = defineProps<{
  modelValue?: H3VideoGenMode | string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: H3VideoGenMode] }>()

const value = computed(() => normalizeH3GenMode(props.modelValue))

function setMode(mode: H3VideoGenMode) {
  emit('update:modelValue', mode)
}
</script>

<template>
  <div class="h3-mode nodrag nowheel" role="group" aria-label="H3 生成模式">
    <button
      type="button"
      :class="{ on: value === 'reference' }"
      title="多张参考图锁身份、场景和看板，当前默认"
      @click="setMode('reference')"
    >
      参考图生成
    </button>
    <button
      type="button"
      :class="{ on: value === 'fl2va' }"
      title="用首帧和尾帧插值成一条连续镜头"
      @click="setMode('fl2va')"
    >
      首尾帧
    </button>
  </div>
</template>

<style scoped>
.h3-mode {
  display: flex;
  flex-shrink: 0;
  width: 100%;
  gap: 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}
.h3-mode button {
  flex: 1;
  margin: 0;
  padding: 0 8px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--color-text-3);
  font-size: 11px;
  cursor: pointer;
}
.h3-mode button + button {
  border-left: 1px solid var(--color-border);
}
.h3-mode button.on {
  background: var(--color-fill);
  color: var(--color-text-1);
}
</style>
