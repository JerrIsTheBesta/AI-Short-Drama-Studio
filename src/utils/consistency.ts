import type { ID, Project, Scene, Shot, Subject } from '@/types'
import { lookFromScript, mediumLockText } from '@/utils/visualStyle'

export interface ShotRefBundle {
  ids: ID[]
  labels: string[]
  characterCount: number
  hasScene: boolean
}

function uniqueIds(ids: ID[]): ID[] {
  const out: ID[] = []
  for (const id of ids) {
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** 用来对上人物：id、名字、身份称呼 */
export function subjectMatchKeys(sub: Subject): string[] {
  return uniqueIds(
    [sub.id, sub.name, sub.role]
      .map((s) => String(s ?? '').trim())
      .filter((s) => s.length >= 2)
  )
}

export function matchSubject(token: string, subjects: Subject[]): Subject | undefined {
  const key = String(token ?? '').trim()
  if (!key) return undefined
  const lower = key.toLowerCase()
  return subjects.find((s) =>
    subjectMatchKeys(s).some((k) => k === key || k.toLowerCase() === lower)
  )
}

export function inferSubjectsFromText(text: string, subjects: Subject[]): Subject[] {
  const t = text || ''
  if (!t.trim() || !subjects.length) return []
  return subjects.filter((s) => subjectMatchKeys(s).some((k) => t.includes(k)))
}

export function shotCastText(shot: Pick<Shot, 'title' | 'visualPrompt' | 'videoPrompt' | 'voiceover' | 'blocking'>): string {
  return [shot.title, shot.visualPrompt, shot.videoPrompt, shot.voiceover, shot.blocking]
    .map((s) => String(s ?? ''))
    .join('\n')
}

/** 这一镜真正该用的人物：既认 id，也认名字/称呼，并从文案里补漏绑 */
export function boundSubjectIds(shot: Shot, subjects: Subject[]): ID[] {
  const explicit = (shot.subjectIds ?? [])
    .map((token) => matchSubject(String(token), subjects)?.id)
    .filter((id): id is ID => Boolean(id))
  const inferred = inferSubjectsFromText(shotCastText(shot), subjects).map((s) => s.id)
  return uniqueIds([...explicit, ...inferred])
}

/**
 * 配图参考：
 * - 普通项目固定 3 槽：1-2 角色设计图 + 场景底板
 * - 视频复刻必须带上用户产品图（GPT 编辑最多 4 张）
 */
export function collectShotRefIds(shot: Shot, project: Project): ShotRefBundle {
  const subjects = project.subjects ?? []
  const scenes = project.scenes ?? []

  const wanted = boundSubjectIds(shot, subjects).slice(0, 4)
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
  if (project.pipelineMode !== 'remake' && chars.length === 1) {
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

  if (project.pipelineMode === 'remake') {
    const products = uniqueIds([
      ...(shot.referenceAssetIds ?? []),
      ...(project.script?.referenceAssetIds ?? [])
    ])
    const productEntries = products.map((id, i) => ({
      id,
      label: `user product photo ${i + 1}; replace every on-screen product with this exact item, packaging, logo and color`
    }))
    const charOne = chars[0] ? [chars[0]] : []
    const sceneOne = sceneEntry ? [sceneEntry] : []
    const reserved = charOne.length + sceneOne.length
    const productSlots = Math.max(productEntries.length ? 1 : 0, 4 - reserved)
    const ordered: { id: ID; label: string }[] = [
      ...productEntries.slice(0, productSlots),
      ...charOne,
      ...sceneOne
    ]
    for (const p of productEntries) {
      if (ordered.length >= 4) break
      if (!ordered.some((o) => o.id === p.id)) ordered.push(p)
    }
    return {
      ids: ordered.map((o) => o.id),
      labels: ordered.map((o) => o.label),
      characterCount: charOne.length,
      hasScene: Boolean(sceneEntry)
    }
  }

  if (chars.length > 0 || sceneEntry) {
    const ordered = [...chars.slice(0, 2), ...(sceneEntry ? [sceneEntry] : [])]
    for (const id of uniqueIds(shot.referenceAssetIds ?? [])) {
      if (ordered.length >= 6) break
      if (ordered.some((o) => o.id === id)) continue
      ordered.push({ id, label: 'user extra reference' })
    }
    return {
      ids: ordered.map((o) => o.id),
      labels: ordered.map((o) => o.label),
      characterCount: Math.min(chars.length, 2),
      hasScene: Boolean(sceneEntry)
    }
  }

  const fallback = uniqueIds([
    ...(shot.referenceAssetIds ?? []),
    ...(project.script?.referenceAssetIds ?? [])
  ])
  return {
    ids: fallback.slice(0, 3),
    labels: fallback.slice(0, 3).map((_, i) => `style/product reference ${i + 1}`),
    characterCount: 0,
    hasScene: false
  }
}

export function subjectsForShot(shot: Shot, project: Project): Subject[] {
  const all = project.subjects ?? []
  const ids = boundSubjectIds(shot, all)
  return ids
    .map((id) => all.find((s) => s.id === id))
    .filter((s): s is Subject => Boolean(s))
}

export function sceneForShot(shot: Shot, project: Project): Scene | undefined {
  const all = project.scenes ?? []
  if (shot.sceneId) return all.find((s) => s.id === shot.sceneId)
  return all[0]
}

export type ShotRefSlot = {
  id: ID
  label: string
  locked: boolean
}

export function refSlotLabel(id: ID, project: Project): string {
  const sub = (project.subjects ?? []).find((s) => s.designSheetAssetId === id)
  if (sub) return `人设·${sub.name}`
  const scn = (project.scenes ?? []).find((s) => s.plateAssetId === id)
  if (scn) return `空镜·${scn.name}`
  if ((project.script?.referenceAssetIds ?? []).includes(id)) return '产品'
  return '参考'
}

/** 配图节点上展示：人设/空镜/产品锁定，额外参考可删 */
export function imageRefSlots(shot: Shot, project: Project): ShotRefSlot[] {
  const seen = new Set<ID>()
  const slots: ShotRefSlot[] = []
  const push = (id: ID | undefined, label: string, locked: boolean) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    slots.push({ id, label, locked })
  }
  for (const sub of subjectsForShot(shot, project)) {
    push(sub.designSheetAssetId, `人设·${sub.name}`, true)
  }
  const scene = sceneForShot(shot, project)
  push(scene?.plateAssetId, scene ? `空镜·${scene.name}` : '空镜', true)
  if (project.pipelineMode === 'remake') {
    for (const id of project.script?.referenceAssetIds ?? []) {
      push(id, '产品', true)
    }
  }
  for (const id of uniqueIds(shot.referenceAssetIds ?? [])) {
    push(id, refSlotLabel(id, project), false)
  }
  return slots
}

/** 视频节点上展示：本镜配图锁定，额外参考可删可加 */
export function videoRefSlots(shot: Shot, project: Project): ShotRefSlot[] {
  const seen = new Set<ID>()
  const slots: ShotRefSlot[] = []
  if (shot.imageAssetId) {
    seen.add(shot.imageAssetId)
    slots.push({ id: shot.imageAssetId, label: '本镜配图', locked: true })
  }
  for (const id of uniqueIds(shot.referenceAssetIds ?? [])) {
    if (seen.has(id)) continue
    seen.add(id)
    slots.push({ id, label: refSlotLabel(id, project), locked: false })
  }
  return slots
}

export function videoExtraRefIds(shot: Shot): ID[] {
  return uniqueIds(shot.referenceAssetIds ?? []).filter((id) => id !== shot.imageAssetId)
}

export function videoExtraRefLead(shot: Shot, project: Project): string {
  const extras = videoExtraRefIds(shot).slice(0, 2)
  if (!extras.length) return ''
  const parts = ['图一是本镜画面，从这一帧接着演。']
  extras.forEach((id, i) => {
    parts.push(`图${i + 2}是${refSlotLabel(id, project)}，用来锁人物或道具，不要当成新出场的人。`)
  })
  return parts.join('')
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
      `地点必须与空镜底板「${scene.name}」一致：${scene.description}。场景底板里没有人；把上述人物按人设放进这个空场景，禁止另造场景，也禁止再添路人。`
    )
  }
  if (project.pipelineMode === 'remake') {
    parts.push(
      '画面中出现的商品必须换成用户上传的产品参考图：外观、包装、logo、配色完全一致，禁止沿用参考视频里的原品牌商品。'
    )
  }
  if (aesthetic) parts.push(aesthetic)
  const look = lookFromScript(project.script)
  parts.push(mediumLockText(look))
  return parts.filter(Boolean).join('\n')
}
