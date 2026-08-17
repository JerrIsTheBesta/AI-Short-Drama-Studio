import { callLLM, getAIMode } from '@/services/ai/client'
import { useProjectStore } from '@/stores'
import {
  runCanvasNode,
  runStoryboard,
  generateSubjectSheet,
  generateScenePlate,
  generateShotImage,
  generateShotVideo
} from './runner'
import { rebuildCanvasGraph } from './layout'

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AgentToolResult {
  tool: string
  ok: boolean
  detail: string
}

function projectDigest() {
  const p = useProjectStore().current
  if (!p) return '（无项目）'
  return JSON.stringify(
    {
      name: p.name,
      topic: p.script?.topic,
      content: (p.script?.content ?? '').slice(0, 800),
      subjects: (p.subjects ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        hasSheet: Boolean(s.designSheetAssetId)
      })),
      scenes: (p.scenes ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        hasPlate: Boolean(s.plateAssetId)
      })),
      shots: p.shots.map((s) => ({
        id: s.id,
        index: s.index,
        title: s.title,
        hasImage: Boolean(s.imageAssetId),
        hasVideo: Boolean(s.videoAssetId)
      }))
    },
    null,
    2
  )
}

const TOOLS_HINT = `你是 AI Cut 桌面端画布智能体。根据用户中文指令，输出严格 JSON：
{
  "say": "给用户看的简短中文回复",
  "actions": [
    { "tool": "generate_storyboard" },
    { "tool": "generate_sheet", "subjectId": "sub_1" },
    { "tool": "generate_scene", "sceneId": "scn_1" },
    { "tool": "generate_shot_image", "shotId": "shot_xxx" },
    { "tool": "generate_video", "shotId": "shot_xxx" },
    { "tool": "generate_all_sheets" },
    { "tool": "generate_all_images" },
    { "tool": "generate_all_videos" },
    { "tool": "sync_canvas" }
  ]
}
规则：
- 没有分镜时先 generate_storyboard
- 配图前先出人设和场景
- 一次不要超过 12 个 actions
- 只输出 JSON`

function parseAgentJson(text: string): { say: string; actions: any[] } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { say: text.slice(0, 400), actions: [] }
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      say: String(obj.say || '好的'),
      actions: Array.isArray(obj.actions) ? obj.actions : []
    }
  } catch {
    return { say: text.slice(0, 400), actions: [] }
  }
}

export async function runAgentTurn(
  history: AgentMessage[],
  userText: string,
  onEvent: (msg: string) => void
): Promise<{ reply: string; results: AgentToolResult[] }> {
  const project = useProjectStore()
  if (!project.current) {
    return { reply: '请先打开或新建一个项目。', results: [] }
  }

  let plan: { say: string; actions: any[] }
  if (getAIMode() === 'real') {
    const resp = await callLLM({
      messages: [
        { role: 'system', content: TOOLS_HINT },
        {
          role: 'user',
          content: `当前项目：\n${projectDigest()}\n\n用户：${userText}`
        }
      ],
      temperature: 0.3,
      jsonMode: true,
      maxTokens: 2000
    })
    plan = parseAgentJson(resp.content)
  } else {
    plan = heuristicPlan(userText)
  }

  const results: AgentToolResult[] = []
  for (const action of plan.actions.slice(0, 12)) {
    const tool = String(action.tool || '')
    onEvent(`执行 ${tool}...`)
    try {
      const detail = await execTool(tool, action, onEvent)
      results.push({ tool, ok: true, detail })
    } catch (e: any) {
      results.push({ tool, ok: false, detail: e?.message ?? String(e) })
    }
  }
  if (project.current) {
    project.setCanvas(rebuildCanvasGraph(project.current, true))
    await project.save()
  }
  const fail = results.filter((r) => !r.ok)
  const extra = fail.length
    ? `\n失败 ${fail.length} 项：${fail.map((f) => f.tool + ' ' + f.detail).join('；')}`
    : results.length
      ? `\n已执行 ${results.length} 步。`
      : ''
  return { reply: plan.say + extra, results }
}

