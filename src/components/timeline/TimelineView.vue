<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Shot, TimelineClip, TransitionType } from '@/types'
import EditIcon from '@/components/edit/EditIcon.vue'

const props = defineProps<{
  clips: TimelineClip[]
  shots: Shot[]
  totalDuration: number
  selectedId: string | null
  playhead?: number
  sourceDurations?: Record<string, number>
}>()

const emit = defineEmits<{
  select: [id: string]
  update: [id: string, patch: Partial<TimelineClip>]
  remove: [id: string]
  reorder: [fromId: string, toId: string]
  seek: [seconds: number]
}>()

const PX_PER_SECOND = 60
const draggingId = ref<string | null>(null)

const totalWidth = computed(() =>
  Math.max(800, props.totalDuration * PX_PER_SECOND + 100)
)

function shotOf(clip: TimelineClip) {
  return props.shots.find((s) => s.id === clip.shotId)
}

function clipWidth(clip: TimelineClip) {
  return Math.max(40, clip.duration * PX_PER_SECOND)
}

function clipLeft(clip: TimelineClip) {
  return clip.startTime * PX_PER_SECOND
}

function transitionLabel(t: TransitionType) {
  return {
    none: '',
    fade: '↔ 淡入淡出',
    'fade-black': '↔ 黑场',
    'slide-left': '←',
    'slide-right': '→',
    'zoom-in': '⊕',
    'zoom-out': '⊖'
  }[t]
}

const ruler = computed(() => {
  const seconds = Math.max(10, Math.ceil(props.totalDuration) + 5)
  const ticks: { sec: number; left: number; major: boolean }[] = []
  for (let i = 0; i <= seconds; i++) {
    ticks.push({
      sec: i,
      left: i * PX_PER_SECOND,
      major: i % 5 === 0
    })
  }
  return ticks
})

