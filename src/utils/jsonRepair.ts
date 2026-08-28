/**
 * 把模型常吐的“差不多是 JSON”修成可 JSON.parse 的文本。
 * 只动结构（逗号、括号、全角标点、截断闭合），不改字段里的中文内容。
 */

const WS = /\s/

function nextNonWs(s: string, i: number): { ch: string; index: number } | null {
  for (let j = i; j < s.length; j++) {
    if (!WS.test(s[j])) return { ch: s[j], index: j }
  }
  return null
}

function isValueStart(ch: string): boolean {
  return (
    ch === '{' ||
    ch === '[' ||
    ch === '"' ||
    ch === '-' ||
    ch === 't' ||
    ch === 'f' ||
    ch === 'n' ||
    (ch >= '0' && ch <= '9')
  )
}

export function stripModelWrappers(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/｛/g, '{')
    .replace(/｝/g, '}')
    .trim()
}

export function extractJsonText(content: string): string {
  const s = stripModelWrappers(content)
  if (!s) throw new Error('LLM 返回内容为空')
  const start = s.indexOf('{')
  if (start === -1) {
    throw new Error(
      `LLM 响应中找不到 JSON 对象（{...}）\n原始内容（前 300 字符）：${content.slice(0, 300)}`
    )
  }
  let inString = false
  let escape = false
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return s.slice(start)
}

function parseErrorContext(text: string, err: Error): string {
  const m = err.message.match(/position (\d+)/i)
  if (!m) return err.message
  const pos = Number(m[1])
  const from = Math.max(0, pos - 90)
  const to = Math.min(text.length, pos + 90)
  return `${err.message}\n出错附近：…${text.slice(from, to)}…`
}

/** 修正常见模型 JSON 小错误；不修改字符串字段内容。 */
export function repairJsonLocally(json: string): string {
  let out = ''
  let inString = false
  let escape = false
  let pendingValueEnd = false

  for (let i = 0; i < json.length; i++) {
    const c = json[i]

    if (inString) {
      if (escape) {
        out += c
        escape = false
        continue
      }
      if (c === '\\') {
        out += c
        escape = true
        continue
      }
      if (c === '"') {
        out += c
        inString = false
        const nxt = nextNonWs(json, i + 1)
        pendingValueEnd = Boolean(nxt && nxt.ch !== ':')
        continue
      }
      if (c === '\n' || c === '\r') {
        out += '\\n'
        if (c === '\r' && json[i + 1] === '\n') i += 1
        continue
      }
      if (c === '\t') {
        out += '\\t'
        continue
      }
      out += c
      continue
    }

    if (WS.test(c)) {
      out += c
      continue
    }

    let ch = c
    if (c === '，') ch = ','
    else if (c === '：') ch = ':'
    else if (c === '“' || c === '”') ch = '"'

    if (ch === '"') {
      if (pendingValueEnd) out += ','
      out += ch
      inString = true
      escape = false
      pendingValueEnd = false
      continue
    }

    if (ch === '{' || ch === '[') {
      if (pendingValueEnd) out += ','
      out += ch
      pendingValueEnd = false
      continue
    }

    if (ch === '}' || ch === ']') {
      out += ch
      pendingValueEnd = true
      continue
    }

    if (ch === ':' || ch === ',') {
      out += ch
      pendingValueEnd = false
      continue
    }

    if (ch === '-' || (ch >= '0' && ch <= '9') || ch === 't' || ch === 'f' || ch === 'n') {
      if (pendingValueEnd) out += ','
      if (ch === 't' || ch === 'f' || ch === 'n') {
        const m = json.slice(i).match(/^(true|false|null)/)
        if (m) {
          out += m[1]
          i += m[1].length - 1
          pendingValueEnd = true
          continue
        }
      }
      const m = json.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
      if (m) {
        out += m[0]
        i += m[0].length - 1
        pendingValueEnd = true
        continue
      }
    }

    out += ch
    pendingValueEnd = false
  }

  return out.replace(/,\s*([}\]])/g, '$1')
}

export function closeTruncatedJson(json: string): string {
  let s = json.trim().replace(/,+\s*$/, '')

  const scan = (text: string) => {
    let inString = false
    let escape = false
    const stack: Array<'{' | '['> = []
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inString) {
        if (escape) escape = false
        else if (c === '\\') escape = true
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === '{') stack.push('{')
      else if (c === '[') stack.push('[')
      else if ((c === '}' || c === ']') && stack.length) stack.pop()
    }
    return { inString, stack }
  }

  let { inString, stack } = scan(s)
  if (inString) s += '"'

  s = s.replace(/,\s*"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*$/, '')
  s = s.replace(/"[^"\\]*(?:\\.[^"\\]*)*"\s*:\s*$/, '')
  s = s.replace(/:\s*$/, '')
  s = s.replace(/,+\s*$/, '')

  ;({ inString, stack } = scan(s))
  if (inString) s += '"'
  ;({ stack } = scan(s))
  while (stack.length) {
    const t = stack.pop()
    s += t === '{' ? '}' : ']'
  }
  return s
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: e as Error }
  }
}

function isUsefulStoryboard(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    (Array.isArray(obj.shots) && obj.shots.length > 0) ||
    (Array.isArray(obj.subjects) && obj.subjects.length > 0) ||
    (Array.isArray(obj.scenes) && obj.scenes.length > 0) ||
    typeof obj.playMarkdown === 'string'
  )
}

/** 鲁棒 JSON 解析：原文 → 结构修复 → 补括号 → 从尾部逐段回切。 */
export function parseJsonRobust(content: string): any {
  const extracted = extractJsonText(content)
  const repaired = repairJsonLocally(extracted)
  const closed = closeTruncatedJson(repaired)
  const first = tryParse(extracted)
  const firstError = first.ok ? undefined : first.error

  for (const candidate of [extracted, repaired, closed]) {
    const r = tryParse(candidate)
    if (r.ok) return r.value
  }

  let best: unknown
  for (let i = repaired.lastIndexOf('}'); i >= 0; i = repaired.lastIndexOf('}', i - 1)) {
    const slice = closeTruncatedJson(repaired.slice(0, i + 1))
    const r = tryParse(slice)
    if (!r.ok || !r.value || typeof r.value !== 'object') continue
    if (isUsefulStoryboard(r.value)) return r.value
    if (!best) best = r.value
  }
  if (best) return best

  throw new Error(
    `JSON.parse 失败：${firstError ? parseErrorContext(extracted, firstError) : '无法恢复合法 JSON'}；本地修复后仍失败。\n尝试解析的内容（前 300 字符）：${extracted.slice(0, 300)}`
  )
}
