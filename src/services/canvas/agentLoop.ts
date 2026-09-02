import type { AgentAutonomy } from '@/types'
import type { AgentEvent, AgentToolResult } from './agent'
import {
  AgentToolError,
  buildTaskGraph,
  estimateToolActions,
  executeRegisteredTool,
  preflightRegisteredTool,
  toolPhase,
  validateToolAction,
  verifyRegisteredTool,
  type AgentToolAction
} from './toolRegistry'
import { TOOL_LABEL } from './pipeline'
import { beginAgentTask, getAgentState, patchAgentTask } from './taskStore'

export interface ReplanInput {
  error: AgentToolError
  completed: AgentToolAction[]
  remaining: AgentToolAction[]
  attempt: number
}

export interface ContinueAgentInput {
  completed: AgentToolAction[]
  results: AgentToolResult[]
  round: number
}

export interface ContinueAgentPlan {
  actions: unknown[]
  say?: string
  done?: boolean
}

export interface AgentLoopOptions {
  request: string
  autonomy: AgentAutonomy
  signal?: AbortSignal
  onEvent: (event: AgentEvent) => void
  replan?: (input: ReplanInput) => Promise<unknown[]>
  /**
   * A real agent must observe the canvas again after tools have changed it.
   * This callback lets the planner inspect the fresh project state and either
   * schedule another small batch or explicitly declare the request complete.
   */
  continue?: (input: ContinueAgentInput) => Promise<ContinueAgentPlan>
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
  const maxReplans = options.autonomy === 'autopilot' ? 4 : options.autonomy === 'gated' ? 2 : 1
  const dependencyAttempts = new Map<string, number>()
  const failureFingerprints = new Map<string, number>()
  const recoveringSteps = new Set<string>()
  let continuationRound = 0
  let finalSay = ''
  let scheduledCalls = estimate.calls
  let scheduledSeconds = estimate.seconds
  const maxContinuationRounds = options.autonomy === 'autopilot' ? 7 : options.autonomy === 'gated' ? 4 : 0

