import { callLLM, getAIMode } from '@/services/ai/client'
import { skillContextForAgent } from '@/skills'
import { useProjectStore } from '@/stores'
import type { Project } from '@/types'
import { shotsMissingKeyframe, shotsMissingStoryboard } from '@/utils/videoStill'
import { collectStoryBrief, isNewStoryBrief } from '@/utils/storyBrief'
import { rebuildCanvasGraph } from './layout'
import { projectContextPrompt } from './contextBuilder'
import { runAgentLoop } from './agentLoop'
import { buildMaterialBlock, type AgentAttachment } from './attachments'
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
import { detectIntent, type AgentIntent } from './intent'
import { buildPlanFromActions } from './planner'
import {
  forgetMemory,
  memoryContextPrompt,
  parseForgetRequest,
  parseRememberRequest,
  rememberMemory
} from '@/services/memory/memoryStore'

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
  kind?: 'log' | 'step' | 'focus' | 'think' | 'intent' | 'plan'
  label: string
  step?: string
  status?: 'running' | 'done' | 'fail'
  nodeId?: string
  plan?: import('./planner').AgentPlan
}

export type AgentProgress = (ev: AgentEvent) => void

/** 单轮最多执行多少个画布动作。放宽上限，别把用户的整句需求切碎。 */
const MAX_ACTIONS_PER_TURN = 12

export interface AgentTurnResult {
  reply: string
  results: AgentToolResult[]
  chips: { label: string; text: string }[]
}
export interface AgentRunOptions {
  signal?: AbortSignal
  autonomy?: 'assist' | 'gated' | 'autopilot'
  /** 已废弃：合并后不再按模式分叉，路线由意图与画布状态决定 */
  mode?: 'drama' | 'freeform'
  /** 当前在画布上选中的自由生成节点 */
  selectedNodeId?: string
  /** 用户在对话框附加的本地文件（文本内容已读入） */
  attachments?: AgentAttachment[]
}

