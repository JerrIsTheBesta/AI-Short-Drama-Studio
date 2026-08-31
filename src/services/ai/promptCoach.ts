/**
 * 图生视频画布：按用户原文扩写节点提示词，补画面层次，不另起故事，不改格式。
 */
import { callLLM, getAIMode } from './client'
import { parseJsonRobust, stripModelWrappers } from '@/utils/jsonRepair'

export type PromptCoachKind = 'image' | 'video'

export interface OptimizeNodePromptInput {
  kind: PromptCoachKind
  nodeLabel: string
  currentPrompt: string
  userHint?: string
  script?: string
  duration?: number
  signal?: AbortSignal
}

export interface OptimizeNodePromptResult {
  prompt: string
  note: string
}

const H3_HEADINGS =
  /(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music|\bdialogue)\s*:/i

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 原文里必须原样留下的标题、节拍和指代。 */
export function extractFormatAnchors(text: string): string[] {
  const t = String(text || '')
  const anchors: string[] = []
  for (const m of t.matchAll(
    /(?:^|\n)\s*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music|dialogue)\s*:/gi
  )) {
    anchors.push(`${m[1]}:`)
  }
  for (const m of t.matchAll(/(?:^|\n)\s*(画面|镜头|声音|对白|台词|运镜|参考图)[：:]/g)) {
    anchors.push(m[1])
  }
  for (const m of t.matchAll(/\[Shot\s*[^\]]+\]/gi)) anchors.push(m[0])
  for (const m of t.matchAll(/\d+\.\d{2}\s*[-–—to]+\s*\d+\.\d{2}/gi)) anchors.push(m[0])
  for (const m of t.matchAll(/图\s*\d+\s*=/g)) anchors.push(m[0].replace(/\s+/g, ''))
  return unique(anchors)
}

function normalizeForAnchor(text: string): string {
  return text.replace(/\s+/g, '').replace(/[–—−]/g, '-').toLowerCase()
}

function hasAnchor(text: string, anchor: string): boolean {
  if (normalizeForAnchor(text).includes(normalizeForAnchor(anchor))) return true
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
  return new RegExp(escaped, 'i').test(text)
}

function formatBreakReason(original: string, next: string): string | null {
  const origAnchors = extractFormatAnchors(original)
  if (!origAnchors.length) {
    if (H3_HEADINGS.test(next) && !H3_HEADINGS.test(original)) {
      return '扩写把原文改成了另一套分段格式'
    }
    return null
  }
  const missing = origAnchors.filter((anchor) => !hasAnchor(next, anchor))
  if (missing.length) return `扩写丢掉了原格式：${missing.slice(0, 8).join('、')}`
  return null
}

function isReasoningDump(text: string): boolean {
  const t = String(text || '')
  if (t.length < 40) return false
  const hits = [
    /需要判断/,
    /需要输出\s*JSON/,
    /需要遵守输出JSON/,
    /系统规则/,
    /需要权衡/,
    /我们应保留/,
    /用户当前提示词是/,
    /用户原文若已是/,
    /只输出 JSON/,
    /评估者/,
    /这里用户当前提示词/
  ].filter((re) => re.test(t)).length
  return hits >= 2
}

function mockExpand(input: OptimizeNodePromptInput): OptimizeNodePromptResult {
  const base = input.currentPrompt.trim()
  if (!base) {
    return {
      prompt: input.kind === 'video' ? '一条连续镜头。写清谁在做什么、光从哪来。' : '一张能看清主体和光线的静帧。',
      note: '演示模式：原文为空，只给了占位。'
    }
  }
  return { prompt: base, note: '演示模式：不改格式，原文原样保留。' }
}

