<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { concatVideos } from '@/services/ffmpeg'
import AssetPicker from '@/components/common/AssetPicker.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'
import EditIcon from '@/components/edit/EditIcon.vue'
import ThemeToggle from '@/components/common/ThemeToggle.vue'
import type { AudioTimelineClip, Shot, TextOverlay, TimelineClip, TransitionType } from '@/types'
import { buildTimelineFromShots, timelineClipAssetId } from '@/utils/timeline'
import { isDigitalHumanSpeechProject } from '@/utils/shot'
import { runCanvasNode } from '@/services/canvas/runner'
import { generateFinalCut } from '@/services/canvas/exportFinal'
import { pickLocalFiles } from '@/utils/pickLocalFiles'

const router = useRouter()
const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()

const selectedClipId = ref<string | null>(null)
const previewingUrl = ref<string | null>(null)
const previewBlob = ref<Blob | null>(null)
const previewing_ = ref(false)
const previewTitle = ref('成片预览')
const previewFilename = ref('成片.mp4')
const merging = ref(false)
const mergeProgress = ref('')
const previewProgress = ref<number | null>(null)
const progressLabel = ref('合成')
const videoPickerOpen = ref(false)
const audioPickerOpen = ref(false)
const audioPickerMode = ref<'bgm' | 'voice'>('bgm')
const importingVoice = ref(false)
const voicePreviewUrl = ref('')
const voicePlayer = ref<HTMLAudioElement | null>(null)
const mediaTab = ref<'clip' | 'audio' | 'text'>('clip')
const mediaQuery = ref('')
const importingVideo = ref(false)
const importingAudio = ref(false)
const selectedTextId = ref<string | null>(null)
const sourcePreviewUrl = ref('')
const sourcePreviewTitle = ref('')
const previewAspect = ref<'16:9' | '9:16'>('9:16')
const sourcePlayer = ref<HTMLVideoElement | null>(null)
const pendingSourceTime = ref<number | null>(null)
const playhead = ref(0)
const playingTimeline = ref(false)
const previewClipId = ref<string | null>(null)
const previewLoadKey = ref(0)
let previewRequest = 0
let switching = false

function clearAutomaticFades() {
  const current = project.current
  if (!current || current.settings.defaultTransition !== 'fade') return
  const timeline = current.timeline.map((clip) =>
    clip.transitionIn === 'fade' ? { ...clip, transitionIn: 'none' as const, transitionDuration: 0 } : clip
  )
  project.setTimeline(timeline)
  project.setSettings({ defaultTransition: 'none' })
}

function fallbackAspect(): '16:9' | '9:16' {
  const ratio = project.current?.settings.aspectRatio
  return ratio === '16:9' || ratio === '4:3' || ratio === '21:9' ? '16:9' : '9:16'
}

function setAspectFromSize(width: number, height: number) {
  if (!width || !height) return
  previewAspect.value = width >= height ? '16:9' : '9:16'
}

function setAspectFromAsset(assetId?: string) {
  if (!assetId) return
  const meta = assets.getMeta(assetId)
  if (!meta || !('width' in meta)) return
  setAspectFromSize(Number(meta.width), Number(meta.height))
}

function onPreviewMetadata(event: Event) {
  const player = event.currentTarget as HTMLVideoElement
  setAspectFromSize(player.videoWidth, player.videoHeight)
  applyPendingSeek(event)
}

async function focusClip(id: string) {
  selectedTextId.value = null
  const index = timeline.value.findIndex((clip) => clip.id === id)
  const clip = timeline.value[index]
  if (index < 0 || !clip) return
  await playClip(clip, index, clip.startTime, false, true)
}

onMounted(async () => {
  if (!project.current) return
  previewAspect.value = fallbackAspect()
  clearAutomaticFades()
  // 第一次进入按分镜顺序铺满；之后保留用户顺序，只补上新生成的视频。
  if (project.current.timeline.length === 0 && project.current.shots.length > 0) {
    autoBuildTimeline()
  } else {
    appendMissingShots()
  }
  await seekTimeline(0)
})

onUnmounted(() => {
  previewRequest++
  voicePlayer.value?.pause()
  if (previewingUrl.value) URL.revokeObjectURL(previewingUrl.value)
})

const shots = computed(() => project.current?.shots ?? [])
const timeline = computed(() => project.current?.timeline ?? [])
const selectedClip = computed(() =>
  timeline.value.find((c) => c.id === selectedClipId.value) ?? null
)
const canTrimSelected = computed(() => {
  const clip = selectedClip.value
  if (!clip) return false
  const offset = playhead.value - clip.startTime
  return offset >= 0.1 && clip.duration - offset >= 0.1
})
const voiceClips = computed(() =>
  timeline.value
    .filter((clip) => clip.voiceAssetId)
    .map((clip) => ({
      id: clip.id,
      name: assets.getMeta(clip.voiceAssetId || '')?.filename || '配音',
      startTime: clip.startTime,
      duration: clip.duration
    }))
)
const selectedVoiceName = computed(() => {
  const id = selectedClip.value?.voiceAssetId
  return id ? assets.getMeta(id)?.filename || '已配音' : ''
})
const selectedShot = computed(() => {
  if (!selectedClip.value) return null
  return shots.value.find((s) => s.id === selectedClip.value!.shotId) ?? null
})
const isDigitalHuman = computed(() => isDigitalHumanSpeechProject(project.current))
const bgmName = computed(() => {
  const id = project.current?.bgmAssetId
  return id ? assets.getMeta(id)?.filename || '已选择背景音乐' : '未添加背景音乐'
})
const textOverlays = computed(() => project.current?.textOverlays || [])
const selectedText = computed(() => textOverlays.value.find((item) => item.id === selectedTextId.value) || null)
const activeTexts = computed(() => textOverlays.value.filter((item) => playhead.value >= item.startTime && playhead.value <= item.startTime + item.duration))
const clipSourceDurations = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {}
  if (!project.current) return result
  for (const clip of timeline.value) {
    const assetId = timelineClipAssetId(project.current, clip)
    if (!assetId) continue
    const meta = assets.getMeta(assetId)
    if (meta?.kind === 'video' && Number(meta.duration) > 0) result[clip.id] = Number(meta.duration)
  }
  return result
})

function clipTitle(clip: TimelineClip, index: number) {
  const shot = shots.value.find((item) => item.id === clip.shotId)
  return shot?.title || clip.label || `视频片段 ${index + 1}`
}

async function playClip(clip: TimelineClip, index: number, seconds = clip.startTime, play = true, select = true) {
  const current = project.current
  if (!current) return
  const request = ++previewRequest
  switching = true
  pendingSourceTime.value = null
  playingTimeline.value = play
  sourcePlayer.value?.pause()
  playhead.value = seconds
  if (select) selectedClipId.value = clip.id
  const same = previewClipId.value === clip.id && Boolean(sourcePreviewUrl.value)
  const assetId = timelineClipAssetId(current, clip)
  setAspectFromAsset(assetId)
  let url = ''
  let voiceUrl = ''
  try {
    url = same ? sourcePreviewUrl.value : assetId ? (await assets.getUrl(assetId)) || '' : ''
    voiceUrl = clip.voiceAssetId ? (await assets.getUrl(clip.voiceAssetId)) || '' : ''
  } catch {}
  if (request !== previewRequest || project.current?.id !== current.id) return
  if (!url) {
    switching = false
    playingTimeline.value = false
    previewClipId.value = null
    sourcePreviewUrl.value = ''
    voicePreviewUrl.value = ''
    voicePlayer.value?.pause()
    toast.warn('这个片段没有可读取的视频素材')
    return
  }
  previewClipId.value = clip.id
  sourcePreviewTitle.value = clipTitle(clip, index)
  const offset = Math.max(0, Math.min(clip.duration, seconds - clip.startTime))
  pendingSourceTime.value = clip.sourceIn + offset * clip.speed
  if (!same) previewLoadKey.value++
  sourcePreviewUrl.value = url
  voicePreviewUrl.value = voiceUrl
  if (!voiceUrl) voicePlayer.value?.pause()
  await nextTick()
  if (request === previewRequest) applyPendingSeek()
}

