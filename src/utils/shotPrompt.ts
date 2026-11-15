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
export const DIRECTOR_TIMELINE_SPEC = `参考图角色/场景对应由程序单独生成；不要重写图号清单，也不要把身份锁定凑进正文。正文用中文，按剧情拍点每段另起一行，格式“镜头 N（起秒–止秒）：…”。从 0 连续覆盖到 duration，上一段止秒等于下一段起秒（例如 0–4、4–9、9–15），不能跳秒或重叠。4–6 秒可用两段，10–15 秒通常用三至四段；拍点不等于硬切，同一次运镜可以跨段。短镜通常写约 180–300 字，10–15 秒通常约 280–500 字，以信息量为准，不灌水。
每段都给出可执行的拍法：① 景别、机位角度或主体在构图中的位置；② 摄影机固定、推拉、摇移或跟随的方向、速度和起落位置，焦点跟什么走、逐步揭示什么；③ 用起始姿态、连续可见的动作及反应、可见的落幅状态说明表演。对关键拍点补光线/景深/材质、被动作影响的环境和同步现场声，不强行添加道具或声音。转场处说明是同机位连续运镜还是硬切；不中断的就写继续，不制造切镜。
例如“镜头拉远，展现困境”不够。可写“贴地侧拍从虚化腐叶间的前足起幅，足节蜷起再徒劳伸直；焦点留在打滑的足尖，镜头沿原轴匀速后撤到中全景，露出压在身侧的湿叶。停在坑沿与角色同框的位置，叶片随扒抓擦响。”只借鉴写法，不能照抄动作到别的剧情。
系统面板/屏显文字是画面事件：写出现的拍点、屏幕方位、层级和停留/消失时机，避开角色关键动作；逐字保留原文和顺序，禁止擅自简写、数字换格式或编造文字。人物不是人类时，按参考图的真实形态写表演，不默认有手、衣服、发型或人脸。`

export const SCENE_NARRATIVE_SPEC = `用导演给演员和摄影说戏的口吻，写这一镜最终会怎样动起来。只写本镜，不要把上一镜或下一镜的剧情演进来。

${DIRECTOR_TIMELINE_SPEC}

先写清楚开场站位：画面里每一个出场的人各写一句——在近处还是后面、身体朝哪、眼睛看谁或看什么。说话的人可以在后面或侧面，前面的人必须侧对或回头看他、或看他指的东西。禁止合影式正面排排站、禁止所有人看镜头。人设图是正面身份锁，成片姿势不要抄人设。

再按因果写清：开场身体状态 → 什么声音/目光/道具触发变化 → 手脚和身体如何完成动作 → 道具与环境产生什么可见结果 → 最后停在什么状态。必须使用本镜真实道具和空间细节，不能把动作缩成情绪摘要。表情必须跟正在发生的事挂钩。

按本镜总时长写 2–5 个连续时间段，从 0 秒覆盖到最后一秒。时间段按剧情拍点分，不要机械等分。每段都写清当前谁在做什么、谁在说什么、其他人物站在哪里并看向谁、表情因什么发生变化，以及摄影机如何跟随或保持。摄影不是另贴一句“固定/推近”：写明镜头从哪里、什么景别起幅，为什么随某个动作移动或改变焦点，移动中逐步揭示什么，最后落在哪里。大场面、走位、揭示与冲击必须允许拉远、跟拍、升降、摇移或切镜，不能一律固定近景。

写出与画面同步的声音节点，以及光、雨、雾、灰尘、火焰、衣料、桌面物件如何被动作影响。有台词只写口播原词；成年旁白是画外音，画面里的人闭嘴。剧本写了不拍的必须遵守。

人物脸和衣服由参考图负责，这里不要报身份证。不要写「禁止呆脸空眼」「衣摆、光和空气里的东西跟着动」这种套话，也不要只在结尾加一句「人物看向场景里的人或物，不要看镜头」却不写每个人看哪。

坏例子：「林遥指着田垄说话。老农和差役在场。人物看向场景里的人或物，不要看镜头。」
好例子：「近处：老农和差役侧对镜头站在石板路上，不朝向镜头。林遥在他们身后稍远，从跪姿撑起半身，泥手指向田垄。老农回头眯眼打量林遥，差役停步，视线跟着那只手看向田垄。三个人都不看镜头。」`

