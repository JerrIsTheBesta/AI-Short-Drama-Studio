<script setup lang="ts">
import { ref } from 'vue'
import type { ProviderPreset } from '@/services/ai/providers'

const props = defineProps<{
  title: string
  hint?: string
  profiles: { id: string; name: string; subtitle: string }[]
  activeId: string
  providers: ProviderPreset[]
}>()

const emit = defineEmits<{
  select: [id: string]
  create: [providerId: string]
  remove: []
}>()

const adding = ref(false)

function pick(id: string) {
  adding.value = false
  emit('create', id)
}
</script>

<template>
  <section class="lib">
    <div class="lib-head">
      <h4>{{ title }}</h4>
      <button type="button" class="add" @click="adding = !adding">
        {{ adding ? '取消' : '添加' }}
      </button>
    </div>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <div v-if="adding" class="add-pick">
      <p>选择接入方式</p>
      <button
        v-for="p in providers"
        :key="p.id"
        type="button"
        :title="p.hint"
        @click="pick(p.id)"
      >
        {{ p.name }}
      </button>
    </div>
    <div class="cards">
      <button
        v-for="p in profiles"
        :key="p.id"
        type="button"
        :class="{ on: p.id === activeId }"
        @click="emit('select', p.id)"
      >
        <strong>{{ p.name }}</strong>
        <span>{{ p.subtitle }}</span>
      </button>
    </div>
    <button
      v-if="profiles.length > 1"
      type="button"
      class="danger"
      @click="emit('remove')"
    >
      删除当前这项
    </button>
  </section>
</template>

<style scoped>
.lib {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 640px;
}
.lib-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lib-head h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.add {
  margin: 0;
  padding: 5px 12px;
  border-radius: 4px;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 12px;
  font-weight: 650;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.5;
}
.add-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
}
.add-pick p {
  width: 100%;
  margin: 0 0 2px;
  font-size: 12px;
  color: var(--color-text-4);
}
.add-pick button {
  margin: 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
  font-size: 12px;
}
.add-pick button:hover {
  color: var(--color-text-1);
  background: var(--color-accent);
  color: var(--color-on-accent);
}
.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cards button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 0;
  min-width: 132px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  text-align: left;
}
.cards button.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: var(--color-fill);
}
.cards strong {
  font-size: 13px;
}
.cards span {
  font-size: 11px;
  color: var(--color-text-4);
}
.danger {
  align-self: flex-start;
  margin: 4px 0 0;
  padding: 6px 10px;
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: 4px;
  background: transparent;
  color: #fca5a5;
  font-size: 12px;
}
</style>
