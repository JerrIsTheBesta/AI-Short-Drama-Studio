<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore, useToastStore } from '@/stores'
import { groupGenerateJobId, runExtractGroup, runGenerateGroup } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { isPlayReady } from '@/services/ai'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import { isPlayApproved, PLAY_GATE_MSG } from '@/services/canvas/playGate'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'

const props = defineProps<{
  id: string
  data: {
    label?: string
    kind?: string
  }
}>()

const project = useProjectStore()
const toast = useToastStore()

const extractable = computed(() => {
  if (props.data.kind === 'subject' || props.data.kind === 'scene' || props.data.kind === 'shot') return true
  return props.data.kind === 'video' && !project.current?.canvas?.nodes.some((n) => n.id === 'group-shots')
})
const generatable = computed(
  () =>
    props.data.kind === 'subject' ||
    props.data.kind === 'scene' ||
    props.data.kind === 'shot' ||
    props.data.kind === 'frames' ||
    props.data.kind === 'video'
)
const running = computed(() => isNodeRunning(props.id))
const generating = computed(() => isNodeRunning(groupGenerateJobId(props.id)))
const busy = computed(() => running.value || generating.value)
const playReady = computed(
  () => isPlayReady(project.current?.script) || Boolean((project.current?.script?.content || '').trim())
)
const hasItems = computed(() => {
  if (props.data.kind === 'subject') return Boolean(project.current?.subjects?.length)
  if (props.data.kind === 'scene') return Boolean(project.current?.scenes?.length)
  return Boolean(project.current?.shots.length)
})
const childCount = computed(
  () =>
    project.current?.canvas?.nodes.filter(
      (n) =>
        n.parentGroupId === props.id &&
        (n.type === 'subject' ||
          n.type === 'scene' ||
          n.type === 'shotBoard' ||
          n.type === 'shotImage' ||
          n.type === 'shotFrames' ||
          n.type === 'shotVideo' ||
          n.type === 'sceneProps')
    ).length ?? 0
)
const runningChildCount = computed(
  () =>
    project.current?.canvas?.nodes.filter(
      (n) => n.parentGroupId === props.id && isNodeRunning(n.id)
    ).length ?? 0
)
const btnLabel = computed(() => {
  if (running.value) return '提取中'
  if (props.data.kind === 'subject') return hasItems.value ? '重新提取' : '提取人物'
  if (props.data.kind === 'scene') return hasItems.value ? '重新提取' : '提取场景'
  return hasItems.value ? '重新提取' : '提取分镜'
})
const genLabel = computed(() => (generating.value ? '生成中' : '一键生成'))
const overlayLabel = computed(() => {
  if (running.value) return btnLabel.value
  if (generating.value && childCount.value) return `生成中 ${runningChildCount.value}/${childCount.value}`
  return genLabel.value
})

async function reextract(ev: Event) {
  ev.stopPropagation()
  if (busy.value || !extractable.value) return
  if (!playReady.value) {
    toast.warn('请先写完整剧本，再提取')
    return
  }
  try {
    await runExtractGroup(props.id)
    toast.success(
      props.data.kind === 'subject'
        ? '人物已更新，已有四视图按同名保留'
        : props.data.kind === 'scene'
          ? '场景描点已更新，已有锚点图按同名保留'
          : '分镜已更新，已有看板/配图/视频按镜号保留'
    )
  } catch (e) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e))
  }
}

async function generateAll(ev: Event) {
  ev.stopPropagation()
  if (busy.value || !generatable.value || !hasItems.value) return
  if (
    (props.data.kind === 'shot' || props.data.kind === 'frames' || props.data.kind === 'video') &&
    !isPlayApproved(project.current)
  ) {
    toast.warn(PLAY_GATE_MSG)
    return
  }
  try {
    await runGenerateGroup(props.id)
    toast.success(
      props.data.kind === 'subject'
        ? '人物四视图已全部跑完'
        : props.data.kind === 'scene'
          ? '场景锚点图已全部跑完'
          : props.data.kind === 'video'
            ? '分镜视频已全部跑完'
            : '分镜关键帧已全部跑完'
    )
  } catch (e) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e))
  }
}
</script>

<template>
  <div class="gframe" :class="[data.kind ? `tint-${data.kind}` : '', { busy }]">
    <div class="gframe-h">
      <span>{{ data.label || '分组' }}</span>
      <div v-if="extractable || generatable" class="gframe-actions nodrag nopan">
        <button
          v-if="extractable"
          type="button"
          class="gframe-btn"
          :disabled="busy || !playReady"
          :title="hasItems ? '只重提这一组，其它组和已生成的图/视频会留下' : '从完整剧本提取这一组'"
          @click="reextract"
          @mousedown.stop
          @pointerdown.stop
        >
          {{ btnLabel }}
        </button>
        <button
          v-if="generatable"
          type="button"
          class="gframe-btn gen"
          :disabled="busy || !hasItems"
          title="同时生成这一组下面的全部节点"
          @click="generateAll"
          @mousedown.stop
          @pointerdown.stop
        >
          {{ genLabel }}
        </button>
      </div>
    </div>
    <NodeBusyOverlay v-if="busy" :label="overlayLabel" />
  </div>
</template>

<style scoped>
.gframe {
  width: 100%;
  height: 100%;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: var(--color-canvas-group);
  pointer-events: none;
}
.gframe-h {
  position: relative;
  z-index: 4;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 12px 0 16px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-2);
  pointer-events: none;
}
.gframe-h > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gframe-actions {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.gframe-btn {
  pointer-events: auto;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 650;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--color-bg-3);
  color: var(--color-text-1);
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.gframe-btn.gen {
  border-color: rgba(255, 255, 255, 0.22);
}
.gframe-btn:hover:not(:disabled) {
  background: var(--color-accent);
  color: #fff;
  border-color: transparent;
}
.gframe-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.tint-script,
.tint-subject,
.tint-scene,
.tint-shot,
.tint-video,
.tint-audio,
.tint-export {
  background: var(--color-canvas-group);
  border-color: rgba(255, 255, 255, 0.08);
}
</style>
