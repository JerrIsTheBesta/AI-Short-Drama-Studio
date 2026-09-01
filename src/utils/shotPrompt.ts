/**
 * 分镜提示词：配图用静帧画面，视频用「内容表现」（动作/台词/运镜）。
 * 二者不能混用。
 */

import type { Shot } from '@/types'

export const CAMERA_MOVEMENTS = ['push', 'pull', 'pan', 'tilt', 'static', 'orbit'] as const

/** 拆分镜模型常写出 handheld / 跟踪 等非法值；查表失败会让 H3 提示词编译崩掉。 */
export function normalizeCameraMovement(value: unknown): Shot['cameraMovement'] {
  const raw = String(value ?? '').trim().toLowerCase()
  return (CAMERA_MOVEMENTS as readonly string[]).includes(raw)
    ? (raw as Shot['cameraMovement'])
    : 'static'
}

/** 旧设置值继续兼容；选 H3 时编译成官方 Ref2VA / I2VA，不套万相。 */
export type VideoPromptStyle = 'scene-narrative' | 'formatted'

export function clampShotSeconds(duration?: number): number {
  return Math.max(4, Math.min(15, Math.round(Number(duration) || 5)))
}

/** 按本镜时长切连续时间段，出片提示词必须覆盖到最后一秒。 */
export function timedBeatWindows(duration?: number): Array<{ start: number; end: number }> {
  const total = clampShotSeconds(duration)
  const n = total <= 5 ? 3 : total <= 8 ? 4 : total <= 12 ? 5 : 6
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < n; i++) {
    out.push({
      start: Number(((total * i) / n).toFixed(2)),
      end: Number(((total * (i + 1)) / n).toFixed(2))
    })
  }
  out[out.length - 1].end = Number(total.toFixed(2))
  return out
}

export function formatBeatRangeCn(start: number, end: number): string {
  const a = Number.isInteger(start) ? String(start) : start.toFixed(1)
  const b = Number.isInteger(end) ? String(end) : end.toFixed(1)
  return `${a}–${b}秒`
}

export function formatBeatRangeEn(start: number, end: number): string {
  return `From ${start.toFixed(2)}s to ${end.toFixed(2)}s`
}

/** 编辑器里仍写中文内容表现；选 H3 出片时再编译成官方 Ref2VA / I2VA。用户若已粘贴官方英文全文，原样使用。 */
export const SCENE_NARRATIVE_SPEC = `用导演给演员说戏的口吻，连续写这一镜里到底发生了什么。中文 80–320 字。只写本镜，不要把上一镜或下一镜的剧情演进来。

先写清楚开场站位：画面里每一个出场的人各写一句——在近处还是后面、身体朝哪、眼睛看谁或看什么。说话的人可以在后面或侧面，前面的人必须侧对或回头看他、或看他指的东西。禁止合影式正面排排站、禁止所有人看镜头。人设图是正面身份锁，成片姿势不要抄人设。

再写中间的动作和看见了什么，情绪怎么跟着变，最后停在什么状态。表情必须跟这件事挂钩。运镜一句话。有台词只写口播原词；成年旁白是画外音，画面里的人闭嘴。剧本写了不拍的必须遵守。

人物脸和衣服由参考图负责，这里不要报身份证。不要按秒切段，不要写「0–1.5秒」，不要写「禁止呆脸空眼」「衣摆、光和空气里的东西跟着动」这种套话，也不要只在结尾加一句「人物看向场景里的人或物，不要看镜头」却不写每个人看哪。

坏例子：「林遥指着田垄说话。老农和差役在场。人物看向场景里的人或物，不要看镜头。」
好例子：「近处：老农和差役侧对镜头站在石板路上，不朝向镜头。林遥在他们身后稍远，从跪姿撑起半身，泥手指向田垄。老农回头眯眼打量林遥，差役停步，视线跟着那只手看向田垄。三个人都不看镜头。」`

/** 格式化：人物图 + 空镜底板直接出视频时，内容表现仍写细，出片再套 H3 结构 */
export const FORMATTED_VIDEO_PERFORMANCE_SPEC = SCENE_NARRATIVE_SPEC

export function videoPerformanceSpec(style: VideoPromptStyle = 'scene-narrative'): string {
  return style === 'formatted' ? FORMATTED_VIDEO_PERFORMANCE_SPEC : SCENE_NARRATIVE_SPEC
}

