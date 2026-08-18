import type { AgentAutonomy } from '@/types'
import type { AgentEvent, AgentToolResult } from './agent'
import {
  AgentToolError,
  buildTaskGraph,
  estimateToolActions,
  executeRegisteredTool,
  toolPhase,
  validateToolAction,
  type AgentToolAction
} from './toolRegistry'
import { beginAgentTask, getAgentState, patchAgentTask } from './taskStore'

export interface ReplanInput {
  error: AgentToolError
  completed: AgentToolAction[]
  remaining: AgentToolAction[]
  attempt: number
}

export interface AgentLoopOptions {
  request: string
  autonomy: AgentAutonomy
  signal?: AbortSignal
  onEvent: (event: AgentEvent) => void
  replan?: (input: ReplanInput) => Promise<unknown[]>
}

function dedupe(actions: AgentToolAction[]) {
  const seen = new Set<string>()
  return actions.filter((action) => {
    const key = `${action.tool}:${action.subjectId ?? ''}:${action.sceneId ?? ''}:${action.shotId ?? ''}:${action.nodeId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function runAgentLoop(rawActions: unknown[], options: AgentLoopOptions) {
  let actions = dedupe(rawActions.map(validateToolAction)).sort(
    (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
  )
  const estimate = estimateToolActions(actions)
  const budget = getAgentState().callBudget
  if (budget > 0 && estimate.calls > budget) {
    throw new Error(`预计需要 ${estimate.calls} 次生成调用，超过当前单次预算 ${budget}。请缩小范围或提高预算。`)
  }
  const graph = buildTaskGraph(actions)
  const task = await beginAgentTask(options.request, estimate)
  await patchAgentTask(task.id, { status: 'running' })
  options.onEvent({
    kind: 'log',
    label: `计划 ${graph.nodes.length} 步，约 ${estimate.calls} 次生成调用 / ${Math.max(1, Math.ceil(estimate.seconds / 60))} 分钟`
  })

  const completed: AgentToolAction[] = []
  const results: AgentToolResult[] = []
  let replanAttempt = 0
  const maxReplans = options.autonomy === 'autopilot' ? 2 : options.autonomy === 'gated' ? 1 : 0

  try {
    while (actions.length) {
      if (options.signal?.aborted) throw new AgentToolError('任务已取消', 'agent', 'cancelled')
      const action = actions.shift()!
      const stepKey = `${action.tool}:${action.shotId || action.subjectId || action.sceneId || action.nodeId || ''}`
      options.onEvent({ kind: 'step', step: stepKey, label: action.tool, status: 'running' })
      await patchAgentTask(task.id, { currentStep: action.tool })
      try {
        const detail = await executeRegisteredTool(action, {
          signal: options.signal,
          onLog: (label) => options.onEvent({ kind: 'log', label })
        })
        completed.push(action)
        results.push({ tool: action.tool, ok: true, detail })
        options.onEvent({ kind: 'step', step: stepKey, label: action.tool, status: 'done' })
        await patchAgentTask(task.id, {
          completedTools: completed.map((item) => item.tool),
          currentStep: undefined
        })
      } catch (error: any) {
        const toolError = error instanceof AgentToolError
          ? error
          : new AgentToolError(error?.message ?? String(error), action.tool, 'execution_failed')
        results.push({ tool: action.tool, ok: false, detail: toolError.message })
        options.onEvent({ kind: 'step', step: stepKey, label: action.tool, status: 'fail' })
        options.onEvent({ kind: 'log', label: `已暂停：${toolError.message}` })

        if (
          toolError.recoverable &&
          options.replan &&
          replanAttempt < maxReplans &&
          !options.signal?.aborted
        ) {
          replanAttempt++
          options.onEvent({ kind: 'log', label: `分析失败原因并重新规划（${replanAttempt}/${maxReplans}）` })
          const replacement = await options.replan({
            error: toolError,
            completed,
            remaining: [action, ...actions],
            attempt: replanAttempt
          })
          actions = dedupe(replacement.map(validateToolAction)).sort(
            (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
          )
          if (actions.length) continue
        }

        await patchAgentTask(task.id, {
          status: toolError.code === 'cancelled' ? 'cancelled' : 'failed',
          failedTool: action.tool,
          error: toolError.message,
          finishedAt: Date.now()
        })
        return { results, graph, stopped: true, error: toolError }
      }
    }
    await patchAgentTask(task.id, { status: 'success', finishedAt: Date.now(), currentStep: undefined })
    return { results, graph, stopped: false }
  } catch (error: any) {
    await patchAgentTask(task.id, {
      status: options.signal?.aborted ? 'cancelled' : 'failed',
      error: error?.message ?? String(error),
      finishedAt: Date.now()
    })
    throw error
  }
}