const TOOLS_HINT = `你是剧流 Studio 画布上的现场助理。一边干活一边告诉用户画布上发生了什么。

硬性规则：
1. 只输出 JSON：{ "say": "给用户看的话", "actions": [ ... ], "done": false }。actions 是“下一小批”真实画布操作，不是一次性的建议清单；工具执行后你会重新看到最新画布并继续判断。确认用户目标已经落到画布上时返回 done=true、actions=[]。
1b. 你的本职是「动手帮忙」：操作画布（建/连/改/删/重跑节点、整理排布）、检查并修复错误、写专业剧本与分镜。默认直接动手把它做完，只在会烧掉大量额度或不可逆的批量生成上才先跟用户确认。没把握的地方宁可问清楚再动，但不要因为怕动画布而只给建议。
2. 需求含糊（「帮我做」「开始」这类）时 actions 必须是空数组，say 里主动问主题、时长、只要剧本还是全流程。
3. 剧本严格两步、默认不同轮：generate_play 只写完整 Markdown 剧本。写剧本、改编、续写必须按 ai-short-film-screenwriter 的故事引擎、改编硬约束、节拍、AI 制作约束和逐场规则来；成稿前自检。必须含一句话故事、对抗引擎、完整梗概、人物小传（主角/对手/关键亲人，含欲望恐惧弧光）、环境与场景、每场场次任务、分场动作和对白；禁止口播/画面/时长四格表；禁止把传说压成高潮切片；禁止默片，相认/唤名/对峙/问答必须有出镜对白往来；不创建人物/场景/分镜节点。用户再说「继续 / 提炼节点」才 extract_cast。禁止同一轮既 generate_play 又 extract_cast，除非用户说了「全流程」。
3b. extract_cast 每次只做当前缺的那一步：先人物，停；再场景，停；再分镜，停。禁止一次拆完。say 里必须说清刚做完哪一步、下一步是什么。已有节点后若用户要改某一组，用 extractStage，不要整表重来。
4. 已有完整剧本时：
   - 用户说「续写 / 接着写 / 再写两场」→ continue_play，保留已有场次。
   - 用户明确说「重新写剧本」，或在讲一个和当前剧本无关的新故事（新题材、新人物、新画风）→ 必须先 seed_script（text=用户这几轮的故事原文，含画风时长题材人物），再 generate_play。禁止 continue_play，禁止拿旧剧本当草稿。
5. 批量、耗时、不可逆的生成（补齐全部人设图 / 全部场景 / 全部关键帧 / 全部视频 / 全部配音）默认一次做一小批，做完在 say 里点明下一步，用户说「继续 / 全流程」再往下；其余所有操作——建节点、连线、删节点、改提示词、重命名、重跑单个节点、重排画布、体检——用户说一次就一次做完，不要分批磨。
6. 普通创作不生成故事看板，用人设图和场景图画「这一镜正在发生的事件」关键帧，再出视频。AI 短剧才走故事看板。
7. 分镜节点未验收时禁止生成故事看板或视频。用户说「确认通过」才 approve_play；说「继续」= 验收并做下一步。这条只管流水线动作，不拦手动添加节点、单个自由节点生成、改提示词。
8. 一次最多 12 个 actions。能用工具完成的请求必须实际操作画布，不要只回复教程。先修改节点提示词，再按用户要求生成对应图片或视频；每批执行后依据新的资产状态验收，禁止无意义重复成功工具。新建自由节点时本批只 create，下一轮从最新画布取得真实 nodeId 后再 run_node，禁止臆造 ID。
9. 画布不分模式：同一张画布既能跑剧本流水线（seed_script / generate_play / extract_cast / …），也能只操作单个生成节点（create_image_node / create_video_node / update_node / run_node）。按用户这句话选——说了剧本、分镜、人设、场景就走流水线；只说「画一张…」「做个 8 秒视频」「把这个节点改一下」就只做单个节点。单个节点的操作可以直接做完并生成。
10. 用户说「给某个节点 / 给选中的节点加一个图片或视频节点」「接上」「连起来」这类派生/接续需求，create_image_node / create_video_node 必须带 sourceNodeId（没点名就填「用户当前选中的节点」的 id），工具会把它放在上游节点右边并自动连线、把上游产出作为参考图传给下游；已有两个节点要连起来用 connect_nodes。禁止只创建不连线。

可用工具：
{ "tool": "seed_script", "text": "用户这几轮的故事原文，必须完整" }
{ "tool": "generate_play", "text": "可选，与 seed_script 相同的故事原文" }
{ "tool": "continue_play", "text": "续写方向，可选。例如再写两场、写父亲回家之后" }
{ "tool": "extract_cast" }
{ "tool": "extract_cast", "extractStage": "subjects|scenes|shots" }
{ "tool": "generate_storyboard" }
{ "tool": "approve_play" }
{ "tool": "revise_shot", "shotId": "shot_xxx", "visualPrompt": "静帧/关键帧画面，可选", "imagePrompt": "实际出图提示词，可选", "videoPrompt": "实际发给视频模型的动态导演提示词：起幅、触发、动作链、运镜、落幅、同步声音", "voiceover": "可选", "duration": 5, "cameraMovement": "static|push|pull|pan|tilt|orbit" }
{ "tool": "generate_sheet", "subjectId": "sub_1" }
{ "tool": "generate_scene", "sceneId": "scn_1" }
{ "tool": "generate_shot_board", "shotId": "shot_xxx" }
{ "tool": "generate_video", "shotId": "shot_xxx" }
{ "tool": "generate_audio", "shotId": "shot_xxx" }
{ "tool": "generate_all_sheets" }
{ "tool": "generate_all_scenes" }
{ "tool": "generate_all_boards" }
{ "tool": "generate_all_images" }
{ "tool": "generate_all_videos" }
{ "tool": "generate_all_audio" }
{ "tool": "sync_canvas" }
{ "tool": "focus_node", "nodeId": "script" }
{ "tool": "create_image_node", "text": "完整出图提示词", "sourceNodeId": "可选，上游节点 id；填了会把新节点放在该节点右边并自动连线" }
{ "tool": "create_video_node", "text": "完整动态导演提示词", "duration": 8, "sourceNodeId": "可选，上游节点 id；「给某个节点加个视频节点」时必填" }
{ "tool": "connect_nodes", "sourceNodeId": "上游节点 id", "targetNodeId": "下游节点 id" }
{ "tool": "delete_node", "nodeId": "要删的自由图片/视频节点 id" }
{ "tool": "arrange_canvas" }
{ "tool": "check_project" }
{ "tool": "update_node", "nodeId": "imageGen_xxx 或 videoGen_xxx", "text": "新的完整提示词", "nodeLabel": "新的节点名，可选", "duration": 8 }
{ "tool": "run_node", "nodeId": "画布上下文中的节点 id" }
{ "tool": "optimize_node_prompt", "nodeId": "imageGen_xxx 或 videoGen_xxx", "text": "优化方向，可选，例如：更有画面感、写清动作表情" }
{ "tool": "remember", "text": "要长期记住的用户偏好或事实（用户说「记住/以后都」时必用）" }
{ "tool": "forget", "text": "要忘掉的记忆关键词" }

问答与记忆规则：
9. 用户在问问题、求建议、聊创作思路（不动画布）时，直接把你懂的写进 say，actions 返回空数组；答得具体，结合当前项目上下文和已记住的偏好。
10. 用户说「记住…/以后都…」→ 用 remember；说「忘掉…」→ 用 forget。这类操作不需要其他动作。`

