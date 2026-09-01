import type { CanvasNode, Project, Shot } from '@/types'
import {
  normalizeVideoGenModel,
  stillModeForVideoModel,
  type VideoStillMode
} from '@/types/canvas'

export function stillModeFromNode(node?: Pick<CanvasNode, 'data'> | null): VideoStillMode {
  const raw = node?.data.videoStillMode
  if (raw === 'identity' || raw === 'keyframe' || raw === 'storyboard') return raw
  return stillModeForVideoModel(normalizeVideoGenModel(node?.data.videoModel))
}

export function shotVideoNode(project: Project | null | undefined, shotId: string) {
  return project?.canvas?.nodes.find((n) => n.type === 'shotVideo' && n.data.shotId === shotId)
}

export function stillModeForShot(shot: Shot, project: Project): VideoStillMode {
  return stillModeFromNode(shotVideoNode(project, shot.id))
}

export function shotMissingStill(shot: Shot, project: Project): boolean {
  const mode = stillModeForShot(shot, project)
  if (mode === 'storyboard') return !shot.boardAssetId
  if (mode === 'keyframe') return !shot.imageAssetId
  return false
}

export function stillTypeForMode(mode: VideoStillMode): 'shotBoard' | 'shotImage' | null {
  if (mode === 'storyboard') return 'shotBoard'
  if (mode === 'keyframe') return 'shotImage'
  return null
}

export function shotsMissingKeyframe(project: Project): Shot[] {
  return (project.shots ?? []).filter(
    (shot) => stillModeForShot(shot, project) === 'keyframe' && !shot.imageAssetId
  )
}

export function shotsMissingStoryboard(project: Project): Shot[] {
  return (project.shots ?? []).filter(
    (shot) => stillModeForShot(shot, project) === 'storyboard' && !shot.boardAssetId
  )
}
