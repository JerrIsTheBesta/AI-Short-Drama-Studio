import { callLLM, getAIMode } from '@/services/ai/client'
import { skillContextForAgent } from '@/skills'
import { useProjectStore } from '@/stores'
import type { Project } from '@/types'
import {
  runCanvasNode,
  runStoryboard,
  generateMissingSheets,
  generateMissingPlates,
  generateMissingImages,
  generateMissingVideos,
  generateMissingAudio
} from './runner'
import { rebuildCanvasGraph } from './layout'
import { inferVisualStyleFromText } from '@/utils/visualStyle'
import { mapPool } from './jobs'
import { revealCanvas } from './canvasBridge'
import {
  continueQuestion,
  clarifyMessage,
  isContinueRequest,
  isVagueRequest,
  nextPipelineStep,
  TOOL_LABEL,
  type PipelineStep
} from './pipeline'
import {
  DOWNSTREAM_TOOLS,
  PLAY_GATE_MSG,
  isApprovePlayRequest,
  isFullPipelineRequest,
  needsPlayReview
} from './playGate'

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AgentToolResult {
  tool: string
  ok: boolean
  detail: string
}

export interface AgentEvent {
  kind?: 'log' | 'step' | 'focus'
  label: string
  step?: string
  status?: 'running' | 'done' | 'fail'
  nodeId?: string
}

export type AgentProgress = (ev: AgentEvent) => void

export interface AgentTurnResult {
  reply: string
  results: AgentToolResult[]
  chips: { label: string; text: string }[]
}

function projectDigest() {
  const p = useProjectStore().current
  if (!p) return '（无项目）'
  return JSON.stringify(
    {
      name: p.name,
      topic: p.script?.topic,
      content: (p.script?.content ?? '').slice(0, 800),
      subjects: (p.subjects ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        hasSheet: Boolean(s.designSheetAssetId)
      })),
      scenes: (p.scenes ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        hasPlate: Boolean(s.plateAssetId)
      })),
      shots: p.shots.map((s) => ({
        id: s.id,
        index: s.index,
        title: s.title,
        hasImage: Boolean(s.imageAssetId),
        hasVideo: Boolean(s.videoAssetId),
        hasAudio: Boolean(s.audioAssetId)
      }))
    },
    null,
    2
  )
}

const TOOLS_HINT = `你是剧流 Studio 画布上的现场助理。一边干活一边告诉用户画布上发生了什么。

硬性规则：
1. 只输出 JSON：{ "say": "给用户看的话", "actions": [ ... ] }
2. 需求含糊（「帮我做」「开始」这类）时 actions 必须是空数组，say 里主动问主题、时长、只要剧本还是全流程。
3. 拆完剧本必须停，告诉用户「画布左侧已经出现完整剧本」。问要不要继续做人设。同一轮不要既拆剧本又出图，除非用户说了「全流程」。
4. 每做完一步，say 里问要不要继续下一步。用户说「继续」才走下一步。
5. 没说「全流程 / 全部做完」禁止一次把人设+配图+视频全做完。
6. 剧本未验收时禁止配图/视频。用户说「确认通过」才 approve_play；说「继续」= 验收并做下一步。
7. 一次最多 8 个 actions。

可用工具：
{ "tool": "seed_script", "text": "用户原文" }
{ "tool": "generate_storyboard" }
{ "tool": "approve_play" }
{ "tool": "generate_sheet", "subjectId": "sub_1" }
{ "tool": "generate_scene", "sceneId": "scn_1" }
{ "tool": "generate_shot_image", "shotId": "shot_xxx" }
{ "tool": "generate_video", "shotId": "shot_xxx" }
{ "tool": "generate_audio", "shotId": "shot_xxx" }
{ "tool": "generate_all_sheets" }
{ "tool": "generate_all_scenes" }
{ "tool": "generate_all_images" }
{ "tool": "generate_all_videos" }
{ "tool": "generate_all_audio" }
{ "tool": "sync_canvas" }
{ "tool": "focus_node", "nodeId": "script" }`

function parseAgentJson(text: string): { say: string; actions: any[] } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { say: text.slice(0, 400), actions: [] }
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      say: String(obj.say || '好的'),
      actions: Array.isArray(obj.actions) ? obj.actions : []
    }
  } catch {
    return { say: text.slice(0, 400), actions: [] }
  }
}

