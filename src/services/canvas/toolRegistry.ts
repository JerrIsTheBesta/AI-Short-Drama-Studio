import { useProjectStore } from '@/stores'
import { needsExternalTts } from '@/utils/shot'
import { inferVisualStyleFromText } from '@/utils/visualStyle'
import {
  runCanvasNode,
  generateMissingSheets,
  generateMissingPlates,
  generateMissingImages,
  generateMissingVideos,
  generateMissingAudio
} from './runner'
import { revealCanvas } from './canvasBridge'
import type { AgentTaskGraph, AgentTaskGraphNode } from '@/types/pipeline'

export type AgentToolName =
  | 'seed_script'
  | 'generate_play'
  | 'generate_storyboard'
  | 'extract_cast'
  | 'approve_play'
  | 'revise_shot'
  | 'generate_sheet'
  | 'generate_all_sheets'
  | 'generate_scene'
  | 'generate_all_scenes'
  | 'generate_shot_image'
  | 'generate_all_images'
  | 'generate_video'
  | 'generate_all_videos'
  | 'generate_audio'
  | 'generate_all_audio'
  | 'sync_canvas'
  | 'focus_node'
  | 'run_node'

export interface AgentToolAction {
  tool: AgentToolName
  text?: string
  subjectId?: string
  sceneId?: string
  shotId?: string
  nodeId?: string
  visualPrompt?: string
  imagePrompt?: string
  videoPrompt?: string
  voiceover?: string
  duration?: number
  cameraMovement?: 'push' | 'pull' | 'pan' | 'tilt' | 'static' | 'orbit'
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
    readonly code: 'invalid_action' | 'timeout' | 'cancelled' | 'execution_failed',
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
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw abortError(tool)
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AgentToolError(`${tool} 超时，请检查服务状态后重试`, tool, 'timeout', true)),
      timeoutMs
    )
  })
  const aborted = new Promise<never>((_, reject) => {
    abortHandler = () => reject(abortError(tool))
    signal?.addEventListener('abort', abortHandler, { once: true })
  })
  try {
    return await Promise.race([promise, timeout, aborted])
  } finally {
    if (timer) clearTimeout(timer)
    if (abortHandler) signal?.removeEventListener('abort', abortHandler)
  }
}

function counts() {
  const p = useProjectStore().current
  return {
    sheets: (p?.subjects ?? []).filter((s) => !s.designSheetAssetId).length,
    scenes: (p?.scenes ?? []).filter((s) => !s.plateAssetId).length,
    images: (p?.shots ?? []).filter((s) => !s.imageAssetId).length,
    videos: (p?.shots ?? []).filter((s) => s.imageAssetId && !s.videoAssetId).length,
    audio: (p?.shots ?? []).filter((s) => needsExternalTts(s) && !s.audioAssetId).length
  }
}

const noCost = () => ({ calls: 0, seconds: 1 })
const oneLlm = () => ({ calls: 1, seconds: 30 })
const oneImage = () => ({ calls: 1, seconds: 45 })
const oneVideo = () => ({ calls: 1, seconds: 180 })
const oneAudio = () => ({ calls: 1, seconds: 20 })

function progress(ctx: ToolExecutionContext) {
  return (_id: string, message: string) => {
    if (ctx.signal?.aborted) throw abortError('run_node')
    ctx.onLog(message)
  }
}

