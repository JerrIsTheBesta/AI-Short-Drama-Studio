<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useAssetsStore, useLibraryStore, useProjectStore, useToastStore } from '@/stores'
import { runCanvasNode } from '@/services/canvas/runner'
import { applyShotVideoModel } from '@/services/canvas/videoModel'
import { isNodeRunning } from '@/services/canvas/jobs'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import { cssAspectRatio } from '@/services/canvas/layout'
import { openLightbox } from '@/composables/useLightbox'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'
import AssetPicker from '@/components/common/AssetPicker.vue'
import ImageModelSelect from '@/components/settings/ImageModelSelect.vue'
import VideoModelSelect from '@/components/settings/VideoModelSelect.vue'
import H3GenModeSelect from '@/components/settings/H3GenModeSelect.vue'
import FramePairSlots from '@/components/canvas/FramePairSlots.vue'
import AspectRatioSeg from '@/components/common/AspectRatioSeg.vue'
import VideoResolutionSeg from '@/components/common/VideoResolutionSeg.vue'
import { selectCanvasNode } from '@/services/canvas/canvasBridge'
import { pickLocalFiles } from '@/utils/pickLocalFiles'
import {
  canvasNodeOutputAssetId,
  resolvedCanvasReferenceAssetIds
} from '@/services/canvas/references'
import type { CanvasNodeType, H3VideoGenMode, ID, VideoGenModel, VideoResolution } from '@/types'
import {
  normalizeH3GenMode,
  normalizeVideoGenModel,
  normalizeVideoResolution,
  videoAllows1080p,
  videoDurationOptions
} from '@/types'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    label?: string
    prompt?: string
    referenceAssetIds?: string[]
    referenceSourceNodeIds?: string[]
    outputAssetId?: string
    duration?: number
    videoModel?: VideoGenModel
    nodeType?: CanvasNodeType
  }
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const library = useLibraryStore()
const toast = useToastStore()
const mediaUrl = ref('')
const posterUrl = ref('')
const pickerOpen = ref(false)
const pickerMode = ref<'ref' | 'output'>('ref')
const panelOpen = ref(false)
const moreOpen = ref(false)
const busyLabel = ref('')
let mediaSeq = 0

const { updateNodeData } = useVueFlow()

const type = computed(() => (props.data.nodeType === 'videoGen' ? 'videoGen' : 'imageGen'))
const isVideo = computed(() => type.value === 'videoGen')
const node = computed(() => project.current?.canvas?.nodes.find((n) => n.id === props.id))
const boundRefs = computed(() => {
  const p = project.current
  const n = node.value
  if (!p || !n) return []
  return (n.data.referenceSourceNodeIds ?? [])
    .map((id) => canvasNodeOutputAssetId(p, p.canvas?.nodes.find((item) => item.id === id)))
    .filter((id): id is ID => Boolean(id))
})
const refs = computed(() => {
  const p = project.current
  return p && node.value ? resolvedCanvasReferenceAssetIds(p, node.value) : []
})
const outputId = computed(() => node.value?.data.outputAssetId || props.data.outputAssetId)
const hasAsset = computed(() => Boolean(outputId.value))
const generating = computed(() => isNodeRunning(props.id))
const title = computed(() => node.value?.data.label || (isVideo.value ? '视频' : '图片'))
const prompt = computed({
  get: () => node.value?.data.prompt ?? '',
  set: (v: string) => project.patchCanvasNode(props.id, { prompt: v })
})
const h3GenMode = computed({
  get: () => normalizeH3GenMode(node.value?.data.h3GenMode),
  set: (v: H3VideoGenMode) => {
    const patch: {
      h3GenMode: H3VideoGenMode
      firstFrameAssetId?: ID
      lastFrameAssetId?: ID
    } = { h3GenMode: v }
    if (v === 'fl2va') {
      if (!node.value?.data.firstFrameAssetId && refs.value[0]) patch.firstFrameAssetId = refs.value[0]
      if (!node.value?.data.lastFrameAssetId && refs.value[1]) patch.lastFrameAssetId = refs.value[1]
    }
    project.patchCanvasNode(props.id, patch)
  }
})
const firstFrameId = computed({
  get: () => node.value?.data.firstFrameAssetId,
  set: (v: ID | undefined) => project.patchCanvasNode(props.id, { firstFrameAssetId: v })
})
const lastFrameId = computed({
  get: () => node.value?.data.lastFrameAssetId,
  set: (v: ID | undefined) => project.patchCanvasNode(props.id, { lastFrameAssetId: v })
})
const videoModel = computed({
  get: () => normalizeVideoGenModel(node.value?.data.videoModel),
  set: (v: VideoGenModel) => applyShotVideoModel(props.id, v)
})
const videoResolution = computed({
  get: () => normalizeVideoResolution(node.value?.data.videoResolution, videoModel.value),
  set: (v: VideoResolution) => project.patchCanvasNode(props.id, { videoResolution: v })
})
const isH3Video = computed(() => isVideo.value && videoModel.value !== 'wan-prime')
const isH3Fl2va = computed(() => isH3Video.value && h3GenMode.value === 'fl2va')
const durationOptions = computed(() => videoDurationOptions(videoModel.value))
const duration = computed({
  get() {
    const raw = Math.round(Number(node.value?.data.duration) || 8)
    const opts = durationOptions.value
    if (opts.includes(raw)) return raw
    const min = opts[0] ?? 1
    const max = opts[opts.length - 1] ?? 15
    return Math.min(max, Math.max(min, raw))
  },
  set(v: number) {
    const opts = durationOptions.value
    const min = opts[0] ?? 1
    const max = opts[opts.length - 1] ?? 15
    project.patchCanvasNode(props.id, {
      duration: Math.min(max, Math.max(min, Math.round(Number(v) || min)))
    })
  }
})
const durOpen = ref<'' | 'bar' | 'foot'>('')

