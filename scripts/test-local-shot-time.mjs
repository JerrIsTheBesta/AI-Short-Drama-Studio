import assert from 'node:assert/strict'
import { build } from 'esbuild'
const b = await build({entryPoints:['src/utils/localShotTime.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {localShotTime} = await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'))
const source = '【00:30–00:35｜收镜】林慎 OS：这是哪儿？\n【00:35–00:39｜侧拍】小卒：林慎！\n【00:39–00:41｜落地】\n【00:41–00:44｜特写】'
const result = localShotTime(source)
assert.equal(result,'【00:00–00:05｜收镜】林慎 OS：这是哪儿？\n【00:05–00:09｜侧拍】小卒：林慎！\n【00:09–00:11｜落地】\n【00:11–00:14｜特写】')
assert.equal(localShotTime(result),result)
assert.equal(localShotTime('30-35秒：A，35-44秒：B'),'0–5秒：A，5–14秒：B')
assert.equal(localShotTime('倒计时59:32，人数30-35。'),'倒计时59:32，人数30-35。')
assert.equal(localShotTime('00:30–00:35 A，00:37–00:40 B'),'00:30–00:35 A，00:37–00:40 B')
console.log('PASS local shot timestamps, dialogue preservation, idempotence, non-time numbers and incoherent ranges')
