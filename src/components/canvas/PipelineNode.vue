<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useAssetsStore, useLibraryStore, useProjectStore, useSettingsStore, useToastStore } from '@/stores'
import { runCanvasNode, optimizeShotVideoPrompt, regenerateShotFrame, grabVideoLastFrameNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { needsPlayReview } from '@/services/canvas/playGate'
import { cssAspectRatio } from '@/services/canvas/layout'
import { applyShotVideoModel, applyShotVideoProfile } from '@/services/canvas/videoModel'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { stillModeFromNode } from '@/utils/videoStill'
import { inspectCanvasNode } from '@/services/canvas/canvasBridge'
import { openLightbox } from '@/composables/useLightbox'
import ShotRefStrip from '@/components/canvas/ShotRefStrip.vue'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'
import AssetPicker from '@/components/common/AssetPicker.vue'
import ParamSelect from '@/components/common/ParamSelect.vue'
import ImageModelSelect from '@/components/settings/ImageModelSelect.vue'
import VideoModelSelect from '@/components/settings/VideoModelSelect.vue'
import H3GenModeSelect from '@/components/settings/H3GenModeSelect.vue'
import FramePairSlots from '@/components/canvas/FramePairSlots.vue'
import AspectRatioSeg from '@/components/common/AspectRatioSeg.vue'
import VideoResolutionSeg from '@/components/common/VideoResolutionSeg.vue'
import CanvasToolbarIcon from '@/components/canvas/CanvasToolbarIcon.vue'
import { canBuildExport } from '@/utils/timeline'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'
import { fillEmptyGeneratePrompt, shotFrameSendPrompt } from '@/utils/nodePrompt'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import { clampRect, cropContainedImage, trimVideoBlob, type NormRect } from '@/utils/mediaEdit'
import {
  normalizeH3GenMode,
  normalizeVideoGenModel,
  normalizeVideoResolution,
  videoAllows1080p,
  videoDurationOptions,
  videoMaxSeconds,
  videoMinSeconds,
  type AspectRatio,
  type CanvasNodeType,
  type H3VideoGenMode,
  type ID,
  type VideoGenModel,
  type VideoResolution
} from '@/types'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    subjectId?: string
    sceneId?: string
    shotId?: string
    label?: string
    nodeType?: CanvasNodeType
  }
}>()

const type = computed<CanvasNodeType>(() => props.data.nodeType || 'script')

const project = useProjectStore()
const router = useRouter()
const assets = useAssetsStore()
const library = useLibraryStore()
const settings = useSettingsStore()
const toast = useToastStore()
const mediaUrl = ref('')
const videoUrl = ref('')
const videoEl = ref<HTMLVideoElement | null>(null)
const audioEl = ref<HTMLAudioElement | null>(null)
const mediaBox = ref<HTMLElement | null>(null)
const playing = ref(false)
const playbackDuration = ref(0)
const moreOpen = ref(false)
const panelOpen = ref(false)
const pickerOpen = ref(false)
const toolBusy = ref('')
const optimizingPrompt = ref(false)
const cropOn = ref(false)
const trimOn = ref(false)
const crop = ref<NormRect>({ x: 0.08, y: 0.08, w: 0.84, h: 0.84 })
const trimStart = ref(0)
const trimEnd = ref(5)
let drag: { kind: string; x: number; y: number; start: NormRect } | null = null

const nodeMeta = computed(() => project.current?.canvas?.nodes.find((n) => n.id === props.id))
const shot = computed(() =>
  props.data.shotId ? project.current?.shots.find((s) => s.id === props.data.shotId) : undefined
)
const subject = computed(() =>
  props.data.subjectId
    ? (project.current?.subjects ?? []).find((s) => s.id === props.data.subjectId)
    : undefined
)
const scene = computed(() =>
  props.data.sceneId
    ? (project.current?.scenes ?? []).find((s) => s.id === props.data.sceneId)
    : undefined
)

/* ── 角色卡语音：音色描述 + 可选参考音频 ── */
const voicePromptText = computed({
  get: () => subject.value?.voicePrompt ?? '',
  set: (v: string) => {
    if (subject.value) project.updateSubject(subject.value.id, { voicePrompt: v })
  }
})
const voiceRefUrl = ref('')
const voiceRefName = ref('')
const voiceRefPlaying = ref(false)
const voiceRefEl = ref<HTMLAudioElement | null>(null)
const voiceFileInput = ref<HTMLInputElement | null>(null)
const voiceUploading = ref(false)

const subjectKindText = computed(() => {
  const k = subject.value?.kind
  if (k === 'person') return '人物'
  if (k === 'animal') return '动物'
  if (k === 'other') return '物体'
  return ''
})

const voiceSummary = computed(() => {
  const s = subject.value
  if (!s) return ''
  if (s.clonedVoiceId) return '音色已复刻'
  if (s.voiceRefAssetId) return '参考音频已上传'
  const vp = s.voicePrompt?.trim()
  if (vp) return vp.length > 20 ? `${vp.slice(0, 20)}…` : vp
  return '未设置语音'
})
const voiceConfigured = computed(() => {
  const s = subject.value
  return Boolean(s?.clonedVoiceId || s?.voiceRefAssetId || s?.voicePrompt?.trim())
})

watch(
  () => subject.value?.voiceRefAssetId,
  async (id) => {
    voiceRefPlaying.value = false
    if (!id) {
      voiceRefUrl.value = ''
      voiceRefName.value = ''
      return
    }
    voiceRefUrl.value = (await assets.getUrl(id)) || ''
    voiceRefName.value = assets.getMeta(id)?.filename || '参考音频'
  },
  { immediate: true }
)

function pickVoiceRef() {
  voiceFileInput.value?.click()
}

async function onVoiceRefChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !subject.value) return
  if (file.size > 10 * 1024 * 1024) {
    toast.error('参考音频不能超过 10 MB')
    return
  }
  voiceUploading.value = true
  try {
    const asset = await assets.add(file, 'audio', 'uploaded', {
      filename: file.name,
      projectId: project.current?.id
    })
    // 换了样本，之前复刻的音色作废
    project.updateSubject(subject.value.id, {
      voiceRefAssetId: asset.id,
      clonedVoiceId: undefined,
      clonedVoiceModel: undefined
    })
    await project.save()
    toast.success('参考音频已上传，生成口播时会自动复刻音色')
  } catch (e: any) {
    toast.error(e?.message || '上传失败')
  } finally {
    voiceUploading.value = false
  }
}

function removeVoiceRef() {
  if (!subject.value) return
  project.updateSubject(subject.value.id, {
    voiceRefAssetId: undefined,
    clonedVoiceId: undefined,
    clonedVoiceModel: undefined
  })
}

async function toggleVoiceRefPlay(ev: Event) {
  ev.stopPropagation()
  const a = voiceRefEl.value
  if (!a) return
  if (a.paused) {
    try {
      await a.play()
      voiceRefPlaying.value = true
    } catch {
      /* ignore */
    }
  } else {
    a.pause()
    voiceRefPlaying.value = false
  }
}

const durationLabel = computed(() => {
  const meta = assetId.value ? assets.getMeta(assetId.value) : undefined
  const actual =
    playbackDuration.value ||
    (meta && 'duration' in meta && Number(meta.duration) > 0 ? Number(meta.duration) : 0)
  const d = actual > 0 ? actual : shot.value?.duration
  if (!d || d <= 0) return ''
  return Number.isInteger(d) ? `${d}s` : `${Number(d).toFixed(1)}s`
})

