/** Rebase explicit director time ranges, not isolated times or dialogue numbers. */
export function localShotTime(prompt: string): string {
  const range = /(\d{1,3}:\d{2}(?:\.\d{1,3})?|\d+(?:\.\d+)?)\s*[–—~～-]\s*(\d{1,3}:\d{2}(?:\.\d{1,3})?|\d+(?:\.\d+)?)(\s*(?:秒|s)\b|秒)?/gi
  const seconds = (s: string) => s.includes(':') ? Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]) : Number(s)
  const matches = [...prompt.matchAll(range)].filter(m => m[1].includes(':') || Boolean(m[3]?.trim()))
  if (!matches.length) return prompt
  const offset = seconds(matches[0][1])
  if (!offset) return prompt
  // Only shift a coherent cumulative timeline. Never scale or invent beat durations.
  let end = offset
  for (const m of matches) {
    if (seconds(m[1]) !== end || seconds(m[2]) <= end) return prompt
    end = seconds(m[2])
  }
  const clock = (n: number) => {
    const mins = Math.floor(n / 60)
    const secs = Number((n % 60).toFixed(3))
    return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0')
  }
  let result = prompt
  for (const m of matches.reverse()) {
    const a = seconds(m[1]) - offset
    const b = seconds(m[2]) - offset
    const text = m[1].includes(':') ? clock(a) + '–' + clock(b) : a + '–' + b + (m[3] || '')
    result = result.slice(0, m.index!) + text + result.slice(m.index! + m[0].length)
  }
  return result
}
