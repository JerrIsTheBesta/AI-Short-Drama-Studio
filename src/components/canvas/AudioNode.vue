<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useAssetsStore, useProjectStore, useToastStore } from '@/stores'
import { runCanvasNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { needsPlayReview } from '@/services/canvas/playGate'
import { inspectCanvasNode } from '@/services/canvas/canvasBridge'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'
import type { ShotAudioMode } from '@/types'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    shotId?: string
    label?: string
  }
}>()

const AUDIO_MODES: { id: ShotAudioMode; label: string }[] = [
  { id: 'h3-dialogue', label: 'H3 对白' },
  { id: 'h3-voiceover', label: 'H3 画外' },
  { id: 'tts', label: '后期 TTS' },
  { id: 'none', label: '无口播' }
]

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const { findNode, removeSelectedNodes } = useVueFlow()

const panelOpen = ref(false)
const playing = ref(false)
const audioEl = ref<HTMLAudioElement | null>(null)
const mediaUrl = ref('')

const shot = computed(() =>
  props.data.shotId ? project.current?.shots.find((s) => s.id === props.data.shotId) : undefined
)
const nodeMeta = computed(() => project.current?.canvas?.nodes.find((n) => n.id === props.id))
const status = computed(() => nodeMeta.value?.status ?? 'idle')
const generating = computed(() => isNodeRunning(props.id))
const mode = computed(() => (shot.value ? effectiveShotAudioMode(shot.value) : 'none'))
const canTts = computed(() => Boolean(shot.value && needsExternalTts(shot.value)))
const gateBlocked = computed(() => needsPlayReview(project.current))
const title = computed(() =>
  shot.value ? `${shot.value.index + 1}. ${shot.value.title}` : props.data.label || '口播'
)
const previewLine = computed(() => {
  const t = shot.value?.voiceover?.trim()
  if (t) return t
  if (mode.value === 'none') return '这一镜没有口播'
  if (mode.value === 'tts') return '还没有口播文案'
  return '人声会跟视频一起生成'
})

watch(
  () => props.selected,
  (on) => {
    panelOpen.value = Boolean(on)
  },
  { immediate: true }
)

watch(
  () => shot.value?.audioAssetId,
  async (id) => {
    playing.value = false
    if (!id) {
      mediaUrl.value = ''
      return
    }
    mediaUrl.value = (await assets.getUrl(id)) || ''
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  audioEl.value?.pause()
})

function setMode(next: ShotAudioMode) {
  if (!shot.value) return
  project.setShotAudioMode(shot.value.id, next)
}

function setVoiceover(v: string) {
  if (!shot.value) return
  project.updateShot(shot.value.id, { voiceover: v })
}

async function togglePlay(ev?: Event) {
  ev?.stopPropagation()
  const el = audioEl.value
  if (!el || !mediaUrl.value) return
  if (el.paused) {
    await el.play().catch(() => {})
    playing.value = true
  } else {
    el.pause()
    playing.value = false
  }
}

async function generateThis(ev?: Event) {
  ev?.stopPropagation()
  if (generating.value || gateBlocked.value) return
  if (!canTts.value) {
    toast.info('H3 人声会跟视频一起生成，只有后期 TTS 才在这里出配音')
    return
  }
  panelOpen.value = false
  const n = findNode(props.id)
  if (n) removeSelectedNodes([n])
  try {
    await runCanvasNode(props.id)
  } catch {
    /* 节点上会显示失败 */
  }
}

function openDetail() {
  inspectCanvasNode(props.id)
}
</script>