function syncVoicePlayback(play: boolean) {
  const audio = voicePlayer.value
  const player = sourcePlayer.value
  const clip = timeline.value.find((item) => item.id === previewClipId.value)
  if (!audio || !player || !clip?.voiceAssetId || !voicePreviewUrl.value) {
    audio?.pause()
    return
  }
  const timelineOffset = Math.max(0, (player.currentTime - clip.sourceIn) / Math.max(0.01, clip.speed || 1))
  audio.volume = Math.max(0, Math.min(1, clip.voiceVolume ?? 1))
  if (audio.readyState >= 1) {
    const target = Math.max(0, (clip.voiceSourceIn || 0) + timelineOffset)
    const limit = Number.isFinite(audio.duration) ? audio.duration : target
    if (Math.abs(audio.currentTime - target) > 0.3) audio.currentTime = Math.min(limit, target)
  }
  if (play) audio.play().catch(() => {})
  else audio.pause()
}

function applyPendingSeek(event?: Event) {
  const player = sourcePlayer.value
  const target = pendingSourceTime.value
  if (!player || (event && event.currentTarget !== player) || player.readyState < 1 || target == null) return
  const clip = timeline.value.find(item => item.id === previewClipId.value)
  player.playbackRate = Math.max(0.25, Math.min(3, clip?.speed || 1))
  const nextTime = Math.max(0, Math.min(Number.isFinite(player.duration) ? player.duration : target, target))
  pendingSourceTime.value = null
  switching = false
  const shouldPlay = playingTimeline.value
  const request = previewRequest
  const start = () => {
    if (request !== previewRequest || sourcePlayer.value !== player) return
    syncVoicePlayback(shouldPlay && playingTimeline.value)
    if (!shouldPlay || !playingTimeline.value) return
    player.play().catch((error: unknown) => {
      if (request !== previewRequest || sourcePlayer.value !== player) return
      const name = error instanceof DOMException ? error.name : ''
      if (name === 'AbortError') return
      playingTimeline.value = false
      toast.warn('这段视频无法播放')
    })
  }
  if (Math.abs(player.currentTime - nextTime) > 0.08) {
    const onSeeked = () => {
      player.removeEventListener('seeked', onSeeked)
      start()
    }
    player.addEventListener('seeked', onSeeked)
    player.currentTime = nextTime
    return
  }
  start()
}

function onFrameClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('.player-text-overlay')) return
  if (!timeline.value.some((clip) => clip.enabled)) return
  void toggleTimelinePlayback()
}

async function seekTimeline(seconds: number) {
  const enabled = timeline.value.filter(item => item.enabled)
  const clip = enabled.find(item => seconds < item.startTime + item.duration) || enabled.at(-1)
  if (!clip) return
  await playClip(clip, timeline.value.indexOf(clip), Math.max(clip.startTime, seconds), false, false)
}

async function toggleTimelinePlayback() {
  if (playingTimeline.value) {
    playingTimeline.value = false
    sourcePlayer.value?.pause()
    voicePlayer.value?.pause()
    return
  }
  const enabled = timeline.value.filter(item => item.enabled)
  const first = enabled[0]
  if (!first) return
  const current = enabled.find(item => playhead.value < item.startTime + item.duration)
  const clip = current || first
  await playClip(clip, timeline.value.indexOf(clip), current ? Math.max(clip.startTime, playhead.value) : clip.startTime, true, false)
}

function playTimelineFromStart() {
  const index = timeline.value.findIndex(item => item.enabled)
  if (index >= 0) void playClip(timeline.value[index], index, timeline.value[index].startTime, true, false)
}

function advanceTimeline(event: Event) {
  if (!playingTimeline.value || switching || event.currentTarget !== sourcePlayer.value) return
  const index = timeline.value.findIndex(item => item.id === previewClipId.value)
  if (index < 0) return
  const clip = timeline.value[index]
  playhead.value = clip.startTime + clip.duration
  const next = timeline.value.findIndex((item, i) => i > index && item.enabled)
  if (next >= 0) void playClip(timeline.value[next], next, timeline.value[next].startTime, true, false)
  else {
    playingTimeline.value = false
    sourcePlayer.value?.pause()
  }
}

function syncPlayheadFromPlayer(event: Event) {
  const player = sourcePlayer.value
  const clip = timeline.value.find(item => item.id === previewClipId.value)
  if (!playingTimeline.value || switching || !player || event.currentTarget !== player || !clip) return
  const elapsed = Math.max(0, player.currentTime - clip.sourceIn) / Math.max(0.01, clip.speed)
  playhead.value = Math.min(clip.startTime + clip.duration, clip.startTime + elapsed)
  if (elapsed >= clip.duration) advanceTimeline(event)
}

function trimAtPlayhead(id: string, side: 'left' | 'right') {
  const clip = timeline.value.find(item => item.id === id)
  if (!clip) return
  const offset = playhead.value - clip.startTime
  if (offset < 0.1 || clip.duration - offset < 0.1) return
  const seconds = side === 'left' ? clip.startTime : playhead.value
  updateClip(id, side === 'left'
    ? { sourceIn: clip.sourceIn + offset * clip.speed, duration: clip.duration - offset }
    : { duration: offset })
  void seekTimeline(seconds)
}

function autoBuildTimeline() {
  if (!project.current) return
  const clips = buildTimelineFromShots(project.current)
  project.setTimeline(clips)
  toast.success(`已自动构建 ${clips.length} 个片段的时间线`)
}

function addShotToTimeline(shot: Shot, preview = true) {
  if (!project.current) return
  const existing = timeline.value.find((c) => c.shotId === shot.id)
  if (existing) {
    if (preview) void focusClip(existing.id)
    return
  }
  const lastEnd = timeline.value.reduce(
    (max, c) => Math.max(max, c.startTime + c.duration),
    0
  )
  const newClip: TimelineClip = {
    id: 'tc_' + Date.now().toString(36),
    shotId: shot.id,
    startTime: lastEnd,
    duration: shot.duration,
    sourceIn: 0,
    transitionIn: 'none',
    transitionDuration: 0,
    speed: 1,
    volume: 1,
    enabled: true
  }
  project.addClip(newClip)
  if (preview) {
    toast.success(`已加入：${shot.title}`)
    void focusClip(newClip.id)
  }
}

function addAllShots() {
  let added = 0
  for (const s of [...shots.value].sort((a, b) => a.index - b.index)) {
    if (!timeline.value.find((c) => c.shotId === s.id)) {
      addShotToTimeline(s, false)
      added++
    }
  }
  const first = timeline.value[0]
  if (first) void focusClip(first.id)
  if (added) toast.success(`已加入 ${added} 个片段`)
}

function appendMissingShots() {
  if (!project.current) return
  const missing = [...shots.value]
    .filter((shot) => (shot.videoAssetId || shot.imageAssetId) && !timeline.value.some((clip) => clip.shotId === shot.id))
    .sort((a, b) => a.index - b.index)
  if (!missing.length) return
  let cursor = timeline.value.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0)
  const additions: TimelineClip[] = missing.map((shot) => {
    const clip: TimelineClip = {
      id: 'tc_' + shot.id,
      shotId: shot.id,
      startTime: cursor,
      duration: shot.duration,
      sourceIn: 0,
      transitionIn: 'none',
      transitionDuration: 0,
      speed: 1,
      volume: 1,
      enabled: true
    }
    cursor += clip.duration
    return clip
  })
  project.setTimeline([...timeline.value, ...additions])
  toast.info(`已补入 ${additions.length} 个新生成的视频片段`)
}

