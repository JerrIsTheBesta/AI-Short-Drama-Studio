/**
 * 去掉剧本常见的“人物名：”前缀，只保留真正需要朗读的内容。
 * 项目里仍保存完整原文，便于字幕和编辑器显示；仅在送入 H3/TTS 时清洗。
 */

const SPEAKER_RE = /^(旁白|画外音|解说|主持人|人声|台词|对白|narrator|voiceover)$/i
const NAME_RE = /^(?:[\u3400-\u9fff]{1,6})(?:说|问|答)?$/
const DIRECTION_RE =
  /景别|镜头|站位|中景|近景|特写|全景|远景|推近|拉远|横摇|运镜|机位|构图|画面中|四宫|六格|分镜|过肩|正反打|视线|承接上一镜|本镜可见|留给下一镜/

function clipSpokenBody(body: string): string {
  const cut = body.search(/[。！？!?]\s*(?:镜头|画面|景别|运镜|机位|构图|站位)/)
  if (cut >= 0) return body.slice(0, cut + 1).trim()
  return body.trim()
}

/** 镜头描述、场记、宫格说明不能当台词念。 */
export function looksLikeShotDirection(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (t.length > 36 && DIRECTION_RE.test(t)) return true
  if (DIRECTION_RE.test(t) && /[；;]/.test(t)) return true
  return false
}

export function spokenTextOnly(input: string): string {
  const cleaned = input
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line
        .trim()
        .replace(/^(?:\[[^\]\n]{1,80}\]|【[^】\n]{1,80}】)\s*/, '')
        .trim()
      if (!trimmed) return ''
      const match = trimmed.match(/^([^：:\n]{1,12})[：:]\s*(.+)$/)
      if (!match) return trimmed

      const label = match[1].trim().replace(/^[【\[(（]|[】\])）]$/g, '')
      const looksLikeSpeaker = SPEAKER_RE.test(label) || NAME_RE.test(label)
      return looksLikeSpeaker ? match[2].trim() : trimmed
    })
    .filter(Boolean)
    .join(' ')
    .trim()

  const spoken = clipSpokenBody(cleaned)
  if (!spoken) return ''
  if (looksLikeShotDirection(spoken)) return ''
  return spoken
}
