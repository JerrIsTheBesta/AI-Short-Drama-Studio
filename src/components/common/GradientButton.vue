<script setup lang="ts">
defineProps<{
  type?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  disabled?: boolean
  block?: boolean
  icon?: string
}>()

const emit = defineEmits<{
  click: [evt: MouseEvent]
}>()
</script>

<template>
  <button
    class="grad-btn"
    :class="[
      `type-${type ?? 'primary'}`,
      `size-${size ?? 'md'}`,
      { loading, disabled, block }
    ]"
    :disabled="disabled || loading"
    @click="emit('click', $event)"
  >
    <span v-if="icon" class="icon">{{ icon }}</span>
    <span class="content">
      <slot />
    </span>
    <span v-if="loading" class="spinner spin"></span>
  </button>
</template>

<style scoped>
.grad-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font-weight: 600;
  border-radius: var(--radius-md);
  transition: all var(--duration-fast) var(--ease-out);
  white-space: nowrap;
  user-select: none;
}

.grad-btn.block {
  width: 100%;
}

.grad-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.size-sm {
  padding: 6px 12px;
  font-size: 12px;
}
.size-md {
  padding: 10px 18px;
  font-size: 13px;
}
.size-lg {
  padding: 14px 28px;
  font-size: 15px;
}

.type-primary {
  background: var(--grad-primary);
  color: white;
  box-shadow: 0 4px 16px rgba(124, 58, 237, 0.3);
}
.type-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(124, 58, 237, 0.45);
}
.type-primary:active:not(:disabled) {
  transform: translateY(0);
}

.type-secondary {
  background: var(--color-bg-3);
  color: var(--color-text-1);
  border: 1px solid var(--color-border-strong);
}
.type-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  border-color: var(--color-accent);
}

.type-ghost {
  background: transparent;
  color: var(--color-text-2);
  border: 1px solid var(--color-border);
}
.type-ghost:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
}

.type-danger {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-error);
  border: 1px solid rgba(239, 68, 68, 0.3);
}
.type-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
}

.icon {
  font-size: 1.1em;
  line-height: 1;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
}

.loading .content {
  opacity: 0.5;
}
</style>
