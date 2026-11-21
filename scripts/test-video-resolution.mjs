import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: ['src/services/ai/modelOptions.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { videoResolutionChoices, providerVideoResolution, pickDocVideoResolution } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
const choices = videoResolutionChoices({ model: 'h3-v5', profile: { model: 'grok-imagine-1.5-video-ext', options: { videoResolutions: ['768p'] } } })
assert.deepEqual(choices, ['480p', '720p', '1080p'])
assert.equal(pickDocVideoResolution('768p', choices), '720p')
for (const resolution of choices) assert.equal(providerVideoResolution('grok-imagine-1.5-video-ext', resolution), resolution)
assert.equal(providerVideoResolution('grok-imagine-1.5-video-ext', '768p'), '720p')
assert.equal(providerVideoResolution('h3', '768p'), '768p')
assert.deepEqual(videoResolutionChoices({ model: 'h3-v5' }), ['768p', '1080p'])
console.log('PASS Grok resolution choices, legacy fallback, supported tiers and H3 preservation')
