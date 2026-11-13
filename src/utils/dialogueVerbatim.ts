/** 只识别明确的人物标签；无法识别的剧本格式不猜测说话人。 */
function cues(text: string, names: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const lines = text.replace(/\*\*/g, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^([^：:\n]{1,24})[：:]\s*(.*)$/)
    if (!match || !names.includes(match[1].trim())) continue
    let body = match[2].trim()
    if (!body) {
      let next = i + 1
      while (next < lines.length && !lines[next].trim()) next++
      if (next < lines.length && /^[「“『]/.test(lines[next].trim())) body = lines[next].trim()
    }
    body = body.replace(/^[（(][^）)]*[）)]\s*/, '').replace(/[\s「」“”『』]/g, '')
    if (body) result.set(match[1].trim(), (result.get(match[1].trim()) || '') + body)
  }
  return result
}

export function dialogueVerbatimIssues(source: string, shots: Array<{ voiceover?: string }>, names: string[]): string[] {
  const original = cues(source, names)
  const assigned = cues(shots.map((shot) => shot.voiceover || '').join('\n'), names)
  const issues: string[] = []
  for (const [name, words] of original) {
    if (assigned.get(name) !== words) issues.push(`严重：${name}的分镜台词与剧本原文不一致。逐字恢复该角色原台词及顺序，不能删改或分配给其他角色；时长不足请拆镜。`)
  }
  return issues
}
