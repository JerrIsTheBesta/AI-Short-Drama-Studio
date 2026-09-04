<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { concatVideos } from '@/services/ffmpeg'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import AssetPicker from '@/components/common/AssetPicker.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'
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
const merging = ref(false)
const mergeProgress = ref('')
const videoPickerOpen = ref(false)
const audioPickerOpen = ref(false)
const importingVideo = ref(false)
const importingAudio = ref(false)
const selectedTextId = ref<string | null>(null)
const clipThumbs = ref<Record<string, string>>({})
const sourcePreviewUrl = ref('')
const sourcePreviewTitle = ref('')
const sourcePlayer = ref<HTMLVideoElement | null>(null)
const pendingSourceTime = ref<number | null>(null)
const playhead = ref(0)

onMounted(async () => {
  if (!project.current) return
  // 第一次进入按分镜顺序铺满；之后保留用户顺序，只补上新生成的视频。
  if (project.current.timeline.length === 0 && project.current.shots.length > 0) {
    autoBuildTimeline()
  } else {
    appendMissingShots()
  }
  await loadClipThumbs()
  if (timeline.value[0]) await playClip(timeline.value[0], 0)
})

onUnmounted(() => {
  if (previewingUrl.value) URL.revokeObjectURL(previewingUrl.value)
})

const shots = computed(() => project.current?.shots ?? [])
const timeline = computed(() => project.current?.timeline ?? [])
const selectedClip = computed(() =>
  timeline.value.find((c) => c.id === selectedClipId.value) ?? null
)
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

function clipTitle(clip: TimelineClip, index: number) {
  const shot = shots.value.find((item) => item.id === clip.shotId)
  return shot?.title || clip.label || `视频片段 ${index + 1}`
}

async function loadClipThumbs() {
  if (!project.current) return
  const next = { ...clipThumbs.value }
  for (const clip of timeline.value) {
    if (next[clip.id]) continue
    const assetId = timelineClipAssetId(project.current, clip)
    if (!assetId) continue
    const thumb = await assets.ensureThumb(assetId)
    if (thumb) next[clip.id] = thumb
  }
  clipThumbs.value = next
}

async function playClip(clip: TimelineClip, index: number) {
  if (!project.current) return
  const assetId = timelineClipAssetId(project.current, clip)
  if (!assetId) {
    toast.warn('这个片段没有可播放的视频素材')
    return
  }
  const url = await assets.getUrl(assetId)
  if (!url) {
    toast.error('视频素材读取失败')
    return
  }
  selectedClipId.value = clip.id
  sourcePreviewTitle.value = clipTitle(clip, index)
  pendingSourceTime.value = clip.sourceIn
  playhead.value = clip.startTime
  sourcePreviewUrl.value = url
}

function applyPendingSeek() {
  const player = sourcePlayer.value
  const target = pendingSourceTime.value
  if (!player || target == null) return
  player.currentTime = Math.max(0, Math.min(Number.isFinite(player.duration) ? player.duration : target, target))
  pendingSourceTime.value = null
  player.play().catch(() => {})
}

async function seekTimeline(seconds: number) {
  const enabled = timeline.value.filter((clip) => clip.enabled)
  const clip =
    enabled.find((item) => seconds >= item.startTime && seconds < item.startTime + item.duration) ||
    enabled[enabled.length - 1]
  if (!clip) return
  const index = timeline.value.findIndex((item) => item.id === clip.id)
  const offset = Math.max(0, Math.min(clip.duration, seconds - clip.startTime))
  const sourceTime = clip.sourceIn + offset * clip.speed
  playhead.value = seconds
  await playClip(clip, index)
  playhead.value = seconds
  pendingSourceTime.value = sourceTime
  if (sourcePlayer.value?.readyState && sourcePlayer.value.readyState >= 1) applyPendingSeek()
}

