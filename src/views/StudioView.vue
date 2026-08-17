<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VueFlow, useVueFlow, type Connection, type Edge, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { rebuildCanvasGraph } from '@/services/canvas/layout'
import { setCanvasReveal } from '@/services/canvas/canvasBridge'
import { isDesktop, desktop } from '@/services/desktop'
import PipelineNode from '@/components/canvas/PipelineNode.vue'
import ScriptDocNode from '@/components/canvas/ScriptDocNode.vue'
import GroupFrame from '@/components/canvas/GroupFrame.vue'
import AgentChat from '@/components/canvas/AgentChat.vue'
import NodeInspector from '@/components/canvas/NodeInspector.vue'
import StudioSettings from '@/components/canvas/StudioSettings.vue'
import type { CanvasNode } from '@/types'

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const router = useRouter()
const agentOpen = ref(true)
const rightOpen = ref(true)
const rightTab = ref<'node' | 'ai'>('ai')

const nodeTypes = {
  script: ScriptDocNode,
  subject: PipelineNode,
  scene: PipelineNode,
  shotImage: PipelineNode,
  shotVideo: PipelineNode,
  audio: PipelineNode,
  export: PipelineNode,
  groupFrame: GroupFrame
}

const { onConnect, onNodeDragStop, onMoveEnd, fitView } = useVueFlow()

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
        zIndex: -1
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
      extent: n.parentGroupId ? ('parent' as const) : undefined,
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
    style: { stroke: '#7c3aed', strokeWidth: 1.4 }
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
  if (!project.current.canvas?.nodes.some((n) => n.type === 'groupFrame')) {
    project.setCanvas(rebuildCanvasGraph(project.current, false))
  } else {
    project.setCanvas(rebuildCanvasGraph(project.current, true))
  }
  await assets.refresh()
  setCanvasReveal((nodeId) => {
    setTimeout(() => {
      if (nodeId) fitView({ nodes: [nodeId], padding: 0.28, duration: 450 })
      else fitView({ padding: 0.2, duration: 400 })
    }, 120)
  })
  setTimeout(() => fitView({ padding: 0.2 }), 80)
})

onUnmounted(() => setCanvasReveal(null))

onConnect((c: Connection) => {
  if (!project.current?.canvas) return
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
  const nodes = project.current.canvas.nodes.map((n) =>
    n.id === node.id ? { ...n, position: { ...node.position } } : n
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
  rightOpen.value = true
  rightTab.value = 'node'
}

function openSettings() {
  rightOpen.value = true
  rightTab.value = 'ai'
}

async function relayout() {
  if (!project.current) return
  project.setCanvas(rebuildCanvasGraph(project.current, false))
  setTimeout(() => fitView({ padding: 0.2 }), 40)
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
      <button class="bar-btn" @click="router.push('/')">← 项目</button>
      <strong>{{ project.current?.name || '画布' }}</strong>
      <span class="dim">{{ project.current?.shots.length || 0 }} 个分镜</span>
      <span v-if="project.current?.folderPath" class="dim path" :title="project.current.folderPath">
        {{ project.current.folderPath }}
      </span>
      <div class="spacer" />
      <button class="bar-btn" @click="agentOpen = !agentOpen">{{ agentOpen ? '收起对话' : '智能体' }}</button>
      <button class="bar-btn" @click="relayout">重整布局</button>
      <button v-if="isDesktop()" class="bar-btn" @click="openFolder">打开文件夹</button>
      <button class="bar-btn" @click="goClassic">经典步骤</button>
      <button class="bar-btn" :class="{ on: rightOpen && rightTab === 'ai' }" @click="openSettings">设置</button>
      <button class="bar-btn" @click="rightOpen = !rightOpen">{{ rightOpen ? '收起右侧' : '右侧' }}</button>
    </header>
    <div class="body">
      <AgentChat v-if="agentOpen" />
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
        >
          <Background :gap="22" color="rgba(255,255,255,0.06)" />
          <Controls position="bottom-left" :show-interactive="false" />
        </VueFlow>
      </div>
      <aside v-if="rightOpen" class="dock">
        <div class="dock-tabs">
          <button :class="{ on: rightTab === 'ai' }" @click="rightTab = 'ai'">模型</button>
          <button :class="{ on: rightTab === 'node' }" @click="rightTab = 'node'">节点</button>
        </div>
        <StudioSettings v-show="rightTab === 'ai'" />
        <NodeInspector v-show="rightTab === 'node'" :node="selected" />
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
.bar-btn {
  font-size: 12px;
  color: var(--color-text-2);
  padding: 4px 8px;
  border-radius: 6px;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.bar-btn:hover {
  background: var(--color-bg-3);
}
.bar-btn.on {
  background: var(--color-bg-3);
  color: var(--color-text-1);
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
.dock-tabs {
  display: flex;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.dock-tabs button {
  flex: 1;
  font-size: 12px;
  padding: 10px;
  color: var(--color-text-3);
}
.dock-tabs button.on {
  color: var(--color-text-1);
  box-shadow: inset 0 -2px 0 var(--color-accent);
}
.dock :deep(.insp) {
  width: auto;
  border-left: none;
  flex: 1;
  min-height: 0;
}
.dock :deep(.panel) {
  width: auto;
  flex: 1;
  min-height: 0;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.flow-wrap {
  flex: 1;
  min-width: 0;
}
.flow-wrap :deep(.vue-flow) {
  background: radial-gradient(ellipse at top, rgba(124, 58, 237, 0.08), transparent 50%), #0a0a14;
}
.flow-wrap :deep(.vue-flow__controls) {
  display: flex;
  flex-direction: row;
  gap: 2px;
  margin: 12px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(18, 18, 31, 0.9);
  backdrop-filter: blur(12px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
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
  background: rgba(124, 58, 237, 0.32);
}
.flow-wrap :deep(.vue-flow__controls-button:hover svg) {
  fill: #fff;
}
.flow-wrap :deep(.vue-flow__controls-button:disabled) {
  opacity: 0.35;
}
.flow-wrap :deep(.vue-flow__node-groupFrame) {
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  width: auto;
  height: auto;
}
.flow-wrap :deep(.vue-flow__node-script) {
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
}
.flow-wrap :deep(.vue-flow__node-subject),
.flow-wrap :deep(.vue-flow__node-scene),
.flow-wrap :deep(.vue-flow__node-shotImage),
.flow-wrap :deep(.vue-flow__node-shotVideo),
.flow-wrap :deep(.vue-flow__node-audio),
.flow-wrap :deep(.vue-flow__node-export) {
  padding: 0;
  background: transparent;
  border: none;
  box-shadow: none;
  width: auto;
  height: auto;
}
</style>