const definitions: ToolDefinition[] = [
  {
    name: 'seed_script', phase: 0, timeoutMs: 5_000, required: ['text'], estimate: noCost,
    async execute(action, ctx) {
      const project = useProjectStore()
      const cur = project.current
      if (!cur) throw new Error('请先创建项目')
      const text = String(action.text || '').trim()
      const topic = text.replace(/\s+/g, ' ').slice(0, 48) || cur.name
      const inferred = inferVisualStyleFromText(text)
      const style = inferred || cur.script?.style || 'cinematic'
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
          topic: cur.script.topic || topic,
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
    name: 'generate_play', phase: 0, timeoutMs: 120_000, estimate: oneLlm,
    async execute(_action, ctx) {
      const { runGeneratePlay } = await import('./runner')
      await runGeneratePlay(ctx.onLog, ctx.signal)
      revealCanvas('script')
      return '完整剧本已写好，请先看左侧；确认后可提炼人物/场景/分镜节点'
    }
  },
  {
    name: 'generate_storyboard', phase: 0, timeoutMs: 180_000, estimate: oneLlm,
    async execute(_action, ctx) {
      const { runGeneratePlay } = await import('./runner')
      await runGeneratePlay(ctx.onLog, ctx.signal)
      revealCanvas('script')
      return '完整剧本已写好（第一步，未拆节点）。回「继续」再提炼人物/场景/分镜'
    }
  },
  {
    name: 'extract_cast', phase: 0, timeoutMs: 180_000, estimate: oneLlm,
    async execute(_action, ctx) {
      const { runExtractStoryboard, runGeneratePlay } = await import('./runner')
      const { isPlayReady } = await import('@/services/ai')
      const project = useProjectStore()
      const script = project.current?.script
      if (!isPlayReady(script) && !script?.content?.trim()) {
        await runGeneratePlay(ctx.onLog, ctx.signal)
        revealCanvas('script')
        return '还没有完整剧本，已先写好剧本（未拆节点）；请再点提炼节点'
      }
      await runExtractStoryboard(ctx.onLog, ctx.signal)
      revealCanvas('script')
      return `已提炼人物 ${project.current?.subjects?.length ?? 0} / 场景 ${project.current?.scenes?.length ?? 0} / 分镜 ${project.current?.shots.length ?? 0}`
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
        ...(action.videoPrompt ? { videoPrompt: action.videoPrompt } : {}),
        ...(action.voiceover !== undefined ? { voiceover: action.voiceover } : {}),
        ...(typeof action.duration === 'number' ? { duration: Math.max(3, Math.min(10, Math.round(action.duration))) } : {}),
        ...(action.cameraMovement ? { cameraMovement: action.cameraMovement } : {})
      }
      if (!Object.keys(patch).length) throw new Error('revise_shot 没有提供任何修改字段')
      project.updateShot(shot.id, patch)
      if (action.visualPrompt || action.imagePrompt) project.invalidateShotAssets(shot.id, 'image')
      else if (action.videoPrompt || action.cameraMovement || action.duration) project.invalidateShotAssets(shot.id, 'video')
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
      return `人设 ${sub.name} 完成`
    }
  },
  {
    name: 'generate_all_sheets', phase: 1, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().sheets, seconds: counts().sheets * 45 }),
    async execute(_action, ctx) { await generateMissingSheets(ctx.onLog, ctx.signal); return '人设已补齐' }
  },
  {
    name: 'generate_scene', phase: 1, timeoutMs: 240_000, required: ['sceneId'], estimate: oneImage,
    async execute(action, ctx) {
      const p = useProjectStore().current!
      const scene = (p.scenes ?? []).find((s) => s.id === action.sceneId)
      if (!scene) throw new Error(`找不到场景 ${action.sceneId}`)
      await runCanvasNode(`scene:${scene.id}`, progress(ctx), ctx.signal)
      return `场景 ${scene.name} 完成`
    }
  },
  {
    name: 'generate_all_scenes', phase: 1, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().scenes, seconds: counts().scenes * 45 }),
    async execute(_action, ctx) { await generateMissingPlates(ctx.onLog, ctx.signal); return '场景已补齐' }
  },
  {
    name: 'generate_shot_image', phase: 2, timeoutMs: 240_000, required: ['shotId'], estimate: oneImage,
    async execute(action, ctx) {
      await runCanvasNode(`shotImage:${action.shotId}`, progress(ctx), ctx.signal)
      revealCanvas(`shotImage:${action.shotId}`)
      return '分镜配图完成'
    }
  },
  {
    name: 'generate_all_images', phase: 2, timeoutMs: 900_000,
    estimate: () => ({ calls: counts().images, seconds: counts().images * 45 }),
    async execute(_action, ctx) { await generateMissingImages(ctx.onLog, ctx.signal); return '配图已补齐' }
  },
  {
    name: 'generate_video', phase: 3, timeoutMs: 20 * 60_000, required: ['shotId'], estimate: oneVideo,
    async execute(action, ctx) {
      await runCanvasNode(`shotVideo:${action.shotId}`, progress(ctx), ctx.signal)
      revealCanvas(`shotVideo:${action.shotId}`)
      return '分镜视频完成'
    }
  },
  {
    name: 'generate_all_videos', phase: 3, timeoutMs: 60 * 60_000,
    estimate: () => ({ calls: counts().videos, seconds: counts().videos * 180 }),
    async execute(_action, ctx) { await generateMissingVideos(ctx.onLog, ctx.signal); return '视频已补齐' }
  },
  {
    name: 'generate_audio', phase: 4, timeoutMs: 180_000, required: ['shotId'], estimate: oneAudio,
    async execute(action, ctx) { await runCanvasNode(`audio:${action.shotId}`, progress(ctx), ctx.signal); return '口播完成' }
  },
  {
    name: 'generate_all_audio', phase: 4, timeoutMs: 600_000,
    estimate: () => ({ calls: counts().audio, seconds: counts().audio * 20 }),
    async execute(_action, ctx) { await generateMissingAudio(ctx.onLog, ctx.signal); return '口播已补齐' }
  },
  {
    name: 'sync_canvas', phase: 5, timeoutMs: 5_000, estimate: noCost,
    async execute() { useProjectStore().syncCanvasFromProject(); revealCanvas(); return '画布已同步' }
  },
  {
    name: 'focus_node', phase: 5, timeoutMs: 5_000, required: ['nodeId'], estimate: noCost,
    async execute(action) { revealCanvas(action.nodeId); return '已定位节点' }
  },
  {
    name: 'run_node', phase: 2, timeoutMs: 20 * 60_000, required: ['nodeId'], estimate: oneImage,
    async execute(action, ctx) { await runCanvasNode(action.nodeId!, progress(ctx), ctx.signal); return '节点完成' }
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
    ,...(typeof action.voiceover === 'string' ? { voiceover: action.voiceover } : {})
    ,...(typeof action.duration === 'number' ? { duration: action.duration } : {})
    ,...(['push', 'pull', 'pan', 'tilt', 'static', 'orbit'].includes(String(action.cameraMovement))
      ? { cameraMovement: action.cameraMovement as AgentToolAction['cameraMovement'] }
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
      definition.execute(valid, ctx),
      definition.timeoutMs,
      ctx.signal
    )
  } catch (error: any) {
    if (error instanceof AgentToolError) throw error
    throw new AgentToolError(
      error?.message ?? String(error),
      valid.tool,
      'execution_failed',
      !/401|403|鉴权|密钥|API Key|找不到|没有口播/.test(error?.message ?? '')
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
  if (/人设|角色图/.test(t)) { calls += Math.max(1, c.sheets); seconds += Math.max(1, c.sheets) * 45 }
  if (/场景|底板/.test(t)) { calls += Math.max(1, c.scenes); seconds += Math.max(1, c.scenes) * 45 }
  if (/配图|出图|关键帧/.test(t)) { calls += Math.max(1, c.images); seconds += Math.max(1, c.images) * 45 }
  if (/视频|成片/.test(t)) { calls += Math.max(1, c.videos || c.images); seconds += Math.max(1, c.videos || c.images) * 180 }
  if (/配音|口播|语音/.test(t)) { calls += Math.max(1, c.audio); seconds += Math.max(1, c.audio) * 20 }
  if (/全流程|完整流程|全部做完|从头到尾|全套/.test(t)) {
    const sheets = c.sheets || 1
    const scenes = c.scenes || 1
    const images = c.images || plannedShots
    const videos = c.videos || plannedShots
    const audio = c.audio || plannedShots
    calls = 1 + sheets + scenes + images + videos + audio
    seconds = 30 + (sheets + scenes + images) * 45 + videos * 180 + audio * 20
  }
  return { calls, seconds }
}
