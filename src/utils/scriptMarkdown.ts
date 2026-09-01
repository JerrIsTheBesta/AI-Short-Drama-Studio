import type { Project, Scene, Script, Shot, Subject } from '@/types'

const CAM: Record<Shot['cameraMovement'], string> = {
  push: '推',
  pull: '拉',
  pan: '摇',
  tilt: '移',
  static: '固定',
  orbit: '环绕'
}

const CAM_REV: Record<string, Shot['cameraMovement']> = {
  推: 'push',
  拉: 'pull',
  摇: 'pan',
  移: 'tilt',
  固定: 'static',
  环绕: 'orbit',
  push: 'push',
  pull: 'pull',
  pan: 'pan',
  tilt: 'tilt',
  static: 'static',
  orbit: 'orbit'
}

/** 把当前项目拼成一份完整剧本 Markdown（大标题 / 小标题分段）。 */
export function composeProjectPlayMarkdown(p: Project): string {
  const script = p.script
  const parts: string[] = []
  parts.push(`# ${script?.topic || p.name || '剧本'}`)
  parts.push('')

  const raw = (script?.content || '').trim()
  if (raw) {
    if (/^#{1,6}\s/m.test(raw)) {
      parts.push(raw)
    } else {
      parts.push('## 文案')
      parts.push('')
      parts.push(raw)
    }
    parts.push('')
  } else {
    parts.push('## 文案')
    parts.push('')
    parts.push('*还没有正文。在右侧填写，或点下方「写剧本」。*')
    parts.push('')
  }

  if (script?.aesthetic?.trim()) {
    parts.push('## 整体氛围')
    parts.push('')
    parts.push(script.aesthetic.trim())
    parts.push('')
  }

  const subjects = p.subjects ?? []
  if (subjects.length) {
    parts.push('## 人物')
    parts.push('')
    for (const s of subjects) {
      parts.push(`### ${s.name}`)
      parts.push('')
      if (s.role) parts.push(`- **角色**　${s.role}`)
      if (s.kind) parts.push(`- **类型**　${s.kind === 'person' ? '人物' : s.kind === 'animal' ? '动物' : '其他'}`)
      if (s.description?.trim()) parts.push(s.description.trim())
      parts.push('')
    }
  }

  const scenes = p.scenes ?? []
  if (scenes.length) {
    parts.push('## 场景')
    parts.push('')
    for (const s of scenes) {
      parts.push(`### ${s.name}`)
      parts.push('')
      if (s.lighting?.trim()) parts.push(`- **光线**　${s.lighting.trim()}`)
      if (s.mainAnchor?.trim()) parts.push(`- **主锚**　${s.mainAnchor.trim()}`)
      if (s.description?.trim()) parts.push(s.description.trim())
      parts.push('')
    }
  }

  if (p.shots.length) {
    parts.push('## 分镜')
    parts.push('')
    for (const shot of p.shots) {
      parts.push(`### 第 ${shot.index + 1} 镜　${shot.title}`)
      parts.push('')
      const meta: string[] = []
      if (shot.shotSize) meta.push(`景别：${shot.shotSize}`)
      meta.push(`运镜：${CAM[shot.cameraMovement] || shot.cameraMovement}`)
      meta.push(`${shot.duration} 秒`)
      parts.push(`- ${meta.join('　')}`)
      if (shot.purpose?.trim()) parts.push(`- **戏剧功能**　${shot.purpose.trim()}`)
      if (shot.voiceover?.trim()) {
        parts.push('')
        parts.push(`**口播**　${shot.voiceover.trim()}`)
      }
      if (shot.visualPrompt?.trim()) {
        parts.push('')
        parts.push(shot.visualPrompt.trim())
      }
      parts.push('')
      parts.push('---')
      parts.push('')
    }
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

function splitH2(md: string): { title: string; body: string }[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const sections: { title: string; body: string }[] = []
  let cur: { title: string; body: string[] } | null = null
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)\s*$/)
    if (m) {
      if (cur) sections.push({ title: cur.title, body: cur.body.join('\n').trim() })
      cur = { title: m[1].trim(), body: [] }
      continue
    }
    if (!cur) {
      // 正文在第一个 ## 之前：忽略（标题已在 # 处理）
      continue
    }
    cur.body.push(line)
  }
  if (cur) sections.push({ title: cur.title, body: cur.body.join('\n').trim() })
  return sections
}

