<script setup lang="ts">
/**
 * 节点面板 / 列表里的参数下拉：比例、出图模型、视频模型统一用这一套外观，
 * 避免三个控件各写一份 CSS 导致圆角、箭头、字号对不齐。
 */
withDefaults(
  defineProps<{
    label?: string
    modelValue?: string
    /** 固定宽度的下拉（如比例）传窄一点，自适应传 'auto' */
    width?: string
    maxWidth?: string
    title?: string
  }>(),
  { label: '', modelValue: '', width: 'auto', maxWidth: '', title: '' }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

function onPick(event: Event) {
  emit('update:modelValue', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <label
    class="psel"
    :style="{
      ...(width === 'auto' ? {} : { flex: `0 0 ${width}` }),
      ...(maxWidth ? { maxWidth } : {})
    }"
  >
    <span v-if="label" class="psel-k">{{ label }}</span>
    <select :value="modelValue" :title="title || label" @change="onPick">
      <slot />
    </select>
  </label>
</template>

<style scoped>
.psel {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
}
.psel-k {
  flex: 0 0 auto;
  font-size: 10px;
  line-height: 1;
  color: var(--color-text-4);
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.psel select {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  height: 28px;
  padding: 0 24px 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background-color: var(--color-bg-2);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path d='M1.4 2.2L6 6.2l4.6-4' fill='none' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1;
  font-family: inherit;
  appearance: none;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s, box-shadow 0.15s;
}
.psel select:hover {
  border-color: var(--color-text-4, #64748b);
  background-color: var(--color-bg-3);
}
.psel select:focus-visible {
  border-color: #60a5fa;
  box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.24);
}
.psel select:disabled {
  opacity: 0.55;
  cursor: default;
}
/* Windows 下 option 跟随系统配色，深色界面里会白底黑字，这里强制跟随界面 */
.psel select option,
.psel select optgroup {
  background: var(--color-bg-2);
  color: var(--color-text-1);
}
.psel select optgroup {
  font-style: normal;
  color: var(--color-text-4);
}
</style>
