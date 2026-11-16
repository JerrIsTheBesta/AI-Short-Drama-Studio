/** Offline regressions: real planner/registry/loop, mocked persistence and paid generation only. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve, basename } from 'node:path'

const mocks = {
  stores: `export const useProjectStore=()=>globalThis.__agentTest.store; export const useSettingsStore=()=>({config:{vision:globalThis.__agentTest.vision}});
    export const useAssetsStore=()=>({getBlob:async id=>globalThis.__agentTest.blobs?.[id],add:async()=>({id:'saved-tail'})});
    export const useLibraryStore=()=>({getBlob:async()=>null});`,
  shot: `export const needsExternalTts=()=>true;`,
  videoStill: `export const stillModeForShot=s=>s.mode||'identity';
    export const shotUsesFrames=s=>s.mode==='frames'; export const needsShotFrames=p=>p.shots.some(shotUsesFrames);
    export const shotsMissingKeyframe=p=>p.shots.filter(s=>s.mode==='keyframe'&&!s.imageAssetId);
    export const shotsMissingStoryboard=p=>p.shots.filter(s=>s.mode==='storyboard'&&!s.boardAssetId);`,
  storyBrief: `export const topicFromBrief=t=>t;`,
  jobs: `export const VIDEO_GEN_CONCURRENCY=3;`,
  pipeline: `export const TOOL_LABEL={}; export const nextExtractStage=p=>!p.subjects?.length?'subjects':!p.scenes?.length?'scenes':!p.shots?.length?'shots':null;`,
  canvasBridge: `export const revealCanvas=()=>{}; export const selectCanvasNode=id=>{globalThis.__agentTest.selected=id};`,
  references: `export const appendCanvasReferenceSource=()=>true; export const canvasNodeProducesImage=n=>n?.type==='imageGen'; export const resolvedCanvasReferenceAssetIds=(_p,n)=>n?.data.referenceAssetIds||[];
    export const canvasNodeOutputAssetId=(p,n)=>n?.type==='shotVideo'?p.shots.find(s=>s.id===n.data.shotId)?.videoAssetId:n?.data.outputAssetId;`,
  layout: `export const rebuildCanvasGraph=p=>p.canvas; export const absoluteCanvasPosition=(_n,node)=>node.position; export const NODE_W=100; export const nextFreeformPosition=(_n,o)=>o.click;`,
  consistency: `export const packVideoRefEntries=x=>x; export const collectShotVideoEntries=(shot)=>shot.refs||[];`,
  types: `export const normalizeVideoGenModel=x=>x||'h3'; export const videoMaxSeconds=()=>15; export const videoMinSeconds=()=>3;`,
  ffmpeg: `export const extractVideoLastFrame=async (_blob,opts)=>{if(!opts?.preserveEnding)throw Error('expected exact ending path');return new Blob(['tail'],{type:'image/jpeg'})};`,
  videoRemake: `export const extractVideoFrames=async()=>({frames:[new Blob(['sample'],{type:'image/jpeg'})]});`,
  client: `export const blobToChatImageUrl=async b=>'image:'+await b.text(); export const callLLM=async r=>{(globalThis.__agentTest.llm??=[]).push(r);return {content:r.provider==='vision'?'看见主体在门口':'从门口继续向前走'}};`,
  ai: `export const isPlayReady=s=>s?.playReady;`,
  promptCoach: `export const optimizeNodePrompt=async()=>({prompt:'optimized',note:'ok'});`,
  memoryStore: `export const rememberMemory=async()=>({content:'ok'}); export const forgetMemory=async()=>'';`,
  runner: `
    export async function runCanvasNode(id) {
      const h=globalThis.__agentTest; h.calls.push(id); if(h.fail) h.fail(id);
      const p=h.store.current;
      const sub=p.subjects.find(s=>'subject:'+s.id===id); if(sub) sub.designSheetAssetId='new:'+id;
      const scene=p.scenes.find(s=>'scene:'+s.id===id); if(scene) scene.plateAssetId='new:'+id;
    }
    export const generateMissingSheets=async()=>{const h=globalThis.__agentTest; for(const s of h.store.current.subjects) if(!s.designSheetAssetId) await runCanvasNode('subject:'+s.id)};
    export const generateMissingPlates=async()=>{const h=globalThis.__agentTest; for(const s of h.store.current.scenes) if(!s.plateAssetId) await runCanvasNode('scene:'+s.id)};
    export const generateMissingBoards=async()=>{}; export const generateMissingImages=async()=>{};
    export const generateMissingVideos=async()=>{}; export const generateMissingAudio=async()=>{};
    export const generateShotFramePair=async()=>{};
    export const runGeneratePlay=async()=>{throw Error('must not rewrite script')};
    export const runExtractStoryboard=async(_log,_signal,_opts,stage)=>{globalThis.__agentTest.calls.push('extract:'+stage)};
  `
}
const real = new Set(['actionPolicy', 'toolRegistry', 'agentLoop', 'planner', 'taskStore', 'visualStyle', 'abort', 'agentMedia'])
const result = await build({
  stdin: { contents: `export * from './src/services/canvas/actionPolicy'; export * from './src/services/canvas/toolRegistry';
    export * from './src/services/canvas/agentLoop'; export * from './src/services/canvas/planner'; export * from './src/utils/visualStyle';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{ name: 'offline-generation', setup(b) {
    b.onResolve({ filter: /.*/ }, args => {
      const name = basename(args.path).replace(/\.ts$/, '')
      if (real.has(name)) return { path: resolve(args.path.startsWith('@/') ? 'src' : args.resolveDir, args.path.replace(/^@\//, '') + '.ts') }
      if (!(name in mocks)) throw Error('Missing explicit test mock: ' + args.path)
      return { path: name, namespace: 'mock' }
    })
    b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }]
})
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
let tests = 0
function reset() {
  const p = {
    id: 'test', name: 'test', playApproved: true,
    script: { id: 'script', playReady: true, content: '原文台词不可改', origin: 'imported', style: 'cinematic', topic: '电影感', keywords: [] },
    subjects: [{ id: 'a', name: '阿默', designSheetAssetId: 'old:a' }, { id: 'b', name: '小白', designSheetAssetId: 'old:b' }],
    scenes: [{ id: 'room', name: '房间', plateAssetId: 'old:room' }],
    shots: [{ id: 'shot', index: 0, mode: 'identity', videoAssetId: 'old:video', voiceover: '阿默：你好' }],
    settings: {}, canvas: { nodes: [
      { id: 'subject:a', type: 'subject', data: { subjectId: 'a' } },
      { id: 'scene:room', type: 'scene', data: { sceneId: 'room' } }
    ], edges: [] }
  }
  globalThis.__agentTest = { calls: [], fail: null, store: {
    current: p, save: async()=>{}, setAgentState: s=>p.agentState=s, setScript: s=>p.script=s,
    updateSubject: (id, patch)=>Object.assign(p.subjects.find(s=>s.id===id), patch),
    updateScene: (id, patch)=>Object.assign(p.scenes.find(s=>s.id===id), patch)
  } }
  return p
}
const options = { request: '重做', autonomy: 'gated', onEvent: ()=>{} }
async function test(name, fn) { reset(); await fn(); tests++; console.log('PASS', name) }

