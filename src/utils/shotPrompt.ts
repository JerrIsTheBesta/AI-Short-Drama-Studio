/**
 * 分镜提示词：配图用静帧画面，视频用「内容表现」（动作/台词/运镜）。
 * 二者不能混用。
 */

import type { Shot } from '@/types'

const CAMERA_CN: Record<NonNullable<Shot['cameraMovement']>, string> = {
  push: '镜头缓缓推近',
  pull: '镜头慢慢拉远',
  pan: '镜头缓缓横摇',
  tilt: '镜头缓缓上下移',
  static: '镜头基本固定，跟着动作微微晃',
  orbit: '镜头缓缓绕着人走'
}

/** 旧设置值继续兼容；出片时统一编译成 H3 官方 I2VA 英文三段式。 */
export type VideoPromptStyle = 'scene-narrative' | 'formatted'

/** 编辑器里仍写中文内容表现；出片时再编译成 I2VA。用户若已粘贴官方英文三段式，原样使用。 */
export const SCENE_NARRATIVE_SPEC = `只写本镜头连续发生的事，中文约 180-450 字，不要写【环境光影】或 integrated_multimodal_description。按发生顺序写清：镜头从哪里开始；谁先做什么；表情、手脚、道具和环境怎么变；镜头怎么走、怎么收。人物外貌和场景由参考图负责。

有出镜对白时只记口播原词，不要把景别、站位、运镜写成要念的话。没有对白就明确写「无对白」。

禁止：把四视图或场景四宫格当成成片画面、把六格看板写成宫格成片、抄静帧词、无动机跳切、同一镜头让多人轮流说话。`

/** 格式化：人物图 + 空镜底板直接出视频时，内容表现仍写细，出片再套 H3 结构 */
export const FORMATTED_VIDEO_PERFORMANCE_SPEC = SCENE_NARRATIVE_SPEC

export function videoPerformanceSpec(style: VideoPromptStyle = 'scene-narrative'): string {
  return style === 'formatted' ? FORMATTED_VIDEO_PERFORMANCE_SPEC : SCENE_NARRATIVE_SPEC
}

export function videoPromptJsonHint(style: VideoPromptStyle = 'scene-narrative'): string {
  if (style === 'formatted') {
    return '<视频内容表现，中文，180-450字。先点名谁是谁。每个出场的人都要写表情神态（眉眼嘴角眼神）和手脚动作。环境要动（门、桌、光、风、衣摆、桌上的东西）。台词用原词并写说话神态。最后写镜头怎么走、怎么收。不要写成静帧配图词>'
  }
  return '<两段中文场景叙事。第一段：画面中：站位+发型+衣服+动作+年龄的人是名字；用分号点名每个人。空一行后第二段连续叙述谁做什么、表情神态、原词台词、环境动势、镜头怎么走怎么收。180-450字。不要写「从第一帧接着演」，不要标签>'
}

/** 写给编剧 / 质检 / 出视频：默认按当前主流的场景叙事 */
export const VIDEO_PERFORMANCE_SPEC = SCENE_NARRATIVE_SPEC

export function stripFrameLead(text: string): string {
  return (text || '')
    .replace(/^从第一帧接着演[。.]?\s*/g, '')
    .replace(/\n从第一帧接着演[。.]?\s*/g, '\n')
    .trim()
}

/** 去掉已有的「画面中：…是谁」身份段，只留下演戏叙述 */
export function stripIdentityOpening(text: string): string {
  let t = stripFrameLead(text)
  if (!/^画面中[：:]/.test(t)) return t
  const parts = t.split(/\n\s*\n/)
  if (parts.length >= 2) return parts.slice(1).join('\n\n').trim()
  const m = t.match(/^画面中[：:][\s\S]+?(?:是[^；;\n]{1,16}[。；;]\s*)+/)
  if (m && t.slice(m[0].length).trim().length > 40) return t.slice(m[0].length).trim()
  return t
}

export function normalizeIdentityLock(lock: string): string {
  let t = stripFrameLead(lock)
  if (!t) return ''
  if (!/^画面中[：:]/.test(t)) t = `画面中：${t}`
  return t
}

/**
 * 把视觉模型认出的身份 + 分镜内容表现拼成喂给模型的画面正文。
 * 场景叙事：两段中文。格式化：仍按段拼接，外层再套 H3 标签。
 */
export function assembleShotVideoPrompt(opts: {
  style: VideoPromptStyle
  identityLock?: string
  performance: string
  extraLead?: string
}): string {
  const performance = (opts.performance || '').trim()
  if (opts.style === 'formatted') {
    return [opts.extraLead, opts.identityLock, performance].filter(Boolean).join('\n\n')
  }
  const reference = (opts.extraLead || '').trim()
  const ident = normalizeIdentityLock(opts.identityLock || '')
  const action = stripIdentityOpening(performance)
  return [reference, ident, action].filter(Boolean).join('\n\n')
}

const FACE_RE =
  /表情|神态|眉|眼|笑|愣|皱|歪|低头|抬头|眼神|嘴角|脸|惊喜|开心|认真|犹豫|紧张|温柔|点头|摇头|吃惊|无奈|得意|委屈|好奇/
const BODY_RE =
  /跑|走|拿|放|伸|举|弯|站|坐|蹲|抱|推|拉|转身|回头|抬手|伸手|迈|踏|递|捧|摸|拍|跳|停|凑|靠|俯|仰/
