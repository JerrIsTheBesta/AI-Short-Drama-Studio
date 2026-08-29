<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { VueFlow, useVueFlow, type Connection, type Edge, type Node, type NodeMouseEvent } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { rebuildCanvasGraph, NODE_W } from '@/services/canvas/layout'
import { setCanvasReveal, setCanvasInspect, setCanvasSelect } from '@/services/canvas/canvasBridge'
import {
  appendCanvasReferenceSource,
  canvasNodeProducesImage
} from '@/services/canvas/references'
import { isDesktop, desktop } from '@/services/desktop'
import PipelineNode from '@/components/canvas/PipelineNode.vue'
import AudioNode from '@/components/canvas/AudioNode.vue'
import ScriptDocNode from '@/components/canvas/ScriptDocNode.vue'
import GroupFrame from '@/components/canvas/GroupFrame.vue'
import FreeformGenNode from '@/components/canvas/FreeformGenNode.vue'
import AgentChat from '@/components/canvas/AgentChat.vue'
import PromptCoach from '@/components/canvas/PromptCoach.vue'
import NodeInspector from '@/components/canvas/NodeInspector.vue'
import type { CanvasNode } from '@/types'

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const router = useRouter()
const agentOpen = ref(true)
const agentWidth = ref(440)
const resizingAgent = ref(false)
const rightOpen = ref(false)
const isImg2Video = computed(() => project.current?.pipelineMode === 'img2video')

const AGENT_WIDTH_KEY = 'aicut:agent-chat-width'
const AGENT_MIN_WIDTH = 300
const AGENT_MAX_WIDTH = 760
let resizeStartX = 0
let resizeStartWidth = 440
let previousBodyCursor = ''
let previousBodyUserSelect = ''

function maxAgentWidth() {
  const rightDock = rightOpen.value ? 300 : 0
  return Math.max(
    AGENT_MIN_WIDTH,
    Math.min(AGENT_MAX_WIDTH, window.innerWidth - rightDock - 360)
  )
}

function clampAgentWidth(value: number) {
  return Math.round(Math.max(AGENT_MIN_WIDTH, Math.min(maxAgentWidth(), value)))
}

function persistAgentWidth() {
  try {
    localStorage.setItem(AGENT_WIDTH_KEY, String(agentWidth.value))
  } catch {
    /* localStorage unavailable */
  }
}

function loadAgentWidth() {
  try {
    const saved = Number(localStorage.getItem(AGENT_WIDTH_KEY))
    if (Number.isFinite(saved) && saved > 0) agentWidth.value = clampAgentWidth(saved)
  } catch {
    agentWidth.value = clampAgentWidth(agentWidth.value)
  }
}

function onAgentResizeMove(event: PointerEvent) {
  if (!resizingAgent.value) return
  agentWidth.value = clampAgentWidth(resizeStartWidth + event.clientX - resizeStartX)
}

function stopAgentResize() {
  if (!resizingAgent.value) return
  resizingAgent.value = false
  window.removeEventListener('pointermove', onAgentResizeMove)
  window.removeEventListener('pointerup', stopAgentResize)
  window.removeEventListener('pointercancel', stopAgentResize)
  document.body.style.cursor = previousBodyCursor
  document.body.style.userSelect = previousBodyUserSelect
  persistAgentWidth()
}

function startAgentResize(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  resizeStartX = event.clientX
  resizeStartWidth = agentWidth.value
  resizingAgent.value = true
  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onAgentResizeMove)
  window.addEventListener('pointerup', stopAgentResize)
  window.addEventListener('pointercancel', stopAgentResize)
}

function nudgeAgentWidth(delta: number) {
  agentWidth.value = clampAgentWidth(agentWidth.value + delta)
  persistAgentWidth()
}

function clampAgentToViewport() {
  const next = clampAgentWidth(agentWidth.value)
  if (next !== agentWidth.value) agentWidth.value = next
}

watch(rightOpen, clampAgentToViewport)

const nodeTypes = {
  script: ScriptDocNode,
  subject: PipelineNode,
  subjectProps: PipelineNode,
  scene: PipelineNode,
  sceneProps: PipelineNode,
  shotBoard: PipelineNode,
  shotImage: PipelineNode,
  shotVideo: PipelineNode,
  audio: AudioNode,
  export: PipelineNode,
  final: PipelineNode,
  groupFrame: GroupFrame,
  imageGen: FreeformGenNode,
  videoGen: FreeformGenNode
}

