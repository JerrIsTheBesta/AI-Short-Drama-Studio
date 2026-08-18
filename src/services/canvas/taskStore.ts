import { useProjectStore } from '@/stores'
import type {
  AgentAutonomy,
  AgentChatMessage,
  AgentTaskRecord,
  AgentWorkspaceState
} from '@/types'

const MAX_MESSAGES = 120
const MAX_TASKS = 40

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function defaults(): AgentWorkspaceState {
  return { autonomy: 'gated', messages: [], tasks: [], callBudget: 24 }
}

export function getAgentState(): AgentWorkspaceState {
  return useProjectStore().current?.agentState ?? defaults()
}

async function commit(state: AgentWorkspaceState) {
  const project = useProjectStore()
  if (!project.current) return
  project.setAgentState(state)
  await project.save()
}

export async function setAgentAutonomy(autonomy: AgentAutonomy) {
  await commit({ ...getAgentState(), autonomy })
}

export async function appendAgentMessage(
  role: AgentChatMessage['role'],
  content: string
): Promise<AgentChatMessage> {
  const message: AgentChatMessage = {
    id: id('msg'),
    role,
    content,
    createdAt: Date.now()
  }
  const state = getAgentState()
  await commit({ ...state, messages: [...state.messages, message].slice(-MAX_MESSAGES) })
  return message
}

export async function replaceAgentMessages(messages: AgentChatMessage[]) {
  await commit({ ...getAgentState(), messages: messages.slice(-MAX_MESSAGES) })
}

export async function beginAgentTask(
  request: string,
  estimate?: { calls: number; seconds: number }
): Promise<AgentTaskRecord> {
  const task: AgentTaskRecord = {
    id: id('task'),
    request,
    status: 'planned',
    completedTools: [],
    estimatedCalls: estimate?.calls,
    estimatedSeconds: estimate?.seconds,
    startedAt: Date.now()
  }
  const state = getAgentState()
  await commit({ ...state, tasks: [...state.tasks, task].slice(-MAX_TASKS) })
  return task
}

export async function patchAgentTask(id: string, patch: Partial<AgentTaskRecord>) {
  const state = getAgentState()
  const tasks = state.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))
  await commit({ ...state, tasks })
}

export function latestAgentTask(): AgentTaskRecord | undefined {
  return getAgentState().tasks.at(-1)
}

