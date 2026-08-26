<script setup lang="ts">
defineProps<{
  data: {
    label?: string
    kind?: string
  }
}>()
</script>

<template>
  <div class="gframe" :class="data.kind ? `tint-${data.kind}` : ''">
    <div class="gframe-h">{{ data.label || '分组' }}</div>
  </div>
</template>

<style scoped>
.gframe {
  width: 100%;
  height: 100%;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: var(--color-canvas-group);
  pointer-events: none;
}
.gframe-h {
  height: 44px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-2);
}
.tint-script,
.tint-subject,
.tint-scene,
.tint-shot,
.tint-audio,
.tint-export {
  background: var(--color-canvas-group);
  border-color: rgba(255, 255, 255, 0.08);
}
</style>
