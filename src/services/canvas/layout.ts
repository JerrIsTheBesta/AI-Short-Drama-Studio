import type { CanvasEdge, CanvasGraph, CanvasNode, Project } from '@/types'
import { emptyCanvas, normalizeVideoGenModel, stillModeForVideoModel, videoStillNeedsCanvas } from '@/types/canvas'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'
import { boundSubjectIds } from '@/utils/consistency'
import { stillModeFromNode, stillTypeForMode } from '@/utils/videoStill'
import { useSettingsStore } from '@/stores/settings'

export const NODE_W = 240
const GAP = 18
const PAD = 20
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

function fallbackStillMode() {
  try {
    return stillModeForVideoModel('h3', useSettingsStore().config.video)
  } catch {
    return 'identity' as const
  }
}

function activeVideoProfile() {
  try {
    return useSettingsStore().config.video
  } catch {
    return undefined
  }
}

function pos(
  prev: Map<string, CanvasNode>,
  id: string,
  fallback: { x: number; y: number }
) {
  return prev.get(id)?.position ?? fallback
}

/** 分组内节点存的是相对坐标，追加自由节点必须用画布绝对坐标，否则会落到视野外。 */
export function absoluteCanvasPosition(
  nodes: CanvasNode[],
  node: Pick<CanvasNode, 'position' | 'parentGroupId'>
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let pid = node.parentGroupId
  const byId = new Map(nodes.map((item) => [item.id, item]))
  const seen = new Set<string>()
  while (pid && !seen.has(pid)) {
    seen.add(pid)
    const parent = byId.get(pid)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    pid = parent.parentGroupId
  }
  return { x, y }
}

export function nextFreeformPosition(
  nodes: CanvasNode[],
  opts: {
    source?: CanvasNode
    click?: { x: number; y: number }
  }
): { x: number; y: number } {
  let pos: { x: number; y: number }
  if (opts.source) {
    const abs = absoluteCanvasPosition(nodes, opts.source)
    pos = { x: abs.x + NODE_W + 48, y: abs.y }
  } else if (opts.click && Number.isFinite(opts.click.x) && Number.isFinite(opts.click.y)) {
    pos = { x: opts.click.x, y: opts.click.y }
  } else {
    const groups = nodes.filter((n) => n.type === 'groupFrame')
    if (groups.length) {
      const right = Math.max(
        ...groups.map((g) => g.position.x + (Number(g.data.width) || NODE_W))
      )
      pos = { x: right + 48, y: groups[0].position.y + 48 }
    } else {
      pos = { x: 120, y: 120 }
    }
  }
  const taken = nodes.filter((n) => n.type === 'imageGen' || n.type === 'videoGen')
  let guard = 0
  while (
    guard < 24 &&
    taken.some(
      (n) => Math.abs(n.position.x - pos.x) < 36 && Math.abs(n.position.y - pos.y) < 36
    )
  ) {
    pos = { x: pos.x + 36, y: pos.y + 36 }
    guard += 1
  }
  return pos
}

/** 误用分组相对坐标时，节点会堆在画布左上角。拉回分镜视频组右侧。 */
export function rescueStrandedFreeformNodes(nodes: CanvasNode[]): CanvasNode[] | null {
  const groups = nodes.filter((n) => n.type === 'groupFrame')
  const free = nodes.filter(
    (n) => (n.type === 'imageGen' || n.type === 'videoGen') && !n.parentGroupId
  )
  if (!free.length) return null
  const videos = groups.find((g) => g.id === 'group-videos') || groups[groups.length - 1]
  const clusterX = videos ? videos.position.x : Math.max(...groups.map((g) => g.position.x), 0)
  const clusterY = videos ? videos.position.y : Math.min(...groups.map((g) => g.position.y), 0)
  const clusterW = videos ? Number(videos.data.width) || NODE_W : NODE_W
  const stranded = free.filter((n) => {
    if (!groups.length) return false
    return n.position.x + NODE_W < clusterX - 80
  })
  if (!stranded.length) return null
  const startX = clusterX + clusterW + 48
  const startY = clusterY + 48
  const ids = new Set(stranded.map((n) => n.id))
  return nodes.map((n) => {
    if (!ids.has(n.id)) return n
    const i = stranded.findIndex((item) => item.id === n.id)
    return {
      ...n,
      parentGroupId: undefined,
      position: {
        x: startX + (i % 3) * (NODE_W + 36),
        y: startY + Math.floor(i / 3) * 220
      }
    }
  })
}

