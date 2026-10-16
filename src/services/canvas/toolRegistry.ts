import { useProjectStore, useSettingsStore } from '@/stores'
import { needsExternalTts } from '@/utils/shot'
import { stillModeForShot, shotsMissingKeyframe, shotsMissingStoryboard } from '@/utils/videoStill'
import { inferVisualStyleFromText } from '@/utils/visualStyle'
import { topicFromBrief } from '@/utils/storyBrief'
import { controlledSignal, isAbortError, isTimeoutAbort } from '@/services/ai/abort'
import { VIDEO_GEN_CONCURRENCY } from './jobs'
import {
  runCanvasNode,
  generateMissingSheets,
  generateMissingPlates,
  generateMissingBoards,
  generateMissingImages,
  generateMissingVideos,
  generateMissingAudio
} from './runner'
import { nextExtractStage, type ExtractStage } from './pipeline'
import { revealCanvas } from './canvasBridge'
import { appendCanvasReferenceSource, canvasNodeProducesImage, resolvedCanvasReferenceAssetIds } from './references'
import { rebuildCanvasGraph } from './layout'
import type { AgentTaskGraph, AgentTaskGraphNode } from '@/types/pipeline'

export type AgentToolName =
  | 'seed_script'
  | 'generate_play'
  | 'continue_play'
  | 'generate_storyboard'
  | 'extract_cast'
  | 'approve_play'
  | 'revise_shot'
  | 'generate_sheet'
  | 'generate_all_sheets'
  | 'generate_all_prop_sheets'
  | 'generate_prop_sheet'
  | 'generate_scene'
  | 'generate_all_scenes'
  | 'generate_shot_board'
  | 'generate_all_boards'
  | 'generate_shot_image'
  | 'generate_all_images'
  | 'generate_video'
  | 'generate_all_videos'
  | 'generate_audio'
  | 'generate_all_audio'
  | 'sync_canvas'
  | 'focus_node'
  | 'create_image_node'
  | 'create_video_node'
  | 'connect_nodes'
  | 'delete_node'
  | 'arrange_canvas'
  | 'check_project'
  | 'update_node'
  | 'run_node'
  | 'optimize_node_prompt'
  | 'remember'
  | 'forget'

export interface AgentToolAction {
  tool: AgentToolName
  text?: string
  subjectId?: string
  sceneId?: string
  shotId?: string
  nodeId?: string
  /** 连线 / 派生新节点的上游节点 id */
  sourceNodeId?: string
  /** 连线的下游节点 id */
  targetNodeId?: string
  /** 节点显示名（重命名用） */
  nodeLabel?: string
  visualPrompt?: string
  imagePrompt?: string
  videoPrompt?: string
  compiledVideoPrompt?: string
  voiceover?: string
  duration?: number
  cameraMovement?: 'push' | 'pull' | 'pan' | 'tilt' | 'static' | 'orbit'
  extractStage?: ExtractStage
}

export interface ToolExecutionContext {
  signal?: AbortSignal
  onLog: (message: string) => void
}

export interface ToolEstimate {
  calls: number
  seconds: number
}

interface ToolDefinition {
  name: AgentToolName
  phase: number
  timeoutMs: number
  required?: Array<keyof AgentToolAction>
  estimate: (action: AgentToolAction) => ToolEstimate
  execute: (action: AgentToolAction, ctx: ToolExecutionContext) => Promise<string>
}

export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly code: 'invalid_action' | 'timeout' | 'cancelled' | 'execution_failed' | 'postcondition_failed',
    readonly recoverable = false
  ) {
    super(message)
  }
}

function abortError(tool: string) {
  return new AgentToolError('任务已由用户停止', tool, 'cancelled', false)
}

async function withControl<T>(
  tool: string,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal
): Promise<T> {
  const control = controlledSignal(parent, timeoutMs)
  try {
    if (control.signal.aborted) throw abortError(tool)
    return await run(control.signal)
  } catch (error: any) {
    if (error instanceof AgentToolError) throw error
    if (isTimeoutAbort(error, control.signal) && control.signal.aborted) {
      throw new AgentToolError(
        `这一步超过 ${Math.round(timeoutMs / 1000)} 秒还没完成，请再试一次`,
        tool,
        'timeout',
        true
      )
    }
    if (isAbortError(error) || control.signal.aborted) throw abortError(tool)
    throw error
  } finally {
    control.cleanup()
  }
}

function counts() {
  const p = useProjectStore().current
  return {
    sheets: (p?.subjects ?? []).filter((s) => !s.designSheetAssetId).length,
    props:
      (p?.subjects ?? []).filter((s) => !s.propSheetAssetId).length
      + (p?.scenes ?? []).filter((s) => !s.propSheetAssetId).length,
    scenes: (p?.scenes ?? []).filter((s) => !s.plateAssetId).length,
    boards: p ? shotsMissingStoryboard(p).length + shotsMissingKeyframe(p).length : 0,
    images: p ? shotsMissingKeyframe(p).length : 0,
    videos: (p?.shots ?? []).filter((s) => !s.videoAssetId).length,
    audio: (p?.shots ?? []).filter((s) => needsExternalTts(s, p) && !s.audioAssetId).length
  }
}

export interface ToolPreflight {
  state: 'ready' | 'skip' | 'repair'
  detail?: string
  actions?: AgentToolAction[]
}

function shotFor(action: AgentToolAction) {
  return useProjectStore().current?.shots.find((shot) => shot.id === action.shotId)
}