const ENV_RE =
  /门|桌|地|光|风|窗|墙|衣|树|水|灯|屋|院|街|天|雾|雨|烟|火|锅|盘|碗|杯|台|椅|梨|包|产品|案|桥|石|帘|影|尘|叶/

export function isVideoPerformanceThin(text: string): boolean {
  const t = (text || '').trim()
  if (t.length < 150) return true
  return !(FACE_RE.test(t) && BODY_RE.test(t) && ENV_RE.test(t))
}

export function videoPerformanceIssue(text: string): string | null {
  const t = (text || '').trim()
  if (!t) return '缺少视频内容表现'
  if (t.length < 150) return '视频内容表现过短，表情、动作、环境都要写细'
  if (!FACE_RE.test(t)) return '视频内容表现缺少表情神态'
  if (!BODY_RE.test(t)) return '视频内容表现缺少具体动作'
  if (!ENV_RE.test(t)) return '视频内容表现缺少环境变化'
  return null
}

/** 把站位 / 承接 / 道具等导演备注压成短摘要（场记用，不拼进画面描述） */
export function composeDirectingNotes(shot: Pick<
  Shot,
  'purpose' | 'shotSize' | 'blocking' | 'eyeline' | 'continuity' | 'propFocus' | 'cameraMovement'
>): string {
  const parts: string[] = []
  if (shot.purpose?.trim()) parts.push(`戏剧功能：${shot.purpose.trim()}`)
  if (shot.shotSize?.trim()) parts.push(`景别：${shot.shotSize.trim()}`)
  if (shot.blocking?.trim()) parts.push(`站位：${shot.blocking.trim()}`)
  if (shot.eyeline?.trim()) parts.push(`视线：${shot.eyeline.trim()}`)
  if (shot.continuity?.trim()) parts.push(`跨镜承接：${shot.continuity.trim()}`)
  if (shot.propFocus?.trim()) parts.push(`道具焦点：${shot.propFocus.trim()}`)
  return parts.join('\n')
}

function storedVideoPrompt(shot: Shot): string {
  return (shot.videoPrompt || '').trim()
}

/** 从分镜场记拼一段「这一镜发生了什么」，绝不回退成配图静帧词 */
export function synthesizeVideoPerformance(shot: Shot): string {
  const parts: string[] = []
  const size = (shot.shotSize || '').trim()
  if (size) parts.push(`景别是${size}。`)

  const blocking = (shot.blocking || '').trim()
  if (blocking) parts.push(`人物站位：${blocking}。`)

  const eyeline = (shot.eyeline || '').trim()
  if (eyeline) parts.push(`视线${eyeline}。`)

  const action = (shot.continuity || '').trim()
  if (action) {
    parts.push(
      `动作过程：${action.replace(/^起始[:：]\s*/, '')}。每个人的表情神态要跟着这件事走，眉眼和嘴角有变化，手脚把动作做完整。`
    )
  }

  const prop = (shot.propFocus || '').trim()
  if (prop && prop !== '无') parts.push(`道具：${prop}。手里的东西、桌上的东西要跟着动作轻轻反应。`)

  const line = (shot.voiceover || '').trim()
  if (line) {
    const speaker = line.match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim() || ''
    const spoken = line.replace(/^([^：:\n]{1,12})[：:]\s*/, '').trim()
    parts.push(
      speaker
        ? `${speaker}带着对应情绪开口，说「${spoken}」。旁边的人闭嘴并做无声反应。`
        : `当前说话者带着对应情绪开口，说「${spoken}」。旁边的人闭嘴并做无声反应。`
    )
  }

  const cam = shot.cameraMovement ? CAMERA_CN[shot.cameraMovement] : ''
  if (cam) parts.push(`${cam}，环境里的光、门、桌、衣摆跟着动作有细微变化。`)
  else parts.push('镜头跟着动作走，环境里的光和物件有细微反应。')

  if ((shot.purpose || '').match(/收口|落幕|揭示/)) {
    parts.push('这一镜收到尾，把故事点交代清楚。')
  }

  const text = parts.filter(Boolean).join('')
  if (text.length >= 80) return text
  if (shot.title?.trim()) {
    return `${shot.title.trim()}。每个人都有自己的表情神态和手脚动作，环境里的光、门、桌、衣摆跟着动，把该说的原词说完，镜头走完这一镜。`
  }
  return '每个人都有自己的表情神态和手脚动作，环境里的光、物件、衣摆跟着动，把该说的原词说完，镜头走完这一镜。'
}

/** 编辑框里的原文：空就是空，不要把场记补回去；旧稿里的套话顺手剥掉 */
export function editableVideoPrompt(shot: Shot): string {
  return stripFrameLead(shot.videoPrompt ?? '')
}

/** 视频内容表现：有原文就用原文；空了才按场记补一段（只用于出片，不写回编辑框） */
export function composeVideoPerformance(
  shot: Shot,
  opts?: { ignoreStored?: boolean }
): string {
  if (!opts?.ignoreStored) {
    const own = stripFrameLead(storedVideoPrompt(shot))
    if (own) return own
  }
  return synthesizeVideoPerformance(shot)
}

/** 供配图/视频使用的提示：配图回退画面描述，视频绝不回退画面描述 */
export function composeShotVisualPrompt(
  shot: Shot,
  kind: 'image' | 'video' | 'base' = 'base'
): string {
  if (kind === 'image') return (shot.imagePrompt ?? shot.visualPrompt ?? '').trim()
  if (kind === 'video') return composeVideoPerformance(shot)
  return (shot.visualPrompt ?? '').trim()
}
