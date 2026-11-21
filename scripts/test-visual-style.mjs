import assert from 'node:assert/strict'
import { build } from 'esbuild'
const built = await build({ entryPoints:['src/utils/visualStyle.ts'],bundle:true,write:false,format:'esm',platform:'node' })
const {lookFromTexts,lookFromScript,mediumLockText,isPhotographicLook} = await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))
for (const phrase of ['3D 半写实风格','3D半写实','3d 半写实风格','三维半写实风格']) {
  const look = lookFromTexts('cinematic',phrase)
  assert.equal(look.style,'3d-render')
  assert.equal(look.userNamed,true)
  assert.equal(isPhotographicLook(look),false)
  assert.match(mediumLockText(look),/半写实/)
}
const imported = lookFromScript({style:'cinematic', content:'【剧名】测试\n3D 半写实风格\n刺客：你好！',aesthetic:'电影感，胶片摄影',styleBrief:'电影质感'})
assert.equal(imported.style,'3d-render','script medium takes priority over generated defaults')
assert.match(imported.medium,/3D 半写实/)
const overridden = lookFromScript({visualStyleOverride:'水墨',content:'画风：3D 半写实风格'})
assert.equal(overridden.style,'ink-wash','explicit later user choice remains highest priority')
assert.equal(lookFromTexts('cinematic','古代卧房，夜，烛光').userNamed,false,'unspecified style must not be treated as confirmed')
console.log('PASS 3D semi-realistic style recognition, source priority, explicit override, no implied confirmation')