await test('截图请求改走人物图和场景图，不重新提炼，也不自动生成后续视频', async()=>{
  const p=globalThis.__agentTest.store.current
  const input=[{tool:'extract_cast'}]
  const actions=api.normalizeAssetRedo(input,'先更新人物角色图，然后场景图，后期的分镜视频里面也要写相应风格',p)
  assert.deepEqual(actions,[{tool:'generate_all_sheets',regenerate:true},{tool:'generate_all_scenes',regenerate:true}])
  assert.deepEqual(input,[{tool:'extract_cast'}])
  const done=await api.runAgentLoop(actions,options)
  assert.equal(done.stopped,false)
  assert.deepEqual(globalThis.__agentTest.calls,['subject:a','subject:b','scene:room'])
  assert.equal(p.script.content,'原文台词不可改')
  assert.equal(p.shots[0].videoAssetId,'old:video')
})
await test('点名一个人物只重画该人物',()=>{
  const actions=api.normalizeAssetRedo([{tool:'extract_cast'}],'重画阿默的角色图',globalThis.__agentTest.store.current)
  assert.deepEqual(actions,[{tool:'generate_sheet',subjectId:'a'}])
})
await test('只改提示词或明确不生成，不能自动增加付费重画',()=>{
  const actions=[{tool:'update_node',nodeId:'subject:a',text:'新描述'}]
  for(const request of ['只更新人物图提示词','更新人物图描述，先不生成','更新人物图的描述']) {
    assert.deepEqual(api.normalizeAssetRedo(actions,request,globalThis.__agentTest.store.current),actions)
  }
  const one=api.normalizeAssetRedo([{tool:'extract_cast'}],'重画人物图，场景图不动',globalThis.__agentTest.store.current)
  assert.deepEqual(one,[{tool:'generate_all_sheets',regenerate:true}])
})
await test('已有节点没有明确重提时安全跳过',()=>{
  assert.equal(api.preflightRegisteredTool({tool:'extract_cast'}).state,'skip')
  assert.equal(api.explicitlyRequestsExtraction('后续分镜视频也用这个风格'),false)
  assert.equal(api.explicitlyRequestsExtraction('重新提取分镜'),true)
})
await test('不同提取范围和不同连线不能被去重吞掉',()=>{
  const actions=[{tool:'extract_cast',extractStage:'subjects'},{tool:'extract_cast',extractStage:'scenes'},
    {tool:'connect_nodes',sourceNodeId:'a',targetNodeId:'b'},{tool:'connect_nodes',sourceNodeId:'a',targetNodeId:'c'}]
  assert.equal(api.uniqueActions(actions).length,4)
  assert.notEqual(api.stepKeyOf(actions[0]),api.stepKeyOf(actions[1]))
})
await test('修改人设提示词在生成之前执行，旧图片不会先被清空',async()=>{
  const p=globalThis.__agentTest.store.current
  globalThis.__agentTest.fail=id=>{
    assert.equal(id,'subject:a'); assert.equal(p.subjects[0].sheetPrompt,'三维动画，灰色蚂蚁')
    assert.equal(p.subjects[0].designSheetAssetId,'old:a')
  }
  const actions=[{tool:'update_node',nodeId:'subject:a',text:'三维动画，灰色蚂蚁'},{tool:'generate_sheet',subjectId:'a'}]
  assert.equal(api.buildPlanFromActions(actions,'test').steps[0].tool,'update_node')
  assert.equal((await api.runAgentLoop(actions,options)).stopped,false)
})
await test('明确重做视频不因旧产物存在而跳过，补缺仍跳过',()=>{
  assert.equal(api.preflightRegisteredTool({tool:'generate_video',shotId:'shot'}).state,'skip')
  assert.equal(api.preflightRegisteredTool({tool:'generate_video',shotId:'shot',regenerate:true}).state,'ready')
})
await test('空恢复方案停下，不自动把错误动作塞回去',async()=>{
  globalThis.__agentTest.fail=()=>{throw Error('temporary failure')}
  const done=await api.runAgentLoop([{tool:'run_node',nodeId:'bad'}],{...options,replan:async()=>[]})
  assert.equal(done.stopped,true)
  assert.deepEqual(globalThis.__agentTest.calls,['bad'])
})
await test('替换错误工具后保留后续任务，不重新执行错误工具',async()=>{
  globalThis.__agentTest.fail=id=>{if(id==='bad')throw Error('wrong tool')}
  const done=await api.runAgentLoop([{tool:'run_node',nodeId:'bad'},{tool:'generate_scene',sceneId:'room'}],
    {...options,replan:async()=>[{tool:'generate_sheet',subjectId:'a'}]})
  assert.equal(done.stopped,false)
  assert.deepEqual(globalThis.__agentTest.calls,['bad','subject:a','scene:room'])
})
await test('批量重做部分失败只重试失败项，成功项不重复付费',async()=>{
  let failed=false
  globalThis.__agentTest.fail=id=>{if(id==='subject:b'&&!failed){failed=true;throw Error('temporary')}}
  const done=await api.runAgentLoop([{tool:'generate_all_sheets',regenerate:true}],{
    ...options,replan:async()=>[{tool:'generate_all_sheets',regenerate:true}],
    continue:async()=>({actions:[{tool:'generate_all_sheets',regenerate:true}]})
  })
  assert.equal(done.stopped,false)
  assert.deepEqual(globalThis.__agentTest.calls,['subject:a','subject:b','subject:b'])
})
await test('鉴权失败不调用恢复、不执行后续',async()=>{
  globalThis.__agentTest.fail=()=>{throw Error('401 invalid API Key')}
  let replans=0
  const done=await api.runAgentLoop([{tool:'generate_sheet',subjectId:'a'},{tool:'generate_scene',sceneId:'room'}],
    {...options,replan:async()=>{replans++;return []}})
  assert.equal(done.stopped,true);assert.equal(replans,0);assert.deepEqual(globalThis.__agentTest.calls,['subject:a'])
})
await test('相同失败最多执行两次，不无限重试',async()=>{
  globalThis.__agentTest.fail=()=>{throw Error('temporary failure')}
  const done=await api.runAgentLoop([{tool:'generate_sheet',subjectId:'a'}],
    {...options,replan:async({remaining})=>remaining})
  assert.equal(done.stopped,true)
  assert.deepEqual(globalThis.__agentTest.calls,['subject:a','subject:a'])
})
await test('重做预算按实际目标数检查，不按缺图数零估价',async()=>{
  globalThis.__agentTest.store.current.agentState={callBudget:1}
  await assert.rejects(api.runAgentLoop([{tool:'generate_all_sheets',regenerate:true}],options),/超过当前单次预算/)
  assert.deepEqual(globalThis.__agentTest.calls,[])
})
await test('已取消的任务不会继续生成或进入恢复',async()=>{
  const signal=AbortSignal.abort()
  await assert.rejects(api.runAgentLoop([{tool:'generate_sheet',subjectId:'a'}],{...options,signal}),/取消/)
  assert.deepEqual(globalThis.__agentTest.calls,[])
})
await test('更新项目画风优先于剧本旧风格、不改变台词或删除产物',async()=>{
  const p=globalThis.__agentTest.store.current
  await api.executeRegisteredTool({tool:'set_visual_style',text:'3D 动画'},{onLog:()=>{}})
  assert.equal(api.lookFromScript(p.script).style,'3d-render')
  assert.equal(p.script.content,'原文台词不可改')
  assert.equal(p.subjects[0].designSheetAssetId,'old:a')
})
await test('按实际提取范围验收，非法范围不能静默降级',()=>{
  globalThis.__agentTest.store.current.scenes=[]
  assert.match(api.verifyRegisteredTool({tool:'extract_cast',extractStage:'scenes'}),/场景/)
  assert.throws(()=>api.validateToolAction({tool:'extract_cast',extractStage:'wrong'}),/提炼范围/)
  assert.throws(()=>api.validateToolAction({tool:'generate_video',shotId:'shot',regenerate:'true'}),/布尔/)
})
await test('视觉没配置时禁用；配置后按图号读取像素，工具不改画布',async()=>{
  const h=globalThis.__agentTest, p=h.store.current
  p.canvas.nodes.push({id:'video',type:'shotVideo',data:{shotId:'shot'}})
  p.shots[0].refs=[{id:'first'},{id:'second'}]
  h.blobs={second:new Blob(['actual-image-2'],{type:'image/png'})}
  const action={tool:'inspect_canvas_image',nodeId:'video',referenceIndex:2,text:'核对人物'}
  const before=JSON.stringify(p.canvas)
  await assert.rejects(api.executeRegisteredTool(action,{onLog:()=>{}}),/配置/)
  assert.equal(h.llm,undefined)
  h.vision={baseUrl:'https://example.com',apiKey:'test-only',model:'vision'}
  assert.match(await api.executeRegisteredTool(action,{onLog:()=>{}}),/参考图 2/)
  assert.equal(h.llm[0].provider,'vision')
  assert.equal(h.llm[0].messages[1].content.at(-1).image_url.url,'image:actual-image-2')
  assert.equal(JSON.stringify(p.canvas),before)
})
for(const withVision of [false,true]) await test(`续拍使用真实末帧、存成下游视频，${withVision?'观察取样帧':'未配置不调用视觉'}`,async()=>{
  const h=globalThis.__agentTest, p=h.store.current
  p.canvas.nodes.push({id:'video',type:'shotVideo',position:{x:0,y:0},data:{shotId:'shot',prompt:'上一段角色到门口'}})
  h.blobs={'old:video':new Blob(['video'],{type:'video/mp4'})}
  if(withVision) h.vision={baseUrl:'https://example.com',apiKey:'test-only',model:'vision'}
  h.store.addCanvasNode=node=>p.canvas.nodes.push(node)
  h.store.setCanvas=canvas=>p.canvas=canvas
  await api.executeRegisteredTool({tool:'continue_from_video_tail',nodeId:'video',text:'接着走'},{onLog:()=>{}})
  const next=p.canvas.nodes.at(-1)
  assert.equal(next.type,'videoGen'); assert.equal(next.status,'idle'); assert.equal(h.selected,next.id)
  assert.deepEqual(next.data.referenceAssetIds,['saved-tail']); assert.equal(next.data.firstFrameAssetId,'saved-tail')
  assert.equal(p.canvas.edges.at(-1).source,'video'); assert.equal(p.canvas.edges.at(-1).target,next.id)
  assert.match(next.data.prompt,/从门口继续向前走/)
  assert.match(h.llm.at(-1).messages[1].content,/上一段角色到门口/)
  assert.deepEqual(h.llm.map(r=>r.provider),withVision ? ['vision',undefined] : [undefined])
  assert.deepEqual(h.calls,[])
})
console.log(`${tests} canvas agent regression tests passed (offline; no API calls).`)