async function addVideoAssets(ids: string[]) {
  if (!project.current || !ids.length) return
  let cursor = timeline.value.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0)
  const stamp = Date.now().toString(36)
  const additions: TimelineClip[] = []
  for (const assetId of ids) {
    let meta = assets.getMeta(assetId)
    if (!meta || meta.kind !== 'video') {
      try {
        meta = await assets.adopt(assetId, 'video', { projectId: project.current.id })
      } catch {
        continue
      }
    }
    if (!meta || meta.kind !== 'video') continue
    const duration = Math.max(0.5, Number(meta.duration) || 5)
    additions.push({
      id: `tc_asset_${stamp}_${additions.length}`,
      shotId: `asset_${assetId}_${stamp}_${additions.length}`,
      assetId,
      label: meta.filename || `视频 ${timeline.value.length + additions.length + 1}`,
      startTime: cursor,
      duration,
      sourceIn: 0,
      transitionIn: 'none',
      transitionDuration: 0,
      speed: 1,
      volume: 1,
      enabled: true
    })
    cursor += duration
  }
  if (!additions.length) {
    toast.warn('没有可加入的视频')
    return
  }
  project.setTimeline([...timeline.value, ...additions])
  selectedClipId.value = additions[0].id
  toast.success(`已加入 ${additions.length} 个视频片段`)
  void focusClip(additions[0].id)
}

async function importVideos() {
  if (!project.current || importingVideo.value) return
  importingVideo.value = true
  try {
    const files = await pickLocalFiles({ kind: 'video', multiple: true })
    const ids: string[] = []
    for (const file of files) {
      const asset = await assets.add(file, 'video', 'uploaded', {
        filename: file.name,
        projectId: project.current.id
      })
      ids.push(asset.id)
    }
    await addVideoAssets(ids)
  } catch (e: any) {
    toast.error(`导入视频失败：${e?.message || String(e)}`)
  } finally {
    importingVideo.value = false
  }
}

function chooseBgm(ids: string[]) {
  const assetId = ids[0]
  if (!assetId) return
  const meta = assets.getMeta(assetId)
  const audioDuration = meta && 'duration' in meta ? Number(meta.duration) : 0
  const total = Number(totalDuration.value) || audioDuration || 5
  project.setBgmClip({
    assetId,
    startTime: 0,
    sourceIn: 0,
    duration: Math.max(0.5, Math.min(audioDuration || total, total)),
    volume: project.current?.settings.bgmVolume ?? 0.25
  })
  toast.success('背景音乐已投入音乐轨，可调整位置和长度')
}

function updateBgmClip(patch: Partial<AudioTimelineClip>) {
  const clip = project.current?.bgmClip
  if (!clip) return
  const next = { ...clip, ...patch }
  project.setBgmClip(next)
  if (patch.volume != null) project.setSettings({ bgmVolume: patch.volume })
}

function addTextOverlay() {
  if (!project.current) return
  const clip = selectedClip.value
  const head = Math.max(0, playhead.value)
  const inside = clip && head >= clip.startTime && head < clip.startTime + clip.duration
  const start = inside ? head : clip?.startTime ?? head
  const end = clip ? clip.startTime + clip.duration : start + 3
  const item: TextOverlay = {
    id: `txt_${Date.now().toString(36)}`,
    text: '输入文字',
    startTime: start,
    duration: Math.max(0.5, end - start),
    fontFamily: project.current.settings.captionStyle.fontFamily || 'Microsoft YaHei',
    fontSizeRatio: project.current.settings.captionStyle.fontSizeRatio || 0.05,
    color: project.current.settings.captionStyle.color || '#ffffff',
    position: project.current.settings.captionStyle.position || 'bottom',
    xRatio: 0.5,
    yRatio: 0.82,
    bold: project.current.settings.captionStyle.bold ?? true
  }
  project.setTextOverlays([...textOverlays.value, item])
  selectedTextId.value = item.id
  mediaTab.value = 'text'
  toast.success('文字已加在当前片段上，可直接改内容')
}

function focusText(id: string) {
  selectedTextId.value = id
  mediaTab.value = 'text'
}

function trimSelected(side: 'left' | 'right') {
  if (!selectedClip.value || !canTrimSelected.value) {
    toast.warn('先把竖线移到片段内部，再裁前段或后段')
    return
  }
  trimAtPlayhead(selectedClip.value.id, side)
}

function openBgmPicker() {
  audioPickerMode.value = 'bgm'
  audioPickerOpen.value = true
}

function openVoicePicker() {
  if (!selectedClip.value) {
    toast.warn('先选中一段视频，再给它配音')
    return
  }
  audioPickerMode.value = 'voice'
  audioPickerOpen.value = true
}

async function onAudioPicked(ids: string[]) {
  if (audioPickerMode.value === 'voice') await assignVoice(ids[0])
  else chooseBgm(ids)
}

async function assignVoice(assetId?: string) {
  const clip = selectedClip.value
  if (!project.current || !clip) {
    toast.warn('先选中一段视频，再给它配音')
    return
  }
  if (!assetId) return
  let meta = assets.getMeta(assetId)
  if (!meta || meta.kind !== 'audio') {
    try {
      meta = await assets.adopt(assetId, 'audio', { projectId: project.current.id })
    } catch (error: any) {
      toast.error(`配音读取失败：${error?.message || '素材无效'}`)
      return
    }
  }
  if (!meta || meta.kind !== 'audio') {
    toast.warn('请选择音频作为配音')
    return
  }
  updateClip(clip.id, {
    voiceAssetId: meta.id,
    voiceSourceIn: clip.voiceSourceIn ?? 0,
    voiceVolume: clip.voiceVolume ?? 1
  })
  if (shots.value.some((shot) => shot.id === clip.shotId)) project.assignShotAudio(clip.shotId, meta.id)
  toast.success('配音已加到这段视频')
  if (previewClipId.value === clip.id) {
    voicePreviewUrl.value = (await assets.getUrl(meta.id)) || ''
    await nextTick()
    syncVoicePlayback(playingTimeline.value)
  }
}

function clearVoice() {
  const id = selectedClip.value?.id
  if (!id) return
  updateClip(id, { voiceAssetId: undefined, voiceSourceIn: undefined, voiceVolume: undefined })
  if (previewClipId.value === id) {
    voicePreviewUrl.value = ''
    voicePlayer.value?.pause()
  }
}

async function importVoice() {
  if (!project.current || importingVoice.value) return
  if (!selectedClip.value) {
    toast.warn('先选中一段视频，再导入配音')
    return
  }
  importingVoice.value = true
  try {
    const [file] = await pickLocalFiles({ kind: 'audio', multiple: false })
    if (!file) return
    const asset = await assets.add(file, 'audio', 'uploaded', {
      filename: file.name,
      projectId: project.current.id
    })
    await assignVoice(asset.id)
  } catch (error: any) {
    toast.error(`导入配音失败：${error?.message || String(error)}`)
  } finally {
    importingVoice.value = false
  }
}

function updateTextOverlay(patch: Partial<TextOverlay>) {
  if (!selectedText.value) return
  project.setTextOverlays(textOverlays.value.map((item) => item.id === selectedText.value!.id ? { ...item, ...patch } : item))
}

function textOverlayStyle(item: TextOverlay) {
  const fallbackY = item.position === 'top' ? 0.15 : item.position === 'center' ? 0.5 : 0.85
  return {
    left: `${(item.xRatio ?? 0.5) * 100}%`,
    top: `${(item.yRatio ?? fallbackY) * 100}%`,
    color: item.color,
    fontFamily: item.fontFamily,
    fontSize: `${Math.max(16, item.fontSizeRatio * 520)}px`,
    fontWeight: item.bold ? '700' : '400'
  }
}

