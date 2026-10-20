import type { CanvasNode, Project, Shot } from '@/types'
import {
  normalizeH3GenMode,
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
  // 走首尾帧的镜头视频直接吃起始帧/结束帧，不要求关键帧或看板
  if (shotUsesFrames(shot, project)) return false
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
    (shot) =>
      !shotUsesFrames(shot, project) && stillModeForShot(shot, project) === 'keyframe' && !shot.imageAssetId
  )
}

export function shotsMissingStoryboard(project: Project): Shot[] {
  return (project.shots ?? []).filter(
    (shot) =>
      !shotUsesFrames(shot, project) && stillModeForShot(shot, project) === 'storyboard' && !shot.boardAssetId
  )
}

/** 这一镜是否走首尾帧出片：项目开了首尾帧链则全部镜头都是，否则看镜头自己的 h3GenMode。 */
export function shotUsesFrames(shot: Shot, project: Project | null | undefined): boolean {
  if (!project) return false
  if ((project.settings?.h3ShotChainMode || 'auto') === 'fl2va') return true
  return normalizeH3GenMode(shot.h3GenMode) === 'fl2va'
}

/**
 * 这个项目到底要不要走首尾帧：项目开了首尾帧链，或有镜头自己选了首尾帧模式。
 * 一处定义，画布分组、流水线下一步、智能体判断都用它，免得三边判断不一致。
 */
export function needsShotFrames(project: Project | null | undefined): boolean {
  if (!project) return false
  if ((project.settings?.h3ShotChainMode || 'auto') === 'fl2va') return true
  return (project.shots ?? []).some((shot) => normalizeH3GenMode(shot.h3GenMode) === 'fl2va')
}

/** 还缺起始帧或结束帧的镜头（只算走首尾帧的镜头，混合模式下普通镜头不算缺） */
export function shotsMissingFrames(project: Project | null | undefined): Shot[] {
  if (!project) return []
  return (project.shots ?? []).filter(
    (shot) => shotUsesFrames(shot, project) && (!shot.firstFrameAssetId || !shot.lastFrameAssetId)
  )
}

/** 首尾帧这一站是否还挂着活：要首尾帧，且还有镜头没画完 */
export function frameStagePending(project: Project | null | undefined): boolean {
  return needsShotFrames(project) && shotsMissingFrames(project).length > 0
}
