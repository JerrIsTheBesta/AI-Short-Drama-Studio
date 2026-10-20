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

/**
 * 任意盘符路径（含文件夹、无后缀文件）。遇到空格 / 引号 / 中文标点即截止（路径里允许中文，如 F:\剧本\），
 * 命中已知文本后缀时只截到后缀为止，避免把后面的指令吃进来（如 F:\剧本\x.txt拆成分镜）。
 */
const ANY_PATH_RE = /[A-Za-z]:[\\/][^\s"'“”‘’<>|*?，。！？；：、]+/g
const TEXT_EXT_RE = /\.(markdown|fountain|json|csv|txt|md|srt|ass|lrc)(?![A-Za-z0-9])/i

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
  for (const m of userText.matchAll(ANY_PATH_RE)) {
    let p = m[0].replace(/[\\/]+$/, '')
    // 路径后面紧跟指令文字时，只保留到已知文本后缀为止
    const extHit = p.match(TEXT_EXT_RE)
    if (extHit && extHit.index !== undefined) p = p.slice(0, extHit.index + extHit[0].length)
    if (!p || known.has(p.toLowerCase())) continue
    known.add(p.toLowerCase())
    const ext = extHit ? extHit[1].toLowerCase() : ''
    if (!extHit && /[^\\/]\.[A-Za-z0-9]{2,5}$/.test(p)) {
      // 有后缀但不是文本格式：不读，明说
      parts.push(`【本地文件：${p} 暂不支持读取（不是文本格式）。请先转成 txt / md，或直接把内容粘贴进来】`)
      onLog?.(`跳过非文本文件 ${p}`)
      continue
    }
    try {
      if (!isDesktop()) throw new Error('读本地文件需要桌面端（已安装的应用）')
      const content = await desktop().readText(p)
      append(`【本地文件：${p}】`, content)
      onLog?.(`已读取本地文件 ${p}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const dirHint = extHit
        ? ''
        : '。如果这是文件夹路径，我列不出目录内容，请给我里面具体文件的完整路径（含后缀）'
      parts.push(`【本地文件：${p} 读取失败：${msg}${dirHint}】`)
      onLog?.(`读取 ${p} 失败`)
    }
  }
  return parts.length
    ? `以下是本轮可用的本地材料（用户通过附件或路径提供），直接使用这些内容干活，不要要求用户重新粘贴：\n\n${parts.join('\n\n')}`
    : ''
}
