import { autodlVideoProfileId } from '@/services/ai/runtime'
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
export function applyShotVideoModel(nodeId: string, model: VideoGenModel, profileId?: string) {
  const project = useProjectStore()
  const settings = useSettingsStore()
  const node = project.current?.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) return
  // 「H3 v5」这组选项写明走 AutoDL 令牌。没点具体接入时不能回落到当前 Zealman。
  const selectedProfileId = profileId
    || (model === 'h3' || model === 'h3-v5' ? autodlVideoProfileId() : undefined)
  const selectedProfile = selectedProfileId
    ? settings.config.videos.find((profile) => profile.id === selectedProfileId)
    : undefined
  const prevStill = stillModeFromNode(node)
  const nextStill = stillModeForVideoModel(model, selectedProfile || settings.config.video)
  const nextH3Mode = selectedProfile?.provider === 'zealman' && selectedProfile.workflowId.startsWith('U02-')
    ? 'fl2va'
    : node.data.h3GenMode
  const min = videoMinSeconds(model)
  const max = videoMaxSeconds(model)
  project.patchCanvasNode(nodeId, {
    videoModel: model,
    videoProfileId: selectedProfileId,
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
        videoProfileId: selectedProfileId,
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

/** 节点明确选择某条接入线路；不能只改全局当前项，否则 UI 与实际提交线路会分叉。 */
export function applyShotVideoProfile(nodeId: string, profileId: string) {
  const settings = useSettingsStore()
  if (!settings.config.videos.some((profile) => profile.id === profileId)) return
  settings.selectVideo(profileId)
  applyShotVideoModel(nodeId, 'h3', profileId)
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
