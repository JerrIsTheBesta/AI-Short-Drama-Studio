<script setup lang="ts">
defineProps<{
  /** 标签类型 */
  type?: 'default' | 'success' | 'warning' | 'error' | 'info' | 'accent'
  /** 尺寸 */
  size?: 'sm' | 'md'
}>()
</script>

<template>
  <span class="tag" :class="[`type-${type ?? 'default'}`, `size-${size ?? 'md'}`]">
    <slot />
  </span>
</template>

<style scoped>
.tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  line-height: 1.6;
  white-space: nowrap;
}
.size-sm {
  padding: 1px 6px;
  font-size: 10px;
}
.type-default {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text-2);
}
.type-success {
  background: rgba(16, 185, 129, 0.15);
  color: #6ee7b7;
}
.type-warning {
  background: rgba(245, 158, 11, 0.15);
  color: #fcd34d;
}
.type-error {
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
}
.type-info {
  background: rgba(59, 130, 246, 0.15);
  color: #93c5fd;
}
.type-accent {
  background: var(--grad-primary-soft);
  color: #f5d0fe;
}
</style>
