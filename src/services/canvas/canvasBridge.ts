/** 智能体和画布之间的轻量桥：聚焦节点、拉近镜头、同步生成进度。 */

type RevealFn = (nodeId?: string) => void
type InspectFn = (nodeId: string) => void
type SelectFn = (nodeId: string) => void

let revealFn: RevealFn | null = null
let inspectFn: InspectFn | null = null
let selectFn: SelectFn | null = null

export function setCanvasReveal(fn: RevealFn | null) {
  revealFn = fn
}

export function revealCanvas(nodeId?: string) {
  revealFn?.(nodeId)
}

export function setCanvasInspect(fn: InspectFn | null) {
  inspectFn = fn
}

export function inspectCanvasNode(nodeId: string) {
  inspectFn?.(nodeId)
}

export function setCanvasSelect(fn: SelectFn | null) {
  selectFn = fn
}

export function selectCanvasNode(nodeId: string) {
  selectFn?.(nodeId)
}

export type CanvasActivity = {
  kind: 'start' | 'progress' | 'done' | 'error'
  nodeId: string
  label: string
  message?: string
  source?: 'canvas' | 'agent'
}

type ActivityFn = (ev: CanvasActivity) => void
const activityFns = new Set<ActivityFn>()

export function onCanvasActivity(fn: ActivityFn) {
  activityFns.add(fn)
  return () => activityFns.delete(fn)
}

export function emitCanvasActivity(ev: CanvasActivity) {
  for (const fn of activityFns) fn(ev)
}