function syncPlayheadFromPlayer() {
  const player = sourcePlayer.value
  const clip = timeline.value.find((item) => item.id === selectedClipId.value)
  if (!player || !clip) return
  const elapsed = Math.max(0, player.currentTime - clip.sourceIn) / Math.max(0.01, clip.speed)
  playhead.value = Math.min(clip.startTime + clip.duration, clip.startTime + elapsed)
}

watch(
  () => timeline.value.map((clip) => `${clip.id}:${clip.assetId || clip.shotId}`).join('|'),
  () => loadClipThumbs(),
  { immediate: true }
)

function autoBuildTimeline() {
  if (!project.current) return
  const clips = buildTimelineFromShots(project.current)
  project.setTimeline(clips)
  toast.success(`已自动构建 ${clips.length} 个片段的时间线`)
}

function addShotToTimeline(shot: Shot) {
  if (!project.current) return
  if (timeline.value.find((c) => c.shotId === shot.id)) {
    toast.warn('该分镜已在时间线上')
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
    transitionIn: project.current.settings.defaultTransition,
    transitionDuration: 0.5,
    speed: 1,
    volume: 1,
    enabled: true
  }
  project.addClip(newClip)
  toast.success(`已加入：${shot.title}`)
}

function addAllShots() {
  for (const s of [...shots.value].sort((a, b) => a.index - b.index)) {
    if (!timeline.value.find((c) => c.shotId === s.id)) {
      addShotToTimeline(s)
    }
  }
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
      transitionIn: project.current!.settings.defaultTransition,
      transitionDuration: 0.5,
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

function addVideoAssets(ids: string[]) {
  if (!project.current || !ids.length) return
  let cursor = timeline.value.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0)
  const stamp = Date.now().toString(36)
  const additions: TimelineClip[] = []
  for (const assetId of ids) {
    const meta = assets.getMeta(assetId)
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
      transitionIn: project.current.settings.defaultTransition,
      transitionDuration: 0.5,
      speed: 1,
      volume: 1,
      enabled: true
    })
    cursor += duration
  }
  if (!additions.length) return
  project.setTimeline([...timeline.value, ...additions])
  selectedClipId.value = additions[0].id
  toast.success(`已加入 ${additions.length} 个视频片段`)
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
    addVideoAssets(ids)
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
  const start = Math.max(0, playhead.value)
  const total = Number(totalDuration.value) || start + 3
  const item: TextOverlay = {
    id: `txt_${Date.now().toString(36)}`,
    text: '输入文字',
    startTime: start,
    duration: Math.max(0.5, Math.min(3, total - start || 3)),
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

function trackStyle(start: number, duration: number) {
  const total = Math.max(0.1, Number(totalDuration.value))
  return {
    left: `${Math.max(0, start) / total * 100}%`,
    width: `${Math.max(0.8, duration / total * 100)}%`
  }
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

/** 预览：用 FFmpeg 把当前时间线快速拼一下 */
async function preview() {
  if (!project.current) return
  if (merging.value) return
  if (timeline.value.length === 0) {
    toast.warn('时间线是空的')
    return
  }
  merging.value = true
  try {
    toast.info('开始预览合成（用 FFmpeg 拼接）...')
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
      onProgress: (msg) => toast.info(msg, 1500)
    })
    previewBlob.value = blob
    if (previewingUrl.value) URL.revokeObjectURL(previewingUrl.value)
    previewingUrl.value = URL.createObjectURL(blob)
    previewing_.value = true
    toast.success('预览就绪')
  } catch (e: any) {
    toast.error('预览失败：' + e.message)
  } finally {
    merging.value = false
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
  mergeProgress.value = '准备正式合成…'
  try {
    if (node) {
      await runCanvasNode(node.id, (_id, message) => {
        mergeProgress.value = message
      })
    } else {
      await generateFinalCut((message) => {
        mergeProgress.value = message
      })
    }
    const assetId = project.current?.finalVideoAssetId
    if (assetId) {
      if (previewingUrl.value) URL.revokeObjectURL(previewingUrl.value)
      previewingUrl.value = (await assets.getUrl(assetId)) || null
      previewing_.value = Boolean(previewingUrl.value)
    }
    toast.success('正式视频已合成，可以预览或返回画布查看')
  } catch (e: any) {
    toast.error(`合成失败：${e?.message || String(e)}`)
  } finally {
    merging.value = false
    mergeProgress.value = ''
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

function next() {
  router.push('/caption')
}
</script>

<template>
  <div class="edit-page">
    <header class="page-head">
      <div>
        <h1>✂️ 视频剪辑</h1>
        <p v-if="isDigitalHuman">各段视频已经带声音，按顺序拼接即可。下一步去确认字幕和划重点，不必再配音。</p>
        <p v-else>把分镜视频片段按顺序拼接，可调时长、加转场、变速</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push(isDigitalHuman ? '/smart-speech' : '/videos')">← 上一步</GradientButton>
        <GradientButton
          type="secondary"
          icon="🔄"
          @click="autoBuildTimeline"
        >
          重建时间线
        </GradientButton>
        <GradientButton
          icon="▶"
          :loading="merging"
          @click="preview"
        >
          预览
        </GradientButton>
        <GradientButton type="secondary" icon="→" @click="next">字幕设置</GradientButton>
        <GradientButton icon="✓" :loading="merging" :disabled="merging" @click="confirmMerge">
          {{ merging ? (mergeProgress || '合成中…') : '确认并正式合成' }}
        </GradientButton>
      </div>
    </header>

    <div class="edit-layout">
      <aside class="left-panel">
        <GlassCard padding="md">
          <div class="panel-head">
            <h3>分镜库</h3>
            <button class="add-all" @click="addAllShots">全部加入</button>
          </div>
          <div class="media-add-row">
            <button type="button" @click="videoPickerOpen = true">＋ 项目视频</button>
            <button type="button" :disabled="importingVideo" @click="importVideos">
              {{ importingVideo ? '导入中…' : '＋ 本地视频' }}
            </button>
          </div>
          <div class="shot-list">
            <div
              v-for="shot in shots"
              :key="shot.id"
              class="shot-item"
              :class="{
                on: timeline.find(c => c.shotId === shot.id),
                off: !timeline.find(c => c.shotId === shot.id)
              }"
              @click="addShotToTimeline(shot)"
            >
              <div class="shot-item-num">{{ shot.index + 1 }}</div>
              <div class="shot-item-info">
                <div class="shot-item-title">{{ shot.title }}</div>
                <div class="shot-item-meta">
                  {{ shot.duration }}s
                  <span v-if="!shot.videoAssetId && !shot.imageAssetId">· 无素材</span>
                </div>
              </div>
              <div class="shot-item-add">
                {{ timeline.find(c => c.shotId === shot.id) ? '✓' : '+' }}
              </div>
            </div>
          </div>
        </GlassCard>
      </aside>

      <main class="main-panel">
        <GlassCard padding="md" class="source-preview-card">
          <div class="source-preview-head">
            <div>
              <h3>片段预览</h3>
              <p>{{ sourcePreviewTitle || '点击下方任一视频片段即可播放' }}</p>
            </div>
          </div>
          <div class="source-player-wrap">
            <video
              v-show="sourcePreviewUrl"
              ref="sourcePlayer"
              :src="sourcePreviewUrl"
              controls
              autoplay
              class="source-player"
              @loadedmetadata="applyPendingSeek"
              @timeupdate="syncPlayheadFromPlayer"
            />
            <div v-if="!sourcePreviewUrl" class="source-player-empty">▶ 选择一个片段开始预览</div>
            <div
              v-for="text in activeTexts"
              :key="text.id"
              class="player-text-overlay"
              :class="{ selected: selectedTextId === text.id }"
              :style="textOverlayStyle(text)"
              @pointerdown.stop="startTextDrag($event, text)"
            >
              {{ text.text }}
            </div>
          </div>

          <div class="filmstrip" aria-label="按合成顺序排列的视频预览">
            <button
              v-for="(clip, index) in timeline"
              :key="clip.id"
              type="button"
              class="filmstrip-item"
              :class="{ on: selectedClipId === clip.id, disabled: !clip.enabled }"
              @click="playClip(clip, index)"
            >
              <div class="filmstrip-thumb">
                <img v-if="clipThumbs[clip.id]" :src="clipThumbs[clip.id]" alt="" />
                <span v-else class="filmstrip-placeholder">🎥</span>
                <span class="filmstrip-play">▶</span>
                <span class="filmstrip-index">{{ index + 1 }}</span>
                <span class="filmstrip-duration">{{ clip.duration.toFixed(1) }}s</span>
              </div>
              <span class="filmstrip-title">{{ clipTitle(clip, index) }}</span>
            </button>
            <button type="button" class="filmstrip-add" @click="videoPickerOpen = true">
              <strong>＋</strong>
              <span>添加视频</span>
            </button>
          </div>
        </GlassCard>

        <GlassCard padding="md" class="timeline-card">
          <TimelineView
            :clips="timeline"
            :shots="shots"
            :total-duration="Number(totalDuration)"
            :selected-id="selectedClipId"
            :playhead="playhead"
            @select="selectedClipId = $event"
            @update="updateClip"
            @remove="removeClip"
            @reorder="reorderClip"
            @seek="seekTimeline"
          />
          <div class="editor-tracks">
            <div class="track-row">
              <div class="track-name">音乐</div>
              <div class="track-lane">
                <button
                  v-if="project.current?.bgmClip"
                  type="button"
                  class="track-block music-block"
                  :style="trackStyle(project.current.bgmClip.startTime, project.current.bgmClip.duration)"
                >
                  ♫ {{ bgmName }}
                </button>
                <button v-else type="button" class="track-empty-add" @click="audioPickerOpen = true">＋ 投入音乐</button>
              </div>
            </div>
            <div class="track-row">
              <div class="track-name">文字</div>
              <div class="track-lane">
                <button
                  v-for="item in textOverlays"
                  :key="item.id"
                  type="button"
                  class="track-block text-block"
                  :class="{ on: selectedTextId === item.id }"
                  :style="trackStyle(item.startTime, item.duration)"
                  @click="selectedTextId = item.id"
                >
                  T {{ item.text }}
                </button>
                <button v-if="!textOverlays.length" type="button" class="track-empty-add" @click="addTextOverlay">＋ 添加文字</button>
              </div>
            </div>
          </div>
        </GlassCard>

        <transition name="fade">
          <div v-if="previewing_ && previewingUrl" class="preview-wrap">
            <GlassCard padding="md">
              <div class="preview-head">
                <h3>▶ 预览</h3>
                <button @click="previewing_ = false">✕ 关闭</button>
              </div>
              <video
                :src="previewingUrl"
                controls
                autoplay
                class="preview-video"
              />
            </GlassCard>
          </div>
        </transition>
      </main>

      <aside class="right-panel">
        <GlassCard v-if="selectedClip" padding="md">
          <h3>片段属性</h3>
          <div class="clip-prop-head">
            <div class="prop-num">#{{ selectedShot ? selectedShot.index + 1 : timeline.findIndex(c => c.id === selectedClip?.id) + 1 }}</div>
            <div class="prop-title">{{ selectedShot?.title || selectedClip.label || '视频素材' }}</div>
          </div>

          <label class="prop-field">
            <span>时长 (秒)</span>
            <div class="row">
              <input
                type="range"
                min="0.5"
                max="30"
                step="0.5"
                :value="selectedClip.duration"
                @input="updateClip(selectedClip.id, { duration: Number(($event.target as HTMLInputElement).value) })"
                class="range"
              />
              <input
                type="number"
                min="0.5"
                max="30"
                step="0.5"
                :value="selectedClip.duration"
                @change="updateClip(selectedClip.id, { duration: Number(($event.target as HTMLInputElement).value) })"
                class="num"
              />
            </div>
          </label>

          <label class="prop-field">
            <span>素材入点 (秒)</span>
            <input
              type="number"
              min="0"
              :value="selectedClip.sourceIn"
              @change="updateClip(selectedClip.id, { sourceIn: Number(($event.target as HTMLInputElement).value) })"
              class="prop-input"
            />
          </label>

          <label class="prop-field">
            <span>播放速度</span>
            <div class="row">
              <input
                type="range"
                min="0.25"
                max="3"
                step="0.25"
                :value="selectedClip.speed"
                @input="updateClip(selectedClip.id, { speed: Number(($event.target as HTMLInputElement).value) })"
                class="range"
              />
              <span class="num-text">{{ selectedClip.speed }}x</span>
            </div>
          </label>

          <label class="prop-field">
            <span>音量</span>
            <div class="row">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                :value="selectedClip.volume"
                @input="updateClip(selectedClip.id, { volume: Number(($event.target as HTMLInputElement).value) })"
                class="range"
              />
              <span class="num-text">{{ Math.round(selectedClip.volume * 100) }}%</span>
            </div>
          </label>

          <label class="prop-field">
            <span>入镜转场</span>
            <select
              :value="selectedClip.transitionIn"
              @change="updateClip(selectedClip.id, { transitionIn: ($event.target as HTMLSelectElement).value as TransitionType })"
              class="prop-input"
            >
              <option value="none">无</option>
              <option value="fade">淡入淡出</option>
              <option value="fade-black">黑场淡入淡出</option>
              <option value="zoom-in">放大</option>
              <option value="zoom-out">缩小</option>
            </select>
          </label>

          <label class="prop-field" v-if="selectedClip.transitionIn !== 'none'">
            <span>转场时长 (秒)</span>
            <input
              type="number"
              min="0"
              max="3"
              step="0.1"
              :value="selectedClip.transitionDuration"
              @change="updateClip(selectedClip.id, { transitionDuration: Number(($event.target as HTMLInputElement).value) })"
              class="prop-input"
            />
          </label>

          <div class="prop-actions">
            <GradientButton
              type="danger"
              size="sm"
              icon="🗑"
              block
              @click="removeClip(selectedClip.id)"
            >
              移除该片段
            </GradientButton>
          </div>
        </GlassCard>

        <GlassCard v-else padding="md">
          <h3>💡 提示</h3>
          <p class="hint">点击时间线上的片段可以在这里编辑它的属性。</p>
          <p class="hint">
            <Tag size="sm" type="accent">时长</Tag> 决定该片段在最终视频里持续多久。
          </p>
          <p class="hint">
            <Tag size="sm" type="accent">转场</Tag> 让片段之间更平滑。
          </p>
          <p class="hint">
            <Tag size="sm" type="accent">速度</Tag> 0.5x = 慢动作，2x = 2 倍快进。
          </p>
        </GlassCard>

        <GlassCard padding="md" class="media-settings">
          <div class="property-title-row">
            <h3>音乐轨</h3>
            <button type="button" @click="audioPickerOpen = true">＋ 投入音乐</button>
          </div>
          <p class="current-media" :title="bgmName">{{ bgmName }}</p>
          <div class="media-add-row">
            <button type="button" @click="audioPickerOpen = true">更换音乐</button>
            <button type="button" :disabled="importingAudio" @click="importBgm">
              {{ importingAudio ? '导入中…' : '本地音乐' }}
            </button>
            <button v-if="project.current?.bgmClip" type="button" class="danger-text" @click="project.setBgmClip(undefined)">移除</button>
          </div>
          <template v-if="project.current?.bgmClip">
            <div class="inline-fields">
              <label class="prop-field"><span>开始（秒）</span><input class="prop-input" type="number" min="0" step="0.1" :value="project.current.bgmClip.startTime" @change="updateBgmClip({ startTime: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label class="prop-field"><span>长度（秒）</span><input class="prop-input" type="number" min="0.5" step="0.1" :value="project.current.bgmClip.duration" @change="updateBgmClip({ duration: Number(($event.target as HTMLInputElement).value) })" /></label>
            </div>
            <label class="prop-field"><span>音乐入点（秒）</span><input class="prop-input" type="number" min="0" step="0.1" :value="project.current.bgmClip.sourceIn" @change="updateBgmClip({ sourceIn: Number(($event.target as HTMLInputElement).value) })" /></label>
            <label class="prop-field bgm-volume">
              <span>音量 {{ Math.round(project.current.bgmClip.volume * 100) }}%</span>
              <input class="range" type="range" min="0" max="1" step="0.05" :value="project.current.bgmClip.volume" @input="updateBgmClip({ volume: Number(($event.target as HTMLInputElement).value) })" />
            </label>
          </template>

          <div class="property-title-row text-property-title">
            <h3>文字轨</h3>
            <button type="button" @click="addTextOverlay">＋ 添加文字</button>
          </div>
          <template v-if="selectedText">
            <label class="prop-field">
              <span>文字内容</span>
              <textarea class="text-content-editor" rows="3" :value="selectedText.text" @input="updateTextOverlay({ text: ($event.target as HTMLTextAreaElement).value })" />
            </label>
            <label class="prop-field">
              <span>字体</span>
              <select class="prop-input" :value="selectedText.fontFamily" @change="updateTextOverlay({ fontFamily: ($event.target as HTMLSelectElement).value })">
                <option value="Microsoft YaHei">微软雅黑</option><option value="SimHei">黑体</option><option value="SimSun">宋体</option><option value="KaiTi">楷体</option><option value="Arial">Arial</option>
              </select>
            </label>
            <div class="inline-fields">
              <label class="prop-field"><span>字号</span><input class="prop-input" type="number" min="12" max="96" step="1" :value="Math.round(selectedText.fontSizeRatio * 720)" @input="updateTextOverlay({ fontSizeRatio: Number(($event.target as HTMLInputElement).value) / 720 })" /></label>
              <label class="prop-field"><span>颜色</span><input class="color-input" type="color" :value="selectedText.color" @input="updateTextOverlay({ color: ($event.target as HTMLInputElement).value })" /></label>
            </div>
            <div class="inline-fields">
              <label class="prop-field"><span>开始（秒）</span><input class="prop-input" type="number" min="0" step="0.1" :value="selectedText.startTime" @change="updateTextOverlay({ startTime: Number(($event.target as HTMLInputElement).value) })" /></label>
              <label class="prop-field"><span>长度（秒）</span><input class="prop-input" type="number" min="0.5" step="0.1" :value="selectedText.duration" @change="updateTextOverlay({ duration: Number(($event.target as HTMLInputElement).value) })" /></label>
            </div>
            <label class="prop-field"><span>位置预设（也可直接在画面拖动）</span><select class="prop-input" :value="selectedText.position" @change="setTextPositionPreset(($event.target as HTMLSelectElement).value as TextOverlay['position'])"><option value="top">顶部</option><option value="center">居中</option><option value="bottom">底部</option></select></label>
            <label class="subtitle-toggle"><input type="checkbox" :checked="selectedText.bold" @change="updateTextOverlay({ bold: ($event.target as HTMLInputElement).checked })" />加粗</label>
            <button type="button" class="remove-text-button" @click="removeTextOverlay(selectedText.id)">删除这段文字</button>
          </template>
          <p v-else class="property-empty">点击“添加文字”，或在时间轴选择一段文字后编辑。</p>

          <label class="subtitle-toggle burn-toggle">
            <input
              type="checkbox"
              :checked="project.current?.settings.burnCaptions !== false"
              @change="project.setSettings({ burnCaptions: ($event.target as HTMLInputElement).checked })"
            />
            导出时把文字烧录到画面
          </label>
        </GlassCard>
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
      title="选择背景音乐"
      @close="audioPickerOpen = false"
      @confirm="chooseBgm"
    />
  </div>
</template>

<style scoped>
.edit-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: var(--space-5) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  gap: var(--space-4);
  flex-wrap: wrap;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 700;
  margin: 0 0 var(--space-1);
}
.page-head p {
  font-size: 13px;
  color: var(--color-text-3);
  margin: 0;
}
.head-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.edit-layout {
  display: grid;
  grid-template-columns: 230px minmax(520px, 1fr) 310px;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6);
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.left-panel,
.right-panel,
.main-panel {
  min-height: 0;
  overflow-y: auto;
}
.main-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.source-preview-card {
  flex-shrink: 0;
}
.source-preview-head h3 {
  margin: 0;
  font-size: 14px;
}
.source-preview-head p {
  margin: 3px 0 var(--space-3);
  color: var(--color-text-3);
  font-size: 11px;
}
.source-player-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: clamp(220px, 42vh, 520px);
  flex: 0 0 clamp(220px, 42vh, 520px);
  overflow: hidden;
  border-radius: var(--radius-md);
  background: #050505;
}
.player-text-overlay {
  position: absolute;
  width: 86%;
  transform: translate(-50%, -50%);
  z-index: 2;
  text-align: center;
  line-height: 1.25;
  white-space: pre-wrap;
  cursor: move;
  user-select: none;
  touch-action: none;
  text-shadow: 0 2px 4px #000, 0 0 2px #000;
}
.player-text-overlay.selected {
  outline: 1px dashed rgba(255, 255, 255, 0.85);
  outline-offset: 5px;
}

