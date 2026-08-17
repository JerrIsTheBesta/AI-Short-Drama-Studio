<script setup lang="ts">
defineProps<{
  /** 悬浮时高亮 */
  hoverable?: boolean
  /** 内边距大小 */
  padding?: 'sm' | 'md' | 'lg' | 'none'
  /** 是否显示光晕 */
  glow?: boolean
}>()
</script>

<template>
  <div
    class="glass-card-root"
    :class="[
      `pad-${padding ?? 'md'}`,
      { hoverable, glow }
    ]"
  >
    <slot />
  </div>
</template>

<style scoped>
.glass-card-root {
  background: var(--color-bg-card);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  transition: all var(--duration-normal) var(--ease-out);
  position: relative;
  overflow: hidden;
}

.glass-card-root::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--grad-primary-soft);
  opacity: 0;
  transition: opacity var(--duration-normal) var(--ease-out);
  pointer-events: none;
}

.glass-card-root.hoverable:hover {
  transform: translateY(-2px);
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-lg);
}

.glass-card-root.hoverable:hover::before {
  opacity: 0.5;
}

.glass-card-root.glow {
  box-shadow: var(--shadow-glow);
}

.pad-none { padding: 0; }
.pad-sm { padding: var(--space-3); }
.pad-md { padding: var(--space-5); }
.pad-lg { padding: var(--space-8); }
</style>
