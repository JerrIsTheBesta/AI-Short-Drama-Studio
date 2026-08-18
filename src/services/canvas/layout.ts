import type { CanvasEdge, CanvasGraph, CanvasNode, Project } from '@/types'
import { emptyCanvas } from '@/types/canvas'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'

export const NODE_W = 240
const GAP = 14
const PAD = 16
const HEAD = 44
const COL_GAP = 32
const SCRIPT_W = 460
const SCRIPT_H = 720
/** 画面下方名称条高度 */
const NODE_CHROME = 36
/** 口播节点是独立卡片，不跟分镜画面同一套比例 */
export const AUDIO_NODE_H = 128

function aspectValue(ar?: string): number {
  const [a, b] = String(ar || '16:9').split(':').map(Number)
  if (!a || !b) return 16 / 9
  return a / b
}

/** 画布节点高度：画面区跟片比例走，避免竖屏被裁成横条 */
export function pipelineNodeHeight(aspectRatio?: string): number {
  return NODE_CHROME + Math.round(NODE_W / aspectValue(aspectRatio))
}

/** CSS aspect-ratio，如 16 / 9 */
export function cssAspectRatio(ar?: string): string {
  const [a, b] = String(ar || '16:9').split(':')
  const w = Number(a)
  const h = Number(b)
  if (!w || !h) return '16 / 9'
  return `${w} / ${h}`
}

function groupBox(rows: number, cols: number, nodeH: number) {
  const r = Math.max(1, rows)
  const c = Math.max(1, cols)
  return {
    width: PAD * 2 + c * NODE_W + (c - 1) * GAP,
    height: HEAD + PAD + r * nodeH + Math.max(0, r - 1) * GAP + PAD
  }
}

function cell(row: number, col: number, nodeH: number) {
  return {
    x: PAD + col * (NODE_W + GAP),
    y: HEAD + PAD + row * (nodeH + GAP)
  }
}

function persistStatus(
  prevStatus: CanvasNode['status'] | undefined,
  hasAsset: boolean
): CanvasNode['status'] {
  // 进程退出后磁盘上的 running 是脏状态，不能再当「生成中」
  if (!prevStatus || prevStatus === 'running' || prevStatus === 'pending') {
    return hasAsset ? 'success' : 'idle'
  }
  return prevStatus
}

function pos(
  prev: Map<string, CanvasNode>,
  id: string,
  fallback: { x: number; y: number }
) {
  return prev.get(id)?.position ?? fallback
}

