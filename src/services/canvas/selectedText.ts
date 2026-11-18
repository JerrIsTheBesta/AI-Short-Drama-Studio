import { callLLM } from '@/services/ai/client'
import { useProjectStore } from '@/stores'
import type { CanvasNode } from '@/types'

export function isCanvasTextNode(node?: CanvasNode | null): boolean {
  return node?.type === 'script' || node?.type === 'captureText'
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
