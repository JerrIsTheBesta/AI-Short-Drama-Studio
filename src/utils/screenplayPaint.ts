const ROLE_COLORS = ['#35d6f7', '#3dd9a0', '#7ec8ff', '#ffb454', '#ff8fa8', '#c4b5fd', '#5eead4', '#f9a8d4']

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function roleColor(name: string, seen: string[]) {
  let index = seen.indexOf(name)
  if (index < 0) {
    seen.push(name)
    index = seen.length - 1
  }
  return ROLE_COLORS[index % ROLE_COLORS.length]
}

/** 这句台词还没说完：行尾不是句号、问号、叹号或收尾引号。 */
function speechStillOpen(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return true
  return !/[。！？!?…」』"”]$/.test(trimmed)
}

function paintLine(line: string, seen: string[], openDialogue: boolean) {
  if (!line.trim()) return { html: '', openDialogue: false }
  const trimmed = line.trim()
  if (/^#\s+/.test(trimmed) || /^第\s*[0-9０-９一二三四五六七八九十]+\s*[集话]/.test(trimmed)) {
    return { html: `<span class="sp-h1">${escapeHtml(line)}</span>`, openDialogue: false }
  }
  if (/^#{2,}\s+/.test(trimmed) || /^场景\s*[0-9０-９]/.test(trimmed)) {
    return { html: `<span class="sp-h2">${escapeHtml(line)}</span>`, openDialogue: false }
  }
  if (/^\*/.test(trimmed) || /^[（(]/.test(trimmed)) {
    return { html: `<span class="sp-note">${escapeHtml(line)}</span>`, openDialogue }
  }
  if (/^出场|^道具|^环境音/.test(trimmed)) {
    return { html: `<span class="sp-cast">${escapeHtml(line)}</span>`, openDialogue: false }
  }
  const narration = line.match(/^(\s*(?:>\s*)?)(旁白|画外音|OS|os)((?:（[^）]{0,24}）|\([^)]{0,24}\))?)(\s*[：:])([\s\S]*)$/)
  if (narration) {
    return {
      html: `<span class="sp-nar">${escapeHtml(narration[1] + narration[2])}</span><span class="sp-paren">${escapeHtml(narration[3])}</span><span class="sp-nar">${escapeHtml(narration[4] + narration[5])}</span>`,
      openDialogue: false,
    }
  }
  const dialogue = line.match(/^(\s*)([\u4e00-\u9fa5A-Za-z0-9·.]{1,12})((?:（[^）]{0,30}）|\([^)]{0,30}\))?)(\s*[：:])([\s\S]*)$/)
  if (dialogue && !/^(场景|出场|道具|环境音)$/.test(dialogue[2])) {
    const color = roleColor(dialogue[2], seen)
    return {
      html: `${escapeHtml(dialogue[1])}<span class="sp-name" style="color:${color}">${escapeHtml(dialogue[2])}</span><span class="sp-paren">${escapeHtml(dialogue[3])}</span><span class="sp-colon">${escapeHtml(dialogue[4])}</span><span class="sp-say">${escapeHtml(dialogue[5])}</span>`,
      openDialogue: speechStillOpen(dialogue[5]),
    }
  }
  if (openDialogue) {
    return { html: `<span class="sp-say">${escapeHtml(line)}</span>`, openDialogue: speechStillOpen(line) }
  }
  return { html: `<span class="sp-act">${escapeHtml(line)}</span>`, openDialogue: false }
}

/** 把剧本文本画成和原文逐字对齐的彩色行，方便叠在输入框上。 */
export function paintScreenplay(source: string) {
  const seen: string[] = []
  let openDialogue = false
  return source.split('\n').map((line) => {
    const painted = paintLine(line, seen, openDialogue)
    openDialogue = painted.openDialogue
    return painted.html
  }).join('\n')
}