/** Deterministic dependency check. Repairs are ordinary registered tools and remain bounded by AgentLoop. */
export function preflightRegisteredTool(raw: unknown): ToolPreflight {
  const action = validateToolAction(raw)
  const project = useProjectStore().current
  if (!project) return { state: 'ready' }

  if (action.tool === 'extract_cast' && !(project.script?.playReady && project.script.content?.trim())) {
    return {
      state: 'repair',
      detail: '提炼节点前缺少完整剧本，先补写剧本',
      actions: [{ tool: 'generate_play' }]
    }
  }

  if (action.tool === 'generate_shot_image') {
    const shot = shotFor(action)
    if (!shot) throw new AgentToolError(`找不到分镜 ${action.shotId}`, action.tool, 'invalid_action', true)
    if (shot.imageAssetId) return { state: 'skip', detail: `第 ${shot.index + 1} 镜关键帧已经存在` }
    if (stillModeForShot(shot, project) !== 'keyframe') {
      return { state: 'skip', detail: `第 ${shot.index + 1} 镜当前视频模型不需要分镜关键帧` }
    }
    const subjectIds = shot.subjectIds?.length ? shot.subjectIds : (project.subjects ?? []).map((subject) => subject.id)
    const missingSubjects = (project.subjects ?? []).filter(
      (subject) => subjectIds.includes(subject.id) && !subject.designSheetAssetId
    )
    const scene = (project.scenes ?? []).find((item) => item.id === shot.sceneId) || (project.scenes ?? [])[0]
    const repairs: AgentToolAction[] = missingSubjects.map((subject) => ({ tool: 'generate_sheet', subjectId: subject.id }))
    if (scene && !scene.plateAssetId) repairs.push({ tool: 'generate_scene', sceneId: scene.id })
    if (repairs.length) {
      return { state: 'repair', detail: `第 ${shot.index + 1} 镜缺少人设或场景，先补齐再出关键帧`, actions: repairs }
    }
  }

  if (action.tool === 'generate_shot_board' || action.tool === 'generate_video' || action.tool === 'generate_audio') {
    const shot = shotFor(action)
    if (!shot) throw new AgentToolError(`找不到分镜 ${action.shotId}`, action.tool, 'invalid_action', true)

    if (action.tool === 'generate_video') {
      if (shot.videoAssetId) return { state: 'skip', detail: `第 ${shot.index + 1} 镜视频已经存在` }
      const stillMode = stillModeForShot(shot, project)
      if (stillMode === 'storyboard' && !shot.boardAssetId) {
        return {
          state: 'repair',
          detail: `第 ${shot.index + 1} 镜缺少故事看板，先补看板`,
          actions: [{ tool: 'generate_shot_board', shotId: shot.id }]
        }
      }
      if (stillMode === 'keyframe' && !shot.imageAssetId) {
        return {
          state: 'repair',
          detail: `第 ${shot.index + 1} 镜缺少四宫格关键帧，先补关键帧`,
          actions: [{ tool: 'generate_shot_image', shotId: shot.id }]
        }
      }
      const subjectIds = shot.subjectIds?.length ? shot.subjectIds : (project.subjects ?? []).map((subject) => subject.id)
      const missingSubjects = (project.subjects ?? []).filter(
        (subject) => subjectIds.includes(subject.id) && !subject.designSheetAssetId
      )
      const scene = (project.scenes ?? []).find((item) => item.id === shot.sceneId) || (project.scenes ?? [])[0]
      const repairs: AgentToolAction[] = missingSubjects.map((subject) => ({ tool: 'generate_sheet', subjectId: subject.id }))
      if (scene && !scene.plateAssetId) repairs.push({ tool: 'generate_scene', sceneId: scene.id })
      if (repairs.length) {
        return { state: 'repair', detail: `第 ${shot.index + 1} 镜缺少视频身份或场景参考，先补齐`, actions: repairs }
      }
    }

    if (action.tool === 'generate_audio') {
      if (!needsExternalTts(shot, project)) return { state: 'skip', detail: `第 ${shot.index + 1} 镜由 H3 负责声音，不需要独立 TTS` }
      if (shot.audioAssetId) return { state: 'skip', detail: `第 ${shot.index + 1} 镜口播已经存在` }
    }

    if (action.tool === 'generate_shot_board') {
      const stillMode = stillModeForShot(shot, project)
      if (stillMode === 'identity') {
        return { state: 'skip', detail: `第 ${shot.index + 1} 镜当前视频模型不需要看板或关键帧` }
      }
      if (stillMode === 'keyframe') {
        if (shot.imageAssetId) return { state: 'skip', detail: `第 ${shot.index + 1} 镜关键帧已经存在` }
      } else if (shot.boardAssetId) return { state: 'skip', detail: `第 ${shot.index + 1} 镜故事看板已经存在` }
      const subjectIds = shot.subjectIds?.length ? shot.subjectIds : (project.subjects ?? []).map((subject) => subject.id)
      const missingFour = (project.subjects ?? []).filter(
        (subject) => subjectIds.includes(subject.id) && !subject.designSheetAssetId
      )
      const scene = (project.scenes ?? []).find((item) => item.id === shot.sceneId) || (project.scenes ?? [])[0]
      const repairs: AgentToolAction[] = [
        ...missingFour.map((subject) => ({ tool: 'generate_sheet' as const, subjectId: subject.id }))
      ]
      if (scene && !scene.plateAssetId) repairs.push({ tool: 'generate_scene', sceneId: scene.id })
      if (repairs.length) {
        return { state: 'repair', detail: `第 ${shot.index + 1} 镜缺少角色或场景参考，先补依赖`, actions: repairs }
      }
    }
  }

  if (action.tool === 'generate_all_sheets') {
    if (!(project.subjects ?? []).some((subject) => !subject.designSheetAssetId)) {
      return { state: 'skip', detail: '四视图已经补齐' }
    }
  }
  if (action.tool === 'generate_all_prop_sheets' || action.tool === 'generate_prop_sheet') {
    return { state: 'skip', detail: '已取消关键道具图' }
  }

  if (action.tool === 'generate_all_boards') {
    if (!shotsMissingStoryboard(project).length && !shotsMissingKeyframe(project).length) {
      return { state: 'skip', detail: '当前视频模型不需要看板或关键帧，或已经补齐' }
    }
    const repairs: AgentToolAction[] = []
    if ((project.subjects ?? []).some((subject) => !subject.designSheetAssetId)) repairs.push({ tool: 'generate_all_sheets' })
    if ((project.scenes ?? []).some((scene) => !scene.plateAssetId)) repairs.push({ tool: 'generate_all_scenes' })
    if (repairs.length) return { state: 'repair', detail: '批量看板缺少角色或场景参考，先补依赖', actions: repairs }
  }

  if (action.tool === 'generate_all_images') {
    if (!shotsMissingKeyframe(project).length) return { state: 'skip', detail: '当前不需要分镜关键帧，或已经补齐' }
    if (shotsMissingStoryboard(project).length) {
      return { state: 'repair', detail: '批量配图缺少故事看板，先补看板', actions: [{ tool: 'generate_all_boards' }] }
    }
    const repairs: AgentToolAction[] = []
    if ((project.subjects ?? []).some((subject) => !subject.designSheetAssetId)) repairs.push({ tool: 'generate_all_sheets' })
    if ((project.scenes ?? []).some((scene) => !scene.plateAssetId)) repairs.push({ tool: 'generate_all_scenes' })
    if (repairs.length) return { state: 'repair', detail: '批量关键帧缺少人设或场景，先补依赖', actions: repairs }
  }

  if (action.tool === 'generate_all_videos') {
    if (!(project.shots ?? []).some((shot) => !shot.videoAssetId)) return { state: 'skip', detail: '分镜视频已经补齐' }
    if (shotsMissingKeyframe(project).length) {
      return { state: 'repair', detail: '批量视频缺少关键帧，先补事件画面', actions: [{ tool: 'generate_all_images' }] }
    }
    if (shotsMissingStoryboard(project).length) {
      return { state: 'repair', detail: '批量视频缺少故事看板，先补看板', actions: [{ tool: 'generate_all_boards' }] }
    }
    const repairs: AgentToolAction[] = []
    if ((project.subjects ?? []).some((subject) => !subject.designSheetAssetId)) repairs.push({ tool: 'generate_all_sheets' })
    if ((project.scenes ?? []).some((scene) => !scene.plateAssetId)) repairs.push({ tool: 'generate_all_scenes' })
    if (repairs.length) return { state: 'repair', detail: '批量视频缺少角色设计图或场景图，先补依赖', actions: repairs }
  }

  if (action.tool === 'generate_all_audio') {
    if (!(project.shots ?? []).some((shot) => needsExternalTts(shot, project) && !shot.audioAssetId)) {
      return { state: 'skip', detail: '没有需要补的独立 TTS' }
    }
  }

  return { state: 'ready' }
}