function skillSelectContext(userText: string) {
  const p = useProjectStore().current
  const subjects = p?.subjects ?? []
  const scenes = p?.scenes ?? []
  const shots = p?.shots ?? []
  return {
    userText,
    hasShots: shots.length > 0,
    missingSheets: subjects.some((s) => !s.designSheetAssetId),
    missingPlates: scenes.some((s) => !s.plateAssetId),
    missingImages: shots.some((s) => !s.imageAssetId),
    missingVideos: shots.some((s) => !s.videoAssetId)
  }
}

function qaNotes(p: Project): string {
  const issues: string[] = []
  if (!p.shots.length) issues.push('还没分镜')
  const noSheet = (p.subjects ?? []).filter((s) => !s.designSheetAssetId)
  if (noSheet.length) issues.push(`没人设：${noSheet.map((s) => s.name).join('、')}`)
  const noPlate = (p.scenes ?? []).filter((s) => !s.plateAssetId)
  if (noPlate.length) issues.push(`没底板：${noPlate.map((s) => s.name).join('、')}`)
  const noImg = p.shots.filter((s) => !s.imageAssetId)
  if (noImg.length) issues.push(`${noImg.length} 镜还没配图`)
  const noVid = p.shots.filter((s) => s.imageAssetId && !s.videoAssetId)
  if (noVid.length) issues.push(`${noVid.length} 镜有图没视频`)
  const unbound = p.shots.filter((s) => !s.sceneId || !(s.subjectIds && s.subjectIds.length))
  if (unbound.length) issues.push(`${unbound.length} 镜没绑人物或场景`)
  if (!issues.length) return '清单过了一遍，目前能往下剪。'
  return issues.join('；')
}

const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
}

function parseShotIndexes(text: string): number[] {
  const out = new Set<number>()
  for (const m of text.matchAll(/第\s*(\d+)\s*镜/g)) {
    const n = Number(m[1])
    if (n >= 1) out.add(n - 1)
  }
  for (const m of text.matchAll(/第\s*([一二两三四五六七八九十]+)\s*镜/g)) {
    const n = CN_NUM[m[1]]
    if (n) out.add(n - 1)
  }
  return [...out].sort((a, b) => a - b)
}

function wantAll(text: string) {
  return isFullPipelineRequest(text)
}

export async function runAgentTurn(
  history: AgentMessage[],
  userText: string,
  onEvent: AgentProgress
): Promise<AgentTurnResult> {
  const project = useProjectStore()
  if (!project.current) {
    return { reply: '先打开或新建一个项目。', results: [], chips: [] }
  }

  const p0 = project.current
  if (/^(先看看|先看|等一下|先不|不用了)([，,。!！ ]*)$/.test(userText.trim())) {
    const n = nextPipelineStep(p0)
    return {
      reply: n ? `好，你先看画布。想做「${n.label}」时回「继续」。` : '好，你先看画布。',
      results: [],
      chips: nextChips(n)
    }
  }
  if (isVagueRequest(userText, p0) && !wantAll(userText) && !isContinueRequest(userText) && !isApprovePlayRequest(userText)) {
    onEvent({ kind: 'log', label: '需求不够清楚，先问你几句' })
    return { reply: clarifyMessage(p0), results: [], chips: clarifyChips(p0) }
  }

  const skillPack = skillContextForAgent(skillSelectContext(userText))
  const wantQa = skillPack.selected.some((s) => s.id === 'qa-verify')

  let plan: { say: string; actions: any[] }

  if (isContinueRequest(userText) && !wantAll(userText)) {
    plan = continuePlan(p0)
  } else if (getAIMode() === 'real' && !isContinueRequest(userText)) {
    onEvent({ kind: 'log', label: '在想怎么做…' })
    const chat = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    const resp = await callLLM({
      messages: [
        { role: 'system', content: `${TOOLS_HINT}\n\n${skillPack.prompt}` },
        {
          role: 'user',
          content: `当前项目快照：\n${projectDigest()}\n\n上面是状态。下面对话里最后一句才是本轮任务。需求含糊就提问，不要瞎做。做完一步要问是否继续。`
        },
        ...chat
      ],
      temperature: 0.2,
      jsonMode: true,
      maxTokens: 2000
    })
    plan = parseAgentJson(resp.content)
    plan.actions = applyPlayGate(
      dedupeActions(sanitizeActions(plan.actions, userText)),
      userText
    )
  } else {
    plan = heuristicPlan(userText)
    plan.actions = applyPlayGate(dedupeActions(plan.actions), userText)
  }

  const gated =
    !wantAll(userText) &&
    needsPlayReview(project.current) &&
    !isApprovePlayRequest(userText) &&
    !isContinueRequest(userText) &&
    !plan.actions.some((a) => a.tool === 'generate_storyboard' || a.tool === 'seed_script')
  if (gated && !plan.actions.length) {
    plan.say = PLAY_GATE_MSG
  }

  if (!plan.actions.length) {
    onEvent({ kind: 'log', label: '先等你确认方向' })
    const chips = gated ? reviewChips() : clarifyChips(project.current)
    return { reply: plan.say || clarifyMessage(project.current), results: [], chips }
  }

  onEvent({ kind: 'log', label: '开始在画布上干活' })
  const results = await execActionList(plan.actions.slice(0, 8), onEvent)

  if (project.current) {
    project.setCanvas(rebuildCanvasGraph(project.current, true))
    await project.save()
  }

  const wrap = wrapUpReply(results, userText, plan.say)
  const qa = wantQa && project.current ? `\n${qaNotes(project.current)}` : ''
  return { reply: wrap.reply + qa, results, chips: wrap.chips }
}

