/**
 * 智能体本地记忆系统。
 *
 * 两层范围：
 * - global ：跨项目共享（用户偏好、习惯、长期事实）
 * - project：跟随当前项目 id（这个项目里的约定、剧情备注）
 *
 * 持久化：
 * - 桌面端：SQLite KV（<存储根>/app.db 的 kv 表），随存储根迁移
 * - 浏览器端：localStorage 兜底
 *
 * 所有读写都走异步函数，UI 与 agent 共用同一份数据。
 */
import { desktop, isDesktop } from '@/services/desktop'
import { useProjectStore } from '@/stores'

export type MemoryKind = 'preference' | 'fact' | 'note'
export type MemoryScope = 'global' | 'project'

export interface AgentMemoryEntry {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  content: string
  pinned?: boolean
  createdAt: number
  updatedAt: number
}

const GLOBAL_KEY = 'agent-memory:v1:global'
const PROJECT_KEY_PREFIX = 'agent-memory:v1:project:'
const MAX_PER_KEY = 60
const MAX_CONTENT_LEN = 240
/** 注入 prompt 时每个范围最多带多少条 */
const PROMPT_LIMIT_PER_SCOPE = 20

function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function projectKey(projectId: string) {
  return `${PROJECT_KEY_PREFIX}${projectId}`
}

function currentProjectId(): string | null {
  return useProjectStore().current?.id ?? null
}

async function kvRead(key: string): Promise<string | null> {
  try {
    if (isDesktop()) return await desktop().kvGet(key)
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

async function kvWrite(key: string, value: string): Promise<void> {
  try {
    if (isDesktop()) {
      await desktop().kvSet(key, value)
      return
    }
    window.localStorage.setItem(key, value)
  } catch {
    /* 存储失败不阻断对话 */
  }
}

async function readEntries(key: string): Promise<AgentMemoryEntry[]> {
  const raw = await kvRead(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is AgentMemoryEntry =>
        item && typeof item.content === 'string' && typeof item.id === 'string'
    )
  } catch {
    return []
  }
}

async function writeEntries(key: string, entries: AgentMemoryEntry[]): Promise<void> {
  await kvWrite(key, JSON.stringify(entries.slice(-MAX_PER_KEY)))
}

function keyForScope(scope: MemoryScope, projectId: string | null): string | null {
  if (scope === 'global') return GLOBAL_KEY
  return projectId ? projectKey(projectId) : null
}

/** 列出记忆。不传 scope 时返回 全局 + 当前项目 的合并列表（置顶优先、新的在前）。 */
export async function listMemories(scope?: MemoryScope): Promise<AgentMemoryEntry[]> {
  const pid = currentProjectId()
  const scopes: MemoryScope[] = scope ? [scope] : ['global', 'project']
  const all: AgentMemoryEntry[] = []
  for (const s of scopes) {
    const key = keyForScope(s, pid)
    if (!key) continue
    all.push(...(await readEntries(key)))
  }
  return all.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt)
}

function normalize(text: string) {
  return text.replace(/\s+/g, '').toLowerCase()
}

