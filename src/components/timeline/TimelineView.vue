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
  texts?: { id: string; text: string; startTime: number; duration: number }[]
  selectedTextId?: string | null
  voices?: { id: string; name: string; startTime: number; duration: number }[]
  bgm?: { name: string; startTime: number; duration: number } | null
}>()

const emit = defineEmits<{
  select: [id: string]
  update: [id: string, patch: Partial<TimelineClip>]
  remove: [id: string]
  reorder: [fromId: string, toId: string]
  seek: [seconds: number]
  trim: [id: string, side: 'left' | 'right']
  selectText: [id: string]
  focusAudio: []
  addVoice: []
}>()

const PX_PER_SECOND = 60
const draggingId = ref<string | null>(null)
const menu = ref<{ id: string; x: number; y: number } | null>(null)
const canTrim = computed(() => {
  const clip = props.clips.find(c => c.id === menu.value?.id)
  const offset = (props.playhead ?? 0) - (clip?.startTime ?? 0)
  return Boolean(clip && offset >= 0.1 && clip.duration - offset >= 0.1)
})
function openTrimMenu(clip: TimelineClip, event: MouseEvent) {
  emit('select', clip.id)
  menu.value = { id: clip.id, x: Math.max(4, Math.min(event.clientX, window.innerWidth - 220)), y: Math.max(4, Math.min(event.clientY, window.innerHeight - 118)) }
}
function applyTrim(side: 'left' | 'right') {
  if (menu.value && canTrim.value) emit('trim', menu.value.id, side)
  menu.value = null
}

const totalWidth = computed(() =>
  Math.max(800, props.totalDuration * PX_PER_SECOND + 100)
)

function shotOf(clip: TimelineClip) {
  return props.shots.find((s) => s.id === clip.shotId)
}

function clipWidth(clip: TimelineClip) {
  return clip.duration * PX_PER_SECOND
}

function clipLeft(clip: TimelineClip) {
  return clip.startTime * PX_PER_SECOND
}