function continuePlan(p: Project): { say: string; actions: any[] } {
  const n = nextPipelineStep(p)
  if (!n) {
    return { say: '目前没有下一步了。要改某一镜，直接点画布节点重新生成。', actions: [] }
  }
  if (n.id === 'review') {
    const fake = { ...p, playApproved: true }
    const after = nextPipelineStep(fake)
    return {
      say: after ? `剧本算你看过了，接着做「${after.label}」。` : '剧本已确认。',
      actions: [{ tool: 'approve_play' }, ...(after?.tools ?? [])]
    }
  }
  return { say: `继续做「${n.label}」。`, actions: n.tools }
}

function clarifyChips(p: Project | null | undefined): { label: string; text: string }[] {
  if (!p?.script?.content?.trim()) {
    return [
      { label: '先拆剧本', text: '按我刚说的拆剧本' },
      { label: '全流程', text: '全流程跑完' }
    ]
  }
  if (!p.shots.length) {
    return [
      { label: '拆剧本', text: '拆剧本' },
      { label: '全流程', text: '全流程跑完' }
    ]
  }
  if (needsPlayReview(p)) return reviewChips()
  const n = nextPipelineStep(p)
  if (n) {
    return [
      { label: `继续：${n.label}`, text: '继续' },
      { label: '全流程', text: '全流程跑完' }
    ]
  }
  return []
}

function reviewChips() {
  return [
    { label: '确认通过', text: '确认通过' },
    { label: '继续往下', text: '继续' },
    { label: '全流程', text: '全流程跑完' }
  ]
}

function nextChips(next: PipelineStep | null): { label: string; text: string }[] {
  if (!next) return []
  return [
    { label: `继续：${next.label}`, text: '继续' },
    { label: '先看看', text: '先看看' },
    { label: '全流程', text: '全流程跑完' }
  ]
}