function startTextDrag(event: PointerEvent, item: TextOverlay) {
  const frame = (event.currentTarget as HTMLElement).parentElement
  if (!frame) return
  event.preventDefault()
  selectedTextId.value = item.id
  const move = (next: PointerEvent) => {
    const rect = frame.getBoundingClientRect()
    const xRatio = Math.max(0.07, Math.min(0.93, (next.clientX - rect.left) / rect.width))
    const yRatio = Math.max(0.07, Math.min(0.93, (next.clientY - rect.top) / rect.height))
    project.setTextOverlays(textOverlays.value.map((text) => text.id === item.id ? { ...text, xRatio, yRatio } : text))
  }
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

function setTextPositionPreset(position: TextOverlay['position']) {
  updateTextOverlay({ position, xRatio: 0.5, yRatio: position === 'top' ? 0.15 : position === 'center' ? 0.5 : 0.85 })
}

function removeTextOverlay(id: string) {
  project.setTextOverlays(textOverlays.value.filter((item) => item.id !== id))
  if (selectedTextId.value === id) selectedTextId.value = null
}

async function importBgm() {
  if (!project.current || importingAudio.value) return
  importingAudio.value = true
  try {
    const [file] = await pickLocalFiles({ kind: 'audio', multiple: false })
    if (!file) return
    const asset = await assets.add(file, 'audio', 'uploaded', {
      filename: file.name,
      projectId: project.current.id
    })
    chooseBgm([asset.id])
  } catch (e: any) {
    toast.error(`导入音乐失败：${e?.message || String(e)}`)
  } finally {
    importingAudio.value = false
  }
}

function updateClip(id: string, patch: Partial<TimelineClip>) {
  project.updateClip(id, patch)
  recalculateStarts()
}

function removeClip(id: string) {
  project.removeClip(id)
  recalculateStarts()
}

function recalculateStarts() {
  if (!project.current) return
  let cursor = 0
  const updated = timeline.value.map((c) => {
    const next = { ...c, startTime: cursor }
    cursor += c.duration
    return next
  })
  project.setTimeline(updated)
}

function reorderClip(fromId: string, toId: string) {
  if (!project.current || fromId === toId) return
  const ordered = [...timeline.value]
  const from = ordered.findIndex((clip) => clip.id === fromId)
  const to = ordered.findIndex((clip) => clip.id === toId)
  if (from < 0 || to < 0) return
  const [moved] = ordered.splice(from, 1)
  ordered.splice(to, 0, moved)
  let cursor = 0
  project.setTimeline(
    ordered.map((clip) => {
      const next = { ...clip, startTime: cursor }
      cursor += clip.duration
      return next
    })
  )
  selectedClipId.value = moved.id
}

const totalDuration = computed(() =>
  timeline.value
    .filter((c) => c.enabled)
    .reduce((sum, c) => sum + c.duration, 0)
    .toFixed(1)
)

const timelineEnd = computed(() => {
  const ends = timeline.value.map((clip) => clip.startTime + clip.duration)
  if (project.current?.bgmClip) ends.push(project.current.bgmClip.startTime + project.current.bgmClip.duration)
  for (const item of textOverlays.value) ends.push(item.startTime + item.duration)
  return ends.length ? Math.max(...ends) : 0
})

function timecode(value: number) {
  const safe = Math.max(0, Number(value) || 0)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const f = Math.floor((safe % 1) * 24)
  return [h, m, s, f].map((n) => String(n).padStart(2, '0')).join(':')
}

const filteredShots = computed(() => {
  const q = mediaQuery.value.trim().toLowerCase()
  return shots.value.filter((shot) => !q || shot.title.toLowerCase().includes(q) || String(shot.index + 1).includes(q))
})

const importedClips = computed(() => {
  const q = mediaQuery.value.trim().toLowerCase()
  const shotIds = new Set(shots.value.map((shot) => shot.id))
  return timeline.value.filter((clip) => {
    if (!clip.assetId || shotIds.has(clip.shotId)) return false
    const label = clip.label || '视频素材'
    return !q || label.toLowerCase().includes(q)
  })
})

function noteComposeProgress(msg: string) {
  const matched = /处理中\s+(\d+(?:\.\d+)?)%/.exec(msg)
  if (!matched) return
  previewProgress.value = Math.min(100, Math.round(Number(matched[1])))
}

/** 预览：用 FFmpeg 把当前时间线快速拼一下 */
async function preview() {
  if (!project.current) return
  if (merging.value) return
  if (timeline.value.length === 0) {
    toast.warn('时间线是空的')
    return
  }
  merging.value = true
  progressLabel.value = '预览合成'
  previewProgress.value = 0
  try {
    const segments = await buildSegments()
    if (segments.length === 0) {
      toast.error('没有可用的视频片段')
      return
    }
    const blob = await concatVideos(segments, {
      width: project.current.settings.width,
      height: project.current.settings.height,
      fps: project.current.settings.fps,
      format: 'webm',
      mimeType: 'video/webm',
      onProgress: noteComposeProgress
    })
    previewProgress.value = 100
    showFinishedPreview(blob, '预览就绪', `${safeName()}.webm`)
  } catch (e: any) {
    toast.error('预览失败：' + e.message)
  } finally {
    merging.value = false
    previewProgress.value = null
  }
}

async function confirmMerge() {
  if (!project.current || merging.value) return
  if (!timeline.value.some((clip) => clip.enabled)) {
    toast.warn('时间线上没有启用的视频片段')
    return
  }
  const node = project.current.canvas?.nodes.find((item) => item.type === 'export' || item.type === 'final')
  merging.value = true
  progressLabel.value = '正式合成'
  previewProgress.value = 0
  mergeProgress.value = '合成中…'
  try {
    if (node) {
      await runCanvasNode(node.id, (_id, message) => noteComposeProgress(message))
    } else {
      await generateFinalCut(noteComposeProgress)
    }
    const assetId = project.current?.finalVideoAssetId
    const blob = assetId ? await assets.getBlob(assetId) : undefined
    if (!blob) {
      toast.warn('合成结束了，但没有拿到成片文件')
      return
    }
    previewProgress.value = 100
    showFinishedPreview(blob, '合成完成', `${safeName()}.mp4`)
  } catch (e: any) {
    toast.error(`合成失败：${e?.message || String(e)}`)
  } finally {
    merging.value = false
    mergeProgress.value = ''
    previewProgress.value = null
  }
}

async function buildSegments() {
  if (!project.current) return []
  const segs: Array<{ blob: Blob; sourceIn: number; duration: number; speed: number; enabled: boolean }> = []
  for (const clip of timeline.value) {
    if (!clip.enabled) continue
    const assetId = timelineClipAssetId(project.current, clip)
    if (!assetId) continue
    const blob = await assets.getBlob(assetId)
    if (!blob) continue
    segs.push({
      blob,
      sourceIn: clip.sourceIn,
      duration: clip.duration,
      speed: clip.speed,
      enabled: true
    })
  }
  return segs
}

function safeName() {
  return (project.current?.name || '成片').replace(/[\\/:*?"<>|]/g, ' ').trim() || '成片'
}

function showFinishedPreview(blob: Blob, title: string, filename: string) {
  previewBlob.value = blob
  if (previewingUrl.value?.startsWith('blob:')) URL.revokeObjectURL(previewingUrl.value)
  previewingUrl.value = URL.createObjectURL(blob)
  previewTitle.value = title
  previewFilename.value = filename
  previewing_.value = true
}

function downloadFinished() {
  if (!previewingUrl.value) return
  const a = document.createElement('a')
  a.href = previewingUrl.value
  a.download = previewFilename.value
  a.click()
}

function next() {
  router.push('/caption')
}

function goBack() {
  router.push(isDigitalHuman.value ? '/smart-speech' : '/videos')
}
</script>

<template>
  <div class="editor">
    <div class="edtool">
      <button type="button" class="icon-btn" title="返回上一步" aria-label="返回上一步" @click="goBack">
        <EditIcon name="back" :size="16" />
      </button>
      <span class="ed-name" :title="project.current?.name">{{ project.current?.name || '视频剪辑' }}</span>
      <details class="edit-tools">
        <summary>更多</summary>
        <div class="edit-tools-menu" @click="($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">
          <button type="button" :disabled="merging" @click="autoBuildTimeline">重建时间线</button>
          <button type="button" :disabled="merging" @click="preview">合成预览</button>
          <button v-if="previewingUrl && !previewing_" type="button" @click="previewing_ = true">查看成片</button>
          <button type="button" @click="next">字幕设置</button>
        </div>
      </details>
      <button type="button" class="icon-btn" title="删除选中片段" :disabled="!selectedClip" @click="selectedClip && removeClip(selectedClip.id)">
        <EditIcon name="trash" :size="15" />
      </button>
      <div class="ed-right">
        <ThemeToggle />
        <span v-if="previewProgress === null" class="save-badge">时间线</span>
        <span v-else class="save-badge">{{ progressLabel }} {{ previewProgress }}%</span>
        <button class="export-btn" type="button" :disabled="merging" @click="confirmMerge">{{ merging ? '合成中…' : '导出成片' }}</button>
      </div>
    </div>
    <div v-if="previewProgress !== null" class="preview-progress" role="progressbar" :aria-valuenow="previewProgress" aria-valuemin="0" aria-valuemax="100">
      <div class="preview-progress-fill" :style="{ width: `${previewProgress}%` }"></div>
    </div>

    <div class="edmain">
      <aside class="medialib">
        <div class="ml-head">
          <div class="ml-tabs" role="tablist">
            <button type="button" role="tab" :class="{ on: mediaTab === 'clip' }" @click="mediaTab = 'clip'">片段</button>
            <button type="button" role="tab" :class="{ on: mediaTab === 'audio' }" @click="mediaTab = 'audio'">音频</button>
            <button type="button" role="tab" :class="{ on: mediaTab === 'text' }" @click="mediaTab = 'text'">字幕</button>
          </div>
          <input v-model="mediaQuery" class="ml-search" placeholder="搜索素材" />
        </div>
        <div v-if="mediaTab === 'clip'" class="ml-body">
          <div class="ml-actions">
            <button type="button" @click="addAllShots">全部加入</button>
            <button type="button" @click="videoPickerOpen = true">项目视频</button>
            <button type="button" :disabled="importingVideo" @click="importVideos">{{ importingVideo ? '导入中…' : '本地视频' }}</button>
          </div>
          <button
            v-for="shot in filteredShots"
            :key="shot.id"
            type="button"
            class="mlrow"
            :class="{ on: timeline.find(c => c.shotId === shot.id) }"
            @click="addShotToTimeline(shot)"
          >
            <span class="th">{{ shot.index + 1 }}</span>
            <span class="meta">
              <span class="n">{{ shot.title }}</span>
              <span class="d">{{ shot.duration }}s<span v-if="!shot.videoAssetId && !shot.imageAssetId"> · 无素材</span></span>
            </span>
          </button>
          <button
            v-for="clip in importedClips"
            :key="clip.id"
            type="button"
            class="mlrow"
            :class="{ on: selectedClipId === clip.id }"
            @click="focusClip(clip.id)"
          >
            <span class="th">▶</span>
            <span class="meta">
              <span class="n">{{ clip.label || '视频素材' }}</span>
              <span class="d">{{ clip.duration.toFixed(1) }}s</span>
            </span>
          </button>
          <p v-if="!filteredShots.length && !importedClips.length" class="ml-empty">没有匹配的片段</p>
        </div>
        <div v-else-if="mediaTab === 'audio'" class="ml-body">
          <div class="ml-actions">
            <button type="button" @click="openBgmPicker">选择音乐</button>
            <button type="button" :disabled="importingAudio" @click="importBgm">{{ importingAudio ? '导入中…' : '本地音乐' }}</button>
          </div>
          <p class="hint">这里是整片背景音乐。配音请选中视频片段后，用时间线上的「配音」。</p>
          <div class="audio-card">
            <strong>{{ bgmName }}</strong>
            <template v-if="project.current?.bgmClip">
              <label>开始（秒）<input type="number" min="0" step="0.1" :value="project.current.bgmClip.startTime" @change="updateBgmClip({ startTime: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label>长度（秒）<input type="number" min="0.5" step="0.1" :value="project.current.bgmClip.duration" @change="updateBgmClip({ duration: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label>音乐入点（秒）<input type="number" min="0" step="0.1" :value="project.current.bgmClip.sourceIn" @change="updateBgmClip({ sourceIn: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label>音量 {{ Math.round(project.current.bgmClip.volume * 100) }}%<input type="range" min="0" max="1" step="0.05" :value="project.current.bgmClip.volume" @input="updateBgmClip({ volume: Number(($event.target as HTMLInputElement).value) })" /></label>
              <button type="button" class="danger" @click="project.setBgmClip(undefined)">移除音乐</button>
            </template>
          </div>
        </div>
        <div v-else class="ml-body">
          <div class="ml-actions">
            <button type="button" @click="addTextOverlay">添加文字</button>
          </div>
          <button
            v-for="item in textOverlays.filter(t => !mediaQuery.trim() || t.text.toLowerCase().includes(mediaQuery.trim().toLowerCase()))"
            :key="item.id"
            type="button"
            class="mlrow"
            :class="{ on: selectedTextId === item.id }"
            @click="focusText(item.id)"
          >
            <span class="th text">文</span>
            <span class="meta"><span class="n">{{ item.text }}</span><span class="d">{{ item.startTime.toFixed(1) }}s · {{ item.duration.toFixed(1) }}s</span></span>
          </button>
          <div v-if="selectedText" class="audio-card">
            <label>文字内容<textarea rows="3" :value="selectedText.text" @input="updateTextOverlay({ text: ($event.target as HTMLTextAreaElement).value })" /></label>
            <label>字体
              <select :value="selectedText.fontFamily" @change="updateTextOverlay({ fontFamily: ($event.target as HTMLSelectElement).value })">
                <option value="Microsoft YaHei">微软雅黑</option><option value="SimHei">黑体</option><option value="SimSun">宋体</option><option value="KaiTi">楷体</option><option value="Arial">Arial</option>
              </select>
            </label>
            <label>字号<input type="number" min="12" max="96" step="1" :value="Math.round(selectedText.fontSizeRatio * 720)" @input="updateTextOverlay({ fontSizeRatio: Number(($event.target as HTMLInputElement).value) / 720 })" /></label>
            <label>颜色<input type="color" :value="selectedText.color" @input="updateTextOverlay({ color: ($event.target as HTMLInputElement).value })" /></label>
            <label>开始（秒）<input type="number" min="0" step="0.1" :value="selectedText.startTime" @change="updateTextOverlay({ startTime: Number(($event.target as HTMLInputElement).value) })" /></label>
            <label>长度（秒）<input type="number" min="0.5" step="0.1" :value="selectedText.duration" @change="updateTextOverlay({ duration: Number(($event.target as HTMLInputElement).value) })" /></label>
            <label>位置
              <select :value="selectedText.position" @change="setTextPositionPreset(($event.target as HTMLSelectElement).value as TextOverlay['position'])">
                <option value="top">顶部</option><option value="center">居中</option><option value="bottom">底部</option>
              </select>
            </label>
            <label class="check"><input type="checkbox" :checked="selectedText.bold" @change="updateTextOverlay({ bold: ($event.target as HTMLInputElement).checked })" />加粗</label>
            <button type="button" class="danger" @click="removeTextOverlay(selectedText.id)">删除这段文字</button>
          </div>
          <label class="check burn">
            <input type="checkbox" :checked="project.current?.settings.burnCaptions !== false" @change="project.setSettings({ burnCaptions: ($event.target as HTMLInputElement).checked })" />
            导出时把文字烧录到画面
          </label>
        </div>
      </aside>

      <div class="center">
        <div class="monitor">
          <div class="screen">
            <div class="frame" :class="previewAspect === '16:9' ? 'wide' : 'tall'" @click="onFrameClick">
              <video
                v-show="sourcePreviewUrl"
                ref="sourcePlayer"
                :key="previewLoadKey"
                :src="sourcePreviewUrl"
                playsinline
                preload="metadata"
                @loadedmetadata="onPreviewMetadata"
                @timeupdate="syncPlayheadFromPlayer"
                @ended="advanceTimeline"
              />
              <div v-if="!sourcePreviewUrl" class="frame-empty"><EditIcon name="play" :size="22" /><span>选择一个片段开始预览</span></div>
              <div
                v-for="text in activeTexts"
                :key="text.id"
                class="player-text-overlay"
                :class="{ selected: selectedTextId === text.id }"
                :style="textOverlayStyle(text)"
                @pointerdown.stop="startTextDrag($event, text)"
                @click.stop
              >{{ text.text }}</div>
              <audio
                v-if="voicePreviewUrl"
                ref="voicePlayer"
                class="voice-preview"
                :src="voicePreviewUrl"
                preload="auto"
                @loadedmetadata="syncVoicePlayback(playingTimeline)"
              />
              <div v-if="playingTimeline" class="rec"><i></i>REC</div>
              <div class="marks"></div>
            </div>
          </div>
          <div class="transport">
            <button type="button" class="icon-btn" title="从头播放" :disabled="!timeline.some(c => c.enabled)" @click="playTimelineFromStart">
              <EditIcon name="refresh" :size="15" />
            </button>
            <button type="button" class="icon-btn play" :disabled="!timeline.some(c => c.enabled)" @click="toggleTimelinePlayback">
              <EditIcon :name="playingTimeline ? 'close' : 'play'" :size="15" />
            </button>
            <span class="tc">{{ timecode(playhead) }} <span>/ {{ timecode(timelineEnd) }}</span></span>
            <span class="transport-title">{{ sourcePreviewTitle || '时间线预览' }}</span>
            <span class="badge">{{ previewAspect }}</span>
          </div>
        </div>

        <div class="tlwrap">
          <div class="tltool">
            <span class="kicker">时间线</span>
            <span class="badge">{{ timeline.length }} 段</span>
            <span class="badge">{{ timecode(timelineEnd) }}</span>
            <button type="button" class="tl-act" @click="addTextOverlay">文字</button>
            <button type="button" class="tl-act" :disabled="!canTrimSelected" @click="trimSelected('left')">裁前段</button>
            <button type="button" class="tl-act" :disabled="!canTrimSelected" @click="trimSelected('right')">裁后段</button>
            <button type="button" class="tl-act" :disabled="!selectedClip" @click="openVoicePicker">配音</button>
            <button type="button" class="tl-act" :disabled="!selectedClip || importingVoice" @click="importVoice">{{ importingVoice ? '导入中…' : '本地配音' }}</button>
            <span class="tl-tip">竖线移进片段后可裁，文字和配音加在当前片段上</span>
          </div>
          <TimelineView
            :clips="timeline"
            :shots="shots"
            :total-duration="timeline.at(-1) ? timeline.at(-1)!.startTime + timeline.at(-1)!.duration : 0"
            :selected-id="selectedClipId"
            :playhead="playhead"
            :source-durations="clipSourceDurations"
            :texts="textOverlays"
            :selected-text-id="selectedTextId"
            :voices="voiceClips"
            :bgm="project.current?.bgmClip ? { name: bgmName, startTime: project.current.bgmClip.startTime, duration: project.current.bgmClip.duration } : null"
            @select="focusClip"
            @select-text="focusText"
            @focus-audio="mediaTab = 'audio'"
            @add-voice="openVoicePicker"
            @update="updateClip"
            @remove="removeClip"
            @reorder="reorderClip"
            @seek="seekTimeline"
            @trim="trimAtPlayhead"
          />
        </div>
      </div>

      <aside class="edinsp">
        <template v-if="selectedText">
          <div class="insp-head">
            <span class="badge">TEXT</span>
            <span class="h4">画面文字</span>
            <button v-if="selectedClip" type="button" class="tl-act" @click="selectedTextId = null">返回片段</button>
          </div>
          <div class="ib">
            <div class="fgroup">
              <label>文字内容<textarea rows="3" :value="selectedText.text" @input="updateTextOverlay({ text: ($event.target as HTMLTextAreaElement).value })" /></label>
              <label>开始（秒）<input class="select" type="number" min="0" step="0.1" :value="selectedText.startTime" @change="updateTextOverlay({ startTime: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label>长度（秒）<input class="select" type="number" min="0.5" step="0.1" :value="selectedText.duration" @change="updateTextOverlay({ duration: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label>字号<input class="select" type="number" min="12" max="96" step="1" :value="Math.round(selectedText.fontSizeRatio * 720)" @input="updateTextOverlay({ fontSizeRatio: Number(($event.target as HTMLInputElement).value) / 720 })" /></label>
              <label>颜色<input class="select" type="color" :value="selectedText.color" @input="updateTextOverlay({ color: ($event.target as HTMLInputElement).value })" /></label>
              <p class="hint">拖动画布上的文字可改位置。导出时按「烧录到画面」写进成片。</p>
              <button type="button" class="danger-btn" @click="removeTextOverlay(selectedText.id)">删除这段文字</button>
            </div>
          </div>
        </template>
        <template v-else-if="selectedClip">
          <div class="insp-head">
            <span class="badge warn">CLIP</span>
            <span class="h4">{{ selectedShot?.title || selectedClip.label || '视频素材' }}</span>
          </div>
          <div class="ib">
            <div class="fgroup">
              <span class="kicker">基本信息</span>
              <div class="kv">
                <dt>时长</dt><dd>{{ selectedClip.duration.toFixed(1) }}s</dd>
                <dt>入点</dt><dd>{{ selectedClip.sourceIn.toFixed(1) }}s</dd>
                <dt>速度</dt><dd>{{ selectedClip.speed }}x</dd>
                <dt>音量</dt><dd>{{ Math.round(selectedClip.volume * 100) }}%</dd>
              </div>
            </div>
            <div class="fgroup">
              <span class="kicker">裁切</span>
              <div class="ml-actions">
                <button type="button" :disabled="!canTrimSelected" @click="trimSelected('left')">按竖线裁掉前段</button>
                <button type="button" :disabled="!canTrimSelected" @click="trimSelected('right')">按竖线裁掉后段</button>
              </div>
              <p v-if="!canTrimSelected" class="hint">把时间线竖线移到这段视频内部，才能按竖线裁。</p>
              <label class="sliderrow"><span>时长</span><input type="range" min="0.5" max="30" step="0.5" :value="selectedClip.duration" @input="updateClip(selectedClip.id, { duration: Number(($event.target as HTMLInputElement).value) })" /><span class="v">{{ selectedClip.duration.toFixed(1) }}s</span></label>
              <label class="sliderrow"><span>入点</span><input type="number" min="0" step="0.1" :value="selectedClip.sourceIn" @change="updateClip(selectedClip.id, { sourceIn: Number(($event.target as HTMLInputElement).value) })" /></label>
            </div>
            <div class="fgroup">
              <span class="kicker">配音</span>
              <p class="hint">{{ selectedVoiceName || '这段还没有配音。配音会跟着这段视频一起预览和导出。' }}</p>
              <div class="ml-actions">
                <button type="button" @click="openVoicePicker">项目配音</button>
                <button type="button" :disabled="importingVoice" @click="importVoice">{{ importingVoice ? '导入中…' : '本地配音' }}</button>
                <button v-if="selectedClip.voiceAssetId" type="button" class="danger" @click="clearVoice">移除配音</button>
              </div>
              <label v-if="selectedClip.voiceAssetId" class="sliderrow"><span>音量</span><input type="range" min="0" max="1" step="0.05" :value="selectedClip.voiceVolume ?? 1" @input="updateClip(selectedClip.id, { voiceVolume: Number(($event.target as HTMLInputElement).value) })" /><span class="v">{{ Math.round((selectedClip.voiceVolume ?? 1) * 100) }}%</span></label>
              <button type="button" class="tl-act" @click="addTextOverlay">在这段上加文字</button>
            </div>
            <div class="fgroup">
              <span class="kicker">速度与音量</span>
              <label class="sliderrow"><span>速度</span><input type="range" min="0.25" max="3" step="0.25" :value="selectedClip.speed" @input="updateClip(selectedClip.id, { speed: Number(($event.target as HTMLInputElement).value) })" /><span class="v">{{ selectedClip.speed }}x</span></label>
              <label class="sliderrow"><span>音量</span><input type="range" min="0" max="1" step="0.05" :value="selectedClip.volume" @input="updateClip(selectedClip.id, { volume: Number(($event.target as HTMLInputElement).value) })" /><span class="v">{{ Math.round(selectedClip.volume * 100) }}%</span></label>
            </div>
            <div class="fgroup">
              <span class="kicker">转场</span>
              <select class="select" :value="selectedClip.transitionIn" @change="updateClip(selectedClip.id, { transitionIn: ($event.target as HTMLSelectElement).value as TransitionType })">
                <option value="none">硬切</option>
                <option value="fade">淡入淡出</option>
                <option value="fade-black">黑场淡入淡出</option>
                <option value="zoom-in">放大</option>
                <option value="zoom-out">缩小</option>
              </select>
              <label v-if="selectedClip.transitionIn !== 'none'" class="sliderrow"><span>时长</span><input type="number" min="0" max="3" step="0.1" :value="selectedClip.transitionDuration" @change="updateClip(selectedClip.id, { transitionDuration: Number(($event.target as HTMLInputElement).value) })" /><span class="v">{{ selectedClip.transitionDuration }}s</span></label>
            </div>
            <div class="fgroup">
              <span class="kicker">操作</span>
              <button type="button" class="danger-btn" @click="removeClip(selectedClip.id)">移除</button>
            </div>
          </div>
        </template>
        <div v-else class="insp-empty">
          <span class="kicker">检视器</span>
          <p>点击时间线上的片段，可以裁切、加文字、配音。</p>
          <p>先把竖线移进片段，再点裁前段或裁后段。右键片段也一样。</p>
        </div>
      </aside>
    </div>

    <AssetPicker
      :open="videoPickerOpen"
      kind="video"
      multiple
      title="选择要加入时间线的视频"
      @close="videoPickerOpen = false"
      @confirm="addVideoAssets"
    />
    <AssetPicker
      :open="audioPickerOpen"
      kind="audio"
      :title="audioPickerMode === 'voice' ? '选择配音' : '选择背景音乐'"
      @close="audioPickerOpen = false"
      @confirm="onAudioPicked"
    />
    <Teleport to="body">
      <div v-if="previewing_ && previewingUrl" class="finish-mask" @click.self="previewing_ = false">
        <section class="finish-dialog" role="dialog" aria-modal="true" aria-labelledby="finish-title">
          <header>
            <h2 id="finish-title">{{ previewTitle }}</h2>
            <button type="button" @click="previewing_ = false">关闭</button>
          </header>
          <video :src="previewingUrl" controls autoplay class="finish-video" />
          <footer>
            <button type="button" class="ghost" @click="previewing_ = false">再改一改</button>
            <button type="button" class="download" @click="downloadFinished">下载</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.editor { display: grid; grid-template-rows: 46px 1fr; height: 100%; min-height: 0; background: var(--nb-bg-0); color: var(--nb-t1); }
.editor:has(.preview-progress) { grid-template-rows: 46px 4px 1fr; }
.edtool { display: flex; align-items: center; gap: 10px; padding: 0 16px; background: var(--nb-bg-1); border-bottom: 1px solid var(--nb-line-2); }
.ed-name { min-width: 0; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--nb-t2); }
.ed-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.icon-btn { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--nb-t2); cursor: pointer; }
.icon-btn:hover:not(:disabled) { background: var(--nb-bg-3); color: var(--nb-t1); }
.icon-btn:disabled { opacity: .4; cursor: default; }
.icon-btn.play { background: var(--nb-bg-3); border-color: var(--nb-line-2); }
.save-badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--nb-line-accent); background: var(--nb-accent-soft); color: var(--nb-accent); font-size: 11px; }
.export-btn { height: 30px; padding: 0 12px; border: 0; border-radius: 8px; background: var(--nb-accent); color: var(--nb-accent-ink); font-size: 12px; font-weight: 650; cursor: pointer; }
.export-btn:disabled { opacity: .55; cursor: default; }
.edit-tools { position: relative; }
.edit-tools summary { list-style: none; height: 30px; padding: 0 10px; border-radius: 8px; color: var(--nb-t2); font-size: 12px; line-height: 30px; cursor: pointer; }
.edit-tools summary:hover { background: var(--nb-bg-3); color: var(--nb-t1); }
.edit-tools-menu { position: absolute; left: 0; top: calc(100% + 6px); z-index: 20; min-width: 140px; padding: 6px; border: 1px solid var(--nb-line-3); border-radius: 10px; background: var(--nb-bg-2); box-shadow: var(--nb-e3); }
.edit-tools-menu button { display: block; width: 100%; padding: 8px; border: 0; border-radius: 6px; background: transparent; color: var(--nb-t1); text-align: left; font-size: 12px; cursor: pointer; }
.edit-tools-menu button:hover:enabled { background: rgba(255,255,255,.05); }
.edit-tools-menu button:disabled { opacity: .45; cursor: default; }
.preview-progress { position: relative; overflow: hidden; background: var(--nb-bg-3); }
.preview-progress-fill { position: absolute; inset: 0 auto 0 0; background: var(--nb-accent); }
.edmain { display: grid; grid-template-columns: 268px minmax(0, 1fr) 296px; min-height: 0; }
.medialib { display: flex; flex-direction: column; min-height: 0; background: var(--nb-bg-1); border-right: 1px solid var(--nb-line-2); }
.ml-head { padding: 12px; border-bottom: 1px solid var(--nb-line-1); }
.ml-tabs { display: flex; gap: 16px; margin-bottom: 10px; border-bottom: 1px solid var(--nb-line-2); }
.ml-tabs button { position: relative; margin: 0; padding: 6px 0 8px; border: 0; background: transparent; color: var(--nb-t3); font-size: 12px; cursor: pointer; }
.ml-tabs button.on { color: var(--nb-t1); }
.ml-tabs button.on::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--nb-accent); }
.ml-search { width: 100%; height: 28px; padding: 0 10px; border: 1px solid var(--nb-line-2); border-radius: 8px; background: var(--nb-bg-2); color: var(--nb-t1); font-size: 12px; outline: none; }
.ml-search:focus { border-color: var(--nb-line-accent); }
.ml-body { flex: 1; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.ml-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.ml-actions button, .danger, .danger-btn { height: 26px; padding: 0 8px; border: 1px solid var(--nb-line-2); border-radius: 7px; background: var(--nb-bg-2); color: var(--nb-t2); font-size: 11px; cursor: pointer; }
.ml-actions button:hover, .danger:hover, .danger-btn:hover { color: var(--nb-t1); }
.danger, .danger-btn { border-color: var(--nb-danger-line); color: var(--nb-danger); background: transparent; }
.mlrow { display: flex; gap: 8px; width: 100%; padding: 6px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.mlrow:hover, .mlrow.on { background: var(--nb-bg-2); border-color: var(--nb-line-1); }
.mlrow.on { border-color: var(--nb-line-accent); }
.th { width: 52px; height: 34px; flex: 0 0 52px; display: grid; place-items: center; border-radius: 4px; background: var(--nb-bg-inset); color: var(--nb-t3); font-size: 12px; }
.th.text { color: var(--nb-ai); }
.meta { min-width: 0; display: grid; gap: 2px; }
.meta .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--nb-t2); }
.meta .d { font-family: var(--nb-font-mono, ui-monospace, monospace); font-size: 10px; color: var(--nb-t4); }
.ml-empty { margin: 12px 4px; color: var(--nb-t4); font-size: 12px; }
.audio-card { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--nb-line-2); border-radius: 10px; background: var(--nb-bg-2); }
.audio-card strong { font-size: 12px; font-weight: 600; }
.audio-card label, .check { display: grid; gap: 4px; color: var(--nb-t3); font-size: 11px; }
.audio-card input, .audio-card select, .audio-card textarea, .select { width: 100%; box-sizing: border-box; border: 1px solid var(--nb-line-2); border-radius: 7px; background: var(--nb-bg-3); color: var(--nb-t1); font-size: 12px; padding: 6px 8px; }
.audio-card input[type="range"], .sliderrow input[type="range"] { padding: 0; }
.check { display: flex; align-items: center; gap: 6px; }
.check.burn { margin: 4px; }
.center { display: grid; grid-template-rows: minmax(180px, 1fr) 280px; min-height: 0; min-width: 0; }
.monitor { display: grid; grid-template-rows: 1fr auto; min-height: 0; background: var(--nb-void); border-bottom: 1px solid var(--nb-line-2); }
.screen { display: grid; place-items: center; height: 100%; min-height: 0; padding: 12px; container-type: size; }
.frame { position: relative; max-width: 100%; max-height: 100%; overflow: hidden; border: 1px solid var(--nb-line-3); border-radius: 10px; background: var(--nb-screen, #05070a); box-shadow: var(--nb-e3); }
.frame.tall { width: min(100cqw, calc(100cqh * 9 / 16)); aspect-ratio: 9 / 16; }
.frame.wide { width: min(100cqw, calc(100cqh * 16 / 9)); aspect-ratio: 16 / 9; }
.frame video { width: 100%; height: 100%; object-fit: contain; background: #000; }
.frame-empty { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: 8px; color: var(--nb-t4); font-size: 12px; }
.rec { position: absolute; top: 10px; left: 10px; display: flex; align-items: center; gap: 5px; font-family: var(--nb-font-mono, ui-monospace, monospace); font-size: 10px; color: var(--nb-t2); }
.rec i { width: 5px; height: 5px; border-radius: 50%; background: var(--nb-danger); box-shadow: 0 0 6px rgba(255,92,108,.8); }
.marks { position: absolute; inset: 10px; pointer-events: none; }
.marks::before, .marks::after { content: ""; position: absolute; width: 12px; height: 12px; border: 1px solid var(--nb-screen-mark, rgba(255,255,255,.45)); }
.marks::before { top: 0; left: 0; border-right: 0; border-bottom: 0; }
.marks::after { right: 0; bottom: 0; border-left: 0; border-top: 0; }
.player-text-overlay { position: absolute; z-index: 3; max-width: 86%; transform: translate(-50%, -50%); text-align: center; text-shadow: 0 1px 4px #000; cursor: move; }
.player-text-overlay.selected { outline: 1px dashed rgba(255,255,255,.7); }
.transport { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-top: 1px solid var(--nb-line-1); background: var(--nb-bg-1); }
.tc { font-family: var(--nb-font-mono, ui-monospace, monospace); font-size: 12px; color: var(--nb-t1); }
.tc span, .transport-title { color: var(--nb-t4); font-size: 12px; }
.transport-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tlwrap { display: grid; grid-template-rows: 42px minmax(0, 1fr); min-height: 0; background: var(--nb-void); }
.tltool { display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--nb-line-2); background: var(--nb-bg-1); }
.kicker { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--nb-t4); }
.badge { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border: 1px solid var(--nb-line-2); border-radius: 6px; background: var(--nb-bg-3); color: var(--nb-t2); font-size: 10px; }
.badge.warn { border-color: var(--nb-warning-line); background: var(--nb-warning-soft); color: var(--nb-warning); }
.tl-act { height: 26px; padding: 0 8px; border: 1px solid var(--nb-line-2); border-radius: 7px; background: var(--nb-bg-2); color: var(--nb-t2); font-size: 11px; cursor: pointer; }
.tl-act:hover:not(:disabled) { color: var(--nb-t1); }
.tl-act:disabled { opacity: .4; cursor: default; }
.tl-tip { margin-left: auto; color: var(--nb-t4); font-size: 11px; }
.hint { margin: 0; color: var(--nb-t4); font-size: 11px; line-height: 1.5; }
.voice-preview { display: none; }
.insp-head .tl-act { margin-left: auto; }
.edinsp { display: flex; flex-direction: column; min-height: 0; background: var(--nb-bg-1); border-left: 1px solid var(--nb-line-2); }
.insp-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--nb-line-1); }
.h4 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 650; }
.ib { flex: 1; overflow: auto; display: grid; align-content: start; gap: 18px; padding: 16px; }
.fgroup { display: grid; gap: 8px; }
.fgroup label { display: grid; gap: 4px; color: var(--nb-t3); font-size: 11px; }
.fgroup textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--nb-line-2); border-radius: 7px; background: var(--nb-bg-3); color: var(--nb-t1); font-size: 12px; padding: 6px 8px; }
.kv { display: grid; grid-template-columns: 52px 1fr; gap: 6px 8px; margin: 0; font-size: 12px; }
.kv dt { color: var(--nb-t4); }
.kv dd { margin: 0; color: var(--nb-t2); font-family: var(--nb-font-mono, ui-monospace, monospace); }
.sliderrow { display: grid; grid-template-columns: 42px 1fr 46px; align-items: center; gap: 8px; color: var(--nb-t3); font-size: 11px; }
.sliderrow .v { color: var(--nb-t2); text-align: right; font-family: var(--nb-font-mono, ui-monospace, monospace); }
.insp-empty { display: grid; align-content: start; gap: 8px; padding: 20px 16px; color: var(--nb-t3); font-size: 12px; line-height: 1.6; }
.insp-empty p { margin: 0; }
.finish-mask { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(6, 8, 11, .72); }
.finish-dialog { width: min(920px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--nb-line-3); border-radius: 12px; background: var(--nb-bg-2); color: var(--nb-t1); box-shadow: var(--nb-e4); }
.finish-dialog header, .finish-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.finish-dialog h2 { margin: 0; font-size: 16px; }
.finish-dialog header button, .finish-dialog .ghost, .finish-dialog .download { border: 0; border-radius: 8px; cursor: pointer; font: inherit; }
.finish-dialog header button, .finish-dialog .ghost { padding: 8px 12px; background: transparent; color: var(--nb-t2); }
.finish-dialog .download { padding: 8px 18px; background: var(--nb-accent); color: var(--nb-accent-ink); }
.finish-video { width: 100%; max-height: 68vh; background: #000; border-radius: 8px; }
@media (max-width: 1100px) {
  .edmain { grid-template-columns: 220px minmax(0, 1fr); }
  .edinsp { display: none; }
}

</style>