function formatTick(sec: number) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
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
  const content = (evt.currentTarget as HTMLElement).closest('.timeline-content') as HTMLElement | null
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
  <div class="tlbody">
    <div class="tlnames">
      <div class="ruler-sp"></div>
      <div class="tlname"><i class="sw text"></i>叠加层</div>
      <div class="tlname"><i class="sw video"></i>主视频</div>
      <div class="tlname"><i class="sw voice"></i>配音</div>
      <div class="tlname"><i class="sw audio"></i>背景音乐</div>
    </div>
    <div class="lanes">
      <div class="timeline-content" :style="{ width: totalWidth + 'px' }" @click="seekFromPointer">
        <div class="ruler">
          <div
            v-for="t in ruler"
            :key="t.sec"
            class="tick"
            :class="{ major: t.major }"
            :style="{ left: t.left + 'px' }"
          >
            <span v-if="t.major">{{ formatTick(t.sec) }}</span>
          </div>
        </div>
        <div
          class="playhead"
          :style="{ left: Math.max(0, Math.min(totalDuration, playhead || 0)) * PX_PER_SECOND + 'px' }"
          title="拖动竖线定位，右键片段按竖线剪切"
          @click.stop
        >
          <span class="playhead-cap" @mousedown="startPlayheadDrag" />
        </div>
        <div class="lane">
          <button
            v-for="item in texts || []"
            :key="item.id"
            type="button"
            class="clip clip-text"
            :class="{ active: item.id === selectedTextId }"
            :style="{ left: item.startTime * PX_PER_SECOND + 'px', width: Math.max(36, item.duration * PX_PER_SECOND) + 'px' }"
            @click.stop="emit('selectText', item.id)"
          >
            <span class="cname">{{ item.text }}</span>
          </button>
        </div>
        <div class="lane">
          <div
            v-for="clip in clips"
            :key="clip.id"
            class="clip clip-video"
            draggable="true"
            :class="{ active: clip.id === selectedId, disabled: !clip.enabled }"
            :style="{ left: clipLeft(clip) + 'px', width: clipWidth(clip) + 'px' }"
            @click.stop="emit('select', clip.id)"
            @contextmenu.prevent.stop="openTrimMenu(clip, $event)"
            @dragstart="startDrag(clip, $event)"
            @dragend="draggingId = null"
            @dragover.prevent
            @drop.prevent="dropOn(clip, $event)"
          >
            <span class="cname">{{ shotOf(clip)?.title || clip.label || '视频素材' }}</span>
            <span class="dur">{{ clip.duration.toFixed(1) }}s</span>
            <span v-if="clip.speed !== 1" class="speed">{{ clip.speed }}x</span>
            <span v-if="clip.transitionIn !== 'none'" class="trans">{{ transitionLabel(clip.transitionIn) }}</span>
            <span class="clip-drag" title="拖动调整顺序"><EditIcon name="grip" :size="12" /></span>
            <button type="button" class="clip-remove" title="删除" @click.stop="emit('remove', clip.id)"><EditIcon name="close" :size="11" /></button>
            <div class="clip-handle left" title="向右拖动，裁掉片段开头" @mousedown="(e) => startTrim(clip, 'left', e)" />
            <div class="clip-handle right" title="向左拖动，裁掉片段结尾" @mousedown="(e) => startTrim(clip, 'right', e)" />
          </div>
          <div v-if="clips.length === 0" class="lane-empty">从左侧片段加入，或用更多里的重建时间线</div>
        </div>
        <div class="lane">
          <button
            v-for="voice in voices || []"
            :key="voice.id"
            type="button"
            class="clip clip-voice"
            :class="{ active: voice.id === selectedId }"
            :style="{ left: voice.startTime * PX_PER_SECOND + 'px', width: Math.max(48, voice.duration * PX_PER_SECOND) + 'px' }"
            @click.stop="emit('select', voice.id)"
          >
            <span class="cname">{{ voice.name }}</span>
          </button>
          <button v-if="!(voices || []).length" type="button" class="lane-empty btn" @click.stop="emit('addVoice')">给选中片段加配音</button>
        </div>
        <div class="lane">
          <button
            v-if="bgm"
            type="button"
            class="clip clip-audio"
            :style="{ left: bgm.startTime * PX_PER_SECOND + 'px', width: Math.max(48, bgm.duration * PX_PER_SECOND) + 'px' }"
            @click.stop="emit('focusAudio')"
          >
            <span class="cname">{{ bgm.name }}</span>
          </button>
          <button v-else type="button" class="lane-empty btn" @click.stop="emit('focusAudio')">投入背景音乐</button>
        </div>
      </div>
    </div>
    <Teleport to="body">
      <div v-if="menu" class="trim-menu-backdrop" @click.self="menu = null" @contextmenu.prevent.self="menu = null" @keydown.esc="menu = null">
        <div class="trim-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" aria-label="片段裁剪">
          <small>{{ canTrim ? '以当前播放头为裁剪点' : '请先将竖线移到片段内部' }}</small>
          <button type="button" :disabled="!canTrim" @click="applyTrim('left')">向左裁剪 · 去掉前段</button>
          <button type="button" :disabled="!canTrim" @click="applyTrim('right')">向右裁剪 · 去掉后段</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.trim-menu-backdrop { position: fixed; inset: 0; z-index: 3000; }
