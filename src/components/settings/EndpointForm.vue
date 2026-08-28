<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ProviderPreset } from '@/services/ai/providers'
import { applyProviderPreset, findProvider, matchProviderId } from '@/services/ai/providers'

const props = defineProps<{
  title: string
  hint?: string
  presets: ProviderPreset[]
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
  provider?: string
}>()

const emit = defineEmits<{
  patch: [
    patch: {
      provider?: string
      baseUrl?: string
      apiKey?: string
      model?: string
      models?: string[]
    }
  ]
  addModel: [name: string]
  removeModel: [name: string]
}>()

const draft = ref('')
const providerId = computed({
  get() {
    if (props.provider && props.presets.some((p) => p.id === props.provider)) return props.provider
    return matchProviderId(props.baseUrl, props.presets)
  },
  set(id: string) {
    const preset = findProvider(id, props.presets)
    emit('patch', applyProviderPreset(props, preset))
  }
})

const currentPreset = computed(() => findProvider(providerId.value, props.presets))

watch(
  () => props.baseUrl,
  (url) => {
    const matched = matchProviderId(url, props.presets)
    if (props.provider && props.provider !== matched && matched !== 'custom') {
      emit('patch', { provider: matched })
    }
  }
)

const suggested = computed(() =>
  currentPreset.value.models.filter((m) => m && !props.models.includes(m))
)

function onAdd() {
  const name = draft.value.trim()
  if (!name) return
  emit('addModel', name)
  draft.value = ''
}
</script>

<template>
  <section class="form">
    <header class="head">
      <h3>{{ title }}</h3>
      <p v-if="hint" class="hint">{{ hint }}</p>
    </header>

    <label>接入方式</label>
    <select v-model="providerId">
      <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <p class="hint">{{ currentPreset.hint }}</p>

    <label>接口地址</label>
    <input
      :value="baseUrl"
      :placeholder="currentPreset.baseUrl || 'https://…/v1'"
      @change="emit('patch', { baseUrl: ($event.target as HTMLInputElement).value.trim() })"
    />

    <label>API Key</label>
    <input
      type="password"
      autocomplete="off"
      :value="apiKey"
      :placeholder="currentPreset.keyPlaceholder || 'sk-…'"
      @change="emit('patch', { apiKey: ($event.target as HTMLInputElement).value.trim() })"
    />

    <label>这个接入下的模型</label>
    <p class="hint">
      同一套地址和 Key 可以挂多个模型名。点一项设为当前使用。
    </p>
    <div class="chips">
      <button
        v-for="m in models"
        :key="m"
        type="button"
        class="chip"
        :class="{ on: m === model }"
        @click="emit('patch', { model: m })"
      >
        {{ m }}
        <span
          v-if="models.length > 1"
          class="x"
          title="从列表移除"
          @click.stop="emit('removeModel', m)"
        >×</span>
      </button>
      <span v-if="!models.length" class="hint">还没有模型</span>
    </div>
    <div v-if="suggested.length" class="suggest">
      <span>常用，点一下加入</span>
      <button
        v-for="m in suggested"
        :key="m"
        type="button"
        class="chip ghost"
        @click="emit('addModel', m)"
      >
        + {{ m }}
      </button>
    </div>

    <label>添加模型名</label>
    <div class="add-row">
      <input
        v-model="draft"
        :placeholder="currentPreset.id === 'custom' || !currentPreset.models.length
          ? '填接口要求的模型名'
          : `例如 ${currentPreset.models[0]}`"
        @keydown.enter.prevent="onAdd"
      />
      <button class="mini" type="button" @click="onAdd">加入列表</button>
    </div>

    <slot />
  </section>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 560px;
}
.head h3 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 700;
}
.hint {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.5;
}
label {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
input,
select {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-1);
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font-size: 11px;
  cursor: pointer;
}
.chip.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: rgba(124, 58, 237, 0.18);
}
.chip.ghost {
  border-style: dashed;
  opacity: 0.85;
}
.suggest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.suggest > span {
  width: 100%;
  font-size: 11px;
  color: var(--color-text-4);
}
.chip .x {
  opacity: 0.55;
  font-size: 13px;
  line-height: 1;
}
.chip .x:hover {
  opacity: 1;
  color: var(--color-error, #f87171);
}
.add-row {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.add-row input {
  flex: 1;
  min-width: 0;
}
.mini {
  font-size: 12px;
  padding: 0 12px;
  border-radius: 4px;
  color: var(--color-text-2);
  background: var(--color-bg-3);
  white-space: nowrap;
}
.mini:hover {
  color: var(--color-text-1);
}
</style>
