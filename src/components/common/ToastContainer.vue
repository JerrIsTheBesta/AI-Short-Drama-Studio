<script setup lang="ts">
import { useToastStore } from '@/stores'
import { computed } from 'vue'

const toast = useToastStore()

const items = computed(() => toast.items)

function iconFor(kind: string) {
  return {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌'
  }[kind] ?? 'ℹ️'
}
</script>

<template>
  <div class="toast-container">
    <transition-group name="toast">
      <div
        v-for="t in items"
        :key="t.id"
        class="toast"
        :class="`kind-${t.kind}`"
        @click="toast.dismiss(t.id)"
      >
        <span class="icon">{{ iconFor(t.kind) }}</span>
        <span class="msg">{{ t.message }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: var(--space-4);
  right: var(--space-4);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  backdrop-filter: blur(20px);
  box-shadow: var(--shadow-lg);
  min-width: 240px;
  max-width: 480px;
  pointer-events: auto;
  cursor: pointer;
  font-size: 13px;
  transition: transform var(--duration-fast) var(--ease-out);
}
.toast:hover {
  transform: translateX(-4px);
}
.icon {
  font-size: 16px;
  flex-shrink: 0;
}
.msg {
  flex: 1;
  color: var(--color-text-1);
}
.kind-info { border-left: 3px solid var(--color-info); }
.kind-success { border-left: 3px solid var(--color-success); }
.kind-warning { border-left: 3px solid var(--color-warning); }
.kind-error { border-left: 3px solid var(--color-error); }

.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s var(--ease-out);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
</style>
