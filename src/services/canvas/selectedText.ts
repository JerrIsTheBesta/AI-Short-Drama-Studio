import { callLLM } from '@/services/ai/client'
import { useProjectStore } from '@/stores'
import type { CanvasNode } from '@/types'

export function isCanvasTextNode(node?: CanvasNode | null): boolean {
  return node?.type === 'script' || node?.type === 'captureText'
}

const NODE_SHORTCUTS = new Set([
  '更有画面感：补构图、光影、材质和空气感，不改原文格式',
  '把眉眼嘴、手和身体怎么动写具体，不改原文格式',
  '对照剧本，只写这一镜该发生的事，不改原文格式',
  '用这个节点最后一帧继续往下拍'
])

/** 选中节点上方的快捷方式。这些只改当前节点，不能拿去重拆整场剧本。 */
export function isDirectNodeShortcut(text: string): boolean {
  return NODE_SHORTCUTS.has(text.trim())
}

/** 选中剧本或分镜文字后，用户是在改这段文字，不是在下令开拍。 */
export function isSelectedTextEdit(text: string, node?: CanvasNode | null): boolean {
  if (!isCanvasTextNode(node)) return false
  const t = text.trim()
  if (!t || /^(?:继续|确认|开始拍摄|分析剧本)/.test(t) || /^重新规划/.test(t)) return false
  if (/节点|下载|合成|截取|参考图|生图|生成视频|生成图片/.test(t) && !/这段|这段文字|剧本|正文|台词|选中的文/.test(t)) return false
  return /改|润色|缩短|加长|重写|修改|换个|写得|改成|删掉|补上|调整|扩写/.test(t)
}

export async function editSelectedCanvasText(text: string, node: CanvasNode, signal?: AbortSignal): Promise<string> {
  const project = useProjectStore()
  const current = project.current
  if (!current) throw new Error('没有打开的项目')
  const source = node.type === 'script' ? current.script?.content || '' : node.data.prompt || ''
  if (!source.trim()) throw new Error('选中的文本是空的，没有可以改的内容')
  const resp = await callLLM({
    signal,
    temperature: 0.4,
    disableThinking: true,
    timeoutMs: 120_000,
    messages: [
      {
        role: 'system',
        content: '你在修改用户当前选中的这一段文字。只输出修改后的全文，不要解释，不要加引号或标题。没要求改的人名、对白和事实保持原样。'
      },
      { role: 'user', content: `修改要求：${text}\n\n原文：\n${source}` }
    ]
  })
  const next = String(resp.content || '').trim()
  if (!next) throw new Error('没有改出内容')
  if (node.type === 'script') {
    if (!current.script) throw new Error('项目里还没有剧本')
    project.setScript({ ...current.script, content: next })
  } else {
    project.setCanvasNodePrompt(node.id, next)
  }
  await project.save()
  return '已按你的要求改了选中的文本，没有开始生成。'
}

/** 快捷方式或「改当前这一镜」：只动选中节点，不重拆剧本，也不提交生成。 */
export async function runSelectedNodeShortcut(
  text: string,
  node: CanvasNode,
  signal?: AbortSignal,
  onLog?: (message: string) => void
): Promise<string> {
  const request = text.trim()
  if (/最后一帧|末帧|尾帧/.test(request) && /续|继续|往下|接着/.test(request)) {
    const { createTailContinuation } = await import('./agentMedia')
    return createTailContinuation(node.id, '从这一镜的真实最后一帧接着往下演。不重拆剧本，不重拍前面的镜头。', signal, onLog)
  }
  if (node.type === 'script' || node.type === 'captureText') {
    return editSelectedCanvasText(request, node, signal)
  }
  if (node.type !== 'imageGen' && node.type !== 'videoGen') {
    throw new Error('先选中要改的图片、视频或分镜文字。这句不会重拆剧本。')
  }
  const project = useProjectStore()
  const { optimizeNodePrompt } = await import('@/services/ai/promptCoach')
  onLog?.(`正在改「${node.data.label || '当前节点'}」…`)
  const result = await optimizeNodePrompt(
    {
      kind: node.type === 'videoGen' ? 'video' : 'image',
      nodeLabel: `${node.data.label || node.id} · ${node.type === 'videoGen' ? '图生视频' : '生图'}`,
      currentPrompt: node.data.prompt || '',
      userHint: request,
      script: project.current?.script?.content || '',
      duration: node.data.duration,
      signal
    },
    onLog
  )
  project.setCanvasNodePrompt(node.id, result.prompt)
  await project.save()
  return `${result.note}已写进「${node.data.label || '当前节点'}」。没有重拆剧本，也没有开始生成。\n\n${result.prompt}`
}