/** 拖动片段边缘做真实素材裁剪：左侧改变入点，右侧改变出点。 */
function startTrim(clip: TimelineClip, edge: 'left' | 'right', evt: MouseEvent) {
  evt.preventDefault()
  evt.stopPropagation()
  emit('select', clip.id)
  const startX = evt.clientX
  const startDuration = clip.duration
  const startSourceIn = clip.sourceIn
  const speed = Math.max(0.01, clip.speed || 1)
  const sourceDuration = props.sourceDurations?.[clip.id]
  const maxOutputDuration = sourceDuration
    ? Math.max(0.1, (sourceDuration - startSourceIn) / speed)
    : Number.POSITIVE_INFINITY
  const onMove = (e: MouseEvent) => {
    const delta = (e.clientX - startX) / PX_PER_SECOND
    if (edge === 'left') {
      const minDelta = -startSourceIn / speed
      const maxDelta = startDuration - 0.1
      const applied = Math.max(minDelta, Math.min(maxDelta, delta))
      emit('update', clip.id, {
        sourceIn: Number(Math.max(0, startSourceIn + applied * speed).toFixed(3)),
        duration: Number(Math.max(0.1, startDuration - applied).toFixed(3))
      })
      return
    }
    const newDuration = Math.max(0.1, Math.min(maxOutputDuration, startDuration + delta))
    emit('update', clip.id, { duration: Number(newDuration.toFixed(3)) })
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function startDrag(clip: TimelineClip, evt: DragEvent) {
  draggingId.value = clip.id
  if (evt.dataTransfer) {
    evt.dataTransfer.effectAllowed = 'move'
    evt.dataTransfer.setData('text/plain', clip.id)
  }
}

function dropOn(clip: TimelineClip, evt: DragEvent) {
  const fromId = draggingId.value || evt.dataTransfer?.getData('text/plain') || ''
  draggingId.value = null
  if (fromId && fromId !== clip.id) emit('reorder', fromId, clip.id)
}

function seekFromPointer(evt: MouseEvent) {
  const el = evt.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const seconds = Math.max(0, Math.min(props.totalDuration, (evt.clientX - rect.left) / PX_PER_SECOND))
  emit('seek', Number(seconds.toFixed(3)))
}

function startPlayheadDrag(evt: MouseEvent) {
  evt.preventDefault()
  evt.stopPropagation()
  const content = (evt.currentTarget as HTMLElement).parentElement
  if (!content) return
  const move = (e: MouseEvent) => {
    const rect = content.getBoundingClientRect()
    const seconds = Math.max(0, Math.min(props.totalDuration, (e.clientX - rect.left) / PX_PER_SECOND))
    emit('seek', Number(seconds.toFixed(3)))
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
  move(evt)
}
</script>

<template>
  <div class="timeline">
    <div class="timeline-head">
      <div class="tl-info">
        <span class="tl-label"><EditIcon name="clock" :size="14" />总时长</span>
        <span class="tl-value gradient-text">{{ totalDuration }}s</span>
        <span class="tl-divider">·</span>
        <span class="tl-label">片段</span>
        <span class="tl-value">{{ clips.length }}</span>
      </div>
      <div class="tl-tip">拖动片段可换顺序；拖动右边缘可调时长</div>
    </div>

    <div class="timeline-scroll">
      <div class="timeline-content" :style="{ width: totalWidth + 'px' }" @click="seekFromPointer">
        <div class="ruler">
          <div
            v-for="t in ruler"
            :key="t.sec"
            class="tick"
            :class="{ major: t.major }"
            :style="{ left: t.left + 'px' }"
          >
            <span v-if="t.major" class="tick-label">{{ t.sec }}s</span>
          </div>
        </div>

        <div
          class="playhead"
          :style="{ left: Math.max(0, Math.min(totalDuration, playhead || 0)) * PX_PER_SECOND + 'px' }"
          title="拖动播放头定位"
          @mousedown="startPlayheadDrag"
        >
          <span class="playhead-cap" />
          <span class="playhead-line" />
        </div>

        <div class="track">
          <div
            v-for="clip in clips"
            :key="clip.id"
            class="clip"
            draggable="true"
            :class="{
              active: clip.id === selectedId,
              disabled: !clip.enabled
            }"
            :style="{
              left: clipLeft(clip) + 'px',
              width: clipWidth(clip) + 'px'
            }"
            @click="emit('select', clip.id)"
            @dragstart="startDrag(clip, $event)"
            @dragend="draggingId = null"
            @dragover.prevent
            @drop.prevent="dropOn(clip, $event)"
          >
            <div class="clip-head">
              <span class="clip-drag" title="拖动调整顺序"><EditIcon name="grip" :size="14" /></span>
              <span class="clip-num">#{{ shotOf(clip) ? (shotOf(clip)!.index + 1) : (clips.findIndex(c => c.id === clip.id) + 1) }}</span>
              <span class="clip-title">{{ shotOf(clip)?.title || clip.label || '视频素材' }}</span>
              <button
                class="clip-remove"
                @click.stop="emit('remove', clip.id)"
                title="删除"
              ><EditIcon name="close" :size="12" /></button>
            </div>
            <div class="clip-body">
              <div
                class="clip-handle clip-handle-left"
                title="向右拖动，裁掉片段开头"
                @mousedown="(e) => startTrim(clip, 'left', e)"
              />
              <div
                v-if="clip.transitionIn !== 'none'"
                class="clip-transition"
                :title="`转场：${clip.transitionIn}`"
              >
                {{ transitionLabel(clip.transitionIn) }}
              </div>
              <div class="clip-duration">
                <span>{{ clip.duration.toFixed(1) }}s</span>
                <span v-if="clip.sourceIn > 0.01" class="trim-badge">入点 {{ clip.sourceIn.toFixed(1) }}s</span>
                <span v-if="clip.speed !== 1" class="speed-badge">
                  {{ clip.speed }}x
                </span>
              </div>
              <div
                class="clip-handle clip-handle-right"
                title="向左拖动，裁掉片段结尾"
                @mousedown="(e) => startTrim(clip, 'right', e)"
              />
            </div>
          </div>

          <div v-if="clips.length === 0" class="track-empty">
            时间线是空的。从左侧分镜库点 "+" 加入，或点「重建时间线」自动加入所有分镜
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
}
.timeline-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-3);
  font-size: 12px;
}
.tl-info {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tl-label {
  color: var(--color-text-3);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tl-value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tl-divider {
  color: var(--color-text-4);
  margin: 0 4px;
}
.tl-tip {
  color: var(--color-text-4);
  font-size: 11px;
}

.timeline-scroll {
  overflow-x: auto;
  overflow-y: visible;
  padding-bottom: 8px;
}
.timeline-content {
  position: relative;
  min-width: 100%;
}

.ruler {
  position: relative;
  height: 24px;
  background: var(--color-bg-2);
  border-radius: 6px;
  margin-bottom: 8px;
  border: 1px solid var(--color-border);
}
.tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
}
.tick.major {
  background: var(--color-border-strong);
}
.tick-label {
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 10px;
  color: var(--color-text-3);
  font-variant-numeric: tabular-nums;
}

.track {
  position: relative;
  min-height: 84px;
  background: var(--color-bg-2);
  border-radius: 7px;
  border: 1px solid var(--color-border);
  padding: 8px 0;
}
.track-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-4);
  font-size: 13px;
  padding: var(--space-5);
  text-align: center;
}