function splitH3(body: string): { name: string; body: string }[] {
  const lines = body.split('\n')
  const out: { name: string; body: string[] }[] = []
  let cur: { name: string; body: string[] } | null = null
  for (const line of lines) {
    const m = line.match(/^###\s+(.+)\s*$/)
    if (m) {
      if (cur) out.push(cur)
      cur = { name: m[1].trim(), body: [] }
      continue
    }
    if (cur) cur.body.push(line)
  }
  if (cur) out.push(cur)
  return out.map((x) => ({ name: x.name, body: x.body.join('\n').trim() }))
}

function fieldLine(body: string, label: string): string | undefined {
  const re = new RegExp(`^-\\s*\\*\\*${label}\\*\\*[\\s　]+(.+)$`, 'm')
  const m = body.match(re)
  return m?.[1]?.trim() || undefined
}

function stripFieldLines(body: string, labels: string[]): string {
  let s = body
  for (const label of labels) {
    s = s.replace(new RegExp(`^-\\s*\\*\\*${label}\\*\\*[\\s　]+.+$`, 'gm'), '')
  }
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

function parseKind(raw?: string): Subject['kind'] | undefined {
  if (!raw) return undefined
  if (/动物/.test(raw)) return 'animal'
  if (/其他|物体|产品/.test(raw)) return 'other'
  if (/人物|人/.test(raw)) return 'person'
  return undefined
}

function parseShotBlock(
  name: string,
  body: string,
  fallback: Shot | undefined,
  index: number
): Shot {
  const titleMatch = name.match(/^第\s*(\d+)\s*镜\s*[　\s]*(.*)$/)
  const idx = titleMatch ? Math.max(0, Number(titleMatch[1]) - 1) : index
  const title = (titleMatch?.[2] || name || fallback?.title || `镜头 ${idx + 1}`).trim()

  let shotSize = fallback?.shotSize
  let cameraMovement = fallback?.cameraMovement ?? ('static' as Shot['cameraMovement'])
  let duration = fallback?.duration ?? 5
  let purpose = fallback?.purpose
  let voiceover = fallback?.voiceover ?? ''
  let visualPrompt = fallback?.visualPrompt ?? ''

  const metaLine = body.match(/^-?\s*(?:景别：([^\s　]+)[　\s]*)?运镜：([^\s　]+)[　\s]*([\d.]+)\s*秒/m)
  if (metaLine) {
    if (metaLine[1]) shotSize = metaLine[1].trim()
    const cam = CAM_REV[metaLine[2].trim()]
    if (cam) cameraMovement = cam
    const d = Number(metaLine[3])
    if (Number.isFinite(d) && d > 0) duration = Math.min(30, Math.max(0.5, d))
  } else {
    // 宽松：`- 景别：中景　运镜：推　6 秒`
    const sizeM = body.match(/景别：([^\s　]+)/)
    const camM = body.match(/运镜：([^\s　]+)/)
    const durM = body.match(/([\d.]+)\s*秒/)
    if (sizeM) shotSize = sizeM[1].trim()
    if (camM && CAM_REV[camM[1].trim()]) cameraMovement = CAM_REV[camM[1].trim()]
    if (durM) {
      const d = Number(durM[1])
      if (Number.isFinite(d) && d > 0) duration = Math.min(30, Math.max(0.5, d))
    }
  }

  const purposeM = body.match(/^-\s*\*\*戏剧功能\*\*[\s　]+(.+)$/m)
  if (purposeM) purpose = purposeM[1].trim()

  const voM = body.match(/\*\*口播\*\*[\s　]+(.+)/)
  if (voM) voiceover = voM[1].trim()

  // 画面描述：去掉元信息行后的剩余正文
  let rest = body
    .replace(/^-?\s*(?:景别：.+)?运镜：.+秒.*$/gm, '')
    .replace(/^\-\s*\*\*戏剧功能\*\*.+$/gm, '')
    .replace(/\*\*口播\*\*[\\s　]+.+/g, '')
    .replace(/^---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // 去掉开头的空列表残留
  rest = rest.replace(/^-\s*$/gm, '').trim()
  if (rest) visualPrompt = rest

  const base: Shot =
    fallback ??
    ({
      id: `shot_${Date.now().toString(36)}_${idx}`,
      index: idx,
      title,
      visualPrompt: '',
      audioDescription: '',
      voiceover: '',
      duration: 5,
      cameraMovement: 'static',
      status: 'draft'
    } as Shot)

  return {
    ...base,
    index: idx,
    title,
    shotSize,
    cameraMovement,
    duration,
    purpose,
    voiceover,
    visualPrompt: visualPrompt || base.visualPrompt
  }
}

/**
 * 把用户编辑后的完整剧本 Markdown 写回项目字段。
 * 返回是否需要重新验收（内容相对已确认剧本有改动时由调用方置 playApproved=false）。
 */
export function applyProjectPlayMarkdown(p: Project, markdown: string): void {
  const md = markdown.replace(/\r\n/g, '\n').trim()
  if (!md) return

  const titleM = md.match(/^#\s+(.+)\s*$/m)
  const topic = titleM?.[1]?.trim() || p.script?.topic || p.name

  const sections = splitH2(md)
  const byTitle = (name: string) =>
    sections.find((s) => s.title === name || s.title.startsWith(name))

  const docSection = byTitle('文案')
  // 若正文自带 ##，compose 时可能不包「文案」——此时取第一个非氛围/人物/场景/分镜段
  let content = docSection?.body ?? ''
  if (!content) {
    const skip = new Set(['整体氛围', '人物', '场景', '分镜'])
    const first = sections.find((s) => !skip.has(s.title) && !s.title.startsWith('整体'))
    if (first) content = `## ${first.title}\n\n${first.body}`.trim()
  }
  if (content.includes('*还没有正文')) content = (p.script?.content || '').trim()

  const aesthetic = byTitle('整体氛围')?.body?.trim() || p.script?.aesthetic

  if (p.script) {
    p.script = {
      ...p.script,
      topic,
      content: content || p.script.content,
      aesthetic: aesthetic || p.script.aesthetic
    }
  }
  if (topic) p.name = topic.slice(0, 48)

  const peopleSec = byTitle('人物')
  if (peopleSec && (p.subjects?.length || peopleSec.body)) {
    const blocks = splitH3(peopleSec.body)
    const next: Subject[] = [...(p.subjects ?? [])]
    blocks.forEach((b, i) => {
      const role = fieldLine(b.body, '角色')
      const kind = parseKind(fieldLine(b.body, '类型'))
      const description = stripFieldLines(b.body, ['角色', '类型'])
      const existing = next.find((x) => x.name === b.name) || next[i]
      if (existing) {
        const idx = next.findIndex((x) => x.id === existing.id)
        next[idx] = {
          ...existing,
          name: b.name,
          role: role ?? existing.role,
          kind: kind ?? existing.kind,
          description: description || existing.description
        }
      } else {
        next.push({
          id: `sub_${Date.now().toString(36)}_${i}`,
          name: b.name,
          kind: kind ?? 'person',
          description: description || '',
          role
        })
      }
    })
    p.subjects = next
  }

  const sceneSec = byTitle('场景')
  if (sceneSec && (p.scenes?.length || sceneSec.body)) {
    const blocks = splitH3(sceneSec.body)
    const next: Scene[] = [...(p.scenes ?? [])]
    blocks.forEach((b, i) => {
      const lighting = fieldLine(b.body, '光线')
      const mainAnchor = fieldLine(b.body, '主锚')
      const description = stripFieldLines(b.body, ['光线', '主锚'])
      const existing = next.find((x) => x.name === b.name) || next[i]
      if (existing) {
        const idx = next.findIndex((x) => x.id === existing.id)
        next[idx] = {
          ...existing,
          name: b.name,
          lighting: lighting ?? existing.lighting,
          mainAnchor: mainAnchor ?? existing.mainAnchor,
          description: description || existing.description
        }
      } else {
        next.push({
          id: `scn_${Date.now().toString(36)}_${i}`,
          name: b.name,
          description: description || '',
          lighting,
          mainAnchor
        })
      }
    })
    p.scenes = next
  }

  const shotSec = byTitle('分镜')
  if (shotSec?.body) {
    const blocks = splitH3(shotSec.body)
    if (blocks.length) {
      const next = blocks.map((b, i) => {
        const titleMatch = b.name.match(/^第\s*(\d+)\s*镜/)
        const idx = titleMatch ? Math.max(0, Number(titleMatch[1]) - 1) : i
        const fallback = p.shots.find((s) => s.index === idx) || p.shots[i]
        return parseShotBlock(b.name, b.body, fallback, idx)
      })
      // 按 index 排序并重排
      next.sort((a, b) => a.index - b.index)
      next.forEach((s, i) => {
        s.index = i
      })
      p.shots = next
    }
  }
}

function cleanMarkdownTitle(value: string): string {
  return value
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 清理外部 Markdown 的 BOM 和换行，便于安全导入。 */
export function normalizeImportedMarkdown(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

/** 把外部 .md 收成可写入 script 的字段。 */
export function importedPlayFields(markdown: string, filename = '') {
  const content = normalizeImportedMarkdown(markdown)
  if (!content) throw new Error('剧本文件是空的')
  return {
    content,
    topic: inferMarkdownTitle(content, filename),
    playReady: true as const
  }
}

export function scriptFromImportedPlay(p: Project, markdown: string, filename = ''): Script {
  const fields = importedPlayFields(markdown, filename)
  const prev = p.script
  return {
    id: prev?.id ?? `s_${Date.now().toString(36)}`,
    keywords: prev?.keywords ?? [],
    style: prev?.style ?? 'cinematic',
    aspectRatio: prev?.aspectRatio ?? p.settings?.aspectRatio ?? '16:9',
    shotDuration: prev?.shotDuration ?? p.settings?.defaultShotDuration ?? 5,
    createdAt: prev?.createdAt ?? Date.now(),
    ...(prev ?? {}),
    ...fields
  }
}

/** 优先从一级标题推断剧本名，否则使用导入文件名。 */
export function inferMarkdownTitle(markdown: string, filename = ''): string {
  const normalized = normalizeImportedMarkdown(markdown)
  const heading = normalized.match(/^\s*#\s+(.+?)\s*$/m)?.[1]
  if (heading) return cleanMarkdownTitle(heading).slice(0, 80)
  const baseName = filename.replace(/\.(?:md|markdown|txt)$/i, '')
  return cleanMarkdownTitle(baseName).slice(0, 80) || '未命名剧本'
}

/** 导出单份剧本 Markdown；正文已有一级标题时不重复添加。 */
export function buildScriptMarkdown(topic: string, content: string): string {
  const normalized = normalizeImportedMarkdown(content)
  if (/^\s*#\s+/m.test(normalized)) return `${normalized}\n`
  const title = cleanMarkdownTitle(topic) || '未命名剧本'
  return `# ${title}\n\n${normalized}\n`
}

export function scriptExportFilename(topic: string): string {
  const title = cleanMarkdownTitle(topic) || '未命名剧本'
  return `${title.slice(0, 60)}.md`
}

/** 能拍的章节剧本：有背景、人物锁、环境，而不是短视频「口播/画面/时长」四格表。 */
export function looksLikeFilmChapterPlay(markdown: string): boolean {
  const t = markdown || ''
  return (
    /改编原则|拍摄原则/.test(t) ||
    /##\s*故事背景/.test(t) ||
    /##\s*环境与场景/.test(t) ||
    /##\s*场景[一二三四五六七八九十0-9]/.test(t) ||
    /(?:内景|外景)\s*｜/.test(t) ||
    /成年[^\n]{0,16}旁白/.test(t) ||
    /视觉与声音基调/.test(t)
  )
}

const PLAY_DIRECTIVE_HEADINGS = [
  '故事背景',
  '本章承接',
  '人物',
  '环境与场景',
  '拍摄原则',
  '改编原则',
  '本章情绪线',
  '视觉与声音基调'
]

/** 章节级约束：背景、人设、环境、不拍什么。拆镜和出片都要带着。 */
export function extractPlayDirectives(markdown: string, maxChars = 3600): string {
  const sections = splitH2(markdown || '')
  const chunks: string[] = []
  const meta = (markdown || '').match(/^>\s*.+(?:\n>\s*.+)*/m)
  if (meta) chunks.push(meta[0])
  for (const key of PLAY_DIRECTIVE_HEADINGS) {
    const hit = sections.find((s) => s.title === key || s.title.startsWith(key))
    if (hit?.body?.trim()) {
      const body = key === '人物' || key === '环境与场景' ? hit.body.trim().slice(0, 1200) : hit.body.trim()
      chunks.push(`## ${hit.title}\n${body}`)
    }
  }
  return chunks.join('\n\n').slice(0, maxChars)
}

export interface PlayLocationDraft {
  name: string
  description: string
  lighting?: string
  mainAnchor?: string
  anchors?: string
  props?: string
}

function normLocationKey(name: string): string {
  return name.replace(/\s+/g, '').replace(/[，,。．.、]/g, '').toLowerCase()
}

function locationShortName(raw: string): string {
  return raw
    .replace(/^场景[^\｜|]*/, '')
    .replace(/^[｜|]\s*/, '')
    .split(/[，,]/)[0]
    .trim()
}

function guessLocationAnchor(name: string, description: string): string {
  const blob = `${name} ${description}`
  const hit = blob.match(
    /破瓦|门缝|墙角|折叠桌|搪瓷盆|铁皮棚|卷帘门|街机|石板路|田埂|仓房|饭堂|修车铺|游戏厅|宿舍|公园|公厕/
  )
  return hit?.[0] || `${name}主锚`
}

/** 不靠模型：从环境设定和「内景｜地点」场记抽出地点，提炼失败时兜底。 */
export function extractLocationsFromPlay(markdown: string): PlayLocationDraft[] {
  const sections = splitH2(markdown || '')
  const out: PlayLocationDraft[] = []
  const seen = new Set<string>()

  const add = (rawName: string, description: string, lighting?: string) => {
    const name = locationShortName(rawName) || rawName.trim()
    const key = normLocationKey(name)
    if (!name || key.length < 2 || seen.has(key)) return
    if (/^场景[一二三四五六七八九十百0-9]+$/.test(name)) return
    seen.add(key)
    const desc = (description || `${name}。无人时的空间、地面、建筑和光线按剧本。`).replace(/\s+/g, ' ').trim()
    const mainAnchor = guessLocationAnchor(name, desc)
    out.push({
      name,
      description: desc.slice(0, 480),
      lighting: lighting?.trim() || undefined,
      mainAnchor,
      anchors: `全景；${mainAnchor}；地面站位区；光源`,
      props: '无'
    })
  }

  const bible = sections.find(
    (s) => s.title === '环境与场景' || s.title === '场景' || s.title.startsWith('环境')
  )
  if (bible) {
    for (const block of splitH3(bible.body)) add(block.name, block.body)
  }

  for (const sec of sections.filter((s) => /^场景[一二三四五六七八九十百0-9]/.test(s.title))) {
    const heading = sec.body.match(/(?:内景|外景|半外景)\s*｜\s*([^｜\n*]+)\s*｜\s*([^\n*]+)/)
    const loc = heading?.[1]?.trim()
    const weather = heading?.[2]?.trim()
    add(loc || sec.title, sec.body.slice(0, 600), weather)
  }

  return out
}

const SKIP_SUBJECT = /旁白|画外|镜头|蒙太奇|改编|类型|本章|视觉|声音/

/** 不靠模型：从「## 人物」和对白名抽出角色。 */
export function extractSubjectsFromPlay(markdown: string): Array<{
  name: string
  kind: 'person' | 'animal' | 'other'
  description: string
  role: string
  stateVariants: string
  fromReference: boolean
}> {
  const sections = splitH2(markdown || '')
  const out: Array<{
    name: string
    kind: 'person' | 'animal' | 'other'
    description: string
    role: string
    stateVariants: string
    fromReference: boolean
  }> = []
  const seen = new Set<string>()

  const add = (raw: string, description = '', role = '') => {
    const name = raw.replace(/（[^）]+）|\([^)]+\)/g, '').replace(/旁白$/, '').trim()
    if (!name || name.length > 16 || SKIP_SUBJECT.test(name)) return
    const key = name.replace(/\s+/g, '').toLowerCase()
    const ident = description.match(/身份[：:]\s*([^\n]+)/)
    const state = description.match(/跨场状态[变化]*[：:]\s*([^\n]+)/)
    const roleText = (ident?.[1] || role).trim()
    const stateText = (state?.[1] || '').trim()
    if (seen.has(key)) {
      const row = out.find((item) => item.name.replace(/\s+/g, '').toLowerCase() === key)
      if (row && description && description.length > row.description.length) {
        row.description = description.slice(0, 1200)
        if (roleText) row.role = roleText.slice(0, 200)
        if (stateText) row.stateVariants = stateText.slice(0, 240)
      }
      return
    }
    seen.add(key)
    out.push({
      name,
      kind: 'person',
      description: (description || `${name}，外貌与服装按剧本补全`).slice(0, 1200),
      role: roleText.slice(0, 200),
      stateVariants: stateText || '单一状态',
      fromReference: false
    })
  }

  const people = sections.find((s) => s.title === '人物' || s.title.startsWith('人物'))
  if (people) {
    for (const block of splitH3(people.body)) add(block.name, block.body)
  }
  for (const m of markdown.matchAll(/\*\*([^*：:\n]{1,16})：\*\*/g)) add(m[1])
  for (const m of markdown.matchAll(/\*\*([^*：:\n]{1,16})\*\*[：:]/g)) add(m[1])
  return out
}

/** 给场景提炼模型的精简正文，避免整章剧本把 JSON 挤爆。 */
export function extractPlayForSceneStage(markdown: string, maxChars = 8000): string {
  const sections = splitH2(markdown || '')
  const chunks: string[] = []
  const meta = (markdown || '').match(/^>\s*.+(?:\n>\s*.+)*/m)
  if (meta) chunks.push(meta[0])
  for (const key of ['故事背景', '环境与场景', '视觉与声音基调', '拍摄原则', '改编原则']) {
    const hit = sections.find((s) => s.title === key || s.title.startsWith(key))
    if (hit?.body?.trim()) chunks.push(`## ${hit.title}\n${hit.body.trim()}`)
  }
  for (const sec of sections.filter((s) => /^场景[一二三四五六七八九十百0-9]/.test(s.title))) {
    const head = sec.body.match(/(?:内景|外景|半外景)[^\n]{0,80}/)?.[0] || ''
    const preview = sec.body.split('\n').filter((l) => l.trim()).slice(0, 6).join('\n')
    chunks.push(`## ${sec.title}\n${head}\n${preview}`)
  }
  const text = chunks.join('\n\n').trim()
  return (text || markdown).slice(0, maxChars)
}

/** 取出本镜对应的那场戏原文，避免扩镜时只看见 2 句场记。 */
export function extractSceneSlice(markdown: string, sceneName?: string, maxChars = 4200): string {
  const sections = splitH2(markdown || '')
  const sceneSecs = sections.filter((s) => /^场景/.test(s.title))
  const name = (sceneName || '').trim()
  if (name) {
    const restOfTitle = (title: string) => title.replace(/^场景[^\｜|]*/, '').replace(/^[｜|]\s*/, '').trim()
    const hit =
      sceneSecs.find((s) => s.title.includes(name) || name.includes(restOfTitle(s.title))) ||
      sceneSecs.find((s) => s.body.includes(name)) ||
      sections.find((s) => s.title.includes(name) || s.body.includes(name))
    if (hit) return `## ${hit.title}\n\n${hit.body}`.slice(0, maxChars)
  }
  if (sceneSecs.length === 1) return `## ${sceneSecs[0].title}\n\n${sceneSecs[0].body}`.slice(0, maxChars)
  return ''
}