.editor-tracks {
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: rgba(5, 7, 11, 0.72);
}
.track-row {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr);
  gap: 8px;
  align-items: stretch;
  min-height: 38px;
}
.track-row + .track-row { margin-top: 7px; }
.track-name {
  display: grid;
  place-items: center;
  color: var(--color-text-3);
  font-size: 11px;
  border-radius: 6px;
  background: var(--color-bg-2);
}
.track-lane {
  position: relative;
  overflow: hidden;
  min-height: 38px;
  border-radius: 6px;
  background: repeating-linear-gradient(90deg, rgba(255,255,255,.035) 0, rgba(255,255,255,.035) 1px, transparent 1px, transparent 10%);
}
.track-block {
  position: absolute;
  top: 3px;
  bottom: 3px;
  min-width: 30px;
  overflow: hidden;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 5px;
  color: #fff;
  font-size: 11px;
  text-align: left;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.music-block { background: linear-gradient(90deg, #6c45c7, #8765d8); }
.text-block { background: linear-gradient(90deg, #23798a, #2a9aaa); }
.text-block.on { border-color: #fff; box-shadow: 0 0 0 1px #31d4ea; }
.track-empty-add {
  height: 100%;
  padding: 0 12px;
  color: var(--color-text-3);
  font-size: 11px;
  border: 1px dashed var(--color-border);
  background: transparent;
}
.source-player {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.source-player-empty {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: #08090c;
  color: var(--color-text-4);
  font-size: 13px;
}
.filmstrip {
  display: flex;
  gap: 9px;
  margin-top: var(--space-3);
  padding: 4px 2px 9px;
  overflow-x: auto;
  overflow-y: hidden;
}
.filmstrip-item,
.filmstrip-add {
  width: 142px;
  flex: 0 0 142px;
  padding: 0;
  text-align: left;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  overflow: hidden;
}
.filmstrip-item:hover,
.filmstrip-item.on {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.2);
}
.filmstrip-item.disabled {
  opacity: 0.42;
}
.filmstrip-thumb {
  position: relative;
  height: 78px;
  overflow: hidden;
  background: #050505;
}
.filmstrip-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.filmstrip-placeholder {
  display: grid;
  place-items: center;
  height: 100%;
  opacity: 0.45;
}
.filmstrip-play {
  position: absolute;
  inset: 50% auto auto 50%;
  transform: translate(-50%, -50%);
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.68);
  color: white;
  font-size: 11px;
  padding-left: 2px;
}
.filmstrip-index,
.filmstrip-duration {
  position: absolute;
  bottom: 5px;
  padding: 2px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.72);
  color: white;
  font-size: 9px;
}
.filmstrip-index { left: 5px; }
.filmstrip-duration { right: 5px; }
.filmstrip-title {
  display: block;
  padding: 7px 8px;
  overflow: hidden;
  color: var(--color-text-2);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filmstrip-add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 107px;
  border-style: dashed;
  border-color: var(--color-border);
  color: var(--color-text-3);
  text-align: center;
}
.filmstrip-add:hover {
  border-color: var(--color-accent);
  color: var(--color-text-1);
}
.filmstrip-add strong { font-size: 24px; font-weight: 400; }
.filmstrip-add span { font-size: 10px; }
.timeline-card {
  flex-shrink: 0;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-3);
}
.panel-head h3 {
  font-size: 13px;
  margin: 0;
  font-weight: 600;
}
.add-all {
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.add-all:hover {
  background: var(--grad-primary-soft);
}
.media-add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--space-3);
}
.media-add-row button {
  padding: 6px 9px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font-size: 11px;
}
.media-add-row button:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-text-1);
}
.shot-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.shot-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--duration-fast);
}
.shot-item:hover {
  background: var(--color-fill);
}
.shot-item.on {
  opacity: 0.5;
}
.shot-item-num {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: var(--grad-primary);
  color: white;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.shot-item-info {
  flex: 1;
  min-width: 0;
}
.shot-item-title {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-item-meta {
  font-size: 10px;
  color: var(--color-text-4);
}
.shot-item-add {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: var(--color-bg-2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--color-text-3);
}
.shot-item.on .shot-item-add {
  background: var(--color-success);
  color: white;
}

.preview-wrap {
  flex: 1;
  min-height: 0;
}
.preview-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-3);
}
.preview-head h3 {
  margin: 0;
  font-size: 14px;
}
.preview-head button {
  font-size: 12px;
  color: var(--color-text-3);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.preview-head button:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.preview-video {
  width: 100%;
  max-height: 50vh;
  background: #000;
  border-radius: var(--radius-md);
}

.right-panel h3 {
  font-size: 13px;
  margin: 0 0 var(--space-3);
  font-weight: 600;
}
.clip-prop-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}
.prop-num {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--grad-primary);
  color: white;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.prop-title {
  font-size: 14px;
  font-weight: 600;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prop-field {
  display: block;
  margin-bottom: var(--space-3);
}
.prop-field > span {
  display: block;
  font-size: 11px;
  color: var(--color-text-3);
  margin-bottom: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.range {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: var(--color-bg-2);
  border-radius: var(--radius-full);
  outline: none;
}
.range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--grad-primary);
  cursor: pointer;
}
.range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--grad-primary);
  cursor: pointer;
  border: none;
}
.num {
  width: 60px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 12px;
  color: var(--color-text-1);
  outline: none;
  text-align: right;
}
.num-text {
  width: 50px;
  font-size: 12px;
  text-align: right;
  color: var(--color-text-1);
  font-variant-numeric: tabular-nums;
}
.prop-input {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-1);
  outline: none;
}
.prop-actions {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}
.hint {
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.6;
  margin: 0 0 var(--space-2);
}
.media-settings {
  margin-top: var(--space-3);
}
.property-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.property-title-row h3 { margin: 0; }
.property-title-row button,
.media-add-row button,
.remove-text-button {
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font-size: 11px;
}
.text-property-title {
  margin-top: var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}
.inline-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.text-content-editor {
  width: 100%;
  resize: vertical;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font: inherit;
}
.color-input {
  width: 100%;
  height: 31px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
}
.property-empty {
  color: var(--color-text-4);
  font-size: 11px;
  line-height: 1.5;
}
.remove-text-button { margin-top: 10px; color: #ff8585; }
.danger-text { color: #ff8585 !important; }
.burn-toggle {
  margin-top: var(--space-4) !important;
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}
.current-media {
  margin: 0 0 var(--space-2);
  color: var(--color-text-3);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bgm-volume {
  margin-top: var(--space-3);
}
.subtitle-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  color: var(--color-text-2);
  font-size: 11px;
}
</style>