/** 格式化：人物图 + 空镜底板直接出视频时，内容表现仍写细，出片再套 H3 结构 */
export const FORMATTED_VIDEO_PERFORMANCE_SPEC = SCENE_NARRATIVE_SPEC

export function videoPerformanceSpec(style: VideoPromptStyle = 'scene-narrative'): string {
  return style === 'formatted' ? FORMATTED_VIDEO_PERFORMANCE_SPEC : SCENE_NARRATIVE_SPEC
}

export function videoPromptJsonHint(_style: VideoPromptStyle = 'scene-narrative'): string {
  return '<中文可执行分镜：每段另起一行写镜头 N（起秒–止秒），无缝覆盖全时长。逐段写景别、机位、运镜起落与焦点、可见动作过程和落幅，按剧情交代转场、声音及屏显原文。不是剧情简述。>'
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
  /禁止呆脸空眼|衣摆、光和空气里的东西跟着动|把这件事做起来：|表情往前走：眼神一转|人物看向场景里的人或物，不要看镜头/

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
  return TEMPLATE_RE.test(t)
}

export function timedBeatCount(text: string): number {
  return ((text || '').match(/\d+(?:\.\d+)?\s*(?:秒|s)?\s*[–\-~到至]\s*\d+(?:\.\d+)?\s*(?:秒|s)/gi) || []).length
}

/** 只验收时间轴正文；图号清单和出场锁定不计入细节。 */
export function directorTimelineIssue(text: string, duration?: number): string | null {
  const body = text.split(/\n\s*(?:出场|转场)\s*[:：]/)[0]
  const ranges = [...body.matchAll(/(?:^|[^\d.])([0-9]+(?:\.[0-9]+)?)\s*(?:秒|s)?\s*[-–—~～到至]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:秒|s)(?=\s*[）)】：:]|\s|$)/gi)]
  if (ranges.length < 2) return '缺少分段导演时间轴（至少两段）'
  let end = 0
  for (const range of ranges) {
    const start = Number(range[1])
    const next = Number(range[2])
    if (Math.abs(start - end) > 0.001 || next <= start) return '时间轴有跳秒、重叠或倒序；必须从 0 秒连续覆盖本镜'
    end = next
  }
  if (duration && Math.abs(end - duration) > 0.001) return `时间轴止于 ${end} 秒，与本镜 ${duration} 秒不一致`
  const camera = /景别|特写|近景|中景|全景|远景|微距|机位|俯拍|仰拍|侧拍|过肩|构图|固定|跟拍|跟移|拉远|后撤|推近|焦点|景深|连续拉|沿原轴|镜头(?:慢|缓|匀|向|从|沿|停|不动|保持)/
  const beats = ranges.map((range, i) => body.slice(range.index! + range[0].length, ranges[i + 1]?.index ?? body.length)
    .replace(/(?:镜头\s*\d+\s*[（(【]?|[\s\p{P}])/gu, ''))
  if (beats.some(beat => beat.length < 36 || !camera.test(beat))) return '部分拍点只是剧情摘要；逐段补机位或构图、运镜起落与连续动作细节'
  const min = end >= 10 ? 210 : end >= 7 ? 150 : 105
  if (beats.reduce((sum, beat) => sum + beat.length, 0) < min) return '动态正文缺少可拍细节；补足景别、焦点、动作过程、环境反馈及结束姿势，不要用身份锁定凑字数'
  return null
}

