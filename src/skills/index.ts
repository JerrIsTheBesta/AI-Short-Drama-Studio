/**
 * 画布智能体 Skill：按用户意图只加载相关 playbook。
 * 正文是我们自己写的现场手册，不是外站提示词。
 */

import characterRaw from './character-consistency.md?raw'
import pipelineRaw from './pipeline-batch.md?raw'
import qaRaw from './qa-verify.md?raw'
import shotImageRaw from './shot-image.md?raw'
import storyboardPanelRaw from './storyboard-panel.md?raw'
import shotVideoRaw from './shot-video.md?raw'
import storyboardRaw from './storyboard-director.md?raw'
import h3PromptRaw from './h3-prompt-writing.md?raw'
import filmChapterRaw from './film-chapter-production.md?raw'

export interface Skill {
  id: string
  name: string
  description: string
  triggers: string[]
  body: string
}

export interface SkillSelectContext {
  userText: string
  pipelineMode?: string
  workflowMode?: string
  hasShots: boolean
  missingSheets: boolean
  missingPlates: boolean
  missingImages: boolean
  missingVideos: boolean
}

interface Frontmatter {
  name: string
  description: string
  triggers: string[]
}

function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) {
    return {
      meta: { name: 'unknown', description: '', triggers: [] },
      body: raw.trim()
    }
  }
  const yaml = match[1]
  const pick = (key: string) => {
    const line = yaml.split(/\r?\n/).find((l) => l.startsWith(`${key}:`))
    return line ? line.slice(key.length + 1).trim() : ''
  }
  const triggers = pick('triggers')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    meta: {
      name: pick('name') || 'unknown',
      description: pick('description'),
      triggers
    },
    body: match[2].trim()
  }
}

function toSkill(raw: string): Skill {
  const { meta, body } = parseFrontmatter(raw)
  return {
    id: meta.name,
    name: meta.name,
    description: meta.description,
    triggers: meta.triggers,
    body
  }
}

export const ALL_SKILLS: Skill[] = [
  toSkill(filmChapterRaw),
  toSkill(pipelineRaw),
  toSkill(storyboardRaw),
  toSkill(characterRaw),
  toSkill(storyboardPanelRaw),
  toSkill(shotImageRaw),
  toSkill(shotVideoRaw),
  toSkill(h3PromptRaw),
  toSkill(qaRaw)
]

const BY_ID = new Map(ALL_SKILLS.map((s) => [s.id, s]))

export function getSkill(id: string): Skill | undefined {
  return BY_ID.get(id)
}

export function getSkillBody(id: string): string {
  return BY_ID.get(id)?.body ?? ''
}

function triggeredByText(skill: Skill, text: string): boolean {
  return skill.triggers.some((t) => t && text.includes(t))
}

/**
 * 按意图挑选要塞进上下文的 Skill。
 * 目录始终可见；正文只加载本轮匹配到的手册。
 */
export function selectSkills(ctx: SkillSelectContext): Skill[] {
  const text = ctx.userText
  const filmChapter = ctx.pipelineMode !== 'remake' && ctx.workflowMode === 'film-chapter'
  const picked = new Map<string, Skill>()
  const add = (id: string) => {
    const s = BY_ID.get(id)
    if (s) picked.set(s.id, s)
  }

  for (const skill of ALL_SKILLS) {
    if (skill.id === 'film-chapter-production' && ctx.pipelineMode === 'remake') continue
    if (triggeredByText(skill, text)) add(skill.id)
  }

  if (filmChapter) add('film-chapter-production')

  if (/拆分镜|拆镜|故事板|出分镜|生成分镜|续写|接着写/.test(text)) {
    add('storyboard-director')
  }
  if (
    /人设|角色|场景图|底板|出场景/.test(text)
  ) {
    add('character-consistency')
  }
  if (!filmChapter && /故事看板|看板图|线稿/.test(text)) {
    add('storyboard-panel')
    add('character-consistency')
  }
  if (/配图|出图|关键帧|画面|第.+镜/.test(text)) {
    add('shot-image')
    if (!filmChapter) add('storyboard-panel')
    add('character-consistency')
  }
  if (/视频|图生视频|运镜|Comfy|H3|配音/.test(text)) {
    add('shot-video')
    add('h3-prompt-writing')
  }
  if (/检查|验收|漏|齐了没|质检/.test(text)) {
    add('qa-verify')
  }
  if (/全部做完|全部生成|都生成|全做|一口气|整条流水线|从头到尾|缺的都补|全流程/.test(text)) {
    if (!filmChapter) add('pipeline-batch')
    if (!ctx.hasShots) add('storyboard-director')
    add('character-consistency')
    if (!filmChapter) add('storyboard-panel')
    add('shot-image')
    add('shot-video')
    add('h3-prompt-writing')
    add('qa-verify')
  }

  const order = ALL_SKILLS.map((s) => s.id)
  const list = [...picked.values()].sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id)
  )
  return list.slice(0, 7)
}

export function catalogPrompt(): string {
  return ALL_SKILLS.map((s) => `- ${s.id}：${s.description}`).join('\n')
}

export function bodiesPrompt(skills: Skill[]): string {
  if (!skills.length) return ''
  return skills.map((s) => `### Skill: ${s.id}\n${s.body}`).join('\n\n')
}

export function skillContextForAgent(ctx: SkillSelectContext): {
  selected: Skill[]
  prompt: string
} {
  const selected = selectSkills(ctx)
  const prompt = `【可调用 Skill 目录】
${catalogPrompt()}

【本轮已加载】${selected.map((s) => s.id).join('、')}
按已加载手册做事，不要发明目录里没有的流程。

${bodiesPrompt(selected)}`
  return { selected, prompt }
}