function wrapUpReply(
  results: AgentToolResult[],
  userText: string,
  fallbackSay: string
): { reply: string; chips: { label: string; text: string }[] } {
  const p = useProjectStore().current
  const fail = results.filter((r) => !r.ok)
  const failLine = fail.length
    ? `\n失败 ${fail.length} 项：${fail.map((f) => TOOL_LABEL[f.tool] || f.tool).join('；')}`
    : ''
  const all = wantAll(userText)
  const didBoard = results.some((r) => r.ok && (r.tool === 'generate_storyboard' || r.tool === 'extract_cast'))
  const didApprove = results.some((r) => r.ok && r.tool === 'approve_play')
  const didCast = results.some(
    (r) => r.ok && /sheet|scene/.test(r.tool)
  )
  const didImg = results.some((r) => r.ok && /image/.test(r.tool))
  const didVid = results.some((r) => r.ok && /video/.test(r.tool))
  const didAud = results.some((r) => r.ok && /audio/.test(r.tool))

  if (all) {
    const next = nextPipelineStep(p)
    return {
      reply: `全流程按你的要求跑完了。${failLine || '画布上的节点都已更新。'}${next ? `\n还缺「${next.label}」，回「继续」我再补。` : ''}`,
      chips: nextChips(next)
    }
  }
  if (didBoard) {
    const n = p?.shots.length ?? 0
    return {
      reply: `剧本已经写到画布左侧了，一共 ${n} 个分镜。请先看一遍。\n看完回「继续」做人设和场景；说「全流程」会自动跑完。${failLine}`,
      chips: reviewChips()
    }
  }
  if (didApprove && !didCast && !didImg) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '剧本已确认。\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didCast && !didImg) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '人设和场景已经出在画布上了。\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didImg && !didVid) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '分镜配图已经铺到画布上了。\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didVid && !didAud) {
    const next = nextPipelineStep(p)
    return {
      reply: continueQuestion(next, '分镜视频已经生成。\n') + failLine,
      chips: nextChips(next)
    }
  }
  if (didAud) {
    return { reply: `口播好了。可以去成片节点导出。${failLine}`, chips: [] }
  }
  const next = nextPipelineStep(p)
  return {
    reply: (fallbackSay || '这一步做完了。') + failLine + (next ? `\n${continueQuestion(next, '')}` : ''),
    chips: nextChips(next)
  }
}

/** 演示模式 / 模型跑偏时：砍掉用户没点名的动作 */
function sanitizeActions(actions: any[], userText: string): any[] {
  const all = wantAll(userText)
  const t = userText
  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜/.test(t)
  const askedSheet = /人设|角色图/.test(t)
  const askedScene = /场景图|底板|出场景|生成场景/.test(t)
  const askedImage = /配图|出图|关键帧|画面/.test(t)
  const askedVideo = /视频|图生视频/.test(t)
  const askedAudio = /口播|配音|语音/.test(t)
  const shotHit = parseShotIndexes(t).length > 0
  return actions.filter((a) => {
    const tool = String(a?.tool || '')
    if (!tool) return false
    if (tool === 'seed_script') return true
    if (tool === 'focus_node') return true
    if (tool === 'approve_play') return true
    if (tool === 'generate_all_sheets') return askedSheet || all
    if (tool === 'generate_all_scenes') return askedScene || all
    if (tool === 'generate_all_images') return askedImage || all
    if (tool === 'generate_all_videos') return askedVideo || all
    if (tool === 'generate_all_audio') return askedAudio || all
    if (tool === 'generate_storyboard' || tool === 'extract_cast') return askedBoard || all
    if (tool === 'generate_sheet') return askedSheet || all
    if (tool === 'generate_scene') return askedScene || all
    if (tool === 'generate_shot_image') return askedImage || shotHit || all
    if (tool === 'generate_video') return askedVideo || all
    if (tool === 'generate_audio') return askedAudio || all
    return true
  })
}