function heuristicPlan(userText: string): { say: string; actions: any[] } {
  const t = userText
  const p = useProjectStore().current!
  const actions: any[] = []
  if (!p.shots.length || /分镜|拆镜|故事板/.test(t)) {
    actions.push({ tool: 'generate_storyboard' })
  }
  if (/人设|角色|主体|全部/.test(t)) actions.push({ tool: 'generate_all_sheets' })
  if (/场景|底板/.test(t)) {
    for (const s of p.scenes ?? []) actions.push({ tool: 'generate_scene', sceneId: s.id })
  }
  if (/配图|图片|关键帧|全部/.test(t)) actions.push({ tool: 'generate_all_images' })
  if (/视频|成片片段/.test(t)) actions.push({ tool: 'generate_all_videos' })
  if (!actions.length) actions.push({ tool: 'generate_storyboard' })
  return { say: '按你的要求开始在画布上执行。', actions }
}

async function execTool(
  tool: string,
  action: any,
  onEvent: (msg: string) => void
): Promise<string> {
  const project = useProjectStore()
  const p = project.current!
  const progress = (_id: string, msg: string) => onEvent(msg)

  if (tool === 'generate_storyboard' || tool === 'extract_cast') {
    await runStoryboard((m) => onEvent(m))
    return `已生成 ${project.current?.shots.length ?? 0} 个分镜`
  }
  if (tool === 'sync_canvas') {
    project.syncCanvasFromProject()
    return '画布已同步'
  }
  if (tool === 'generate_sheet') {
    const sub = (p.subjects ?? []).find((s) => s.id === action.subjectId) || (p.subjects ?? [])[0]
    if (!sub) return '没有主体'
    await generateSubjectSheet(sub, (m) => onEvent(m))
    return `人设 ${sub.name} 完成`
  }
  if (tool === 'generate_all_sheets') {
    for (const sub of p.subjects ?? []) {
      if (!sub.designSheetAssetId) await generateSubjectSheet(sub, (m) => onEvent(m))
    }
    for (const scn of p.scenes ?? []) {
      if (!scn.plateAssetId) await generateScenePlate(scn, (m) => onEvent(m))
    }
    return '人设与场景已补齐'
  }
  if (tool === 'generate_scene') {
    const scn = (p.scenes ?? []).find((s) => s.id === action.sceneId) || (p.scenes ?? [])[0]
    if (!scn) return '没有场景'
    await generateScenePlate(scn, (m) => onEvent(m))
    return `场景 ${scn.name} 完成`
  }
  if (tool === 'generate_shot_image') {
    const shot = p.shots.find((s) => s.id === action.shotId)
    if (!shot) return '找不到分镜'
    await generateShotImage(shot, (m) => onEvent(m))
    return `分镜 ${shot.index + 1} 配图完成`
  }
  if (tool === 'generate_all_images') {
    for (const shot of p.shots) {
      if (!shot.imageAssetId) await generateShotImage(shot, (m) => onEvent(m))
    }
    return '全部配图完成'
  }
  if (tool === 'generate_video') {
    const shot = p.shots.find((s) => s.id === action.shotId)
    if (!shot) return '找不到分镜'
    await generateShotVideo(shot, (m) => onEvent(m))
    return `分镜 ${shot.index + 1} 视频完成`
  }
  if (tool === 'generate_all_videos') {
    for (const shot of p.shots) {
      if (shot.imageAssetId && !shot.videoAssetId) {
        await generateShotVideo(shot, (m) => onEvent(m))
      }
    }
    return '全部视频完成'
  }
  if (tool === 'connect' || tool === 'group' || tool === 'focus_node') {
    return '画布已按项目结构自动连线'
  }
  if (tool === 'run_node' && action.nodeId) {
    await runCanvasNode(action.nodeId, progress)
    return `节点 ${action.nodeId} 完成`
  }
  return `未知工具 ${tool}`
}
