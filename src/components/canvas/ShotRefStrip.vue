<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAssetsStore, useProjectStore, useToastStore } from '@/stores'
import { imageRefSlots, videoRefSlots, boardRefSlots, boundSubjectIds } from '@/utils/consistency'
import { openLightbox } from '@/composables/useLightbox'
import AssetPicker from '@/components/common/AssetPicker.vue'
import type { ID, Shot } from '@/types'

const props = defineProps<{
  shot: Shot
  mode: 'image' | 'video' | 'board'
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const urls = ref<Record<string, string>>({})
const pickerOpen = ref(false)

const unboundCast = computed(() => {
  const p = project.current
  if (!p || props.mode !== 'image') return false
  const people = (p.subjects ?? []).filter((s) => s.kind !== 'other')
  if (!people.length) return false
  return boundSubjectIds(props.shot, people).length === 0
})

const slots = computed(() => {
  if (!project.current) return []
  if (props.mode === 'video') return videoRefSlots(props.shot, project.current)
  if (props.mode === 'board') return boardRefSlots(props.shot, project.current)
  return imageRefSlots(props.shot, project.current)
})

watch(
  () => slots.value.map((s) => s.id).join(','),
  async () => {
    const next: Record<string, string> = {}
    for (const slot of slots.value) {
      const url = await assets.getUrl(slot.id)
      if (url) next[slot.id] = url
    }
    urls.value = next
  },
  { immediate: true }
)

function addExtraIds(ids: ID[]) {
  const shot = props.shot
  const merged = [...(shot.referenceAssetIds ?? [])]
  for (const id of ids) {
    if (!merged.includes(id) && id !== shot.imageAssetId) merged.push(id)
  }
  project.updateShot(shot.id, { referenceAssetIds: merged })
}

function removeExtra(id: ID) {
  const ids = (props.shot.referenceAssetIds ?? []).filter((x) => x !== id)
  project.updateShot(props.shot.id, { referenceAssetIds: ids })
}

function onPickerConfirm(ids: ID[]) {
  addExtraIds(ids)
  pickerOpen.value = false
}

function triggerUpload() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.addEventListener('change', async () => {
    const files = input.files
    document.body.removeChild(input)
    if (!files?.length) return
    let count = 0
    const added: string[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      const asset = await assets.add(file, 'image', 'uploaded', {
        filename: file.name,
        projectId: project.current?.id,
        shotId: props.shot.id
      })
      added.push(asset.id)
      count++
    }
    if (added.length) addExtraIds(added)
    if (count) toast.success(`已添加 ${count} 张参考图`)
  })
  document.body.appendChild(input)
  input.click()
}

onBeforeUnmount(() => {
  pickerOpen.value = false
})
</script>

<template>
  <div class="ref-strip" @mousedown.stop @click.stop>
    <div class="ref-head">
      <span>参考图</span>
      <div class="ref-acts">
        <button type="button" @click="pickerOpen = true">资源库</button>
        <button type="button" @click="triggerUpload">＋ 添加</button>
      </div>
    </div>
    <div class="ref-list">
      <div
        v-for="slot in slots"
        :key="slot.id"
        class="ref-item"
        :class="{ locked: slot.locked }"
        :title="slot.label"
      >
        <img
          v-if="urls[slot.id]"
          :src="urls[slot.id]"
          alt=""
          @click="openLightbox(urls[slot.id])"
        />
        <div v-else class="ph">图</div>
        <em>{{ slot.label }}</em>
        <button
          v-if="!slot.locked"
          type="button"
          class="del"
          title="移除"
          @click="removeExtra(slot.id)"
        >
          ×
        </button>
      </div>
      <button type="button" class="ref-add" title="添加参考图" @click="pickerOpen = true">＋</button>
    </div>
    <p v-if="mode === 'image' && unboundCast" class="hint">
      这镜还没绑人物，人设图不会进配图。重新提炼节点，或在画面描述里写出角色名字。
    </p>
    <p v-else-if="mode === 'video' && !slots.length" class="hint">出视频要传本镜角色设计图、场景图和故事看板。缺哪张就先补哪张，不要用人设+场景配图。</p>
    <AssetPicker
      :open="pickerOpen"
      kind="image"
      multiple
      title="添加参考图"
      @close="pickerOpen = false"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<style scoped>
.ref-strip {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.ref-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.ref-head span {
  font-size: 11px;
  color: var(--color-text-3);
}
.ref-acts {
  display: flex;
  gap: 4px;
}
.ref-acts button {
  margin: 0;
  padding: 2px 8px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #f5f5fa;
  font-size: 11px;
  cursor: pointer;
}
.ref-acts button:hover {
  background: rgba(255, 255, 255, 0.16);
}
.ref-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ref-item {
  position: relative;
  width: 52px;
  flex-shrink: 0;
}
.ref-item img,
.ref-item .ph {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  object-fit: cover;
  display: block;
  background: #0b0b14;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.ref-item .ph {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--color-text-4);
}
.ref-item em {
  display: block;
  margin-top: 3px;
  font-style: normal;
  font-size: 10px;
  color: var(--color-text-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ref-item .del {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #1a1a26;
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}
.ref-add {
  width: 52px;
  height: 52px;
  margin: 0;
  border: 1px dashed rgba(255, 255, 255, 0.22);
  border-radius: 8px;
  background: transparent;
  color: #f5f5fa;
  font-size: 18px;
  cursor: pointer;
}
.hint {
  margin: 6px 0 0;
  font-size: 10px;
  color: var(--color-text-4);
}
</style>