function dedupeActions(actions: any[]): any[] {
  const seen = new Set<string>()
  return actions.filter((a) => {
    const key = `${a.tool}:${a.subjectId || ''}:${a.sceneId || ''}:${a.shotId || ''}:${a.nodeId || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function applyPlayGate(actions: any[], userText: string): any[] {
  const all = wantAll(userText)
  const p = useProjectStore().current
  if (all) {
    const out = [...actions]
    const hasBoard = out.some((a) => a.tool === 'generate_storyboard' || a.tool === 'extract_cast')
    const hasApprove = out.some((a) => a.tool === 'approve_play')
    if (!hasApprove) {
      const idx = out.findIndex((a) => a.tool === 'generate_storyboard' || a.tool === 'extract_cast')
      if (idx >= 0) out.splice(idx + 1, 0, { tool: 'approve_play' })
      else out.unshift({ tool: 'approve_play' })
    }
    if (hasBoard) {
      /* 全流程：拆完立刻视为通过再往下 */
    }
    return out
  }
  if (isApprovePlayRequest(userText)) {
    return [{ tool: 'approve_play' }]
  }
  const hasBoard = actions.some(
    (a) => a.tool === 'generate_storyboard' || a.tool === 'extract_cast' || a.tool === 'seed_script'
  )
  if (hasBoard) {
    return actions.filter(
      (a) =>
        a.tool === 'generate_storyboard' ||
        a.tool === 'extract_cast' ||
        a.tool === 'seed_script' ||
        a.tool === 'sync_canvas' ||
        a.tool === 'focus_node'
    )
  }
  if (p && needsPlayReview(p)) {
    return actions.filter((a) => !DOWNSTREAM_TOOLS.has(String(a.tool)))
  }
  return actions
}

function heuristicPlan(userText: string): { say: string; actions: any[] } {
  const t = userText.trim()
  const p = useProjectStore().current!
  const actions: any[] = []
  const all = wantAll(t)
  const shotIdxs = parseShotIndexes(t)
  const namedSubs = (p.subjects ?? []).filter((s) => s.name && t.includes(s.name))
  const namedScns = (p.scenes ?? []).filter((s) => s.name && t.includes(s.name))

  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜|拆剧本/.test(t)
  const askedSheet = /人设|角色图/.test(t)
  const askedScene = /场景图|底板|出场景|生成场景/.test(t)
  const askedImage = /配图|出图|关键帧|把图画上|缺的图/.test(t)
  const askedVideo = /图生视频|生成视频|出视频/.test(t) || /第.+镜.*视频/.test(t)
  const askedAudio = /口播|配音|语音/.test(t)
  const looksLikeBrief =
    t.length >= 16 && !askedSheet && !askedImage && !askedVideo && !askedScene && !p.shots.length

  if (!p.script?.content?.trim() && (askedBoard || looksLikeBrief || all)) {
    actions.push({ tool: 'seed_script', text: t })
  }
  if (askedBoard || looksLikeBrief || (all && !p.shots.length)) {
    actions.push({ tool: 'generate_storyboard' })
  }

  if (namedSubs.length && askedSheet) {
    for (const s of namedSubs) actions.push({ tool: 'generate_sheet', subjectId: s.id })
  } else if (askedSheet) {
    actions.push({ tool: 'generate_all_sheets' })
  }

  if (namedScns.length && askedScene) {
    for (const s of namedScns) actions.push({ tool: 'generate_scene', sceneId: s.id })
  } else if (askedScene) {
    actions.push({ tool: 'generate_all_scenes' })
  }

  if (shotIdxs.length) {
    for (const i of shotIdxs) {
      const shot = p.shots[i] ?? p.shots.find((s) => s.index === i)
      if (!shot) continue
      if (askedVideo && !askedImage) {
        actions.push({ tool: 'generate_video', shotId: shot.id })
      } else if (askedAudio && !askedImage && !askedVideo) {
        actions.push({ tool: 'generate_audio', shotId: shot.id })
      } else {
        actions.push({ tool: 'generate_shot_image', shotId: shot.id })
        if (askedVideo) actions.push({ tool: 'generate_video', shotId: shot.id })
      }
    }
  } else {
    if (askedImage) actions.push({ tool: 'generate_all_images' })
    if (askedVideo) actions.push({ tool: 'generate_all_videos' })
    if (askedAudio) actions.push({ tool: 'generate_all_audio' })
  }

  if (all) {
    if (!p.shots.length && !actions.some((a) => a.tool === 'generate_storyboard')) {
      actions.push({ tool: 'generate_storyboard' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_sheets')) {
      actions.push({ tool: 'generate_all_sheets' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_scenes')) {
      actions.push({ tool: 'generate_all_scenes' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_images')) {
      actions.push({ tool: 'generate_all_images' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_videos')) {
      actions.push({ tool: 'generate_all_videos' })
    }
  }

  if (!actions.length) {
    if (needsPlayReview(p)) {
      return {
        say: PLAY_GATE_MSG,
        actions: []
      }
    }
    return {
      say: '你想让我做哪一步？可以说：拆分镜、确认通过、出人设、第1镜配图。说「全流程」才会整条跑。',
      actions: []
    }
  }
  if (askedBoard && !all) {
    return { say: '先拆剧本。拆完请看左侧完整剧本，点确认通过后再往下。', actions }
  }
  return { say: '按你这句做，不加别的步骤。', actions }
}

const PHASE: Record<string, number> = {
  seed_script: 0,
  generate_storyboard: 0,
  extract_cast: 0,
  approve_play: 0,
  generate_sheet: 1,
  generate_all_sheets: 1,
  generate_scene: 1,
  generate_all_scenes: 1,
  generate_shot_image: 2,
  generate_all_images: 2,
  generate_video: 3,
  generate_all_videos: 3,
  generate_audio: 4,
  generate_all_audio: 4,
  run_node: 2,
  sync_canvas: 5,
  focus_node: 5
}

async function execActionList(
  actions: any[],
  onEvent: AgentProgress
): Promise<AgentToolResult[]> {
  const results: AgentToolResult[] = []
  const list = actions.filter((a) => a?.tool)
  const groups = new Map<number, any[]>()
  for (const a of list) {
    const phase = PHASE[String(a.tool)] ?? 2
    const arr = groups.get(phase) ?? []
    arr.push(a)
    groups.set(phase, arr)
  }
  const phases = [...groups.keys()].sort((a, b) => a - b)
  for (const phase of phases) {
    const batch = groups.get(phase) ?? []
    const parallel = phase >= 1 && phase <= 4
    if (!parallel) {
      for (const action of batch) {
        const tool = String(action.tool || '')
        const label = TOOL_LABEL[tool] || tool
        onEvent({ kind: 'step', step: tool, label, status: 'running' })
        try {
          const detail = await execTool(tool, action, onEvent)
          results.push({ tool, ok: true, detail })
          onEvent({ kind: 'step', step: tool, label, status: 'done' })
        } catch (e: any) {
          results.push({ tool, ok: false, detail: e?.message ?? String(e) })
          onEvent({ kind: 'step', step: tool, label, status: 'fail' })
        }
      }
      continue
    }
    onEvent({
      kind: 'log',
      label: `同时进行：${batch.map((a) => TOOL_LABEL[a.tool] || a.tool).join('、')}`
    })
    const chunk: AgentToolResult[] = []
    await mapPool(batch, 3, async (action) => {
      const tool = String(action.tool || '')
      const label = TOOL_LABEL[tool] || tool
      onEvent({ kind: 'step', step: `${tool}:${action.shotId || action.subjectId || action.sceneId || ''}`, label, status: 'running' })
      try {
        const detail = await execTool(tool, action, onEvent)
        chunk.push({ tool, ok: true, detail })
        onEvent({ kind: 'step', step: `${tool}:${action.shotId || action.subjectId || action.sceneId || ''}`, label, status: 'done' })
      } catch (e: any) {
        chunk.push({ tool, ok: false, detail: e?.message ?? String(e) })
        onEvent({ kind: 'step', step: `${tool}:${action.shotId || action.subjectId || action.sceneId || ''}`, label, status: 'fail' })
      }
    })
    results.push(...chunk)
  }
  return results
}

async function execTool(
  tool: string,
  action: any,
  onEvent: AgentProgress
): Promise<string> {
  const project = useProjectStore()
  const p = project.current!
  const progress = (_id: string, msg: string) => onEvent({ kind: 'log', label: msg })

  if (tool === 'seed_script') {
    const text = String(action.text || '').trim()
    const cur = project.current
    if (!cur) throw new Error('请先创建项目')
    const topic = text.replace(/\s+/g, ' ').slice(0, 48) || cur.name
    const inferred = inferVisualStyleFromText(text)
    const style = inferred || cur.script?.style || 'cinematic'
    if (!cur.script) {
      project.setScript({
        id: 's_' + Date.now().toString(36),
        topic,
        content: text,
        keywords: [],
        style,
        aspectRatio: cur.settings.aspectRatio,
        shotDuration: cur.settings.defaultShotDuration || 5,
        createdAt: Date.now()
      })
    } else if (!(cur.script.content || '').trim() && text) {
      project.setScript({
        ...cur.script,
        topic: cur.script.topic || topic,
        content: text,
        style
      })
    } else if (inferred && inferred !== cur.script.style) {
      project.setScript({ ...cur.script, style: inferred })
    }
    onEvent({ kind: 'log', label: '文案已写入，接着拆剧本' })
    return '文案已准备好'
  }
  if (tool === 'generate_storyboard' || tool === 'extract_cast') {
    await runStoryboard((m) => onEvent({ kind: 'log', label: m }))
    revealCanvas('script')
    onEvent({ kind: 'focus', nodeId: 'script', label: '剧本已出现在画布左侧' })
    return `已生成 ${project.current?.shots.length ?? 0} 个分镜，请先看画布上的剧本`
  }
  if (tool === 'approve_play') {
    project.setPlayApproved(true)
    await project.save()
    revealCanvas('script')
    return '剧本已确认，可以往下做人设和配图'
  }
  if (tool === 'sync_canvas') {
    project.syncCanvasFromProject()
    revealCanvas()
    return '画布已同步'
  }
  if (tool === 'focus_node') {
    revealCanvas(action.nodeId || 'script')
    return '已定位到画布节点'
  }
  if (tool === 'generate_sheet') {
    const sub = (p.subjects ?? []).find((s) => s.id === action.subjectId) || (p.subjects ?? [])[0]
    if (!sub) return '没有主体'
    await runCanvasNode(`subject:${sub.id}`, progress)
    revealCanvas(`subject:${sub.id}`)
    return `人设 ${sub.name} 完成`
  }
  if (tool === 'generate_all_sheets') {
    await generateMissingSheets((m) => onEvent({ kind: 'log', label: m }))
    revealCanvas('group-subjects')
    return '人设已按缺的补齐'
  }
  if (tool === 'generate_scene') {
    const scn = (p.scenes ?? []).find((s) => s.id === action.sceneId) || (p.scenes ?? [])[0]
    if (!scn) return '没有场景'
    await runCanvasNode(`scene:${scn.id}`, progress)
    revealCanvas(`scene:${scn.id}`)
    return `场景 ${scn.name} 完成`
  }
  if (tool === 'generate_all_scenes') {
    await generateMissingPlates((m) => onEvent({ kind: 'log', label: m }))
    revealCanvas('group-scenes')
    return '场景底板已按缺的补齐'
  }
  if (tool === 'generate_shot_image') {
    const shot = p.shots.find((s) => s.id === action.shotId)
    if (!shot) return '找不到分镜'
    await runCanvasNode(`shotImage:${shot.id}`, progress)
    revealCanvas(`shotImage:${shot.id}`)
    return `分镜 ${shot.index + 1} 配图完成`
  }
  if (tool === 'generate_all_images') {
    await generateMissingImages((m) => onEvent({ kind: 'log', label: m }))
    revealCanvas('group-shots')
    return '缺的配图已补'
  }
  if (tool === 'generate_video') {
    const shot = p.shots.find((s) => s.id === action.shotId)
    if (!shot) return '找不到分镜'
    await runCanvasNode(`shotVideo:${shot.id}`, progress)
    revealCanvas(`shotVideo:${shot.id}`)
    return `分镜 ${shot.index + 1} 视频完成`
  }
  if (tool === 'generate_all_videos') {
    await generateMissingVideos((m) => onEvent({ kind: 'log', label: m }))
    revealCanvas('group-shots')
    return '缺的视频已补'
  }
  if (tool === 'generate_audio') {
    const shot = p.shots.find((s) => s.id === action.shotId)
    if (!shot) return '找不到分镜'
    const nodeId = `audio:${shot.id}`
    await runCanvasNode(nodeId, progress)
    return `分镜 ${shot.index + 1} 口播完成`
  }
  if (tool === 'generate_all_audio') {
    await generateMissingAudio((m) => onEvent({ kind: 'log', label: m }))
    return '缺的口播已补'
  }
  if (tool === 'connect' || tool === 'group') {
    return '画布已按人物 / 场景 / 分镜分组'
  }
  if (tool === 'run_node' && action.nodeId) {
    await runCanvasNode(action.nodeId, progress)
    revealCanvas(action.nodeId)
    return `节点 ${action.nodeId} 完成`
  }
  return `未知工具 ${tool}`
}
