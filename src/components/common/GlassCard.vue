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
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: all var(--duration-normal) var(--ease-out);
  position: relative;
  overflow: hidden;
}

.glass-card-root.hoverable:hover {
  transform: translateY(-1px);
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-md);
}

.glass-card-root.glow {
  box-shadow: var(--shadow-md);
}

.pad-none { padding: 0; }
.pad-sm { padding: var(--space-3); }
.pad-md { padding: var(--space-5); }
.pad-lg { padding: var(--space-8); }
</style>
