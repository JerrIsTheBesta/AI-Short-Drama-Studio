<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useAssetsStore, useProjectStore } from '@/stores'
import { runCanvasNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { needsPlayReview } from '@/services/canvas/playGate'
import { cssAspectRatio } from '@/services/canvas/layout'
import { openLightbox } from '@/composables/useLightbox'
import type { CanvasNodeType } from '@/types'

const props = defineProps<{
  id: string
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
const assets = useAssetsStore()
const mediaUrl = ref('')
const videoUrl = ref('')
const videoEl = ref<HTMLVideoElement | null>(null)
const playing = ref(false)

const nodeMeta = computed(() => {
  const p = project.current
  const canvasNode = p?.canvas?.nodes.find((n) => n.id === props.id)
  return canvasNode
})

const shot = computed(() =>
  props.data.shotId
    ? project.current?.shots.find((s) => s.id === props.data.shotId)
    : undefined
)

const durationLabel = computed(() => {
  const d = shot.value?.duration
  if (!d || d <= 0) return ''
  return Number.isInteger(d) ? `${d}s` : `${Number(d).toFixed(1)}s`
})

const title = computed(() => {
  if (type.value === 'script') return project.current?.script?.topic || project.current?.name || '文案'
  if (type.value === 'subject') {
    return (project.current?.subjects ?? []).find((s) => s.id === props.data.subjectId)?.name || '主体'
  }
  if (type.value === 'scene') {
    return (project.current?.scenes ?? []).find((s) => s.id === props.data.sceneId)?.name || '场景'
  }
  if (shot.value) return `${shot.value.index + 1}. ${shot.value.title}`
  return props.data.label || type.value
})

const subtitle = computed(() => {
  if (type.value === 'script') return '文案 / 拆分镜'
  if (type.value === 'subject') return '多角度人设'
  if (type.value === 'scene') return '场景底板'
  if (type.value === 'shotImage') return '分镜配图'
  if (type.value === 'shotVideo') {
    return durationLabel.value ? `分镜视频 · ${durationLabel.value}` : '分镜视频'
  }
  if (type.value === 'audio') return '口播 TTS'
  if (type.value === 'export') return '成片导出'
  return ''
})

const assetId = computed(() => {
  const p = project.current
  if (!p) return undefined
  if (type.value === 'subject') {
    return (p.subjects ?? []).find((s) => s.id === props.data.subjectId)?.designSheetAssetId
  }
  if (type.value === 'scene') {
    return (p.scenes ?? []).find((s) => s.id === props.data.sceneId)?.plateAssetId
  }
  const shot = p.shots.find((s) => s.id === props.data.shotId)
  if (!shot) return undefined
  if (type.value === 'shotImage') return shot.imageAssetId
  if (type.value === 'shotVideo') return shot.videoAssetId
  if (type.value === 'audio') return shot.audioAssetId
  return undefined
})

/** 画面框跟项目片比走，contain 不裁切 */
const mediaAspect = computed(() => {
  if (type.value === 'subject') return cssAspectRatio('16:9')
  return cssAspectRatio(project.current?.settings.aspectRatio)
})

const status = computed(() => nodeMeta.value?.status ?? 'idle')
const generating = computed(() => isNodeRunning(props.id) || status.value === 'running')
const hasAsset = computed(() => Boolean(assetId.value))
const gateBlocked = computed(() => type.value !== 'script' && type.value !== 'export' && needsPlayReview(project.current))

const genLabel = computed(() => {
  if (gateBlocked.value) return '先验收剧本'
  const again = hasAsset.value
  if (type.value === 'script') return project.current?.shots.length ? '重新拆分镜' : '拆分镜'
  if (type.value === 'subject') return again ? '重新生成' : '生成人设'
  if (type.value === 'scene') return again ? '重新生成' : '生成场景'
  if (type.value === 'shotImage') return again ? '重新生成' : '生成配图'
  if (type.value === 'shotVideo') return again ? '重新生成' : '生成视频'
  if (type.value === 'audio') return again ? '重新生成' : '生成口播'
  if (type.value === 'export') return ''
  return again ? '重新生成' : '生成'
})

async function generateThis(ev: Event) {
  ev.stopPropagation()
  if (type.value === 'export' || generating.value || gateBlocked.value) return
  try {
    await runCanvasNode(props.id)
    await loadMedia()
  } catch {
    /* 节点上会显示失败 */
  }
}

watch(
  assetId,
  () => {
    loadMedia()
  },
  { immediate: true }
)

async function loadMedia() {
  const id = assetId.value
  playing.value = false
  if (!id) {
    mediaUrl.value = ''
    videoUrl.value = ''
    return
  }
  if (type.value === 'shotVideo') {
    videoUrl.value = (await assets.getUrl(id)) || ''
    mediaUrl.value = (await assets.ensureThumb(id)) || videoUrl.value
  } else {
    videoUrl.value = ''
    mediaUrl.value = (await assets.getUrl(id)) || ''
  }
}

defineExpose({ loadMedia })

function showVideoFrame(ev: Event) {
  const v = ev.target as HTMLVideoElement
  if (!v || v.currentTime > 0) return
  try {
    v.currentTime = 0.05
  } catch {
    /* ignore */
  }
}

async function togglePlay(ev: Event) {
  ev.stopPropagation()
  const v = videoEl.value
  if (!v || !videoUrl.value) return
  if (v.paused) {
    try {
      v.muted = false
      await v.play()
      playing.value = true
    } catch {
      try {
        v.muted = true
        await v.play()
        playing.value = true
      } catch {
        /* 浏览器拦截自动播放时忽略 */
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
  playing.value = false
}

function onVideoEnded() {
  playing.value = false
  const v = videoEl.value
  if (v) v.currentTime = 0
}
</script>

<template>
  <div class="pnode" :class="[`kind-${type}`, `st-${status}`]">
    <Handle
      v-if="type !== 'script'"
      id="in"
      type="target"
      :position="Position.Left"
      class="hndl"
    />
    <Handle
      v-if="type === 'shotImage'"
      id="char1"
      type="target"
      :position="Position.Left"
      :style="{ top: '28%' }"
      class="hndl"
    />
    <Handle
      v-if="type === 'shotImage'"
      id="char2"
      type="target"
      :position="Position.Left"
      :style="{ top: '50%' }"
      class="hndl"
    />
    <Handle
      v-if="type === 'shotImage'"
      id="scene"
      type="target"
      :position="Position.Left"
      :style="{ top: '72%' }"
      class="hndl"
    />
    <Handle
      v-if="type === 'shotVideo'"
      id="image"
      type="target"
      :position="Position.Left"
      class="hndl"
    />

    <div class="pnode-head">
      <span class="pnode-k">{{ subtitle }}</span>
      <span v-if="status === 'running'" class="badge run">生成中</span>
      <span v-else-if="status === 'failed'" class="badge fail">生成失败</span>
      <span v-else-if="status === 'success'" class="badge ok">完成</span>
    </div>
    <div class="pnode-title">{{ title }}</div>
    <div v-if="type === 'script'" class="pnode-body text">
      {{ (project.current?.script?.content || '还没有正文，在右侧填写或让智能体拆分镜').slice(0, 120) }}
    </div>
    <div v-else-if="type === 'audio'" class="pnode-body wave">
      {{ shot?.voiceover?.slice(0, 40) || '无口播' }}
    </div>
    <div v-else-if="type === 'export'" class="pnode-body text">拼接时间线 · 字幕 · BGM</div>
    <div v-else class="pnode-media" :style="{ aspectRatio: mediaAspect }">
      <template v-if="type === 'shotVideo' && videoUrl">
        <video
          ref="videoEl"
          class="nodrag nowheel"
          :src="videoUrl"
          :poster="mediaUrl && mediaUrl !== videoUrl ? mediaUrl : undefined"
          playsinline
          preload="metadata"
          title="点击播放 / 暂停"
          @loadedmetadata="showVideoFrame"
          @play="onVideoPlay"
          @pause="onVideoPause"
          @ended="onVideoEnded"
          @click.stop="togglePlay"
          @mousedown.stop
        />
        <button
          v-if="!playing"
          class="play-btn nodrag"
          type="button"
          title="播放"
          @click.stop="togglePlay"
          @mousedown.stop
        >
          ▶
        </button>
      </template>
      <img
        v-else-if="mediaUrl"
        :src="mediaUrl"
        alt=""
        title="点击查看大图"
        @click.stop="openLightbox(mediaUrl, 'image', title)"
        @mousedown.stop
      />
      <div v-else class="ph">{{ type === 'shotVideo' ? '▶' : '＋' }}</div>
      <span v-if="type === 'shotVideo' && durationLabel" class="dur">{{ durationLabel }}</span>
    </div>
    <div v-if="nodeMeta?.error" class="pnode-err">{{ nodeMeta.error }}</div>
    <button
      v-if="genLabel"
      class="pnode-gen"
      :disabled="generating || gateBlocked"
      @click="generateThis"
      @mousedown.stop
    >
      {{ generating ? '生成中…' : genLabel }}
    </button>

    <Handle id="out" type="source" :position="Position.Right" class="hndl" />
  </div>
</template>

<style scoped>
.pnode {
  width: 240px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border-strong);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow-md);
  color: var(--color-text-1);
}
.pnode.st-running {
  border-color: var(--color-accent);
}
.pnode.st-failed {
  border-color: var(--color-error);
}
.pnode.st-success {
  border-color: rgba(16, 185, 129, 0.5);
}
.pnode-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px 0;
}
.pnode-k {
  font-size: 10px;
  color: var(--color-text-4);
  letter-spacing: 0.04em;
}
.pnode-title {
  font-size: 13px;
  font-weight: 700;
  padding: 2px 10px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pnode-media {
  position: relative;
  width: 100%;
  background: #0b0b14;
  overflow: hidden;
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
  background: #0b0b14;
}
.pnode-media img {
  cursor: zoom-in;
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
  background: rgba(124, 58, 237, 0.9);
}
.dur {
  position: absolute;
  right: 6px;
  bottom: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: #fff;
  background: rgba(0, 0, 0, 0.72);
  padding: 1px 6px;
  border-radius: 4px;
  pointer-events: none;
  letter-spacing: 0.02em;
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
.pnode-body {
  padding: 8px 10px 12px;
  font-size: 11px;
  color: var(--color-text-3);
  line-height: 1.45;
  min-height: 48px;
}
.pnode-err {
  padding: 4px 10px 8px;
  font-size: 10px;
  color: var(--color-error);
}
.badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 99px;
}
.badge.run {
  background: rgba(124, 58, 237, 0.25);
  color: #c4b5fd;
}
.badge.fail {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}
.badge.ok {
  background: rgba(16, 185, 129, 0.2);
  color: #6ee7b7;
}
.pnode.kind-subject {
  border-color: rgba(251, 191, 36, 0.45);
}
.pnode.kind-scene {
  border-color: rgba(96, 165, 250, 0.45);
}
.pnode.kind-shotImage {
  border-color: rgba(167, 139, 250, 0.45);
}
.pnode.kind-shotVideo {
  border-color: rgba(244, 114, 182, 0.45);
}
.pnode-gen {
  width: calc(100% - 16px);
  margin: 0 8px 8px;
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 8px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
}
.pnode-gen:hover:not(:disabled) {
  background: var(--color-accent);
  color: #fff;
}
.pnode-gen:disabled {
  opacity: 0.6;
  cursor: default;
}
.hndl {
  width: 8px;
  height: 8px;
  background: #a78bfa;
  border: 1px solid #fff;
}
</style>
