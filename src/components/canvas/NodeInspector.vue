<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useProjectStore, useAssetsStore, useToastStore, useSettingsStore } from '@/stores'
import { llmChoiceKey, llmModelGroups, parseLlmChoiceKey } from '@/stores/settings'
import { runCanvasNode, runScriptNode, rewriteShotPerformance, optimizeShotVideoPrompt } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { needsPlayReview, PLAY_GATE_MSG } from '@/services/canvas/playGate'
import { generateMusic, refineMusicPrompt, buildMusicPrompt, isPlayReady } from '@/services/ai'
import { scriptFromImportedPlay } from '@/utils/scriptMarkdown'
import { pickPlayMarkdownFile } from '@/utils/pickPlayFile'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import ImageModelSelect from '@/components/settings/ImageModelSelect.vue'
import VideoModelSelect from '@/components/settings/VideoModelSelect.vue'
import VideoResolutionSeg from '@/components/common/VideoResolutionSeg.vue'
import H3GenModeSelect from '@/components/settings/H3GenModeSelect.vue'
import FramePairSlots from '@/components/canvas/FramePairSlots.vue'
import TtsModelSelect from '@/components/settings/TtsModelSelect.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import AspectRatioSeg from '@/components/common/AspectRatioSeg.vue'
import AssetPicker from '@/components/common/AssetPicker.vue'
import { openLightbox } from '@/composables/useLightbox'
import { cssAspectRatio } from '@/services/canvas/layout'
import { nextExtractStage, type ExtractStage } from '@/services/canvas/pipeline'
import { canBuildExport } from '@/utils/timeline'
import {
  fillEmptyGeneratePrompt,
  rebuildGeneratePrompt
} from '@/utils/nodePrompt'
import { VISUAL_STYLE_LABEL } from '@/utils/visualStyle'
import { resolvedCanvasReferenceAssetIds } from '@/services/canvas/references'
import ShotRefStrip from '@/components/canvas/ShotRefStrip.vue'
import { normalizeH3GenMode, normalizeVideoGenModel, normalizeVideoResolution, videoAllows1080p, videoMaxSeconds, videoMinSeconds, type CanvasNode, type H3VideoGenMode, type ID, type ShotAudioMode, type VideoGenModel, type VideoResolution, type VisualStyle } from '@/types'