const { onConnect, onNodeDragStop, onMoveEnd, fitView, screenToFlowCoordinate } = useVueFlow()

const ctxMenu = ref<{
  x: number
  y: number
  flow: { x: number; y: number }
  nodeId?: string
} | null>(null)

const flowNodes = computed<Node[]>(() => {
  const graph = project.current?.canvas
  if (!graph) return []
  return graph.nodes.map((n) => {
    if (n.type === 'groupFrame') {
      return {
        id: n.id,
        type: 'groupFrame',
        position: n.position,
        data: { ...n.data, nodeType: n.type },
        style: {
          width: `${n.data.width ?? 280}px`,
          height: `${n.data.height ?? 240}px`
        },
        draggable: true,
        selectable: false,
        zIndex: 0
      }
    }
    if (n.type === 'script') {
      return {
        id: n.id,
        type: 'script',
        position: n.position,
        data: { ...n.data, nodeType: n.type },
        style: {
          width: `${n.data.width ?? 460}px`,
          height: `${n.data.height ?? 720}px`
        },
        draggable: true,
        zIndex: 2
      }
    }
    return {
      id: n.id,
      type: n.type,
      position: n.position,
      data: { ...n.data, nodeType: n.type },
      parentNode: n.parentGroupId,
      expandParent: false,
      draggable: true,
      zIndex: 1
    }
  })
})

const flowEdges = computed<Edge[]>(() => {
  const graph = project.current?.canvas
  if (!graph) return []
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    animated: false,
    interactionWidth: 28,
    class: 'pipe-edge',
    style: { stroke: 'rgba(126, 180, 255, 0.42)', strokeWidth: 1.1 }
  }))
})

const selected = computed<CanvasNode | null>(() => {
  const id = selectedId.value
  if (!id || !project.current?.canvas) return null
  return project.current.canvas.nodes.find((n) => n.id === id) ?? null
})
const selectedId = ref<string | null>(null)

onMounted(async () => {
  if (!project.current) {
    toast.warn('请先打开项目')
    router.push('/')
    return
  }
  agentOpen.value = true
  loadAgentWidth()
  if (project.current.pipelineMode === 'img2video') {
    /* 空白画布，右键添加节点 */
  } else if (!project.current.canvas?.nodes.some((n) => n.type === 'groupFrame')) {
    project.setCanvas(rebuildCanvasGraph(project.current, false))
  } else {
    project.setCanvas(rebuildCanvasGraph(project.current, true))
  }
  await assets.refresh()
  document.querySelectorAll('body > input[type="file"]').forEach((el) => el.remove())
  setCanvasReveal((nodeId) => {
    setTimeout(() => {
      if (nodeId) fitView({ nodes: [nodeId], padding: 0.28, duration: 450 })
      else fitView({ padding: 0.2, duration: 400 })
    }, 120)
  })
  setCanvasInspect((nodeId) => {
    selectedId.value = nodeId
    rightOpen.value = true
  })
  setCanvasSelect((nodeId) => {
    selectedId.value = nodeId
  })
  setTimeout(() => fitView({ padding: 0.2 }), 80)
  window.addEventListener('keydown', onDupKey)
  window.addEventListener('resize', clampAgentToViewport)
})

onUnmounted(() => {
  stopAgentResize()
  window.removeEventListener('keydown', onDupKey)
  window.removeEventListener('resize', clampAgentToViewport)
  setCanvasReveal(null)
  setCanvasInspect(null)
  setCanvasSelect(null)
})

onConnect((c: Connection) => {
  if (!project.current?.canvas) return
  const source = project.current.canvas.nodes.find((node) => node.id === c.source)
  const target = project.current.canvas.nodes.find((node) => node.id === c.target)
  if (
    source &&
    target &&
    canvasNodeProducesImage(source) &&
    (target.type === 'imageGen' || target.type === 'videoGen') &&
    !appendCanvasReferenceSource(project.current, target.id, source.id)
  ) {
    toast.warn('参考图数量已达到当前模型上限')
    return
  }
  const id = `e-${c.source}-${c.target}-${c.targetHandle || 'in'}`
  const edges = [
    ...project.current.canvas.edges.filter((e) => e.id !== id),
    {
      id,
      source: c.source,
      target: c.target,
      sourceHandle: c.sourceHandle || undefined,
      targetHandle: c.targetHandle || undefined
    }
  ]
  project.setCanvas({ ...project.current.canvas, edges })
})

