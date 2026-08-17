<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useProjectStore, useToastStore } from '@/stores'
import { runCanvasNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import {
  applyProjectPlayMarkdown,
  composeProjectPlayMarkdown
} from '@/utils/scriptMarkdown'
import { markdownToHtml } from '@/utils/markdown'
import { needsPlayReview } from '@/services/canvas/playGate'

const props = defineProps<{
  id: string
  data: {
    label?: string
    width?: number
    height?: number
    nodeType?: string
  }
}>()

const MIN_W = 320
const MIN_H = 360

const project = useProjectStore()
const toast = useToastStore()
const { getViewport } = useVueFlow()

const nodeMeta = computed(() => project.current?.canvas?.nodes.find((n) => n.id === props.id))
const width = computed(() => nodeMeta.value?.data.width || props.data.width || 460)
const height = computed(() => nodeMeta.value?.data.height || props.data.height || 720)
const generating = computed(() => isNodeRunning(props.id) || nodeMeta.value?.status === 'running')
const status = computed(() => nodeMeta.value?.status ?? 'idle')
const waitingReview = computed(() => needsPlayReview(project.current))
const approved = computed(() => Boolean(project.current?.shots.length) && !waitingReview.value)

const editing = ref(false)
const draft = ref('')
const dirty = ref(false)

const markdown = computed(() => {
  if (!project.current) return '# 剧本\n\n*还没有打开项目。*'
  return composeProjectPlayMarkdown(project.current)
})
const html = computed(() => markdownToHtml(markdown.value))

watch(markdown, (md) => {
  if (!editing.value) {
    draft.value = md
    dirty.value = false
  }
})

function startEdit(ev?: Event) {
  ev?.stopPropagation()
  draft.value = markdown.value
  dirty.value = false
  editing.value = true
}

function cancelEdit(ev?: Event) {
  ev?.stopPropagation()
  editing.value = false
  dirty.value = false
  draft.value = markdown.value
}

async function saveEdit(ev?: Event) {
  ev?.stopPropagation()
  if (!project.current) return
  try {
    const clone = JSON.parse(JSON.stringify(project.current)) as typeof project.current
    if (!clone) return
    applyProjectPlayMarkdown(clone, draft.value)
    if (clone.script) project.setScript(clone.script)
    if (clone.subjects) project.setSubjects(clone.subjects)
    if (clone.scenes) project.setScenes(clone.scenes)
    if (clone.shots) project.setShots(clone.shots)
    // 改过剧本后需要重新确认，避免带着旧验收状态往下跑
    if (project.current.playApproved) {
      project.setPlayApproved(false)
    }
    await project.save()
    editing.value = false
    dirty.value = false
    toast.success('剧本已保存，可继续改或点确认通过')
  } catch (e: any) {
    toast.error('保存失败：' + (e?.message || String(e)))
  }
}

async function approvePlay(ev: Event) {
  ev.stopPropagation()
  if (editing.value && dirty.value) {
    await saveEdit()
  }
  project.setPlayApproved(true)
  await project.save()
}

const live = ref<{ w: number; h: number } | null>(null)

function patchSize(w: number, h: number) {
  const canvas = project.current?.canvas
  if (!canvas) return
  const nodes = canvas.nodes.map((n) =>
    n.id === props.id ? { ...n, data: { ...n.data, width: w, height: h } } : n
  )
  project.setCanvas({ ...canvas, nodes })
}

let dragging: {
  kind: 'se' | 'e' | 's'
  sx: number
  sy: number
  sw: number
  sh: number
} | null = null

function flowEl() {
  return document.querySelector(`.vue-flow__node[data-id="${props.id}"]`) as HTMLElement | null
}

function applyBox(w: number, h: number) {
  live.value = { w, h }
  const el = flowEl()
  if (el) {
    el.style.width = `${w}px`
    el.style.height = `${h}px`
  }
}

function onResizeStart(kind: 'se' | 'e' | 's', e: PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragging = {
    kind,
    sx: e.clientX,
    sy: e.clientY,
    sw: width.value,
    sh: height.value
  }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
}

function onResizeMove(e: PointerEvent) {
  if (!dragging) return
  const zoom = getViewport().zoom || 1
  const dx = (e.clientX - dragging.sx) / zoom
  const dy = (e.clientY - dragging.sy) / zoom
  const w = dragging.kind === 's' ? dragging.sw : Math.max(MIN_W, dragging.sw + dx)
  const h = dragging.kind === 'e' ? dragging.sh : Math.max(MIN_H, dragging.sh + dy)
  applyBox(w, h)
}

function onResizeEnd() {
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
  if (live.value) patchSize(Math.round(live.value.w), Math.round(live.value.h))
  live.value = null
  dragging = null
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
})

async function generateThis(ev: Event) {
  ev.stopPropagation()
  if (generating.value) return
  if (editing.value) {
    toast.warn('请先保存或取消剧本编辑')
    return
  }
  try {
    await runCanvasNode(props.id)
  } catch {
    /* 节点上会显示失败 */
  }
}
</script>

