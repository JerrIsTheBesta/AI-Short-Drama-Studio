import type { ID, Project, Scene, Shot, Subject } from '@/types'

export interface ShotRefBundle {
  ids: ID[]
  labels: string[]
  characterCount: number
  hasScene: boolean
}

/**
 * 配图工作流固定 3 槽：
 * 1-2 角色多角度设计图（只有 1 个角色时重复填第 2 槽）
 * 3   场景底板
 */
export function collectShotRefIds(shot: Shot, project: Project): ShotRefBundle {
  const subjects = project.subjects ?? []
  const scenes = project.scenes ?? []

  const wanted = (shot.subjectIds?.length ? shot.subjectIds : subjects.map((s) => s.id)).slice(0, 4)
  const chars: { id: ID; label: string }[] = []
  for (const sid of wanted) {
    const sub = subjects.find((s) => s.id === sid)
    if (!sub?.designSheetAssetId) continue
    chars.push({
      id: sub.designSheetAssetId,
      label: `character design sheet of "${sub.name}" (${sub.kind})`
    })
    if (chars.length >= 2) break
  }
  if (chars.length === 1) {
    chars.push({
      ...chars[0],
      label: `${chars[0].label}, second copy for identity lock`
    })
  }

  const scene =
    (shot.sceneId && scenes.find((s) => s.id === shot.sceneId)) || scenes[0]
  const sceneEntry = scene?.plateAssetId
    ? {
        id: scene.plateAssetId,
        label: `empty scene plate of "${scene.name}", environment only`
      }
    : null

  if (chars.length > 0 || sceneEntry) {
    const ordered = [...chars.slice(0, 2), ...(sceneEntry ? [sceneEntry] : [])]
    return {
      ids: ordered.map((o) => o.id),
      labels: ordered.map((o) => o.label),
      characterCount: Math.min(chars.length, 2),
      hasScene: Boolean(sceneEntry)
    }
  }

  const fallback = [
    ...(shot.referenceAssetIds ?? []),
    ...(project.script?.referenceAssetIds ?? [])
  ]
  const unique: ID[] = []
  for (const id of fallback) {
    if (!unique.includes(id)) unique.push(id)
  }
  return {
    ids: unique.slice(0, 3),
    labels: unique.slice(0, 3).map((_, i) => `style/product reference ${i + 1}`),
    characterCount: 0,
    hasScene: false
  }
}

export function subjectsForShot(shot: Shot, project: Project): Subject[] {
  const all = project.subjects ?? []
  if (shot.subjectIds?.length) {
    return shot.subjectIds
      .map((id) => all.find((s) => s.id === id))
      .filter((s): s is Subject => Boolean(s))
  }
  return all
}

export function sceneForShot(shot: Shot, project: Project): Scene | undefined {
  const all = project.scenes ?? []
  if (shot.sceneId) return all.find((s) => s.id === shot.sceneId)
  return all[0]
}

export function missingCastAssets(project: Project): {
  subjects: Subject[]
  scenes: Scene[]
} {
  return {
    subjects: (project.subjects ?? []).filter((s) => !s.designSheetAssetId),
    scenes: (project.scenes ?? []).filter((s) => !s.plateAssetId)
  }
}

export function composeShotImagePrompt(
  shot: Shot,
  project: Project,
  basePrompt: string
): string {
  const chars = subjectsForShot(shot, project)
  const scene = sceneForShot(shot, project)
  const aesthetic = project.script?.aesthetic?.trim()
  const parts = [basePrompt.trim()]
  if (chars.length) {
    parts.push(
      '人物必须与人设图完全一致（同一张脸、发型、体型、服装、配色）：' +
        chars.map((c) => `${c.name} — ${c.description}`).join('；')
    )
  }
  if (scene) {
    parts.push(
      `地点必须与场景底板「${scene.name}」一致：${scene.description}。禁止另造场景。`
    )
  }
  if (aesthetic) parts.push(aesthetic)
  return parts.filter(Boolean).join('\n')
}
