<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Shot, TimelineClip, TransitionType } from '@/types'

const props = defineProps<{
  clips: TimelineClip[]
  shots: Shot[]
  totalDuration: number
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  update: [id: string, patch: Partial<TimelineClip>]
  remove: [id: string]
}>()

const PX_PER_SECOND = 60

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

/** 拖拽右边缘调整时长 */
function startResize(clip: TimelineClip, evt: MouseEvent) {
  evt.preventDefault()
  const startX = evt.clientX
  const startDuration = clip.duration
  const onMove = (e: MouseEvent) => {
    const dx = e.clientX - startX
    const dSec = dx / PX_PER_SECOND
    const newDuration = Math.max(0.5, startDuration + dSec)
    emit('update', clip.id, { duration: Number(newDuration.toFixed(2)) })
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div class="timeline">
    <div class="timeline-head">
      <div class="tl-info">
        <span class="tl-label">⏱ 总时长</span>
        <span class="tl-value gradient-text">{{ totalDuration }}s</span>
        <span class="tl-divider">·</span>
        <span class="tl-label">片段</span>
        <span class="tl-value">{{ clips.length }}</span>
      </div>
      <div class="tl-tip">提示：拖动片段右边缘可调时长，点击片段编辑属性</div>
    </div>

    <div class="timeline-scroll">
      <div class="timeline-content" :style="{ width: totalWidth + 'px' }">
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

        <div class="track">
          <div
            v-for="clip in clips"
            :key="clip.id"
            class="clip"
            :class="{
              active: clip.id === selectedId,
              disabled: !clip.enabled
            }"
            :style="{
              left: clipLeft(clip) + 'px',
              width: clipWidth(clip) + 'px'
            }"
            @click="emit('select', clip.id)"
          >
            <div class="clip-head">
              <span class="clip-num">#{{ shotOf(clip)?.index ?? '?' }}</span>
              <span class="clip-title">{{ shotOf(clip)?.title ?? '?' }}</span>
              <button
                class="clip-remove"
                @click.stop="emit('remove', clip.id)"
                title="删除"
              >×</button>
            </div>
            <div class="clip-body">
              <div
                v-if="clip.transitionIn !== 'none'"
                class="clip-transition"
                :title="`转场：${clip.transitionIn}`"
              >
                {{ transitionLabel(clip.transitionIn) }}
              </div>
              <div class="clip-duration">
                {{ clip.duration.toFixed(1) }}s
                <span v-if="clip.speed !== 1" class="speed-badge">
                  {{ clip.speed }}x
                </span>
              </div>
              <div
                class="clip-handle clip-handle-right"
                @mousedown="(e) => startResize(clip, e)"
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
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
  background: var(--grad-primary-soft);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--duration-fast);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.clip:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.clip.active {
  border-color: var(--color-accent-2);
  box-shadow: 0 0 0 2px rgba(236, 72, 153, 0.3), var(--shadow-md);
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
  width: 6px;
  cursor: ew-resize;
  background: transparent;
}
.clip-handle-right {
  right: 0;
}
.clip-handle-right:hover {
  background: var(--color-accent);
}
</style>
