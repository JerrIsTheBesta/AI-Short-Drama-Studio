/**
 * 去掉剧本常见的“人物名：”前缀，只保留真正需要朗读的内容。
 * 项目里仍保存完整原文，便于字幕和编辑器显示；仅在送入 H3/TTS 时清洗。
 */
export function spokenTextOnly(input: string): string {
  return input
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      const match = trimmed.match(/^([^：:\n]{1,12})[：:]\s*(.+)$/)
      if (!match) return trimmed

      const label = match[1].trim().replace(/^[【\[(（]|[】\])）]$/g, '')
      const looksLikeSpeaker =
        /^(旁白|画外音|解说|主持人| narrator|voiceover)$/i.test(label) ||
        /^(?:[\u3400-\u9fff]{1,6})(?:说|问|答)?$/.test(label)
      return looksLikeSpeaker ? match[2].trim() : trimmed
    })
    .filter(Boolean)
    .join(' ')
    .trim()
}