const props = defineProps<{
  node: CanvasNode | null
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const settings = useSettingsStore()
const preview = ref('')
const historyUrls = ref<Record<string, string>>({})
const running = computed(() => (props.node ? isNodeRunning(props.node.id) : false))
const bgmPrompt = ref('')
const bgmUrl = ref('')
const generatingBgm = ref(false)
const bgmError = ref('')

const continueHint = ref('')
const pickerOpen = ref(false)
const optimizingPrompt = ref(false)
const videoPromptBox = ref<HTMLTextAreaElement | null>(null)

function persistShotVideoPrompt() {
  if (props.node?.type !== 'shotVideo' || !shot.value) return
  const v = videoPromptBox.value?.value
  if (v == null) return
  if (v !== (shot.value.compiledVideoPrompt ?? '')) {
    project.updateShot(shot.value.id, { compiledVideoPrompt: v })
  }
}

function onVideoPromptPaste() {
  nextTick(() => persistShotVideoPrompt())
}

const keepAmbientAudio = computed({
  get: () => project.current?.settings.keepAmbientAudio !== false,
  set: (v: boolean) => project.setSettings({ keepAmbientAudio: v })
})
const ambientVolume = computed({
  get: () => project.current?.settings.originalVolume ?? 0.55,
  set: (v: number) => project.setSettings({ originalVolume: v })
})
const bgmVolume = computed({
  get: () => project.current?.settings.bgmVolume ?? 0.35,
  set: (v: number) => project.setSettings({ bgmVolume: v })
})
const burnCaptions = computed({
  get: () => project.current?.settings.burnCaptions !== false,
  set: (v: boolean) => project.setSettings({ burnCaptions: v })
})
const bgmAssetId = computed({
  get: () => project.current?.bgmAssetId || '',
  set: (id: string) => {
    project.setBgm(id || undefined, bgmPrompt.value)
  }
})
const audioAssets = computed(() =>
  assets.all.filter((a) => a.kind === 'audio' && !String(a.filename).startsWith('vo_'))
)
const totalDuration = computed(() => {
  const p = project.current
  if (!p) return 24
  if (p.timeline?.length) {
    return Math.max(
      8,
      p.timeline.filter((c) => c.enabled).reduce((s, c) => s + (c.duration || 0), 0)
    )
  }
  return Math.max(
    8,
    p.shots.reduce((s, sh) => s + (sh.duration || 0), 0)
  )
})
const isExportNode = computed(
  () => props.node?.type === 'export' || props.node?.type === 'final'
)

const shot = computed(() => {
  const id = props.node?.data.shotId
  return project.current?.shots.find((s) => s.id === id)
})
const subject = computed(() => {
  const id = props.node?.data.subjectId
  return (project.current?.subjects ?? []).find((s) => s.id === id)
})
const scene = computed(() => {
  const id = props.node?.data.sceneId
  return (project.current?.scenes ?? []).find((s) => s.id === id)
})

const extraRefIds = computed({
  get(): ID[] {
    const t = props.node?.type
    if (t === 'subject') return subject.value?.referenceAssetIds ?? []
    if (t === 'sceneProps') return scene.value?.propReferenceAssetIds ?? []
    if (t === 'scene') return scene.value?.referenceAssetIds ?? []
    return []
  },
  set(ids: ID[]) {
    const t = props.node?.type
    if (t === 'subject' && subject.value) {
      project.updateSubject(subject.value.id, { referenceAssetIds: ids })
    } else if (t === 'sceneProps' && scene.value) {
      project.updateScene(scene.value.id, { propReferenceAssetIds: ids })
    } else if (t === 'scene' && scene.value) {
      project.updateScene(scene.value.id, { referenceAssetIds: ids })
    }
  }
})

const inspectorRefIds = computed(() => {
  const p = project.current
  const n = props.node
  if (!p || !n || (n.type !== 'imageGen' && n.type !== 'videoGen')) return []
  return resolvedCanvasReferenceAssetIds(p, n)
})
const inspectorRefUrls = ref<Record<string, string>>({})

watch(
  () => inspectorRefIds.value.join(','),
  async () => {
    const next: Record<string, string> = {}
    for (const id of inspectorRefIds.value) {
      next[id] = (await assets.getUrl(id)) || ''
    }
    inspectorRefUrls.value = next
  },
  { immediate: true }
)

function removeInspectorRef(id: ID) {
  if (!props.node) return
  project.removeCanvasNodeRef(props.node.id, id)
  toast.success('已移除这张参考图')
}

const currentAssetId = computed(() => {
  const t = props.node?.type
  if (t === 'final') return project.current?.finalVideoAssetId
  if (t === 'subject') return subject.value?.designSheetAssetId
  if (t === 'sceneProps') return scene.value?.propSheetAssetId
  if (t === 'scene') return scene.value?.plateAssetId
  if (t === 'shotBoard') return shot.value?.boardAssetId
  if (t === 'shotImage') return shot.value?.imageAssetId
  if (t === 'shotVideo') return shot.value?.videoAssetId
  if (t === 'audio') return shot.value?.audioAssetId
  if (t === 'imageGen' || t === 'videoGen') return props.node?.data.outputAssetId
  return undefined
})

const hasAsset = computed(() => Boolean(currentAssetId.value))
const waitingReview = computed(() => needsPlayReview(project.current))
const gateBlocked = computed(() => {
  const t = props.node?.type
  return Boolean(
    t &&
      t !== 'script' &&
      t !== 'export' &&
      t !== 'final' &&
      t !== 'imageGen' &&
      t !== 'videoGen' &&
      waitingReview.value
  )
})

const actionLabel = computed(() => {
  const t = props.node?.type
  const again = hasAsset.value || Boolean(project.current?.finalVideoAssetId)
  if (t === 'script') {
    return isPlayReady(project.current?.script) ? '重新写剧本' : '写剧本'
  }
  if (t === 'subject') return again ? '重新生成四视图' : '生成四视图'
  if (t === 'sceneProps') return again ? '重新生成关键道具图' : '生成关键道具图'
  if (t === 'scene') return again ? '重新生成锚点图' : '生成锚点图'
  if (t === 'shotBoard') return again ? '重新生成故事看板' : '生成故事看板'
  if (t === 'shotImage') {
    return again
      ? videoRequiresStoryboard(project.current)
        ? '重新生成配图'
        : '重新生成四宫格'
      : videoRequiresStoryboard(project.current)
        ? '生成配图'
        : '生成四宫格'
  }
  if (t === 'shotVideo') return again ? '重新生成视频' : '生成视频'
  if (t === 'audio') {
    if (!shot.value || !needsExternalTts(shot.value, project.current)) return '无需独立配音'
    return again ? '重新生成口播' : '生成口播'
  }
  if (t === 'export' || t === 'final') return again ? '重新合成视频' : '合成视频'
  return again ? '重新生成' : '生成这个节点'
})

const extractLabel = computed(() => {
  const stage = nextExtractStage(project.current)
  if (stage === 'subjects') return '第 1 步：提炼人物'
  if (stage === 'scenes') return '第 2 步：提炼场景'
  if (stage === 'shots') return '第 3 步：拆分镜'
  return ''
})
const canExtractNext = computed(() => Boolean(nextExtractStage(project.current)))
const isImg2Video = computed(() => project.current?.pipelineMode === 'img2video')
const canExtractShots = computed(
  () => Boolean((project.current?.subjects ?? []).length && (project.current?.scenes ?? []).length)
)

const isImageNode = computed(() => {
  const t = props.node?.type
  return t === 'subject' || t === 'sceneProps' || t === 'scene' || t === 'shotBoard' || t === 'shotImage'
})
const canPickAsset = computed(() => isImageNode.value || props.node?.type === 'imageGen')

const showAspect = computed(() => {
  const t = props.node?.type
  return (
    t === 'script' ||
    t === 'shotBoard' ||
    t === 'shotImage' ||
    t === 'shotVideo' ||
    t === 'imageGen' ||
    t === 'videoGen'
  )
})

const videoModel = computed({
  get: () => normalizeVideoGenModel(props.node?.data.videoModel),
  set: (v: VideoGenModel) => {
    if (!props.node) return
    const min = videoMinSeconds(v)
    const max = videoMaxSeconds(v)
    project.patchCanvasNode(props.node.id, {
      videoModel: v,
      videoResolution: normalizeVideoResolution(props.node.data.videoResolution, v),
      ...(props.node.type === 'videoGen'
        ? { duration: Math.min(max, Math.max(min, Math.round(props.node.data.duration || min))) }
        : {})
    })
    if (props.node.type === 'shotVideo' && shot.value) {
      project.updateShot(shot.value.id, {
        duration: Math.min(max, Math.max(min, Math.round(shot.value.duration || min)))
      })
    }
  }
})
const videoResolution = computed({
  get: () => normalizeVideoResolution(props.node?.data.videoResolution, videoModel.value),
  set: (v: VideoResolution) => {
    if (props.node) project.patchCanvasNode(props.node.id, { videoResolution: v })
  }
})
const isH3Video = computed(
  () =>
    (props.node?.type === 'shotVideo' || props.node?.type === 'videoGen') &&
    videoModel.value !== 'wan-prime'
)
const h3GenMode = computed({
  get: () =>
    props.node?.type === 'videoGen'
      ? normalizeH3GenMode(props.node.data.h3GenMode)
      : normalizeH3GenMode(shot.value?.h3GenMode),
  set: (v: H3VideoGenMode) => {
    if (props.node?.type === 'videoGen') {
      project.patchCanvasNode(props.node.id, { h3GenMode: v })
    } else if (shot.value) {
      project.updateShot(shot.value.id, { h3GenMode: v })
    }
  }
})
const firstFrameId = computed({
  get: () =>
    props.node?.type === 'videoGen'
      ? props.node.data.firstFrameAssetId
      : shot.value?.firstFrameAssetId,
  set: (v: ID | undefined) => {
    if (props.node?.type === 'videoGen') {
      project.patchCanvasNode(props.node.id, { firstFrameAssetId: v })
    } else if (shot.value) {
      project.updateShot(shot.value.id, { firstFrameAssetId: v })
    }
  }
})
const lastFrameId = computed({
  get: () =>
    props.node?.type === 'videoGen'
      ? props.node.data.lastFrameAssetId
      : shot.value?.lastFrameAssetId,
  set: (v: ID | undefined) => {
    if (props.node?.type === 'videoGen') {
      project.patchCanvasNode(props.node.id, { lastFrameAssetId: v })
    } else if (shot.value) {
      project.updateShot(shot.value.id, { lastFrameAssetId: v })
    }
  }
})
const isH3Fl2va = computed(() => isH3Video.value && h3GenMode.value === 'fl2va')

const canRun = computed(() => {
  if (running.value || gateBlocked.value) return false
  if (props.node?.type === 'export' || props.node?.type === 'final') {
    return canBuildExport(project.current)
  }
  if (props.node?.type === 'audio' && shot.value && !needsExternalTts(shot.value, project.current)) return false
  return true
})

const previewAspect = computed(() => {
  if (props.node?.type === 'subject' || props.node?.type === 'sceneProps' || props.node?.type === 'scene') {
    return cssAspectRatio('16:9')
  }
  return cssAspectRatio(project.current?.settings.aspectRatio)
})

const kindLabel = computed(() => {
  const t = props.node?.type
  if (t === 'script') return '完整剧本'
  if (t === 'subject') return '人物 · 四视图'
  if (t === 'sceneProps') return '场景 · 关键道具图'
  if (t === 'scene') return '场景 · 锚点图'
  if (t === 'shotBoard') return '分镜 · 故事看板'
  if (t === 'shotImage') return videoRequiresStoryboard(project.current) ? '分镜 · 配图' : '分镜 · 四宫格关键帧'
  if (t === 'shotVideo') {
    const d = shot.value?.duration
    return d ? `分镜 · 视频 · ${d}s` : '分镜 · 视频'
  }
  if (t === 'audio') return '分镜 · 口播'
  if (t === 'export') return '视频 · 合成'
  if (t === 'final') return '视频 · 预览'
  if (t === 'imageGen') return '图片生成'
  if (t === 'videoGen') return '图生视频'
  return t || ''
})

const title = computed(() => {
  if (!props.node) return '未选择'
  if (props.node.type === 'script') return project.current?.script?.topic || '文案'
  if (subject.value) return subject.value.name
  if (scene.value) return scene.value.name
  if (shot.value) return `${shot.value.index + 1}. ${shot.value.title}`
  if (props.node.type === 'export') return '合成视频'
  if (props.node.type === 'final') return '视频预览'
  return props.node.data.label || props.node.type
})

const historyIds = computed(() => {
  const t = props.node?.type
  if (t === 'subject') return subject.value?.designSheetHistoryIds ?? []
  if (t === 'sceneProps') return scene.value?.propSheetHistoryIds ?? []
  if (t === 'scene') return scene.value?.plateHistoryIds ?? []
  if (t === 'shotBoard') return shot.value?.boardHistoryIds ?? []
  if (t === 'shotImage') return shot.value?.imageHistoryIds ?? []
  if (t === 'shotVideo') return shot.value?.videoHistoryIds ?? []
  return []
})

const videoPromptPlaceholder = computed(() =>
  '粘贴或编辑后原样发送。生成视频不会改回默认模板。空着再点「优化提示词」或「按分镜重铺」才会重写。'
)

watch(
  () => [props.node?.id, props.node?.type, subject.value?.id, scene.value?.id, shot.value?.id],
  () => {
    const p = project.current
    const node = props.node
    if (!p || !node) return
    const t = node.type
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

async function refreshPreview() {
  preview.value = ''
  const id = currentAssetId.value
  if (!id || !props.node) return
  preview.value = (await assets.getUrl(id)) || ''
}

async function loadHistory() {
  const ids = historyIds.value
  const next: Record<string, string> = {}
  for (const id of ids) {
    const url =
      props.node?.type === 'shotVideo'
        ? (await assets.ensureThumb(id)) || (await assets.getUrl(id))
        : await assets.getUrl(id)
    if (url) next[id] = url
  }
  historyUrls.value = next
}

async function restoreHistory(assetId: string) {
  if (!props.node) return
  project.assignCanvasNodeAsset(props.node.id, assetId)
  await project.save()
  await refreshPreview()
  await loadHistory()
  toast.success('已切回这个版本')
}

async function onPickerConfirm(ids: ID[]) {
  pickerOpen.value = false
  const id = ids[0]
  if (!id || !props.node) return
  try {
    const asset = await assets.adopt(id, 'image', {
      projectId: project.current?.id,
      shotId: props.node.data.shotId
    })
    project.assignCanvasNodeAsset(props.node.id, asset.id)
    await project.save()
    await refreshPreview()
    await loadHistory()
    toast.success('已选用该图片')
  } catch (e: any) {
    toast.error(e?.message || '选用失败')
  }
}

async function downloadFinal() {
  const id = project.current?.finalVideoAssetId
  if (!id) {
    toast.warn('还没有合成视频，请先合成')
    return
  }
  const blob = await assets.getBlob(id)
  if (!blob) {
    toast.error('视频文件读取失败')
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.current?.name ?? 'final'}.mp4`
  a.click()
  URL.revokeObjectURL(url)
}

async function refreshBgmPreview() {
  const id = project.current?.bgmAssetId
  if (!id) {
    bgmUrl.value = ''
    return
  }
  bgmUrl.value = (await assets.getUrl(id)) || ''
}

async function ensureBgmPrompt() {
  if (!project.current) return
  if (!bgmPrompt.value.trim()) {
    bgmPrompt.value =
      project.current.bgmPrompt || buildMusicPrompt(project.current)
  }
}

async function generateBgm() {
  if (!project.current) return
  generatingBgm.value = true
  bgmError.value = ''
  try {
    await ensureBgmPrompt()
    let prompt = bgmPrompt.value.trim()
    if (!prompt) {
      prompt = await refineMusicPrompt(project.current)
      bgmPrompt.value = prompt
    }
    const result = await generateMusic({
      prompt,
      duration: totalDuration.value || 24
    })
    const typed = result.blob.type.startsWith('audio/')
      ? result.blob
      : new Blob([result.blob], { type: result.mimeType || 'audio/mpeg' })
    const asset = await assets.add(typed, 'audio', 'ai-generated', {
      filename: `bgm_${Date.now().toString(36)}`,
      prompt,
      projectId: project.current.id
    })
    project.setBgm(asset.id, prompt)
    await project.save()
    await refreshBgmPreview()
    toast.success('整片配乐已生成，可先试听')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    bgmError.value = msg
    toast.error('配乐生成失败：' + msg, 10000)
  } finally {
    generatingBgm.value = false
  }
}

function onBgmPromptBlur() {
  if (!project.current) return
  project.setBgm(project.current.bgmAssetId, bgmPrompt.value)
}

async function run() {
  if (!props.node) return
  persistShotVideoPrompt()
  if (gateBlocked.value) {
    toast.warn(PLAY_GATE_MSG)
    return
  }
  try {
    if (props.node.type === 'script') {
      await runScriptNode('play', undefined, undefined, llmModel.value)
    } else {
      await runCanvasNode(props.node.id)
    }
    await refreshPreview()
    await loadHistory()
    toast.success(actionLabel.value + '完成')
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '生成失败')
  }
}

async function runContinue() {
  if (!props.node) return
  try {
    await runScriptNode('continue', undefined, undefined, llmModel.value, continueHint.value)
    toast.success('已续写剧本')
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '续写失败')
  }
}

async function runExtract(stage?: ExtractStage) {
  if (!props.node) return
  if (stage === 'shots' && !canExtractShots.value) {
    toast.warn('请先提炼角色和场景，再拆分镜')
    return
  }
  try {
    await runScriptNode('extract', undefined, undefined, llmModel.value, undefined, stage)
    toast.success(
      stage === 'subjects'
        ? '角色已提炼到画布'
        : stage === 'scenes'
          ? '场景已提炼到画布'
          : stage === 'shots'
            ? '分镜已提炼到画布'
            : '节点已从剧本提炼出来'
    )
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '提炼失败')
  }
}

watch(
  () => [props.node?.id, currentAssetId.value] as const,
  () => {
    refreshPreview()
    loadHistory()
  }
)

watch(
  () => [props.node?.type, project.current?.bgmAssetId, project.current?.bgmPrompt] as const,
  async ([type]) => {
    if (type !== 'export' && type !== 'final') return
    await assets.refresh()
    await ensureBgmPrompt()
    await refreshBgmPreview()
  },
  { immediate: true }
)

watch(running, (now, was) => {
  if (was && !now) {
    refreshPreview()
    loadHistory()
  }
})

const llmGroups = computed(() => llmModelGroups(settings.config.llms ?? []))
const llmChoice = computed({
  get() {
    const id = settings.config.activeLlmId
    const model = settings.config.llm.model
    return id && model ? llmChoiceKey(id, model) : ''
  },
  set(v: string) {
    const parsed = parseLlmChoiceKey(v)
    if (parsed) settings.selectLlmModel(parsed.profileId, parsed.model)
  }
})
const llmModel = computed(() => settings.config.llm.model)

function patchScript(field: 'topic' | 'content', value: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, [field]: value })
  if (field === 'topic') project.applyPlayTitle(value)
}

async function importPlayMarkdown() {
  if (!project.current) return
  const existing = (project.current.script?.content || '').trim()
  if (existing && !confirm('导入会替换当前剧本正文，确定吗？')) return
  try {
    const picked = await pickPlayMarkdownFile()
    if (!picked) return
    const script = scriptFromImportedPlay(project.current, picked.text, picked.filename)
    project.setScript(script)
    project.applyPlayTitle(script.topic)
    if (project.current.pipelineMode !== 'img2video') project.setPlayApproved(false)
    await project.save()
    toast.success(`已导入「${script.topic}」`)
  } catch (e: any) {
    toast.error(e?.message || '导入失败')
  }
}

const styleOptions = Object.entries(VISUAL_STYLE_LABEL) as [VisualStyle, string][]
const projectStyle = computed({
  get: () => project.current?.script?.style ?? 'cinematic',
  set: (style: VisualStyle) => {
    if (!project.current?.script) return
    project.setScript({ ...project.current.script, style })
  }
})

function rebuildPrompt() {
  const p = project.current
  const node = props.node
  if (!p || !node) return
  const t = node.type
  if (t === 'subject' && subject.value) {
    project.updateSubject(subject.value.id, rebuildGeneratePrompt('subject', p, subject.value))
  } else if (t === 'scene' && scene.value) {
    project.updateScene(scene.value.id, rebuildGeneratePrompt('scene', p, scene.value))
  } else if (t === 'sceneProps' && scene.value) {
    project.updateScene(scene.value.id, rebuildGeneratePrompt('sceneProps', p, scene.value))
  } else if (t === 'shotBoard' && shot.value) {
    project.updateShot(shot.value.id, rebuildGeneratePrompt('shotBoard', p, shot.value))
  } else if (t === 'shotImage' && shot.value) {
    project.updateShot(shot.value.id, rebuildGeneratePrompt('shotImage', p, shot.value))
  } else if (t === 'shotVideo' && shot.value) {
    project.updateShot(shot.value.id, rebuildGeneratePrompt('shotVideo', p, shot.value))
  } else {
    return
  }
  toast.success('已按当前画风重铺提示词。再点生成才会出新图。')
}

async function resetVideoPrompt() {
  if (!shot.value) return
  try {
    await rewriteShotPerformance(shot.value)
    toast.success('已按本镜剧情重写')
  } catch (e: any) {
    toast.error(friendlyAiError(e) || '重写失败')
  }
}

async function optimizeVideoPrompt() {
  persistShotVideoPrompt()
  if (!shot.value || optimizingPrompt.value) return
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
</script>

<template>
  <aside class="insp">
    <div v-if="!node" class="empty">点画布上的节点，这里改提示词、单独重新生成</div>
    <template v-else>
      <div class="insp-k">{{ kindLabel }}</div>
      <h3>{{ title }}</h3>
      <p v-if="node.error" class="err">{{ node.error }}</p>
      <p v-else-if="hasAsset && node.type === 'audio'" class="hint">
        点播放可试听口播。改文案后重新生成，只动这一个节点。
      </p>
      <p v-else-if="hasAsset && node.type !== 'script' && node.type !== 'export' && node.type !== 'final'" class="hint">
        改下面提示词后点重新生成，只动这一个节点。也可以从资源库选用已有图。点缩略图可看大图。
      </p>
      <p v-else-if="canPickAsset" class="hint">
        可以生成，也可以从资源库选用已有图片，不必临时出图。
      </p>

      <p v-else-if="node.type === 'script'" class="hint">
        {{
          isImg2Video
            ? '可导入 .md 剧本，或先写完整剧本，再点提炼角色、场景或分镜。也可以右键直接加空白节点。'
            : '可导入 .md 剧本。或先写完整剧本（背景、人物、环境、分场都要写清，还不拆节点），再提炼人物、场景、分镜。'
        }}
      </p>
      <p v-else-if="node.type === 'export'" class="hint">
        先调下方音频与字幕，再点合成。视频会出现在「视频预览」节点。
      </p>
      <p v-else-if="node.type === 'final'" class="hint">
        可预览/下载视频。改音频设置后点重新合成即可。
      </p>
      <p v-else-if="gateBlocked" class="hint">{{ PLAY_GATE_MSG }}</p>

      <AspectRatioSeg v-if="showAspect" />

      <div v-if="preview && (node.type === 'shotVideo' || node.type === 'final')" class="prev prev-video">
        <div class="prev-frame" :style="{ aspectRatio: previewAspect }">
          <video :src="preview" controls playsinline preload="auto" />
        </div>
      </div>
      <div v-else-if="preview && node.type === 'audio'" class="prev prev-audio">
        <audio :src="preview" controls preload="auto" />
        <span>试听口播</span>
      </div>
      <button
        v-else-if="preview"
        class="prev"
        type="button"
        title="点击查看大图"
        @click="openLightbox(preview, 'image', title)"
      >
        <div class="prev-frame" :style="{ aspectRatio: previewAspect }">
          <img :src="preview" alt="" />
        </div>
        <span>查看大图</span>
      </button>

      <template v-if="isExportNode && project.current">
        <label>字幕</label>
        <label class="check">
          <input v-model="burnCaptions" type="checkbox" />
          <span>烧录字幕到画面</span>
        </label>

        <label>分镜原声（环境音）</label>
        <div class="seg">
          <button
            type="button"
            class="seg-btn"
            :class="{ on: keepAmbientAudio }"
            @click="keepAmbientAudio = true"
          >
            保留
          </button>
          <button
            type="button"
            class="seg-btn"
            :class="{ on: !keepAmbientAudio }"
            @click="keepAmbientAudio = false"
          >
            去掉
          </button>
        </div>
        <p class="hint">
          {{
            keepAmbientAudio
              ? '保留普通镜头环境音；H3 自带对白 / 口播始终保留。'
              : '静音 TTS / 无口播镜头原声；H3 自带人声不受影响。'
          }}
        </p>
        <div v-if="keepAmbientAudio" class="vol-row">
          <span class="hint">环境音</span>
          <input v-model.number="ambientVolume" type="range" min="0.1" max="1" step="0.05" />
          <span class="hint">{{ Math.round(ambientVolume * 100) }}%</span>
        </div>

        <label>背景音乐</label>
        <textarea
          v-model="bgmPrompt"
          rows="3"
          placeholder="配乐风格，例如：温暖弦乐铺底，不要人声…"
          @blur="onBgmPromptBlur"
        />
        <div class="vol-row">
          <span class="hint">BGM 音量</span>
          <input v-model.number="bgmVolume" type="range" min="0" max="1" step="0.05" />
          <span class="hint">{{ Math.round(bgmVolume * 100) }}%</span>
        </div>
        <div class="bgm-row">
          <GradientButton
            size="sm"
            :loading="generatingBgm"
            :disabled="generatingBgm || running"
            @click="generateBgm"
          >
            {{ bgmAssetId ? '重新生成配乐' : '生成配乐' }}
          </GradientButton>
          <select v-model="bgmAssetId">
            <option value="">不使用 BGM</option>
            <option v-for="a in audioAssets" :key="a.id" :value="a.id">
              {{ a.filename }}
            </option>
          </select>
        </div>
        <audio v-if="bgmUrl" class="bgm-player" :src="bgmUrl" controls />
        <p v-if="bgmError" class="err">{{ bgmError }}</p>
      </template>

      <template v-if="node.type === 'script' && project.current">
        <label>主题</label>
        <input
          :value="project.current.script?.topic"
          @input="patchScript('topic', ($event.target as HTMLInputElement).value)"
        />
        <label>文案（Markdown，可用 # 大标题 ## 小标题）</label>
        <div class="lab-row">
          <p class="hint">可导入 .md / .markdown / .txt。</p>
          <button class="link" type="button" @click="importPlayMarkdown">导入 Markdown</button>
        </div>
        <textarea
          rows="12"
          :value="project.current.script?.content"
          @input="patchScript('content', ($event.target as HTMLTextAreaElement).value)"
        />
        <GradientButton
          v-if="waitingReview"
          block
          type="secondary"
          @click="project.setPlayApproved(true)"
        >
          确认通过，往下做人设
        </GradientButton>
        <label>画面风格</label>
        <select v-model="projectStyle">
          <option v-for="[id, name] in styleOptions" :key="id" :value="id">{{ name }}</option>
        </select>
        <p class="hint">这是项目默认画风。各节点上已经展开的提示词不会自动改；换完到人物/场景/分镜点「按这个画风重铺」。</p>
        <label>写剧本用的 LLM</label>
        <select v-model="llmChoice">
          <option v-if="!llmGroups.some((g) => g.models.length)" value="">请先在设置里添加模型</option>
          <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
            <option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">{{ m }}</option>
          </optgroup>
        </select>
      </template>

      <template v-else-if="node.type === 'subject' && subject">
        <label>实际出图提示词</label>
        <div class="lab-row">
          <p class="hint">框里是什么就发什么。换风格：改画风那几句，或先在剧本节点改画面风格，再点重铺。</p>
          <button class="link" type="button" @click="rebuildPrompt">按这个画风重铺</button>
        </div>
        <textarea
          rows="16"
          :value="subject.sheetPrompt ?? ''"
          placeholder="纯白背景四视图。外貌、服装、画风。改完点重新生成。"
          @input="project.updateSubject(subject.id, { sheetPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'sceneProps' && scene">
        <label>实际出图提示词</label>
        <div class="lab-row">
          <p class="hint">框里是什么就发什么。</p>
          <button class="link" type="button" @click="rebuildPrompt">按这个画风重铺</button>
        </div>
        <textarea
          rows="16"
          :value="scene.propSheetPrompt ?? ''"
          placeholder="关键道具怎么画。改完点重新生成。"
          @input="project.updateScene(scene.id, { propSheetPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'scene' && scene">
        <label>实际出图提示词</label>
        <div class="lab-row">
          <p class="hint">框里是什么就发什么。</p>
          <button class="link" type="button" @click="rebuildPrompt">按这个画风重铺</button>
        </div>
        <textarea
          rows="16"
          :value="scene.platePrompt ?? ''"
          placeholder="这个地点的四宫格锚点图怎么画。"
          @input="project.updateScene(scene.id, { platePrompt: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>地点描述</label>
        <textarea
          rows="4"
          :value="scene.description"
          placeholder="人还没进来时这个地方：地面、光、门窗、材质。"
          @input="project.updateScene(scene.id, { description: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>主锚</label>
        <input
          :value="scene.mainAnchor || ''"
          placeholder="电梯门、接待台、锅灶……摄像能对着的实物"
          @change="project.updateScene(scene.id, { mainAnchor: ($event.target as HTMLInputElement).value })"
        />
        <label>四宫格锚点</label>
        <textarea
          rows="3"
          :value="scene.anchors || ''"
          placeholder="全景；主锚；地面站位；光源或次锚"
          @input="project.updateScene(scene.id, { anchors: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotBoard' && shot">
        <label>实际出图提示词</label>
        <div class="lab-row">
          <p class="hint">框里是什么就发什么。</p>
          <button class="link" type="button" @click="rebuildPrompt">按这个画风重铺</button>
        </div>
        <textarea
          rows="16"
          :value="shot.boardPrompt ?? ''"
          placeholder="故事看板怎么画。改完点生成。"
          @input="project.updateShot(shot.id, { boardPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotImage' && shot">
        <div class="lab-row">
          <label>实际出图提示词</label>
          <button class="link" type="button" @click="rebuildPrompt">按这个画风重铺</button>
        </div>
        <p class="hint">下面就是发给出图接口的全文。改完原样发送。</p>
        <textarea
          rows="16"
          :value="shot.imagePrompt ?? ''"
          placeholder="2×2 四宫格，正好四格。左上到右下是这一镜的事件。"
          @input="project.updateShot(shot.id, { imagePrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotVideo' && shot">
        <div class="lab-row">
          <label>实际出视频提示词</label>
          <div class="lab-actions">
            <button
              class="link"
              type="button"
              :disabled="optimizingPrompt || running"
              @click="optimizeVideoPrompt"
            >
              {{ optimizingPrompt ? '优化中…' : '优化提示词' }}
            </button>
            <button class="link" type="button" :disabled="optimizingPrompt || running" @click="resetVideoPrompt">按分镜重铺</button>
          </div>
        </div>
        <p class="hint">
          优化按这个框里的原文改写成 H3 格式。你写的台词会进 &lt;d&gt;，口播栏为空也不会删掉。
        </p>
        <textarea
          ref="videoPromptBox"
          rows="16"
          :value="shot.compiledVideoPrompt ?? ''"
          :placeholder="videoPromptPlaceholder"
          @input="project.updateShot(shot.id, { compiledVideoPrompt: ($event.target as HTMLTextAreaElement).value })"
          @paste="onVideoPromptPaste"
          @blur="persistShotVideoPrompt"
        />
        <label>时长（秒）</label>
        <input
          type="number"
          :min="videoMinSeconds(videoModel)"
          :max="videoMaxSeconds(videoModel)"
          step="1"
          :value="shot.duration"
          @change="project.updateShot(shot.id, { duration: Math.min(videoMaxSeconds(videoModel), Math.max(videoMinSeconds(videoModel), Math.round(Number(($event.target as HTMLInputElement).value) || shot.duration))) })"
        />
        <label>运镜</label>
        <select
          :value="shot.cameraMovement"
          @change="project.updateShot(shot.id, { cameraMovement: ($event.target as HTMLSelectElement).value as any })"
        >
          <option value="static">固定</option>
          <option value="push">推</option>
          <option value="pull">拉</option>
          <option value="pan">摇</option>
          <option value="tilt">移</option>
          <option value="orbit">环绕</option>
        </select>
        <p v-if="videoRequiresStoryboard(project.current) && !isH3Fl2va && !shot.boardAssetId" class="err">这一镜还没有六格故事看板，先生成看板再出视频。</p>
        <p v-else-if="isH3Fl2va && !shot.lastFrameAssetId" class="err">首尾帧模式需要尾帧。请在下方选择尾帧。</p>
      </template>

      <H3GenModeSelect v-if="isH3Video" v-model="h3GenMode" />
      <FramePairSlots
        v-if="isH3Fl2va"
        v-model:first-id="firstFrameId"
        v-model:last-id="lastFrameId"
        :first-hint="node.type === 'shotVideo' && shot?.imageAssetId ? '空则用本镜配图' : ''"
      />
      <ShotRefStrip
        v-else-if="shot && (node.type === 'shotBoard' || node.type === 'shotImage' || node.type === 'shotVideo')"
        :shot="shot"
        :mode="node.type === 'shotVideo' ? 'video' : node.type === 'shotBoard' ? 'board' : 'image'"
      />
      <ShotRefStrip
        v-else-if="node.type === 'subject' || node.type === 'sceneProps' || node.type === 'scene'"
        v-model:extra-ids="extraRefIds"
      />
      <div v-else-if="node.type === 'imageGen' || node.type === 'videoGen'" class="insp-refs">
        <div class="lab-row"><label>参考图</label></div>
        <div v-if="inspectorRefIds.length" class="insp-ref-list">
          <div v-for="id in inspectorRefIds" :key="id" class="insp-ref">
            <img v-if="inspectorRefUrls[id]" :src="inspectorRefUrls[id]" alt="" />
            <button type="button" class="insp-ref-del" title="移除这张参考图" @click="removeInspectorRef(id)">×</button>
          </div>
        </div>
        <p v-else class="hint">还没有参考图。在节点上点「库」或「＋」添加。</p>
      </div>

      <template v-else-if="node.type === 'audio' && shot">
        <label>人声方案</label>
        <select
          :value="effectiveShotAudioMode(shot)"
          @change="project.setShotAudioMode(shot.id, ($event.target as HTMLSelectElement).value as ShotAudioMode)"
        >
          <option value="h3-dialogue">H3 出镜对白 + 对口型</option>
          <option value="h3-voiceover">H3 画外口播</option>
          <option value="tts">后期 TTS</option>
          <option value="none">无口播</option>
        </select>
        <label>口播文案</label>
        <textarea
          rows="4"
          :value="shot.voiceover"
          placeholder="这一镜要说的话"
          @input="project.updateShot(shot.id, { voiceover: ($event.target as HTMLTextAreaElement).value })"
        />
        <TtsModelSelect v-if="effectiveShotAudioMode(shot) === 'tts'" />
      </template>

      <div v-if="historyIds.length" class="hist">
        <span>历史版本（点一下切回）</span>
        <div class="hist-row">
          <div v-for="hid in historyIds" :key="hid" class="hist-item">
            <button
              class="hist-thumb"
              type="button"
              title="查看大图"
              @click="openLightbox(historyUrls[hid], 'image')"
            >
              <img v-if="historyUrls[hid]" :src="historyUrls[hid]" alt="" />
            </button>
            <button class="hist-use" type="button" @click="restoreHistory(hid)">切回</button>
          </div>
        </div>
      </div>

      <ImageModelSelect v-if="isImageNode" />
      <VideoModelSelect v-if="node.type === 'shotVideo' || node.type === 'videoGen'" v-model="videoModel" />
      <VideoResolutionSeg
        v-if="(node.type === 'shotVideo' || node.type === 'videoGen') && videoAllows1080p(videoModel) && !isH3Fl2va"
        v-model="videoResolution"
      />
      <template v-if="node.type === 'script' && isPlayReady(project.current?.script)">
        <label>续写方向（可选）</label>
        <textarea
          rows="3"
          :value="continueHint"
          placeholder="例如：再写两场，写父亲回家之后。不填则顺着往下写 2–3 场。"
          @input="continueHint = ($event.target as HTMLTextAreaElement).value"
        />
      </template>
      <GradientButton
        v-if="node.type === 'script' && isPlayReady(project.current?.script)"
        block
        :loading="running"
        :disabled="running"
        @click="runContinue"
      >
        续写剧本
      </GradientButton>
      <GradientButton
        v-if="node.type === 'script'"
        block
        :type="isPlayReady(project.current?.script) ? 'secondary' : undefined"
        :loading="running"
        :disabled="running"
        @click="run"
      >
        {{ actionLabel }}
      </GradientButton>
      <GradientButton
        v-if="canPickAsset"
        block
        type="secondary"
        :disabled="running"
        @click="pickerOpen = true"
      >
        从资源库选用
      </GradientButton>
      <template v-if="node.type === 'script' && isImg2Video">
        <GradientButton
          block
          type="secondary"
          :loading="running"
          :disabled="running || !((project.current?.script?.content || '').trim())"
          @click="runExtract('subjects')"
        >
          提炼角色
        </GradientButton>
        <GradientButton
          block
          type="secondary"
          :loading="running"
          :disabled="running || !((project.current?.script?.content || '').trim())"
          @click="runExtract('scenes')"
        >
          提炼场景
        </GradientButton>
        <GradientButton
          block
          type="secondary"
          :loading="running"
          :disabled="running || !canExtractShots"
          @click="runExtract('shots')"
        >
          提炼分镜
        </GradientButton>
      </template>
      <GradientButton
        v-else-if="node.type === 'script' && canExtractNext"
        block
        type="secondary"
        :loading="running"
        :disabled="running || !((project.current?.script?.content || '').trim())"
        @click="runExtract()"
      >
        {{ extractLabel }}
      </GradientButton>
      <GradientButton
        v-else-if="node.type !== 'script' || !canExtractNext"
        block
        :loading="running"
        :disabled="!canRun"
        @click="run"
      >
        {{ gateBlocked ? '请先验收剧本' : actionLabel }}
      </GradientButton>
      <GradientButton
        v-if="node.type === 'final' && hasAsset"
        block
        type="secondary"
        @click="downloadFinal"
      >
        下载视频
      </GradientButton>
      <button class="ghost" type="button" @click="refreshPreview">刷新预览</button>
    </template>
    <AssetPicker
      :open="pickerOpen"
      kind="image"
      title="选用已有图片作为本节点结果"
      show-library
      default-tab="page"
      :selected-ids="currentAssetId ? [currentAssetId] : []"
      @close="pickerOpen = false"
      @confirm="onPickerConfirm"
    />
  </aside>
</template>

<style scoped>
.insp {
  width: 300px;
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-1);
  padding: 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.insp h3 {
  margin: 0;
  font-size: 16px;
}
.insp-k {
  font-size: 10px;
  color: var(--color-text-4);
  text-transform: uppercase;
}
.insp-ref-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  overflow: visible;
  padding-top: 6px;
}
.insp-ref {
  position: relative;
  width: 56px;
  overflow: visible;
}
.insp-ref img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
  display: block;
  background: var(--color-bg-2);
}
.insp-ref-del {
  position: absolute;
  top: -6px;
  right: -6px;
  z-index: 2;
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
}
.empty,
.err,
.hint {
  font-size: 12px;
  color: var(--color-text-3);
  margin: 0;
}
.err {
  color: var(--color-error);
}
.lab-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.lab-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.link {
  font-size: 11px;
  color: var(--color-accent);
  padding: 0;
  background: none;
}
.link:disabled {
  opacity: 0.4;
  cursor: default;
}
label {
  font-size: 11px;
  color: var(--color-text-4);
}
input,
textarea,
select {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-1);
  padding: 8px;
  font: inherit;
  font-size: 12px;
}
textarea {
  min-height: 120px;
  flex: 1;
}
.prev {
  align-self: flex-start;
  width: 148px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-bg-3);
  cursor: zoom-in;
}
.prev-frame {
  position: relative;
  width: 100%;
  background: var(--color-bg-2);
}
.prev img,
.prev video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  display: block;
}
.prev span {
  display: block;
  font-size: 10px;
  color: var(--color-text-4);
  padding: 4px 6px 5px;
  text-align: center;
}
.prev-audio {
  width: 100%;
  max-width: 100%;
  cursor: default;
  padding: 8px 8px 0;
}
.prev-audio audio {
  width: 100%;
  height: 36px;
  display: block;
}
.prev-video {
  width: 100%;
  max-width: 220px;
  cursor: default;
}
.hist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hist > span {
  font-size: 11px;
  color: var(--color-text-4);
}
.hist-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.hist-item {
  width: 56px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: none;
}
.hist-thumb {
  width: 56px;
  height: 40px;
  padding: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-bg-3);
  cursor: zoom-in;
}
.hist-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hist-use {
  font-size: 10px;
  padding: 1px 0;
  color: var(--color-text-4);
  background: none;
}
.hist-use:hover {
  color: var(--color-accent);
}
.ghost {
  font-size: 12px;
  color: var(--color-text-3);
  padding: 6px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-2);
}
.check input {
  width: auto;
}
.seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.seg-btn {
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-2);
  border-radius: 8px;
  padding: 8px 6px;
  font-size: 12px;
  cursor: pointer;
}
.seg-btn.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-bg-2));
}
.vol-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
}
.vol-row input[type='range'] {
  padding: 0;
  background: transparent;
  border: none;
}
.bgm-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bgm-row select {
  flex: 1;
  min-width: 0;
}
.bgm-player {
  width: 100%;
  height: 32px;
}
</style>