/** Verify persisted project state instead of trusting a tool's success string. */
export function verifyRegisteredTool(raw: unknown): string | null {
  const action = validateToolAction(raw)
  const project = useProjectStore().current
  if (!project) return '项目状态不存在'
  const shot = shotFor(action)
  switch (action.tool) {
    case 'generate_play':
    case 'generate_storyboard':
    case 'continue_play':
      return project.script?.playReady && project.script.content?.trim() ? null : '完整剧本没有成功写入项目'
    case 'extract_cast':
      return (project.subjects ?? []).length ? null : '人物节点没有成功写入项目'
    case 'generate_sheet': {
      const subject = (project.subjects ?? []).find((item) => item.id === action.subjectId)
      return subject?.designSheetAssetId ? null : '角色四视图没有落库'
    }
    case 'generate_prop_sheet':
    case 'generate_all_prop_sheets':
      return null
    case 'generate_scene':
      return (project.scenes ?? []).find((item) => item.id === action.sceneId)?.plateAssetId ? null : '场景锚点图没有落库'
    case 'generate_all_sheets':
      return (project.subjects ?? []).every((item) => item.designSheetAssetId) ? null : '仍有角色四视图缺失'
    case 'generate_all_scenes':
      return (project.scenes ?? []).every((item) => item.plateAssetId) ? null : '仍有场景锚点图缺失'
    case 'generate_shot_board': {
      if (!shot) return '故事看板没有落库'
      const mode = stillModeForShot(shot, project)
      if (mode === 'identity') return null
      if (mode === 'storyboard') return shot.boardAssetId ? null : '故事看板没有落库'
      return shot.imageAssetId ? null : '关键帧没有落库'
    }
    case 'generate_shot_image':
      if (!shot) return '关键帧没有落库'
      if (stillModeForShot(shot, project) !== 'keyframe') return null
      return shot.imageAssetId ? null : '关键帧没有落库'
    case 'generate_all_boards':
      return shotsMissingStoryboard(project).length || shotsMissingKeyframe(project).length
        ? '仍有看板或关键帧缺失'
        : null
    case 'generate_all_images':
      return shotsMissingKeyframe(project).length ? '仍有关键帧缺失' : null
    case 'generate_video':
      return shot?.videoAssetId ? null : '分镜视频没有落库'
    case 'generate_all_videos':
      return project.shots.every((item) => item.videoAssetId) ? null : '仍有分镜视频缺失'
    case 'generate_audio':
      return !shot || !needsExternalTts(shot, project) || shot.audioAssetId ? null : '独立口播没有落库'
    case 'generate_all_audio':
      return project.shots.every((item) => !needsExternalTts(item, project) || item.audioAssetId) ? null : '仍有独立口播缺失'
    default:
      return null
  }
}

const noCost = () => ({ calls: 0, seconds: 1 })
const oneLlm = () => ({ calls: 1, seconds: 180 })
const oneImage = () => ({ calls: 1, seconds: 45 })
const oneVideo = () => ({ calls: 1, seconds: 180 })
const oneAudio = () => ({ calls: 1, seconds: 20 })

function progress(ctx: ToolExecutionContext) {
  return (_id: string, message: string) => {
    if (ctx.signal?.aborted) throw abortError('run_node')
    ctx.onLog(message)
  }
}

/** 把两个已有节点连起来（source → target），必要时把上游的产出作为参考图继承给下游 */
function linkCanvasNodes(sourceId: string, targetId: string): string {
  const project = useProjectStore()
  const canvas = project.current?.canvas
  if (!project.current || !canvas) throw new Error('当前项目没有可用画布')
  const source = canvas.nodes.find((n) => n.id === sourceId)
  const target = canvas.nodes.find((n) => n.id === targetId)
  if (!source) throw new Error(`找不到上游节点 ${sourceId}`)
  if (!target) throw new Error(`找不到下游节点 ${targetId}`)
  if (sourceId === targetId) throw new Error('节点不能连自己')

  let refNote = ''
  if (canvasNodeProducesImage(source) && (target.type === 'imageGen' || target.type === 'videoGen')) {
    const ok = appendCanvasReferenceSource(project.current, targetId, sourceId)
    refNote = ok ? '，上游产出已作为参考图传给下游' : '（提示：下游参考图数量已满，只连了线）'
  }

  const id = `e-${sourceId}-${targetId}-in`
  const existed = canvas.edges.some((e) => e.id === id)
  if (!existed) {
    canvas.edges = [
      ...canvas.edges,
      { id, source: sourceId, target: targetId, sourceHandle: 'out', targetHandle: 'in' }
    ]
  }
  return existed
    ? `${sourceId} → ${targetId} 本来就连着${refNote}`
    : `已连线 ${sourceId} → ${targetId}${refNote}`
}

