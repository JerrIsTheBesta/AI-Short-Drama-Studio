/** 口播语速：大约每秒 4.2 个汉字，用来按台词长度拆镜。 */
export const DIGITAL_HUMAN_CONCURRENCY = 10
const CHARS_PER_SEC = 4.2
const MIN_SHOT_SEC = 5
const MAX_SHOT_SEC = 15

export function digitalSpeechSegments(text: string): string[] {
  const units = String(text || '')
    .replace(/\s+/g, '')
    .split(/(?<=[。！？；])/)
    .map((part) => part.trim())
    .filter(Boolean)
  const output: string[] = []
  for (const unit of units.length ? units : [String(text || '').trim()]) {
    if (!unit) continue
    if (unit.length <= 30) {
      output.push(unit)
      continue
    }
    const clauses = unit.split(/(?<=[，、：])/).filter(Boolean)
    let current = ''
    for (const clause of clauses) {
      if (current && current.length + clause.length > 30) {
        output.push(current)
        current = ''
      }
      if (clause.length <= 30) current += clause
      else {
        if (current) output.push(current)
        current = ''
        for (let i = 0; i < clause.length; i += 28) output.push(clause.slice(i, i + 28))
      }
    }
    if (current) output.push(current)
  }
  return output.filter(Boolean)
}

export function speechCharWeight(text: string): number {
  return Math.max(1, String(text || '').replace(/[，。！？；：、\s]/g, '').length)
}

/** 这一段台词对应的镜头时长（秒），夹在音画同步工作流 5–15 秒。 */
export function durationFromSpeechText(text: string): number {
  const seconds = speechCharWeight(text) / CHARS_PER_SEC + 0.4
  return Math.min(MAX_SHOT_SEC, Math.max(MIN_SHOT_SEC, Math.round(seconds)))
}

export function planDigitalSpeechShots(text: string): Array<{ text: string; duration: number }> {
  return digitalSpeechSegments(text).map((part) => ({
    text: part,
    duration: durationFromSpeechText(part)
  }))
}

export function estimatedSpeechSeconds(text: string): number {
  return planDigitalSpeechShots(text).reduce((sum, item) => sum + item.duration, 0)
}

/** 按台词字数，把整段上传口播切到这一镜。始终切原音频，不按文案重念。 */
export function speechSliceRange(
  index: number,
  parts: string[],
  totalDuration: number
): { start: number; duration: number } {
  const weights = parts.map((part) => speechCharWeight(part))
  const totalWeight = weights.reduce((sum, item) => sum + item, 0) || 1
  const safeTotal = Math.max(0.4, totalDuration)
  let start = 0
  for (let i = 0; i < index; i++) start += safeTotal * (weights[i] / totalWeight)
  const duration =
    index >= parts.length - 1
      ? Math.max(0.4, safeTotal - start)
      : Math.max(0.4, safeTotal * (weights[index] / totalWeight))
  return { start, duration }
}

export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (!items.length) return
  let cursor = 0
  const n = Math.min(Math.max(1, limit), items.length)
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (cursor < items.length) {
        if (signal?.aborted) throw new DOMException('生成已取消', 'AbortError')
        const item = items[cursor++]
        await worker(item)
      }
    })
  )
}
