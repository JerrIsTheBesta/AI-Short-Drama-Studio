// Offline integration tests: real planner/controller/schema; no paid model calls.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const mocks = {
  '@/stores': `export const useProjectStore=()=>globalThis.h.store;
    export const useSettingsStore=()=>({config:globalThis.h.config});
    export const useAssetsStore=()=>({getBlob:async id=>globalThis.h.blobs[id],add:async (blob,kind,source,meta)=>{const h=globalThis.h;const id='asset-'+(++h.assetCounter);h.blobs[id]=blob;h.saved.push({id,kind,source,meta});return {id}}});
    export const useLibraryStore=()=>({getBlob:async()=>null});`,
  '@/services/ai/client': `export const blobToChatImageUrl=async()=> 'data:image/png;base64,dGVzdA==';
    export const callLLM=async req=>{const h=globalThis.h;h.requests.push(req);const system=req.messages[0].content;const review=system.includes('独立的短剧场记');
    if(system.includes('图几是什么')||system.includes('你看图确认参考图身份'))return {content:JSON.stringify({pictures:[{id:'a',role:'character',caption:'阿默'},{id:'b',role:'character',caption:'阿青'},{id:'room',role:'scene',caption:'室内'}]})};
    return {content:JSON.stringify(review ? h.reviews?.shift() ?? {ok:true,reason:''} : h.responses.shift()||h.fixture)}};`,
  '@/services/ai/image': `export const generateImage=async req=>{globalThis.h.images.push(req);return {blob:new Blob(['image'],{type:'image/png'})}};`,
  '@/services/ai/video': `export const generateVideo=async req=>{const h=globalThis.h;h.videos.push(req);await req.onTaskSubmitted('task-'+h.videos.length);if(h.failVideo){h.failVideo=false;throw Error('polling interrupted')}return {blob:new Blob(['video-'+h.videos.length],{type:'video/mp4'})}};`,
  '@/services/ai/runtime': `export const autodlVideoProfileId=()=>globalThis.h.config.activeVideoId;`,
  '@/services/ai/autodl': `export const autodlWorkflowById=()=>undefined;`,
  '@/services/ai/zealman': `export const zealmanWorkflowById=()=>undefined;`,
  '@/services/ai/apimart': `export const isApimartEndpoint=()=>false;`,
  '@/services/ffmpeg': `export const extractVideoLastFrame=async (video,o)=>{if(!o.preserveEnding)throw Error('must preserve ending');globalThis.h.tails++;return new Blob(['tail:'+await video.text()],{type:'image/jpeg'})};`,
  '@/utils/visualStyle': `export const lookFromScript=()=>({style:'cinematic',medium:'电影感'});export const lookFromTexts=()=>lookFromScript();export const isPhotographicLook=()=>true;export const mediumLockText=()=>'媒介锁定';`,
  '@/utils/aspect': `export const aspectToSize=()=>({width:1280,height:720});`,
  '@/types': `export const emptyCanvas=()=>({nodes:[],edges:[],groups:[],viewport:{x:0,y:0,zoom:1}});export const normalizeVideoGenModel=x=>x||'h3';export const videoMaxSeconds=x=>x==='wan-prime'?30:x==='h3-v5'?10:15;`,
  '@/services/canvas/jobs': `const running=new Set();export async function withNodeJob(id,fn){if(running.has(id))throw Error('already running');running.add(id);try{return await fn()}finally{running.delete(id)}}`,
  '@/services/canvas/videoPromptProfile': `export const resolveH3PromptProfile=async()=>globalThis.h.isH3;`,
  '@/services/ai/h3Prompt': `export const isOfficialH3Prompt=text=>/integrated_multimodal_description\\s*:/i.test(text||'')&&/overall_soundscape\\s*:/i.test(text||'');
    export const buildH3ImageSlots=items=>items.map((item,i)=>({index:i+1,kind:item.kind,name:item.name,sourceName:item.name,job:'Picture '+(i+1)}));
    export const compileH3OfficialPrompt=async req=>{const h=globalThis.h;h.optimizations++;h.lastH3=req;if(h.failOptimize){h.failOptimize=false;throw Error('optimize failed')}return 'integrated_multimodal_description:\\n[Shot 1] compiled\\n\\noverall_soundscape:\\nroom tone\\n\\nnon_diegetic_music:\\nN/A'};`
}
const bundled = await build({
  stdin: { contents: `export * from './src/services/continuous/capture'; export * from './src/services/continuous/model';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', alias: { '@': resolve('src') },
  plugins: [{ name: 'paid-api-mocks', setup(b) {
    b.onResolve({ filter: /^@\// }, args => args.path in mocks ? { path: args.path, namespace: 'mock' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }]
})
const { runContinuousTurn, runCaptureNode, validateCapturePlan, parseCaptureVerdict, isCaptureApproval, planSeconds } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
const detail = '中景固定机位，阿默站在门口左侧抬手，阿青在右侧听他说话，视线与轴线不变。冷色晨光照亮门框，暖色室内灯光落在人物脸上。镜头以缓慢而克制的速度推进，人物边说边放下手，脚步停稳，手指触及木门边缘，背景传来鸟鸣和轻微脚步声，最后停在双方对视的姿态。全段保持原服装、脸和道具，不新增路人。'
const segment = (speaker, text) => ({ title: '交谈', duration: 6, prompt: detail, startState: '门口站立', endState: '原地对视', sound: '鸟鸣', dialogue: [{ speaker, text, delivery: '自然说话' }] })
const source1 = '阿默：你好。\n阿青：你好。\n'
const source2 = '场景二\n阿默：再见。'
const source = source1 + source2
const fixture = {
  title: '两场连续拍', aesthetic: '三维卡通',
  assets: [{ id: 'a', name: '阿默', kind: 'character', prompt: '阿默卡通角色' }, { id: 'b', name: '阿青', kind: 'character', prompt: '阿青卡通角色' }, { id: 'room', name: '室内', kind: 'scene', prompt: '木门房间无人物' }, { id: 'street', name: '街道', kind: 'scene', prompt: '街道无人物' }],
  scenes: [
    { id: 's1', name: '门口', sourceText: source1, assetIds: ['a', 'b', 'room'], openingPrompt: '阿默在左阿青在右', segments: [segment('阿默', '你好。'), segment('阿青', '你好。')] },
    { id: 's2', name: '街道', sourceText: source2, assetIds: ['a', 'street'], openingPrompt: '阿默走到街道', segments: [segment('阿默', '再见。')] }
  ]
}
function reset() {
  const h = globalThis.h = { fixture: structuredClone(fixture), responses: [], requests: [], images: [], videos: [], saved: [], blobs: {}, tails: 0, optimizations: 0, assetCounter: 0, config: { videos: [{ id: 'video', name: '测试工作流', workflowId: 'custom', adapter: { type: 'comfyui-prompt' } }], activeVideoId: 'video' } }
  const p = { id: 'project', script: { content: source }, settings: { aspectRatio: '16:9' }, subjects: [], props: [], scenes: [], shots: [], canvas: { nodes: [], edges: [], groups: [] } }
  h.store = { current: p, save: async () => {}, setCanvas: c => p.canvas = c, addCanvasNode: n => p.canvas.nodes.push(n) }
  return h
}
const turn = text => runContinuousTurn(text, () => {}, {})
let h = reset()
assert.equal(validateCapturePlan(fixture, 15).scenes.length, 2)
assert.equal(validateCapturePlan({ title: '外层标题', plan: { aesthetic: '水墨', assets: fixture.assets, scenes: fixture.scenes } }, 15).aesthetic, '水墨')
assert.equal(validateCapturePlan({
  标题: '中文键', 画风: '写实',
  资产: fixture.assets.map(a => ({ id: a.id, 名称: a.name, 类型: a.kind === 'scene' ? '场景' : '角色', 提示词: a.prompt })),
  场景: fixture.scenes.map(s => ({ id: s.id, 名称: s.name, 原文: s.sourceText, assetIds: s.assetIds.map(id => fixture.assets.find(a => a.id === id).name), 起始画面: s.openingPrompt, 子镜头: s.segments.map(seg => ({ 标题: seg.title, 时长: `${seg.duration}秒`, 提示词: seg.prompt, 起幅: seg.startState, 落幅: seg.endState, 对白: seg.dialogue.map(line => ({ 说话人: line.speaker, 台词: line.text })) })) }))
}, 15).scenes[0].assetIds[0], 'a')
assert.throws(() => validateCapturePlan({ title: '只有标题' }, 15), /这次返回的字段是：title/)
const leet = JSON.parse(JSON.stringify(fixture).replace('"aesthetic"', '"43sth3t1c"').replace('"assets"', '"4ss3ts"').replace('"scenes"', '"sc3n3s"'))
assert.equal(validateCapturePlan(leet, 15).scenes.length, 2)
assert.deepEqual(parseCaptureVerdict('{"ok":true}'), { ok: true, reason: '' })
assert.deepEqual(parseCaptureVerdict('{"ok":"false","原因":"第一场串词"}'), { ok: false, reason: '第一场串词' })
assert.equal(parseCaptureVerdict('{"title":"不是审核"}'), null)
assert.equal(planSeconds(fixture), 18)
for (const input of ['不要继续', '继续但先改台词', '不要开始生成', '确认一下是否合理']) assert.equal(isCaptureApproval(input), false)
assert.equal(isCaptureApproval('继续！'), true)
h = reset()
h.store.current.settings.aspectRatio = '9:16'
await turn('分析剧本')
const hero = h.store.current.canvas.nodes.find(n => n.data.label === '阿默')
const place = h.store.current.canvas.nodes.find(n => n.data.label === '室内')
assert.equal(hero.data.aspectRatio, '16:9')
assert.match(hero.data.prompt, /四视图/)
assert.match(hero.data.prompt, /#FFFFFF/)
assert.equal(place.data.aspectRatio, '16:9')
assert.match(place.data.prompt, /绝对不能有/)
h = reset()
const withProp = structuredClone(fixture)
withProp.assets.push({ id: 'cup', name: '木杯', kind: 'prop', prompt: '一只深色木杯' })
withProp.scenes[0].assetIds.push('cup')
h.responses.push(withProp)
await turn('分析剧本')
const cup = h.store.current.canvas.nodes.find(n => n.data.label === '木杯')
assert.equal(cup.data.aspectRatio, '16:9')
assert.match(cup.data.prompt, /不要人物/)
assert.match(cup.data.prompt, /不要场景/)
h = reset()
await turn('你好')
assert.equal(h.requests.length, 0, '打招呼只识别意图，不制定计划')
assert.equal(h.store.current.continuousCapture, undefined)
h = reset()
await turn('分析剧本')
const plannedRequests = h.requests.length
await turn('这个大概要拍多久')
assert.equal(h.requests.length, plannedRequests, '询问时长不重新规划，也不生成')
assert.equal(h.images.length, 0)
h = reset()
for (const mutate of [p => p.scenes[0].segments[0].duration = 5, p => p.scenes[0].segments[0].duration = 16, p => p.assets.push(p.assets[0])]) {
  const bad = structuredClone(fixture); mutate(bad)
  assert.throws(() => validateCapturePlan(bad, 15))
}
await turn('分析剧本')
assert.equal(h.images.length, 0, 'planning cannot submit assets')
assert.equal(h.requests[0].timeoutMs, 300000)
assert.equal(h.requests[0].useProviderOutputLimit, true)
let s = h.store.current.continuousCapture
assert.equal(h.store.current.canvas.nodes.filter(n => n.type === 'captureText').length, 4)
await assert.rejects(() => runCaptureNode(s.assetNodes.a), /确认/)
await turn('不要继续')
assert.equal(h.images.length, 0)
await turn('继续')
assert.equal(h.images.length, 4)
assert.equal(h.videos.length, 0)
await turn('继续')
assert.equal(h.images.length, 6, 'shared character reused across scenes')
assert.equal(s.phase, 'videos')
assert.equal(h.videos.length, 0, 'video needs its own approval')
await turn('继续')
assert.equal(h.videos.length, 3)
assert.equal(h.videos[0].referenceImages.length, 3, 'first frame is followed by selected identity and scene sheets')
assert.match(h.videos[0].prompt, /图1.*首帧/)
assert.match(h.videos[0].prompt, /图2是阿默/)
assert.match(h.videos[0].prompt, /图3是阿青/)
assert.match(h.videos[0].prompt, /图4是室内/)
assert.equal(h.tails, 1, 'only same-scene continuation extracts a tail')
assert.equal(h.images.length, 7, 'same-scene tail is repaired once before the next shot')
const repair = h.images[6]
assert.equal(repair.referenceImages.length, 3, 'repair uses the tail plus both character sheets')
assert.match(repair.prompt, /高清修复/)
assert.match(repair.prompt, /阿默/)
assert.match(repair.prompt, /阿青/)
assert.match(await repair.referenceImages[0].text(), /^tail:video-/)
assert.equal(await h.videos[1].imageBlob.text(), 'image', 'next shot starts from the repaired tail')
assert.equal(await h.videos[2].imageBlob.text(), 'image', 'scene boundary resets to opening image')
assert.equal(s.phase, 'complete')
await turn('继续')
assert.equal(h.videos.length, 3, 'completed outputs not resubmitted')
const requestsBeforeGrab = h.requests.length
const grabbed = await runContinuousTurn('帮我截取最后一帧的图', () => {}, { selectedNodeId: s.videoNodes['s1:1'] })
assert.match(grabbed.reply, /尾帧/)
assert.equal(h.videos.length, 3, 'grabbing a frame does not start another shoot')
assert.equal(h.requests.length, requestsBeforeGrab, 'grabbing a frame does not plan or generate')
assert.equal(h.tails, 2)
const frameNode = h.store.current.canvas.nodes.find(n => n.id === `lastframe_${s.videoNodes['s1:1']}`)
assert.ok(frameNode?.data.outputAssetId)
assert.match((await runContinuousTurn('帮我截取最后一帧的图', () => {}, {})).reply, /先选中/)
assert.equal(h.store.current.shots.length, 0, 'ordinary pipeline untouched')
assert.equal(h.store.current.script.content, source)
const planNode = h.store.current.canvas.nodes.find(n => n.id === `${s.id}-plan`)
assert.equal(JSON.parse(planNode.data.captureJson).phase, 'complete')
assert.doesNotMatch(planNode.data.prompt, /"phase"/)
assert.match(planNode.data.prompt, /门口/)
assert.equal(planNode.data.height, 720)

h = reset()
const bad = structuredClone(fixture); bad.scenes[0].segments[0].duration = 50
h.responses.push(bad, fixture)
await turn('分析剧本')
assert.equal(h.requests.length, 3, 'invalid structure retries once, then goes to LLM review')

h = reset()
h.store.current.script.content = source.replace('阿默：你好。', '阿默（回头）：“你好。”')
h.fixture.scenes[0].sourceText = source1.replace('阿默：你好。', '阿默：“你好。”')
await turn('分析剧本')
assert.equal(h.requests.length, 2, 'different quote and stage direction formatting reaches LLM review')
assert.ok(h.store.current.continuousCapture)

h = reset()
h.reviews = [{ ok: true }]
await turn('分析剧本')
assert.equal(h.requests.length, 2, '通过结论可以不带 reason')
assert.ok(h.store.current.continuousCapture)
h = reset()
h.reviews = [{ ok: false, reason: '第一场对白串人' }, { ok: false, reason: '第一场对白仍串人' }]
await assert.rejects(() => turn('分析剧本'), /第一场对白仍串人/)
assert.equal(h.requests.length, 4)
assert.match(h.requests[2].messages[1].content, /第一场对白串人/)
assert.equal(h.store.current.continuousCapture, undefined)
assert.equal(h.images.length + h.videos.length, 0)
h = reset()
await turn('分析剧本')
await turn('继续'); await turn('继续')
h.failVideo = true
await assert.rejects(() => turn('继续'), /polling interrupted/)
s = h.store.current.continuousCapture
assert.equal(s.phase, 'videos')
const pending = h.store.current.canvas.nodes.find(n => n.id === s.videoNodes['s1:0'])
assert.ok(pending.data.videoTaskId)
await turn('继续')
assert.ok(h.videos[1].resumeTaskId, 'retry polls previous task')
assert.equal(h.images.length, 7, 'retry keeps the asset images and only repairs the continuation tail')
assert.match(h.images[6].prompt, /高清修复/)

h = reset(); h.isH3 = true
await turn('分析剧本'); await turn('继续'); await turn('继续')
h.failOptimize = true
await assert.rejects(() => turn('继续'), /optimize failed/)
assert.equal(h.videos.length, 0)
await turn('继续')
assert.equal(h.optimizations, 4, 'failed H3 compilation retries instead of being marked ready')
assert.equal(h.lastH3.mode, 'I2VA')
assert.match(h.lastH3.voiceover, /：/)
assert.match(h.videos[0].prompt, /integrated_multimodal_description/)
assert.match(h.videos[0].prompt, /overall_soundscape/)

h = reset(); h.store.current.script = null
assert.match((await turn('开始')).reply, /已有剧本/)
assert.equal(h.requests.length, 0)
h = reset(); h.config.videos[0].name = 'seedance2.5'
// 30 seconds must reach the generation layer, not the ordinary 15-second clamp.
h.fixture.scenes[0].segments[0].duration = 21
await turn('分析剧本')
assert.equal(h.store.current.continuousCapture.maxSeconds, 30)
await turn('继续'); await turn('继续'); await turn('继续')
assert.equal(h.videos[0].duration, 21)
assert.equal(h.videos[0].durationLimit, 30)

h = reset(); await turn('分析剧本'); await turn('继续'); await turn('继续')
s = h.store.current.continuousCapture
const uncertain = h.store.current.canvas.nodes.find(n => n.id === s.videoNodes['s1:0'])
uncertain.data.captureSubmissionPending = true
await assert.rejects(() => turn('继续'), /停止自动重提/)
assert.equal(h.videos.length, 0)
await turn('确认重新提交')
assert.equal(h.videos.length, 3)

h = reset(); await turn('分析剧本'); h.store.current.script.content += '\n新场景'
assert.match((await turn('继续')).reply, /剧本改过了/)
assert.equal(h.images.length, 0)

h = reset(); await turn('分析剧本'); await turn('继续'); await turn('继续')
const controller = new AbortController(); controller.abort()
await assert.rejects(() => runContinuousTurn('继续', () => {}, { signal: controller.signal }))
assert.equal(h.videos.length, 0, 'cancelled runs never submit videos')
console.log('PASS continuous capture: validation, confirmation gates, asset reuse, per-scene serial tails, checkpoints, H3 retry, model limits, no ordinary pipeline mutations')
