/**
 * 节点上展示的提示词 = 真正发给出图/出视频接口的全文。
 * 框里有字就原样发送，不再背后拼接。
 */
import {
  characterPropSheetPrompt,
  characterSheetPrompt,
  ensureCharacterSheetWhiteBackground,
  scenePlatePrompt,
  scenePropSheetPrompt,
  shotBoardPrompt,
  shotKeyframePrompt
} from '@/services/ai/consistency'
import { spokenTextOnly } from '@/services/ai/dialogue'
import { buildH3ImageSlots, pictureIdentityBlock } from '@/services/ai/h3Prompt'
import type { Project, Scene, Shot, Subject } from '@/types'
import {
  collectShotRefIds,
  collectShotVideoEntries,
  composeShotImagePrompt,
  packVideoRefEntries,
  sceneForShot,
  shotRefRoster,
  subjectsForShot
} from '@/utils/consistency'
import { resolveShotPlace } from '@/utils/shotPlace'
import { lookFromScript, mediumLockText } from '@/utils/visualStyle'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'

export function defaultSubjectSheetPrompt(subject: Subject, project: Project): string {
  const look = lookFromScript(project.script)
  return ensureCharacterSheetWhiteBackground(characterSheetPrompt(subject, look.style, false, look))
}

export function defaultScenePlatePrompt(scene: Scene, project: Project): string {
  const look = lookFromScript(project.script)
  return scenePlatePrompt(scene, look.style, look)
}

export function defaultScenePropPrompt(scene: Scene, project: Project): string {
  const look = lookFromScript(project.script)
  return scenePropSheetPrompt(scene, look.style, look)
}

export function defaultSubjectPropPrompt(subject: Subject, project: Project): string {
  const look = lookFromScript(project.script)
  return characterPropSheetPrompt(subject, look.style, look)
}

export function defaultBoardPrompt(shot: Shot, project: Project): string {
  const look = lookFromScript(project.script)
  return shotBoardPrompt(shot, look.style, look, {
    filmChapter:
      project.pipelineMode !== 'remake' && project.script?.workflowMode === 'film-chapter',
    aspectRatio: project.settings.aspectRatio
  })
}

export function defaultShotImagePrompt(shot: Shot, project: Project): string {
  if (!videoRequiresStoryboard(project)) {
    const look = lookFromScript(project.script)
    return shotKeyframePrompt(shot, look, { aspectRatio: project.settings.aspectRatio })
  }
  return composeShotImagePrompt(shot, project, (shot.visualPrompt || shot.title).trim())
}

