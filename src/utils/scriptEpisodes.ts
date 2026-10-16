/**
 * 剧本 Markdown ⇄ 集数（章节）的结构化互转。
 *
 * 约定：
 * - `# 标题` 是整份剧本的名字（最多一个）
 * - `## 标题` 是一集的开始；两集之间的内容属于上一集
 * - 第一个 `##` 之前的内容算「前言」，保留但不属于任何一集
 */

import type { ScriptEpisode } from '@/types'

export interface ParsedScriptDoc {
  title: string
  preamble: string
  episodes: Array<{ title: string; content: string }>
}

export function normalizeScriptText(md: string): string {
  return (md || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

export function countWords(text: string): number {
  return (text || '').replace(/\s/g, '').length
}

/** 正文 → 结构（标题 / 前言 / 每一集的标题与正文） */
export function parseScriptDoc(md: string): ParsedScriptDoc {
  const lines = normalizeScriptText(md).split('\n')
  let title = ''
  const preambleLines: string[] = []
  const episodes: Array<{ title: string; content: string[] }> = []
  let current: { title: string; content: string[] } | null = null
  let sawTitle = false

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/)
    if (h1 && !sawTitle) {
      title = h1[1].trim()
      sawTitle = true
      continue
    }
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2) {
      if (current) episodes.push(current)
      current = { title: h2[1].trim(), content: [] }
      continue
    }
    if (current) current.content.push(line)
    else preambleLines.push(line)
  }
  if (current) episodes.push(current)

  const preamble = preambleLines.join('\n').trim()
  const cleaned = episodes.map((ep) => ({
    title: ep.title,
    content: ep.content.join('\n').trim()
  }))

  // 没有任何二级标题：整篇当成第一集
  if (!cleaned.length) {
    return {
      title,
      preamble: '',
      episodes: [{ title: '第 1 集', content: preamble }]
    }
  }
  return { title, preamble, episodes: cleaned }
}

export function serializeScriptDoc(parsed: ParsedScriptDoc): string {
  const chunks: string[] = []
  if (parsed.title.trim()) chunks.push(`# ${parsed.title.trim()}\n`)
  if (parsed.preamble.trim()) chunks.push(`${parsed.preamble.trim()}\n`)
  for (const ep of parsed.episodes) {
    chunks.push(`## ${ep.title.trim() || '未命名'}\n`)
    const body = (ep.content || '').trim()
    if (body) chunks.push(`${body}\n`)
  }
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** 结构 → 带 id/字数的集列表，供界面渲染 */
export function toEpisodes(parsed: ParsedScriptDoc, docId: string): ScriptEpisode[] {
  return parsed.episodes.map((ep, index) => ({
    id: `${docId}#${index}`,
    index,
    title: ep.title,
    content: ep.content,
    wordCount: countWords(ep.content)
  }))
}

/** 生成下一集的默认标题：沿用「第 N 集」格式 */
export function nextEpisodeTitle(parsed: ParsedScriptDoc): string {
  const n = parsed.episodes.length + 1
  return `第 ${n} 集`
}

export const NEW_EPISODE_BODY = `> 一句话概括本集发生的事

**场景**：
**人物**：
**剧情**：
`

/** 追加一集，返回新的 Markdown 与这一集的下标 */
export function appendEpisode(md: string, title?: string): { markdown: string; index: number } {
  const parsed = parseScriptDoc(md)
  parsed.episodes.push({
    title: title?.trim() || nextEpisodeTitle(parsed),
    content: NEW_EPISODE_BODY.trim()
  })
  return { markdown: serializeScriptDoc(parsed), index: parsed.episodes.length - 1 }
}

/** 在指定位置插入一集 */
export function insertEpisode(
  md: string,
  at: number,
  title?: string
): { markdown: string; index: number } {
  const parsed = parseScriptDoc(md)
  const pos = Math.max(0, Math.min(parsed.episodes.length, at))
  parsed.episodes.splice(pos, 0, {
    title: title?.trim() || `第 ${pos + 1} 集`,
    content: NEW_EPISODE_BODY.trim()
  })
  return { markdown: serializeScriptDoc(parsed), index: pos }
}

/** 删除一集；至少保留一集 */
export function removeEpisode(md: string, index: number): { markdown: string; removed: boolean } {
  const parsed = parseScriptDoc(md)
  if (parsed.episodes.length <= 1) return { markdown: md, removed: false }
  if (index < 0 || index >= parsed.episodes.length) return { markdown: md, removed: false }
  parsed.episodes.splice(index, 1)
  return { markdown: serializeScriptDoc(parsed), removed: true }
}

/** 改某一集的标题和/或正文 */
export function updateEpisode(
  md: string,
  index: number,
  patch: { title?: string; content?: string }
): string {
  const parsed = parseScriptDoc(md)
  const ep = parsed.episodes[index]
  if (!ep) return md
  if (patch.title !== undefined) ep.title = patch.title.trim() || ep.title
  if (patch.content !== undefined) ep.content = patch.content
  return serializeScriptDoc(parsed)
}

/** 上下移动某一集 */
export function moveEpisode(md: string, from: number, to: number): string {
  const parsed = parseScriptDoc(md)
  if (from === to) return md
  if (from < 0 || from >= parsed.episodes.length) return md
  const target = Math.max(0, Math.min(parsed.episodes.length - 1, to))
  const [item] = parsed.episodes.splice(from, 1)
  parsed.episodes.splice(target, 0, item)
  return serializeScriptDoc(parsed)
}

/** 按一集一份 Markdown 导出（文件名安全） */
export function episodeMarkdown(title: string, content: string): string {
  const heading = title.trim() || '未命名'
  const body = (content || '').trim()
  return `# ${heading}\n\n${body}\n`
}
