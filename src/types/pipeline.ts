/**
 * Pipeline / 任务状态
 */

export type TaskStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'

export interface PipelineTask {
  id: string
  /** 任务类型 */
  kind:
    | 'storyboard'
    | 'image'
    | 'video'
    | 'caption'
    | 'export'
  /** 任务标题 */
  title: string
  /** 状态 */
  status: TaskStatus
  /** 进度 0-1 */
  progress: number
  /** 当前步骤描述 */
  message?: string
  /** 错误 */
  error?: string
  /** 开始时间 */
  startedAt?: number
  /** 结束时间 */
  finishedAt?: number
  /** 关联的分镜 ID（可选） */
  shotId?: string
}

export interface AgentTaskGraphNode {
  id: string
  tool: string
  phase: number
  dependsOn: string[]
  estimatedSeconds: number
  estimatedCalls: number
}

export interface AgentTaskGraph {
  id: string
  nodes: AgentTaskGraphNode[]
  createdAt: number
}

export type PipelineStepId =
  | 'script'
  | 'storyboard'
  | 'image'
  | 'video'
  | 'edit'
  | 'caption'
  | 'export'

export interface PipelineStep {
  id: PipelineStepId
  label: string
  description: string
  /** 是否已完成（用户主动标记） */
  done: boolean
  /** 是否可访问 */
  enabled: boolean
  /** 当前处于的步骤 */
  current: boolean
  route: string
  icon: string
}