.clip {
  position: absolute;
  top: 8px;
  height: 68px;
  background: #25324a;
  border: 1px solid #496da9;
  border-radius: 6px;
  cursor: pointer;
  transition: all var(--duration-fast);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.clip:hover {
  transform: translateY(-1px);
  border-color: #7ea9ff;
  box-shadow: none;
}
.clip.active {
  border-color: #9bc0ff;
  box-shadow: 0 0 0 2px rgba(126, 169, 255, .18);
}
.clip.disabled {
  opacity: 0.4;
}
.clip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: rgba(0, 0, 0, 0.2);
  font-size: 10px;
  border-bottom: 1px solid var(--color-border);
}
.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 20;
  width: 14px;
  transform: translateX(-7px);
  cursor: ew-resize;
}
.playhead-cap {
  position: absolute;
  top: 0;
  left: 2px;
  width: 10px;
  height: 10px;
  border-radius: 3px 3px 6px 6px;
  background: #ff4d67;
  box-shadow: 0 1px 5px rgba(255, 77, 103, 0.45);
}
.playhead-line {
  position: absolute;
  top: 8px;
  bottom: 0;
  left: 6px;
  width: 2px;
  background: #ff4d67;
  box-shadow: 0 0 4px rgba(255, 77, 103, 0.35);
}
.clip-drag {
  color: var(--color-text-3);
  cursor: grab;
  line-height: 1;
  flex-shrink: 0;
}
.clip-num {
  background: var(--color-accent);
  color: white;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 700;
  font-size: 9px;
  flex-shrink: 0;
}
.clip-title {
  flex: 1;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 10px;
}
.clip-remove {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1;
  display: grid;
  place-items: center;
}
.clip-remove:hover {
  background: var(--color-error);
  color: white;
}
.clip-body {
  flex: 1;
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  position: relative;
}
.trim-badge {
  overflow: hidden;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(126, 169, 255, .18);
  color: #b9d1ff;
  font-size: 9px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clip-transition {
  font-size: 9px;
  color: var(--color-text-3);
  background: rgba(0, 0, 0, 0.3);
  padding: 1px 4px;
  border-radius: 3px;
  align-self: flex-start;
}
.clip-duration {
  font-size: 11px;
  color: var(--color-text-2);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.speed-badge {
  font-size: 9px;
  background: rgba(255, 255, 255, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 500;
}
.clip-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
  z-index: 3;
  background: rgba(126, 169, 255, .08);
}
.clip-handle-left {
  left: 0;
  border-right: 1px solid rgba(126, 169, 255, .35);
}
.clip-handle-right {
  right: 0;
  border-left: 1px solid rgba(126, 169, 255, .35);
}
.clip-handle:hover {
  background: #7ea9ff;
}
</style>
