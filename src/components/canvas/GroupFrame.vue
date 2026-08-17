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
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.03);
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
.tint-script {
  background: rgba(124, 58, 237, 0.07);
  border-color: rgba(167, 139, 250, 0.28);
}
.tint-subject {
  background: rgba(245, 158, 11, 0.07);
  border-color: rgba(251, 191, 36, 0.32);
}
.tint-scene {
  background: rgba(59, 130, 246, 0.07);
  border-color: rgba(96, 165, 250, 0.32);
}
.tint-shot {
  background: rgba(236, 72, 153, 0.06);
  border-color: rgba(244, 114, 182, 0.28);
}
.tint-export {
  background: rgba(16, 185, 129, 0.06);
  border-color: rgba(52, 211, 153, 0.28);
}
</style>
