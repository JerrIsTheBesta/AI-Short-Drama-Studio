// Exercise the actual store action, without desktop storage or paid providers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
const source = readFileSync('src/stores/project.ts', 'utf8')
const start = source.indexOf('  function setShotAudioMode(')
const end = source.indexOf('\n  /** 局部修改', start)
assert.ok(start >= 0 && end > start)
const compiled = await transform(`export function createAction(current, touch, pushHistory) { ${source.slice(start, end)}; return setShotAudioMode }`, { loader: 'ts', format: 'esm' })
const { createAction } = await import('data:text/javascript;base64,' + Buffer.from(compiled.code).toString('base64'))
for (const mode of ['tts', 'none', 'h3-dialogue', 'h3-voiceover']) {
  const initial = { id:'s1',audioMode:'old', videoAssetId:'existing-video', videoTaskId:'pending-task', videoHistoryIds:['old-video'], imageAssetId:'image', status:'video-generated', audioAssetId:'tts-audio', audioHistoryIds:[] }
  const current = { value:{ shots:[structuredClone(initial)] } }
  let touches = 0
  const set = createAction(current, () => touches++, (id, _next, ids) => [...ids, id])
  set('s1', mode)
  const shot = current.value.shots[0]
  for (const key of ['videoAssetId', 'videoTaskId', 'videoHistoryIds', 'imageAssetId', 'status']) assert.deepEqual(shot[key], initial[key])
  assert.equal(shot.audioMode, mode)
  assert.equal(shot.audioAssetId, mode === 'tts' ? 'tts-audio' : undefined)
  assert.equal(touches, 1)
  set('s1', mode)
  assert.equal(touches, 1, 'same choice is a no-op')
}
console.log('PASS audio mode changes preserve the video, pending task, history and status')