function pickDuration(n: number) {
  duration.value = n
  durOpen.value = ''
}
const genLabel = computed(() => (hasAsset.value ? '重绘' : isVideo.value ? '出视频' : '出图'))
const failMsg = computed(() =>
  node.value?.status === 'failed' ? node.value.error || '生成失败' : ''
)

const pageImageIds = computed(() => {
  const ids: ID[] = []
  const p = project.current
  if (!p) return ids
  for (const n of p.canvas?.nodes ?? []) {
    if (n.type === 'imageGen' && n.data.outputAssetId) ids.push(n.data.outputAssetId)
    for (const id of resolvedCanvasReferenceAssetIds(p, n)) ids.push(id)
  }
  return [...new Set(ids)]
})

const refUrls = ref<Record<string, string>>({})

async function loadMedia() {
  const id = outputId.value
  const seq = ++mediaSeq
  if (!id) {
    mediaUrl.value = ''
    posterUrl.value = ''
    return
  }
  const url = (await assets.getUrl(id)) || (await library.getUrl(id)) || ''
  if (seq !== mediaSeq) return
  mediaUrl.value = url
  if (isVideo.value && url) {
    const thumb = await assets.ensureThumb(id).catch(() => '')
    if (seq !== mediaSeq) return
    posterUrl.value = thumb || ''
  } else {
    posterUrl.value = ''
  }
}

watch(
  () => outputId.value,
  () => {
    loadMedia().catch(() => {})
  },
  { immediate: true }
)

watch(
  () => generating.value,
  (on, was) => {
    if (was && !on) loadMedia().catch(() => {})
  }
)

watch(
  () => refs.value.join(','),
  async () => {
    const next: Record<string, string> = {}
    for (const id of refs.value) {
      next[id] = (await assets.getUrl(id)) || (await library.getUrl(id)) || ''
    }
    refUrls.value = next
  },
  { immediate: true }
)

watch(
  () => props.selected,
  (on) => {
    panelOpen.value = Boolean(on)
    if (!on) {
      moreOpen.value = false
      durOpen.value = ''
    }
  },
  { immediate: true }
)

onMounted(() => {
  document.querySelectorAll('body > input[type="file"]').forEach((el) => el.remove())
})

onBeforeUnmount(() => {
  mediaSeq += 1
  mediaUrl.value = ''
  posterUrl.value = ''
})

function setRefs(ids: ID[]) {
  const max = videoModel.value === 'wan-prime' ? 10 : 9
  const inherited = new Set(boundRefs.value)
  const manual = [...new Set(ids)].filter((id) => !inherited.has(id))
  const next = manual.slice(0, Math.max(0, max - inherited.size))
  project.patchCanvasNode(props.id, {
    referenceAssetIds: next
  })
  updateNodeData(props.id, {
    ...props.data,
    referenceAssetIds: next,
    nodeType: type.value
  })
}

