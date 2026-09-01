import type { ID, Project, Scene, Shot, Subject } from '@/types'
import { sceneForShotPlace } from '@/utils/shotPlace'
import { lookFromScript, mediumLockText } from '@/utils/visualStyle'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { stillModeForShot } from '@/utils/videoStill'

export interface ShotRefBundle {
  ids: ID[]
  labels: string[]
  characterCount: number
  hasScene: boolean
}

export function sceneHasKeyProps(scene: Pick<Scene, 'props'>): boolean {
  const value = scene.props?.trim()
  return Boolean(value && !/^(无|没有|暂无|none|no)$/i.test(value))
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

function castRefEntries(
  shot: Shot,
  project: Project,
  opts?: { includeProps?: boolean }
): { id: ID; label: string }[] {
  const subjects = project.subjects ?? []
  const bound = boundSubjectIds(shot, subjects)
  const speakerLabel = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const speaker = speakerLabel ? matchSubject(speakerLabel, subjects) : undefined
  const wanted = uniqueIds([...(speaker ? [speaker.id] : []), ...bound]).slice(0, 4)
  const out: { id: ID; label: string }[] = []
  for (const sid of wanted) {
    const sub = subjects.find((s) => s.id === sid)
    if (!sub) continue
    if (sub.designSheetAssetId) {
      out.push({
        id: sub.designSheetAssetId,
        label: `four-view turnaround of "${sub.name}" (${sub.kind}); lock face, hair, body and outfit`
      })
    }
    if (out.filter((x) => x.label.includes('four-view')).length >= 2) break
  }
  return out
}

/**
 * 看板参考：四视图 + 资产图 + 场景底板（还没有看板自己）
 */
export function collectShotBoardRefIds(shot: Shot, project: Project): ShotRefBundle {
  return packShotRefs(shot, project, { includeBoard: false, includeProps: true, max: 6 })
}

export type VideoRefKind = 'character' | 'scene' | 'board' | 'extra' | 'keyframe'

export interface VideoRefEntry {
  id: ID
  label: string
  kind: VideoRefKind
  name?: string
}

/** 视频参考：按该镜视频模型的 stillMode 打包。H3 identity 只人设+场景，不传看板/四宫格。 */
export function collectShotVideoEntries(shot: Shot, project: Project): VideoRefEntry[] {
  const omitted = new Set(shot.omittedRefAssetIds ?? [])
  const stillMode = stillModeForShot(shot, project)
  const subjects = project.subjects ?? []
  const bound = boundSubjectIds(shot, subjects)
  const speakerLabel = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const speaker = speakerLabel ? matchSubject(speakerLabel, subjects) : undefined
  const wanted = uniqueIds([...(speaker ? [speaker.id] : []), ...bound])
  const out: VideoRefEntry[] = []
  for (const sid of wanted) {
    const sub = subjects.find((item) => item.id === sid)
    if (!sub?.designSheetAssetId || omitted.has(sub.designSheetAssetId)) continue
    out.push({
      id: sub.designSheetAssetId,
      kind: 'character',
      name: sub.name,
      label: `CHARACTER DESIGN SHEET of ${sub.name}; lock only this person's face, hair, body and outfit; do not generate a four-view grid`
    })
  }
  const scene = sceneForShot(shot, project)
  if (scene?.plateAssetId && !omitted.has(scene.plateAssetId)) {
    out.push({
      id: scene.plateAssetId,
      kind: 'scene',
      name: scene.name,
      label: `SCENE PLATE of ${scene.name}; lock only space, materials and light; do not generate a four-panel grid`
    })
  }
  if (stillMode === 'storyboard' && shot.boardAssetId && !omitted.has(shot.boardAssetId)) {
    out.push({
      id: shot.boardAssetId,
      kind: 'board',
      name: `shot ${shot.index + 1}`,
      label: `six-panel STORYBOARD for [Shot 1]; action plan only; one continuous full-frame take; never copy panels or play them as a slideshow`
    })
  }
  if (stillMode === 'keyframe' && shot.imageAssetId && !omitted.has(shot.imageAssetId)) {
    out.unshift({
      id: shot.imageAssetId,
      kind: 'keyframe',
      name: 'keyframe',
      label: '2x2 four-panel KEYFRAME for [Shot 1] (exactly 4 cells, never more); action plan only; one continuous full-frame take; never copy the grid'
    })
  }
  const used = new Set(out.map((item) => item.id))
  for (const id of uniqueIds(shot.referenceAssetIds ?? [])) {
    if (!id || used.has(id) || omitted.has(id)) continue
    if (id === shot.imageAssetId || id === shot.boardAssetId) continue
    used.add(id)
    out.push({
      id,
      kind: 'extra',
      name: 'user reference',
      label: 'additional user reference; match people, clothing, product or style from this image'
    })
  }
  return out
}

export function collectShotVideoRefIds(shot: Shot, project: Project): ShotRefBundle {
  const entries = packVideoRefEntries(collectShotVideoEntries(shot, project))
  return {
    ids: entries.map((entry) => entry.id),
    labels: entries.map((entry) => entry.label),
    characterCount: entries.filter((entry) => entry.kind === 'character').length,
    hasScene: entries.some((entry) => entry.kind === 'scene')
  }
}

/** 最多 9 张。普通创作关键帧作为成片第一帧排在最前。 */
export function packVideoRefEntries(entries: VideoRefEntry[], max = 9): VideoRefEntry[] {
  const chars = entries.filter((entry) => entry.kind === 'character')
  const extras = entries.filter((entry) => entry.kind === 'extra')
  const scene = entries.find((entry) => entry.kind === 'scene')
  const board = entries.find((entry) => entry.kind === 'board')
  const keyframe = entries.find((entry) => entry.kind === 'keyframe')
  if (keyframe) {
    const reserved = [keyframe, scene].filter((entry): entry is VideoRefEntry => Boolean(entry))
    const leftover = Math.max(0, max - reserved.length)
    const extraTake = Math.min(extras.length, leftover)
    const charTake = Math.max(0, leftover - extraTake)
    return [keyframe, ...chars.slice(0, charTake), ...reserved.slice(1), ...extras.slice(0, extraTake)]
  }
  const reserved = [scene, board].filter((entry): entry is VideoRefEntry => Boolean(entry))
  const leftover = Math.max(0, max - reserved.length)
  const extraTake = Math.min(extras.length, leftover)
  const charTake = Math.max(0, leftover - extraTake)
  return [...chars.slice(0, charTake), ...reserved, ...extras.slice(0, extraTake)]
}

/**
 * 配图参考：故事看板 + 四视图 + 资产图 + 场景底板
 * 视频复刻必须带上用户产品图（GPT 编辑最多 4 张）
 */
export function collectShotRefIds(shot: Shot, project: Project): ShotRefBundle {
  return packShotRefs(shot, project, {
    includeBoard: videoRequiresStoryboard(project),
    includeProps: false,
    max: 8
  })
}

/** 普通创作关键帧：只用人设、场景、道具，不带故事看板。 */
export function collectShotKeyframeRefIds(shot: Shot, project: Project): ShotRefBundle {
  return packShotRefs(shot, project, { includeBoard: false, includeProps: false, max: 8 })
}

function packShotRefs(
  shot: Shot,
  project: Project,
  opts: { includeBoard: boolean; includeProps: boolean; max: number }
): ShotRefBundle {
  const omitted = new Set(shot.omittedRefAssetIds ?? [])
  const keep = (list: { id: ID; label: string }[]) =>
    omitted.size ? list.filter((item) => !omitted.has(item.id)) : list
  const scenes = project.scenes ?? []
  const chars = castRefEntries(shot, project, { includeProps: opts.includeProps })
  const scene =
    (shot.sceneId && scenes.find((s) => s.id === shot.sceneId)) || scenes[0]
  const sceneEntry = scene?.plateAssetId
    ? {
        id: scene.plateAssetId,
        label: `four-panel scene anchor sheet of "${scene.name}"; same place, no people; use overall space, main anchor, floor and light`
      }
    : null
  const scenePropEntry = opts.includeProps && sceneHasKeyProps(scene || {}) && scene?.propSheetAssetId
    ? {
        id: scene.propSheetAssetId,
        label: `key prop design sheet of "${scene.name}"; only the listed story-relevant objects must match`
      }
    : null
  const boardEntry =
    opts.includeBoard && shot.boardAssetId
      ? {
          id: shot.boardAssetId,
          label: 'six-panel action storyboard for this shot; use the final panel for framing and use all panels for blocking and prop-state continuity; do not copy the grid or line-art look'
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
    const boardOne = boardEntry ? [boardEntry] : []
    const reserved = charOne.length + sceneOne.length + boardOne.length
    const productSlots = Math.max(productEntries.length ? 1 : 0, 4 - reserved)
    const ordered: { id: ID; label: string }[] = [
      ...productEntries.slice(0, productSlots),
      ...boardOne,
      ...charOne,
      ...sceneOne
    ]
    for (const p of productEntries) {
      if (ordered.length >= 4) break
      if (!ordered.some((o) => o.id === p.id)) ordered.push(p)
    }
    const kept = keep(ordered)
    return {
      ids: kept.map((o) => o.id),
      labels: kept.map((o) => o.label),
      characterCount: charOne.length,
      hasScene: Boolean(sceneEntry)
    }
  }

  const fourViews = chars.filter((c) => c.label.includes('four-view'))
  const props = chars.filter((c) => !c.label.includes('four-view'))
  if (chars.length > 0 || sceneEntry || boardEntry) {
    const ordered = [
      ...(boardEntry ? [boardEntry] : []),
      ...fourViews.slice(0, 2),
      ...props.slice(0, 2),
      ...(scenePropEntry ? [scenePropEntry] : []),
      ...(sceneEntry ? [sceneEntry] : [])
    ]
    for (const id of uniqueIds(shot.referenceAssetIds ?? [])) {
      if (ordered.length >= opts.max) break
      if (ordered.some((o) => o.id === id)) continue
      ordered.push({ id, label: 'user extra reference' })
    }
    const kept = keep(ordered)
    return {
      ids: kept.map((o) => o.id),
      labels: kept.map((o) => o.label),
      characterCount: Math.min(fourViews.length, 2),
      hasScene: Boolean(sceneEntry)
    }
  }

  const fallback = uniqueIds([
    ...(shot.referenceAssetIds ?? []),
    ...(project.script?.referenceAssetIds ?? [])
  ]).filter((id) => !omitted.has(id))
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
  return sceneForShotPlace(shot, project)
}

export type ShotRefSlot = {
  id: ID
  label: string
  locked: boolean
}

export function refSlotLabel(id: ID, project: Project): string {
  const four = (project.subjects ?? []).find((s) => s.designSheetAssetId === id)
  if (four) return `四视图·${four.name}`
  const prop = (project.scenes ?? []).find((s) => s.propSheetAssetId === id)
  if (prop) return `关键道具·${prop.name}`
  const scn = (project.scenes ?? []).find((s) => s.plateAssetId === id)
  if (scn) return `锚点·${scn.name}`
  const board = (project.shots ?? []).find((s) => s.boardAssetId === id)
  if (board) return `看板·${board.index + 1}`
  if ((project.script?.referenceAssetIds ?? []).includes(id)) return '产品'
  return '参考'
}

/** 配图节点上展示：人设/空镜/产品锁定，额外参考可删 */
export function imageRefSlots(shot: Shot, project: Project): ShotRefSlot[] {
  const seen = new Set<ID>()
  const omitted = new Set(shot.omittedRefAssetIds ?? [])
  const slots: ShotRefSlot[] = []
  const push = (id: ID | undefined, label: string, locked: boolean) => {
    if (!id || seen.has(id) || omitted.has(id)) return
    seen.add(id)
    slots.push({ id, label, locked })
  }
  push(videoRequiresStoryboard(project) ? shot.boardAssetId : undefined, '故事看板', true)
  for (const sub of subjectsForShot(shot, project)) {
    push(sub.designSheetAssetId, `四视图·${sub.name}`, true)
  }
  const scene = sceneForShot(shot, project)
  push(scene?.plateAssetId, scene ? `锚点·${scene.name}` : '锚点图', true)
  push(scene?.propSheetAssetId, scene ? `关键道具·${scene.name}` : '关键道具图', true)
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

/** 看板节点：四视图 + 资产 + 空镜，不含看板自己 */
export function boardRefSlots(shot: Shot, project: Project): ShotRefSlot[] {
  return imageRefSlots(shot, project).filter((s) => s.id !== shot.boardAssetId)
}

/** 视频节点展示实际提交 H3 的图：角色设计图、场景图、故事看板。 */
export function videoRefSlots(shot: Shot, project: Project): ShotRefSlot[] {
  return packVideoRefEntries(collectShotVideoEntries(shot, project)).map((entry, index) => ({
    id: entry.id,
    label:
      entry.kind === 'character'
        ? `图${index + 1}：角色设计·${entry.name}`
        : entry.kind === 'scene'
          ? `图${index + 1}：场景·${entry.name}`
          : entry.kind === 'extra'
            ? `图${index + 1}：补充参考`
            : entry.kind === 'keyframe'
              ? `图${index + 1}：四宫格关键帧`
              : `图${index + 1}：本镜故事看板`,
    locked: false
  }))
}

export function videoExtraRefIds(shot: Shot): ID[] {
  return uniqueIds(shot.referenceAssetIds ?? [])
    .filter((id) => id !== shot.boardAssetId && id !== shot.imageAssetId)
}

export function videoExtraRefLead(shot: Shot, project: Project): string {
  const extras = videoExtraRefIds(shot).slice(0, 2)
  if (!shot.boardAssetId && !extras.length) return ''
  const filmChapter =
    project.pipelineMode !== 'remake' && project.script?.workflowMode === 'film-chapter'
  const parts = [
    shot.boardAssetId
      ? filmChapter
        ? '图一是本镜彩色四/八宫格电影故事看板，不是视频首帧。按左上到右下执行动作时间线，禁止复制宫格、边框或拼贴。'
        : '图一是本镜六格黑白动作看板，不是视频首帧。按左上到右下执行动作时间线，禁止复制分格、边框、线稿或拼贴。'
      : '图一是本镜主参考图。'
  ]
  extras.forEach((id, i) => {
    if (id === shot.boardAssetId) {
      parts.push(
        filmChapter
          ? `图${i + 2}是本镜彩色电影故事看板，只参考从左上到右下的动作顺序、构图、道具状态和结束姿势；不要复制宫格边框、拼贴版式或同时出现多个画面。`
          : `图${i + 2}是本镜六格黑白动作看板，只参考从左上到右下的动作顺序、道具状态和结束姿势；不要复制分格边框、线稿、拼贴版式或同时出现六个画面。`
      )
    } else {
      parts.push(`图${i + 2}是${refSlotLabel(id, project)}，用来锁人物或道具，不要当成新出场的人。`)
    }
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
  const ar = project.settings?.aspectRatio || '16:9'
  parts.push(`画面比例必须是 ${ar}，整张图按这个画幅输出，禁止另一种比例。`)
  const dialogueSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const filmChapter =
    project.pipelineMode !== 'remake' && project.script?.workflowMode === 'film-chapter'
  if ((shot.audioMode || 'h3-dialogue') === 'h3-dialogue' && dialogueSpeaker) {
    parts.push(
      `这是「${dialogueSpeaker}」的出镜对白镜头。单画面起始构图必须已经明确落在${dialogueSpeaker}身上，让${dialogueSpeaker}成为唯一、无歧义的主视觉，脸和嘴清楚可见；可以用中近景、近景、过肩构图或以${dialogueSpeaker}为主体的双人构图，但其他人只能作为闭嘴倾听或反应者，不能与${dialogueSpeaker}争夺视觉中心。`
    )
  }
  if (shot.boardAssetId && videoRequiresStoryboard(project)) {
    parts.push(
      filmChapter
        ? '附件中的彩色四/八宫格电影故事看板按左上到右下展示动作过程。视频起始帧采用第一格的开场构图、站位、朝向、天气和道具状态，后续动作顺序由文字提示承接；只生成一张完整的单画面起始帧，绝对不要复制宫格边框、编号或拼贴版式。'
        : '附件中的六格故事看板按左上到右下展示同一镜头的动作过程。视频起始帧采用第一格的开场构图、站位、朝向和道具状态，后续动作顺序由文字提示承接；只生成一张完整上色的单画面起始帧，绝对不要复制六格边框、线稿、编号或拼贴版式。'
    )
  } else if (!videoRequiresStoryboard(project)) {
    parts.push(
      '这是这一镜的四宫格关键帧：2 列 × 2 行，正好 4 格，不能超过 4 格，也不能少格留白。左上到右下依次是初态、准备、核心事件、结束。用人设图锁脸和服装，用场景图锁地点和光线。禁止 6 格、8 格、空白格或把格子画成四张无关海报。'
    )
  }
  if (chars.length) {
    parts.push(
      '人物必须与四视图完全一致（同一张脸、发型、体型、服装、配色）：' +
        chars
          .map((c) => `${c.name} — ${c.description}`)
          .join('；')
    )
  }
  if (scene) {
    parts.push(
      `地点必须与场景锚点图「${scene.name}」一致：${scene.description}${scene.mainAnchor ? `；主锚是${scene.mainAnchor}` : ''}。锚点图是四宫格设定，成片只要同一个地方，不要把四格画进画面。场景里没有人；把上述人物按四视图放进去，禁止另造场景，也禁止再添路人。`
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
