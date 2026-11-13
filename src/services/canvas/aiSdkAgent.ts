/**
 * 画布智能体的模型核心：Vercel AI SDK。
 * 规划、追问和失败恢复都走 OpenAI 兼容的 chat/completions 工具调用。
 * 工具只负责把动作交回来，真正改画布仍由 toolRegistry 执行。
 */
import { generateText, tool, type ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import { desktop, isDesktop } from '@/services/desktop'
import { getLlmConfig } from '@/services/ai/runtime'
import type { AgentToolName } from './toolRegistry'

const text = z.string().describe('故事原文、提示词、续写方向或要记住的话')
const shotId = z.string().describe('分镜 id，例如 shot_xxx')
const subjectId = z.string().describe('人物 id')
const sceneId = z.string().describe('场景 id')
const nodeId = z.string().describe('画布节点 id')
const sourceNodeId = z.string().describe('上游节点 id。给某个节点往下接时必填')
const targetNodeId = z.string().describe('下游节点 id')
const nodeLabel = z.string().describe('节点显示名')
const visualPrompt = z.string().describe('静帧画面')
const imagePrompt = z.string().describe('实际出图提示词')
const videoPrompt = z.string().describe('视频动态提示词：起幅、动作、运镜、落幅')
const voiceover = z.string().describe('口播，写成「人物名：台词」')
const duration = z.number().describe('秒数')
const cameraMovement = z.enum(['static', 'push', 'pull', 'pan', 'tilt', 'orbit']).describe('运镜')
const extractStage = z.enum(['subjects', 'scenes', 'shots']).describe('只提炼这一步')

function canvasTool(description: string, shape: Record<string, z.ZodType>) {
  return tool({
    description,
    inputSchema: z.object(shape)
  })
}

export const studioAgentTools = {
  seed_script: canvasTool('把用户这几轮的故事原文写入剧本草稿。新故事必须先走这一步。', { text }),
  generate_play: canvasTool('根据草稿写完整 Markdown 剧本。不要同时提炼人物或分镜。', { text: text.optional() }),
  continue_play: canvasTool('在已有剧本后面续写，保留已有场次。', { text: text.optional() }),
  extract_cast: canvasTool('从已有剧本提炼。每次只做缺的那一步：人物、场景或分镜。', { extractStage: extractStage.optional() }),
  generate_storyboard: canvasTool('把已验收的剧本拆成故事板。', {}),
  approve_play: canvasTool('用户确认剧本通过后，打开下游生成。', {}),
  revise_shot: canvasTool('修改某一个分镜的画面、视频提示词、口播或时长。', {
    shotId,
    visualPrompt: visualPrompt.optional(),
    imagePrompt: imagePrompt.optional(),
    videoPrompt: videoPrompt.optional(),
    voiceover: voiceover.optional(),
    duration: duration.optional(),
    cameraMovement: cameraMovement.optional()
  }),
  generate_sheet: canvasTool('给一个人物出设计图。', { subjectId }),
  generate_all_sheets: canvasTool('补齐还没有设计图的人物。', {}),
  generate_scene: canvasTool('给一个场景出锚点图。', { sceneId }),
  generate_all_scenes: canvasTool('补齐还没有锚点图的场景。', {}),
  generate_shot_board: canvasTool('给一个分镜出故事看板。', { shotId }),
  generate_all_boards: canvasTool('补齐缺少的故事看板。', {}),
  generate_shot_image: canvasTool('给一个分镜出关键帧。', { shotId }),
  generate_all_images: canvasTool('补齐缺少的分镜关键帧。', {}),
  generate_shot_frames: canvasTool('给一个分镜画起始帧和结束帧。', { shotId }),
  generate_all_frames: canvasTool('补齐所有需要首尾帧的镜头。', {}),
  generate_video: canvasTool('给一个分镜出视频。', { shotId }),
  generate_all_videos: canvasTool('补齐还没有视频的分镜。', {}),
  generate_audio: canvasTool('给一个分镜出口播。', { shotId }),
  generate_all_audio: canvasTool('补齐还没有口播的分镜。', {}),
  sync_canvas: canvasTool('按当前剧本把画布节点对齐。', {}),
  focus_node: canvasTool('把画布视野移到某个节点。', { nodeId }),
  create_image_node: canvasTool('新建一个自由图片节点。要接在某个节点后面时带上 sourceNodeId。', {
    text,
    sourceNodeId: sourceNodeId.optional()
  }),
  create_video_node: canvasTool('新建一个自由视频节点。要接在某个节点后面时带上 sourceNodeId。', {
    text,
    duration: duration.optional(),
    sourceNodeId: sourceNodeId.optional()
  }),
  connect_nodes: canvasTool('把两个已有节点连起来，上游产出作为下游参考。', { sourceNodeId, targetNodeId }),
  delete_node: canvasTool('删除一个自由图片或视频节点。', { nodeId }),
  arrange_canvas: canvasTool('重新整理画布布局。', {}),
  check_project: canvasTool('检查项目缺了什么，不生成新内容。', {}),
  update_node: canvasTool('修改一个自由图片或视频节点的提示词、名字或时长。', {
    nodeId,
    text: text.optional(),
    nodeLabel: nodeLabel.optional(),
    duration: duration.optional()
  }),
  run_node: canvasTool('运行画布上已有的节点。新建节点要等下一轮拿到真实 id 再运行。', { nodeId }),
  optimize_node_prompt: canvasTool('优化一个自由节点的提示词，不直接出图。', {
    nodeId,
    text: text.optional()
  }),
  remember: canvasTool('记下用户说的长期偏好。', { text }),
  forget: canvasTool('忘掉一条记忆。', { text })
}

const TOOL_NAMES = new Set<string>(Object.keys(studioAgentTools))

function studioChatModel() {
  const { baseUrl, apiKey, model } = getLlmConfig()
  if (!baseUrl || !apiKey || !model) {
    throw new Error('还没配语言模型的地址、密钥或模型名，请到设置里补上')
  }
  const provider = createOpenAICompatible({
    name: 'studio',
    baseURL: baseUrl.replace(/\/+$/, ''),
    apiKey,
    fetch: studioLlmFetch
  })
  return provider.chatModel(model)
}

async function studioLlmFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isDesktop() || typeof desktop().llmFetch !== 'function') {
    return fetch(input, init)
  }
  const request = new Request(input, init)
  if (request.signal.aborted) throw new DOMException('任务已取消', 'AbortError')
  const body = request.method === 'GET' ? '' : await request.text()
  const res = await desktop().llmFetch({
    url: request.url,
    authorization: request.headers.get('authorization') || '',
    body,
    timeoutMs: 120_000
  })
  if (request.signal.aborted) throw new DOMException('任务已取消', 'AbortError')
  return new Response(res.text, {
    status: res.status,
    headers: { 'content-type': 'application/json' }
  })
}