.trim-menu { position: absolute; width: 220px; box-sizing: border-box; padding: 6px; border: 1px solid var(--nb-line-3); border-radius: 10px; background: var(--nb-bg-2); box-shadow: var(--nb-e3); }
.trim-menu small { display: block; padding: 6px 8px; color: var(--nb-t3); font-size: 11px; }
.trim-menu button { display: block; width: 100%; padding: 8px; border: 0; border-radius: 6px; background: transparent; color: var(--nb-t1); text-align: left; cursor: pointer; font-size: 12px; }
.trim-menu button:hover:enabled { background: var(--nb-fill-1, rgba(255,255,255,.045)); }
.trim-menu button:disabled { opacity: .45; cursor: default; }
.tlbody { display: grid; grid-template-columns: 156px 1fr; height: 100%; min-height: 0; overflow: hidden; }
.tlnames { border-right: 1px solid var(--nb-line-2); background: var(--nb-bg-1); }
.ruler-sp { height: 28px; border-bottom: 1px solid var(--nb-line-1); }
.tlname { height: 50px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--nb-line-1); font-size: 11px; color: var(--nb-t3); }
.sw { width: 3px; height: 20px; border-radius: 2px; }
.sw.text { background: var(--nb-t-text, #94a3b8); }
.sw.video { background: var(--nb-t-video, #ffb454); }
.sw.voice { background: var(--nb-accent); }
.sw.audio { background: var(--nb-t-compose, #b78bff); }
.lanes { overflow: auto; background: var(--nb-void); }
.timeline-content { position: relative; min-width: 100%; min-height: 100%; }
.ruler { position: sticky; top: 0; z-index: 4; height: 28px; border-bottom: 1px solid var(--nb-line-1); background: var(--nb-bg-1); }
.tick { position: absolute; top: 0; bottom: 0; width: 1px; }
.tick::after { content: ''; position: absolute; left: 0; bottom: 0; width: 1px; height: 6px; background: var(--nb-line-3); }
.tick span { position: absolute; top: 6px; left: 4px; font-family: var(--nb-font-mono, ui-monospace, monospace); font-size: 10px; color: var(--nb-t4); white-space: nowrap; }
.lane { position: relative; height: 50px; border-bottom: 1px solid var(--nb-line-1); background-image: repeating-linear-gradient(90deg, rgba(255,255,255,.03) 0 1px, transparent 1px 60px); }
.lane-empty { position: absolute; inset: 0; display: flex; align-items: center; padding-left: 12px; color: var(--nb-t4); font-size: 11px; }
.lane-empty.btn { border: 0; background: transparent; cursor: pointer; }
.clip { position: absolute; top: 6px; height: 38px; border-radius: 6px; overflow: hidden; border: 1px solid var(--nb-line-3); color: var(--nb-t1); cursor: pointer; }
.clip-video { background: var(--nb-clip-video-bg, rgba(255,180,84,.14)); border-color: var(--nb-clip-video-line, rgba(255,180,84,.4)); }
.clip-audio { background: var(--nb-clip-audio-bg, rgba(255,143,168,.12)); border-color: var(--nb-clip-audio-line, rgba(255,143,168,.36)); width: auto; }
.clip-voice { background: var(--nb-accent-soft); border-color: var(--nb-line-accent); text-align: left; padding: 0; }
.clip-text { border: 1px solid var(--nb-clip-text-line, rgba(125,140,255,.36)); background: var(--nb-clip-text-bg, rgba(125,140,255,.12)); text-align: left; padding: 0; }
.clip.active { border-color: var(--nb-accent); box-shadow: 0 0 0 1px var(--nb-accent), 0 0 14px var(--nb-accent-glow); }
.clip.disabled { opacity: .4; }
.cname { display: block; padding: 3px 22px 0 8px; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dur, .speed, .trans { position: absolute; right: 4px; bottom: 3px; z-index: 2; height: 15px; padding: 0 4px; border-radius: 4px; background: rgba(6,8,11,.72); border: 1px solid var(--nb-line-2); font-size: 9px; line-height: 15px; color: var(--nb-on-media, #e9f0f9); }
.speed { right: 42px; }
.trans { left: 6px; right: auto; bottom: 3px; }
.clip-drag { position: absolute; left: 4px; bottom: 3px; color: var(--nb-t3); cursor: grab; }
.clip-remove { position: absolute; top: 2px; right: 2px; z-index: 3; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--nb-t3); cursor: pointer; }
.clip-remove:hover { color: var(--nb-danger); }
.clip-handle { position: absolute; top: 0; bottom: 0; width: 6px; z-index: 3; cursor: ew-resize; }
.clip-handle.left { left: 0; }
.clip-handle.right { right: 0; }
.clip-handle:hover { background: rgba(53,214,247,.35); }
.playhead { position: absolute; top: 0; bottom: 0; z-index: 6; width: 1px; background: var(--nb-danger, #ff5c6c); pointer-events: none; }
.playhead-cap { position: absolute; top: 0; left: -5px; width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 8px solid var(--nb-danger, #ff5c6c); pointer-events: auto; cursor: ew-resize; }
</style>
