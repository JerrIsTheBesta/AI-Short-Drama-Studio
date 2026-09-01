<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAssetsStore, useLibraryStore, useProjectStore, useToastStore } from '@/stores'
import { imageRefSlots, videoRefSlots, boardRefSlots, boundSubjectIds } from '@/utils/consistency'
import { openLightbox } from '@/composables/useLightbox'
import AssetPicker from '@/components/common/AssetPicker.vue'
import { pickLocalFiles } from '@/utils/pickLocalFiles'
import type { ID, Shot } from '@/types'

const props = defineProps<{
  shot?: Shot
  mode?: 'image' | 'video' | 'board'
  extraIds?: ID[]
}>()

const emit = defineEmits<{
  'update:extraIds': [ids: ID[]]
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const library = useLibraryStore()
const toast = useToastStore()
const urls = ref<Record<string, string>>({})
const pickerOpen = ref(false)

const unboundCast = computed(() => {
  const p = project.current
  if (!p || props.mode !== 'image' || !props.shot) return false
  const people = (p.subjects ?? []).filter((s) => s.kind !== 'other')
  if (!people.length) return false
  return boundSubjectIds(props.shot, people).length === 0
})

const slots = computed(() => {
  if (props.shot && project.current) {
    if (props.mode === 'video') return videoRefSlots(props.shot, project.current)
    if (props.mode === 'board') return boardRefSlots(props.shot, project.current)
    return imageRefSlots(props.shot, project.current)
  }
  return (props.extraIds ?? []).map((id) => ({ id, label: '参考', locked: false }))
})

watch(
  () => slots.value.map((s) => s.id).join(','),
  async () => {
    const next: Record<string, string> = {}
    for (const slot of slots.value) {
      const url = (await assets.getUrl(slot.id)) || (await library.getUrl(slot.id))
      if (url) next[slot.id] = url
    }
    urls.value = next
  },
  { immediate: true }
)

function currentExtraIds(): ID[] {
  return props.shot ? props.shot.referenceAssetIds ?? [] : props.extraIds ?? []
}

function setExtraIds(ids: ID[]) {
  const merged = [...new Set(ids)].slice(0, 10)
  if (props.shot) {
    project.updateShot(props.shot.id, { referenceAssetIds: merged })
    return
  }
  emit('update:extraIds', merged)
}

function addExtraIds(ids: ID[]) {
  const skip = props.shot?.imageAssetId
  const merged = [...currentExtraIds()]
  for (const id of ids) {
    if (!merged.includes(id) && id !== skip) merged.push(id)
  }
  setExtraIds(merged)
  if (props.shot && ids.length) {
    const drop = new Set(ids)
    const omitted = (props.shot.omittedRefAssetIds ?? []).filter((x) => !drop.has(x))
    if (omitted.length !== (props.shot.omittedRefAssetIds ?? []).length) {
      project.updateShot(props.shot.id, { omittedRefAssetIds: omitted })
    }
  }
}

function removeExtra(id: ID, ev?: Event) {
  ev?.preventDefault()
  ev?.stopPropagation()
  const extras = currentExtraIds()
  if (extras.includes(id)) setExtraIds(extras.filter((x) => x !== id))
  if (props.shot) {
    const omitted = [...new Set([...(props.shot.omittedRefAssetIds ?? []), id])]
    project.updateShot(props.shot.id, { omittedRefAssetIds: omitted })
  }
  toast.success('已移除这张参考图')
}

async function onPickerConfirm(ids: ID[]) {
  const resolved: ID[] = []
  for (const id of ids) {
    try {
      const copied = await assets.adopt(id, 'image', { projectId: project.current?.id, shotId: props.shot?.id })
      resolved.push(copied.id)
    } catch {
      resolved.push(id)
    }
  }
  addExtraIds(resolved)
  pickerOpen.value = false
}

function triggerUpload() {
  void pickAndAddRefs()
}

async function pickAndAddRefs() {
  let files: File[]
  try {
    files = await pickLocalFiles({ kind: 'image', multiple: true })
  } catch (err: any) {
    toast.error(err?.message || '读取参考图失败')
    return
  }
  if (!files.length) return
  let count = 0
  const added: string[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    const asset = await assets.add(file, 'image', 'uploaded', {
      filename: file.name,
      projectId: project.current?.id,
      shotId: props.shot?.id
    })
    added.push(asset.id)
    count++
  }
  if (added.length) addExtraIds(added)
  if (count) toast.success(`已添加 ${count} 张参考图`)
}

onBeforeUnmount(() => {
  pickerOpen.value = false
})
</script>

<template>
  <div class="ref-strip nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @click.stop>
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
          type="button"
          class="del nodrag nopan nowheel"
          title="移除这张参考图"
          @pointerdown.stop.prevent="removeExtra(slot.id, $event)"
        >
          ×
        </button>
      </div>
      <button type="button" class="ref-add" title="添加参考图" @click="pickerOpen = true">＋</button>
    </div>
    <p v-if="mode === 'image' && unboundCast" class="hint">
      这镜还没绑人物，人设图不会进关键帧。到「人物」分组点重新提取，或在画面描述里写出角色名字。
    </p>
    <p v-else-if="mode === 'image' && !slots.length" class="hint">关键帧是 2×2 四宫格（正好四格）。用人设图和场景图来画这一镜正在发生的事。</p>
    <p v-else-if="mode === 'video' && !slots.length" class="hint">先做人设图和场景图，再出视频。本镜会带上绑定场景的场景图。</p>
    <AssetPicker
      :open="pickerOpen"
      kind="image"
      multiple
      title="添加参考图"
      show-library
      @close="pickerOpen = false"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<style scoped>
.ref-strip {
  margin-top: 8px;
  padding-top: 10px;
  overflow: visible;
  border-top: 1px solid var(--color-border);
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
  background: var(--color-fill);
  color: var(--color-text-1);
  font-size: 11px;
  cursor: pointer;
}
.ref-acts button:hover {
  background: var(--color-fill-hover);
}
.ref-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  overflow: visible;
  padding-top: 6px;
}
.ref-item {
  position: relative;
  width: 48px;
  flex-shrink: 0;
  overflow: visible;
}
.ref-item img,
.ref-item .ph {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
  display: block;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
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
  top: -6px;
  right: -6px;
  z-index: 4;
  box-sizing: border-box;
  width: 20px;
  height: 20px;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid #fff;
  border-radius: 50%;
  background: #e5484d;
  color: #fff !important;
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.55);
  cursor: pointer;
  pointer-events: auto;
}
.ref-item .del:hover {
  background: #c63c41;
}
.ref-add {
  width: 52px;
  height: 52px;
  margin: 0;
  border: 1px dashed var(--color-border-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-2);
  font-size: 18px;
  cursor: pointer;
}
.hint {
  margin: 6px 0 0;
  font-size: 10px;
  color: var(--color-text-4);
}
</style>
