<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { VueFlow, useVueFlow, type Connection, type Edge, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { rebuildCanvasGraph } from '@/services/canvas/layout'
import { isDesktop, desktop } from '@/services/desktop'
import PipelineNode from '@/components/canvas/PipelineNode.vue'
import AgentChat from '@/components/canvas/AgentChat.vue'
import NodeInspector from '@/components/canvas/NodeInspector.vue'
import type { CanvasNode } from '@/types'

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const router = useRouter()
const agentOpen = ref(true)
const inspectorOpen = ref(true)

const nodeTypes = {
  script: PipelineNode,
  subject: PipelineNode,
  scene: PipelineNode,
  shotImage: PipelineNode,
  shotVideo: PipelineNode,
  audio: PipelineNode,
  export: PipelineNode
}

const { onConnect, onNodeDragStop, onMoveEnd, fitView } = useVueFlow()

const flowNodes = computed<Node[]>(() => {
  const graph = project.current?.canvas
  if (!graph) return []
  return graph.nodes
    .filter((n) => n.type !== 'groupFrame')
    .map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: { ...n.data, nodeType: n.type },
      draggable: true
    }))
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
  if (!project.current.canvas?.nodes.length) {
    project.setCanvas(rebuildCanvasGraph(project.current, false))
  }
  await assets.refresh()
  setTimeout(() => fitView({ padding: 0.2 }), 80)
})

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
  selectedId.value = ev.node.id
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
      <button class="bar-btn" @click="inspectorOpen = !inspectorOpen">{{ inspectorOpen ? '收起详情' : '详情' }}</button>
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
          <Controls />
          <MiniMap pannable zoomable />
        </VueFlow>
      </div>
      <NodeInspector v-if="inspectorOpen" :node="selected" />
    </div>
  </div>
</template>

<style scoped>
.studio {
  height: 100vh;
  width: 100vw;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-0);
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
}
.bar .dim {
  color: var(--color-text-4);
  font-size: 11px;
}
.bar .path {
  max-width: 280px;
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
}
.bar-btn:hover {
  background: var(--color-bg-3);
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
</style>