<template>
  <div class="anode" :class="[`st-${status}`, { on: selected && panelOpen, busy: generating }]">
    <Handle id="in" type="target" :position="Position.Left" class="hndl" />

    <div class="anode-top">
      <span class="kind">口播</span>
      <span class="name" :title="title">{{ title }}</span>
      <span class="mode">{{ AUDIO_MODES.find((m) => m.id === mode)?.label }}</span>
    </div>

    <p class="line">{{ previewLine }}</p>

    <div class="anode-foot">
      <audio
        v-if="mediaUrl"
        ref="audioEl"
        class="nodrag nowheel"
        :src="mediaUrl"
        preload="auto"
        @play="playing = true"
        @pause="playing = false"
        @ended="playing = false"
      />
      <button
        v-if="mediaUrl"
        class="play nodrag"
        type="button"
        @click.stop="togglePlay"
        @mousedown.stop
      >
        {{ playing ? '❚❚' : '▶' }}
      </button>
      <span v-else class="hint">{{ canTts ? '待合成 TTS' : mode === 'none' ? '无口播' : '随视频出声' }}</span>
    </div>
    <NodeBusyOverlay v-if="generating" label="合成中" />

    <transition name="float-down">
      <div v-if="selected && panelOpen" class="panel nodrag nowheel" @mousedown.stop @click.stop>
        <div class="modes">
          <button
            v-for="m in AUDIO_MODES"
            :key="m.id"
            type="button"
            :class="{ on: mode === m.id }"
            @click="setMode(m.id)"
          >
            {{ m.label }}
          </button>
        </div>
        <textarea
          rows="4"
          :value="shot?.voiceover || ''"
          placeholder="这一镜要说的原词"
          @input="setVoiceover(($event.target as HTMLTextAreaElement).value)"
        />
        <div class="panel-foot">
          <span>{{ canTts ? '后期独立配音' : '人声走 H3 视频' }}</span>
          <button type="button" class="ghost" @click="openDetail">详情</button>
          <button
            v-if="canTts"
            type="button"
            class="go"
            :disabled="generating || gateBlocked"
            @click="generateThis"
          >
            ↑
          </button>
        </div>
      </div>
    </transition>

    <Handle id="out" type="source" :position="Position.Right" class="hndl" />
  </div>
</template>

<style scoped>
.anode {
  position: relative;
  width: 240px;
  min-height: 128px;
  padding: 10px 12px 8px;
  background: #11181a;
  border: 1px solid rgba(52, 211, 153, 0.28);
  border-radius: 12px;
  color: var(--color-text-1);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
  overflow: visible;
}
.anode.on {
  border-color: rgba(255, 255, 255, 0.55);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18), 0 16px 40px rgba(0, 0, 0, 0.45);
  z-index: 4;
}
.anode.st-running,
.anode.busy {
  border-color: #c4b5fd;
  box-shadow: 0 0 0 2px rgba(167, 139, 250, 0.55), 0 0 22px rgba(124, 58, 237, 0.5);
  animation: node-busy 1.35s ease-in-out infinite;
  z-index: 5;
}
@keyframes node-busy {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgba(167, 139, 250, 0.4), 0 0 14px rgba(124, 58, 237, 0.32);
  }
  50% {
    box-shadow: 0 0 0 3px rgba(221, 214, 254, 0.9), 0 0 28px rgba(124, 58, 237, 0.62);
  }
}
.anode.st-failed {
  border-color: var(--color-error);
}
.anode-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.kind {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #6ee7b7;
}
.name {
  min-width: 0;
  flex: 1;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mode {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-4);
}
.line {
  margin: 8px 0 0;
  min-height: 40px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.anode-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  min-height: 28px;
}
.play {
  width: 28px;
  height: 28px;
  margin: 0;
  padding: 0 0 1px 1px;
  border: none;
  border-radius: 50%;
  background: rgba(16, 185, 129, 0.9);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
}
.hint {
  font-size: 11px;
  color: var(--color-text-4);
}
.panel {
  position: absolute;
  left: 50%;
  top: calc(100% + 8px);
  z-index: 5;
  width: 320px;
  transform: translateX(-50%);
  background: #161f1d;
  border: 1px solid rgba(52, 211, 153, 0.22);
  border-radius: 12px;
  padding: 10px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.modes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-bottom: 8px;
}
.modes button {
  margin: 0;
  padding: 6px 0;
  border: none;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.08);
  color: #f5f5fa;
  font-size: 11px;
  cursor: pointer;
}
.modes button.on {
  background: #fff;
  color: #111;
  font-weight: 650;
}
.panel textarea {
  width: 100%;
  min-height: 72px;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
}
.panel-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.panel-foot span {
  flex: 1;
  font-size: 10px;
  color: var(--color-text-4);
}
.ghost {
  margin: 0;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 11px;
  cursor: pointer;
}
.go {
  width: 28px;
  height: 28px;
  margin: 0;
  border: none;
  border-radius: 7px;
  background: #fff;
  color: #111;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.go:disabled {
  opacity: 0.4;
  cursor: default;
}
.hndl {
  width: 8px;
  height: 8px;
  background: #34d399;
  border: 1px solid #fff;
}
.float-down-enter-active,
.float-down-leave-active {
  transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.float-down-enter-from,
.float-down-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-10px) scale(0.98);
}
</style>