onNodeDragStop(({ node }) => {
  if (!project.current?.canvas || !node) return
  if (node.type === 'groupFrame') {
    const nodes = project.current.canvas.nodes.map((n) =>
      n.id === node.id ? { ...n, position: { ...node.position } } : n
    )
    project.setCanvas({ ...project.current.canvas, nodes })
    return
  }
  const stored = project.current.canvas.nodes.find((n) => n.id === node.id)
  const parentId = stored?.parentGroupId
  let position = { ...node.position }
  let parentGroupId = parentId
  if (parentId) {
    const parent = project.current.canvas.nodes.find((n) => n.id === parentId)
    const pw = Number(parent?.data.width) || 0
    const ph = Number(parent?.data.height) || 0
    const cx = node.position.x + NODE_W / 2
    const cy = node.position.y + 48
    const inside = cx >= 0 && cy >= 0 && cx <= pw && cy <= ph
    if (!inside && parent) {
      position = {
        x: parent.position.x + node.position.x,
        y: parent.position.y + node.position.y
      }
      parentGroupId = undefined
    }
  }
  const nodes = project.current.canvas.nodes.map((n) =>
    n.id === node.id ? { ...n, position, parentGroupId } : n
  )
  project.setCanvas({ ...project.current.canvas, nodes })
})

onMoveEnd((ev) => {
  const vp = ev?.flowTransform
  if (!project.current?.canvas || !vp) return
  project.setCanvas({
    ...project.current.canvas,
    viewport: { x: vp.x, y: vp.y, zoom: vp.zoom }
  })
})

function onNodeClick(ev: { node: Node }) {
  if (ev.node.type === 'groupFrame') return
  selectedId.value = ev.node.id
  if (ev.node.type === 'export' || ev.node.type === 'final') rightOpen.value = true
}

function openSettings() {
  router.push('/settings')
}

async function relayout() {
  if (!project.current) return
  if (project.current.pipelineMode === 'img2video') {
    setTimeout(() => fitView({ padding: 0.2 }), 40)
    return
  }
  project.setCanvas(rebuildCanvasGraph(project.current, false))
  setTimeout(() => fitView({ padding: 0.2 }), 40)
}

function eventFromCtx(
  ev: MouseEvent | TouchEvent | { event: MouseEvent | TouchEvent }
): MouseEvent | TouchEvent | null {
  if (ev instanceof MouseEvent || ev instanceof TouchEvent) return ev
  if (ev && typeof ev === 'object' && ev.event) return ev.event
  return null
}

function pointerClient(ev: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if (ev instanceof MouseEvent) return { x: ev.clientX, y: ev.clientY }
  const t = ev.changedTouches[0] || ev.touches[0]
  if (!t) return null
  return { x: t.clientX, y: t.clientY }
}

function canDuplicate(id: string | null | undefined): boolean {
  if (!id) return false
  const n = project.current?.canvas?.nodes.find((x) => x.id === id)
  return n?.type === 'imageGen' || n?.type === 'videoGen'
}

function duplicateNode(id: string | null | undefined) {
  if (!id) {
    toast.warn('请先选中要复制的图片或视频节点')
    return
  }
  const nid = project.duplicateCanvasNode(id)
  closeCtxMenu()
  if (!nid) {
    toast.warn('只能复制图片或视频节点')
    return
  }
  selectedId.value = nid
  toast.success('已复制节点')
}

function onDupKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    duplicateNode(selectedId.value)
  }
}

function openCtxMenu(ev: MouseEvent | NodeMouseEvent) {
  const event = eventFromCtx(ev)
  if (!event) return
  event.preventDefault()
  event.stopPropagation()
  const pt = pointerClient(event)
  if (!pt) return
  const flow = screenToFlowCoordinate({ x: pt.x, y: pt.y })
  const clickedId =
    'node' in ev && ev.node && ev.node.type !== 'groupFrame' ? String(ev.node.id) : undefined
  if (clickedId) selectedId.value = clickedId
  const nodeId = clickedId || selectedId.value || undefined
  const extra = canDuplicate(nodeId) ? 36 : 0
  const w = 188
  const h = 92 + extra
  ctxMenu.value = {
    x: Math.max(8, Math.min(pt.x, window.innerWidth - w - 8)),
    y: Math.max(8, Math.min(pt.y, window.innerHeight - h - 8)),
    flow,
    nodeId
  }
}

