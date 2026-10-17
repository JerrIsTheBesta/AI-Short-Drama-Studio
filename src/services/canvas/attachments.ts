/**
 * 对话附件：把本地文本文件内容注入智能体本轮材料。
 * 桌面端已在设置里授权文件访问；地址一律以用户给的路径为准。
 */
import { desktop, isDesktop } from '@/services/desktop'

export interface AgentAttachment {
  name: string
  /** 本地绝对路径（有的话可去重、可追溯） */
  path?: string
  content: string
}

const MAX_FILE_CHARS = 200_000
const MAX_TOTAL_CHARS = 500_000

function limitedContent(content: string): string {
  if (content.length <= MAX_FILE_CHARS) return content
  return `${content.slice(0, MAX_FILE_CHARS)}\n\n【内容过长，已截取前 ${MAX_FILE_CHARS.toLocaleString()} 个字符】`
}

const TEXT_PATH_RE =
  /[A-Za-z]:[\\/][^\n"'“”‘’<>|*?]*?\.(?:txt|md|markdown|fountain|srt|ass|lrc|json|csv)/gi

/** 从用户消息里的本地路径 + 显式附件构建材料块；没有材料返回空串。 */
export async function buildMaterialBlock(
  userText: string,
  attachments?: AgentAttachment[],
  onLog?: (label: string) => void
): Promise<string> {
  const parts: string[] = []
  let totalChars = 0
  const append = (label: string, content: string) => {
    if (totalChars >= MAX_TOTAL_CHARS) return
    const remaining = MAX_TOTAL_CHARS - totalChars
    const normalized = limitedContent(content).slice(0, remaining)
    parts.push(`${label}\n${normalized}`)
    totalChars += normalized.length
  }
  for (const a of attachments || []) {
    append(`【附件：${a.name}】`, a.content)
  }
  const known = new Set((attachments || []).map((a) => (a.path || a.name).toLowerCase()))
  for (const m of userText.matchAll(TEXT_PATH_RE)) {
    const p = m[0].trim()
    if (known.has(p.toLowerCase())) continue
    known.add(p.toLowerCase())
    try {
      if (!isDesktop()) throw new Error('读本地文件需要桌面端（已安装的应用）')
      const content = await desktop().readText(p)
      append(`【本地文件：${p}】`, content)
      onLog?.(`已读取本地文件 ${p}`)
    } catch (e) {
      parts.push(`【本地文件：${p} 读取失败：${e instanceof Error ? e.message : String(e)}】`)
    }
  }
  return parts.length
    ? `以下是本轮可用的本地材料（用户通过附件或路径提供），直接使用这些内容干活，不要要求用户重新粘贴：\n\n${parts.join('\n\n')}`
    : ''
}
