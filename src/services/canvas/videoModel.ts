import { useProjectStore } from '@/stores/project'
import { useSettingsStore } from '@/stores/settings'
import {
  normalizeVideoGenModel,
  normalizeVideoResolution,
  stillModeForVideoModel,
  videoMaxSeconds,
  videoMinSeconds,
  videoStillNeedsCanvas,
  type VideoGenModel,
  type VideoStillMode
} from '@/types/canvas'
import { stillModeFromNode } from '@/utils/videoStill'
import { rebuildCanvasGraph } from './layout'

/** 节点切视频模型时同时写入参考图策略，必要时重铺「分镜关键帧」分组。 */
export function applyShotVideoModel(nodeId: string, model: VideoGenModel) {
  const project = useProjectStore()
  const settings = useSettingsStore()
  const node = project.current?.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) return
  const prevStill = stillModeFromNode(node)
  const nextStill = stillModeForVideoModel(model, settings.config.video)
  const nextH3Mode = settings.config.video.provider === 'zealman' && settings.config.video.workflowId.startsWith('U02-')
    ? 'fl2va'
    : node.data.h3GenMode
  const min = videoMinSeconds(model)
  const max = videoMaxSeconds(model)
  project.patchCanvasNode(nodeId, {
    videoModel: model,
    videoProfileId: model === 'h3' ? settings.config.activeVideoId : undefined,
    videoStillMode: nextStill,
    h3GenMode: nextH3Mode,
    videoResolution: normalizeVideoResolution(node.data.videoResolution, model),
    ...(node.type === 'videoGen'
      ? { duration: Math.min(max, Math.max(min, Math.round(node.data.duration || min))) }
      : {})
  })
  const shotId = node.data.shotId
  if (node.type === 'shotVideo' && shotId) {
    const shot = project.current?.shots.find((s) => s.id === shotId)
    if (shot) {
      project.updateShot(shot.id, {
        duration: Math.min(max, Math.max(min, Math.round(shot.duration || min))),
        videoProfileId: model === 'h3' ? settings.config.activeVideoId : undefined,
        h3GenMode: nextH3Mode
      })
    }
  }
  if (
    node.type === 'shotVideo' &&
    videoStillNeedsCanvas(prevStill) !== videoStillNeedsCanvas(nextStill) &&
    project.current
  ) {
    project.setCanvas(rebuildCanvasGraph(project.current, true))
  }
}

/** 设置里改当前视频接入的参考图方式后，同步所有走该接入的分镜节点。 */
export function syncH3ShotStillModes(stillMode: VideoStillMode) {
  const project = useProjectStore()
  const p = project.current
  if (!p?.canvas) return
  for (const node of p.canvas.nodes) {
    if (node.type !== 'shotVideo') continue
    const model = normalizeVideoGenModel(node.data.videoModel)
    if (model === 'h3-v5' || model === 'wan-prime') continue
    project.patchCanvasNode(node.id, { videoStillMode: stillMode })
  }
  if (project.current) project.setCanvas(rebuildCanvasGraph(project.current, true))
}