export function videoPromptJsonHint(_style: VideoPromptStyle = 'scene-narrative'): string {
  return '<导演口吻。先写每个出场人物：近处还是后面、身体朝哪、眼睛看谁。说话者可以在后；前面的人侧对或回头看他/他指的东西。禁止合影看镜头。再写动作和台词原词。80-320字。>'
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
  /表情|神态|眉|眼|笑|愣|皱|歪|低头|抬头|眼神|嘴角|脸|惊喜|开心|认真|犹豫|紧张|温柔|点头|摇头|吃惊|无奈|得意|委屈|好奇|惊|呆/
const BODY_RE =
  /跑|走|拿|放|伸|举|弯|站|坐|蹲|抱|推|拉|转身|回头|抬手|伸手|迈|踏|递|捧|摸|拍|跳|停|凑|靠|俯|仰|躺|撑|醒/
const ENV_RE =
  /门|桌|地|光|风|窗|墙|衣|树|水|灯|屋|院|街|天|雾|雨|烟|火|锅|盘|碗|杯|台|椅|梨|包|产品|案|桥|石|帘|影|尘|叶|草|田/

const TEMPLATE_RE =
  /禁止呆脸空眼|衣摆、光和空气里的东西跟着动|把这件事做起来：|表情往前走：眼神一转|0\s*[–\-~]\s*\d+(?:\.\d+)?秒|人物看向场景里的人或物，不要看镜头/

const ENSEMBLE_LAYER_RE =
  /近处|近景里|身前|身后|稍远|前景|后景|侧对|侧身|侧过|四分之三|过肩|回头|扭头/

/** 多人在场却没写谁在前、谁在后、各自看谁 → 模型会摆成合影看镜头。 */
export function lacksEnsembleBlocking(text: string, names: string[] = []): boolean {
  const t = (text || '').trim()
  if (!t) return false
  const named = names.filter((n) => n && n.length >= 2 && t.includes(n))
  const multi = named.length >= 2 || /和|、|与/.test(t) && (t.match(/[\u4e00-\u9fff]{2,4}(?=从|跪|说|看|眯|停|站)/g) || []).length >= 2
  if (!multi && named.length < 2) return false
  return !ENSEMBLE_LAYER_RE.test(t)
}

export function isVideoPerformanceTemplate(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  const timed = (t.match(/\d+(?:\.\d+)?\s*[–\-~]\s*\d+(?:\.\d+)?秒/g) || []).length
  return timed >= 2 || TEMPLATE_RE.test(t)
}

/** continuity 常写成「上一镜末态 → 本镜变化 → 下一镜初态」；出视频只演中间这一截。 */
export function thisShotAction(continuity?: string): string {
  const raw = (continuity || '').trim().replace(/^起始[:：]\s*/, '')
  if (!raw) return ''
  const parts = raw
    .split(/\s*(?:→|->|／|\/)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length >= 3) return parts[1]
  if (parts.length === 2) return parts[1]
  return raw
}

function cameraStoryCn(movement: Shot['cameraMovement']): string {
  switch (movement) {
    case 'push':
      return '镜头跟着他的注意慢慢推近，幅度小，结束时停住。'
    case 'pull':
      return '镜头从近处慢慢拉开，把环境和后来靠近的人带进画面，不要猛拉。'
    case 'pan':
      return '镜头顺着他的视线慢慢横移，停在他看见的东西上。'
    case 'tilt':
      return '镜头顺着他抬头或低头的方向慢慢俯仰，停在结束视线。'
    case 'orbit':
      return '镜头小幅度绕着他转一点，带出周围环境，不要绕出半圈。'
    default:
      return '机位基本不动，只随呼吸和动作有一点微晃。'
  }
}

export function isVideoPerformanceThin(text: string): boolean {
  const t = (text || '').trim()
  if (t.length < 50) return true
  if (isVideoPerformanceTemplate(t)) return true
  return !(BODY_RE.test(t) || FACE_RE.test(t))
}

export function videoPerformanceIssue(text: string, names?: string[]): string | null {
  const t = (text || '').trim()
  if (!t) return '缺少视频内容表现'
  if (isVideoPerformanceTemplate(t)) return '视频内容表现是套话，没有写出每个人站哪、看谁'
  if (t.length < 40) return '视频内容表现过短，没写清这一镜发生了什么'
  if (lacksEnsembleBlocking(t, names)) {
    return '多人同框却没写谁在近处、谁在后面、各自看谁，会拍成合影看镜头'
  }
  if (!BODY_RE.test(t) && !FACE_RE.test(t) && !ENV_RE.test(t)) {
    return '视频内容表现缺少具体动作或反应'
  }
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

/** 从分镜场记写出「这一镜发生了什么」，绝不回退成配图静帧词，也不按秒填空。 */
export function synthesizeVideoPerformance(shot: Shot): string {
  const secs = clampShotSeconds(shot.duration)
  const happening =
    thisShotAction(shot.continuity) ||
    (shot.blocking || '').trim() ||
    (shot.title || '').trim() ||
    '把这一镜的事做完'
  const look = (shot.eyeline || '').trim()
  const line = (shot.voiceover || '').trim()
  const speaker = line.match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim() || ''
  const spokenRaw = line.replace(/^([^：:\n]{1,12})[：:]\s*/, '').trim()
  const spoken = /^(?:无|没有|暂无|空|无对白|无台词|无口播|none|n\/a)$/i.test(spokenRaw.replace(/[。.\s]/g, ''))
    ? ''
    : spokenRaw
  const movement = normalizeCameraMovement(shot.cameraMovement)
  const bits = [
    `${happening.replace(/[。；;]+$/, '')}。`,
    look
      ? `每个人写清看向谁：${look.replace(/^看/, '')}。身体侧对或四分之三侧面，不要正面看镜头。`
      : '每个人写清站在近处还是后面、身体朝哪、眼睛看谁。禁止合影看镜头。'
  ]
  if ((shot.blocking || '').trim() && happening !== (shot.blocking || '').trim()) {
    bits.push(`站位：${(shot.blocking || '').trim()}。`)
  }
  bits.push(cameraStoryCn(movement))
  if (spoken) {
    bits.push(
      speaker
        ? `${speaker}开口说「${spoken}」。旁边的人闭嘴，侧头或回头看他，脸上要有反应。`
        : `有人开口说「${spoken}」。旁边的人闭嘴，看向说话者或他指的东西。`
    )
  } else {
    bits.push('无对白。')
  }
  bits.push(`约${secs}秒，一镜到底，不要跳切。`)
  return bits.join('')
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
