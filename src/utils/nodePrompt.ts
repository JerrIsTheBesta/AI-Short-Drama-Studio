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
import { buildH3ImageSlots, composeH3VideoPrompt } from '@/services/ai/h3Prompt'
import { getVideoPromptStyle } from '@/services/ai/runtime'
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
import { resolveH3VoiceMode } from '@/utils/shot'
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
  const cast = subjectsForShot(shot, project)
  const scene = sceneForShot(shot, project)
  const place = resolveShotPlace(shot, scene)
  const spoken = spokenTextOnly(shot.voiceover || '')
  const onScreenNames = cast.map((item) => item.name)
  const visibleSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  return composeH3VideoPrompt({
    prompt: shotDirectorBrief(shot, project),
    aesthetic: project.script?.h3Aesthetic || project.script?.aesthetic,
    audioDescription: shot.audioDescription,
    voiceover: spoken,
    voiceMode: spoken ? resolveH3VoiceMode(shot, onScreenNames) : 'none',
    speakerHint: shot.speakerHint,
    speakerName: visibleSpeaker,
    onScreenNames,
    sceneName: place.name,
    sceneLighting: place.lighting,
    shotTitle: shot.title,
    imageAssignments: imageSlots.map((slot) => slot.job),
    imageSlots,
    duration: shot.duration,
    width: project.settings.width,
    height: project.settings.height,
    aspectRatio: project.settings.aspectRatio,
    cameraMovement: shot.cameraMovement,
    promptStyle: getVideoPromptStyle(),
    mode: 'R2VA'
  })
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
  if (shot.compiledVideoPrompt != null && shot.compiledVideoPrompt.trim()) {
    return shot.compiledVideoPrompt
  }
  return defaultVideoSendPrompt(shot, project)
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
  if (hasStoredPrompt(shot.compiledVideoPrompt)) return null
  return { compiledVideoPrompt: defaultVideoSendPrompt(shot, project) }
}
