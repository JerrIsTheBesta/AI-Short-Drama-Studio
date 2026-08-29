import { callLLM, getAIMode } from '@/services/ai/client'
import { skillContextForAgent } from '@/skills'
import { useProjectStore } from '@/stores'
import type { Project } from '@/types'
import { sceneHasKeyProps } from '@/utils/consistency'
import { collectStoryBrief, isNewStoryBrief } from '@/utils/storyBrief'
import { rebuildCanvasGraph } from './layout'
import { projectContextPrompt } from './contextBuilder'
import { runAgentLoop } from './agentLoop'
import { getAgentState } from './taskStore'
import {
  continueQuestion,
  clarifyMessage,
  isContinueRequest,
  isVagueRequest,
  isGreetingOrChitchat,
  greetingReply,
  nextPipelineStep,
  extractStageFromText,
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
  kind?: 'log' | 'step' | 'focus' | 'think'
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
export interface AgentRunOptions {
  signal?: AbortSignal
  autonomy?: 'assist' | 'gated' | 'autopilot'
}

const TOOLS_HINT = `你是剧流 Studio 画布上的现场助理。一边干活一边告诉用户画布上发生了什么。

硬性规则：
1. 只输出 JSON：{ "say": "给用户看的话", "actions": [ ... ] }
2. 需求含糊（「帮我做」「开始」这类）时 actions 必须是空数组，say 里主动问主题、时长、只要剧本还是全流程。
3. 剧本严格两步、默认不同轮：generate_play 只写完整 Markdown 剧本（必须含故事背景、人物外貌与状态、环境与场景、分场动作和对白；禁止口播/画面/时长四格表；不创建人物/场景/分镜节点）；用户再说「继续 / 提炼节点」才 extract_cast。禁止同一轮既 generate_play 又 extract_cast，除非用户说了「全流程」。
3b. extract_cast 每次只做当前缺的那一步：先人物，停；再场景，停；再分镜，停。禁止一次拆完。say 里必须说清刚做完哪一步、下一步是什么。已有节点后若用户要改某一组，用 extractStage，不要整表重来。
4. 已有完整剧本时：
   - 用户说「续写 / 接着写 / 再写两场」→ continue_play，保留已有场次。
   - 用户明确说「重新写剧本」，或在讲一个和当前剧本无关的新故事（新题材、新人物、新画风）→ 必须先 seed_script（text=用户这几轮的故事原文，含画风时长题材人物），再 generate_play。禁止 continue_play，禁止拿旧剧本当草稿。
5. 每做完一步，say 里问要不要继续下一步。用户说「继续」才走下一步。用户说「续写」不是流水线的「继续」。
6. 没说「全流程 / 全部做完」禁止一次把人设+场景宫格+故事看板+视频全做完。出视频只传角色设计图、场景图和本镜故事看板，禁止传人物+场景配图。
7. 分镜节点未验收时禁止生成故事看板或视频。用户说「确认通过」才 approve_play；说「继续」= 验收并做下一步。
8. 一次最多 8 个 actions。

可用工具：
{ "tool": "seed_script", "text": "用户这几轮的故事原文，必须完整" }
{ "tool": "generate_play", "text": "可选，与 seed_script 相同的故事原文" }
{ "tool": "continue_play", "text": "续写方向，可选。例如再写两场、写父亲回家之后" }
{ "tool": "extract_cast" }
{ "tool": "extract_cast", "extractStage": "subjects|scenes|shots" }
{ "tool": "generate_storyboard" }
{ "tool": "approve_play" }
{ "tool": "revise_shot", "shotId": "shot_xxx", "visualPrompt": "看板画面与动作，可选", "videoPrompt": "场景叙事：画面中谁是谁；然后连续写这一镜怎么演、怎么说、镜头怎么走", "voiceover": "可选", "duration": 5, "cameraMovement": "static|push|pull|pan|tilt|orbit" }
{ "tool": "generate_sheet", "subjectId": "sub_1" }
{ "tool": "generate_prop_sheet", "sceneId": "scn_1" }
{ "tool": "generate_scene", "sceneId": "scn_1" }
{ "tool": "generate_shot_board", "shotId": "shot_xxx" }
{ "tool": "generate_video", "shotId": "shot_xxx" }
{ "tool": "generate_audio", "shotId": "shot_xxx" }
{ "tool": "generate_all_sheets" }
{ "tool": "generate_all_prop_sheets" }
{ "tool": "generate_all_scenes" }
{ "tool": "generate_all_boards" }
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
    pipelineMode: p?.pipelineMode,
    workflowMode: p?.script?.workflowMode,
    hasShots: shots.length > 0,
    missingSheets: subjects.some((s) => !s.designSheetAssetId),
    missingPlates: scenes.some((s) => !s.plateAssetId || (sceneHasKeyProps(s) && !s.propSheetAssetId)),
    missingImages: shots.some((s) => !s.boardAssetId),
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
  const noImg = p.shots.filter((s) => !s.boardAssetId)
  if (noImg.length) issues.push(`${noImg.length} 镜还没故事看板`)
  const noVid = p.shots.filter((s) => s.boardAssetId && !s.videoAssetId)
  if (noVid.length) issues.push(`${noVid.length} 镜有看板没视频`)
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
  onEvent: AgentProgress,
  options: AgentRunOptions = {}
): Promise<AgentTurnResult> {
  const project = useProjectStore()
  if (!project.current) {
    return { reply: '先打开或新建一个项目。', results: [], chips: [] }
  }

  const p0 = project.current
  if (isGreetingOrChitchat(userText)) {
    const n = nextPipelineStep(p0)
    return {
      reply: greetingReply(p0),
      results: [],
      chips: n
        ? nextChips(n)
        : p0.script?.content?.trim()
          ? clarifyChips(p0)
          : [
              { label: '发主题拆剧本', text: '帮我拆剧本' },
              { label: '全流程', text: '全流程跑完' }
            ]
    }
  }
  if (/^(先看看|先看|等一下|先不|不用了)([，,。!！ ]*)$/.test(userText.trim())) {
    const n = nextPipelineStep(p0)
    return {
      reply: n ? `好，你先看画布。想做「${n.label}」时回「继续」。` : '好，你先看画布。',
      results: [],
      chips: nextChips(n)
    }
  }
  if (
    isVagueRequest(userText, p0) &&
    !wantAll(userText) &&
    !isContinueRequest(userText) &&
    !isApprovePlayRequest(userText) &&
    !isNewStoryBrief(userText, p0)
  ) {
    onEvent({ kind: 'log', label: '需求不够清楚，先问你几句' })
    return { reply: clarifyMessage(p0), results: [], chips: clarifyChips(p0) }
  }

  const skillPack = skillContextForAgent(skillSelectContext(userText))
  const wantQa = skillPack.selected.some((s) => s.id === 'qa-verify')

  let plan: { say: string; actions: any[] }

  if (isContinueRequest(userText) && !wantAll(userText)) {
    plan = continuePlan(p0)
  } else if (getAIMode() === 'real' && !isContinueRequest(userText)) {
    onEvent({ kind: 'think', label: '在想怎么做…' })
    const chat = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    const resp = await callLLM({
      messages: [
        { role: 'system', content: `${TOOLS_HINT}\n\n${skillPack.prompt}` },
        {
          role: 'user',
          content: `当前项目完整上下文：\n${projectContextPrompt(userText)}\n\n上面是状态。下面对话里最后一句才是本轮任务。若用户在讲一个和当前剧本无关的新故事，不要沿用旧剧本。需求含糊就提问，不要瞎做。只修改用户点名的范围。`
        },
        ...chat
      ],
      temperature: 0.2,
      jsonMode: true,
      maxTokens: 2000,
      signal: options.signal,
      timeoutMs: 120_000
    })
    plan = parseAgentJson(resp.content)
    plan.actions = applyPlayGate(
      dedupeActions(alignNewStoryActions(sanitizeActions(plan.actions, userText), userText, history)),
      userText
    )
  } else {
    plan = heuristicPlan(userText)
    plan.actions = applyPlayGate(
      dedupeActions(alignNewStoryActions(plan.actions, userText, history)),
      userText
    )
  }

  const gated =
    !wantAll(userText) &&
    needsPlayReview(project.current) &&
    !isApprovePlayRequest(userText) &&
    !isContinueRequest(userText) &&
    !plan.actions.some(
      (a) => a.tool === 'generate_storyboard' || a.tool === 'generate_play' || a.tool === 'continue_play' || a.tool === 'seed_script'
    )
  if (gated && !plan.actions.length) {
    plan.say = PLAY_GATE_MSG
  }

  if (!plan.actions.length) {
    onEvent({ kind: 'log', label: '先等你确认方向' })
    const chips = gated ? reviewChips() : clarifyChips(project.current)
    return { reply: plan.say || clarifyMessage(project.current), results: [], chips }
  }

  onEvent({ kind: 'log', label: '开始在画布上干活' })
  const autonomy = options.autonomy ?? getAgentState().autonomy
  const loop = await runAgentLoop(plan.actions.slice(0, 8), {
    request: userText,
    autonomy,
    signal: options.signal,
    onEvent,
    replan: getAIMode() === 'real'
      ? async ({ error, completed, remaining, attempt }) => {
          const response = await callLLM({
            messages: [
              {
                role: 'system',
                content: `${TOOLS_HINT}\n\n你正在做失败恢复。只输出 JSON。先根据错误、已完成步骤和最新项目状态判断根因属于：缺少上游产物、输入不合法、产物验收失败、临时服务错误，还是鉴权/额度/用户权限问题。\n- 缺上游：先补最小依赖，再让原目标继续。\n- 输入或产物质量问题：只修改有问题的局部节点，再重试目标。\n- 临时服务错误：允许一次同目标重试。\n- 鉴权、额度、内容安全或必须由用户决定的问题：actions 返回空，不得绕过。\n不要重复已经成功的工具，不要扩大用户授权范围，不要重做无关产物。最多给 4 个修复 actions；AgentLoop 会在修复动作后自动重新验收原目标。`
              },
              {
                role: 'user',
                content: `原任务：${userText}\n第 ${attempt} 次恢复。\n失败工具：${error.tool}\n错误：${error.message}\n已完成：${JSON.stringify(completed)}\n剩余：${JSON.stringify(remaining)}\n最新项目：${projectContextPrompt(userText)}`
              }
            ],
            temperature: 0.1,
            jsonMode: true,
            maxTokens: 1200,
            signal: options.signal,
            timeoutMs: 90_000
          })
          const repaired = parseAgentJson(response.content)
          return applyPlayGate(
            dedupeActions(alignNewStoryActions(sanitizeActions(repaired.actions, userText), userText, history)),
            userText
          ).slice(0, 4)
        }
      : undefined
  })
  const results = loop.results

  if (project.current) {
    const alreadyOnCanvas = results.some(
      (r) => r.ok && (r.tool === 'extract_cast' || r.tool === 'generate_play' || r.tool === 'continue_play')
    )
    if (!alreadyOnCanvas) {
      try {
        project.setCanvas(rebuildCanvasGraph(project.current, true))
      } catch {
        project.setCanvas(rebuildCanvasGraph(project.current, false))
      }
    }
    if (project.dirty) await project.save()
  }

  if (loop.stopped) {
    const ok = results.filter((result) => result.ok).length
    const failed = [...results].reverse().find((result) => !result.ok)
    return {
      reply: `已暂停，没有继续污染下游。${ok ? `前面 ${ok} 步已保留。` : ''}\n失败位置：${TOOL_LABEL[failed?.tool || ''] || failed?.tool}\n原因：${failed?.detail || loop.error?.message}`,
      results,
      chips: [
        { label: '重试失败步骤', text: `重试${TOOL_LABEL[failed?.tool || ''] || '失败步骤'}` },
        { label: '检查配置', text: '帮我检查当前失败原因' }
      ]
    }
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
    ? `\n失败 ${fail.length} 项：${fail.map((f) => `${TOOL_LABEL[f.tool] || f.tool}：${f.detail}`).join('；')}`
    : ''
  const all = wantAll(userText)
  const didPlay = results.some(
    (r) => r.ok && (r.tool === 'generate_play' || r.tool === 'generate_storyboard')
  )
  const didContinue = results.some((r) => r.ok && r.tool === 'continue_play')
  const didBoard = results.some((r) => r.ok && r.tool === 'extract_cast')
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
  if (didContinue) {
    const hasShots = Boolean(p?.shots.length)
    return {
      reply: hasShots
        ? `已经顺着当前剧后续写，原场次保留。\n新场还没进画布节点。到「分镜」分组点重新提取，或回「重新提取分镜」。${failLine}`
        : `已经顺着当前剧后续写，原场次保留。\n看完可再改字，回「继续」先拆人物（不会同时拆场景和分镜）。${failLine}`,
      chips: hasShots
        ? [
            { label: '重新提取分镜', text: '重新提取分镜' },
            { label: '再续写', text: '续写剧本' },
            { label: '先看看', text: '先看看' }
          ]
        : [
            { label: '先拆人物', text: '继续' },
            { label: '再续写', text: '续写剧本' },
            { label: '先看看', text: '先看看' }
          ]
    }
  }
  if (didPlay && !(p?.shots.length)) {
    return {
      reply: `完整剧本已经写到画布左侧了（还没拆节点）。请先看背景、人物和环境写得对不对，再回「继续」只拆人物；场景和分镜要再各走一步。说「全流程」会自动跑完。${failLine}`,
      chips: [
        { label: '先拆人物', text: '继续' },
        { label: '续写', text: '续写剧本' },
        { label: '先看看', text: '先看看' },
        { label: '全流程', text: '全流程跑完' }
      ]
    }
  }
  if (didBoard) {
    const n = p?.shots.length ?? 0
    const subjectCount = p?.subjects?.length ?? 0
    const sceneCount = p?.scenes?.length ?? 0
    if (!n && !sceneCount) {
      return {
        reply: `第 1 步完成：已提炼并保存 ${subjectCount} 个角色。没有同时运行场景和分镜。\n确认人物没问题后，回「继续」再单独提炼场景。${failLine}`,
        chips: [
          { label: '继续提炼场景', text: '继续' },
          { label: '先检查人物', text: '先看看人物' }
        ]
      }
    }
    if (!n) {
      return {
        reply: `第 2 步完成：已保留 ${subjectCount} 个角色，并保存 ${sceneCount} 个场景。\n确认场景没问题后，回「继续」再单独拆分镜。${failLine}`,
        chips: [
          { label: '继续拆分镜', text: '继续' },
          { label: '先检查场景', text: '先看看场景' }
        ]
      }
    }
    return {
      reply: `第 3 步完成：已拆出 ${n} 个分镜，并与现有角色和场景绑定。请先看一遍。\n看完回「继续」做人设和场景；说「全流程」会自动跑完。${failLine}`,
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
      reply: continueQuestion(next, '故事看板已经铺到画布上了。\n') + failLine,
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
    return { reply: `口播好了。可以点「合成视频」节点，结果会显示在视频预览里。${failLine}`, chips: [] }
  }
  const next = nextPipelineStep(p)
  return {
    reply: (fallbackSay || '这一步做完了。') + failLine + (next ? `\n${continueQuestion(next, '')}` : ''),
    chips: nextChips(next)
  }
}

/** 演示模式 / 模型跑偏时：砍掉用户没点名的动作 */
function alignNewStoryActions(
  actions: any[],
  userText: string,
  history: AgentMessage[]
): any[] {
  const p = useProjectStore().current
  if (!isNewStoryBrief(userText, p)) return actions
  const brief = collectStoryBrief(history, userText)
  const triedWrite = actions.some((a) =>
    ['generate_play', 'continue_play', 'seed_script', 'generate_storyboard'].includes(String(a.tool))
  )
  const detailed = brief.length >= 36 || /女主|男主|人物|修仙|炼丹|场景|对白|热梗/.test(brief)
  if (!triedWrite && !detailed) return actions
  const out = actions.filter((a) => a.tool !== 'continue_play' && a.tool !== 'extract_cast')
  const seed = out.find((a) => a.tool === 'seed_script')
  if (seed) seed.text = brief
  else out.unshift({ tool: 'seed_script', text: brief })
  const gen = out.find((a) => a.tool === 'generate_play' || a.tool === 'generate_storyboard')
  if (gen) gen.text = brief
  else out.push({ tool: 'generate_play', text: brief })
  return out
}

function sanitizeActions(actions: any[], userText: string): any[] {
  const all = wantAll(userText)
  const t = userText
  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜|写剧本|提炼节点|拆剧本|续写|接着写|再写/.test(t)
  const askedSheet = /人设|角色图|四视图/.test(t)
  const askedProp = /资产图|道具图|关键道具/.test(t)
  const askedScene = /场景图|底板|出场景|生成场景/.test(t)
  const askedPanel = /故事看板|看板图|线稿分镜/.test(t)
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
    if (tool === 'generate_all_prop_sheets') return askedProp || askedSheet || all
    if (tool === 'generate_all_scenes') return askedScene || all
    if (tool === 'generate_all_boards') return askedPanel || all
    if (tool === 'generate_all_images') return askedImage || all
    if (tool === 'generate_all_videos') return askedVideo || all
    if (tool === 'generate_all_audio') return askedAudio || all
    if (tool === 'generate_storyboard' || tool === 'extract_cast' || tool === 'generate_play' || tool === 'continue_play') {
      return askedBoard || all || isNewStoryBrief(t, useProjectStore().current)
    }
    if (tool === 'generate_sheet') return askedSheet || all
    if (tool === 'generate_prop_sheet') return askedProp || askedSheet || all
    if (tool === 'generate_scene') return askedScene || all
    if (tool === 'generate_shot_board') return askedPanel || shotHit || all
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
    const hasBoard = out.some(
      (a) =>
        a.tool === 'generate_storyboard' ||
        a.tool === 'extract_cast' ||
        a.tool === 'continue_play'
    )
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
    (a) =>
      a.tool === 'generate_storyboard' ||
      a.tool === 'generate_play' ||
      a.tool === 'continue_play' ||
      a.tool === 'extract_cast' ||
      a.tool === 'seed_script'
  )
  if (hasBoard) {
    const kept = actions.filter(
      (a) =>
        a.tool === 'generate_storyboard' ||
        a.tool === 'generate_play' ||
        a.tool === 'continue_play' ||
        a.tool === 'extract_cast' ||
        a.tool === 'seed_script' ||
        a.tool === 'sync_canvas' ||
        a.tool === 'focus_node'
    )
    const writingPlay = kept.some(
      (a) => a.tool === 'generate_play' || a.tool === 'generate_storyboard' || a.tool === 'continue_play'
    )
    // 非全流程：写剧本和提炼拆开，同一轮只写剧本
    if (writingPlay) {
      return kept.filter((a) => a.tool !== 'extract_cast')
    }
    return kept
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

  const askedExtract = /提炼节点|提炼人物|提炼场景|拆节点|出节点|重新提取|重新提炼/.test(t)
  const askedContinuePlay = /续写|接着写|再写[一两三四\d]*场|加一场|往后写|续一[场段]|写下去/.test(t)
  const askedPlay = /写剧本|完整剧本|重新写剧本/.test(t) && !askedContinuePlay
  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜|拆剧本/.test(t)
  const askedSheet = /人设|角色图|四视图/.test(t)
  const askedProp = /资产图|道具图|关键道具/.test(t)
  const askedScene = /场景图|底板|出场景|生成场景/.test(t)
  const askedPanel = /故事看板|看板图|线稿分镜/.test(t)
  const askedImage = /配图|出图|关键帧|把图画上|缺的图/.test(t)
  const askedVideo = /图生视频|生成视频|出视频/.test(t) || /第.+镜.*视频/.test(t)
  const askedAudio = /口播|配音|语音/.test(t)
  const looksLikeBrief =
    t.length >= 16 &&
    !askedSheet &&
    !askedProp &&
    !askedImage &&
    !askedVideo &&
    !askedScene &&
    !p.shots.length &&
    !p.script?.playReady
  const playReady = Boolean(p.script?.playReady && p.script.content?.trim())
  const newStory = isNewStoryBrief(t, p)

  if (newStory) {
    actions.push({ tool: 'seed_script', text: t })
    actions.push({ tool: 'generate_play', text: t })
  } else if (!p.script?.content?.trim() && (askedBoard || askedPlay || looksLikeBrief || all)) {
    actions.push({ tool: 'seed_script', text: t })
  }
  if (!newStory && askedContinuePlay && playReady) {
    actions.push({ tool: 'continue_play', text: t })
  } else if (!newStory && (askedExtract || (askedBoard && playReady && !p.shots.length))) {
    const extractStage = extractStageFromText(t)
    actions.push({ tool: 'extract_cast', ...(extractStage ? { extractStage } : {}) })
  } else if (!newStory && (askedPlay || askedBoard || looksLikeBrief)) {
    actions.push({ tool: 'generate_play' })
  }

  if (namedSubs.length && askedSheet) {
    for (const s of namedSubs) actions.push({ tool: 'generate_sheet', subjectId: s.id })
  } else if (askedSheet) {
    actions.push({ tool: 'generate_all_sheets' })
  }
  if (namedScns.length && askedProp && !askedSheet) {
    for (const s of namedScns) actions.push({ tool: 'generate_prop_sheet', sceneId: s.id })
  } else if (askedProp && !askedSheet) {
    actions.push({ tool: 'generate_all_prop_sheets' })
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
      if (askedVideo && !askedImage && !askedPanel) {
        actions.push({ tool: 'generate_video', shotId: shot.id })
      } else if (askedAudio && !askedImage && !askedVideo && !askedPanel) {
        actions.push({ tool: 'generate_audio', shotId: shot.id })
      } else if (askedPanel && !askedImage) {
        actions.push({ tool: 'generate_shot_board', shotId: shot.id })
      } else {
        actions.push({ tool: 'generate_shot_image', shotId: shot.id })
        if (askedVideo) actions.push({ tool: 'generate_video', shotId: shot.id })
      }
    }
  } else {
    if (askedPanel) actions.push({ tool: 'generate_all_boards' })
    if (askedImage) actions.push({ tool: 'generate_all_images' })
    if (askedVideo) actions.push({ tool: 'generate_all_videos' })
    if (askedAudio) actions.push({ tool: 'generate_all_audio' })
  }

  if (all) {
    if (!playReady && !actions.some((a) => a.tool === 'generate_play')) {
      actions.push({ tool: 'generate_play' })
    }
    if (!p.shots.length && !actions.some((a) => a.tool === 'extract_cast')) {
      actions.push({ tool: 'extract_cast' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_sheets')) {
      actions.push({ tool: 'generate_all_sheets' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_prop_sheets')) {
      actions.push({ tool: 'generate_all_prop_sheets' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_scenes')) {
      actions.push({ tool: 'generate_all_scenes' })
    }
    if (!actions.some((a) => a.tool === 'generate_all_boards')) {
      actions.push({ tool: 'generate_all_boards' })
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
      say: '你想让我做哪一步？可以说：写剧本、续写、提炼节点、确认通过、出人设、第1镜配图。说「全流程」才会整条跑。',
      actions: []
    }
  }
  if (newStory && !all) {
    return { say: '按你这轮说的新故事重写剧本，不再沿用旧稿。', actions }
  }
  if (askedExtract && !all) {
    return { say: '按完整剧本提炼人物、场景、分镜节点。', actions }
  }
  if (askedContinuePlay && !all) {
    return { say: '顺着当前剧本往后加场，已有场次和台词不动。', actions }
  }
  if ((askedPlay || askedBoard || looksLikeBrief) && !all) {
    return { say: '先写完整剧本，还不拆节点。写完看左侧，回「继续」再提炼。', actions }
  }
  return { say: '按你这句做，不加别的步骤。', actions }
}
