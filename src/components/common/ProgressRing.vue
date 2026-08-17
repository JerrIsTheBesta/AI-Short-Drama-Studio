<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  progress: number
  size?: number
  strokeWidth?: number
  showLabel?: boolean
}>()

const size = computed(() => props.size ?? 64)
const stroke = computed(() => props.strokeWidth ?? 4)

const radius = computed(() => (size.value - stroke.value) / 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
const offset = computed(() => {
  const p = Math.max(0, Math.min(1, props.progress))
  return circumference.value * (1 - p)
})
</script>

<template>
  <div class="ring" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg :width="size" :height="size">
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        :stroke-width="stroke"
      />
      <circle
        class="progress"
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        stroke="url(#ring-grad)"
        :stroke-width="stroke"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="offset"
        stroke-linecap="round"
        :transform="`rotate(-90 ${size / 2} ${size / 2})`"
      />
      <defs>
        <linearGradient id="ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#7c3aed" />
          <stop offset="50%" stop-color="#ec4899" />
          <stop offset="100%" stop-color="#f59e0b" />
        </linearGradient>
      </defs>
    </svg>
    <div v-if="showLabel" class="label">
      {{ Math.round(progress * 100) }}%
    </div>
  </div>
</template>

<style scoped>
.ring {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.progress {
  transition: stroke-dashoffset 0.3s var(--ease-out);
}
.label {
  position: absolute;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
}
</style>