function previewRef(id: ID) {
  const url = refUrls.value[id]
  if (url) openLightbox(url, 'image')
}

function removeRef(id: ID, ev?: Event) {
  ev?.preventDefault()
  ev?.stopPropagation()
  project.removeCanvasNodeRef(props.id, id)
  const n = project.current?.canvas?.nodes.find((item) => item.id === props.id)
  updateNodeData(props.id, {
    ...props.data,
    referenceSourceNodeIds: n?.data.referenceSourceNodeIds ?? [],
    referenceAssetIds: n?.data.referenceAssetIds ?? [],
    nodeType: type.value
  })
  toast.success('已移除这张参考图')
}

async function onPickerConfirm(ids: ID[]) {
  pickerOpen.value = false
  if (!ids.length) return
  try {
    if (pickerMode.value === 'output') {
      const kind = isVideo.value ? 'video' : 'image'
      const asset = await assets.adopt(ids[0], kind, { projectId: project.current?.id })
      project.assignCanvasNodeAsset(props.id, asset.id)
      updateNodeData(props.id, {
        ...props.data,
        outputAssetId: asset.id,
        nodeType: type.value
      })
      await loadMedia()
      toast.success(isVideo.value ? '已选用该视频' : '已选用该图片')
      return
    }
    const resolved: ID[] = []
    for (const id of ids) {
      try {
        const copied = await assets.adopt(id, 'image', { projectId: project.current?.id })
        resolved.push(copied.id)
      } catch {
        resolved.push(id)
      }
    }
    setRefs([...refs.value, ...resolved])
  } catch (e: any) {
    toast.error(e?.message || '选用失败')
  }
}

function openRefPicker() {
  pickerMode.value = 'ref'
  pickerOpen.value = true
}

function openOutputPicker() {
  pickerMode.value = 'output'
  pickerOpen.value = true
}

function onEmptyClick() {
  if (generating.value) return
  if (props.selected && panelOpen.value) openOutputPicker()
}

function uploadRefs() {
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
  const added: ID[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    const asset = await assets.add(file, 'image', 'uploaded', {
      filename: file.name,
      projectId: project.current?.id
    })
    added.push(asset.id)
  }
  if (added.length) setRefs([...refs.value, ...added])
}

function togglePlay() {
  previewFull()
}

function previewFull() {
  if (!mediaUrl.value) return
  openLightbox(mediaUrl.value, isVideo.value ? 'video' : 'image', title.value)
}

async function generate() {
  if (generating.value) return
  if (!prompt.value.trim()) {
    toast.warn('请先写提示词')
    return
  }
  if (isVideo.value) {
    if (isH3Fl2va.value) {
      if (!firstFrameId.value && !refs.value[0]) {
        toast.warn('请先选首帧')
        return
      }
      if (!lastFrameId.value && !refs.value[1]) {
        toast.warn('请先选尾帧')
        return
      }
    } else if (!refs.value.length) {
      toast.warn('请先选至少一张参考图')
      return
    }
  }
  moreOpen.value = false
  durOpen.value = ''
  busyLabel.value = isVideo.value ? '出视频…' : '出图…'
  try {
    await runCanvasNode(props.id, (_id, msg) => {
      busyLabel.value = msg
    })
    if (outputId.value) {
      const n = project.current?.canvas?.nodes.find((item) => item.id === props.id)
      updateNodeData(props.id, {
        ...(n?.data ?? props.data),
        outputAssetId: outputId.value,
        nodeType: type.value
      })
    }
    await loadMedia()
    if (isVideo.value && !outputId.value) {
      toast.error('生成结束，但视频没有写进节点。请看节点上的红字错误。', 10000)
    } else {
      toast.success(isVideo.value ? '视频已生成' : '图片已生成')
    }
  } catch (e: unknown) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '生成失败', 10000)
  } finally {
    busyLabel.value = ''
  }
}

async function publish() {
  if (!outputId.value) return
  moreOpen.value = false
  try {
    await library.publishFrom(outputId.value, {
      filename: title.value,
      prompt: prompt.value
    })
    toast.success('已加入公共资产库')
  } catch (e: any) {
    toast.error(e?.message || '入库失败')
  }
}