const title = computed(() => {
  if (type.value === 'script') return project.current?.script?.topic || project.current?.name || '文案'
  if (subject.value) return subject.value.name
  if (scene.value) return scene.value.name
  if (shot.value) return `${shot.value.index + 1}. ${shot.value.title}`
  if (type.value === 'export') return '合成视频'
  if (type.value === 'final') return '视频预览'
  return props.data.label || type.value
})

const kindLabel = computed(() => {
  if (type.value === 'subject') return '四视图'
  if (type.value === 'sceneProps') return '关键道具'
  if (type.value === 'scene') return '锚点图'
  if (type.value === 'shotBoard') return '看板'
  if (type.value === 'shotImage') return videoRequiresStoryboard(project.current) ? '配图' : '四宫格'
  if (type.value === 'shotFrames') return '首尾帧'
  if (type.value === 'shotVideo') return '视频'
  if (type.value === 'audio') return '口播'
  if (type.value === 'export') return '合成'
  if (type.value === 'final') return '预览'
  return ''
})

const assetId = computed(() => {
  const p = project.current
  if (!p) return undefined
  if (type.value === 'final') return p.finalVideoAssetId
  if (type.value === 'subject') return subject.value?.designSheetAssetId
  if (type.value === 'sceneProps') return scene.value?.propSheetAssetId
  if (type.value === 'scene') return scene.value?.plateAssetId
  if (!shot.value) return undefined
  if (type.value === 'shotBoard') return shot.value.boardAssetId
  if (type.value === 'shotImage') return shot.value.imageAssetId
  // 首尾帧节点有两张产出，单图预览取起始帧
  if (type.value === 'shotFrames') return shot.value.firstFrameAssetId || shot.value.lastFrameAssetId
  if (type.value === 'shotVideo') return shot.value.videoAssetId
  if (type.value === 'audio') return shot.value.audioAssetId
  return undefined
})

const mediaAspect = computed(() => {
  if (type.value === 'subject' || type.value === 'sceneProps' || type.value === 'scene') {
    return cssAspectRatio('16:9')
  }
  if (type.value === 'audio' || type.value === 'export') return '16 / 10'
  return cssAspectRatio(nodeAspectRatio.value)
})

const status = computed(() => nodeMeta.value?.status ?? 'idle')
const generating = computed(() => isNodeRunning(props.id))
// 首尾帧要两张都画出来才算完成，只有起始帧时节点仍显示未生成
const hasAsset = computed(() =>
  type.value === 'shotFrames'
    ? Boolean(shot.value?.firstFrameAssetId && shot.value?.lastFrameAssetId)
    : Boolean(assetId.value)
)
const gateBlocked = computed(
  () =>
    type.value !== 'script' &&
    type.value !== 'export' &&
    type.value !== 'final' &&
    needsPlayReview(project.current)
)

const isVideoNode = computed(() => type.value === 'shotVideo' || type.value === 'final')
const isFrameNode = computed(() => type.value === 'shotFrames')
const isImageNode = computed(
  () =>
    type.value === 'shotImage' ||
    type.value === 'shotBoard' ||
    type.value === 'subject' ||
    type.value === 'sceneProps' ||
    type.value === 'scene'
)
const videoModel = computed({
  get: () => normalizeVideoGenModel(nodeMeta.value?.data.videoModel),
  set: (v: VideoGenModel) => applyShotVideoModel(props.id, v)
})
const videoResolution = computed({
  get: () => normalizeVideoResolution(nodeMeta.value?.data.videoResolution, videoModel.value),
  set: (v: VideoResolution) => project.patchCanvasNode(props.id, { videoResolution: v })
})
const nodeAspectRatio = computed({
  get: () => nodeMeta.value?.data.aspectRatio ?? project.current?.settings.aspectRatio ?? '16:9',
  set: (v: AspectRatio) => {
    project.patchCanvasNode(props.id, { aspectRatio: v })
    if (type.value === 'shotVideo' && shot.value) project.invalidateShotAssets(shot.value.id, 'video')
    else if ((type.value === 'shotImage' || type.value === 'shotBoard') && shot.value) {
      project.invalidateShotAssets(shot.value.id, 'image')
    }
  }
})
const h3GenMode = computed({
  get: () => normalizeH3GenMode(shot.value?.h3GenMode),
  set: (v: H3VideoGenMode) => {
    if (shot.value) project.updateShot(shot.value.id, { h3GenMode: v })
  }
})
const firstFrameId = computed({
  get: () => shot.value?.firstFrameAssetId,
  set: (v: ID | undefined) => {
    if (shot.value) project.updateShot(shot.value.id, { firstFrameAssetId: v })
  }
})
const lastFrameId = computed({
  get: () => shot.value?.lastFrameAssetId,
  set: (v: ID | undefined) => {
    if (shot.value) project.updateShot(shot.value.id, { lastFrameAssetId: v })
  }
})
const isH3VideoNode = computed(() => type.value === 'shotVideo' && videoModel.value !== 'wan-prime')
const isH3Fl2va = computed(() => isH3VideoNode.value && h3GenMode.value === 'fl2va')
const videoStillHint = computed(() => {
  if (type.value !== 'shotVideo') return ''
  const mode = stillModeFromNode(nodeMeta.value)
  if (mode === 'identity') return '只传人设和场景'
  if (mode === 'keyframe') return '需四宫格关键帧'
  return '需故事看板'
})
const showPrompt = computed(
  () =>
    type.value === 'shotImage' ||
    type.value === 'shotBoard' ||
    type.value === 'shotFrames' ||
    type.value === 'shotVideo' ||
    type.value === 'subject' ||
    type.value === 'sceneProps' ||
    type.value === 'scene' ||
    type.value === 'audio'
)

/** 首尾帧的两张图各有一个 URL，节点上并排显示 */
const frameUrls = ref({ start: '', end: '' })
async function loadFrames() {
  const s = shot.value
  if (!s) {
    frameUrls.value = { start: '', end: '' }
    return
  }
  const [a, b] = await Promise.all([
    s.firstFrameAssetId ? assets.getUrl(s.firstFrameAssetId) : Promise.resolve(undefined),
    s.lastFrameAssetId ? assets.getUrl(s.lastFrameAssetId) : Promise.resolve(undefined)
  ])
  frameUrls.value = { start: a || '', end: b || '' }
}

const extraRefIds = computed({
  get(): ID[] {
    if (type.value === 'subject') return subject.value?.referenceAssetIds ?? []
    if (type.value === 'sceneProps') return scene.value?.propReferenceAssetIds ?? []
    if (type.value === 'scene') return scene.value?.referenceAssetIds ?? []
    return []
  },
  set(ids: ID[]) {
    if (type.value === 'subject' && subject.value) {
      project.updateSubject(subject.value.id, { referenceAssetIds: ids })
    } else if (type.value === 'sceneProps' && scene.value) {
      project.updateScene(scene.value.id, { propReferenceAssetIds: ids })
    } else if (type.value === 'scene' && scene.value) {
      project.updateScene(scene.value.id, { referenceAssetIds: ids })
    }
  }
})