function closeCtxMenu() {
  ctxMenu.value = null
}

function addFreeform(type: 'imageGen' | 'videoGen') {
  if (!project.current) return
  const count = (project.current.canvas?.nodes ?? []).filter((n) => n.type === type).length + 1
  const id = `${type}_${Date.now().toString(36)}`
  const sourceId = ctxMenu.value?.nodeId
  const source = sourceId
    ? project.current.canvas?.nodes.find((node) => node.id === sourceId)
    : undefined
  const inheritsSource = canvasNodeProducesImage(source)
  const base = ctxMenu.value?.flow ?? { x: 120, y: 120 }
  const pos = source ? { x: base.x + 140, y: base.y - 50 } : base
  project.addCanvasNode({
    id,
    type,
    position: { x: pos.x, y: pos.y },
    data: {
      label: type === 'imageGen' ? `图片 ${count}` : `视频 ${count}`,
      prompt: '',
      referenceAssetIds: [],
      referenceSourceNodeIds: inheritsSource && sourceId ? [sourceId] : [],
      duration: 8,
      ...(type === 'videoGen' ? { videoModel: 'h3' as const } : {})
    },
    status: 'idle'
  })
  if (inheritsSource && sourceId && project.current.canvas) {
    const edge = {
      id: `e-${sourceId}-${id}-in`,
      source: sourceId,
      target: id,
      sourceHandle: 'out',
      targetHandle: 'in'
    }
    project.setCanvas({
      ...project.current.canvas,
      edges: [...project.current.canvas.edges.filter((item) => item.id !== edge.id), edge]
    })
  }
  selectedId.value = id
  closeCtxMenu()
}

async function openFolder() {
  const dir = project.current?.folderPath
  if (dir && isDesktop()) await desktop().openPath(dir)
}

function goClassic() {
  router.push('/script')
}
</script>

