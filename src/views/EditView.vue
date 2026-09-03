<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { concatVideos } from '@/services/ffmpeg'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'
import type { Shot, TimelineClip, TransitionType } from '@/types'
import { buildTimelineFromShots } from '@/utils/timeline'
import { isDigitalHumanSpeechProject } from '@/utils/shot'
import { runCanvasNode } from '@/services/canvas/runner'

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

onMounted(async () => {
  if (!project.current) return
  // 第一次进入按分镜顺序铺满；之后保留用户顺序，只补上新生成的视频。
  if (project.current.timeline.length === 0 && project.current.shots.length > 0) {
    autoBuildTimeline()
  } else {
    appendMissingShots()
  }
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
  if (!node) {
    toast.error('找不到合成节点，请返回画布重建流程')
    return
  }
  merging.value = true
  mergeProgress.value = '准备正式合成…'
  try {
    await runCanvasNode(node.id, (_id, message) => {
      mergeProgress.value = message
    })
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
    const shot = shots.value.find((s) => s.id === clip.shotId)
    if (!shot) continue
    const assetId = shot.videoAssetId || shot.imageAssetId
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
        <h1>✂️ 剪辑时间线</h1>
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
        <GlassCard padding="md" class="timeline-card">
          <TimelineView
            :clips="timeline"
            :shots="shots"
            :total-duration="Number(totalDuration)"
            :selected-id="selectedClipId"
            @select="selectedClipId = $event"
            @update="updateClip"
            @remove="removeClip"
            @reorder="reorderClip"
          />
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
        <GlassCard v-if="selectedClip && selectedShot" padding="md">
          <h3>片段属性</h3>
          <div class="clip-prop-head">
            <div class="prop-num">#{{ selectedShot.index + 1 }}</div>
            <div class="prop-title">{{ selectedShot.title }}</div>
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
      </aside>
    </div>
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
  grid-template-columns: 240px 1fr 280px;
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
</style>
