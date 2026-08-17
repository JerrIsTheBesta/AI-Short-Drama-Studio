/** 智能体和画布之间的轻量桥：聚焦节点、拉近镜头。 */

type RevealFn = (nodeId?: string) => void

let revealFn: RevealFn | null = null

export function setCanvasReveal(fn: RevealFn | null) {
  revealFn = fn
}

export function revealCanvas(nodeId?: string) {
  revealFn?.(nodeId)
}