<template>
  <div class="studio">
    <header class="bar">
      <button class="icon-btn" title="返回项目" @click="router.push('/')">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 5 8 12l7 7" />
        </svg>
      </button>
      <strong>{{ project.current?.name || '画布' }}</strong>
      <span class="dim">{{
        isImg2Video ? '一图生视频' : `${project.current?.shots.length || 0} 个分镜`
      }}</span>
      <span v-if="project.current?.folderPath" class="dim path" :title="project.current.folderPath">
        {{ project.current.folderPath }}
      </span>
      <div class="spacer" />
      <button
        class="icon-btn"
        :class="{ on: agentOpen }"
        :title="agentOpen ? '收起对话' : '打开智能体'"
        @click="agentOpen = !agentOpen"
      >
        <svg v-if="agentOpen" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="5" width="7" height="14" rx="1.5" />
          <path d="M14 8h6M14 12h6M14 16h4" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.2V6.5Z" />
        </svg>
      </button>
      <button class="icon-btn" title="重整布局" @click="relayout">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="4" width="7" height="7" rx="1.2" />
          <rect x="13" y="4" width="7" height="7" rx="1.2" />
          <rect x="4" y="13" width="7" height="7" rx="1.2" />
          <path d="M16.5 13.5v6.5M13.5 17h6.5" />
        </svg>
      </button>
      <button v-if="isDesktop()" class="icon-btn" title="打开文件夹" @click="openFolder">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H10l2 2h6.5A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-10Z" />
        </svg>
      </button>
      <button v-if="!isImg2Video" class="icon-btn" title="经典步骤" @click="goClassic">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 7h12M8 12h12M8 17h12" />
          <circle cx="4.5" cy="7" r="1.2" />
          <circle cx="4.5" cy="12" r="1.2" />
          <circle cx="4.5" cy="17" r="1.2" />
        </svg>
      </button>
      <button class="icon-btn" title="设置" @click="openSettings">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 4.5v2.2M12 17.3V19.5M19.5 12h-2.2M6.7 12H4.5M17.3 6.7l-1.6 1.6M8.3 15.7l-1.6 1.6M17.3 17.3l-1.6-1.6M8.3 8.3 6.7 6.7" />
        </svg>
      </button>
      <button
        class="icon-btn"
        :class="{ on: rightOpen }"
        :title="rightOpen ? '收起右侧' : '打开右侧'"
        @click="rightOpen = !rightOpen"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="5" width="16" height="14" rx="1.5" />
          <path d="M15 5v14" />
        </svg>
      </button>
    </header>
    <div class="body">
      <div
        v-if="agentOpen"
        class="agent-shell"
        :class="{ resizing: resizingAgent }"
        :style="{ width: `${agentWidth}px` }"
      >
        <PromptCoach v-if="isImg2Video" :node="selected" />
        <AgentChat v-else />
        <div
          class="agent-resizer"
          role="separator"
          aria-label="调整智能体聊天窗口宽度"
          aria-orientation="vertical"
          :aria-valuemin="AGENT_MIN_WIDTH"
          :aria-valuemax="maxAgentWidth()"
          :aria-valuenow="agentWidth"
          tabindex="0"
          title="左右拖动调整聊天窗口宽度"
          @pointerdown="startAgentResize"
          @keydown.left.prevent="nudgeAgentWidth(-24)"
          @keydown.right.prevent="nudgeAgentWidth(24)"
          @dblclick="agentWidth = 440; persistAgentWidth()"
        />
      </div>
      <div class="flow-wrap">
        <VueFlow
          :nodes="flowNodes"
          :edges="flowEdges"
          :node-types="(nodeTypes as any)"
          :default-viewport="project.current?.canvas?.viewport"
          :min-zoom="0.2"
          :max-zoom="2"
          fit-view-on-init
          @node-click="onNodeClick"
          @pane-context-menu="openCtxMenu"
          @node-context-menu="openCtxMenu"
        >
          <Background :gap="22" color="rgba(255,255,255,0.08)" />
          <Controls position="bottom-left" :show-interactive="false" />
        </VueFlow>
        <div
          v-if="isImg2Video && !(project.current?.canvas?.nodes.length)"
          class="empty-hint"
        >
          在空白处右键，添加图片或视频节点
        </div>
      </div>
      <Teleport to="body">
        <div
          v-if="ctxMenu"
          class="ctx-mask"
          @click="closeCtxMenu"
          @contextmenu.prevent="openCtxMenu"
        />
        <div
          v-if="ctxMenu"
          class="ctx-menu"
          :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }"
          @mousedown.stop
        >
          <button type="button" @mousedown.prevent.stop="addFreeform('imageGen')">
            {{ ctxMenu.nodeId ? '追加生图节点' : '添加生图节点' }}
          </button>
          <button type="button" @mousedown.prevent.stop="addFreeform('videoGen')">
            {{ ctxMenu.nodeId ? '追加视频节点' : '添加视频节点' }}
          </button>
          <button
            v-if="canDuplicate(ctxMenu.nodeId)"
            type="button"
            @mousedown.prevent.stop="duplicateNode(ctxMenu.nodeId)"
          >
            复制节点
          </button>
        </div>
      </Teleport>
      <aside v-if="rightOpen" class="dock">
        <div class="dock-title">节点</div>
        <NodeInspector :node="selected" />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.studio {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-0);
  min-width: 0;
}
.bar {
  height: 46px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-1);
  font-size: 13px;
  min-width: 0;
  -webkit-app-region: drag;
  app-region: drag;
}
.bar .dim {
  color: var(--color-text-4);
  font-size: 11px;
}
.bar .path {
  max-width: 160px;
  min-width: 0;
  flex-shrink: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-2);
  flex-shrink: 0;
  cursor: pointer;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.icon-btn svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.icon-btn:hover {
  background: var(--color-bg-3);
  color: var(--color-text-1);
}
.icon-btn.on {
  background: var(--color-bg-3);
  color: var(--color-accent);
}
.empty-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: var(--color-text-4);
  font-size: 13px;
  letter-spacing: 0.04em;
}
.ctx-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
}
.ctx-menu {
  position: fixed;
  z-index: 9001;
  min-width: 168px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-1);
  box-shadow: var(--shadow-lg);
}
.ctx-menu button {
  display: block;
  width: 100%;
  margin: 0;
  padding: 8px 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-1);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ctx-menu button:hover {
  background: var(--color-fill);
}
.dock {
  width: 300px;
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-1);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.dock-title {
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  font-size: 12px;
  padding: 10px;
  color: var(--color-text-1);
  font-weight: 600;
}
.dock :deep(.insp) {
  width: auto;
  border-left: none;
  flex: 1;
  min-height: 0;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.agent-shell {
  position: relative;
  flex: 0 0 auto;
  min-width: 300px;
  max-width: min(760px, calc(100vw - 360px));
  min-height: 0;
  z-index: 4;
}
.agent-shell :deep(.agent) {
  width: 100%;
  height: 100%;
  border-right: 1px solid var(--color-border);
}
.agent-resizer {
  position: absolute;
  top: 0;
  right: -5px;
  bottom: 0;
  width: 10px;
  z-index: 8;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
.agent-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 2px;
  background: transparent;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}
.agent-resizer:hover::after,
.agent-resizer:focus-visible::after,
.agent-shell.resizing .agent-resizer::after {
  background: var(--color-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 16%, transparent);
}
.flow-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
}
.flow-wrap :deep(.vue-flow) {
  background: var(--color-canvas);
}
.flow-wrap :deep(.vue-flow__controls) {
  display: flex;
  flex-direction: row;
  gap: 2px;
  margin: 12px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-1);
  box-shadow: var(--shadow-md);
}
.flow-wrap :deep(.vue-flow__controls-button) {
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  border-bottom: none;
  border-radius: 8px;
  background: transparent;
  box-sizing: border-box;
}
.flow-wrap :deep(.vue-flow__controls-button svg) {
  max-width: 14px;
  max-height: 14px;
  fill: var(--color-text-2);
}
.flow-wrap :deep(.vue-flow__controls-button:hover) {
  background: var(--color-fill-hover);
}
.flow-wrap :deep(.vue-flow__controls-button:hover svg) {
  fill: var(--color-text-1);
}
.flow-wrap :deep(.vue-flow__controls-button:disabled) {
  opacity: 0.35;
}
.flow-wrap :deep(.vue-flow__node) {
  overflow: visible !important;
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
}
.flow-wrap :deep(.vue-flow__node.selected) {
  z-index: 12 !important;
}
.flow-wrap :deep(.vue-flow__node-groupFrame) {
  overflow: visible !important;
  margin: 0;
  width: auto;
  height: auto;
}
.flow-wrap :deep(.vue-flow__node-subject),
.flow-wrap :deep(.vue-flow__node-subjectProps),
.flow-wrap :deep(.vue-flow__node-scene),
.flow-wrap :deep(.vue-flow__node-sceneProps),
.flow-wrap :deep(.vue-flow__node-shotBoard),
.flow-wrap :deep(.vue-flow__node-shotImage),
.flow-wrap :deep(.vue-flow__node-shotVideo),
.flow-wrap :deep(.vue-flow__node-audio),
.flow-wrap :deep(.vue-flow__node-export),
.flow-wrap :deep(.vue-flow__node-final),
.flow-wrap :deep(.vue-flow__node-imageGen),
.flow-wrap :deep(.vue-flow__node-videoGen) {
  width: auto;
  height: auto;
}
.flow-wrap :deep(.vue-flow__edge-path) {
  stroke: rgba(126, 180, 255, 0.42) !important;
  stroke-width: 1.1 !important;
  transition: stroke 0.16s ease, stroke-width 0.16s ease, filter 0.16s ease;
}
.flow-wrap :deep(.vue-flow__edge.pipe-edge:hover),
.flow-wrap :deep(.vue-flow__edge:hover) {
  z-index: 20;
}
.flow-wrap :deep(.vue-flow__edge:hover .vue-flow__edge-path) {
  stroke: #9cc4ff !important;
  stroke-width: 2.4 !important;
  filter: none;
}
.flow-wrap :deep(.vue-flow__edge .vue-flow__edgeupdater),
.flow-wrap :deep(.vue-flow__edge-interaction) {
  stroke-width: 28px;
  stroke: transparent;
}
.flow-wrap :deep(.vue-flow__connection-line) {
  stroke: rgba(126, 180, 255, 0.55) !important;
  stroke-width: 1.4 !important;
}
</style>
