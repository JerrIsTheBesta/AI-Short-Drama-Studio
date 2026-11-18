export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'
export const MIN_NODE_SCALE = 0.55
export const MAX_NODE_SCALE = 4
export function normalizeNodeScale(value?: number) {
  return Math.min(MAX_NODE_SCALE, Math.max(MIN_NODE_SCALE, Number.isFinite(value) ? value! : 1))
}
/** Project pointer movement onto the diagonal, keeping the opposite corner fixed. */
export function resizeNodeCorner(start: { x: number; y: number; width: number; height: number; scale: number }, corner: ResizeCorner, dx: number, dy: number) {
  const sx = corner.endsWith('w') ? -1 : 1
  const sy = corner.startsWith('n') ? -1 : 1
  const denominator = start.width ** 2 + start.height ** 2
  const factor = denominator > 0 ? 1 + (sx * dx * start.width + sy * dy * start.height) / denominator : 1
  const scale = normalizeNodeScale(start.scale * factor)
  const ratio = scale / start.scale
  return {
    scale,
    x: start.x + (sx < 0 ? start.width * (1 - ratio) : 0),
    y: start.y + (sy < 0 ? start.height * (1 - ratio) : 0)
  }
}