export function shotDirectorBrief(shot: Shot, project: Project): string {
  const scene = sceneForShot(shot, project)
  const place = resolveShotPlace(shot, scene)
  const cast = subjectsForShot(shot, project)
  const spoken = spokenTextOnly(shot.voiceover || '')
  const performance = (shot.videoPrompt || '')
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .replace(spoken ? new RegExp(spoken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '')
    .replace(/\s*Location facts\s*:[\s\S]*$/i, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !/^(?:镜头|景别|地点|出场|站位|视线|动作承接|可见画面|道具|现场声|台词|对白|旁白|口播)\s*[：:]/.test(line))
    .map((line) => line.replace(/^这一镜怎么演\s*[：:]\s*/, ''))
    .filter(Boolean)
    .join('\n')
    .trim()
  const lines = [
    shot.title ? `镜头：${shot.title}` : '',
    shot.shotSize ? `景别：${shot.shotSize}` : '',
    place.name ? `地点：${place.name}` : '',
    cast.length ? `出场：${cast.map((item) => item.name).join('、')}` : '',
    shot.blocking ? `站位：${shot.blocking}` : '',
    shot.eyeline ? `视线：${shot.eyeline}` : '',
    shot.continuity ? `动作承接：${shot.continuity}` : '',
    shot.visualPrompt?.trim() ? `可见画面：${shot.visualPrompt.trim()}` : '',
    performance ? `这一镜怎么演：${performance}` : '',
    shot.propFocus && shot.propFocus !== '无' ? `道具：${shot.propFocus}` : '',
    shot.audioDescription?.trim() ? `现场声：${shot.audioDescription.trim()}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * 本镜出场人物各自的声音描述。音色是中文，必须原样写进提示词开头，
 * 否则会被「正文去中文」的清洗一起抹掉，人物就只剩脸没有声音。
 */
export function shotVoiceBlock(shot: Shot, project: Project): string {
  const cast = subjectsForShot(shot, project)
  const speakerLabel = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const lines: string[] = []
  for (const sub of cast) {
    const voice = sub.voicePrompt?.trim()
    if (!voice) continue
    const speaking = Boolean(
      speakerLabel &&
        (sub.name === speakerLabel ||
          speakerLabel.includes(sub.name) ||
          sub.name.includes(speakerLabel))
    )
    lines.push(`${sub.name}（${speaking ? '本镜说话' : '在场'}）：${voice}`)
  }
  if (!lines.length) {
    const own = shot.speakerVoice?.trim()
    if (!own) return ''
    lines.push(`本镜说话人：${own}`)
  }
  return [
    '人物声音（每个人自己的音色，开口时按这个来，不要互相串音色）：',
    ...lines
  ].join('\n')
}

export function defaultVideoSendPrompt(shot: Shot, project: Project): string {
  const packed = packVideoRefEntries(collectShotVideoEntries(shot, project))
  const imageSlots = buildH3ImageSlots(packed)
  const spoken = spokenTextOnly(shot.voiceover || '')
  const roster = pictureIdentityBlock({ prompt: '', imageSlots, duration: shot.duration })
  const camera: Record<string, string> = {
    push: '从当前景别随人物注意力缓慢推近，落在动作结果上',
    pull: '从动作细节缓慢后拉，逐步带出人物关系和完整空间',
    pan: '顺着人物移动或视线平移，停在新出现的信息上',
    tilt: '顺着人物抬头、俯身或物体方向俯仰，停在叙事焦点上',
    orbit: '围绕人物做有明确起点和落点的小幅弧线运动，带出空间层次',
    static: '机位是否保持不动服从具体动作；发生走位、揭示或环境变化时允许跟随和重新构图'
  }
  const visual = String(shot.visualPrompt || '').trim()
  const performance = String(shot.videoPrompt || '').trim()
  const voices = shotVoiceBlock(shot, project)
  return [
    roster,
    voices,
    `镜头：${shot.title || `第${shot.index + 1}镜`}`,
    `景别与运镜：${shot.shotSize || '按动作选择景别'}；${camera[shot.cameraMovement || 'static']}；在 ${shot.duration} 秒内完成并落到清楚的结束状态。`,
    visual ? `画面与动作依据：${visual}` : '',
    performance && performance !== visual ? `动态表演依据：${performance}` : '',
    shot.blocking ? `人物调度：${shot.blocking}` : '',
    shot.eyeline ? `视线关系：${shot.eyeline}` : '',
    shot.continuity ? `动作承接：${shot.continuity}` : '',
    shot.propFocus && shot.propFocus !== '无' ? `关键道具：${shot.propFocus}` : '',
    shot.audioDescription ? `同步声音：${shot.audioDescription}` : '',
    spoken ? `原词台词：${shot.voiceover}` : '无对白，不需要人物做说话口型。'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 出图前补上全片画风。已写明同一种画风时不重复堆。 */
export function ensureStyleLock(prompt: string, project: Project): string {
  const look = lookFromScript(project.script)
  const line = `画风要求：全片统一为「${look.medium}」。${mediumLockText(look)}`
  const body = prompt.trim()
  if (body.includes(look.medium) && /画风|绘制媒介|必须按/.test(body)) return body
  return `${body}\n${line}`.trim()
}

export function subjectSendPrompt(subject: Subject, project: Project): string {
  const raw = subject.sheetPrompt?.trim() || defaultSubjectSheetPrompt(subject, project)
  return ensureStyleLock(ensureCharacterSheetWhiteBackground(raw), project)
}

export function sceneSendPrompt(scene: Scene, project: Project): string {
  return ensureStyleLock(scene.platePrompt?.trim() || defaultScenePlatePrompt(scene, project), project)
}

export function scenePropSendPrompt(scene: Scene, project: Project): string {
  return ensureStyleLock(scene.propSheetPrompt?.trim() || defaultScenePropPrompt(scene, project), project)
}

export function boardSendPrompt(shot: Shot, project: Project): string {
  const raw = shot.boardPrompt?.trim() || defaultBoardPrompt(shot, project)
  const film = project.pipelineMode !== 'remake' && project.script?.workflowMode === 'film-chapter'
  return film ? ensureStyleLock(raw, project) : raw
}

export function shotImageSendPrompt(shot: Shot, project: Project): string {
  return ensureStyleLock(shot.imagePrompt?.trim() || defaultShotImagePrompt(shot, project), project)
}

/** 运镜对结束帧构图的影响：结束帧不是把开场画面复制一遍，要走到运镜的落点 */
const CAMERA_END_TEXT: Record<string, string> = {
  push: '运镜是推近：结束帧比开场更近，落在这镜要交代的动作结果或情绪上。',
  pull: '运镜是后拉：结束帧比开场更远，把人物关系和完整空间带出来。',
  pan: '运镜是平移：结束帧的视线落点移到新出现的信息上，起幅和落幅是同一个连续摇 process。',
  tilt: '运镜是俯仰：结束帧跟着人物抬头或俯身走到叙事焦点上。',
  orbit: '运镜是环绕：结束帧换到弧线运动落点的角度，仍是同一批人物和同一处空间。',
  static: '机位固定：结束帧保持和开场一致的机位、焦段和构图，只有人物动作、表情和道具状态推进。'
}

/**
 * 把「起始快照 → 本镜可见变化 → 末态」拆成开场状态和结束状态两段。
 * 拆不出来就用可见画面兜底，结束状态再额外强调「动作已完成」。
 */
function splitShotContinuity(shot: Shot): { start: string; end: string } {
  const raw = String(shot.continuity || '').trim()
  const segs = raw
    .split(/\s*(?:→|->|-->|—>|=>|⇒|\|)\s*/)
    .map((item) => item.replace(/^(?:起始快照|本镜可见变化|末态|结束状态)\s*[：:]?\s*/, '').trim())
    .filter(Boolean)
  const visual = String(shot.visualPrompt || '').trim()
  if (segs.length >= 2) {
    return { start: segs[0], end: segs[segs.length - 1] }
  }
  return { start: segs[0] || visual, end: segs[0] || visual }
}

/** 首尾帧专用画面词：起始帧画开场那一瞬，结束帧画动作完成后的末态。 */
export function defaultShotFramePrompts(shot: Shot, project: Project): { start: string; end: string } {
  const look = lookFromScript(project.script)
  const scene = sceneForShot(shot, project)
  const place = resolveShotPlace(shot, scene)
  const cast = subjectsForShot(shot, project)
  const { start, end } = splitShotContinuity(shot)
  // 参考图编号对照：起始帧比结束帧多带一张（上一镜末帧 / 本镜起始帧），编号要跟着走
  const refIds = collectShotRefIds(shot, project).ids
  const orderedShots = [...(project.shots ?? [])].sort((a, b) => a.index - b.index)
  const pos = orderedShots.findIndex((item) => item.id === shot.id)
  const prevTail = pos > 0 ? orderedShots[pos - 1]?.lastFrameAssetId : undefined
  const startRoster = shotRefRoster(
    shot,
    project,
    refIds,
    prevTail
      ? `图${refIds.length + 1}：上一镜的结束帧——从这一格的构图、机位和光线接着走，只是衔接参考，不要照抄成新画面。`
      : ''
  )
  const endRoster = shotRefRoster(
    shot,
    project,
    refIds,
    shot.firstFrameAssetId
      ? `图${refIds.length + 1}：本镜的起始帧——保持同一机位、同一焦段、同一服装、同一光线，只把动作走到结束状态。`
      : ''
  )
  const ar = project.settings?.aspectRatio || '16:9'
  const visual = String(shot.visualPrompt || '').trim()
  const performance = String(shot.videoPrompt || '')
    .replace(/<d>[\s\S]*?<\/d>/gi, '')
    .trim()
  const common = [
    look.medium ? `画风要求：全片统一为「${look.medium}」。` : '',
    place.name ? `场景：${place.name}。` : '',
    place.lighting ? `光线：${place.lighting}。` : '',
    cast.length
      ? `画面里的人：${cast.map((item) => (item.description ? `${item.name}（${item.description}）` : item.name)).join('、')}。`
      : '',
    shot.shotSize ? `景别：${shot.shotSize}。` : '',
    shot.blocking ? `站位：${shot.blocking}。` : '',
    shot.propFocus && shot.propFocus !== '无' ? `关键道具：${shot.propFocus}。` : '',
    `画面比例必须是 ${ar}，整张图按这个画幅输出，禁止另一种比例。`
  ].filter(Boolean)
  const still = '只输出一张完整的单画面剧照：不要宫格、不要拼贴、不要编号、不要任何文字和对白字幕。'
  const startPrompt = [
    startRoster,
    `这是第 ${shot.index + 1} 镜「${shot.title || '本镜'}」的起始帧，镜头开始的第一格画面，动作还没发生。`,
    start ? `开场状态：${start}。` : '',
    visual ? `画面依据：${visual}。` : '',
    ...common,
    '人物处在动作起点，表情和身体还是进入这一镜时的初始状态，画面要能直接作为视频的第一帧开始运动。',
    still
  ]
    .filter(Boolean)
    .join('\n')
  const endPrompt = [
    endRoster,
    `这是第 ${shot.index + 1} 镜「${shot.title || '本镜'}」的结束帧：同一个镜头、同一批人物、同一处场景、同一种光线，只是动作已经走完，停在结束状态。`,
    end ? `结束状态（末态）：${end}。` : '',
    performance && performance !== visual ? `这一镜的动作过程：${performance}。` : '',
    ...common,
    CAMERA_END_TEXT[shot.cameraMovement || 'static'] || CAMERA_END_TEXT.static,
    '参考图里有本镜的起始帧：必须和它保持同一机位、同一焦段、同一服装、同一光线，只允许人物动作、位置、表情、道具状态和环境细节往前推进；不要换场景、不要换人、不要改变时间。',
    still
  ]
    .filter(Boolean)
    .join('\n')
  return { start: startPrompt, end: endPrompt }
}

export function shotFrameSendPrompt(
  shot: Shot,
  project: Project,
  which: 'start' | 'end'
): string {
  const raw =
    which === 'start'
      ? shot.startFramePrompt?.trim() || defaultShotFramePrompts(shot, project).start
      : shot.endFramePrompt?.trim() || defaultShotFramePrompts(shot, project).end
  return ensureStyleLock(raw, project)
}

function hasStoredPrompt(value: string | undefined): boolean {
  return value != null
}

export function videoSendPrompt(shot: Shot, project: Project): string {
  void project
  // 单一数据源：文本框字段就是接口参数。禁止清洗、补映射、迁移或自动改写。
  return shot.compiledVideoPrompt ?? ''
}

export function rebuildGeneratePrompt(
  kind: 'subject' | 'scene' | 'sceneProps' | 'shotBoard' | 'shotImage' | 'shotVideo',
  project: Project,
  target: Subject | Scene | Shot
): Record<string, string> {
  if (kind === 'subject') {
    return { sheetPrompt: defaultSubjectSheetPrompt(target as Subject, project) }
  }
  if (kind === 'scene') {
    return { platePrompt: defaultScenePlatePrompt(target as Scene, project) }
  }
  if (kind === 'sceneProps') {
    return { propSheetPrompt: defaultScenePropPrompt(target as Scene, project) }
  }
  const shot = target as Shot
  if (kind === 'shotBoard') return { boardPrompt: defaultBoardPrompt(shot, project) }
  if (kind === 'shotImage') return { imagePrompt: defaultShotImagePrompt(shot, project) }
  return { compiledVideoPrompt: defaultVideoSendPrompt(shot, project) }
}

export function fillEmptyGeneratePrompt(
  kind: 'subject' | 'scene' | 'sceneProps' | 'shotBoard' | 'shotImage' | 'shotVideo',
  project: Project,
  target: Subject | Scene | Shot
): Record<string, string> | null {
  if (kind === 'subject') {
    const subject = target as Subject
    if (hasStoredPrompt(subject.sheetPrompt)) return null
    return { sheetPrompt: defaultSubjectSheetPrompt(subject, project) }
  }
  if (kind === 'scene') {
    const scene = target as Scene
    if (hasStoredPrompt(scene.platePrompt)) return null
    return { platePrompt: defaultScenePlatePrompt(scene, project) }
  }
  if (kind === 'sceneProps') {
    const scene = target as Scene
    if (hasStoredPrompt(scene.propSheetPrompt)) return null
    return { propSheetPrompt: defaultScenePropPrompt(scene, project) }
  }
  const shot = target as Shot
  if (kind === 'shotBoard') {
    if (hasStoredPrompt(shot.boardPrompt)) return null
    return { boardPrompt: defaultBoardPrompt(shot, project) }
  }
  if (kind === 'shotImage') {
    if (hasStoredPrompt(shot.imagePrompt)) return null
    return { imagePrompt: defaultShotImagePrompt(shot, project) }
  }
  // 视频框永不自动初始化、迁移或回填。只有用户主动点“按分镜重铺”才改它。
  return null
}
