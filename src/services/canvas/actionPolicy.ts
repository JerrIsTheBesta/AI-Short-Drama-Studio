import type { AgentToolAction } from './toolRegistry'
import type { Project } from '@/types'

/** Include parameters: two extraction stages / two different edits are not duplicates. */
export function actionKey(action: AgentToolAction): string {
  return JSON.stringify(Object.entries(action).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)))
}

export function uniqueActions<T extends AgentToolAction>(actions: T[]): T[] {
  const seen = new Set<string>()
  return actions.filter((action) => {
    const key = actionKey(action)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function explicitlyRequestsExtraction(text: string): boolean {
  return /提炼|提取|拆分镜|拆镜|拆剧本|拆人物|拆场景|拆节点|出节点/.test(text)
}

/** Fail-safe for an already extracted project, not a replacement for semantic planning. */
export function normalizeAssetRedo(actions: AgentToolAction[], text: string, project: Project | null): AgentToolAction[] {
  if (!project || explicitlyRequestsExtraction(text) || !/重做|重画|重新(?:生成|画|出)|更新|重来/.test(text)) return actions
  // Editing text is not consent to paid generation; conservative fallback for mixed/negative requests.
  if (/(?:不要|不用|先不|暂不|别).{0,12}(?:生成|重画|重做)|(?:只|仅).{0,8}(?:提示词|描述|文案)/.test(text)) return actions
  if (/提示词|描述|文案/.test(text) && !/重画|重新(?:生成|画|出)/.test(text)) return actions
  const requested = (pattern: RegExp) => text.split(/[，,。；;\n]/).some((clause) =>
    pattern.test(clause) && !/不要|不用|先不|暂不|不动|别动|以后|后期|后续/.test(clause))
  const subjects = requested(/人物角色图|人物图|角色图|人设图|四视图/) && Boolean(project.subjects?.length)
  const scenes = requested(/场景图|场景锚点|底板/) && Boolean(project.scenes?.length)
  if (!subjects && !scenes) return actions
  const result = actions.filter((action) => action.tool !== 'extract_cast').map((action) => ({ ...action }))
  for (const [requested, batch, single] of [
    [subjects, 'generate_all_sheets', 'generate_sheet'],
    [scenes, 'generate_all_scenes', 'generate_scene']
  ] as const) {
    if (!requested) continue
    for (const action of result) if (action.tool === batch) action.regenerate = true
    const nodePrefix = batch === 'generate_all_sheets' ? 'subject:' : 'scene:'
    if (result.some((action) => action.tool === batch || action.tool === single ||
      (action.tool === 'run_node' && action.nodeId?.startsWith(nodePrefix)))) continue
    const named = batch === 'generate_all_sheets'
      ? (project.subjects ?? []).filter((item) => item.name && text.includes(item.name)).map((item) => ({ tool: single, subjectId: item.id }))
      : (project.scenes ?? []).filter((item) => item.name && text.includes(item.name)).map((item) => ({ tool: single, sceneId: item.id }))
    result.push(...(named.length ? named : [{ tool: batch, regenerate: true }]))
  }
  return result
}

/** Avoid recharging completed generation on observation/recovery unless an edit followed it. */
export function alreadyGenerated(action: AgentToolAction, completed: AgentToolAction[]): boolean {
  if (!/^generate_(?:sheet|scene|shot_|video|audio)/.test(action.tool) && action.tool !== 'run_node') return false
  const target = (a: AgentToolAction) => `${a.tool}:${a.subjectId || a.sceneId || a.shotId || a.nodeId || ''}`
  const index = completed.map(target).lastIndexOf(target(action))
  if (index < 0) return false
  return !completed.slice(index + 1).some((done) =>
    ['update_node', 'revise_shot', 'set_visual_style', 'optimize_node_prompt', 'extract_cast'].includes(done.tool))
}

/** Snapshot batch redo targets into individual jobs, so recovery never reruns successful siblings. */
export function expandRegeneration(actions: AgentToolAction[], project: Project | null): AgentToolAction[] {
  if (!project) return actions
  return actions.flatMap((action): AgentToolAction[] => {
    if (!action.regenerate) return [action]
    if (action.tool === 'generate_all_sheets') return (project.subjects ?? []).map((s) => ({ tool: 'generate_sheet', subjectId: s.id, regenerate: true }))
    if (action.tool === 'generate_all_scenes') return (project.scenes ?? []).map((s) => ({ tool: 'generate_scene', sceneId: s.id, regenerate: true }))
    const singles: Partial<Record<AgentToolAction['tool'], AgentToolAction['tool']>> = {
      generate_all_boards: 'generate_shot_board', generate_all_images: 'generate_shot_image',
      generate_all_frames: 'generate_shot_frames', generate_all_videos: 'generate_video', generate_all_audio: 'generate_audio'
    }
    const single = singles[action.tool]
    return single ? project.shots.map((s) => ({ tool: single, shotId: s.id, regenerate: true })) : [action]
  })
}
