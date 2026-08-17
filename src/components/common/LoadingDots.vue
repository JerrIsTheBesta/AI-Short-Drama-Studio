<script setup lang="ts">
defineProps<{ text?: string }>()
</script>

<template>
  <div class="loading-dots">
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span v-if="text" class="text">{{ text }}</span>
  </div>
</template>

<style scoped>
.loading-dots {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dot {
  width: 6px;
  height: 6px;
  background: var(--color-text-3);
  border-radius: 50%;
  animation: dot-pulse 1.4s ease-in-out infinite;
}
.dot:nth-child(2) {
  animation-delay: 0.2s;
}
.dot:nth-child(3) {
  animation-delay: 0.4s;
}
.text {
  margin-left: var(--space-2);
  color: var(--color-text-3);
  font-size: 13px;
}

@keyframes dot-pulse {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1);
    opacity: 1;
  }
}
</style>