  try {
    while (true) {
      if (!actions.length) {
        if (!options.continue || continuationRound >= maxContinuationRounds) break
        continuationRound++
        options.onEvent({ kind: 'think', label: `重新查看画布，检查任务是否完成（${continuationRound}/${maxContinuationRounds}）…` })
        const next = await options.continue({
          completed: [...completed],
          results: [...results],
          round: continuationRound
        })
        if (next.say?.trim()) finalSay = next.say.trim()
        if (next.done || !next.actions?.length) break

        const nextActions = dedupe(next.actions.map(validateToolAction)).sort(
          (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
        )
        if (!nextActions.length) break
        const nextEstimate = estimateToolActions(nextActions)
        if (budget > 0 && scheduledCalls + nextEstimate.calls > budget) {
          throw new Error(
            `继续执行预计累计需要 ${scheduledCalls + nextEstimate.calls} 次生成调用，超过当前单次预算 ${budget}。已完成结果会保留。`
          )
        }
        scheduledCalls += nextEstimate.calls
        scheduledSeconds += nextEstimate.seconds
        await patchAgentTask(task.id, {
          estimatedCalls: scheduledCalls,
          estimatedSeconds: scheduledSeconds
        })
        options.onEvent({
          kind: 'log',
          label: `根据最新画布继续 ${nextActions.length} 步：${nextActions.map((item) => TOOL_LABEL[item.tool] || item.tool).join('、')}`
        })
        actions = nextActions
        continue
      }
      if (options.signal?.aborted) throw new AgentToolError('任务已取消', 'agent', 'cancelled')
      const action = actions.shift()!
      const stepKey = `${action.tool}:${action.shotId || action.subjectId || action.sceneId || action.nodeId || ''}`
      const stepLabel = TOOL_LABEL[action.tool] || action.tool

      let preflight
      try {
        preflight = preflightRegisteredTool(action)
      } catch (error: any) {
        const toolError = error instanceof AgentToolError
          ? error
          : new AgentToolError(error?.message ?? String(error), action.tool, 'invalid_action', false)
        results.push({ tool: action.tool, ok: false, detail: toolError.message })
        await patchAgentTask(task.id, {
          status: 'failed', failedTool: action.tool, error: toolError.message, finishedAt: Date.now()
        })
        return { results, graph, stopped: true, error: toolError }
      }
      if (preflight.state === 'skip') {
        completed.push(action)
        results.push({ tool: action.tool, ok: true, detail: preflight.detail || '已满足，无需重复执行' })
        options.onEvent({ kind: 'step', step: stepKey, label: stepLabel, status: 'done' })
        options.onEvent({ kind: 'log', label: `自检跳过：${preflight.detail || stepLabel}` })
        continue
      }
      if (preflight.state === 'repair') {
        const count = (dependencyAttempts.get(stepKey) || 0) + 1
        dependencyAttempts.set(stepKey, count)
        if (count > 3 || !preflight.actions?.length) {
          const toolError = new AgentToolError(
            `${preflight.detail || stepLabel}，自动补依赖后仍未满足`,
            action.tool,
            'postcondition_failed',
            false
          )
          results.push({ tool: action.tool, ok: false, detail: toolError.message })
          await patchAgentTask(task.id, {
            status: 'failed', failedTool: action.tool, error: toolError.message, finishedAt: Date.now()
          })
          return { results, graph, stopped: true, error: toolError }
        }
        const candidate = dedupe([...preflight.actions, action, ...actions]).sort(
          (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
        )
        const projected = estimateToolActions([...completed, ...candidate])
        if (budget > 0 && projected.calls > budget) {
          const toolError = new AgentToolError(
            `发现缺失依赖，但补齐后预计需要 ${projected.calls} 次生成调用，超过预算 ${budget}`,
            action.tool,
            'postcondition_failed',
            false
          )
          results.push({ tool: action.tool, ok: false, detail: toolError.message })
          await patchAgentTask(task.id, {
            status: 'failed', failedTool: action.tool, error: toolError.message, finishedAt: Date.now()
          })
          return { results, graph, stopped: true, error: toolError }
        }
        options.onEvent({ kind: 'log', label: `执行前自检：${preflight.detail}` })
        await patchAgentTask(task.id, {
          repairCount: (dependencyAttempts.get(stepKey) || 0) + replanAttempt,
          lastRecovery: preflight.detail
        })
        actions = candidate
        continue
      }

      options.onEvent({ kind: 'step', step: stepKey, label: stepLabel, status: 'running' })
      await patchAgentTask(task.id, { currentStep: action.tool })
      try {
        const detail = await executeRegisteredTool(action, {
          signal: options.signal,
          onLog: (label) => options.onEvent({ kind: 'log', label, step: stepKey })
        })
        const verificationIssue = verifyRegisteredTool(action)
        if (verificationIssue) {
          throw new AgentToolError(
            `工具返回成功，但结果验收未通过：${verificationIssue}`,
            action.tool,
            'postcondition_failed',
            true
          )
        }
        completed.push(action)
        results.push({ tool: action.tool, ok: true, detail })
        if (recoveringSteps.delete(stepKey)) {
          options.onEvent({ kind: 'log', label: `自动修复成功，继续后续任务：${stepLabel}` })
        }
        options.onEvent({ kind: 'step', step: stepKey, label: stepLabel, status: 'done' })
        await patchAgentTask(task.id, {
          completedTools: completed.map((item) => item.tool),
          currentStep: undefined
        })
      } catch (error: any) {
        const toolError = error instanceof AgentToolError
          ? error
          : new AgentToolError(error?.message ?? String(error), action.tool, 'execution_failed')
        options.onEvent({ kind: 'step', step: stepKey, label: stepLabel, status: 'fail' })
        const fingerprint = `${stepKey}:${toolError.code}:${toolError.message.replace(/\d+/g, '#').slice(0, 180)}`
        const sameFailureCount = (failureFingerprints.get(fingerprint) || 0) + 1
        failureFingerprints.set(fingerprint, sameFailureCount)

        if (
          toolError.recoverable &&
          options.replan &&
          replanAttempt < maxReplans &&
          sameFailureCount < 2 &&
          !options.signal?.aborted
        ) {
          replanAttempt++
          recoveringSteps.add(stepKey)
          options.onEvent({ kind: 'log', label: `结果未达标，正在诊断并重新规划（${replanAttempt}/${maxReplans}）：${toolError.message}` })
          await patchAgentTask(task.id, {
            repairCount: replanAttempt + [...dependencyAttempts.values()].reduce((sum, value) => sum + value, 0),
            lastRecovery: `${toolError.code}：${toolError.message}`
          })
          const replacement = await options.replan({
            error: toolError,
            completed,
            remaining: [action, ...actions],
            attempt: replanAttempt
          })
          actions = dedupe([...replacement.map(validateToolAction), action, ...actions]).sort(
            (a, b) => toolPhase(a.tool) - toolPhase(b.tool)
          )
          if (actions.length) continue
        }

        results.push({ tool: action.tool, ok: false, detail: toolError.message })
        options.onEvent({ kind: 'log', label: sameFailureCount >= 2 ? `同一错误重复出现，已停止盲目重试：${toolError.message}` : `已暂停：${toolError.message}` })
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
    return { results, graph, stopped: false, finalSay }
  } catch (error: any) {
    await patchAgentTask(task.id, {
      status: options.signal?.aborted ? 'cancelled' : 'failed',
      error: error?.message ?? String(error),
      finishedAt: Date.now()
    })
    throw error
  }
}
