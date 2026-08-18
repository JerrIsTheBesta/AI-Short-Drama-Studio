/** 智能体和画布之间的轻量桥：聚焦节点、拉近镜头。 */

type RevealFn = (nodeId?: string) => void
type InspectFn = (nodeId: string) => void

let revealFn: RevealFn | null = null
let inspectFn: InspectFn | null = null

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