async function downloadAsset() {
  if (!outputId.value) return
  const blob = await assets.getBlob(outputId.value)
  if (!blob) {
    toast.error('素材读取失败')
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.value}.${isVideo.value ? 'mp4' : 'png'}`
  a.click()
  URL.revokeObjectURL(url)
}

function copyPrompt() {
  const t = prompt.value.trim()
  if (!t) {
    toast.warn('没有提示词')
    return
  }
  navigator.clipboard.writeText(t).then(
    () => toast.success('已复制提示词'),
    () => toast.error('复制失败')
  )
  moreOpen.value = false
}

function duplicateSelf() {
  moreOpen.value = false
  durOpen.value = ''
  const nid = project.duplicateCanvasNode(props.id)
  if (!nid) {
    toast.warn('复制失败')
    return
  }
  toast.success('已复制节点')
  selectCanvasNode(nid)
}

function removeSelf() {
  moreOpen.value = false
  if (!confirm('删除这个节点？')) return
  project.removeCanvasNode(props.id)
}
</script>

<template>
  <div class="fnode" :class="[`kind-${type}`, { on: selected && panelOpen, empty: !hasAsset, busy: generating }]">
    <Handle id="in" type="target" :position="Position.Left" class="hndl" />

    <transition name="float-up">
      <div v-if="selected && panelOpen" class="toolbar-wrap nodrag nowheel" @mousedown.stop @click.stop>
        <div class="toolbar">
          <button type="button" :disabled="generating" @click="generate">
            <span>↺</span>{{ genLabel }}
          </button>
          <button type="button" :disabled="generating" title="选用已有资源，不重新生成" @click="openOutputPicker">
            <span>▣</span>选用
          </button>
          <button type="button" @click="duplicateSelf">
            <span>❐</span>复制
          </button>
          <div v-if="isVideo" class="dur-edit">
            <button type="button" class="dur-btn" @click="durOpen = durOpen === 'bar' ? '' : 'bar'">
              {{ duration }} 秒
            </button>
            <div v-if="durOpen === 'bar'" class="dur-menu">
              <button
                v-for="n in durationOptions"
                :key="'bar-' + n"
                type="button"
                :class="{ on: n === duration }"
                @mousedown.prevent.stop
                @click.stop="pickDuration(n)"
              >
                {{ n }} 秒
              </button>
            </div>
          </div>
          <button v-if="hasAsset" type="button" @click="downloadAsset">
            <span>⬇</span>下载
          </button>
          <button type="button" class="icon" title="更多" @click="moreOpen = !moreOpen">⋯</button>
          <button v-if="hasAsset" type="button" class="icon" title="全屏" @click="previewFull">⛶</button>
          <div v-if="moreOpen" class="more">
            <button type="button" @click="copyPrompt">复制提示词</button>
            <button type="button" @click="duplicateSelf">复制节点</button>
            <button v-if="!isVideo && hasAsset" type="button" @click="publish">加入公共资产库</button>
            <button type="button" @click="removeSelf">删除节点</button>
          </div>
        </div>
      </div>
    </transition>

    <div class="media" :style="{ aspectRatio: cssAspectRatio(project.current?.settings.aspectRatio) }">
      <template v-if="isVideo && mediaUrl">
        <img
          v-if="posterUrl"
          class="nodrag nowheel frame"
          :src="posterUrl"
          alt=""
          @click.stop="previewFull"
        />
        <div v-else class="ready">视频已生成</div>
        <button
          class="play-btn nodrag"
          type="button"
          title="播放"
          @click.stop="previewFull"
          @mousedown.stop
        >
          ▶
        </button>
      </template>
      <img
        v-else-if="mediaUrl"
        class="nodrag nowheel zoomable"
        :src="mediaUrl"
        alt=""
        @click.stop="previewFull"
      />
      <div
        v-else
        class="ph pick"
        :title="isVideo ? '选用已有视频' : '选用已有图片'"
        @click="onEmptyClick"
      >
        {{ isVideo ? '▶' : '＋' }}
      </div>
      <span v-if="isVideo && duration" class="dur-tag">{{ duration }}s</span>
      <NodeBusyOverlay v-if="generating" :label="busyLabel || (isVideo ? '出视频…' : '出图…')" />
      <div v-if="failMsg && !generating" class="fail" :title="failMsg">{{ failMsg }}</div>
    </div>

    <div class="name">
      <span class="kind">{{
        isVideo
          ? videoModel === 'wan-prime'
            ? '图生视频 · 万相'
            : videoModel === 'h3-v5'
              ? '图生视频 · H3 10s 1080p'
              : '图生视频 · H3 15s'
          : '图片生成'
      }}</span>
      <span class="title">{{ title }}</span>
    </div>

    <transition name="float-down">
      <div
        v-if="selected && panelOpen"
        class="prompt nodrag nowheel"
        @pointerdown.stop
        @mousedown.stop
        @click.stop
      >
        <H3GenModeSelect v-if="isH3Video" v-model="h3GenMode" />
        <FramePairSlots
          v-if="isH3Fl2va"
          v-model:first-id="firstFrameId"
          v-model:last-id="lastFrameId"
        />
        <div v-else class="refs">
          <div v-for="id in refs" :key="id" class="thumb nodrag nopan nowheel">
            <button type="button" class="thumb-preview nodrag" title="查看大图" @pointerdown.stop @click.stop="previewRef(id)">
              <img v-if="refUrls[id]" :src="refUrls[id]" alt="" />
            </button>
            <button
              type="button"
              class="thumb-del nodrag nopan nowheel"
              title="移除这张参考图"
              @pointerdown.stop.prevent="removeRef(id, $event)"
            >
              ×
            </button>
          </div>
          <button type="button" class="add nodrag" title="上传参考图" @click="uploadRefs">＋</button>
          <button type="button" class="add nodrag" title="从本页或资产库选择参考图" @click="openRefPicker">库</button>
        </div>
        <textarea
          v-model="prompt"
          rows="6"
          :placeholder="
            isVideo
              ? videoModel === 'wan-prime'
                ? '写视频提示词。多张参考图时可用图1、图2指代人物/场景…'
                : '写视频提示词，描述动作、镜头和声音…'
              : '写提示词，可加参考图做图生图…'
          "
        />
        <AspectRatioSeg compact />
        <VideoResolutionSeg
          v-if="isVideo && videoAllows1080p(videoModel) && !isH3Fl2va"
          v-model="videoResolution"
          compact
        />
        <div class="prompt-foot">
          <ImageModelSelect v-if="!isVideo" />
          <VideoModelSelect v-else v-model="videoModel" />
          <div v-if="isVideo" class="dur-edit">
            <button type="button" class="dur-btn" @click="durOpen = durOpen === 'foot' ? '' : 'foot'">
              {{ duration }} 秒
            </button>
            <div v-if="durOpen === 'foot'" class="dur-menu">
              <button
                v-for="n in durationOptions"
                :key="'foot-' + n"
                type="button"
                :class="{ on: n === duration }"
                @mousedown.prevent.stop
                @click.stop="pickDuration(n)"
              >
                {{ n }} 秒
              </button>
            </div>
          </div>
          <button class="go" type="button" :disabled="generating" :title="genLabel" @click="generate">↑</button>
        </div>
      </div>
    </transition>

    <Handle id="out" type="source" :position="Position.Right" class="hndl" />

    <AssetPicker
      :open="pickerOpen"
      :kind="pickerMode === 'output' && isVideo ? 'video' : 'image'"
      :multiple="pickerMode === 'ref'"
      :title="
        pickerMode === 'output'
          ? isVideo
            ? '选用已有视频作为本节点结果'
            : '选用已有图片作为本节点结果'
          : isVideo
            ? videoModel === 'wan-prime'
              ? '选择参考图（最多 10 张，提示词里可用图1、图2）'
              : '选择参考图（本页或公共库）'
            : '选择参考图'
      "
      :page-ids="pickerMode === 'ref' ? pageImageIds : undefined"
      :show-library="pickerMode === 'ref' || !isVideo"
      :default-tab="pickerMode === 'output' ? 'page' : undefined"
      :selected-ids="pickerMode === 'output' && outputId ? [outputId] : []"
      @close="pickerOpen = false"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<style scoped>
.fnode {
  position: relative;
  width: 240px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-node-border);
  border-radius: 12px;
  overflow: visible;
  color: var(--color-text-1);
  box-shadow: var(--shadow-node);
}
.fnode.on {
  border-color: var(--color-text-1);
  box-shadow: 0 0 0 1px var(--color-text-1), var(--shadow-md);
  z-index: 4;
}
.fnode.busy {
  border-color: var(--color-accent);
  z-index: 5;
}
.toolbar-wrap {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  z-index: 6;
  transform-origin: 50% 100%;
}
.toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 10px;
  background: #2a2a32;
  color: var(--color-text-1);
  border: 1px solid var(--color-border);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
}
.toolbar > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-1);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.toolbar > button span {
  font-size: 11px;
  opacity: 0.7;
}
.toolbar > button:hover:not(:disabled) {
  background: var(--color-fill-hover);
}
.toolbar > button:disabled {
  opacity: 0.35;
  cursor: default;
}
.toolbar > button.icon {
  width: 30px;
  justify-content: center;
  padding: 6px 0;
}
.more {
  position: absolute;
  top: calc(100% + 4px);
  right: 4px;
  min-width: 148px;
  padding: 4px;
  border-radius: 8px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
}
.more button {
  display: block;
  width: 100%;
  margin: 0;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 12px;
  color: var(--color-text-1);
  cursor: pointer;
}
.more button:hover {
  background: var(--color-fill-hover);
}
.media {
  position: relative;
  width: 100%;
  background: var(--color-node-well);
  overflow: hidden;
  border-radius: 12px 12px 0 0;
}
.media img,
.media video,
.media .frame {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.ready {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-3);
  font-size: 12px;
  font-weight: 650;
}
.fail {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 7;
  padding: 6px 8px;
  background: rgba(180, 40, 40, 0.92);
  color: #fff;
  font-size: 11px;
  line-height: 1.35;
  font-weight: 650;
  max-height: 46%;
  overflow: auto;
}
.play-btn {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 2;
  width: 44px;
  height: 44px;
  margin: 0;
  padding: 0 0 2px 3px;
  border: none;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.play-btn:hover {
  background: var(--color-accent);
}
.ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-4);
  font-size: 18px;
}
.ph.pick {
  cursor: pointer;
}
.dur-tag {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 10px;
}
.name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 10px;
}
.kind {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-text-4);
  letter-spacing: 0.04em;
}
.title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prompt {
  position: absolute;
  left: 0;
  top: calc(100% + 8px);
  z-index: 5;
  width: 420px;
  min-width: 280px;
  transform-origin: 0 0;
  overflow: visible;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.refs {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 8px;
  padding-top: 2px;
  overflow: visible;
}
.thumb {
  position: relative;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  z-index: 2;
  overflow: visible;
  pointer-events: auto;
}
.thumb-preview,
.add {
  width: 48px;
  height: 48px;
  margin: 0;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  overflow: hidden;
  background: var(--color-bg-2);
  color: var(--color-text-3);
  cursor: pointer;
  pointer-events: auto;
}
.add {
  width: 36px;
  height: 36px;
  font-size: 16px;
  align-self: flex-start;
}
.thumb-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.thumb-del {
  position: absolute;
  top: -6px;
  right: -6px;
  z-index: 8;
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
.thumb-del:hover {
  background: #c63c41;
}
.prompt textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 13px;
  line-height: 1.55;
  font-family: inherit;
}
.prompt-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.dur-edit {
  position: relative;
  flex: 0 0 auto;
}
.dur-btn {
  display: block;
  height: 28px;
  min-width: 76px;
  margin: 0;
  padding: 0 26px 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background-color: var(--color-bg-2);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%23f5f5fa' d='M1.2 1.2L6 6l4.8-4.8' stroke='%23f5f5fa' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
  color: var(--color-text-1);
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  outline: none;
}
.dur-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 4px);
  z-index: 8;
  min-width: 88px;
  max-height: 220px;
  overflow: auto;
  padding: 4px;
  border-radius: 8px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.45);
}
.dur-menu button {
  display: block;
  width: 100%;
  margin: 0;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 12px;
  font-weight: 650;
  color: var(--color-text-1);
  cursor: pointer;
}
.dur-menu button:hover,
.dur-menu button.on {
  background: var(--color-fill-hover);
}
.dur-menu-down {
  bottom: auto;
  top: calc(100% + 4px);
}
.go {
  width: 28px;
  height: 28px;
  margin-left: auto;
  border: none;
  border-radius: 50%;
  background: #ececef;
  color: #111;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.go:disabled {
  opacity: 0.4;
}
.hndl {
  width: 8px;
  height: 8px;
  background: var(--color-accent);
  border: 1px solid #fff;
}
.float-up-enter-active,
.float-up-leave-active,
.float-down-enter-active,
.float-down-leave-active {
  transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.float-up-enter-from,
.float-up-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}
.float-down-enter-from,
.float-down-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