/** 上游节点右侧的空位，已有几个下游就往下错开 */
function spotNextToSource(sourceId: string, fallbackX: number, fallbackY: number, count: number) {
  const canvas = useProjectStore().current?.canvas
  const source = canvas?.nodes.find((n) => n.id === sourceId)
  if (!source) return { x: fallbackX, y: fallbackY }
  const siblings = (canvas?.edges ?? []).filter((e) => e.source === sourceId).length
  return { x: source.position.x + 420, y: source.position.y + siblings * 300 + (count % 2) * 40 }
}

const definitions: ToolDefinition[] = [
  {
    name: 'seed_script', phase: 0, timeoutMs: 5_000, required: ['text'], estimate: noCost,
    async execute(action, ctx) {
      const project = useProjectStore()
      const cur = project.current
      if (!cur) throw new Error('请先创建项目')
      const text = String(action.text || '').trim()
      const hasFullPlay = Boolean(
        cur.script?.playReady &&
        (
          /^#{1,4}\s+/m.test(cur.script.content || '') ||
          (cur.script.content || '').length >= 500 ||
          (cur.subjects ?? []).length ||
          (cur.scenes ?? []).length ||
          (cur.shots ?? []).length
        )
      )
      const explicitReplace =
        /重新写(?:完整)?剧本|重写(?:完整)?剧本|换(?:一个|成).{0,12}(?:故事|剧本)|新故事|新剧本|从头(?:写|开始)/.test(text)
      if (hasFullPlay && !explicitReplace) {
        ctx.onLog('已有完整剧本；已阻止用当前聊天短句覆盖正文')
        return '保留已有完整剧本。人物反馈或局部修改不会再清空正文。'
      }
      const topic = topicFromBrief(text) || cur.name
      const inferred = inferVisualStyleFromText(text)
      const style = inferred || cur.script?.style || 'cinematic'
      cur.name = topic
      if (!cur.script) {
        project.setScript({
          id: `s_${Date.now().toString(36)}`, topic, content: text, keywords: [], style,
          aspectRatio: cur.settings.aspectRatio,
          shotDuration: cur.settings.defaultShotDuration || 5,
          playReady: false,
          createdAt: Date.now()
        })
      } else {
        project.setScript({
          ...cur.script,
          topic,
          content: text,
          style,
          playReady: false
        })
      }
      ctx.onLog('文案已写入')
      return '文案已准备好'
    }
  },
  {
    name: 'generate_play', phase: 0, timeoutMs: 420_000, estimate: oneLlm,
    async execute(action, ctx) {
      const { runGeneratePlay } = await import('./runner')
      await runGeneratePlay(ctx.onLog, ctx.signal, undefined, {
        mode: 'write',
        brief: action.text
      })
      revealCanvas('script')
      return '完整剧本已写好。下一步只拆人物，不会同时拆场景和分镜。'
    }
  },
  {
    name: 'continue_play', phase: 0, timeoutMs: 420_000, estimate: oneLlm,
    async execute(action, ctx) {
      const { runGeneratePlay } = await import('./runner')
      await runGeneratePlay(ctx.onLog, ctx.signal, undefined, {
        mode: 'continue',
        hint: action.text
      })
      revealCanvas('script')
      return '已按当前剧后续写（保留原场次）。若已提炼过节点，请在「分镜关键帧」分组点重新提取以同步新场。'
    }
  },
  {
    name: 'generate_storyboard', phase: 0, timeoutMs: 420_000, estimate: oneLlm,
    async execute(action, ctx) {
      const { runGeneratePlay } = await import('./runner')
      await runGeneratePlay(ctx.onLog, ctx.signal, undefined, {
        mode: 'write',
        brief: action.text
      })
      revealCanvas('script')
      return '完整剧本已写好（第一步，未拆节点）。回「继续」只拆人物。'
    }
  },
  {
    name: 'extract_cast', phase: 0, timeoutMs: 1_080_000, estimate: oneLlm,
    async execute(action, ctx) {
      const { runExtractStoryboard, runGeneratePlay } = await import('./runner')
      const { isPlayReady } = await import('@/services/ai')
      const project = useProjectStore()
      const script = project.current?.script
      if (!isPlayReady(script) && !script?.content?.trim()) {
        await runGeneratePlay(ctx.onLog, ctx.signal)
        revealCanvas('script')
        return '还没有完整剧本，已先写好剧本（未拆节点）；请再点提炼节点'
      }
      const start = action.extractStage || nextExtractStage(project.current)
      if (!start) {
        throw new Error('人物、场景和分镜都已提炼。要改某一组，请在对应分组上点「重新提取」，或说明要重新提取人物、场景还是分镜。')
      }
      await runExtractStoryboard(ctx.onLog, ctx.signal, undefined, start)
      revealCanvas(
        start === 'subjects' ? 'group-subjects' : start === 'scenes' ? 'group-scenes' : 'group-shots'
      )
      const after = project.current
      const subjects = after?.subjects?.length ?? 0
      const scenes = after?.scenes?.length ?? 0
      const shots = after?.shots.length ?? 0
      if (start === 'subjects' && !subjects) throw new Error('人物没有写入画布')
      if (start === 'scenes' && !scenes) throw new Error('场景没有写入画布')
      if (start === 'shots' && !shots) throw new Error('分镜没有写入画布')
      const re = Boolean(action.extractStage)
      const kept = '已生成的图和视频按同名或镜号保留。'
      if (start === 'subjects') {
        return re
          ? `已重新提取人物（${subjects} 个）。${kept}没有动场景和分镜。`
          : `第1步完成：已拆 ${subjects} 个角色。没有同时拆场景和分镜。`
      }
      if (start === 'scenes') {
        return re
          ? `已重新提取场景描点（${scenes} 个）。${kept}没有动人物和分镜。`
          : `第2步完成：已拆 ${scenes} 个场景。没有同时拆分镜。`
      }
      return re
        ? `已重新提取分镜（${shots} 镜）。${kept}没有动人物和场景。`
        : `第3步完成：已拆 ${shots} 个分镜。`
    }
  },
  {
    name: 'approve_play', phase: 0, timeoutMs: 5_000, estimate: noCost,
    async execute() {
      const project = useProjectStore()
      project.setPlayApproved(true)
      await project.save()
      return '剧本已确认'
    }
  },
  {
    name: 'revise_shot', phase: 0, timeoutMs: 10_000, required: ['shotId'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const shot = project.current?.shots.find((item) => item.id === action.shotId)
      if (!shot) throw new Error(`找不到分镜 ${action.shotId}`)
      const patch = {
        ...(action.visualPrompt ? { visualPrompt: action.visualPrompt } : {}),
        ...(action.imagePrompt ? { imagePrompt: action.imagePrompt } : {}),
        ...(action.videoPrompt
          ? { videoPrompt: action.videoPrompt, compiledVideoPrompt: action.videoPrompt }
          : action.compiledVideoPrompt !== undefined
            ? { compiledVideoPrompt: action.compiledVideoPrompt }
            : {}),
        ...(action.voiceover !== undefined ? { voiceover: action.voiceover } : {}),
        ...(typeof action.duration === 'number' ? { duration: Math.max(3, Math.min(10, Math.round(action.duration))) } : {}),
        ...(action.cameraMovement ? { cameraMovement: action.cameraMovement } : {})
      }
      if (!Object.keys(patch).length) throw new Error('revise_shot 没有提供任何修改字段')
      project.updateShot(shot.id, patch)
      if (action.visualPrompt) project.updateShot(shot.id, { boardAssetId: undefined })
      if (action.visualPrompt || action.imagePrompt) project.invalidateShotAssets(shot.id, 'image')
      else if (action.videoPrompt || action.compiledVideoPrompt !== undefined || action.cameraMovement || action.duration) project.invalidateShotAssets(shot.id, 'video')
      if (action.voiceover !== undefined) {
        project.invalidateShotAssets(shot.id, 'audio')
        project.invalidateShotAssets(shot.id, 'video')
      }
      await project.save()
      revealCanvas(`shotImage:${shot.id}`)
      return `第 ${shot.index + 1} 镜已局部修改，只失效受影响的下游产物`
    }
  },
  {
    name: 'generate_sheet', phase: 1, timeoutMs: 240_000, required: ['subjectId'], estimate: oneImage,
    async execute(action, ctx) {
      const p = useProjectStore().current!
      const sub = (p.subjects ?? []).find((s) => s.id === action.subjectId)
      if (!sub) throw new Error(`找不到主体 ${action.subjectId}`)
      await runCanvasNode(`subject:${sub.id}`, progress(ctx), ctx.signal)
      revealCanvas(`subject:${sub.id}`)
      return `四视图 ${sub.name} 完成`
    }
  },
  {
    name: 'generate_all_sheets', phase: 1, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().sheets, seconds: counts().sheets * 90 }),
    async execute(_action, ctx) { await generateMissingSheets(ctx.onLog, ctx.signal); return '四视图已补齐' }
  },
  {
    name: 'generate_all_prop_sheets', phase: 1, timeoutMs: 600_000,
    estimate: () => ({ calls: 0, seconds: 0 }),
    async execute() { return '已取消关键道具图' }
  },
  {
    name: 'generate_prop_sheet', phase: 1, timeoutMs: 240_000, required: ['sceneId'], estimate: oneImage,
    async execute() { return '已取消关键道具图' }
  },
  {
    name: 'generate_scene', phase: 1, timeoutMs: 240_000, required: ['sceneId'], estimate: oneImage,
    async execute(action, ctx) {
      const p = useProjectStore().current!
      const scene = (p.scenes ?? []).find((s) => s.id === action.sceneId)
      if (!scene) throw new Error(`找不到场景 ${action.sceneId}`)
      await runCanvasNode(`scene:${scene.id}`, progress(ctx), ctx.signal)
      return `场景锚点图 ${scene.name} 完成`
    }
  },
  {
    name: 'generate_all_scenes', phase: 1, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().scenes, seconds: counts().scenes * 45 }),
    async execute(_action, ctx) { await generateMissingPlates(ctx.onLog, ctx.signal); return '场景锚点图已补齐' }
  },
  {
    name: 'generate_shot_board', phase: 2, timeoutMs: 240_000, required: ['shotId'], estimate: oneImage,
    async execute(action, ctx) {
      const project = useProjectStore().current
      const shot = project?.shots.find((item) => item.id === action.shotId)
      const mode = shot && project ? stillModeForShot(shot, project) : 'identity'
      if (mode === 'identity') return '当前视频模型不需要看板或关键帧'
      const nodeId = mode === 'storyboard' ? `shotBoard:${action.shotId}` : `shotImage:${action.shotId}`
      await runCanvasNode(nodeId, progress(ctx), ctx.signal)
      revealCanvas(nodeId)
      return mode === 'storyboard' ? '故事看板完成' : '关键帧完成'
    }
  },
  {
    name: 'generate_all_boards', phase: 2, timeoutMs: 900_000,
    estimate: () => ({ calls: counts().boards, seconds: counts().boards * 45 }),
    async execute(_action, ctx) {
      const project = useProjectStore().current
      if (project && shotsMissingStoryboard(project).length) {
        await generateMissingBoards(ctx.onLog, ctx.signal)
        return '故事看板已补齐'
      }
      await generateMissingImages(ctx.onLog, ctx.signal)
      return '关键帧已补齐'
    }
  },
  {
    name: 'generate_shot_image', phase: 3, timeoutMs: 240_000, required: ['shotId'], estimate: oneImage,
    async execute(action, ctx) {
      await runCanvasNode(`shotImage:${action.shotId}`, progress(ctx), ctx.signal)
      revealCanvas(`shotImage:${action.shotId}`)
      return '关键帧完成'
    }
  },
  {
    name: 'generate_all_images', phase: 3, timeoutMs: 900_000,
    estimate: () => ({ calls: counts().images, seconds: counts().images * 45 }),
    async execute(_action, ctx) { await generateMissingImages(ctx.onLog, ctx.signal); return '关键帧已补齐' }
  },
  {
    name: 'generate_video', phase: 4, timeoutMs: 20 * 60_000, required: ['shotId'], estimate: oneVideo,
    async execute(action, ctx) {
      await runCanvasNode(`shotVideo:${action.shotId}`, progress(ctx), ctx.signal)
      revealCanvas(`shotVideo:${action.shotId}`)
      return '分镜视频完成'
    }
  },
  {
    name: 'generate_all_videos', phase: 4, timeoutMs: 60 * 60_000,
    estimate: () => {
      const n = counts().videos
      return { calls: n, seconds: n ? Math.ceil(n / VIDEO_GEN_CONCURRENCY) * 180 : 0 }
    },
    async execute(_action, ctx) { await generateMissingVideos(ctx.onLog, ctx.signal); return '视频已补齐' }
  },
  {
    name: 'generate_audio', phase: 5, timeoutMs: 180_000, required: ['shotId'], estimate: oneAudio,
    async execute(action, ctx) { await runCanvasNode(`audio:${action.shotId}`, progress(ctx), ctx.signal); return '口播完成' }
  },
  {
    name: 'generate_all_audio', phase: 5, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().audio, seconds: counts().audio * 20 }),
    async execute(_action, ctx) { await generateMissingAudio(ctx.onLog, ctx.signal); return '口播已补齐' }
  },
  {
    name: 'sync_canvas', phase: 6, timeoutMs: 5_000, estimate: noCost,
    async execute() { useProjectStore().syncCanvasFromProject(); revealCanvas(); return '画布已同步' }
  },
  {
    name: 'focus_node', phase: 6, timeoutMs: 5_000, required: ['nodeId'], estimate: noCost,
    async execute(action) { revealCanvas(action.nodeId); return '已定位节点' }
  },
  {
    name: 'create_image_node', phase: 2, timeoutMs: 5_000, required: ['text'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const canvas = project.current?.canvas
      if (!project.current || !canvas) throw new Error('当前项目没有可用画布')
      const count = canvas.nodes.filter((node) => node.type === 'imageGen').length + 1
      const sourceId = action.sourceNodeId || action.nodeId
      const right = canvas.nodes.reduce((max, node) => Math.max(max, node.position.x), 0)
      const spot = sourceId
        ? spotNextToSource(sourceId, right + 340, 120 + ((count - 1) % 4) * 260, count)
        : { x: right + 340, y: 120 + ((count - 1) % 4) * 260 }
      const id = `imageGen_${Date.now().toString(36)}`
      project.addCanvasNode({
        id,
        type: 'imageGen',
        position: spot,
        data: { label: `图片 ${count}`, prompt: action.text, aspectRatio: project.current.settings.aspectRatio },
        status: 'idle'
      })
      await project.save()
      let linked = ''
      if (sourceId) {
        try {
          linked = `，并${linkCanvasNodes(sourceId, id)}`
        } catch (e: any) {
          linked = `（连线失败：${e?.message || '未知原因'}，可以在画布上手动拉线）`
        }
      }
      revealCanvas(id)
      return `已创建图片节点 ${id}，提示词已写入${linked}，可继续 run_node 生成`
    }
  },
  {
    name: 'create_video_node', phase: 2, timeoutMs: 5_000, required: ['text'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const canvas = project.current?.canvas
      if (!project.current || !canvas) throw new Error('当前项目没有可用画布')
      const count = canvas.nodes.filter((node) => node.type === 'videoGen').length + 1
      const sourceId = action.sourceNodeId || action.nodeId
      const right = canvas.nodes.reduce((max, node) => Math.max(max, node.position.x), 0)
      const spot = sourceId
        ? spotNextToSource(sourceId, right + 340, 140 + ((count - 1) % 4) * 280, count)
        : { x: right + 340, y: 140 + ((count - 1) % 4) * 280 }
      const id = `videoGen_${Date.now().toString(36)}`
      project.addCanvasNode({
        id,
        type: 'videoGen',
        position: spot,
        data: {
          label: `视频 ${count}`,
          prompt: action.text,
          aspectRatio: project.current.settings.aspectRatio,
          duration: Math.max(1, Math.min(15, Math.round(action.duration || 8)))
        },
        status: 'idle'
      })
      await project.save()
      let linked = ''
      if (sourceId) {
        try {
          linked = `，并${linkCanvasNodes(sourceId, id)}`
        } catch (e: any) {
          linked = `（连线失败：${e?.message || '未知原因'}，可以在画布上手动拉线）`
        }
      }
      revealCanvas(id)
      return `已创建视频节点 ${id}，动态提示词已写入${linked}，可继续 run_node 生成`
    }
  },
  {
    name: 'connect_nodes', phase: 2, timeoutMs: 5_000, required: ['sourceNodeId', 'targetNodeId'], estimate: noCost,
    async execute(action) {
      const note = linkCanvasNodes(action.sourceNodeId!, action.targetNodeId!)
      await useProjectStore().save()
      revealCanvas(action.targetNodeId!)
      return note
    }
  },
  {
    name: 'delete_node', phase: 2, timeoutMs: 5_000, required: ['nodeId'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const canvas = project.current?.canvas
      const node = canvas?.nodes.find((n) => n.id === action.nodeId)
      if (!canvas || !node) throw new Error(`找不到画布节点 ${action.nodeId}`)
      if (node.type !== 'imageGen' && node.type !== 'videoGen') {
        throw new Error('delete_node 只能删自由图片/视频节点；剧本、人设、分镜节点要在画布上手动删')
      }
      const label = node.data.label || node.id
      for (const other of canvas.nodes) {
        const sources = other.data.referenceSourceNodeIds ?? []
        if (sources.includes(node.id)) {
          other.data.referenceSourceNodeIds = sources.filter((id) => id !== node.id)
        }
      }
      project.removeCanvasNode(node.id)
      await project.save()
      return `已删除节点「${label}」，相关连线和其它节点对它的参考图引用也一起清掉了`
    }
  },
  {
    name: 'arrange_canvas', phase: 6, timeoutMs: 5_000, estimate: noCost,
    async execute() {
      const project = useProjectStore()
      const p = project.current
      if (!p) throw new Error('当前没有打开的项目')
      try {
        p.canvas = rebuildCanvasGraph(p, true)
      } catch {
        p.canvas = rebuildCanvasGraph(p, false)
      }
      await project.save()
      return '画布已重新排布（按 剧本 → 人设/场景 → 分镜 的顺序整理）'
    }
  },
  {
    name: 'check_project', phase: 6, timeoutMs: 5_000, estimate: noCost,
    async execute() {
      const project = useProjectStore()
      const p = project.current
      if (!p) throw new Error('当前没有打开的项目')
      const settings = useSettingsStore()
      const blocking: string[] = []
      const warnings: string[] = []

      if (!(settings.config.llms ?? []).length) blocking.push('没配 LLM，写剧本、拆节点、优化提示词都做不了')
      if (!(settings.config.images ?? []).length) blocking.push('没配图像模型，出不了图')
      if (!(settings.config.videos ?? []).length) blocking.push('没配视频模型，出不了视频')

      const canvas = p.canvas
      const nodes = canvas?.nodes ?? []
      const edges = canvas?.edges ?? []
      const free = nodes.filter((n) => n.type === 'imageGen' || n.type === 'videoGen')
      for (const n of free) {
        const name = n.data.label || n.id
        if (!(n.data.prompt || '').trim()) {
          warnings.push(`「${name}」还没写提示词，生成会空跑`)
        }
        if (n.type === 'videoGen' && !resolvedCanvasReferenceAssetIds(p, n).length) {
          warnings.push(`「${name}」是图生视频，但没有连上游也没有参考图，需要至少一张`)
        }
        if (n.status === 'failed') {
          warnings.push(`「${name}」上次生成失败：${n.error || '原因不明'}`)
        }
        if (!n.data.outputAssetId && n.status !== 'failed') {
          warnings.push(`「${name}」还没有产物`)
        }
      }
      const connected = new Set<string>()
      for (const e of edges) {
        connected.add(e.source)
        connected.add(e.target)
      }
      const orphans = free.filter((n) => !connected.has(n.id))
      if (orphans.length) {
        warnings.push(`有 ${orphans.length} 个节点没连线：${orphans.map((n) => n.data.label || n.id).join('、')}`)
      }

      const subjects = p.subjects ?? []
      const scenes = p.scenes ?? []
      if (!p.script?.content?.trim()) warnings.push('还没有剧本')
      if (subjects.length && subjects.some((s) => !s.designSheetAssetId)) {
        warnings.push(`有 ${subjects.filter((s) => !s.designSheetAssetId).length} 个角色没画人设图`)
      }
      if (scenes.length && scenes.some((s) => !s.plateAssetId)) {
        warnings.push(`有 ${scenes.filter((s) => !s.plateAssetId).length} 个场景没画底板`)
      }
      if (p.shots.length) {
        const noImg = p.shots.filter((s) => !s.imageAssetId).length
        const noVid = p.shots.filter((s) => !s.videoAssetId).length
        if (noImg) warnings.push(`有 ${noImg} 个分镜还没出图`)
        if (noVid) warnings.push(`有 ${noVid} 个分镜还没出视频`)
        if (!p.playApproved) warnings.push('剧本/分镜还没验收，流水线下游动作会被拦住')
      }

      if (!blocking.length && !warnings.length) {
        return `体检通过。剧本、${subjects.length} 个人物、${scenes.length} 个场景、${(p.shots ?? []).length} 个分镜、画布 ${free.length} 个生成节点都没问题。`
      }
      const lines: string[] = []
      if (blocking.length) lines.push(`【卡住】\n- ${blocking.join('\n- ')}`)
      if (warnings.length) lines.push(`【待处理】\n- ${warnings.join('\n- ')}`)
      return lines.join('\n')
    }
  },
  {
    name: 'update_node', phase: 2, timeoutMs: 5_000, required: ['nodeId'], estimate: noCost,
    async execute(action) {
      const project = useProjectStore()
      const node = project.current?.canvas?.nodes.find((item) => item.id === action.nodeId)
      if (!node) throw new Error(`找不到画布节点 ${action.nodeId}`)
      if (node.type !== 'imageGen' && node.type !== 'videoGen') {
        throw new Error('update_node 只修改自由图片/视频节点；分镜节点请用 revise_shot')
      }
      if (action.text === undefined && action.duration === undefined && action.nodeLabel === undefined) {
        throw new Error('update_node 至少需要 prompt(text)、duration 或 label')
      }
      project.patchCanvasNode(node.id, {
        ...(action.text !== undefined ? { prompt: action.text } : {}),
        ...(action.nodeLabel !== undefined ? { label: action.nodeLabel.trim() || undefined } : {}),
        ...(action.duration !== undefined
          ? { duration: Math.max(1, Math.min(15, Math.round(action.duration))) }
          : {}),
        outputAssetId: undefined
      })
      node.status = 'idle'
      node.error = undefined
      await project.save()
      revealCanvas(node.id)
      return `已更新节点 ${node.id}，旧输出已失效，可继续 run_node 生成`
    }
  },
  {
    name: 'run_node', phase: 2, timeoutMs: 20 * 60_000, required: ['nodeId'], estimate: oneImage,
    async execute(action, ctx) { await runCanvasNode(action.nodeId!, progress(ctx), ctx.signal); return '节点完成' }
  },
  {
    name: 'optimize_node_prompt', phase: 2, timeoutMs: 240_000, required: ['nodeId'], estimate: oneLlm,
    async execute(action, ctx) {
      const project = useProjectStore()
      const node = project.current?.canvas?.nodes.find((item) => item.id === action.nodeId)
      if (!node) throw new Error(`找不到画布节点 ${action.nodeId}`)
      if (node.type !== 'imageGen' && node.type !== 'videoGen') {
        throw new Error('optimize_node_prompt 只支持自由图片/视频节点')
      }
      const { optimizeNodePrompt } = await import('@/services/ai/promptCoach')
      const result = await optimizeNodePrompt(
        {
          kind: node.type === 'videoGen' ? 'video' : 'image',
          nodeLabel: `${node.data.label || node.id} · ${node.type === 'videoGen' ? '图生视频' : '生图'}`,
          currentPrompt: node.data.prompt || '',
          userHint: action.text,
          script: project.current?.script?.content || '',
          duration: node.data.duration,
          signal: ctx.signal
        },
        (msg) => ctx.onLog(msg)
      )
      project.setCanvasNodePrompt(node.id, result.prompt)
      await project.save()
      revealCanvas(node.id)
      return `${result.note}（已写入「${node.data.label || node.id}」）\n\n\`\`\`\n${result.prompt}\n\`\`\``
    }
  },
  {
    name: 'remember', phase: 6, timeoutMs: 10_000, required: ['text'], estimate: noCost,
    async execute(action) {
      const { rememberMemory } = await import('@/services/memory/memoryStore')
      const scope = /项目|本剧|这部/.test(action.text || '') ? 'project' : 'global'
      const entry = await rememberMemory(action.text!, { scope })
      if (!entry) throw new Error('没有可记忆的内容')
      return `已记住（${scope === 'global' ? '长期' : '本项目'}）：${entry.content}`
    }
  },
  {
    name: 'forget', phase: 6, timeoutMs: 10_000, required: ['text'], estimate: noCost,
    async execute(action) {
      const { forgetMemory } = await import('@/services/memory/memoryStore')
      const removed = await forgetMemory(action.text!)
      if (!removed) throw new Error('没有找到匹配的记忆')
      return `已忘掉：${removed}`
    }
  }
]

