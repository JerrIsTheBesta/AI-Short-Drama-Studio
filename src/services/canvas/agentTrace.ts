import type { AgentPlan } from './planner'

export type TraceStatus = 'running' | 'done' | 'fail'

/** 智能体面板里一次执行轨迹的行（意图 / 计划 / 步骤 / 日志） */
export interface TraceRow {
  key: string
  kind: 'think' | 'plan' | 'step' | 'log' | 'intent'
  label: string
  status?: TraceStatus
  detail?: string
  plan?: AgentPlan
}