export function rebuildCanvasGraph(project: Project, preservePositions = true): CanvasGraph {
  const prevList = project.canvas?.nodes ?? []
  const hadGroups = prevList.some((n) => n.type === 'groupFrame')
  const layoutReady = hadGroups && prevList.some((n) => n.id === 'group-audio')
  const prev = new Map((preservePositions && layoutReady ? prevList : []).map((n) => [n.id, n]))
  const prevAny = new Map(prevList.map((n) => [n.id, n]))
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const groups: CanvasGraph['groups'] = []

  const subjects = project.subjects ?? []
  const scenes = project.scenes ?? []
  const shots = project.shots
  const shotH = pipelineNodeHeight(project.settings?.aspectRatio)
  const sheetH = pipelineNodeHeight('16:9')

  const prevScript = prevAny.get('script')
  const scriptW = prevScript?.data.width || SCRIPT_W
  const scriptH = prevScript?.data.height || SCRIPT_H
  const scriptPos =
    prevScript && !prevScript.parentGroupId
      ? prevScript.position
      : { x: 24, y: 24 }

  nodes.push({
    id: 'script',
    type: 'script',
    position: scriptPos,
    data: {
      label: project.script?.topic || project.name || '剧本',
      width: scriptW,
      height: scriptH,
      kind: 'scriptDoc'
    },
    status: persistStatus(prevScript?.status, Boolean(project.script?.content))
  })

  const subBox = groupBox(subjects.length, 1, sheetH)
  const scnBox = groupBox(scenes.length, 1, shotH)
  const shotBox = groupBox(shots.length, 2, shotH)
  const audBox = groupBox(shots.length, 1, AUDIO_NODE_H)
  const expBox = groupBox(1, 2, shotH)

  let x = 24 + scriptW + COL_GAP
  const y = 24

  function pushGroup(
    id: string,
    label: string,
    kind: string,
    box: { width: number; height: number }
  ) {
    nodes.push({
      id,
      type: 'groupFrame',
      position: pos(prev, id, { x, y }),
      data: { label, width: box.width, height: box.height, kind },
      status: 'idle'
    })
    groups.push({ id, label, nodeIds: [] })
    x += box.width + COL_GAP
  }

  pushGroup('group-subjects', '人物角色', 'subject', subBox)
  pushGroup('group-scenes', '场景', 'scene', scnBox)
  pushGroup('group-shots', '分镜', 'shot', shotBox)
  pushGroup('group-audio', '口播', 'audio', audBox)
  pushGroup('group-export', '成片', 'export', expBox)

  function attach(groupId: string, node: CanvasNode) {
    node.parentGroupId = groupId
    nodes.push(node)
    const g = groups.find((x) => x.id === groupId)
    g?.nodeIds.push(node.id)
  }

  subjects.forEach((s, i) => {
    const id = `subject:${s.id}`
    attach('group-subjects', {
      id,
      type: 'subject',
      position: cell(i, 0, sheetH),
      data: { subjectId: s.id, label: s.name },
      status: persistStatus(prev.get(id)?.status, Boolean(s.designSheetAssetId)),
      parentGroupId: 'group-subjects'
    })
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
    attach('group-scenes', {
      id,
      type: 'scene',
      position: cell(i, 0, shotH),
      data: { sceneId: s.id, label: s.name },
      status: persistStatus(prev.get(id)?.status, Boolean(s.plateAssetId)),
      parentGroupId: 'group-scenes'
    })
    edges.push({
      id: `e-script-${id}`,
      source: 'script',
      target: id,
      sourceHandle: 'out',
      targetHandle: 'in'
    })
  })

  shots.forEach((shot, i) => {
    const imgId = `shotImage:${shot.id}`
    const vidId = `shotVideo:${shot.id}`
    const audId = `audio:${shot.id}`
    attach('group-shots', {
      id: imgId,
      type: 'shotImage',
      position: cell(i, 0, shotH),
      data: { shotId: shot.id, label: `${i + 1}. ${shot.title}` },
      status: persistStatus(prev.get(imgId)?.status, Boolean(shot.imageAssetId)),
      parentGroupId: 'group-shots'
    })
    attach('group-shots', {
      id: vidId,
      type: 'shotVideo',
      position: cell(i, 1, shotH),
      data: { shotId: shot.id, label: `${i + 1}. ${shot.title}` },
      status: persistStatus(prev.get(vidId)?.status, Boolean(shot.videoAssetId)),
      parentGroupId: 'group-shots'
    })
    attach('group-audio', {
      id: audId,
      type: 'audio',
      position: cell(i, 0, AUDIO_NODE_H),
      data: {
        shotId: shot.id,
        label: needsExternalTts(shot) ? '后期 TTS' : effectiveShotAudioMode(shot).startsWith('h3-') ? 'H3 人声' : '无口播'
      },
      status: persistStatus(
        prev.get(audId)?.status,
        Boolean(shot.audioAssetId) || !needsExternalTts(shot)
      ),
      parentGroupId: 'group-audio'
    })

    const wanted = (shot.subjectIds?.length ? shot.subjectIds : subjects.map((s) => s.id)).slice(
      0,
      2
    )
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

  const hasFinal = Boolean(project.finalVideoAssetId)
  attach('group-export', {
    id: 'export',
    type: 'export',
    position: cell(0, 0, shotH),
    data: { label: '合成成片' },
    status: persistStatus(prev.get('export')?.status, hasFinal),
    parentGroupId: 'group-export'
  })
  attach('group-export', {
    id: 'final',
    type: 'final',
    position: cell(0, 1, shotH),
    data: { label: '成片结果' },
    status: persistStatus(prev.get('final')?.status, hasFinal),
    parentGroupId: 'group-export'
  })
  edges.push({
    id: 'e-export-final',
    source: 'export',
    target: 'final',
    sourceHandle: 'out',
    targetHandle: 'in'
  })

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