export function rebuildCanvasGraph(project: Project, preservePositions = true): CanvasGraph {
  const freeform = project.pipelineMode === 'img2video'
  const prevList = project.canvas?.nodes ?? []
  const subjects = project.subjects ?? []
  const scenes = project.scenes ?? []
  const shots = project.shots
  const hasPipelineData = subjects.length > 0 || scenes.length > 0 || shots.length > 0
  const hasScriptNode = prevList.some((n) => n.id === 'script' || n.type === 'script')
  if (freeform && !hasPipelineData && !hasScriptNode) {
    return project.canvas ?? emptyCanvas()
  }
  const hadGroups = prevList.some((n) => n.type === 'groupFrame')
  const shotVideoPrev = prevList.filter((n) => n.type === 'shotVideo')
  const defaultStill = fallbackStillMode()
  const useStills = shotVideoPrev.length
    ? shotVideoPrev.some((n) => videoStillNeedsCanvas(stillModeFromNode(n)))
    : videoStillNeedsCanvas(defaultStill)
  const stillGroupLabel = shotVideoPrev.some((n) => stillModeFromNode(n) === 'storyboard')
    ? '故事看板'
    : '分镜关键帧'
  const videosHomed =
    shots.length === 0 ||
    !prevList.some((n) => n.type === 'shotVideo') ||
    prevList
      .filter((n) => n.type === 'shotVideo')
      .every((n) => n.parentGroupId === 'group-videos')
  const layoutReady = freeform
    ? shots.length === 0 || (prevList.some((n) => n.id === 'group-videos') && videosHomed)
    : hadGroups &&
      prevList.some((n) => n.id === 'group-audio') &&
      prevList.some((n) => n.id === 'group-videos') &&
      videosHomed &&
      (shots.length === 0 ||
        !useStills ||
        prevList.some((n) => n.type === 'shotBoard' || n.type === 'shotImage'))
  const prev = new Map((preservePositions && layoutReady ? prevList : []).map((n) => [n.id, n]))
  const prevAny = new Map(prevList.map((n) => [n.id, n]))
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const groups: CanvasGraph['groups'] = []
  const shotH = pipelineNodeHeight(project.settings?.aspectRatio)
  const sheetH = pipelineNodeHeight('16:9')

  const prevScript = prevAny.get('script')
  const scriptW = prevScript?.data.width || SCRIPT_W
  const scriptH = prevScript?.data.height || SCRIPT_H
  const keepScript = !freeform || hasScriptNode
  const scriptPos =
    prevScript && !prevScript.parentGroupId
      ? prevScript.position
      : { x: 24, y: 24 }

  if (keepScript) {
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
  }

  const subBox = groupBox(subjects.length, 1, sheetH)
  const scnBox = groupBox(scenes.length, 1, sheetH)
  const shotBox = groupBox(shots.length, 1, shotH)
  const vidBox = groupBox(shots.length, 1, shotH)
  const audBox = groupBox(shots.length, 1, AUDIO_NODE_H)
  const expBox = groupBox(1, 2, shotH)

  let x = (keepScript ? scriptPos.x + scriptW : 24) + COL_GAP
  const y = keepScript ? scriptPos.y : 24

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

  if (!freeform || subjects.length) pushGroup('group-subjects', '人物角色', 'subject', subBox)
  if (!freeform || scenes.length) pushGroup('group-scenes', '场景锚点', 'scene', scnBox)
  if ((!freeform || shots.length) && useStills) {
    pushGroup('group-shots', stillGroupLabel, 'shot', shotBox)
  }
  if (!freeform || shots.length) {
    pushGroup('group-videos', '分镜视频', 'video', vidBox)
  }
  if (!freeform) {
    pushGroup('group-audio', '口播', 'audio', audBox)
    pushGroup('group-export', '合成视频', 'export', expBox)
  }

  function attach(groupId: string, node: CanvasNode) {
    if (!nodes.some((item) => item.id === groupId)) return
    const old = prevAny.get(node.id)
    const sameParent = old?.parentGroupId === groupId
    if (
      preservePositions &&
      sameParent === false &&
      old &&
      old.parentGroupId === undefined &&
      node.type !== 'shotVideo' &&
      prevList.some((n) => n.id === node.id)
    ) {
      nodes.push({ ...node, position: old.position, parentGroupId: undefined })
      return
    }
    node.parentGroupId = groupId
    // 换组后不能沿用旧组里的相对坐标，否则会落到框外（例如从分镜第 2 列迁到分镜视频）
    node.position = sameParent ? pos(prev, node.id, node.position) : node.position
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
    if (keepScript) {
      edges.push({
        id: `e-script-${id}`,
        source: 'script',
        target: id,
        sourceHandle: 'out',
        targetHandle: 'in'
      })
    }
  })

  scenes.forEach((s, i) => {
    const id = `scene:${s.id}`
    attach('group-scenes', {
      id,
      type: 'scene',
      position: cell(i, 0, sheetH),
      data: { sceneId: s.id, label: s.name },
      status: persistStatus(prev.get(id)?.status, Boolean(s.plateAssetId)),
      parentGroupId: 'group-scenes'
    })
    if (keepScript) {
      edges.push({
        id: `e-script-${id}`,
        source: 'script',
        target: id,
        sourceHandle: 'out',
        targetHandle: 'in'
      })
    }
  })

  shots.forEach((shot, i) => {
    const vidId = `shotVideo:${shot.id}`
    const audId = `audio:${shot.id}`
    const prevVid = prev.get(vidId) || prevAny.get(vidId)
    const model = normalizeVideoGenModel(prevVid?.data.videoModel)
    const resolvedStill =
      prevVid?.data.videoStillMode === 'identity' ||
      prevVid?.data.videoStillMode === 'keyframe' ||
      prevVid?.data.videoStillMode === 'storyboard'
        ? prevVid.data.videoStillMode
        : stillModeForVideoModel(model, activeVideoProfile())
    const stillType = stillTypeForMode(resolvedStill)
    const stillId = stillType ? `${stillType}:${shot.id}` : ''
    if (stillType && stillId) {
      const prevStillNode = prev.get(stillId) || prevAny.get(stillId)
      attach('group-shots', {
        id: stillId,
        type: stillType,
        position: cell(i, 0, shotH),
        data: {
          shotId: shot.id,
          label: `${i + 1}. ${shot.title}`,
          aspectRatio: prevStillNode?.data.aspectRatio ?? project.settings.aspectRatio
        },
        status: persistStatus(
          prev.get(stillId)?.status,
          Boolean(stillType === 'shotBoard' ? shot.boardAssetId : shot.imageAssetId)
        ),
        parentGroupId: 'group-shots'
      })
    }
    attach('group-videos', {
      id: vidId,
      type: 'shotVideo',
      position: cell(i, 0, shotH),
      data: {
        shotId: shot.id,
        label: `${i + 1}. ${shot.title}`,
        videoModel: prevVid?.data.videoModel,
        videoResolution: prevVid?.data.videoResolution,
        videoStillMode: resolvedStill,
        aspectRatio: prevVid?.data.aspectRatio ?? project.settings.aspectRatio
      },
      status: persistStatus(prevVid?.status, Boolean(shot.videoAssetId)),
      parentGroupId: 'group-videos'
    })
    if (!freeform) {
      attach('group-audio', {
        id: audId,
        type: 'audio',
        position: cell(i, 0, AUDIO_NODE_H),
        data: {
          shotId: shot.id,
          label: needsExternalTts(shot, project) ? '后期 TTS' : effectiveShotAudioMode(shot).startsWith('h3-') ? 'H3 人声' : '无口播'
        },
        status: persistStatus(
          prev.get(audId)?.status,
          Boolean(shot.audioAssetId) || !needsExternalTts(shot, project)
        ),
        parentGroupId: 'group-audio'
      })
    }

    const visualTarget = stillType && stillId ? stillId : vidId
    const wanted = boundSubjectIds(shot, subjects).slice(0, 2)
    wanted.forEach((sid, idx) => {
      const src = `subject:${sid}`
      if (!nodes.some((n) => n.id === src)) return
      edges.push({
        id: `e-${src}-${visualTarget}-${idx}`,
        source: src,
        target: visualTarget,
        sourceHandle: 'out',
        targetHandle: stillType ? (idx === 0 ? 'char1' : 'char2') : 'in'
      })
    })
    const sceneId = shot.sceneId || scenes[0]?.id
    if (sceneId) {
      edges.push({
        id: `e-scene-${sceneId}-${visualTarget}`,
        source: `scene:${sceneId}`,
        target: visualTarget,
        sourceHandle: 'out',
        targetHandle: stillType ? 'scene' : 'in'
      })
    }
    if (stillType && stillId) {
      edges.push({
        id: `e-${stillId}-${vidId}`,
        source: stillId,
        target: vidId,
        sourceHandle: 'out',
        targetHandle: 'image'
      })
    }
    if (!freeform) {
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
    }
  })

  if (!freeform) {
    const hasFinal = Boolean(project.finalVideoAssetId)
    attach('group-export', {
      id: 'export',
      type: 'export',
      position: cell(0, 0, shotH),
      data: { label: '合成视频' },
      status: persistStatus(prev.get('export')?.status, hasFinal),
      parentGroupId: 'group-export'
    })
    attach('group-export', {
      id: 'final',
      type: 'final',
      position: cell(0, 1, shotH),
      data: { label: '视频预览' },
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
  }

  // 固定流程是模板层；用户追加的自由生图/视频节点属于创作层，重整布局时不能覆盖。
  const freeNodes = prevList.filter((node) => node.type === 'imageGen' || node.type === 'videoGen')
  const freeIds = new Set(freeNodes.map((node) => node.id))
  for (const node of freeNodes) {
    if (!nodes.some((item) => item.id === node.id)) nodes.push({ ...node, parentGroupId: undefined })
  }
  const nodeIds = new Set(nodes.map((node) => node.id))
  for (const edge of project.canvas?.edges ?? []) {
    if (!freeIds.has(edge.source) && !freeIds.has(edge.target)) continue
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    if (!edges.some((item) => item.id === edge.id)) edges.push(edge)
  }

  const viewport = project.canvas?.viewport ?? emptyCanvas().viewport
  return { nodes, edges, groups, viewport }
}

export function nodeByEntity(graph: CanvasGraph, type: CanvasNode['type'], entityId: string) {
  return graph.nodes.find((n) => {
    if (n.type !== type) return false
    if (type === 'subject' || type === 'subjectProps') return n.data.subjectId === entityId
    if (type === 'scene' || type === 'sceneProps') return n.data.sceneId === entityId
    return n.data.shotId === entityId
  })
}
