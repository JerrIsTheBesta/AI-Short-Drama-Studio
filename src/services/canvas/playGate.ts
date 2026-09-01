import type { Project } from '@/types'

export const PLAY_GATE_MSG =
  '请先查看左侧完整剧本并点「确认通过」。验收后才做人设、故事看板或视频。除非你明确说全流程。'

export function isPlayApproved(p: Project | null | undefined): boolean {
  if (!p) return false
  if (p.playApproved === true) return true
  if (p.playApproved === false) return false
  const hasDownstream =
    (p.subjects ?? []).some((s) => s.designSheetAssetId) ||
    (p.scenes ?? []).some((s) => s.plateAssetId) ||
    p.shots.some((s) => s.imageAssetId || s.videoAssetId)
  return hasDownstream
}

export function needsPlayReview(p: Project | null | undefined): boolean {
  if (p?.pipelineMode === 'img2video') return false
  return Boolean(p?.shots.length) && !isPlayApproved(p)
}

export function isFullPipelineRequest(text: string) {
  return /全部做完|全部生成|都生成|全做|一口气|整条流水线|从头到尾|缺的都补|全流程|完整流程|全套/.test(text)
}

export function isApprovePlayRequest(text: string) {
  return /确认剧本|验收通过|确认通过|剧本没问题|通过验收|验收了/.test(text)
}

export const DOWNSTREAM_TOOLS = new Set([
  'generate_sheet',
  'generate_all_sheets',
  'generate_all_prop_sheets',
  'generate_prop_sheet',
  'generate_scene',
  'generate_all_scenes',
  'generate_shot_board',
  'generate_all_boards',
  'generate_shot_image',
  'generate_all_images',
  'generate_video',
  'generate_all_videos',
  'generate_audio',
  'generate_all_audio',
  'run_node'
])