export async function rememberMemory(
  content: string,
  opts: { kind?: MemoryKind; scope?: MemoryScope; pinned?: boolean } = {}
): Promise<AgentMemoryEntry | null> {
  const text = content.trim().slice(0, MAX_CONTENT_LEN)
  if (!text) return null
  const scope = opts.scope ?? 'global'
  const key = keyForScope(scope, currentProjectId())
  if (!key) return null
  const entries = await readEntries(key)
  const dup = entries.find((item) => normalize(item.content) === normalize(text))
  if (dup) {
    dup.updatedAt = Date.now()
    if (opts.kind) dup.kind = opts.kind
    if (opts.pinned !== undefined) dup.pinned = opts.pinned
    await writeEntries(key, entries)
    return dup
  }
  const entry: AgentMemoryEntry = {
    id: newId(),
    scope,
    kind: opts.kind ?? 'fact',
    content: text,
    pinned: opts.pinned,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  entries.push(entry)
  await writeEntries(key, entries)
  return entry
}

/** 按 id 精确删除，或按关键词删除第一条匹配的记忆。返回删除的内容。 */
export async function forgetMemory(idOrKeyword: string, scope?: MemoryScope): Promise<string | null> {
  const pid = currentProjectId()
  const scopes: MemoryScope[] = scope ? [scope] : ['global', 'project']
  const needle = normalize(idOrKeyword)
  for (const s of scopes) {
    const key = keyForScope(s, pid)
    if (!key) continue
    const entries = await readEntries(key)
    const idx = entries.findIndex(
      (item) => item.id === idOrKeyword || normalize(item.content).includes(needle)
    )
    if (idx >= 0) {
      const [removed] = entries.splice(idx, 1)
      await writeEntries(key, entries)
      return removed.content
    }
  }
  return null
}

export async function clearMemories(scope: MemoryScope): Promise<void> {
  const key = keyForScope(scope, currentProjectId())
  if (key) await writeEntries(key, [])
}

export async function togglePinMemory(id: string): Promise<void> {
  const pid = currentProjectId()
  for (const s of ['global', 'project'] as MemoryScope[]) {
    const key = keyForScope(s, pid)
    if (!key) continue
    const entries = await readEntries(key)
    const hit = entries.find((item) => item.id === id)
    if (hit) {
      hit.pinned = !hit.pinned
      hit.updatedAt = Date.now()
      await writeEntries(key, entries)
      return
    }
  }
}

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  note: '笔记'
}

/** 组装注入 LLM 上下文的记忆文本。没有记忆时返回空串。 */
export async function memoryContextPrompt(): Promise<string> {
  const entries = await listMemories()
  if (!entries.length) return ''
  const global = entries.filter((e) => e.scope === 'global').slice(0, PROMPT_LIMIT_PER_SCOPE)
  const proj = entries.filter((e) => e.scope === 'project').slice(0, PROMPT_LIMIT_PER_SCOPE)
  const fmt = (list: AgentMemoryEntry[]) =>
    list.map((e) => `- [${KIND_LABEL[e.kind]}] ${e.content}`).join('\n')
  const parts: string[] = []
  if (global.length) parts.push(`【用户长期记忆】\n${fmt(global)}`)
  if (proj.length) parts.push(`【本项目记忆】\n${fmt(proj)}`)
  return parts.join('\n\n')
}

/**
 * 解析「记住… / 以后都… / 我喜欢…」这类显式记忆请求。
 * 返回要记忆的内容与推断类型；不像记忆请求时返回 null。
 */
export function parseRememberRequest(
  text: string
): { content: string; kind: MemoryKind; scope: MemoryScope } | null {
  const t = text.trim()
  let m = t.match(/^(?:帮我|请|你)?记(?:住|一下|下来)[：:，,]?\s*(.+)$/)
  if (!m) m = t.match(/^(?:以后|今后)(?:都|要)?(.+)$/)
  if (!m) return null
  let content = m[1].trim().replace(/[。！!]+$/, '')
  if (content.length < 2) return null
  let scope: MemoryScope = 'global'
  if (/^(?:在|对)?(?:这个|本|当前)项目[里中内]?[，,：:]/.test(content)) {
    scope = 'project'
    content = content.replace(/^(?:在|对)?(?:这个|本|当前)项目[里中内]?[，,：:]?\s*/, '')
  }
  const kind: MemoryKind = /喜欢|偏好|习惯|不要|别|总是|一律|默认/.test(content)
    ? 'preference'
    : 'fact'
  return { content, kind, scope }
}

/** 解析「忘掉 / 别记了 / 删除记忆」请求，返回关键词。 */
export function parseForgetRequest(text: string): string | null {
  const m = text
    .trim()
    .match(/^(?:帮我|请)?(?:忘掉|忘记|别记(?:住|了)|删除(?:这条|那条)?记忆)[：:，,]?\s*(.*)$/)
  if (!m) return null
  return m[1].trim().replace(/[。！!]+$/, '')
}
