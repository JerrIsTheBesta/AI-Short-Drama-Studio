import { getSkillBody } from '@/skills'
import {
  CUSTOM_STORY_SKILL_ID,
  GENERAL_STORY_SKILL_ID,
  storySkillById
} from '@/skills/storyStyles'
import { useSettingsStore, type DirectorSkillDoc } from '@/stores/settings'
import { desktop, isDesktop } from '@/services/desktop'

const MAX_BODY = 24_000

/** 从 SKILL.md 前言或 README 标题里取出手册名和正文。没有前言时整篇 markdown 都是正文。 */
export function parseDirectorSkill(text: string, filename = ''): DirectorSkillDoc {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!raw || raw.length < 20) throw new Error('这份手册太短，至少要有一段写法说明')
  if (/<html[\s>]/i.test(raw.slice(0, 400))) throw new Error('请导入 Markdown 或 README，不是网页')

  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  const yaml = fm?.[1] || ''
  const rest = (fm?.[2] || raw).trim()
  const pick = (key: string) => {
    const line = yaml.split(/\r?\n/).find((item) => item.startsWith(`${key}:`))
    return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') : ''
  }
  const heading = rest.match(/^#\s+(.+)$/m)?.[1]?.trim() || ''
  const fileTitle = filename.replace(/\.[^.]+$/, '').replace(/^(readme|skill)$/i, '').trim()
  const name = (pick('name') || (heading && !/^readme$/i.test(heading) ? heading : '') || fileTitle || '导演手册').slice(0, 80)
  const body = rest.slice(0, MAX_BODY)
  if (body.length < 20) throw new Error('这份手册正文是空的')
  return {
    name,
    filename: filename.slice(0, 180),
    body,
    importedAt: Date.now()
  }
}

export function currentDirectorSkill(): DirectorSkillDoc | null {
  try {
    return useSettingsStore().config.directorSkill || null
  } catch {
    return null
  }
}

function manualText(skill: DirectorSkillDoc): string {
  return `【用户导入的导演手册：${skill.name}】
拆分镜头、写画面提示词和视频提示词时，按这份手册的写法来。
系统硬约束仍然有效：成片时长窗口、单镜时长上限、对白逐字保留、必须能落库的字段。手册和这些冲突时，硬约束优先，镜头怎么拆、提示词怎么写以手册为准。

${skill.body}`
}

/** 当前选中的分镜技能。通用手册不额外加一层。 */
export function activeStorySkillOverlay(): string {
  let id = GENERAL_STORY_SKILL_ID
  try {
    id = useSettingsStore().config.activeStorySkillId || GENERAL_STORY_SKILL_ID
  } catch {
    id = GENERAL_STORY_SKILL_ID
  }
  if (id === CUSTOM_STORY_SKILL_ID) {
    const imported = currentDirectorSkill()
    return imported ? manualText(imported) : ''
  }
  const skill = storySkillById(id)
  if (!skill) return ''
  return `【当前分镜技能：${skill.name}】
拆分镜头、写画面提示词和视频提示词时，在系统硬约束之上按这个技能来。硬约束仍然优先。

${skill.body}`
}

/** 通用分镜导演手册，再加上当前选中的风格或类型。导入的手册选中时整份替换这一层。 */
export function directorPlaybookText(): string {
  const base = getSkillBody('storyboard-director')
  const extra = activeStorySkillOverlay()
  if (!extra) return base
  if (extra.startsWith('【用户导入的导演手册')) return extra
  return `${base}\n\n${extra}`
}

/** 写剧本、拆镜和出提示词时插入当前技能。通用分镜不加这一层。 */
export function importedDirectorPrefix(): string {
  const extra = activeStorySkillOverlay()
  return extra ? `${extra}\n\n` : ''
}

/** 给 H3 英文成片稿用：吸收当前技能的调度写法，输出格式仍是 (S#) 与 <d>。 */
export function importedDirectorForH3(): string {
  const extra = activeStorySkillOverlay()
  if (!extra) return ''
  return `Active story skill (follow its blocking, performance and how a shot is staged). Keep this task's output format: speaker lock, English action, dialogue only inside d tags.\n${extra.slice(0, 8_000)}\n\n`
}

const SKILL_NAMES = ['SKILL.md', 'skill.md', 'README.md', 'readme.md', 'Readme.md']

async function readSkillFile(filePath: string): Promise<{ text: string; filename: string }> {
  const filename = filePath.split(/[\\/]/).pop() || 'SKILL.md'
  return { text: await desktop().readText(filePath), filename }
}

/** 选一个 SKILL.md / README.md，或一个里面放着这两份文件的文件夹。 */
export async function pickDirectorSkillFile(): Promise<{ text: string; filename: string } | null> {
  if (isDesktop()) {
    const paths = await desktop().pickFiles([
      { name: '导演手册', extensions: ['md', 'markdown', 'txt'] }
    ])
    const path = paths[0]
    if (!path) return null
    return readSkillFile(path)
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      resolve({ text: await file.text(), filename: file.name })
    }
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

export async function pickDirectorSkillFolder(): Promise<{ text: string; filename: string } | null> {
  if (!isDesktop()) throw new Error('网页版请直接选择 SKILL.md 或 README.md')
  const dir = await desktop().pickDirectory()
  if (!dir) return null
  for (const name of SKILL_NAMES) {
    const file = await desktop().join(dir, name)
    if (await desktop().exists(file)) return readSkillFile(file)
  }
  throw new Error('这个文件夹里没有 SKILL.md 或 README.md')
}
