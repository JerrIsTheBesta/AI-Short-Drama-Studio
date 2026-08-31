<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import {
  composeVideoPrompt,
  buildH3ImageSlots,
  spokenTextOnly,
  DIGITAL_HUMAN_VISUAL_LOCK,
  DIGITAL_HUMAN_AESTHETIC,
  DIGITAL_HUMAN_AUDIO_DESCRIPTION,
  DIGITAL_HUMAN_SPEAKER_HINT,
  DIGITAL_HUMAN_SPEAKER_NAME,
  DIGITAL_HUMAN_SCENE_NAME,
  DIGITAL_HUMAN_SCENE_DESCRIPTION,
  DIGITAL_HUMAN_SCENE_ANCHOR,
  DIGITAL_HUMAN_IMAGE_ASSIGNMENT
} from '@/services/ai'
import { collectShotVideoEntries, packVideoRefEntries, sceneForShot, subjectsForShot } from '@/utils/consistency'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { resolveShotPlace } from '@/utils/shotPlace'
import { generateShotVideo, rewriteShotPerformance } from '@/services/canvas/runner'
import { mapPool, VIDEO_GEN_CONCURRENCY } from '@/services/canvas/jobs'
import { getVideoPromptStyle } from '@/services/ai/runtime'
import { effectiveShotAudioMode, editableVideoPrompt, resolveH3VoiceMode, synthesizeVideoPerformance } from '@/utils/shot'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import ProgressRing from '@/components/common/ProgressRing.vue'
import AssetPicker from '@/components/common/AssetPicker.vue'
import H3GenModeSelect from '@/components/settings/H3GenModeSelect.vue'
import FramePairSlots from '@/components/canvas/FramePairSlots.vue'
import { normalizeH3GenMode, type H3VideoGenMode, type Shot, type ID } from '@/types'
import { openLightbox } from '@/composables/useLightbox'

const router = useRouter()
const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()

const generating = ref<Set<string>>(new Set())
const progress = ref<Record<string, string>>({})
const videoUrls = ref<Record<string, string>>({})
const imageUrls = ref<Record<string, string>>({})
const historyUrls = ref<Record<string, string>>({})
const expanded = ref<Set<string>>(new Set())
const pickerShotId = ref<string | null>(null)

onMounted(async () => {
  if (!project.current?.shots.length) {
    toast.warn('请先生成分镜')
    router.push('/storyboard')
    return
  }
  await loadVideos()
  await loadImages()
  await loadHistory()
})

const shots = computed(() => project.current?.shots ?? [])
const isDigitalHuman = computed(() =>
  project.current?.pipelineMode === 'smart-speech' &&
  project.current?.speechWorkflow?.mode === 'digital-human'
)
const aspectRatio = computed(() => project.current?.settings.aspectRatio ?? '16:9')
const width = computed(() => project.current?.settings.width ?? 1280)
const height = computed(() => project.current?.settings.height ?? 720)
const aesthetic = computed(() => project.current?.script?.h3Aesthetic || project.current?.script?.aesthetic || '')
const videoPromptPlaceholder = computed(() =>
  getVideoPromptStyle() === 'formatted'
    ? '每个角色的表情神态、手脚动作、环境怎么动、说什么原词、镜头怎么走。写细才有表现力。'
    : '画面中：站位、发型、衣服、动作、年龄的人是谁。空一行后连续写这一镜怎么演、台词原词、环境动势、镜头怎么收。'
)

const shotsWithoutBoard = computed(() =>
  isDigitalHuman.value || !videoRequiresStoryboard(project.current)
    ? []
    : shots.value.filter((s) => normalizeH3GenMode(s.h3GenMode) !== 'fl2va' && !s.boardAssetId)
)

function shotH3Mode(shot: Shot): H3VideoGenMode {
  return normalizeH3GenMode(shot.h3GenMode)
}

function setShotH3Mode(shot: Shot, mode: H3VideoGenMode) {
  project.updateShot(shot.id, { h3GenMode: mode })
}
const shotsWithoutVideo = computed(() =>
  shots.value.filter((s) => !s.videoAssetId)
)

