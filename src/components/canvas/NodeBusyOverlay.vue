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
  background: rgba(10, 8, 22, 0.72);
  backdrop-filter: blur(3px);
  pointer-events: none;
  color: #f5f3ff;
  font-size: 13px;
  font-weight: 750;
  letter-spacing: 0.06em;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.55);
}
.bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(167, 139, 250, 0.28);
}
.bar::after {
  content: '';
  position: absolute;
  top: 0;
  left: -40%;
  width: 40%;
  height: 100%;
  background: linear-gradient(90deg, transparent, #ddd6fe, transparent);
  animation: bar 1.05s ease-in-out infinite;
}
.scan {
  position: absolute;
  left: 0;
  right: 0;
  height: 38%;
  background: linear-gradient(180deg, transparent, rgba(196, 181, 253, 0.22), transparent);
  animation: scan 1.7s ease-in-out infinite;
}
.ring {
  position: relative;
  width: 34px;
  height: 34px;
  border: 3px solid rgba(196, 181, 253, 0.22);
  border-top-color: #ede9fe;
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