const promptValue = computed({
  get() {
    const p = project.current
    if (!p) return ''
    if (type.value === 'subject' && subject.value) return subject.value.sheetPrompt ?? ''
    if (type.value === 'sceneProps' && scene.value) return scene.value.propSheetPrompt ?? ''
    if (type.value === 'scene' && scene.value) return scene.value.platePrompt ?? ''
    if (type.value === 'shotBoard' && shot.value) return shot.value.boardPrompt ?? ''
    if (type.value === 'shotImage' && shot.value) return shot.value.imagePrompt ?? ''
    if (type.value === 'shotVideo' && shot.value) return shot.value.compiledVideoPrompt ?? ''
    if (type.value === 'audio') return shot.value?.voiceover || ''
    return ''
  },
  set(v: string) {
    if (type.value === 'subject' && subject.value) project.updateSubject(subject.value.id, { sheetPrompt: v })
    else if (type.value === 'sceneProps' && scene.value) {
      project.updateScene(scene.value.id, { propSheetPrompt: v })
    }
    else if (type.value === 'scene' && scene.value) project.updateScene(scene.value.id, { platePrompt: v })
    else if (type.value === 'shotBoard' && shot.value) project.updateShot(shot.value.id, { boardPrompt: v })
    else if (type.value === 'shotImage' && shot.value) project.updateShot(shot.value.id, { imagePrompt: v })
    else if (type.value === 'shotVideo' && shot.value) project.setShotVideoPrompt(shot.value.id, v)
    else if (type.value === 'audio' && shot.value) project.updateShot(shot.value.id, { voiceover: v })
  }
})

const promptHint = computed(() => {
  if (type.value === 'audio') return '改口播后重新合成配音'
  if (type.value === 'shotVideo') return '这里完全由你编辑。清空后不会回填；可自己填写，或主动点“优化提示词 / 按分镜重铺”。'
  return '这里就是实际发出去的全文。改完原样发送，不会再背后加词。'
})

const metaLine = computed(() => {
  const ar = nodeAspectRatio.value
  const w = project.current?.settings.width ?? 1280
  const h = project.current?.settings.height ?? 720
  if (type.value === 'shotVideo') return `MiniMax H3 · ${ar}`
  if (type.value === 'audio') {
    if (!shot.value) return '口播'
    return effectiveShotAudioMode(shot.value) === 'tts' ? '后期 TTS' : 'H3 人声'
  }
  const model = settings.config.image.model || '出图'
  return `${model} · ${ar} · ${w}×${h}`
})

const genLabel = computed(() => {
  if (gateBlocked.value) return '先验收剧本'
  const again = hasAsset.value
  if (type.value === 'subject') return again ? '重新生成' : '生成四视图'
  if (type.value === 'sceneProps') return again ? '重新生成' : '生成关键道具图'
  if (type.value === 'scene') return again ? '重新生成' : '生成锚点图'
  if (type.value === 'shotBoard') return again ? '重新生成' : '生成看板'
  if (type.value === 'shotImage') {
    return again ? '重新生成' : videoRequiresStoryboard(project.current) ? '生成配图' : '生成四宫格'
  }
  if (type.value === 'shotFrames') return again ? '重画首尾帧' : '画首尾帧'
  if (type.value === 'shotVideo') return again ? '重新生成' : '生成视频'
  if (type.value === 'audio') {
    if (!shot.value || !needsExternalTts(shot.value, project.current)) return ''
    return again ? '重新生成' : '生成口播'
  }
  if (type.value === 'export' || type.value === 'final') {
    return again || project.current?.finalVideoAssetId ? '重新合成' : '合成视频'
  }
  return again ? '重新生成' : '生成'
})

const { findNode, removeSelectedNodes } = useVueFlow()

watch(assetId, () => loadMedia(), { immediate: true })
watch(
  () => [shot.value?.firstFrameAssetId, shot.value?.lastFrameAssetId],
  () => {
    if (type.value === 'shotFrames') void loadFrames()
  },
  { immediate: true }
)
watch(
  // 必须把每一项作为独立 source。若用 getter 每次返回一个新数组，回写提示词后
  // 即使数组内容完全相同也会被判定为变化，从而递归触发本 watcher。
  [
    () => props.selected,
    () => type.value,
    () => shot.value?.id,
    () => subject.value?.id,
    () => scene.value?.id
  ],
  ([on]) => {
    panelOpen.value = Boolean(on)
    if (!on) {
      moreOpen.value = false
      cropOn.value = false
      trimOn.value = false
    }
    const p = project.current
    const t = type.value
    if (!p) return
    if (t === 'subject' && subject.value) {
      const patch = fillEmptyGeneratePrompt('subject', p, subject.value)
      if (patch) project.updateSubject(subject.value.id, patch)
    } else if (t === 'scene' && scene.value) {
      const patch = fillEmptyGeneratePrompt('scene', p, scene.value)
      if (patch) project.updateScene(scene.value.id, patch)
    } else if (t === 'sceneProps' && scene.value) {
      const patch = fillEmptyGeneratePrompt('sceneProps', p, scene.value)
      if (patch) project.updateScene(scene.value.id, patch)
    } else if (t === 'shotBoard' && shot.value) {
      const patch = fillEmptyGeneratePrompt('shotBoard', p, shot.value)
      if (patch) project.updateShot(shot.value.id, patch)
    } else if (t === 'shotImage' && shot.value) {
      const patch = fillEmptyGeneratePrompt('shotImage', p, shot.value)
      if (patch) project.updateShot(shot.value.id, patch)
    }
  },
  { immediate: true }
)

const durationOptions = computed(() => videoDurationOptions(videoModel.value))

const shotDurationValue = computed(() =>
  Math.min(
    videoMaxSeconds(videoModel.value),
    Math.max(videoMinSeconds(videoModel.value), Math.round(Number(shot.value?.duration) || 5))
  )
)

function setShotDuration(raw: number) {
  if (!shot.value) return
  const min = videoMinSeconds(videoModel.value)
  const max = videoMaxSeconds(videoModel.value)
  const d = Math.min(max, Math.max(min, Math.round(Number(raw) || shot.value.duration || min)))
  project.updateShot(shot.value.id, { duration: d })
}

/** 只重画一张帧（起始帧或结束帧），另一张不动 */
async function redrawFrame(which: 'start' | 'end') {
  if (generating.value || toolBusy.value || !shot.value) return
  moreOpen.value = false
  try {
    await regenerateShotFrame(
      shot.value,
      which,
      (msg) => {
        toolBusy.value = msg
      },
      undefined
    )
    await loadFrames()
    toast.success(which === 'start' ? '起始帧已重画' : '结束帧已重画')
  } catch (e: any) {
    toast.error(friendlyAiError(e) || '重画失败')
  } finally {
    toolBusy.value = ''
  }
}

const startFramePromptValue = computed({
  get() {
    const s = shot.value
    if (!s || !project.current) return ''
    return s.startFramePrompt?.trim() || shotFrameSendPrompt(s, project.current, 'start')
  },
  set(v: string) {
    if (shot.value) project.updateShot(shot.value.id, { startFramePrompt: v })
  }
})
const endFramePromptValue = computed({
  get() {
    const s = shot.value
    if (!s || !project.current) return ''
    return s.endFramePrompt?.trim() || shotFrameSendPrompt(s, project.current, 'end')
  },
  set(v: string) {
    if (shot.value) project.updateShot(shot.value.id, { endFramePrompt: v })
  }
})

function dismissPanel() {
  moreOpen.value = false
  cropOn.value = false
  trimOn.value = false
  panelOpen.value = false
  const n = findNode(props.id)
  if (n) removeSelectedNodes([n])
}

async function publishToLibrary() {
  if (!assetId.value || !isImageNode.value) return
  moreOpen.value = false
  try {
    const meta = assets.getMeta(assetId.value)
    await library.publishFrom(assetId.value, {
      filename: meta?.filename || title.value,
      prompt: promptValue.value
    })
    toast.success('已加入公共资产库')
  } catch (e: any) {
    toast.error(e?.message || '入库失败')
  }
}

