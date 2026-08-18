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

/** 写给编剧 / 质检 / 出视频：视频内容表现必须细到能演戏 */
export const VIDEO_PERFORMANCE_SPEC = `视频内容表现必须写细（大约 180-450 字），按时序把这一镜演完，让画面丰富、有表现力：
1. 先点名画面里谁是谁（穿什么、站哪）。
2. 每个出场的人都要写清楚：表情神态（眉眼、嘴角、脸色、眼神看谁）、身体动作（手、脚、转身、跑、拿、放）、和别人或道具怎么互动。不要只写一个人。
3. 环境也要跟着动：门、桌、椅、光、风、衣摆、窗帘、桌上的东西有没有晃、远处有没有变化。
4. 台词必须是原词，并写说话时的神态和口型。
5. 镜头怎么走、这一镜怎么收。
禁止：一句站位摘要、抄配图静帧词、只写英文、不写表情、不写环境、所有人同一张脸。`

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
  const own = (shot.videoPrompt || '').trim()
  const visual = (shot.visualPrompt || '').trim()
  if (own && own !== visual) return own
  return ''
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
    const speaker = (shot.speakerHint || '').replace(/^\[|\]$/g, '').trim()
    parts.push(
      speaker
        ? `${speaker}带着对应情绪开口，口型对上，说「${line}」。旁边的人听见后表情要有反应。`
        : `有人带着对应情绪开口，口型对上，说「${line}」。旁边的人听见后表情要有反应。`
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
    return `${shot.title.trim()}。从参考画面接着演：每个人都有自己的表情神态和手脚动作，环境里的光、门、桌、衣摆跟着动，把该说的原词说完，镜头走完这一镜。`
  }
  return '从参考画面接着演下去：每个人都有自己的表情神态和手脚动作，环境里的光、物件、衣摆跟着动，把该说的原词说完，镜头走完这一镜。'
}

/** 视频内容表现：独立 videoPrompt；若空或误用了配图词，则按场记重写 */
export function composeVideoPerformance(
  shot: Shot,
  opts?: { ignoreStored?: boolean }
): string {
  if (!opts?.ignoreStored) {
    const own = storedVideoPrompt(shot)
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
