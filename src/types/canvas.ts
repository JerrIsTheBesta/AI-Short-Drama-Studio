import type { TaskStatus } from './pipeline'

export type CanvasNodeType =
  | 'script'
  | 'subject'
  | 'subjectProps'
  | 'scene'
  | 'sceneProps'
  | 'shotBoard'
  | 'shotImage'
  | 'shotVideo'
  | 'audio'
  | 'export'
  | 'final'
  | 'groupFrame'
  | 'imageGen'
  | 'videoGen'

/** 图生视频节点模型。默认 H3（AutoDL）；万相走百炼 TTS 同一套 Key。 */
export type VideoGenModel = 'h3' | 'wan-prime'

/** H3 出片方式。reference=多图参考（当前默认）；fl2va=首尾帧。 */
export type H3VideoGenMode = 'reference' | 'fl2va'

export const DEFAULT_VIDEO_GEN_MODEL: VideoGenModel = 'h3'
export const DEFAULT_H3_GEN_MODE: H3VideoGenMode = 'reference'

export function normalizeVideoGenModel(value: unknown): VideoGenModel {
  return value === 'wan-prime' ? 'wan-prime' : 'h3'
}

export function normalizeH3GenMode(value: unknown): H3VideoGenMode {
  return value === 'fl2va' ? 'fl2va' : 'reference'
}

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
    prompt?: string
    referenceAssetIds?: string[]
    /** 通过画布连线继承参考图的上游节点，顺序即图1、图2…… */
    referenceSourceNodeIds?: string[]
    outputAssetId?: string
    duration?: number
    videoModel?: VideoGenModel
    /** H3：参考图生成（默认）或首尾帧 */
    h3GenMode?: H3VideoGenMode
    firstFrameAssetId?: string
    lastFrameAssetId?: string
    /** AutoDL / 万相进行中任务，重试时先查结果 */
    videoTaskId?: string
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
