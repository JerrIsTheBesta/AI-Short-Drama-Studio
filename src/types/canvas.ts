import type { TaskStatus } from './pipeline'

export type CanvasNodeType =
  | 'script'
  | 'subject'
  | 'subjectProps'
  | 'scene'
  | 'shotBoard'
  | 'shotImage'
  | 'shotVideo'
  | 'audio'
  | 'export'
  | 'final'
  | 'groupFrame'

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  position: { x: number; y: number }
  data: {
    subjectId?: string
    sceneId?: string
    shotId?: string
    label?: string
    width?: number
    height?: number
    kind?: string
  }
  status?: TaskStatus
  error?: string
  parentGroupId?: string
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export interface CanvasGroup {
  id: string
  label: string
  nodeIds: string[]
}

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  groups: CanvasGroup[]
  viewport: CanvasViewport
}

export function emptyCanvas(): CanvasGraph {
  return {
    nodes: [],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 0.85 }
  }
}
