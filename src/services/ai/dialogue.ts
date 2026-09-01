/**
 * 去掉剧本常见的“人物名：”前缀，只保留真正需要朗读的内容。
 * 项目里仍保存完整原文，便于字幕和编辑器显示；仅在送入 H3/TTS 时清洗。
 */

const SPEAKER_RE = /^(旁白|画外音|解说|主持人|人声|台词|对白|narrator|voiceover)$/i
const NAME_RE = /^(?:[\u3400-\u9fff]{1,6})(?:说|问|答)?$/
const DIRECTION_RE =
  /景别|镜头|站位|中景|近景|特写|全景|远景|推近|拉远|横摇|运镜|机位|构图|画面中|四宫|六格|分镜|过肩|正反打|视线|承接上一镜|本镜可见|留给下一镜|画风|质感|噪点|武侠|场记|时长轴|参考图|人设|首帧|摄像机|情感镜头|integrated_multimodal|overall_soundscape|Camera language|Performance direction|non_diegetic/
const PLACEHOLDER_SPEECH_RE =
  /^(?:无|没有|暂无|空|无对白|无台词|无口播|不对白|不说话|没有台词|没有对白|none|n\/a|na|null|nil|-|—|–|\/|／)$/i
const PERF_HINT_RE =
  /哭腔|哽咽|抽泣|颤抖|低声|轻声|小声|大声|喊道|怒吼|冷冷|喘|气音|破音|沙哑|咬牙|画外|旁白|哭着|笑着|泣|带着哭|带着笑|压着嗓|压低|OS|VO/
const PERF_PREFIX_RE =
  /^(?:带着[^：:\n]{1,8}|哭着|笑着|低声|轻声|小声|大声|哽咽|颤抖|喘着气|冷冷地|平静地|泣声)[地的]?\s*[：:]\s*/

/** 「无」「无对白」不是台词，不能进 <d>，否则会被念出来。 */
export function isPlaceholderSpokenLine(text: string): boolean {
  const t = String(text || '')
    .replace(/<\/?d>/gi, '')
    .replace(/\[(?:Chinese|English|Japanese|Korean)\]/gi, '')
    .replace(/[“”「」'"'']/g, '')
    .replace(/[。.!！？?\s]/g, '')
    .trim()
  return !t || PLACEHOLDER_SPEECH_RE.test(t)
}

function clipSpokenBody(body: string): string {
  const cut = body.search(/[。！？!?]\s*(?:镜头|画面|景别|运镜|机位|构图|站位)/)
  if (cut >= 0) return body.slice(0, cut + 1).trim()
  return body.trim()
}

/** 镜头描述、场记、宫格说明不能当台词念。 */
export function looksLikeShotDirection(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (/^图\s*\d+\s*[/：:=是]/.test(t) || /^<Picture\s*\d+>/i.test(t)) return true
  if (/Reference pictures/i.test(t)) return true
  if (/\[\d{2}:\d{2}\.\d{3}/.test(t) || /\[Shot\s*\d+\]/i.test(t)) return true
  if (/\d+\s*[-–~到至]\s*\d+\s*秒/.test(t) || /^\d+[s秒]\s*[：:]/.test(t)) return true
  if (/^(?:镜头|景别|地点|出场|站位|视线|动作承接|可见画面|道具|现场声|画风|时长|场记)\s*[：:]/.test(t)) {
    return true
  }
  if (/这一镜怎么演|连续\s*\d+\s*秒|情感镜头|武侠|雨夜打斗|合围|推近|缓推/.test(t) && !/[“「]/.test(t)) {
    return true
  }
  if (t.length > 40 && !/[。！？!?]/u.test(t) && /[\u3400-\u9fff]/.test(t)) return true
  if (t.length > 12 && DIRECTION_RE.test(t) && !/[“「]/.test(t)) return true
  if (DIRECTION_RE.test(t) && /[；;]/.test(t)) return true
  return false
}

/** 表演提示不能进 <d>，否则会被念出来。只留真正要说的字。 */
export function stripSpokenStageDirection(text: string): string {
  let t = String(text || '').trim()
  if (!t) return ''
  t = t.replace(/^(?:[（(【[][^）)】\]]{1,24}[）)】\]]\s*[：:]?\s*)+/, '')
  t = t.replace(/[（(【[][^）)】\]]{1,24}[）)】\]]/g, (block) => (PERF_HINT_RE.test(block) ? '' : block))
  t = t.replace(PERF_PREFIX_RE, '')
  t = t.replace(/^[“”「」『』"'']+|[“”「」『』"'']+$/g, '')
  t = t.replace(/[“”「」『』]/g, '')
  t = t.replace(/^[：:\s]+|[：:\s]+$/g, '')
  return t.replace(/\s+/g, ' ').trim()
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
      const looksLikeSpeaker = SPEAKER_RE.test(label) || NAME_RE.test(label) || PERF_HINT_RE.test(label)
      const body = looksLikeSpeaker ? match[2].trim() : trimmed
      return isPlaceholderSpokenLine(body) ? '' : body
    })
    .filter(Boolean)
    .join(' ')
    .trim()

  const spoken = stripSpokenStageDirection(clipSpokenBody(cleaned))
  if (!spoken) return ''
  if (looksLikeShotDirection(spoken)) return ''
  if (isPlaceholderSpokenLine(spoken)) return ''
  return spoken
}