async function loadMedia() {
  const id = assetId.value
  playing.value = false
  playbackDuration.value = 0
  if (!id) {
    mediaUrl.value = ''
    videoUrl.value = ''
    return
  }
  if (type.value === 'shotVideo' || type.value === 'final') {
    videoUrl.value = (await assets.getUrl(id)) || ''
    mediaUrl.value = (await assets.ensureThumb(id)) || videoUrl.value
  } else {
    videoUrl.value = ''
    mediaUrl.value = (await assets.getUrl(id)) || ''
  }
  // 首尾帧有两张图，跟着一起刷新
  if (type.value === 'shotFrames') await loadFrames()
}

defineExpose({ loadMedia })

async function optimizePrompt(ev?: Event) {
  ev?.stopPropagation()
  if (type.value !== 'shotVideo' || !shot.value || optimizingPrompt.value || generating.value) return
  optimizingPrompt.value = true
  try {
    await optimizeShotVideoPrompt(shot.value)
    toast.success('已按 H3 格式优化提示词')
  } catch (e: any) {
    toast.error(friendlyAiError(e) || '优化失败')
  } finally {
    optimizingPrompt.value = false
  }
}

async function generateThis(ev?: Event, hd = false) {
  ev?.stopPropagation()
  if (generating.value || gateBlocked.value || toolBusy.value) return
  if ((type.value === 'export' || type.value === 'final') && !canBuildExport(project.current)) {
    toast.warn('还没有可导出的视频或图片，请先生成分镜视频')
    return
  }
  if (type.value === 'export' || type.value === 'final') {
    dismissPanel()
    await router.push('/edit')
    return
  }
  moreOpen.value = false
  dismissPanel()
  try {
    await runCanvasNode(
      props.id,
      (_id, msg) => {
        toolBusy.value = msg
      },
      undefined,
      hd ? { hd: true } : undefined
    )
    await loadMedia()
    if (hd) toast.success('已按更高分辨率重新生成')
  } catch (e: any) {
    // 节点上只有一个小红点，失败原因必须直接弹出来，否则表现为「点了生成，什么都没出来」
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '生成失败')
  } finally {
    toolBusy.value = ''
  }
}

function onLoadedMetadata(ev: Event) {
  const v = ev.target as HTMLVideoElement
  if (v && Number.isFinite(v.duration) && v.duration > 0) {
    playbackDuration.value = v.duration
    if (trimOn.value) trimEnd.value = Number(v.duration.toFixed(2))
  }
}

function currentMedia(): HTMLMediaElement | null {
  if (isVideoNode.value) return videoEl.value
  if (type.value === 'audio') return audioEl.value
  return null
}

async function togglePlay(ev: Event) {
  ev.stopPropagation()
  const v = currentMedia()
  if (!v) return
  if (v.paused) {
    try {
      v.muted = false
      await v.play()
      playing.value = true
    } catch {
      if (type.value === 'shotVideo') {
        try {
          v.muted = true
          await v.play()
          playing.value = true
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    v.pause()
    playing.value = false
  }
}

function onVideoPlay() {
  playing.value = true
}
function onVideoPause() {
  const v = videoEl.value
  if (!v || v.ended) playing.value = false
}
function bufferedEnd(v: HTMLVideoElement) {
  try {
    if (v.buffered.length === 0) return 0
    return v.buffered.end(v.buffered.length - 1)
  } catch {
    return 0
  }
}
function onVideoEnded() {
  const v = videoEl.value
  if (v) {
    const dur = Number.isFinite(v.duration) ? v.duration : 0
    const buf = bufferedEnd(v)
    if (buf > v.currentTime + 0.2 || (dur > 0 && v.currentTime < dur - 0.35 && buf > v.currentTime + 0.05)) {
      v.play().catch(() => {})
      return
    }
    v.currentTime = 0
  }
  playing.value = false
}
function onCanPlay() {
  const v = currentMedia()
  if (playing.value && v?.paused && !v.ended) v.play().catch(() => {})
}
function onAudioEnded() {
  playing.value = false
  if (audioEl.value) audioEl.value.currentTime = 0
}

function startCrop() {
  if (!hasAsset.value) {
    toast.warn('先生成图片再裁剪')
    return
  }
  trimOn.value = false
  cropOn.value = true
  crop.value = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 }
}

/** 截取视频最后一帧 → 在视频旁边落一个图片节点，可以拿去当下一镜首帧或参考图 */
async function grabLastFrame() {
  if (toolBusy.value) return
  if (!assetId.value) {
    toast.warn('先生成视频再截取尾帧')
    return
  }
  cropOn.value = false
  trimOn.value = false
  toolBusy.value = '截取尾帧…'
  try {
    await grabVideoLastFrameNode(props.id, (msg) => {
      toolBusy.value = msg
    })
    toast.success('尾帧已截出，放在视频右侧的图片节点里')
  } catch (e: any) {
    toast.error(e?.message || '截取尾帧失败')
  } finally {
    toolBusy.value = ''
  }
}

function startTrim() {
  if (!videoUrl.value) {
    toast.warn('先生成视频再剪辑')
    return
  }
  cropOn.value = false
  const dur = playbackDuration.value || shot.value?.duration || 5
  trimStart.value = 0
  trimEnd.value = Number(dur.toFixed(2))
  trimOn.value = true
  if (videoEl.value) videoEl.value.currentTime = 0
}

function onCropDown(kind: string, ev: PointerEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  const box = mediaBox.value
  if (!box) return
  drag = { kind, x: ev.clientX, y: ev.clientY, start: { ...crop.value } }
  window.addEventListener('pointermove', onCropMove)
  window.addEventListener('pointerup', onCropUp)
}

function onCropMove(ev: PointerEvent) {
  if (!drag || !mediaBox.value) return
  const rect = mediaBox.value.getBoundingClientRect()
  const dx = (ev.clientX - drag.x) / rect.width
  const dy = (ev.clientY - drag.y) / rect.height
  const s = drag.start
  if (drag.kind === 'move') {
    crop.value = clampRect({ ...s, x: s.x + dx, y: s.y + dy })
    return
  }
  let { x, y, w, h } = s
  if (drag.kind.includes('w')) {
    const nx = Math.min(x + w - 0.12, x + dx)
    w += x - nx
    x = nx
  }
  if (drag.kind.includes('e')) w = Math.max(0.12, w + dx)
  if (drag.kind.includes('n')) {
    const ny = Math.min(y + h - 0.12, y + dy)
    h += y - ny
    y = ny
  }
  if (drag.kind.includes('s')) h = Math.max(0.12, h + dy)
  crop.value = clampRect({ x, y, w, h })
}

function onCropUp() {
  drag = null
  window.removeEventListener('pointermove', onCropMove)
  window.removeEventListener('pointerup', onCropUp)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onCropMove)
  window.removeEventListener('pointerup', onCropUp)
})

async function applyCrop() {
  const id = assetId.value
  const box = mediaBox.value
  if (!id || !box) return
  toolBusy.value = '裁剪中…'
  try {
    const blob = await assets.getBlob(id)
    if (!blob) throw new Error('原图读取失败')
    const out = await cropContainedImage(blob, { width: box.clientWidth, height: box.clientHeight }, crop.value)
    await replaceImage(out, `crop_${Date.now().toString(36)}`)
    cropOn.value = false
    toast.success('已裁剪并替换当前图')
  } catch (e: any) {
    toast.error(e?.message || '裁剪失败')
  } finally {
    toolBusy.value = ''
  }
}

