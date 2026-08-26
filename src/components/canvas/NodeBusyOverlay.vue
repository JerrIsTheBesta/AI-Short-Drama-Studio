<script setup lang="ts">
defineProps<{
  label?: string
}>()
</script>

<template>
  <div class="busy-ov nodrag nowheel">
    <i class="bar" />
    <i class="scan" />
    <i class="ring" />
    <span>{{ label || '生成中' }}</span>
  </div>
</template>

<style scoped>
.busy-ov {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  overflow: hidden;
  border-radius: inherit;
  background: rgba(18, 18, 22, 0.88);
  pointer-events: none;
  color: var(--color-text-1);
  font-size: 12px;
  font-weight: 750;
  letter-spacing: 0.04em;
}
.busy-ov > span {
  position: relative;
  z-index: 1;
  max-width: 92%;
  padding: 0 8px;
  text-align: center;
  line-height: 1.35;
  word-break: break-word;
}
.bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.12);
}
.bar::after {
  content: '';
  position: absolute;
  top: 0;
  left: -40%;
  width: 40%;
  height: 100%;
  background: linear-gradient(90deg, transparent, #7eb4ff, transparent);
  animation: bar 1.05s ease-in-out infinite;
}
.scan {
  position: absolute;
  left: 0;
  right: 0;
  height: 38%;
  background: linear-gradient(180deg, transparent, rgba(126, 180, 255, 0.12), transparent);
  animation: scan 1.7s ease-in-out infinite;
}
.ring {
  position: relative;
  width: 34px;
  height: 34px;
  border: 3px solid rgba(255, 255, 255, 0.16);
  border-top-color: #7eb4ff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes bar {
  to {
    left: 100%;
  }
}
@keyframes scan {
  0% {
    top: -40%;
  }
  100% {
    top: 100%;
  }
}
</style>
