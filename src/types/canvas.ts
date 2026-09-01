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

/** 图生视频节点模型。默认 H3 15s；h3-v5 为 10 秒且可选 1080p；万相走百炼同一套 Key。 */
export type VideoGenModel = 'h3' | 'h3-v5' | 'wan-prime'

export type VideoResolution = '768p' | '1080p'

/** H3 出片方式。reference=多图参考（当前默认）；fl2va=首尾帧。 */
export type H3VideoGenMode = 'reference' | 'fl2va'

export const DEFAULT_VIDEO_GEN_MODEL: VideoGenModel = 'h3'
export const DEFAULT_H3_GEN_MODE: H3VideoGenMode = 'reference'

export function normalizeVideoGenModel(value: unknown): VideoGenModel {
  if (value === 'wan-prime') return 'wan-prime'
  if (value === 'h3-v5') return 'h3-v5'
  return 'h3'
}

export function isH3VideoFamily(model: VideoGenModel): boolean {
  return model !== 'wan-prime'
}

export function videoMinSeconds(model: VideoGenModel): number {
  return model === 'wan-prime' ? 2 : 1
}

export function videoMaxSeconds(model: VideoGenModel): number {
  if (model === 'wan-prime') return 30
  if (model === 'h3-v5') return 10
  return 15
}

export function videoDurationOptions(model: VideoGenModel): number[] {
  const min = videoMinSeconds(model)
  const max = videoMaxSeconds(model)
  return Array.from({ length: max - min + 1 }, (_, i) => min + i)
}

export function videoAllows1080p(model: VideoGenModel): boolean {
  return model === 'h3-v5'
}

export function normalizeVideoResolution(value: unknown, model: VideoGenModel): VideoResolution {
  if (!videoAllows1080p(model)) return '768p'
  if (value === '768p') return '768p'
  return '1080p'
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
    /** h3-v5 可选 1080p，其余固定 768p */
    videoResolution?: VideoResolution
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
