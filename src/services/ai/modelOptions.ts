/** 接入助手从模型文档里抽出的节点选项。文档没写的字段保持空，节点就不显示。 */

export type DocImageResolution = '1k' | '2k' | '4k'

export interface ModelNodeOptions {
  /** 文档列出的出图档位，例如 1K / 2K */
  imageResolutions?: DocImageResolution[]
  /** 文档有音频开关时才为 true */
  videoAudio?: boolean
  /** 文档写明尾帧必填时才为 true */
  lastFrameRequired?: boolean
  /** 文档里的音频字段名，默认 audio */
  audioField?: string
}

const RESOLUTION_ORDER: DocImageResolution[] = ['1k', '2k', '4k']

export function normalizeDocImageResolution(value: unknown): DocImageResolution | undefined {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s/g, '')
  if (raw === '1k' || raw === '1') return '1k'
  if (raw === '2k' || raw === '2') return '2k'
  if (raw === '4k' || raw === '4') return '4k'
  return undefined
}

export function normalizeAudioField(value: unknown): string | undefined {
  const field = String(value || '').trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return undefined
  if (!/audio/i.test(field)) return undefined
  return field
}

export function normalizeModelNodeOptions(raw: unknown): ModelNodeOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const listed = Array.isArray(src.imageResolutions) ? src.imageResolutions : []
  const imageResolutions = RESOLUTION_ORDER.filter((tier) =>
    listed.some((item) => normalizeDocImageResolution(item) === tier)
  )
  const out: ModelNodeOptions = {}
  if (imageResolutions.length) out.imageResolutions = imageResolutions
  if (src.videoAudio === true) out.videoAudio = true
  if (src.lastFrameRequired === true) out.lastFrameRequired = true
  const audioField = normalizeAudioField(src.audioField)
  if (out.videoAudio && audioField) out.audioField = audioField
  return Object.keys(out).length ? out : undefined
}

export function pickDocImageResolution(
  value: unknown,
  choices: DocImageResolution[] | undefined
): DocImageResolution | undefined {
  if (!choices?.length) return undefined
  const picked = normalizeDocImageResolution(value)
  if (picked && choices.includes(picked)) return picked
  return choices[0]
}

export function docImageResolutionLabel(value: DocImageResolution): string {
  if (value === '1k') return '1K'
  if (value === '4k') return '4K'
  return '2K'
}
