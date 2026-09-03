import type { Project, TimelineClip } from '@/types'

export function timelineClipAssetId(project: Project, clip: TimelineClip): string | undefined {
  if (clip.assetId) return clip.assetId
  const shot = project.shots.find((item) => item.id === clip.shotId)
  return shot?.videoAssetId || shot?.imageAssetId
}

/** 按分镜顺序从已有视频/图片构建时间线 */
export function buildTimelineFromShots(project: Project): TimelineClip[] {
  const clips: TimelineClip[] = [...project.shots]
    .sort((a, b) => a.index - b.index)
    .filter((s) => s.videoAssetId || s.imageAssetId)
    .map((s) => ({
      id: 'tc_' + s.id,
      shotId: s.id,
      startTime: 0,
      duration: s.duration,
      sourceIn: 0,
      transitionIn: project.settings.defaultTransition,
      transitionDuration: 0.5,
      speed: 1,
      volume: 1,
      enabled: true
    }))

  let cursor = 0
  for (const c of clips) {
    c.startTime = cursor
    cursor += c.duration
  }
  return clips
}

/**
 * 若时间线为空且有可导出分镜，则自动补齐。
 * 返回是否新建了时间线。
 */
export function ensureTimelineFromShots(project: Project): {
  built: boolean
  clips: TimelineClip[]
} {
  if (project.timeline.length > 0) {
    return { built: false, clips: project.timeline }
  }
  const clips = buildTimelineFromShots(project)
  return { built: clips.length > 0, clips }
}

/** 是否具备导出条件（时间线有启用片段，或分镜已有视频素材） */
export function canBuildExport(project: Project | null | undefined): boolean {
  if (!project) return false
  if (project.timeline.some((c) => c.enabled)) return true
  return project.shots.some((s) => s.videoAssetId || s.imageAssetId)
}