function jsonPlan(textValue: string): { say: string; actions: Record<string, unknown>[] } {
  const start = textValue.indexOf('{')
  const end = textValue.lastIndexOf('}')
  if (start < 0 || end <= start) return { say: textValue.trim(), actions: [] }
  try {
    const obj = JSON.parse(textValue.slice(start, end + 1)) as { say?: unknown; actions?: unknown }
    const actions = Array.isArray(obj.actions)
      ? obj.actions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : []
    return { say: String(obj.say || textValue.trim() || ''), actions }
  } catch {
    return { say: textValue.trim(), actions: [] }
  }
}

export async function planStudioActions(options: {
  system: string
  messages: ModelMessage[]
  temperature?: number
  maxOutputTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 问答时关掉工具，只返回正文。 */
  tools?: boolean
}): Promise<{ say: string; actions: Record<string, unknown>[]; done: boolean }> {
  const useTools = options.tools !== false
  const result = await generateText({
    model: studioChatModel(),
    system: options.system,
    messages: options.messages,
    ...(useTools ? { tools: studioAgentTools, toolChoice: 'auto' as const } : {}),
    temperature: options.temperature ?? 0.2,
    maxOutputTokens: options.maxOutputTokens ?? 2000,
    abortSignal: options.signal,
    timeout: options.timeoutMs ?? 120_000,
    maxRetries: 1
  })

  const calls = result.toolCalls.filter(
    (call) => TOOL_NAMES.has(call.toolName) && !(call as { invalid?: boolean }).invalid
  )
  if (!calls.length) {
    const parsed = jsonPlan(result.text)
    const known = parsed.actions.filter((action) => TOOL_NAMES.has(String(action.tool || '')))
    return {
      say: (result.text.trim() || parsed.say).trim(),
      actions: known,
      done: known.length === 0
    }
  }
  return {
    say: result.text.trim() || '好的，我来做。',
    actions: calls.map((call) => {
      const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {}
      return { tool: call.toolName as AgentToolName, ...input }
    }),
    done: false
  }
}