function parseAgentJson(text: string): { say: string; actions: any[]; done: boolean } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { say: text.slice(0, 400), actions: [], done: true }
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      say: String(obj.say || '好的'),
      actions: Array.isArray(obj.actions) ? obj.actions : [],
      done: obj.done === true
    }
  } catch {
    return { say: text.slice(0, 400), actions: [], done: true }
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
    missingPlates: scenes.some((s) => !s.plateAssetId),
    missingImages: Boolean(
      p && (shotsMissingStoryboard(p).length || shotsMissingKeyframe(p).length)
    ),
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
  const noBoard = shotsMissingStoryboard(p)
  const noKf = shotsMissingKeyframe(p)
  if (noBoard.length) issues.push(`${noBoard.length} 镜还没故事看板`)
  if (noKf.length) issues.push(`${noKf.length} 镜还没关键帧`)
  const noVid = p.shots.filter((s) => !s.videoAssetId)
  if (noVid.length) issues.push(`${noVid.length} 镜还没视频`)
  const unbound = p.shots.filter((s) => !s.sceneId || !(s.subjectIds && s.subjectIds.length))
  if (unbound.length) issues.push(`${unbound.length} 镜没绑人物或场景`)
  if (!issues.length) return '**清单过了一遍**，目前能往下剪。'
  return `**还有 ${issues.length} 处要补**\n\n${issues.map((s) => `- ${s}`).join('\n')}`
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

  // ── 意图识别：先判断这句话想干什么，再决定走哪条路 ──
  // 附件 / 消息里的本地文件路径 → 读成材料块，拼在本轮任务前面。
  const material = await buildMaterialBlock(userText, options.attachments, (label) =>
    onEvent({ kind: 'log', label })
  )
  if (material) userText = `${material}\n\n${userText}`
  const hasPipeline = hasPipelineData(p0)
  const intent = detectIntent(userText, {
    hasPipeline,
    project: p0,
    hasSelectedGenNode: Boolean(options.selectedNodeId)
  })
  onEvent({ kind: 'intent', label: intent.label })

  // 合并模式：不再按项目模式分叉，而是按「这句话 + 画布当前状态」决定走节点路径还是流水线路径
  const nodePath = resolveNodePath(intent, p0, userText)
  // 只在「这句话明确是单个节点需求」时才收紧工具集；意图含糊时不硬拦，避免模型想做却被静默过滤掉
  const restrictToNodes =
    !hasPipeline && (intent.kind === 'create_asset' || intent.kind === 'prompt_polish')

  // 显式记忆指令：直接写本地记忆，不进任务规划
  if (intent.kind === 'remember') {
    const req = parseRememberRequest(userText)
    if (req) {
      const entry = await rememberMemory(req.content, { kind: req.kind, scope: req.scope })
      if (entry) {
        onEvent({ kind: 'log', label: `已写入本地记忆（${req.scope === 'global' ? '长期' : '本项目'}）` })
        return {
          reply: `记住了：${entry.content}\n${req.scope === 'global' ? '长期有效，之后的所有项目都会带上。' : '只在当前项目里生效。'}`,
          results: [],
          chips: [{ label: '查看记忆', text: '查看记忆' }]
        }
      }
    }
  }
  if (intent.kind === 'forget') {
    const keyword = parseForgetRequest(userText)
    if (keyword) {
      const removed = await forgetMemory(keyword)
      return {
        reply: removed ? `已忘掉：${removed}` : `没有找到和「${keyword}」相关的记忆。`,
        results: [],
        chips: []
      }
    }
  }
  // 进度查询 / 质检：确定性汇总，不消耗模型调用
  if (intent.kind === 'status') {
    onEvent({ kind: 'log', label: '正在盘点画布与项目状态' })
    return { reply: statusNotes(p0), results: [], chips: statusChips(p0) }
  }
  // 纯问答 / 咨询：不动画布，结合记忆与项目上下文直接回答
  if (intent.kind === 'question') {
    return answerQuestion(userText, history, p0, onEvent, options)
  }
  // 选中节点的提示词优化：快路径，不等规划
  if (intent.kind === 'prompt_polish') {
    const nodeId = options.selectedNodeId || findGenNodeInText(p0, userText)
    if (nodeId) {
      const plan0 = {
        say: '按你说的方向加厚这个节点的提示词，只补画面细节，不动原文格式。',
        actions: [{ tool: 'optimize_node_prompt', nodeId, text: userText }]
      }
      onEvent({ kind: 'plan', label: '计划 1 步：优化节点提示词', plan: buildPlanFromActions(plan0.actions as any, intent.label) })
      onEvent({ kind: 'log', label: '开始在画布上干活' })
      const loop0 = await runAgentLoop(plan0.actions, {
        request: userText,
        autonomy: options.autonomy ?? getAgentState().autonomy,
        signal: options.signal,
        onEvent
      })
      const r0 = loop0.results
      if (loop0.stopped) {
        const failed = [...r0].reverse().find((r) => !r.ok)
        return {
          reply: `提示词优化没成功。${failed ? `\n原因：${failed.detail}` : ''}`,
          results: r0,
          chips: [{ label: '重试', text: '再优化一次当前节点提示词' }]
        }
      }
      return {
        reply: r0[0]?.detail || '提示词已加厚，写回节点了。',
        results: r0,
        chips: [
          { label: '生成这个节点', text: `生成节点 ${nodeId}` },
          { label: '再厚一点', text: '继续加厚当前节点提示词，画面再具体一点' }
        ]
      }
    }
    return {
      reply:
        '先在画布上点选一个图片或视频节点，再告诉我要往哪个方向优化；也可以直接说「新建一个…节点」。',
      results: [],
      chips: statusChips(p0)
    }
  }

  if (
    !nodePath &&
    getAIMode() !== 'real' &&
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

  let plan: { say: string; actions: any[]; done?: boolean }

  if (isContinueRequest(userText) && !wantAll(userText)) {
    plan = continuePlan(p0)
  } else if (getAIMode() === 'real' && !isContinueRequest(userText)) {
    onEvent({ kind: 'think', label: '在想怎么做…' })
    const memoryText = await memoryContextPrompt()
    const chat = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `${TOOLS_HINT}\n\n${skillPack.prompt}${restrictToNodes ? `\n\n${NODE_PATH_RULE}` : ''}${memoryText ? `\n\n${memoryText}\n回答和规划时必须尊重上面的记忆。` : ''}`
        },
        {
          role: 'user',
          content: `当前项目上下文（按本轮需求摘录的摘要，明细不全；工具执行时读的是实时数据，需要更多信息就用工具查）：\n${projectContextPrompt(userText)}\n\n上面是状态。下面对话里最后一句才是本轮任务。若用户在讲一个和当前剧本无关的新故事，不要沿用旧剧本。需求含糊就提问，不要瞎做。只修改用户点名的范围。${options.selectedNodeId ? `\n用户当前选中的节点：${options.selectedNodeId}（没点名其他节点时默认操作它）` : ''}`
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
    plan.actions = gateModeActions(
      applyPlayGate(
        dedupeActions(alignNewStoryActions(sanitizeActions(plan.actions, userText), userText, history)),
        userText
      ),
      restrictToNodes
    )
  } else {
    if (nodePath) {
      const nodePlan = freeformHeuristicPlan(userText, options.selectedNodeId)
      // 单节点规则没命中时回退到流水线规则，避免空手而归
      plan = nodePlan.actions.length ? nodePlan : heuristicPlan(userText)
    } else {
      plan = heuristicPlan(userText)
    }
    plan.actions = gateModeActions(
      applyPlayGate(
        dedupeActions(alignNewStoryActions(plan.actions, userText, history)),
        userText
      ),
      restrictToNodes
    )
  }

  // 验收门只挡「流水线下游动作」：手动加单个节点、单节点生成、改提示词不受阻
  const hitDownstream = plan.actions.some((a) => isDownstreamAction(a, project.current))
  const gated =
    hitDownstream &&
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
    if (nodePath) {
      return {
        reply: plan.say || '直接说你想画什么、改哪个节点，我来动手。',
        results: [],
        chips: statusChips(project.current)
      }
    }
    const chips = gated ? reviewChips() : clarifyChips(project.current)
    return { reply: plan.say || clarifyMessage(project.current), results: [], chips }
  }

  // ── 任务规划：把动作整理成用户可读的计划卡片，执行中同步状态 ──
  try {
    const agentPlan = buildPlanFromActions(plan.actions.slice(0, MAX_ACTIONS_PER_TURN), intent.label)
    onEvent({ kind: 'plan', label: agentPlan.summary, plan: agentPlan })
  } catch {
    /* 计划卡片生成失败不阻断执行 */
  }
  onEvent({ kind: 'log', label: '开始在画布上干活' })
  const autonomy = options.autonomy ?? getAgentState().autonomy
  const loop = await runAgentLoop(plan.actions.slice(0, MAX_ACTIONS_PER_TURN), {
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
      : undefined,
    continue: getAIMode() === 'real' && autonomy !== 'assist'
      ? async ({ completed, results: observedResults, round }) => {
          const response = await callLLM({
            messages: [
              {
                role: 'system',
                content: `${TOOLS_HINT}\n\n你现在处于同一个任务的第 ${round} 次观察。工具已经真实执行，项目状态已经改变。请对照原始任务逐项验收：\n- 需要写/改提示词：确认目标分镜字段已经具体、可拍、动态，不是静态模板。\n- 需要出图/视频：确认对应资产字段已经存在；如果提示词刚改导致旧资产失效，再生成一次。\n- 需要操控节点：使用 focus_node、run_node、sync_canvas 或对应的精确生成工具。\n- 目标已经完成：done=true 且 actions=[]，say 简洁报告实际完成内容。\n- 仍缺一步：done=false，只给下一小批必要动作。\n禁止重复已成功且未被后续修改失效的工具，禁止扩大原始请求范围，禁止把“建议用户自己点”冒充完成。`
              },
              {
                role: 'user',
                content: `原始任务：${userText}\n\n已执行动作：${JSON.stringify(completed)}\n执行结果：${JSON.stringify(observedResults)}\n\n最新画布与项目状态：\n${projectContextPrompt(userText)}`
              }
            ],
            temperature: 0.1,
            jsonMode: true,
            maxTokens: 2400,
            signal: options.signal,
            timeoutMs: 120_000
          })
          const next = parseAgentJson(response.content)
          const actions = applyPlayGate(
            dedupeActions(alignNewStoryActions(sanitizeActions(next.actions, userText), userText, history)),
            userText
          ).slice(0, MAX_ACTIONS_PER_TURN)
          return {
            say: next.say,
            actions,
            done: next.done || !actions.length
          }
        }
      : undefined
  })
  const results = loop.results

  if (project.current) {
    const alreadyOnCanvas = nodePath || results.some(
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

  if (nodePath) {
    const fails = results.filter((r) => !r.ok)
    const failLine = fails.length
      ? `\n失败 ${fails.length} 项：${fails.map((f) => `${TOOL_LABEL[f.tool] || f.tool}：${f.detail}`).join('；')}`
      : ''
    return {
      reply: (loop.finalSay || plan.say || '搞定了，画布已更新。') + failLine,
      results,
      chips: statusChips(project.current)
    }
  }

  const wrap = wrapUpReply(results, userText, plan.say)
  const qa = wantQa && project.current ? `\n${qaNotes(project.current)}` : ''
  return { reply: (loop.finalSay || wrap.reply) + qa, results, chips: wrap.chips }
}

const NODE_PATH_RULE = `这条需求属于「单个节点」操作。常用的是 create_image_node、create_video_node、connect_nodes、update_node、delete_node、arrange_canvas、check_project、optimize_node_prompt、run_node、focus_node、sync_canvas、remember、forget。除非用户明确要写剧本、拆人物场景分镜或做一整条片子，否则不要动 generate_play、extract_cast 这类流水线工具。用户没点名节点时，优先操作「用户当前选中的节点」。`

/** 项目里是否已经有流水线产物（剧本 / 人物 / 场景 / 分镜） */
function hasPipelineData(p: Project | null | undefined): boolean {
  if (!p) return false
  return Boolean(
    p.shots.length ||
      (p.subjects?.length ?? 0) > 0 ||
      (p.scenes?.length ?? 0) > 0 ||
      p.script?.content?.trim()
  )
}

/**
 * 合并后不再看项目模式，只按「这句话的意图 + 画布现状」决定路线：
 * node = 单个节点操作（建图片/视频节点、改提示词、重跑节点）
 * flow = 流水线推进（写剧本、拆人物场景分镜、批量出图出视频）
 */
function resolveNodePath(
  intent: { kind: string },
  p: Project | null | undefined,
  userText: string
): boolean {
  if (intent.kind === 'create_asset' || intent.kind === 'prompt_polish') return true
  if (intent.kind === 'pipeline') return false
  if (intent.kind === 'edit_canvas') return !hasPipelineData(p)
  if (intent.kind === 'task') return NODE_REQUEST.test(userText)
  return !hasPipelineData(p)
}

/** 「画一张…」「做个 8 秒视频」这类只针对单个节点的需求 */
const NODE_REQUEST =
  /画一?[张幅个]|做一?[个条]|生成一?[张个条]|出一张|图片|图像|视频节点|出图|一张图|一段视频/i

/** 这个动作是否属于「流水线下游」——只有它才需要先验收剧本 */
function isDownstreamAction(a: any, p: Project | null | undefined): boolean {
  const tool = String(a?.tool || '')
  if (!tool) return false
  if (tool === 'run_node') {
    const node = (p?.canvas?.nodes ?? []).find((n) => n.id === a.nodeId)
    if (!node) return false
    return node.type !== 'imageGen' && node.type !== 'videoGen'
  }
  return /^(generate_|extract_)/.test(tool)
}

/** 只在「空画布 + 单节点需求」时收紧工具集，其余情况全放开 */
function gateModeActions(actions: any[], restrictToNodes: boolean): any[] {
  if (!restrictToNodes) return actions
  const allowed = new Set([
    'create_image_node',
    'create_video_node',
    'connect_nodes',
    'delete_node',
    'arrange_canvas',
    'check_project',
    'update_node',
    'optimize_node_prompt',
    'run_node',
    'focus_node',
    'sync_canvas',
    'remember',
    'forget'
  ])
  return actions.filter((a) => allowed.has(String(a?.tool || '')))
}

/** 在用户文本里找被点名的自由生成节点 */
function findGenNodeInText(p: Project, text: string): string | null {
  const nodes = (p.canvas?.nodes ?? []).filter(
    (n) => n.type === 'imageGen' || n.type === 'videoGen'
  )
  for (const node of nodes) {
    if (node.data.label && text.includes(node.data.label)) return node.id
    if (text.includes(node.id)) return node.id
  }
  return null
}

/** 自由生成节点（图片 / 视频节点）的进度小结；没有这类节点时返回空 */
function genNodeNotes(p: Project): string {
  const nodes = (p.canvas?.nodes ?? []).filter(
    (n) => n.type === 'imageGen' || n.type === 'videoGen'
  )
  if (!nodes.length) return ''
  const done = nodes.filter((n) => n.data.outputAssetId).length
  const running = nodes.filter((n) => n.status === 'running' || n.status === 'pending').length
  const failed = nodes.filter((n) => n.status === 'failed' || n.error)
  const lines = [`**画布节点**：共 ${nodes.length} 个生成节点，${done} 个已有产出`]
  if (running) lines.push(`- ${running} 个正在生成`)
  if (failed.length) {
    lines.push(
      `- ${failed.length} 个失败：${failed
        .slice(0, 3)
        .map((n) => `「${n.data.label || n.id}」${n.error ? `（${n.error.slice(0, 40)}）` : ''}`)
        .join('、')}`
    )
  }
  return lines.join('\n')
}

/** 合并后的进度盘点：流水线进度 + 自由节点进度一起报 */
function statusNotes(p: Project): string {
  const parts: string[] = []
  if (hasPipelineData(p)) parts.push(qaNotes(p))
  const gen = genNodeNotes(p)
  if (gen) parts.push(gen)
  if (!parts.length) {
    return '**画布还是空的。** 直接在左边说一句话我就开工（例如「写一个修仙短剧，8 个分镜」），也可以在空白处右键手动添加图片 / 视频 / 剧本 / 角色 / 场景 / 分镜节点。'
  }
  return parts.join('\n\n')
}

function statusChips(p: Project | null | undefined): { label: string; text: string }[] {
  const chips: { label: string; text: string }[] = []
  const next = nextPipelineStep(p)
  if (next && (p?.shots.length || p?.script?.content?.trim())) {
    chips.push({ label: `继续：${next.label}`, text: '继续' })
  }
  const failed = (p?.canvas?.nodes ?? []).find(
    (n) => (n.type === 'imageGen' || n.type === 'videoGen') && (n.status === 'failed' || n.error)
  )
  if (failed) chips.push({ label: '重跑失败节点', text: `重新生成节点 ${failed.id}` })
  chips.push({ label: '帮我画一张图', text: '帮我创建一个图片节点并生成：' })
  chips.push({ label: '全流程', text: '全流程跑完' })
  return chips.slice(0, 3)
}

/** 问答 / 咨询：不操作画布，结合记忆和项目状态直接回答 */
async function answerQuestion(
  userText: string,
  history: AgentMessage[],
  p: Project,
  onEvent: AgentProgress,
  options: AgentRunOptions
): Promise<AgentTurnResult> {
  if (getAIMode() !== 'real') {
    return { reply: capabilityNotes(p), results: [], chips: statusChips(p) }
  }
  onEvent({ kind: 'think', label: '在组织回答…' })
  const memoryText = await memoryContextPrompt()
  const chat = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-8)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `你是剧流 Studio（AI 短剧工作台）画布上的智能助手，精通 AI 短剧、AI 图片与视频制作流程、提示词写法。用户在创作过程中向你提问或求建议。
要求：
- 直接回答，不要假装执行了画布操作，不要输出 JSON。
- 结合给出的项目状态${memoryText ? '、用户记忆' : ''}作答，答得具体，别泛泛而谈。
- 口语化，可以分点，但别写成八股文。答完可以顺嘴提一个可行的下一步。
- 用 Markdown 排版：要点用「- 」列表，关键结论用 **加粗**，提示词 / 示例用三个反引号围起来的代码块，超过三个要点就用小标题分段。
- 正文控制在 500 字以内，能短就短。
${memoryText ? `\n${memoryText}` : ''}`
        },
        {
          role: 'user',
          content: `当前项目状态（仅供参考，不需要操作）：\n${projectContextPrompt(userText)}`
        },
        ...chat
      ],
      temperature: 0.5,
      maxTokens: 1200,
      signal: options.signal,
      timeoutMs: 90_000
    })
    const reply = resp.content.trim()
    return {
      reply: reply || '这个问题我一时没组织好语言，换个问法试试。',
      results: [],
      chips: statusChips(p)
    }
  } catch (e: any) {
    if (options.signal?.aborted) throw e
    return { reply: capabilityNotes(p), results: [], chips: [] }
  }
}