<template>
  <div class="sdoc" :class="[`st-${status}`, { editing }]">
    <div class="sdoc-head">
      <div class="sdoc-titles">
        <span class="sdoc-k">完整剧本</span>
        <strong>{{ project.current?.script?.topic || project.current?.name || '剧本' }}</strong>
      </div>
      <div class="sdoc-actions nodrag">
        <template v-if="editing">
          <button type="button" class="sdoc-btn ghost" @click="cancelEdit" @mousedown.stop>取消</button>
          <button type="button" class="sdoc-btn primary" @click="saveEdit" @mousedown.stop>
            保存{{ dirty ? '*' : '' }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="sdoc-btn" @click="startEdit" @mousedown.stop>✎ 编辑</button>
          <button class="sdoc-gen" :disabled="generating" @click="generateThis" @mousedown.stop>
            {{ generating ? '拆解中…' : project.current?.shots.length ? '重新拆分镜' : '拆分镜' }}
          </button>
        </template>
      </div>
    </div>

    <textarea
      v-if="editing"
      v-model="draft"
      class="sdoc-edit nowheel nodrag"
      spellcheck="false"
      @input="dirty = true"
      @mousedown.stop
    />
    <div v-else class="sdoc-md nowheel nodrag" v-html="html" />

    <div v-if="waitingReview && !editing" class="sdoc-gate nodrag">
      <span>请先验收这份剧本。可点「编辑」修改后再确认。确认后才做人设、配图、视频。</span>
      <button type="button" @click="approvePlay" @mousedown.stop>确认通过</button>
    </div>
    <div v-else-if="approved && !editing" class="sdoc-ok nodrag">
      剧本已确认。仍可点「编辑」继续改；改完需重新确认。
    </div>
    <p v-if="nodeMeta?.error" class="sdoc-err">{{ nodeMeta.error }}</p>
    <Handle id="out" type="source" :position="Position.Right" class="hndl" />
    <div class="rz rz-e nodrag nopan" title="横向缩放" @pointerdown="onResizeStart('e', $event)" />
    <div class="rz rz-s nodrag nopan" title="纵向缩放" @pointerdown="onResizeStart('s', $event)" />
    <div class="rz rz-se nodrag nopan" title="拖动缩放" @pointerdown="onResizeStart('se', $event)" />
  </div>
</template>

<style scoped>
.sdoc {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-2);
  border: 1px solid rgba(167, 139, 250, 0.4);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-md);
  color: var(--color-text-1);
  position: relative;
}
.sdoc.editing {
  border-color: var(--color-accent);
}
.sdoc.st-running {
  border-color: var(--color-accent);
}
.sdoc.st-failed {
  border-color: var(--color-error);
}
.sdoc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(124, 58, 237, 0.08);
  flex-shrink: 0;
  cursor: grab;
}
.sdoc-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sdoc-k {
  font-size: 10px;
  color: var(--color-text-4);
  letter-spacing: 0.06em;
}
.sdoc-titles strong {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sdoc-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.sdoc-btn,
.sdoc-gen {
  flex-shrink: 0;
  font-size: 11px;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
  border: none;
  cursor: pointer;
}
.sdoc-btn:hover,
.sdoc-gen:hover:not(:disabled) {
  background: var(--color-accent);
  color: #fff;
}
.sdoc-btn.primary {
  background: var(--color-accent);
  color: #fff;
}
.sdoc-btn.ghost {
  background: transparent;
  border: 1px solid var(--color-border);
}
.sdoc-gen:disabled {
  opacity: 0.6;
}
.sdoc-md,
.sdoc-edit {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px 20px;
  cursor: text;
}
.sdoc-edit {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: var(--color-bg-1);
  color: var(--color-text-1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}
.sdoc-md :deep(h1) {
  margin: 0 0 14px;
  font-size: 22px;
  font-weight: 800;
  line-height: 1.3;
  color: var(--color-text-1);
}
.sdoc-md :deep(h2) {
  margin: 20px 0 8px;
  padding-bottom: 6px;
  font-size: 15px;
  font-weight: 700;
  color: #ddd6fe;
  border-bottom: 1px solid rgba(167, 139, 250, 0.28);
}
.sdoc-md :deep(h3) {
  margin: 14px 0 6px;
  font-size: 13px;
  font-weight: 700;
  color: #c4b5fd;
}
.sdoc-md :deep(p) {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--color-text-2);
}
.sdoc-md :deep(ul),
.sdoc-md :deep(ol) {
  margin: 0 0 10px;
  padding-left: 1.2em;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--color-text-2);
}
.sdoc-md :deep(li) {
  margin: 3px 0;
}
.sdoc-md :deep(strong) {
  color: var(--color-text-1);
  font-weight: 700;
}
.sdoc-md :deep(em) {
  color: var(--color-text-3);
}
.sdoc-md :deep(code) {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--color-bg-3);
}
.sdoc-md :deep(hr) {
  border: none;
  border-top: 1px dashed rgba(255, 255, 255, 0.12);
  margin: 12px 0;
}
.sdoc-err {
  margin: 0;
  padding: 6px 14px 10px;
  font-size: 11px;
  color: var(--color-error);
}
.sdoc-gate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(245, 158, 11, 0.12);
  border-top: 1px solid rgba(251, 191, 36, 0.35);
  flex-shrink: 0;
}
.sdoc-gate span {
  font-size: 12px;
  color: #fcd34d;
  line-height: 1.4;
}
.sdoc-gate button {
  flex-shrink: 0;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  background: #f59e0b;
  color: #111;
  font-weight: 700;
}
.sdoc-ok {
  padding: 8px 14px;
  font-size: 11px;
  color: #6ee7b7;
  border-top: 1px solid rgba(16, 185, 129, 0.25);
  flex-shrink: 0;
}
.hndl {
  width: 8px;
  height: 8px;
  background: #a78bfa;
  border: 1px solid #fff;
}
.rz {
  position: absolute;
  z-index: 4;
}
.rz-e {
  top: 28px;
  right: 0;
  width: 8px;
  height: calc(100% - 36px);
  cursor: ew-resize;
}
.rz-s {
  left: 0;
  bottom: 0;
  width: calc(100% - 14px);
  height: 8px;
  cursor: ns-resize;
}
.rz-se {
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
}
.rz-se::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 8px;
  height: 8px;
  border-right: 2px solid rgba(196, 181, 253, 0.85);
  border-bottom: 2px solid rgba(196, 181, 253, 0.85);
}
</style>
