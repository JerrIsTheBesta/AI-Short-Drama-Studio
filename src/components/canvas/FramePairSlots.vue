<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAssetsStore, useLibraryStore } from '@/stores'
import { openLightbox } from '@/composables/useLightbox'
import AssetPicker from '@/components/common/AssetPicker.vue'
import type { ID } from '@/types'

const props = withDefaults(
  defineProps<{
    firstId?: ID
    lastId?: ID
    firstHint?: string
    lastRequired?: boolean
  }>(),
  { lastRequired: false }
)

const emit = defineEmits<{
  'update:firstId': [id: ID | undefined]
  'update:lastId': [id: ID | undefined]
}>()

const assets = useAssetsStore()
const library = useLibraryStore()
const urls = ref<Record<string, string>>({})
const picking = ref<'first' | 'last' | ''>('')

const ids = computed(() => [props.firstId, props.lastId].filter((id): id is ID => Boolean(id)))

watch(
  ids,
  async (next) => {
    const map: Record<string, string> = {}
    for (const id of next) {
      map[id] = (await assets.getUrl(id)) || (await library.getUrl(id)) || ''
    }
    urls.value = map
  },
  { immediate: true }
)

function openPick(which: 'first' | 'last') {
  picking.value = which
}

function onConfirm(selected: ID[]) {
  const id = selected[0]
  if (picking.value === 'first') emit('update:firstId', id)
  if (picking.value === 'last') emit('update:lastId', id)
  picking.value = ''
}

function clear(which: 'first' | 'last') {
  if (which === 'first') emit('update:firstId', undefined)
  else emit('update:lastId', undefined)
}
</script>

<template>
  <div class="frames nodrag nowheel">
    <div class="slot">
      <span>首帧</span>
      <button v-if="firstId && urls[firstId]" type="button" class="thumb" @click="openLightbox(urls[firstId], 'image')">
        <img :src="urls[firstId]" alt="" />
      </button>
      <button v-else type="button" class="empty" @click="openPick('first')">＋</button>
      <div class="row">
        <button type="button" class="link" @click="openPick('first')">{{ firstId ? '更换' : '选择' }}</button>
        <button v-if="firstId" type="button" class="link" @click="clear('first')">清除</button>
      </div>
      <small v-if="firstHint">{{ firstHint }}</small>
    </div>
    <div class="slot">
      <span>{{ lastRequired ? '尾帧' : '尾帧（可选）' }}</span>
      <button v-if="lastId && urls[lastId]" type="button" class="thumb" @click="openLightbox(urls[lastId], 'image')">
        <img :src="urls[lastId]" alt="" />
      </button>
      <button v-else type="button" class="empty" @click="openPick('last')">＋</button>
      <div class="row">
        <button type="button" class="link" @click="openPick('last')">{{ lastId ? '更换' : '选择' }}</button>
        <button v-if="lastId" type="button" class="link" @click="clear('last')">清除</button>
      </div>
    </div>
    <AssetPicker
      :open="Boolean(picking)"
      kind="image"
      :title="picking === 'last' ? '选择尾帧' : '选择首帧'"
      show-library
      default-tab="page"
      :selected-ids="picking === 'last' ? (lastId ? [lastId] : []) : firstId ? [firstId] : []"
      @close="picking = ''"
      @confirm="onConfirm"
    />
  </div>
</template>

<style scoped>
.frames {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.slot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.slot span {
  font-size: 10px;
  color: var(--color-text-4);
}
.slot small {
  font-size: 10px;
  color: var(--color-text-4);
}
.thumb,
.empty {
  width: 100%;
  aspect-ratio: 16 / 9;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-0);
  overflow: hidden;
  cursor: pointer;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.empty {
  color: var(--color-text-4);
  font-size: 18px;
}
.row {
  display: flex;
  gap: 8px;
}
.link {
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-3);
  font-size: 11px;
  cursor: pointer;
}
.link:hover {
  color: var(--color-text-1);
}
</style>
