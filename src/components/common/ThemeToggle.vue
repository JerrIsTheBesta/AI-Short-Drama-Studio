<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@/stores'

const settings = useSettingsStore()
const light = computed(() => settings.config.theme === 'light')

function toggle() {
  settings.update({ theme: light.value ? 'dark' : 'light' })
}
</script>

<template>
  <button
    type="button"
    class="nb-theme"
    :title="light ? '切换到深色' : '切换到浅色'"
    :aria-label="light ? '切换到深色' : '切换到浅色'"
    @click="toggle"
  >
    <svg v-if="light" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </svg>
    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2 12h2.2M19.8 12H22M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
    </svg>
  </button>
</template>

<style scoped>
.nb-theme {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--nb-line-2);
  border-radius: 8px;
  background: var(--nb-bg-2);
  color: var(--nb-t2);
  cursor: pointer;
}
.nb-theme:hover {
  color: var(--nb-t1);
  border-color: var(--nb-line-accent);
}
.nb-theme svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
