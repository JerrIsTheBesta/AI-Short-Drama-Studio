type ProjectGate = {
  pipelineMode?: string
  script?: { workflowMode?: string } | null
} | null | undefined

/** 只有 AI 短剧 / 电影章节才走故事看板。普通创作用人设+场景出关键帧，再出视频。 */
export function videoRequiresStoryboard(project?: ProjectGate): boolean {
  if (!project) return false
  if (project.pipelineMode === 'drama') return true
  if (project.pipelineMode === 'remake' || project.pipelineMode === 'img2video') return false
  if (project.pipelineMode === 'standard' || project.pipelineMode === 'smart-speech') return false
  return project.script?.workflowMode === 'film-chapter'
}

/** 画布上铺看板节点；普通创作铺关键帧节点，不铺空白看板。 */
export function usesStoryboardCanvas(project?: ProjectGate): boolean {
  return videoRequiresStoryboard(project)
}
