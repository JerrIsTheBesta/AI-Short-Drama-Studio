/**
 * 任务规划系统：把解析出来的工具动作整理成用户可读的任务计划。
 * 计划通过 AgentEvent(kind='plan') 推给面板，执行中按 stepKey 同步状态。
 */
import { estimateToolActions, toolPhase, type AgentToolAction } from './toolRegistry'
import { TOOL_LABEL } from './pipeline'

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'fail'

export interface AgentPlanStep {
  /** 与 agentLoop 的 stepKey 同构：tool:shotId/subjectId/sceneId/nodeId */
  key: string
  title: string
  tool: string
  status: PlanStepStatus
  detail?: string
}

export interface AgentPlan {
  intentLabel: string
  summary: string
  steps: AgentPlanStep[]
  calls: number
  seconds: number
}

export function stepKeyOf(action: AgentToolAction): string {
  return `${action.tool}:${action.shotId || action.subjectId || action.sceneId || action.nodeId || ''}`
}

function stepTitle(action: AgentToolAction): string {
  const label = TOOL_LABEL[action.tool] || action.tool
  if (action.tool === 'optimize_node_prompt' || action.tool === 'update_node' || action.tool === 'run_node') {
    return action.nodeId ? `${label} ${action.nodeId}` : label
  }
  return label
}

/** 按工具 phase 排序后生成计划（与 agentLoop 实际执行顺序一致）。 */
export function buildPlanFromActions(actions: AgentToolAction[], intentLabel: string): AgentPlan {
  const sorted = [...actions].sort((a, b) => toolPhase(a.tool) - toolPhase(b.tool))
  const estimate = estimateToolActions(sorted)
  const steps: AgentPlanStep[] = sorted.map((action) => ({
    key: stepKeyOf(action),
    title: stepTitle(action),
    tool: action.tool,
    status: 'pending'
  }))
  const summary =
    steps.length === 1
      ? `计划 1 步：${steps[0].title}`
      : `计划 ${steps.length} 步：${steps.map((s) => s.title).join(' → ')}`
  return {
    intentLabel,
    summary,
    steps,
    calls: estimate.calls,
    seconds: estimate.seconds
  }
}