const registry = new Map(definitions.map((definition) => [definition.name, definition]))

export function validateToolAction(raw: unknown): AgentToolAction {
  if (!raw || typeof raw !== 'object') {
    throw new AgentToolError('工具动作必须是对象', 'unknown', 'invalid_action')
  }
  const action = raw as Record<string, unknown>
  const name = String(action.tool || '') as AgentToolName
  const definition = registry.get(name)
  if (!definition) throw new AgentToolError(`不允许的工具：${name || '空'}`, name, 'invalid_action')
  for (const key of definition.required ?? []) {
    if (typeof action[key] !== 'string' || !String(action[key]).trim()) {
      throw new AgentToolError(`${name} 缺少参数 ${key}`, name, 'invalid_action')
    }
  }
  return {
    tool: name,
    ...(typeof action.text === 'string' ? { text: action.text } : {}),
    ...(typeof action.subjectId === 'string' ? { subjectId: action.subjectId } : {}),
    ...(typeof action.sceneId === 'string' ? { sceneId: action.sceneId } : {}),
    ...(typeof action.shotId === 'string' ? { shotId: action.shotId } : {}),
    ...(typeof action.nodeId === 'string' ? { nodeId: action.nodeId } : {})
    ,...(typeof action.visualPrompt === 'string' ? { visualPrompt: action.visualPrompt } : {})
    ,...(typeof action.imagePrompt === 'string' ? { imagePrompt: action.imagePrompt } : {})
    ,...(typeof action.videoPrompt === 'string' ? { videoPrompt: action.videoPrompt } : {})
    ,...(typeof action.compiledVideoPrompt === 'string' ? { compiledVideoPrompt: action.compiledVideoPrompt } : {})
    ,...(typeof action.voiceover === 'string' ? { voiceover: action.voiceover } : {})
    ,...(typeof action.duration === 'number' ? { duration: action.duration } : {})
    ,...(['push', 'pull', 'pan', 'tilt', 'static', 'orbit'].includes(String(action.cameraMovement))
      ? { cameraMovement: action.cameraMovement as AgentToolAction['cameraMovement'] }
      : {})
    ,...(['subjects', 'scenes', 'shots'].includes(String(action.extractStage))
      ? { extractStage: action.extractStage as ExtractStage }
      : {})
  }
}

