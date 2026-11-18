<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { useProjectStore, useToastStore } from '@/stores'
import { normalizeNodeScale, resizeNodeCorner, type ResizeCorner } from '@/utils/nodeResize'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ renderer: Component; id: string; selected?: boolean; data: { nodeType?: string; width?: number; height?: number; canvasScale?: number } }>()
const project = useProjectStore()
const toast = useToastStore()
const { getViewport, updateNodeInternals } = useVueFlow()
const inner = ref<HTMLElement | null>(null)
const root = ref<HTMLElement | null>(null)
const measured = ref({ width: 240, height: 160 })
const resizing = ref(false)
const node = computed(() => project.current?.canvas?.nodes.find(n => n.id === props.id))
const scale = computed(() => normalizeNodeScale(node.value?.data.canvasScale ?? props.data.canvasScale))
const scriptBox = computed(() => props.data.nodeType === 'script' ? { width: `${props.data.width || 460}px`, height: `${props.data.height || 720}px` } : {})
const outerStyle = computed(() => ({ width: `${measured.value.width * scale.value}px`, height: `${measured.value.height * scale.value}px` }))
const corners: ResizeCorner[] = ['nw', 'ne', 'sw', 'se']
let observer: ResizeObserver | undefined
let raf = 0
let drag: { projectId: string; pointer: number; corner: ResizeCorner; clientX: number; clientY: number; zoom: number; x: number; y: number; width: number; height: number; scale: number } | undefined
function refreshHandles() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => { void updateNodeInternals([props.id]) })
}
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (!inner.value) return
    measured.value = { width: inner.value.offsetWidth, height: inner.value.offsetHeight }
    refreshHandles()
  })
  if (inner.value) observer.observe(inner.value)
})
watch(scale, () => { void nextTick(refreshHandles) })
function start(corner: ResizeCorner, event: PointerEvent) {
  if (event.button !== 0 || !node.value || !project.current || !root.value) return
  const zoom = getViewport().zoom || 1
  const box = root.value.getBoundingClientRect()
  drag = { projectId: project.current.id, pointer: event.pointerId, corner, clientX: event.clientX, clientY: event.clientY, zoom,
    x: node.value.position.x, y: node.value.position.y, width: box.width / zoom, height: box.height / zoom, scale: scale.value }
  resizing.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('blur', cancel)
}
function move(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer || !node.value) return
  if (project.current?.id !== drag.projectId) { cleanup(); return }
  event.preventDefault()
  const result = resizeNodeCorner(drag, drag.corner, (event.clientX - drag.clientX) / drag.zoom, (event.clientY - drag.clientY) / drag.zoom)
  node.value.position = { x: result.x, y: result.y }
  project.patchCanvasNode(props.id, { canvasScale: result.scale })
}
function cleanup() {
  drag = undefined
  resizing.value = false
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerup', end)
  window.removeEventListener('pointercancel', cancel)
  window.removeEventListener('blur', cancel)
}
function end(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointer) return
  move(event)
  const sameProject = project.current?.id === drag?.projectId
  cleanup()
  if (sameProject) void project.save().catch(() => toast.error('节点尺寸保存失败，请重试保存项目'))
}
function cancel() {
  if (drag && node.value && project.current?.id === drag.projectId) {
    node.value.position = { x: drag.x, y: drag.y }
    project.patchCanvasNode(props.id, { canvasScale: drag.scale })
  }
  cleanup()
}
onBeforeUnmount(() => { cancel(); observer?.disconnect(); cancelAnimationFrame(raf) })
</script>
<template>
  <div ref="root" class="resizable-node" :class="{ resizing }" :style="outerStyle">
    <div ref="inner" class="node-scale-content" :style="{ ...scriptBox, transform: `scale(${scale})` }">
      <component :is="renderer" v-bind="$attrs" :id="id" :selected="selected" :data="data" />
    </div>
    <template v-if="selected || resizing">
      <span class="resize-outline" aria-hidden="true" />
      <button v-for="corner in corners" :key="corner" type="button" class="corner nodrag nopan nowheel" :class="corner"
        :aria-label="`${({ nw: '左上', ne: '右上', sw: '左下', se: '右下' })[corner]}角缩放节点`" title="拖动等比缩放节点（不改变生成分辨率）"
        @pointerdown.stop.prevent="start(corner, $event)" @mousedown.stop @click.stop @dblclick.stop />
    </template>
  </div>
</template>
<style scoped>
.resizable-node { position: relative; overflow: visible; }
.node-scale-content { position: relative; width: max-content; transform-origin: top left; }
.node-scale-content :deep(.rz) { display: none; }
.node-scale-content :deep(.fnode), .node-scale-content :deep(.pnode) { background: transparent; box-shadow: none; }
/* Keep the title attached to the card but outside its media surface. */
.node-scale-content :deep(.fnode > .name),
.node-scale-content :deep(.pnode > .pnode-name),
.node-scale-content :deep(.subject-card > .sc-head),
.node-scale-content :deep(.anode > .anode-top) {
  position: absolute; top: -28px; left: 0; right: 0; height: 24px; min-height: 24px;
  margin: 0; padding: 0 2px; border: none; border-radius: 0; background: transparent; box-shadow: none;
  display: flex; align-items: center; gap: 6px;
}
.node-scale-content :deep(.fnode > .name)::before,
.node-scale-content :deep(.pnode > .pnode-name)::before {
  content: ''; width: 13px; height: 13px; flex: 0 0 13px; background: var(--color-text-3);
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='none' stroke='black' stroke-width='1.8' d='M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M3 17l6-6 5 5 3-3 4 4'/%3E%3Ccircle cx='16' cy='8' r='2'/%3E%3C/svg%3E") center / contain no-repeat;
}
.node-scale-content :deep(.kind-videoGen > .name)::before,
.node-scale-content :deep(.kind-shotVideo > .pnode-name)::before,
.node-scale-content :deep(.kind-compose > .name)::before {
  mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3' y='3' width='18' height='18' rx='4' fill='none' stroke='black' stroke-width='1.8'/%3E%3Cpath d='m10 7 7 5-7 5z'/%3E%3C/svg%3E");
}
.node-scale-content :deep(.subject-card) { background: transparent; }
.node-scale-content :deep(.toolbar-wrap) { bottom: calc(100% + 34px); }
.node-scale-content :deep(.sdoc-head) { background: transparent; }
.resize-outline { position: absolute; inset: -2px; border: 1px solid var(--color-accent, #9b82ff); border-radius: 8px; pointer-events: none; }
.corner { position: absolute; z-index: 40; width: 12px; height: 12px; padding: 0; margin: 0; border: 2px solid var(--color-accent, #9b82ff); border-radius: 3px; background: var(--color-bg-1, #1b1b20); touch-action: none; }
.corner:hover { background: var(--color-accent, #9b82ff); }
.nw { top: -6px; left: -6px; cursor: nwse-resize; }
.ne { top: -6px; right: -6px; cursor: nesw-resize; }
.sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
.se { bottom: -6px; right: -6px; cursor: nwse-resize; }
</style>
