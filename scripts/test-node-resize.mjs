import assert from 'node:assert/strict'
import { build } from 'esbuild'
const built = await build({ entryPoints: ['src/utils/nodeResize.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { resizeNodeCorner, normalizeNodeScale } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
const start = { x: 100, y: 200, width: 240, height: 160, scale: 1 }
for (const corner of ['nw','ne','sw','se']) {
  const sx = corner.endsWith('w') ? -1 : 1
  const sy = corner.startsWith('n') ? -1 : 1
  const grown = resizeNodeCorner(start, corner, sx * 120, sy * 80)
  assert.equal(grown.scale, 1.5)
  assert.equal(grown.x, sx < 0 ? -20 : 100)
  assert.equal(grown.y, sy < 0 ? 120 : 200)
  const min = resizeNodeCorner(start, corner, -sx * 10000, -sy * 10000)
  const max = resizeNodeCorner(start, corner, sx * 10000, sy * 10000)
  assert.equal(min.scale, .55)
  assert.equal(max.scale, 4)
  if (sx < 0) assert.equal(max.x + start.width * max.scale, start.x + start.width)
  if (sy < 0) assert.equal(max.y + start.height * max.scale, start.y + start.height)
}
assert.equal(normalizeNodeScale(undefined), 1)
assert.equal(normalizeNodeScale(NaN), 1)
assert.equal(normalizeNodeScale(Infinity), 1)
assert.equal(resizeNodeCorner({ ...start, width: 480, height: 320, scale: 2 }, 'se', 120, 80).scale, 2.5)
assert.equal(resizeNodeCorner(start, 'se', 120 / .5, 80 / .5).scale, 2, 'viewport zoom is removed before geometry')
console.log('PASS: all four corners, opposite corner anchors, aspect ratio, min/max limits, invalid saved values, existing scale and zoom')