export function estimateToolActions(actions: unknown[]): ToolEstimate {
  return actions.map(validateToolAction).reduce(
    (sum, action) => {
      const cost = registry.get(action.tool)!.estimate(action)
      return { calls: sum.calls + cost.calls, seconds: sum.seconds + cost.seconds }
    },
    { calls: 0, seconds: 0 }
  )
}

export function buildTaskGraph(actions: unknown[]): AgentTaskGraph {
  const valid = actions.map(validateToolAction)
  const nodes: AgentTaskGraphNode[] = valid.map((action, index) => {
    const definition = registry.get(action.tool)!
    const estimate = definition.estimate(action)
    const previous = valid
      .map((a, i) => ({ a, i, phase: registry.get(a.tool)!.phase }))
      .filter((item) => item.i < index && item.phase < definition.phase)
      .map((item) => `step_${item.i}`)
    return {
      id: `step_${index}`,
      tool: action.tool,
      phase: definition.phase,
      dependsOn: previous,
      estimatedCalls: estimate.calls,
      estimatedSeconds: estimate.seconds
    }
  })
  return { id: `graph_${Date.now().toString(36)}`, nodes, createdAt: Date.now() }
}

export async function executeRegisteredTool(action: unknown, ctx: ToolExecutionContext) {
  const valid = validateToolAction(action)
  const definition = registry.get(valid.tool)!
  try {
    return await withControl(
      valid.tool,
      (signal) => definition.execute(valid, { ...ctx, signal }),
      definition.timeoutMs,
      ctx.signal
    )
  } catch (error: any) {
    if (error instanceof AgentToolError) throw error
    const message = error?.message ?? String(error)
    const hardStop = /401|403|鉴权|密钥|API Key|余额不足|配额不足|内容安全|用户停止|用户取消/.test(message)
    throw new AgentToolError(
      message,
      valid.tool,
      'execution_failed',
      !hardStop
    )
  }
}

