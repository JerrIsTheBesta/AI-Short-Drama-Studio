<script setup lang="ts">
defineProps<{
  icon?: string
  title: string
  description?: string
}>()
</script>

<template>
  <div class="empty">
    <div class="icon">{{ icon ?? '✨' }}</div>
    <div class="title">{{ title }}</div>
    <div v-if="description" class="desc">{{ description }}</div>
    <div v-if="$slots.action" class="action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-12) var(--space-6);
  text-align: center;
  color: var(--color-text-3);
}
.icon {
  font-size: 48px;
  margin-bottom: var(--space-4);
  opacity: 0.5;
}
.title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-2);
  margin-bottom: var(--space-2);
}
.desc {
  font-size: 13px;
  max-width: 360px;
  line-height: 1.6;
  margin-bottom: var(--space-4);
}
.action {
  margin-top: var(--space-3);
}
</style>