async function applyTrim() {
  const id = assetId.value
  if (!id) return
  const start = Math.max(0, trimStart.value)
  const end = Math.max(start + 0.2, trimEnd.value)
  toolBusy.value = '剪辑中…'
  try {
    const blob = await assets.getBlob(id)
    if (!blob) throw new Error('视频读取失败')
    const w = project.current?.settings.width ?? 1280
    const h = project.current?.settings.height ?? 720
    const fps = project.current?.settings.fps ?? 30
    const out = await trimVideoBlob(blob, start, end - start, w, h, fps, (m) => {
      toolBusy.value = m
    })
    const asset = await assets.add(out, 'video', 'extracted', {
      filename: `trim_${Date.now().toString(36)}`,
      projectId: project.current?.id,
      shotId: shot.value?.id
    })
    if (type.value === 'final') project.setFinalVideo(asset.id)
    else if (shot.value) {
      project.assignShotVideo(shot.value.id, asset.id)
      project.updateShot(shot.value.id, { duration: Math.max(1, Math.round(end - start)) })
    }
    await project.save()
    trimOn.value = false
    await loadMedia()
    toast.success('已剪辑并替换当前视频')
  } catch (e: any) {
    toast.error(e?.message || '剪辑失败')
  } finally {
    toolBusy.value = ''
  }
}

async function replaceImage(blob: Blob, filename: string) {
  const asset = await assets.add(blob, 'image', 'extracted', {
    filename,
    projectId: project.current?.id,
    shotId: shot.value?.id
  })
  project.assignCanvasNodeAsset(props.id, asset.id)
  await project.save()
  await loadMedia()
}

function openOutputPicker() {
  pickerOpen.value = true
}

function onEmptyClick() {
  if (!isImageNode.value || generating.value) return
  if (props.selected && panelOpen.value) openOutputPicker()
}

async function onPickerConfirm(ids: ID[]) {
  pickerOpen.value = false
  const id = ids[0]
  if (!id) return
  try {
    const asset = await assets.adopt(id, 'image', {
      projectId: project.current?.id,
      shotId: shot.value?.id
    })
    project.assignCanvasNodeAsset(props.id, asset.id)
    await project.save()
    await loadMedia()
    toast.success('已选用该图片')
  } catch (e: any) {
    toast.error(e?.message || '选用失败')
  }
}

