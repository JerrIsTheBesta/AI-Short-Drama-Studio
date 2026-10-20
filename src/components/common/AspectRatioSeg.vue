<script setup lang="ts">
import { computed } from 'vue'
import ParamSelect from '@/components/common/ParamSelect.vue'
import { useProjectStore } from '@/stores'
import { ASPECT_PRESETS } from '@/utils/aspect'
import type { AspectRatio } from '@/types'

const props = defineProps<{
  compact?: boolean
  modelValue?: AspectRatio
}>()
const emit = defineEmits<{ 'update:modelValue': [value: AspectRatio] }>()

const project = useProjectStore()
const current = computed(() => props.modelValue ?? project.current?.settings.aspectRatio ?? '16:9')

function pick(ar: AspectRatio) {
  if (!project.current) return
  if (current.value === ar) return
  if (props.modelValue !== undefined) emit('update:modelValue', ar)
  else project.setAspectRatio(ar)
}
</script>

<template>
  <ParamSelect
    v-if="compact"
    label="比例"
    width="104px"
    :model-value="current"
    @update:model-value="pick($event as AspectRatio)"
  >
    <option v-for="a in ASPECT_PRESETS" :key="a.value" :value="a.value">
      {{ a.hint }} {{ a.value }}
    </option>
  </ParamSelect>
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
    <p class="ar-hint">节点可独立设置；项目比例只作为新节点的默认值。</p>
  </div>
</template>

<style scoped>
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
