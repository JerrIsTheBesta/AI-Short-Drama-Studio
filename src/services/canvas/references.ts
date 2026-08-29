import type { CanvasNode, ID, Project } from '@/types'

/** 返回节点当前产物；绑定节点而不是绑定旧 asset，所以上游重绘后会自动跟随。 */
export function canvasNodeOutputAssetId(project: Project, node?: CanvasNode): ID | undefined {
  if (!node) return undefined
  if (node.type === 'imageGen' || node.type === 'videoGen') return node.data.outputAssetId
  if (node.type === 'final' || node.type === 'export') return project.finalVideoAssetId
  if (node.type === 'subject' || node.type === 'subjectProps') {
    const subject = (project.subjects ?? []).find((item) => item.id === node.data.subjectId)
    return node.type === 'subject' ? subject?.designSheetAssetId : subject?.propSheetAssetId
  }
  if (node.type === 'scene') {
    return (project.scenes ?? []).find((item) => item.id === node.data.sceneId)?.plateAssetId
  }
  if (node.type === 'sceneProps') {
    return (project.scenes ?? []).find((item) => item.id === node.data.sceneId)?.propSheetAssetId
  }
  const shot = project.shots.find((item) => item.id === node.data.shotId)
  if (!shot) return undefined
  if (node.type === 'shotBoard') return shot.boardAssetId
  if (node.type === 'shotImage') return shot.imageAssetId
  if (node.type === 'shotVideo') return shot.videoAssetId
  if (node.type === 'audio') return shot.audioAssetId
  return undefined
}

export function canvasNodeProducesImage(node?: CanvasNode): boolean {
  return Boolean(
    node &&
      ['imageGen', 'subject', 'subjectProps', 'scene', 'sceneProps', 'shotBoard', 'shotImage'].includes(node.type)
  )
}

/** 连线参考优先，其后是手工上传/资产库选择的参考图。 */
export function resolvedCanvasReferenceAssetIds(project: Project, node?: CanvasNode): ID[] {
  if (!node) return []
  const connected = (node.data.referenceSourceNodeIds ?? [])
    .map((id) => canvasNodeOutputAssetId(project, project.canvas?.nodes.find((item) => item.id === id)))
    .filter((id): id is ID => Boolean(id))
  return [...new Set([...connected, ...(node.data.referenceAssetIds ?? [])])]
}

/** 从自由节点拿掉一张参考图：手工添加的和连线带进来的都能删，连线一并断开。 */
export function removeCanvasNodeReference(project: Project, nodeId: ID, assetId: ID): boolean {
  const canvas = project.canvas
  const node = canvas?.nodes.find((item) => item.id === nodeId)
  if (!canvas || !node) return false
  const dropSources = (node.data.referenceSourceNodeIds ?? []).filter((sourceId) => {
    const source = canvas.nodes.find((item) => item.id === sourceId)
    return canvasNodeOutputAssetId(project, source) === assetId
  })
  const nextSources = (node.data.referenceSourceNodeIds ?? []).filter((id) => !dropSources.includes(id))
  const nextManual = (node.data.referenceAssetIds ?? []).filter((id) => id !== assetId)
  node.data = {
    ...node.data,
    referenceSourceNodeIds: nextSources,
    referenceAssetIds: nextManual
  }
  if (dropSources.length) {
    const drop = new Set(dropSources)
    canvas.edges = canvas.edges.filter((edge) => !(edge.target === nodeId && drop.has(edge.source)))
  }
  return true
}

export function appendCanvasReferenceSource(project: Project, targetId: ID, sourceId: ID): boolean {
  const target = project.canvas?.nodes.find((node) => node.id === targetId)
  const source = project.canvas?.nodes.find((node) => node.id === sourceId)
  if (!target || !source || !canvasNodeProducesImage(source)) return false
  if (target.type !== 'imageGen' && target.type !== 'videoGen') return false
  const max = target.type === 'videoGen' && target.data.videoModel === 'wan-prime' ? 10 : 9
  const current = target.data.referenceSourceNodeIds ?? []
  if (current.includes(sourceId)) return true
  if (current.length + (target.data.referenceAssetIds ?? []).length >= max) return false
  target.data.referenceSourceNodeIds = [...current, sourceId]
  return true
}
