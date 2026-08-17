import type { CanvasEdge, CanvasGraph, CanvasNode, Project } from '@/types'
import { emptyCanvas } from '@/types/canvas'

const COL = {
  scriptX: 40,
  castX: 40,
  imageX: 420,
  videoX: 780,
  exportX: 1160
}

function pos(prev: Map<string, CanvasNode>, id: string, fallback: { x: number; y: number }) {
  const old = prev.get(id)
  return old?.position ?? fallback
}

export function rebuildCanvasGraph(project: Project, preservePositions = true): CanvasGraph {
  const prev = new Map((preservePositions ? project.canvas?.nodes ?? [] : []).map((n) => [n.id, n]))
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const groups = [
    { id: 'group-cast', label: '主体与场景', nodeIds: [] as string[] },
    { id: 'group-images', label: '分镜配图', nodeIds: [] as string[] },
    { id: 'group-videos', label: '短剧视频片段', nodeIds: [] as string[] },
    { id: 'group-output', label: '成片输出', nodeIds: [] as string[] }
  ]

  nodes.push({
    id: 'script',
    type: 'script',
    position: pos(prev, 'script', { x: COL.scriptX, y: 40 }),
    data: { label: project.script?.topic || project.name || '文案' },
    status: prev.get('script')?.status ?? 'idle'
  })

  const subjects = project.subjects ?? []
  const scenes = project.scenes ?? []
  subjects.forEach((s, i) => {
    const id = `subject:${s.id}`
    nodes.push({
      id,
      type: 'subject',
      position: pos(prev, id, { x: COL.castX, y: 220 + i * 210 }),
      data: { subjectId: s.id, label: s.name },
      status: prev.get(id)?.status ?? (s.designSheetAssetId ? 'success' : 'idle')
    })
    groups[0].nodeIds.push(id)
    edges.push({
      id: `e-script-${id}`,
      source: 'script',
      target: id,
      sourceHandle: 'out',
      targetHandle: 'in'
    })
  })
  scenes.forEach((s, i) => {
    const id = `scene:${s.id}`
    nodes.push({
      id,
      type: 'scene',
      position: pos(prev, id, { x: COL.castX, y: 220 + (subjects.length + i) * 210 }),
      data: { sceneId: s.id, label: s.name },
      status: prev.get(id)?.status ?? (s.plateAssetId ? 'success' : 'idle')
    })
    groups[0].nodeIds.push(id)
    edges.push({
      id: `e-script-${id}`,
      source: 'script',
      target: id,
      sourceHandle: 'out',
      targetHandle: 'in'
    })
  })

  project.shots.forEach((shot, i) => {
    const imgId = `shotImage:${shot.id}`
    const vidId = `shotVideo:${shot.id}`
    const audId = `audio:${shot.id}`
    const y = 40 + i * 230
    nodes.push({
      id: imgId,
      type: 'shotImage',
      position: pos(prev, imgId, { x: COL.imageX, y }),
      data: { shotId: shot.id, label: `${i + 1}. ${shot.title}` },
      status: prev.get(imgId)?.status ?? (shot.imageAssetId ? 'success' : 'idle')
    })
    nodes.push({
      id: vidId,
      type: 'shotVideo',
      position: pos(prev, vidId, { x: COL.videoX, y }),
      data: { shotId: shot.id, label: `${i + 1}. ${shot.title}` },
      status: prev.get(vidId)?.status ?? (shot.videoAssetId ? 'success' : 'idle')
    })
    nodes.push({
      id: audId,
      type: 'audio',
      position: pos(prev, audId, { x: COL.videoX + 20, y: y + 150 }),
      data: { shotId: shot.id, label: '口播' },
      status: prev.get(audId)?.status ?? (shot.audioAssetId ? 'success' : 'idle')
    })
    groups[1].nodeIds.push(imgId)
    groups[2].nodeIds.push(vidId, audId)

    const wanted = (shot.subjectIds?.length ? shot.subjectIds : subjects.map((s) => s.id)).slice(0, 2)
    wanted.forEach((sid, idx) => {
      const src = `subject:${sid}`
      if (!nodes.some((n) => n.id === src)) return
      edges.push({
        id: `e-${src}-${imgId}-${idx}`,
        source: src,
        target: imgId,
        sourceHandle: 'out',
        targetHandle: idx === 0 ? 'char1' : 'char2'
      })
    })
    const sceneId = shot.sceneId || scenes[0]?.id
    if (sceneId) {
      edges.push({
        id: `e-scene-${sceneId}-${imgId}`,
        source: `scene:${sceneId}`,
        target: imgId,
        sourceHandle: 'out',
        targetHandle: 'scene'
      })
    }
    edges.push({
      id: `e-${imgId}-${vidId}`,
      source: imgId,
      target: vidId,
      sourceHandle: 'out',
      targetHandle: 'image'
    })
    edges.push({
      id: `e-${audId}-export`,
      source: audId,
      target: 'export',
      sourceHandle: 'out',
      targetHandle: 'in'
    })
    edges.push({
      id: `e-${vidId}-export`,
      source: vidId,
      target: 'export',
      sourceHandle: 'out',
      targetHandle: 'in'
    })
  })

  nodes.push({
    id: 'export',
    type: 'export',
    position: pos(prev, 'export', { x: COL.exportX, y: 80 }),
    data: { label: '成片导出' },
    status: prev.get('export')?.status ?? 'idle'
  })
  groups[3].nodeIds.push('export')

  const viewport = project.canvas?.viewport ?? emptyCanvas().viewport
  return { nodes, edges, groups, viewport }
}

export function nodeByEntity(graph: CanvasGraph, type: CanvasNode['type'], entityId: string) {
  return graph.nodes.find((n) => {
    if (n.type !== type) return false
    if (type === 'subject') return n.data.subjectId === entityId
    if (type === 'scene') return n.data.sceneId === entityId
    return n.data.shotId === entityId
  })
}
