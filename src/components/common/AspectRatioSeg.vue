<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore } from '@/stores'
import { ASPECT_PRESETS } from '@/utils/aspect'
import type { AspectRatio } from '@/types'

defineProps<{
  compact?: boolean
}>()

const project = useProjectStore()
const current = computed(() => project.current?.settings.aspectRatio ?? '16:9')

function pick(ar: AspectRatio) {
  if (!project.current) return
  if (project.current.settings.aspectRatio === ar) return
  project.setAspectRatio(ar)
}
</script>

<template>
  <label v-if="compact" class="ar-compact">
    <span class="ar-k">比例</span>
    <select
      :value="current"
      @change="pick(($event.target as HTMLSelectElement).value as AspectRatio)"
    >
      <option v-for="a in ASPECT_PRESETS" :key="a.value" :value="a.value">
        {{ a.hint }} {{ a.value }}
      </option>
    </select>
  </label>
  <div v-else class="ar-full">
    <div class="ar-head">画面比例</div>
    <div class="ar-seg">
      <button
        v-for="a in ASPECT_PRESETS"
        :key="a.value"
        type="button"
        class="ar-btn"
        :class="{ on: current === a.value }"
        :title="`${a.hint} ${a.value}`"
        @click="pick(a.value)"
      >
        <i class="ar-box" :data-ar="a.value" />
        <span>{{ a.hint }}</span>
        <small>{{ a.value }}</small>
      </button>
    </div>
    <p class="ar-hint">默认跟创建项目时选的一样。改了只影响之后新生成的分镜图和视频。</p>
  </div>
</template>

<style scoped>
.ar-compact {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ar-k {
  font-size: 11px;
  color: var(--color-text-3);
  white-space: nowrap;
}
.ar-compact select {
  height: 28px;
  min-width: 0;
  max-width: 118px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-1);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 12px;
}
.ar-full {
  display: grid;
  gap: 8px;
}
.ar-head {
  font-size: 12px;
  color: var(--color-text-2);
}
.ar-seg {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}
.ar-btn {
  display: grid;
  justify-items: center;
  gap: 4px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-2);
  border-radius: 8px;
  padding: 8px 4px 6px;
  cursor: pointer;
}
.ar-btn.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-bg-2));
}
.ar-btn span {
  font-size: 11px;
  line-height: 1.2;
}
.ar-btn small {
  font-size: 10px;
  opacity: 0.75;
}
.ar-box {
  display: block;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  opacity: 0.85;
}
.ar-box[data-ar='16:9'] { width: 22px; height: 12px; }
.ar-box[data-ar='9:16'] { width: 10px; height: 18px; }
.ar-box[data-ar='1:1'] { width: 14px; height: 14px; }
.ar-box[data-ar='4:3'] { width: 18px; height: 14px; }
.ar-box[data-ar='21:9'] { width: 24px; height: 10px; }
.ar-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-3);
}
</style>