function formatRules(input: OptimizeNodePromptInput, current: string): string {
  const kindLabel = input.kind === 'video' ? '图生视频' : '文生图 / 图生图'
  const duration = input.kind === 'video' ? Math.max(1, Math.round(input.duration || 8)) : 0
  const anchors = extractFormatAnchors(current)
  const anchorLine = anchors.length
    ? `原文必须保留的标记：${anchors.join('、')}`
    : '原文没有分段标题。不要给它套 MiniMax 六段或任何新模板。'

  const shotBlock =
    input.kind === 'video'
      ? `这是连续 ${duration} 秒的一条镜头：只加厚开幅、动作怎么起、怎么收，不要切镜，不要新按秒切段。原文里已有的秒标记原样保留。`
      : '这是静帧：只加厚已经能看见的画面，不要写时间流逝。'

  return `你是提示词润色助手。只加厚原文里已有的画面，绝对不改变格式。
任务类型：${kindLabel}。
格式铁律：
- ${anchorLine}
- 标题、分段、[Shot]、图1=、0.00-2.00 这类标记的名字和顺序都不能改。
- 禁止把自由段落改成六段，也禁止把已有分段拆掉、合并或改名。
- 只在原有段落内部写得更具体：眉眼嘴、手、身体、光、材质、声音。
- 台词、人名、服装、场景限制、参考图指代一律不动。
- 原来用中文的句子继续中文，原来用英文的句子继续英文，不要整段互译。
${shotBlock}
硬性要求：
- 没写的剧情不要编。
- 禁止套话，禁止分析过程。prompt 只能是给生成模型看的全文。
只输出 JSON：{"prompt":"扩写后的全文","note":"改了什么，一两句中文"}`
}

async function askOnce(
  input: OptimizeNodePromptInput,
  current: string,
  hint: string,
  script: string,
  extra = ''
) {
  return callLLM({
    jsonMode: true,
    temperature: extra ? 0.2 : 0.35,
    maxTokens: 5000,
    signal: input.signal,
    messages: [
      { role: 'system', content: formatRules(input, current) },
      {
        role: 'user',
        content: `节点：${input.nodeLabel}

当前提示词：
${current || '（空）'}

用户补充：
${hint || '（没有额外要求，按更有画面感来扩，但不要改格式）'}

剧情参考：
${script ? script.slice(0, 6000) : '（无）'}
${extra}

直接给出扩写后的全文。格式必须与当前提示词一致。`
      }
    ]
  })
}

function readPrompt(content: string): { prompt: string; note: string } | null {
  try {
    const parsed = parseJsonRobust(content) as {
      prompt?: string
      optimizedPrompt?: string
      note?: string
    }
    const prompt = String(parsed.prompt || parsed.optimizedPrompt || '').trim()
    if (prompt.length >= 8 && !isReasoningDump(prompt)) {
      return { prompt, note: String(parsed.note || '已按原文加厚画面，格式未改。').trim() }
    }
  } catch {
    /* ignore */
  }
  const fallback = stripModelWrappers(content).trim()
  if (fallback.length >= 8 && !isReasoningDump(fallback) && fallback[0] !== '{') {
    return { prompt: fallback, note: '模型没按 JSON 返回，已尽量保留扩写正文。' }
  }
  return null
}

export async function optimizeNodePrompt(
  input: OptimizeNodePromptInput,
  onProgress?: (msg: string) => void
): Promise<OptimizeNodePromptResult> {
  const current = input.currentPrompt.trim()
  const hint = input.userHint?.trim() || ''
  const script = input.script?.trim() || ''
  if (!current && !hint && !script) {
    throw new Error('先在节点里写一句要生成什么，或贴一段剧情参考。')
  }
  if (getAIMode() === 'mock') return mockExpand(input)
  if (!current) {
    throw new Error('先在节点里写下提示词。扩写只加厚原文，不会另起一套格式。')
  }

  onProgress?.('正在按原文格式加厚提示词…')
  const first = await askOnce(input, current, hint, script)
  let result = readPrompt(first.content)
  let breakReason = result ? formatBreakReason(current, result.prompt) : '没有得到可用提示词'

  if (result && !breakReason) return result

  onProgress?.('上次改了格式，正在按原文结构重写…')
  const retry = await askOnce(
    input,
    current,
    hint,
    script,
    `\n上次结果不合格：${breakReason || '格式被改了'}。必须用原文的标题和分段，只加厚内容，不要换模板。`
  )
  result = readPrompt(retry.content)
  if (!result || isReasoningDump(result.prompt)) {
    throw new Error('扩写写成了分析过程，没有得到提示词。请换一个模型或再试一次。')
  }
  breakReason = formatBreakReason(current, result.prompt)
  if (breakReason) {
    throw new Error(`${breakReason}。原文格式必须保留，请再试一次。`)
  }
  return result
}