async function loadVideos() {
  for (const s of shots.value) {
    if (s.videoAssetId) {
      const url = await assets.getUrl(s.videoAssetId)
      if (url) videoUrls.value[s.id] = url
    }
  }
}

async function loadImages() {
  for (const s of shots.value) {
    const previewId = isDigitalHuman.value
      ? project.current?.speechWorkflow?.imageAssetId || s.imageAssetId
      : s.boardAssetId || s.imageAssetId
    if (previewId) {
      const url = await assets.getUrl(previewId)
      if (url) imageUrls.value[s.id] = url
    }
  }
}

async function loadHistory() {
  const next: Record<string, string> = {}
  for (const s of shots.value) {
    for (const id of s.videoHistoryIds ?? []) {
      const url = await assets.ensureThumb(id)
      if (url) next[id] = url
    }
  }
  historyUrls.value = { ...historyUrls.value, ...next }
}

function updateVideoPrompt(shot: Shot, value: string) {
  project.updateShot(shot.id, { videoPrompt: value })
}

async function resetVideoPrompt(shot: Shot) {
  try {
    await rewriteShotPerformance(shot)
    toast.success('已按本镜剧情重写视频内容表现')
  } catch (e: any) {
    toast.error(e?.message || '重写失败')
  }
}

function changeAudioMode(shot: Shot, mode: NonNullable<Shot['audioMode']>) {
  if (effectiveShotAudioMode(shot) === mode) return
  const hadVideo = Boolean(shot.videoAssetId)
  project.setShotAudioMode(shot.id, mode)
  if (hadVideo) toast.info('人声方案已改变，旧视频已放入历史；请重新生成本镜以避免声音或口型不匹配。', 6000)
}

function composedPrompt(shot: Shot) {
  if (isDigitalHuman.value) {
    const spoken = spokenTextOnly(shot.voiceover || '')
    return composeVideoPrompt({
      prompt: DIGITAL_HUMAN_VISUAL_LOCK,
      aesthetic: DIGITAL_HUMAN_AESTHETIC,
      audioDescription: DIGITAL_HUMAN_AUDIO_DESCRIPTION,
      voiceover: spoken,
      voiceMode: spoken ? 'dialogue' : 'none',
      speakerHint: DIGITAL_HUMAN_SPEAKER_HINT,
      speakerName: DIGITAL_HUMAN_SPEAKER_NAME,
      onScreenNames: [DIGITAL_HUMAN_SPEAKER_NAME],
      sceneName: DIGITAL_HUMAN_SCENE_NAME,
      sceneDescription: DIGITAL_HUMAN_SCENE_DESCRIPTION,
      sceneAnchor: DIGITAL_HUMAN_SCENE_ANCHOR,
      shotTitle: 'Locked single-person talking head',
      imageAssignments: [DIGITAL_HUMAN_IMAGE_ASSIGNMENT],
      duration: shot.duration,
      width: width.value,
      height: height.value,
      aspectRatio: aspectRatio.value,
      cameraMovement: 'static',
      mode: 'I2VA'
    })
  }
  const promptStyle = getVideoPromptStyle()
  const spoken = spokenTextOnly(shot.voiceover || '')
  const packed = project.current
    ? packVideoRefEntries(collectShotVideoEntries(shot, project.current))
    : []
  const imageSlots = buildH3ImageSlots(packed)
  const onScreenNames = project.current ? subjectsForShot(shot, project.current).map((item) => item.name) : []
  const speaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const scene = project.current ? sceneForShot(shot, project.current) : undefined
  const place = resolveShotPlace(shot, scene)
  return composeVideoPrompt({
    prompt: editableVideoPrompt(shot) || synthesizeVideoPerformance(shot),
    aesthetic: aesthetic.value,
    audioDescription: shot.audioDescription,
    voiceover: spoken,
    voiceMode: spoken ? resolveH3VoiceMode(shot, onScreenNames) : 'none',
    speakerHint: shot.speakerHint,
    speakerName: speaker,
    onScreenNames,
    sceneName: place.name,
    sceneLighting: place.lighting,
    shotTitle: shot.title,
    imageAssignments: imageSlots.map((slot) => slot.job),
    imageSlots,
    duration: shot.duration,
    width: width.value,
    height: height.value,
    aspectRatio: aspectRatio.value,
    cameraMovement: shot.cameraMovement,
    promptStyle,
    mode: 'R2VA'
  })
}