/** 自动补写必须逐字保留旧稿中已标明的屏显，不接受缩写或调换次序。 */
export function preservesScreenText(previous: string, next: string): boolean {
  let from = 0
  for (const [, literal] of previous.matchAll(/【([^】\n]+)】/g)) {
    if (/^(?:\s*\d+:\d+\s*(?:[｜|].*)?$|.*(?:参考图对应|画面风格|镜头\s*\d+|画幅|首尾帧).*$)/.test(literal)) continue
    const found = next.indexOf(literal, from)
    if (found < 0) return false
    from = found + literal.length
  }
  return true
}

/** H3 用英文正文和自己的分镜格式，不套中文时间段校验。 */
export function h3DirectorBodyIssue(body: string, duration: number): string | null {
  const prose = body
    .replace(/<d>[\s\S]*?<\/d>/gi, ' ')
    .replace(/Speaker lock \(these labels are the pictures\):[\s\S]*?(?=\d+[:.]\d+|\b(?:at|from)\s+\d+|$)/i, ' ')
  const words = prose.match(/[a-z]+(?:[-'][a-z]+)*/gi)?.length || 0
  if (words < (duration >= 10 ? 105 : duration >= 7 ? 75 : 45)) return '动态正文过短，须写足连续表演与摄影调度，身份和台词不计入'
  if (!/\b(?:close[- ]?up|wide shot|medium shot|low[- ]angle|over[- ]the[- ]shoulder|eye[- ]level|framing|foreground|macro|profile)\b/i.test(prose) ||
      !/\b(?:camera|lens|focus|dolly|tracks?|pans?|tilts?|push(?:es)?|pulls?|locked[- ]off)\b/i.test(prose)) return '动态正文缺少具体景别、机位或运镜焦点'
  return null
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
  if (t.length < 120) return true
  if (isVideoPerformanceTemplate(t)) return true
  if (timedBeatCount(t) < 2) return true
  return !(BODY_RE.test(t) || FACE_RE.test(t))
}

export function videoPerformanceIssue(text: string, names?: string[]): string | null {
  const t = (text || '').trim()
  if (!t) return '缺少视频内容表现'
  if (isVideoPerformanceTemplate(t)) return '视频内容表现是套话，没有写出每个人站哪、看谁'
  if (t.length < 120) return '视频内容表现过短，必须写清触发、连续动作、道具结果、运镜落点和同步声音'
  if (timedBeatCount(t) < 2) return '视频内容表现缺少从0秒到镜头结束的分段时间轴，无法明确每一拍谁在做什么、谁在说什么'
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

/** 从分镜场记写出「这一镜发生了什么」，绝不回退成配图静帧词。 */
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
  const firstEnd = Number((secs * 0.3).toFixed(1))
  const secondEnd = Number((secs * 0.75).toFixed(1))
  const bits = [
    `${formatBeatRangeCn(0, firstEnd)}：起幅先交代人物前后站位和当前身体状态。${look ? `视线：${look.replace(/^看/, '')}。` : '每个人看向场景里的行动对象，不朝镜头。'}`,
    `${formatBeatRangeCn(firstEnd, secondEnd)}：${happening.replace(/[。；;]+$/, '')}。动作连续发生，人物的眼神、眉眼和呼吸随触发事件变化。`
  ]
  if ((shot.blocking || '').trim() && happening !== (shot.blocking || '').trim()) {
    bits[0] += `站位：${(shot.blocking || '').trim()}。`
  }
  bits.push(cameraStoryCn(movement))
  if (spoken) {
    bits[1] +=
      speaker
        ? `${speaker}开口说「${spoken}」。旁边的人闭嘴，侧头或回头看他，脸上要有反应。`
        : `有人开口说「${spoken}」。旁边的人闭嘴，看向说话者或他指的东西。`
  } else {
    bits[1] += '无对白。'
  }
  bits.push(`${formatBeatRangeCn(secondEnd, secs)}：${cameraStoryCn(movement)}动作完成后停在明确的结果状态，其他人物保持与行动者的视线关系。`)
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