/** 演示模式 / 问答兜底：说清自己能干什么（两种创作方式合一） */
function capabilityNotes(p: Project): string {
  const hasScript = Boolean(p.script?.content?.trim())
  return `**我能做的事**

- 写 / 改 / 续写剧本，拆人物、场景、分镜
- 出人设图、场景图、关键帧、分镜视频和口播
- 按你一句话创建图片 / 视频节点并直接生成
- 改任意一镜或任意节点的提示词、运镜、时长
- 检查进度、补齐缺漏（说「全流程」会整条跑完）
- 记住你的偏好（说「记住…」）

两种用法都行：左边直接说一句话我一路做下去，也可以在画布空白处右键手动加节点自己拼。

${
  hasScript
    ? '当前已有剧本，回「继续」往下走，或直接点明要改哪一镜。'
    : '先给我一个故事主题或一段剧情，我来拆剧本；或者直接说「画一张…」。'
}`
}

/** 演示模式下自由画布的规则规划 */
function freeformHeuristicPlan(
  userText: string,
  selectedNodeId?: string
): { say: string; actions: any[] } {
  const t = userText.trim()
  const p = useProjectStore().current
  const actions: any[] = []

  if (p) {
    // 生成 / 重跑某个节点
    const runMatch = t.match(/(?:重新生成|生成|重跑|跑一下)\s*(?:节点)?\s*([a-zA-Z]+_\w+)/)
    if (runMatch) actions.push({ tool: 'run_node', nodeId: runMatch[1] })
    // 优化选中节点
    if (!actions.length && selectedNodeId && /优化|扩写|加厚|润色|更|再/.test(t)) {
      actions.push({ tool: 'optimize_node_prompt', nodeId: selectedNodeId, text: t })
    }
    // 体检 / 整理画布
    if (!actions.length && /检查|体检|看看有什么问题|哪里不对|齐了没|漏了/.test(t)) {
      actions.push({ tool: 'check_project' })
    }
    if (!actions.length && /整理|重排|排布|重新摆放|整理一下画布/.test(t)) {
      actions.push({ tool: 'arrange_canvas' })
    }
    // 删掉选中节点
    if (!actions.length && selectedNodeId && /删|去掉|移除/.test(t)) {
      actions.push({ tool: 'delete_node', nodeId: selectedNodeId })
    }
    // 新建节点（说「给这个节点加…」时自动挂到选中节点后面并连线）
    if (!actions.length && /视频/.test(t) && /新建|创建|做一?[个条]|来一?[个条]|加|接|连/.test(t)) {
      const dur = Number(t.match(/(\d{1,2})\s*秒/)?.[1] || 8)
      actions.push({ tool: 'create_video_node', text: t, duration: dur, sourceNodeId: selectedNodeId })
    } else if (
      !actions.length &&
      /图|画/.test(t) &&
      /新建|创建|画一?[张个]|做一?[张个]|来一?[张个]|加|接|连/.test(t)
    ) {
      actions.push({ tool: 'create_image_node', text: t, sourceNodeId: selectedNodeId })
    }
  }

  if (!actions.length) {
    return {
      say: '直接说你想画什么、改哪个节点，我来动手。例如「创建一个修仙渡劫的视频节点，8 秒」或「把这个节点的提示词写得更具体」。',
      actions: []
    }
  }
  return { say: '按你这句做，不加别的步骤。', actions }
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
    ? `\n\n**失败 ${fail.length} 项**\n${fail
        .map((f) => `- ${TOOL_LABEL[f.tool] || f.tool}：${f.detail}`)
        .join('\n')}`
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
      reply: `**全流程跑完了。**${failLine || '\n\n画布上的节点都已更新。'}${
        next ? `\n\n还缺「${next.label}」，回「继续」我再补。` : ''
      }`,
      chips: nextChips(next)
    }
  }
  if (didContinue) {
    const hasShots = Boolean(p?.shots.length)
    return {
      reply: hasShots
        ? `**已顺着当前剧后续写**，原场次保留。\n\n- 新场还没进画布节点\n- 到「分镜关键帧」分组点重新提取，或回「重新提取分镜」${failLine}`
        : `**已顺着当前剧后续写**，原场次保留。\n\n- 看完可再改字\n- 回「继续」先拆人物（不会同时拆场景和分镜）${failLine}`,
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
      reply: `**完整剧本已经写到画布左侧**（还没拆节点）。

先确认三件事：

- 背景对不对
- 人物对不对
- 环境对不对

确认后回「继续」只拆人物；场景和分镜要再各走一步。说「全流程」会自动跑完。${failLine}`,
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
        reply: `**第 1 步完成**：已提炼并保存 ${subjectCount} 个角色。没有同时运行场景和分镜。

- 确认人物没问题后，回「继续」再单独提炼场景${failLine}`,
        chips: [
          { label: '继续提炼场景', text: '继续' },
          { label: '先检查人物', text: '先看看人物' }
        ]
      }
    }
    if (!n) {
      return {
        reply: `**第 2 步完成**：已保留 ${subjectCount} 个角色，并保存 ${sceneCount} 个场景。

- 确认场景没问题后，回「继续」再单独拆分镜${failLine}`,
        chips: [
          { label: '继续拆分镜', text: '继续' },
          { label: '先检查场景', text: '先看看场景' }
        ]
      }
    }
    return {
      reply: `**第 3 步完成**：已拆出 ${n} 个分镜，并与现有角色和场景绑定。

- 先去画布看一遍
- 看完回「继续」做人设和场景；说「全流程」会自动跑完${failLine}`,
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
  // 只有「批量」动作（会一次性烧掉大量额度）才需要用户的话里有对应意图，
  // 单个动作放手让模型根据最新画布决定，避免在意料之外被静默丢弃。
  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜|写剧本|提炼节点|拆剧本|续写|接着写|再写|分镜|场次/.test(t)
  const askedSheet = /人设|角色图|四视图|人物图|角色/.test(t)
  const askedScene = /场景图|底板|出场景|生成场景|场景/.test(t)
  const askedPanel = /故事看板|看板图|线稿分镜|线稿/.test(t)
  const askedImage = /配图|出图|关键帧|画面|图片|静帧|作图|图/.test(t)
  const askedVideo = /视频|图生视频|动态|出片|成片|运镜/.test(t)
  const askedAudio = /口播|配音|语音|旁白|声音|台词录音/.test(t)
  const shotHit = parseShotIndexes(t).length > 0
  return actions.filter((a) => {
    const tool = String(a?.tool || '')
    if (!tool) return false
    if (tool === 'generate_all_prop_sheets' || tool === 'generate_prop_sheet') return false
    if (tool === 'generate_all_sheets') return askedSheet || all
    if (tool === 'generate_all_scenes') return askedScene || all
    if (tool === 'generate_all_boards') return askedPanel || all
    if (tool === 'generate_all_images') return askedImage || shotHit || all
    if (tool === 'generate_all_videos') return askedVideo || shotHit || all
    if (tool === 'generate_all_audio') return askedAudio || shotHit || all
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
    if (!actions.some((a) => a.tool === 'generate_all_scenes')) {
      actions.push({ tool: 'generate_all_scenes' })
    }
    if (shotsMissingKeyframe(p).length && !actions.some((a) => a.tool === 'generate_all_images')) {
      actions.push({ tool: 'generate_all_images' })
    }
    if (shotsMissingStoryboard(p).length && !actions.some((a) => a.tool === 'generate_all_boards')) {
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
