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
  collectShotVideoEntries,
  composeShotImagePrompt,
  packVideoRefEntries,
  sceneForShot,
  subjectsForShot
} from '@/utils/consistency'
import { resolveShotPlace } from '@/utils/shotPlace'
import { lookFromScript } from '@/utils/visualStyle'
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
  return [
    roster,
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

export function subjectSendPrompt(subject: Subject, project: Project): string {
  const raw = subject.sheetPrompt?.trim() || defaultSubjectSheetPrompt(subject, project)
  return ensureCharacterSheetWhiteBackground(raw)
}

export function sceneSendPrompt(scene: Scene, project: Project): string {
  return scene.platePrompt?.trim() || defaultScenePlatePrompt(scene, project)
}

export function scenePropSendPrompt(scene: Scene, project: Project): string {
  return scene.propSheetPrompt?.trim() || defaultScenePropPrompt(scene, project)
}

export function boardSendPrompt(shot: Shot, project: Project): string {
  return shot.boardPrompt?.trim() || defaultBoardPrompt(shot, project)
}

export function shotImageSendPrompt(shot: Shot, project: Project): string {
  return shot.imagePrompt?.trim() || defaultShotImagePrompt(shot, project)
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