async function downloadAsset() {
  const id = assetId.value
  if (!id) {
    toast.warn('还没有可下载的素材')
    return
  }
  const blob = await assets.getBlob(id)
  if (!blob) {
    toast.error('素材读取失败')
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.value}.${isVideoNode.value ? 'mp4' : type.value === 'audio' ? 'wav' : 'png'}`
  a.click()
  URL.revokeObjectURL(url)
}

function copyPrompt() {
  const t = promptValue.value.trim()
  if (!t) {
    toast.warn('没有提示词')
    return
  }
  navigator.clipboard.writeText(t).then(
    () => toast.success('已复制提示词'),
    () => toast.error('复制失败')
  )
}

function openDetail() {
  inspectCanvasNode(props.id)
}

function previewFull() {
  if (isVideoNode.value && videoUrl.value) openLightbox(videoUrl.value, 'video', title.value)
  else if (mediaUrl.value) openLightbox(mediaUrl.value, 'image', title.value)
}

function onTrimStart(v: number) {
  trimStart.value = Math.min(v, trimEnd.value - 0.2)
  if (videoEl.value) videoEl.value.currentTime = trimStart.value
}

function onTrimEnd(v: number) {
  const max = playbackDuration.value || shot.value?.duration || 10
  trimEnd.value = Math.max(v, trimStart.value + 0.2)
  trimEnd.value = Math.min(trimEnd.value, max)
  if (videoEl.value) videoEl.value.currentTime = trimEnd.value
}

const cropStyle = computed(() => ({
  left: `${crop.value.x * 100}%`,
  top: `${crop.value.y * 100}%`,
  width: `${crop.value.w * 100}%`,
  height: `${crop.value.h * 100}%`
}))
</script>

<template>
  <div class="pnode" :class="[`kind-${type}`, `st-${status}`, { on: selected && panelOpen, empty: !hasAsset, busy: generating || !!toolBusy }]">
    <Handle v-if="type !== 'script'" id="in" type="target" :position="Position.Left" class="hndl" />
    <Handle v-if="type === 'shotBoard' || type === 'shotImage' || type === 'shotFrames'" id="char1" type="target" :position="Position.Left" :style="{ top: '28%' }" class="hndl" />
    <Handle v-if="type === 'shotBoard' || type === 'shotImage' || type === 'shotFrames'" id="char2" type="target" :position="Position.Left" :style="{ top: '50%' }" class="hndl" />
    <Handle v-if="type === 'shotBoard' || type === 'shotImage' || type === 'shotFrames'" id="scene" type="target" :position="Position.Left" :style="{ top: '72%' }" class="hndl" />
    <Handle v-if="type === 'shotImage' && videoRequiresStoryboard(project.current)" id="board" type="target" :position="Position.Left" :style="{ top: '50%' }" class="hndl" />
    <Handle v-if="type === 'shotVideo'" id="image" type="target" :position="Position.Left" :style="{ top: '30%' }" class="hndl" />
    <Handle v-if="type === 'shotVideo'" id="frames" type="target" :position="Position.Left" :style="{ top: '70%' }" class="hndl" />

    <transition name="float-up">
      <div v-if="selected && panelOpen" class="toolbar-wrap nodrag nowheel" @mousedown.stop @click.stop>
        <div class="toolbar">
          <button v-if="isImageNode && hasAsset" type="button" :disabled="!!toolBusy" @click="startCrop">
            <span>✂</span>裁剪
          </button>
          <button v-if="isImageNode" type="button" :disabled="generating || gateBlocked || !!toolBusy" @click="generateThis($event, true)">
            <span>HD</span>高清
          </button>
          <button v-if="isVideoNode && hasAsset" type="button" :disabled="!!toolBusy" @click="startTrim">
            <span>🎞</span>剪辑
          </button>
          <button
            v-if="isVideoNode && hasAsset"
            type="button"
            :disabled="!!toolBusy"
            title="截取视频最后一帧，在旁边生成一张图片节点"
            @click="grabLastFrame"
          >
            <span>◫</span>截取尾帧
          </button>
          <button v-if="genLabel" type="button" :disabled="generating || gateBlocked || !!toolBusy" @click="generateThis">
            <span>↺</span>{{ hasAsset ? '重绘' : genLabel }}
          </button>
          <button
            v-if="type === 'shotVideo' && isH3VideoNode"
            type="button"
            :disabled="generating || gateBlocked || !!toolBusy || optimizingPrompt"
            title="只优化当前节点的提示词"
            @click="optimizePrompt"
          >
            <span>✦</span>{{ optimizingPrompt ? '优化中…' : '优化提示词' }}
          </button>
          <button
            v-if="isImageNode"
            type="button"
            :disabled="generating || !!toolBusy"
            title="选用已有图片，不重新生成"
            @click="openOutputPicker"
          >
            <span>▣</span>选用
          </button>
          <button v-if="hasAsset" type="button" @click="downloadAsset">
            <span>⬇</span>下载
          </button>
          <button type="button" class="icon" title="更多" @click="moreOpen = !moreOpen"><CanvasToolbarIcon name="more" :size="17" /></button>
          <button v-if="hasAsset" type="button" class="icon" title="查看大图" @click="previewFull"><CanvasToolbarIcon name="expand" :size="17" /></button>
          <div v-if="moreOpen" class="more">
            <button v-if="showPrompt" type="button" @click="copyPrompt(); moreOpen = false">复制提示词</button>
            <button
              v-if="isImageNode && hasAsset"
              type="button"
              @click="publishToLibrary"
            >
              加入公共资产库
            </button>
            <button type="button" @click="openDetail(); moreOpen = false">打开右侧详情</button>
          </div>
        </div>
      </div>
    </transition>

    <div ref="mediaBox" class="pnode-media" :style="{ aspectRatio: mediaAspect }">
      <template v-if="type === 'audio'">
        <audio
          v-if="mediaUrl"
          ref="audioEl"
          class="nodrag nowheel"
          :src="mediaUrl"
          preload="auto"
          @play="onVideoPlay"
          @ended="onAudioEnded"
          @canplay="onCanPlay"
        />
        <div class="audio-card">
          <button v-if="mediaUrl" class="vo-play nodrag" type="button" @click.stop="togglePlay" @mousedown.stop>
            {{ playing ? '❚❚' : '▶' }}
          </button>
          <span>{{ shot?.voiceover?.slice(0, 36) || (mediaUrl ? '口播' : '无口播') }}</span>
        </div>
      </template>
      <div v-else-if="type === 'export'" class="ph text">合成视频</div>
      <template v-else-if="isVideoNode && videoUrl">
        <video
          ref="videoEl"
          class="nodrag nowheel"
          :src="videoUrl"
          :poster="mediaUrl && mediaUrl !== videoUrl ? mediaUrl : undefined"
          playsinline
          preload="auto"
          @loadedmetadata="onLoadedMetadata"
          @canplay="onCanPlay"
          @play="onVideoPlay"
          @pause="onVideoPause"
          @ended="onVideoEnded"
          @click.stop="togglePlay"
        />
        <button v-if="!playing" class="play-btn nodrag" type="button" title="播放" @click.stop="togglePlay" @mousedown.stop>
          ▶
        </button>
      </template>
      <div v-else-if="type === 'shotFrames'" class="frame-pair">
        <div class="fp-cell">
          <img v-if="frameUrls.start" :src="frameUrls.start" alt="起始帧" />
          <div v-else class="fp-ph">＋</div>
          <span class="fp-tag">起</span>
          <button
            v-if="frameUrls.start && !generating && !toolBusy"
            class="fp-redo"
            title="重画起始帧"
            @click.stop="redrawFrame('start')"
          >↺</button>
        </div>
        <span class="fp-arrow">→</span>
        <div class="fp-cell">
          <img v-if="frameUrls.end" :src="frameUrls.end" alt="结束帧" />
          <div v-else class="fp-ph">＋</div>
          <span class="fp-tag">末</span>
          <button
            v-if="frameUrls.end && !generating && !toolBusy"
            class="fp-redo"
            title="重画结束帧"
            @click.stop="redrawFrame('end')"
          >↺</button>
        </div>
      </div>
      <img v-else-if="mediaUrl" :src="mediaUrl" alt="" />
      <div
        v-else
        class="ph"
        :class="{ pick: isImageNode }"
        :title="isImageNode ? '选用已有图片' : undefined"
        @click="onEmptyClick"
      >
        {{ isVideoNode ? '▶' : '＋' }}
      </div>
      <span v-if="isVideoNode && durationLabel && !trimOn && !generating && !toolBusy" class="dur">{{ durationLabel }}</span>
      <NodeBusyOverlay v-if="generating || toolBusy" :label="toolBusy || '生成中'" />
      <div v-if="status === 'failed' && nodeMeta?.error && !selected" class="fail-dot" :title="nodeMeta.error" />

      <div v-if="cropOn" class="crop-mask nodrag nowheel" @mousedown.stop>
        <div class="crop-box" :style="cropStyle" @pointerdown="onCropDown('move', $event)">
          <i class="h nw" @pointerdown.stop="onCropDown('nw', $event)" />
          <i class="h ne" @pointerdown.stop="onCropDown('ne', $event)" />
          <i class="h sw" @pointerdown.stop="onCropDown('sw', $event)" />
          <i class="h se" @pointerdown.stop="onCropDown('se', $event)" />
        </div>
        <div class="crop-actions">
          <button type="button" @click="cropOn = false">取消</button>
          <button type="button" class="ok" @click="applyCrop">应用裁剪</button>
        </div>
      </div>

      <div v-if="trimOn" class="trim-bar nodrag nowheel" @mousedown.stop @click.stop>
        <div class="trim-times">{{ trimStart.toFixed(1) }}s — {{ trimEnd.toFixed(1) }}s</div>
        <input
          type="range"
          min="0"
          :max="playbackDuration || shot?.duration || 10"
          step="0.1"
          :value="trimStart"
          @input="onTrimStart(Number(($event.target as HTMLInputElement).value))"
        />
        <input
          type="range"
          min="0"
          :max="playbackDuration || shot?.duration || 10"
          step="0.1"
          :value="trimEnd"
          @input="onTrimEnd(Number(($event.target as HTMLInputElement).value))"
        />
        <div class="crop-actions">
          <button type="button" @click="trimOn = false">取消</button>
          <button type="button" class="ok" :disabled="!!toolBusy" @click="applyTrim">应用剪辑</button>
        </div>
      </div>
    </div>

    <div v-if="type === 'subject' && subject" class="subject-card">
      <div class="sc-head">
        <span class="sc-name" :title="title">{{ title }}</span>
        <span class="sc-role">{{ subject.role || subjectKindText || '角色' }}</span>
      </div>
      <p v-if="subject.description" class="sc-desc" :title="subject.description">
        {{ subject.description }}
      </p>
      <div class="sc-voice" :class="{ set: voiceConfigured }">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="3.5" width="6" height="11" rx="3" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
        </svg>
        <span>{{ voiceSummary }}</span>
      </div>
    </div>
    <div v-else class="pnode-name">
      <span v-if="kindLabel" class="kind">{{ kindLabel }}</span>
      <span class="name" :title="title">{{ title }}</span>
      <span v-if="isVideoNode && durationLabel" class="len">{{ durationLabel }}</span>
    </div>

    <transition name="float-down">
      <div v-if="selected && panelOpen && showPrompt && !cropOn && !trimOn" class="prompt nodrag nowheel" @pointerdown.stop @mousedown.stop @click.stop>
      <div v-if="type === 'shotVideo'" class="prompt-tools">
        <button
          type="button"
          class="opt"
          :disabled="generating || gateBlocked || !!toolBusy || optimizingPrompt"
          @click="optimizePrompt"
        >
          {{ optimizingPrompt ? '优化中…' : '优化提示词' }}
        </button>
      </div>
      <div v-if="type === 'subject' && subject" class="voice-sec">
        <div class="voice-sec-head">
          <span class="voice-sec-title">角色语音</span>
          <span class="voice-sec-tag">提炼人物时自动生成 · 出镜对白与配音都用它</span>
        </div>
        <textarea
          class="voice-input"
          rows="2"
          :value="voicePromptText"
          placeholder="用一句话描述音色，如：低沉磁性的中年男声，语速偏慢，带一点沙哑"
          @input="voicePromptText = ($event.target as HTMLTextAreaElement).value"
        />
        <div class="voice-ref">
          <template v-if="voiceRefUrl">
            <button
              type="button"
              class="voice-play"
              :title="voiceRefPlaying ? '暂停' : '试听参考音频'"
              @click="toggleVoiceRefPlay"
            >
              {{ voiceRefPlaying ? '❚❚' : '▶' }}
            </button>
            <span class="voice-ref-name" :title="voiceRefName">{{ voiceRefName }}</span>
            <span v-if="subject.clonedVoiceId" class="voice-cloned">已复刻</span>
            <button type="button" class="voice-del" title="移除参考音频" @click="removeVoiceRef">✕</button>
          </template>
          <button
            v-else
            type="button"
            class="voice-upload"
            :disabled="voiceUploading"
            @click="pickVoiceRef"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4.5M7.5 9 12 4.5 16.5 9" />
              <path d="M4.5 16.5v2.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
            </svg>
            {{ voiceUploading ? '上传中…' : '上传参考音频' }}
          </button>
        </div>
        <p class="voice-sec-hint">
          参考音频仅在支持声音复刻的模型上生效（当前为百炼 Qwen3-TTS-VC）；音色描述对普通 TTS 也会生效。口播文案以「角色名：台词」开头时自动套用。
        </p>
        <audio
          v-if="voiceRefUrl"
          ref="voiceRefEl"
          :src="voiceRefUrl"
          preload="auto"
          class="voice-audio"
          @ended="voiceRefPlaying = false"
        />
        <input
          ref="voiceFileInput"
          type="file"
          accept="audio/*"
          style="display: none"
          @change="onVoiceRefChange"
        />
      </div>
      <div v-if="isFrameNode && shot" class="fp-prompts">
        <p class="fp-tip">
          两张帧各用一段画面词：起始帧画开场那一瞬，结束帧画动作走完的末态。画的时候会带上本镜的人物和场景参考图。
        </p>
        <label>起始帧画面词</label>
        <textarea
          rows="6"
          :value="startFramePromptValue"
          placeholder="留空则按分镜描述与连续性自动拼"
          @input="startFramePromptValue = ($event.target as HTMLTextAreaElement).value"
        />
        <label>结束帧画面词</label>
        <textarea
          rows="6"
          :value="endFramePromptValue"
          placeholder="留空则按「起始 → 末态」里的末态自动拼"
          @input="endFramePromptValue = ($event.target as HTMLTextAreaElement).value"
        />
      </div>
      <textarea
        v-else
        rows="12"
        :value="promptValue"
        :placeholder="promptHint"
        @input="promptValue = ($event.target as HTMLTextAreaElement).value"
      />
      <H3GenModeSelect v-if="isH3VideoNode" v-model="h3GenMode" />
      <FramePairSlots
        v-if="isH3Fl2va"
        v-model:first-id="firstFrameId"
        v-model:last-id="lastFrameId"
        :first-hint="shot?.imageAssetId ? '空则用本镜配图' : '请选择首帧'"
      />
      <ShotRefStrip
        v-else-if="shot && (type === 'shotBoard' || type === 'shotImage' || type === 'shotVideo')"
        :shot="shot"
        :mode="type === 'shotVideo' ? 'video' : type === 'shotBoard' ? 'board' : 'image'"
      />
      <ShotRefStrip
        v-else-if="type === 'subject' || type === 'sceneProps' || type === 'scene'"
        v-model:extra-ids="extraRefIds"
      />
      <div class="prompt-foot">
        <ImageModelSelect v-if="isImageNode || isFrameNode" />
        <VideoModelSelect
          v-else-if="type === 'shotVideo'"
          v-model="videoModel"
          :profile-id="nodeMeta?.data.videoProfileId"
          @select-profile="(id) => applyShotVideoProfile(props.id, id)"
        />
        <span v-if="type === 'shotVideo' && videoStillHint" class="still-hint">{{ videoStillHint }}</span>
        <span v-else>{{ metaLine }}</span>
        <AspectRatioSeg
          v-if="type === 'shotBoard' || type === 'shotImage' || type === 'shotFrames' || type === 'shotVideo'"
          v-model="nodeAspectRatio"
          compact
        />
        <VideoResolutionSeg
          v-if="type === 'shotVideo' && videoAllows1080p(videoModel) && !isH3Fl2va"
          v-model="videoResolution"
          compact
        />
        <ParamSelect
          v-if="type === 'shotVideo' && shot"
          class="dur-edit"
          width="76px"
          title="时长"
          :model-value="String(shotDurationValue)"
          @update:model-value="setShotDuration(Number($event))"
        >
          <option v-for="n in durationOptions" :key="n" :value="String(n)">{{ n }} 秒</option>
        </ParamSelect>
        <button
          v-if="genLabel"
          class="go"
          type="button"
          :disabled="generating || gateBlocked || !!toolBusy || optimizingPrompt"
          :title="genLabel"
          @click="generateThis"
        >
          ↑
        </button>
      </div>
      </div>
    </transition>

    <Handle id="out" type="source" :position="Position.Right" class="hndl" />

    <AssetPicker
      :open="pickerOpen"
      kind="image"
      :title="`选用已有图片作为${kindLabel || '本节点'}结果`"
      show-library
      default-tab="page"
      :selected-ids="assetId ? [assetId] : []"
      @close="pickerOpen = false"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<style scoped>
.pnode {
  position: relative;
  width: 240px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-node-border);
  border-radius: 12px;
  overflow: visible;
  color: var(--color-text-1);
  box-shadow: var(--shadow-node);
  transition: border-color 0.2s ease, box-shadow 0.22s ease;
}
.pnode.on {
  border-color: var(--color-text-1);
  box-shadow: 0 0 0 1px var(--color-text-1), var(--shadow-md);
  z-index: 4;
}
.pnode.st-running,
.pnode.busy {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px rgba(126, 180, 255, 0.28);
  animation: node-busy 1.35s ease-in-out infinite;
  z-index: 5;
}
@keyframes node-busy {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgba(126, 180, 255, 0.22);
  }
  50% {
    box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.4);
  }
}
.pnode.st-failed {
  border-color: var(--color-error);
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
  min-width: 132px;
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
}
.more button:hover {
  background: var(--color-fill-hover);
}
.pnode-media {
  position: relative;
  width: 100%;
  background: var(--color-node-well);
  overflow: hidden;
  border-radius: 12px 12px 0 0;
}
.pnode-media img,
.pnode-media video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  display: block;
  background: var(--color-node-well);
}
.pnode-media video {
  cursor: pointer;
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
.dur {
  position: absolute;
  right: 6px;
  bottom: 6px;
  z-index: 2;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: rgba(0, 0, 0, 0.72);
  padding: 2px 6px;
  border-radius: 4px;
  pointer-events: none;
}
.fail-dot {
  position: absolute;
  right: 8px;
  top: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
}
.ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-4);
  font-size: 22px;
}
.ph.pick {
  cursor: pointer;
}
.ph.text {
  font-size: 13px;
  font-weight: 600;
}

/* 首尾帧节点：起始帧 → 结束帧并排 */
.frame-pair {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 2px;
}
.fp-cell {
  position: relative;
  flex: 1;
  min-width: 0;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.2);
}
.fp-cell img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.fp-ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-4);
  font-size: 18px;
}
.fp-tag {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 10px;
  line-height: 1.6;
}
.fp-redo {
  position: absolute;
  right: 3px;
  top: 3px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.frame-pair:hover .fp-redo {
  opacity: 1;
}
.fp-redo:hover {
  background: rgba(0, 0, 0, 0.8);
}
.fp-arrow {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  padding: 0 3px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 11px;
}
.fp-prompts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fp-prompts label {
  color: var(--color-text-2);
  font-size: 11px;
}
.fp-prompts textarea {
  min-height: 72px;
}
.fp-tip {
  margin: 0;
  color: var(--color-text-3);
  font-size: 11px;
  line-height: 1.6;
}
.audio-card {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  font-size: 12px;
  color: var(--color-text-2);
}
.audio-card span {
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.vo-play {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  margin: 0;
  padding: 0 0 1px 1px;
  border: none;
  border-radius: 50%;
  background: var(--color-accent);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.pnode-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 10px;
  background: var(--color-bg-1);
  border-radius: 0 0 11px 11px;
}

/* ── 角色卡 ── */
.pnode.kind-subject {
  border-color: rgba(167, 139, 250, 0.28);
}
.pnode.kind-subject .pnode-media {
  border-bottom: 1px solid rgba(167, 139, 250, 0.16);
}
.pnode.on.kind-subject {
  border-color: rgba(167, 139, 250, 0.85);
  box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.5), var(--shadow-md);
}
.subject-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 11px 9px;
  background:
    linear-gradient(180deg, rgba(167, 139, 250, 0.07), transparent 42%),
    var(--color-bg-1);
  border-radius: 0 0 11px 11px;
}
.sc-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sc-name {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  font-weight: 680;
  letter-spacing: 0.01em;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-role {
  flex-shrink: 0;
  max-width: 96px;
  padding: 2px 8px;
  border-radius: 99px;
  border: 1px solid rgba(167, 139, 250, 0.4);
  background: rgba(167, 139, 250, 0.12);
  color: #c4b5fd;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-desc {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-voice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px dashed var(--color-border);
  color: var(--color-text-4);
  font-size: 11px;
}
.sc-voice svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sc-voice span {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-voice.set {
  border-style: solid;
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.08);
  color: #6ee7b7;
}

/* ── 角色语音编辑区（展开面板） ── */
.voice-sec {
  margin-bottom: 8px;
  padding: 9px 10px;
  border: 1px solid rgba(167, 139, 250, 0.22);
  border-radius: 10px;
  background: rgba(167, 139, 250, 0.05);
}
.voice-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.voice-sec-title {
  font-size: 12px;
  font-weight: 680;
  color: var(--color-text-1);
  letter-spacing: 0.02em;
}
.voice-sec-tag {
  font-size: 10px;
  color: var(--color-text-4);
}
.voice-input {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-border);
  outline: none;
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.5;
  padding: 7px 9px;
  font-family: inherit;
}
.voice-input:focus {
  border-color: rgba(167, 139, 250, 0.6);
}
.voice-ref {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
}
.voice-upload {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 11px;
  border: 1px dashed rgba(167, 139, 250, 0.45);
  border-radius: 8px;
  background: transparent;
  color: #c4b5fd;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.voice-upload:hover:not(:disabled) {
  background: rgba(167, 139, 250, 0.1);
}
.voice-upload:disabled {
  opacity: 0.5;
  cursor: default;
}
.voice-upload svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.voice-play {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  margin: 0;
  padding: 0 0 1px 1px;
  border: none;
  border-radius: 50%;
  background: rgba(167, 139, 250, 0.9);
  color: #fff;
  font-size: 10px;
  cursor: pointer;
}
.voice-ref-name {
  min-width: 0;
  flex: 1;
  font-size: 11px;
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.voice-cloned {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 99px;
  background: rgba(52, 211, 153, 0.14);
  border: 1px solid rgba(52, 211, 153, 0.35);
  color: #6ee7b7;
  font-size: 10px;
  font-weight: 600;
}
.voice-del {
  flex-shrink: 0;
  margin: 0;
  padding: 3px 5px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-4);
  font-size: 11px;
  cursor: pointer;
}
.voice-del:hover {
  color: var(--color-error);
  background: rgba(239, 68, 68, 0.12);
}
.voice-sec-hint {
  margin: 7px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--color-text-4);
}
.voice-audio {
  display: none;
}
.pnode-name .kind {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-4);
}
.pnode-name .name {
  min-width: 0;
  flex: 1;
  font-size: 12px;
  font-weight: 650;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pnode-name .len {
  flex-shrink: 0;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-4);
}
.prompt {
  position: absolute;
  left: 50%;
  top: calc(100% + 8px);
  z-index: 5;
  width: 400px;
  min-width: 400px;
  transform: translateX(-50%);
  transform-origin: 50% 0;
  overflow: visible;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.prompt textarea {
  width: 100%;
  min-height: 88px;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
}
.prompt-tools {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 4px;
}
.opt {
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent);
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
.opt:disabled {
  opacity: 0.4;
  cursor: default;
}
.prompt-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
}
.prompt-foot span {
  font-size: 10px;
  color: var(--color-text-4);
}
.dur-edit {
  margin-left: auto;
}
.dur-edit select {
  display: block;
  height: 28px;
  min-width: 72px;
  padding: 0 26px 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background-color: var(--color-bg-1);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%23ececef' d='M1.2 1.2L6 6l4.8-4.8' stroke='%23ececef' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
  color: var(--color-text-1);
  font-size: 12px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 28px;
  outline: none;
  cursor: pointer;
  appearance: none;
  color-scheme: dark;
}
.dur-edit select option {
  background: var(--color-bg-1);
  color: var(--color-text-1);
}
.go {
  width: 28px;
  height: 28px;
  margin: 0;
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
  cursor: default;
}
.crop-mask {
  position: absolute;
  inset: 0;
  z-index: 4;
  background: rgba(0, 0, 0, 0.35);
}
.crop-box {
  position: absolute;
  border: 1.5px solid #fff;
  box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.45);
  cursor: move;
}
.crop-box .h {
  position: absolute;
  width: 10px;
  height: 10px;
  background: #fff;
  border-radius: 2px;
}
.crop-box .nw { left: -5px; top: -5px; cursor: nwse-resize; }
.crop-box .ne { right: -5px; top: -5px; cursor: nesw-resize; }
.crop-box .sw { left: -5px; bottom: -5px; cursor: nesw-resize; }
.crop-box .se { right: -5px; bottom: -5px; cursor: nwse-resize; }
.crop-actions {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  z-index: 5;
}
.crop-actions button,
.trim-bar button {
  margin: 0;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  font-size: 11px;
}
.crop-actions .ok,
.trim-bar .ok {
  background: #fff;
  color: #111;
  font-weight: 700;
}
.trim-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 4;
  padding: 8px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.82));
}
.trim-times {
  font-size: 11px;
  color: #fff;
  margin-bottom: 4px;
}
.trim-bar input[type='range'] {
  width: 100%;
  margin: 0 0 4px;
}
.hndl {
  width: 8px;
  height: 8px;
  background: var(--color-accent);
  border: 1px solid #fff;
}
.pnode.kind-subject,
.pnode.kind-sceneProps,
.pnode.kind-scene,
.pnode.kind-shotBoard,
.pnode.kind-shotImage,
.pnode.kind-shotVideo { border-color: var(--color-node-border); }
.pnode.on.kind-subject,
.pnode.on.kind-sceneProps,
.pnode.on.kind-scene,
.pnode.on.kind-shotBoard,
.pnode.on.kind-shotImage,
.pnode.on.kind-shotVideo {
  border-color: var(--color-text-1);
}

.float-up-enter-active,
.float-up-leave-active,
.float-down-enter-active,
.float-down-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.float-up-enter-from,
.float-up-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px) scale(0.96);
}
.float-down-enter-from,
.float-down-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-10px) scale(0.98);
}
</style>
