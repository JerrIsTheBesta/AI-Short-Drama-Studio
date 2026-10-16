/**
 * 剧本库 store
 *
 * 职责：
 * - 每次 AI 生成 / 导入的剧本，落成一份本地 Markdown 并登记到剧本库
 * - 提供列表、读取正文、改名、增删集数、删除、导出
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ID, Project, ScriptDoc, ScriptSource } from '@/types'
import {
  deleteScriptDoc,
  listScriptDocs,
  loadScriptMarkdown,
  saveScript,
  scriptAbsPath,
  scriptsDirPath
} from '@/services/storage'
import { desktop, isDesktop } from '@/services/desktop'
import { buildScriptMarkdown, inferMarkdownTitle, normalizeImportedMarkdown } from '@/utils/scriptMarkdown'
import {
  parseScriptDoc,
  toEpisodes,
  appendEpisode,
  insertEpisode,
  removeEpisode,
  updateEpisode,
  moveEpisode
} from '@/utils/scriptEpisodes'

function sanitizeFilename(name: string): string {
  return (
    (name || '未命名剧本')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '未命名剧本'
  )
}

function newId(): string {
  return `sd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function statsOf(markdown: string) {
  const parsed = parseScriptDoc(markdown)
  const episodes = toEpisodes(parsed, '')
  return {
    episodeCount: Math.max(1, episodes.length),
    totalWords: episodes.reduce((sum, ep) => sum + ep.wordCount, 0)
  }
}

export const useScriptsStore = defineStore('scripts', () => {
  const docs = ref<ScriptDoc[]>([])
  const loading = ref(false)
  /** 正文缓存：id → markdown */
  const cache = new Map<ID, string>()
  let loadPromise: Promise<void> | null = null

  const byId = computed(() => (id: ID) => docs.value.find((d) => d.id === id))
  const projectDocs = computed(() => (projectId: ID) =>
    docs.value.filter((d) => d.projectId === projectId)
  )

  async function refresh() {
    loading.value = true
    try {
      docs.value = await listScriptDocs()
    } finally {
      loading.value = false
    }
  }

  /** 首次访问时加载一次 */
  function ensureLoaded() {
    if (docs.value.length) return Promise.resolve()
    if (loadPromise) return loadPromise
    loadPromise = refresh().finally(() => {
      loadPromise = null
    })
    return loadPromise
  }

  async function readContent(id: ID, force = false): Promise<string> {
    if (!force && cache.has(id)) return cache.get(id)!
    const text = await loadScriptMarkdown(id)
    cache.set(id, text)
    return text
  }

  async function write(id: ID, markdown: string): Promise<void> {
    const doc = docs.value.find((d) => d.id === id)
    if (!doc) return
    const stats = statsOf(markdown)
    const next: ScriptDoc = {
      ...doc,
      episodeCount: stats.episodeCount,
      totalWords: stats.totalWords,
      updatedAt: Date.now()
    }
    const stored = await saveScript(next, markdown)
    cache.set(id, markdown)
    const idx = docs.value.findIndex((d) => d.id === id)
    if (idx >= 0) docs.value[idx] = stored
    else docs.value.unshift(stored)
  }

  /** 新建一份空剧本 */
  async function create(options: {
    title?: string
    markdown?: string
    projectId?: ID
    source?: ScriptSource
  } = {}): Promise<ScriptDoc> {
    await ensureLoaded()
    const now = Date.now()
    const id = newId()
    const raw = normalizeImportedMarkdown(options.markdown || '')
    const markdown = raw || buildScriptMarkdown(options.title || '未命名剧本', '')
    const title =
      options.title?.trim() ||
      (raw ? inferMarkdownTitle(raw) : '') ||
      '未命名剧本'
    const stats = statsOf(markdown)
    const doc: ScriptDoc = {
      id,
      title,
      filename: `${sanitizeFilename(title)}.md`,
      source: options.source ?? 'manual',
      projectId: options.projectId,
      episodeCount: stats.episodeCount,
      totalWords: stats.totalWords,
      createdAt: now,
      updatedAt: now
    }
    const stored = await saveScript(doc, markdown)
    cache.set(id, markdown)
    docs.value = [stored, ...docs.value.filter((d) => d.id !== id)]
    return stored
  }

  /** 导入一份 Markdown 剧本文件 */
  async function importMarkdown(text: string, filename = '', options: { projectId?: ID } = {}) {
    const raw = normalizeImportedMarkdown(text)
    if (!raw.trim()) throw new Error('剧本文件是空的')
    const title = inferMarkdownTitle(raw, filename)
    return create({ title, markdown: raw, source: 'imported', projectId: options.projectId })
  }

  /**
   * 把项目里的剧本存成一份 Markdown。
   * - 同一次续写（同一项目 + 同一剧本标题）更新原档，不刷屏
   * - 换了题目就另存一份新剧本
   */
  async function saveFromProject(
    project: Project,
    options: { mode?: 'write' | 'continue'; prompt?: string } = {}
  ): Promise<ScriptDoc | undefined> {
    const script = project.script
    if (!script?.content?.trim()) return undefined
    await ensureLoaded()
    const markdown = buildScriptMarkdown(
      script.topic || project.name || '未命名剧本',
      script.content
    )
    const title = (script.topic || project.name || '未命名剧本').trim()
    const existing = docs.value.find(
      (d) =>
        d.projectId === project.id &&
        (d.scriptId === script.id || (d.title === title && d.source === 'ai-generated'))
    )
    const shouldUpdate =
      Boolean(existing) &&
      (options.mode === 'continue' ||
        existing!.title === title ||
        existing!.scriptId === script.id)
    if (existing && shouldUpdate) {
      const next: ScriptDoc = {
        ...existing,
        title,
        filename: `${sanitizeFilename(title)}.md`,
        scriptId: script.id,
        prompt: options.prompt ?? existing.prompt,
        ...statsOf(markdown),
        updatedAt: Date.now()
      }
      const stored = await saveScript(next, markdown)
      cache.set(existing.id, markdown)
      const idx = docs.value.findIndex((d) => d.id === existing.id)
      if (idx >= 0) docs.value[idx] = stored
      return stored
    }
    const doc = await create({
      title,
      markdown,
      projectId: project.id,
      source: 'ai-generated'
    })
    const patch: ScriptDoc = {
      ...doc,
      scriptId: script.id,
      prompt: options.prompt ?? doc.prompt
    }
    const stored = await saveScript(patch, markdown)
    cache.set(doc.id, markdown)
    const idx = docs.value.findIndex((d) => d.id === doc.id)
    if (idx >= 0) docs.value[idx] = stored
    return stored
  }

  async function rename(id: ID, title: string) {
    const clean = (title || '').trim()
    if (!clean) return undefined
    const doc = docs.value.find((d) => d.id === id)
    if (!doc) return undefined
    let md = await readContent(id)
    md = /^\s*#\s+/m.test(md)
      ? md.replace(/^\s*#\s+.*$/m, `# ${clean}`)
      : buildScriptMarkdown(clean, md)
    const stats = statsOf(md)
    const stored = await saveScript(
      {
        ...doc,
        title: clean,
        filename: `${sanitizeFilename(clean)}.md`,
        episodeCount: stats.episodeCount,
        totalWords: stats.totalWords,
        updatedAt: Date.now()
      },
      md
    )
    cache.set(id, md)
    const idx = docs.value.findIndex((d) => d.id === id)
    if (idx >= 0) docs.value[idx] = stored
    return stored
  }

  async function setContent(id: ID, markdown: string) {
    cache.set(id, markdown)
    await write(id, markdown)
  }

  // ===== 集数操作 =====

  async function addEpisode(id: ID, title?: string) {
    const md = await readContent(id)
    const { markdown, index } = appendEpisode(md, title)
    await write(id, markdown)
    return index
  }

  async function insertEpisodeAt(id: ID, at: number, title?: string) {
    const md = await readContent(id)
    const { markdown, index } = insertEpisode(md, at, title)
    await write(id, markdown)
    return index
  }

  async function removeEpisodeAt(id: ID, index: number) {
    const md = await readContent(id)
    if (parseScriptDoc(md).episodes.length <= 1) throw new Error('至少保留一集')
    const { markdown } = removeEpisode(md, index)
    await write(id, markdown)
  }

  async function editEpisode(
    id: ID,
    index: number,
    patch: { title?: string; content?: string }
  ) {
    const md = await readContent(id)
    await write(id, updateEpisode(md, index, patch))
  }

  async function reorderEpisode(id: ID, from: number, to: number) {
    const md = await readContent(id)
    await write(id, moveEpisode(md, from, to))
  }

  // ===== 其它 =====

  async function remove(id: ID) {
    await deleteScriptDoc(id)
    cache.delete(id)
    docs.value = docs.value.filter((d) => d.id !== id)
  }

  async function download(id: ID) {
    const doc = docs.value.find((d) => d.id === id)
    const markdown = await readContent(id, true)
    if (isDesktop()) {
      const saved = await desktop().saveTextFile({
        defaultName: doc?.filename || '剧本.md',
        text: markdown,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      return Boolean(saved)
    }
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = doc?.filename || '剧本.md'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  }

  async function revealFile(id: ID) {
    if (!isDesktop()) return false
    const abs = await scriptAbsPath(id)
    if (!abs) return false
    await desktop().openPath(abs)
    return true
  }

  async function openFolder() {
    if (!isDesktop()) return false
    const dir = await scriptsDirPath()
    if (!dir) return false
    await desktop().openPath(dir)
    return true
  }

  /** 磁盘上的正文被手改过后同步回来 */
  async function reloadFromDisk(id: ID) {
    const text = await readContent(id, true)
    await write(id, text)
    return text
  }

  return {
    docs,
    loading,
    byId,
    projectDocs,
    refresh,
    ensureLoaded,
    readContent,
    create,
    importMarkdown,
    saveFromProject,
    rename,
    setContent,
    addEpisode,
    insertEpisodeAt,
    removeEpisodeAt,
    editEpisode,
    reorderEpisode,
    remove,
    download,
    revealFile,
    openFolder,
    reloadFromDisk
  }
})