export function toolPhase(name: AgentToolName) {
  return registry.get(name)?.phase ?? 99
}

export function estimateRequestText(text: string): ToolEstimate {
  const t = text.trim()
  const c = counts()
  const requestedShots = Number(t.match(/(?:生成|做|拆成)?\s*(\d{1,2})\s*(?:个)?镜头/)?.[1] || 0)
  const plannedShots = Math.max(1, requestedShots || c.images || c.videos || c.audio || 6)
  let calls = 0
  let seconds = 0
  if (/拆|剧本|分镜|脚本/.test(t)) { calls += 1; seconds += 30 }
  if (/人设|角色图|四视图/.test(t)) { calls += Math.max(1, c.sheets); seconds += Math.max(1, c.sheets) * 45 }
  if (/资产图/.test(t)) { calls += Math.max(1, c.props); seconds += Math.max(1, c.props) * 45 }
  if (/场景|底板/.test(t)) { calls += Math.max(1, c.scenes); seconds += Math.max(1, c.scenes) * 45 }
  if (/看板|故事看板/.test(t)) { calls += Math.max(1, c.boards); seconds += Math.max(1, c.boards) * 45 }
  if (/配图|出图|关键帧/.test(t)) { calls += Math.max(1, c.images); seconds += Math.max(1, c.images) * 45 }
  if (/视频|成片/.test(t)) { calls += Math.max(1, c.videos || c.images); seconds += Math.max(1, c.videos || c.images) * 180 }
  if (/配音|口播|语音/.test(t)) { calls += Math.max(1, c.audio); seconds += Math.max(1, c.audio) * 20 }
  if (/全流程|完整流程|全部做完|从头到尾|全套/.test(t)) {
    const sheets = c.sheets || 1
    const scenes = c.scenes || 1
    const boards = c.boards || plannedShots
    const images = c.images || plannedShots
    const videos = c.videos || plannedShots
    const audio = c.audio || plannedShots
    calls = 1 + sheets + scenes + boards + images + videos + audio
    seconds = 30 + (sheets + scenes + boards + images) * 45 + videos * 180 + audio * 20
  }
  return { calls, seconds }
}