function toggleExpanded(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

async function generateOne(shot: Shot) {
  const next = new Set(generating.value)
  next.add(shot.id)
  generating.value = next
  try {
    const asset = await generateShotVideo(shot, (msg) => {
      progress.value[shot.id] = msg
    })
    const url = await assets.getUrl(asset.id)
    if (url) videoUrls.value[shot.id] = url
    await loadHistory()
    toast.success(`分镜 ${shot.index + 1} 视频已生成并加入资源库`)
  } catch (e: any) {
    toast.error(`分镜 ${shot.index + 1} 视频生成失败：${e.message}`)
  } finally {
    const done = new Set(generating.value)
    done.delete(shot.id)
    generating.value = done
    delete progress.value[shot.id]
  }
}

async function generateAll() {
  const targets = shots.value.filter((shot) => !shot.videoAssetId && !generating.value.has(shot.id))
  await mapPool(targets, VIDEO_GEN_CONCURRENCY, (shot) => generateOne(shot))
}

async function restoreHistory(shot: Shot, assetId: ID) {
  project.assignShotVideo(shot.id, assetId)
  await project.save()
  const url = await assets.getUrl(assetId)
  if (url) videoUrls.value[shot.id] = url
  await loadHistory()
  toast.success('已切回历史版本')
}

async function onPickerConfirm(ids: ID[]) {
  const shotId = pickerShotId.value
  pickerShotId.value = null
  if (!shotId || ids.length === 0) return
  const shot = shots.value.find((s) => s.id === shotId)
  if (!shot) return
  project.assignShotVideo(shot.id, ids[0])
  await project.save()
  const url = await assets.getUrl(ids[0])
  if (url) videoUrls.value[shot.id] = url
  await loadHistory()
  toast.success(`分镜 ${shot.index + 1} 已从资源库选用视频`)
}

function next() {
  if (shots.value.some((s) => !s.videoAssetId)) {
    if (!confirm('还有分镜没生成视频，确定进入剪辑？')) return
  }
  router.push('/edit')
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>🎥 AI 视频生成</h1>
        <p v-if="isDigitalHuman">每次生成和重新生成都强制使用项目上传的人物图作为唯一参考，并锁定人物、服装、背景、构图和机位。</p>
        <p v-else>H3 可用人设、场景、配图或参考图出视频；故事看板可选。口播人声请到「字幕」步骤按台词生成。</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/images')">← 上一步</GradientButton>
        <GradientButton
          icon="✨"
          :loading="generating.size > 0"
          :disabled="shotsWithoutVideo.length === 0"
          @click="generateAll"
        >
          {{ generating.size > 0 ? `生成中 ${generating.size}/${shotsWithoutVideo.length}` : '一键生成全部' }}
        </GradientButton>
        <GradientButton icon="→" @click="next">下一步：剪辑</GradientButton>
      </div>
    </header>

    <GlassCard v-if="shotsWithoutBoard.length > 0" padding="md" class="warn-card">
      ⚠️ 还有 {{ shotsWithoutBoard.length }} 个分镜没有故事看板。参考图生成需要角色设计图、场景图和本镜看板；首尾帧模式只需要首帧和尾帧。
    </GlassCard>

    <EmptyState
      v-if="shots.length === 0"
      icon="🎥"
      title="还没有分镜"
      description="请先回到分镜步骤"
    />

    <div v-else class="grid">
      <GlassCard
        v-for="shot in shots"
        :key="shot.id"
        padding="md"
        :class="['shot-card', { generating: generating.has(shot.id) }]"
      >
        <div class="shot-head">
          <div class="shot-num">{{ shot.index + 1 }}</div>
          <div class="shot-title">{{ shot.title }}</div>
          <Tag v-if="shot.videoAssetId" type="success" size="sm">已完成</Tag>
          <Tag v-else-if="generating.has(shot.id)" type="warning" size="sm">生成中</Tag>
          <Tag v-else-if="shotH3Mode(shot) === 'fl2va' && !shot.lastFrameAssetId" type="error" size="sm">缺尾帧</Tag>
          <Tag v-else-if="shotH3Mode(shot) !== 'fl2va' && videoRequiresStoryboard(project.current) && !shot.boardAssetId" type="error" size="sm">缺看板</Tag>
          <Tag v-else size="sm">待生成</Tag>
        </div>

        <div class="shot-video">
          <video
            v-if="videoUrls[shot.id]"
            :src="videoUrls[shot.id]"
            controls
            muted
            loop
            playsinline
          />
          <div v-else-if="generating.has(shot.id)" class="placeholder">
            <ProgressRing :progress="0.5" :size="64" :stroke-width="3" />
            <div class="progress-msg">{{ progress[shot.id] || '处理中...' }}</div>
          </div>
          <div v-else class="placeholder">
            <img
              v-if="imageUrls[shot.id]"
              :src="imageUrls[shot.id]"
              class="still zoomable"
              alt=""
              title="点击查看大图"
              @click="openLightbox(imageUrls[shot.id], 'image', shot.title)"
            />
            <div v-else class="placeholder-icon">🎬</div>
            <div class="placeholder-text">未生成</div>
          </div>
        </div>

        <div
          v-if="(shot.videoHistoryIds?.length ?? 0) > 0"
          class="history"
        >
          <span class="history-label">历史版本</span>
          <button
            v-for="hid in shot.videoHistoryIds"
            :key="hid"
            class="history-item"
            title="切回这个版本"
            @click="restoreHistory(shot, hid)"
          >
            <img
              v-if="historyUrls[hid]"
              class="zoomable"
              :src="historyUrls[hid]"
              alt=""
              title="查看大图并切回这个版本"
              @click="openLightbox(historyUrls[hid])"
            />
          </button>
        </div>

        <div v-if="!isDigitalHuman" class="h3-mode-block">
          <H3GenModeSelect :model-value="shotH3Mode(shot)" @update:model-value="setShotH3Mode(shot, $event)" />
          <FramePairSlots
            v-if="shotH3Mode(shot) === 'fl2va'"
            :first-id="shot.firstFrameAssetId"
            :last-id="shot.lastFrameAssetId"
            first-hint="空则用本镜配图"
            @update:first-id="project.updateShot(shot.id, { firstFrameAssetId: $event })"
            @update:last-id="project.updateShot(shot.id, { lastFrameAssetId: $event })"
          />
        </div>
        <div class="shot-info">
          <label class="info-row">
            <span>时长</span>
            <input
              class="dur-input"
              type="number"
              min="5"
              max="10"
              step="1"
              :value="shot.duration"
              @change="project.updateShot(shot.id, { duration: Number(($event.target as HTMLInputElement).value) || shot.duration })"
            />
          </label>
          <label class="info-row">
            <span>运镜</span>
            <select
              class="cam-select"
              :value="shot.cameraMovement"
              @change="project.updateShot(shot.id, { cameraMovement: ($event.target as HTMLSelectElement).value as Shot['cameraMovement'] })"
            >
              <option value="push">推</option>
              <option value="pull">拉</option>
              <option value="pan">摇</option>
              <option value="tilt">移</option>
              <option value="orbit">环绕</option>
              <option value="static">固定</option>
            </select>
          </label>
          <label v-if="!isDigitalHuman" class="info-row">
            <span>人声</span>
            <select
              class="cam-select"
              :value="effectiveShotAudioMode(shot)"
              @change="changeAudioMode(shot, ($event.target as HTMLSelectElement).value as NonNullable<Shot['audioMode']>)"
            >
              <option value="h3-dialogue">H3 出镜对白 + 对口型</option>
              <option value="h3-voiceover">H3 画外口播 + 人物闭嘴</option>
              <option value="tts">后期 TTS + H3 不说话</option>
              <option value="none">无口播，仅环境声</option>
            </select>
          </label>
          <div v-else class="info-row">
            <span>人声</span>
            <strong>成片已带上传音频</strong>
          </div>
        </div>

        <div class="shot-prompt">
          <div class="prompt-bar">
            <div class="prompt-label">视频内容表现</div>
            <div class="prompt-tools">
              <button class="reset-btn" @click="resetVideoPrompt(shot)">按分镜动作重写</button>
              <button class="reset-btn" @click="toggleExpanded(shot.id)">
                {{ expanded.has(shot.id) ? '收起 H3 提交格式' : '看 H3 提交格式' }}
              </button>
            </div>
          </div>
          <textarea
            class="prompt-edit"
            rows="5"
            :value="editableVideoPrompt(shot)"
            :placeholder="videoPromptPlaceholder"
            @input="updateVideoPrompt(shot, ($event.target as HTMLTextAreaElement).value)"
          />
          <pre v-if="expanded.has(shot.id)" class="composed">{{ composedPrompt(shot) }}</pre>
        </div>

        <div class="shot-actions">
          <GradientButton
            v-if="!shot.videoAssetId"
            size="sm"
            icon="✨"
            :loading="generating.has(shot.id)"
            :disabled="generating.has(shot.id)"
            @click="generateOne(shot)"
          >
            生成视频
          </GradientButton>
          <GradientButton
            v-else
            size="sm"
            type="secondary"
            icon="🔄"
            :loading="generating.has(shot.id)"
            @click="generateOne(shot)"
          >
            重新生成
          </GradientButton>
          <GradientButton
            size="sm"
            type="ghost"
            @click="pickerShotId = shot.id"
          >
            资源库选用
          </GradientButton>
        </div>
      </GlassCard>
    </div>

    <AssetPicker
      :open="!!pickerShotId"
      kind="video"
      :multiple="false"
      title="从资源库选用视频片段"
      @close="pickerShotId = null"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  max-width: 1400px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-5);
  gap: var(--space-4);
  flex-wrap: wrap;
}
.page-head h1 {
  font-size: 24px;
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
.warn-card {
  margin-bottom: var(--space-4);
  border-color: var(--color-warning);
  color: var(--color-warning);
  background: rgba(245, 158, 11, 0.1);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--space-4);
}
.shot-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.shot-card.generating {
  border-color: var(--color-accent);
}
.shot-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.shot-num {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--grad-primary);
  color: white;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.shot-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-video {
  position: relative;
  aspect-ratio: 16/9;
  background: #000;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--color-border);
}
.shot-video video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-4);
  background: var(--grad-primary-soft);
  position: relative;
}
.still {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0.35;
}
.placeholder-icon {
  font-size: 32px;
  opacity: 0.5;
  z-index: 1;
}
.placeholder-text {
  font-size: 12px;
  z-index: 1;
}
.progress-msg {
  font-size: 11px;
  color: var(--color-text-3);
  text-align: center;
  padding: 0 var(--space-2);
}
.history {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.history-label {
  font-size: 10px;
  color: var(--color-text-4);
  font-weight: 600;
}
.history-item {
  width: 36px;
  height: 36px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  padding: 0;
}
.history-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.h3-mode-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.shot-info {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  font-size: 12px;
}
.info-row {
  min-width: 0;
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--color-text-3);
  gap: 10px;
}
.info-row span {
  flex-shrink: 0;
  white-space: nowrap;
}
.info-row strong {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-1);
}
.info-row:last-child {
  grid-column: 1 / -1;
}
.dur-input,
.cam-select {
  min-width: 0;
  flex: 1;
  width: auto;
  max-width: 100%;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  color: var(--color-text-1);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 600;
}
.shot-prompt {
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.prompt-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.prompt-label {
  font-size: 10px;
  color: var(--color-text-4);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.prompt-tools {
  display: flex;
  gap: 4px;
}
.reset-btn {
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.reset-btn:hover {
  background: var(--grad-primary-soft);
}
.prompt-edit {
  width: 100%;
  resize: vertical;
  min-height: 88px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.5;
  padding: 8px;
  font-family: inherit;
}
.prompt-edit:focus {
  outline: none;
  border-color: var(--color-accent);
}
.composed {
  margin: 8px 0 0;
  padding: 8px;
  background: var(--color-bg-0);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--color-text-3);
  white-space: pre-wrap;
  line-height: 1.5;
  max-height: 160px;
  overflow: auto;
}
.shot-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.shot-actions > * {
  flex: 1;
}
.voice-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-3);
}
.vo-player {
  width: 100%;
  margin-top: 8px;
  height: 32px;
}
</style>
