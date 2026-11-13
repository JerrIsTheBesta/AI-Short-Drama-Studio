<script setup lang="ts">
/**
 * 剧本管理
 *
 * 左侧剧本列表（本地 Markdown 档案），右侧编辑器：
 * - 按集编辑：改标题、改正文、增删排序
 * - Markdown 全文 / 预览：直接改整份 md
 * 每份剧本都会落到 保存目录/_scripts/<id>.md，可在资源库里复用。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useScriptsStore, useSettingsStore, useToastStore } from '@/stores'
import { llmModelGroups } from '@/stores/settings'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import Tag from '@/components/common/Tag.vue'
import { pickScriptFile } from '@/utils/pickPlayFile'
import { markdownToHtml } from '@/utils/markdown'
import { parseScriptDoc, toEpisodes, updateEpisode } from '@/utils/scriptEpisodes'
import { callLLM } from '@/services/ai/client'
import type { ScriptEpisode } from '@/types'

type EditorTab = 'episodes' | 'markdown' | 'preview'

const router = useRouter()
const scripts = useScriptsStore()
const project = useProjectStore()
const settings = useSettingsStore()
const toast = useToastStore()

const keyword = ref('')
const activeId = ref('')
const detailOpen = ref(false)
const activeTab = ref<EditorTab>('episodes')
const markdown = ref('')
const dirty = ref(false)
const saving = ref(false)
const activeEpisodeIndex = ref(0)
const titleEditing = ref('')
/** 当前展开那一集的编辑草稿（避免边打字边被 Markdown 规范化打断） */
const draft = ref<{ index: number; title: string; content: string } | null>(null)

const activeDoc = computed(() => scripts.docs.find((d) => d.id === activeId.value) ?? null)

const episodes = computed<ScriptEpisode[]>(() => {
  if (!activeDoc.value) return []
  return toEpisodes(parseScriptDoc(markdown.value), activeDoc.value.id)
})

const filteredDocs = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return scripts.docs
  return scripts.docs.filter((d) => d.title.toLowerCase().includes(kw))
})

const totalWords = computed(() => episodes.value.reduce((sum, ep) => sum + ep.wordCount, 0))
const previewHtml = computed(() => markdownToHtml(markdown.value))

function fmtTime(ts: number) {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sourceLabel(source: string) {
  return source === 'ai-generated' ? 'AI 生成' : source === 'imported' ? '导入' : '手建'
}

async function loadContent(id: string, force = false) {
  markdown.value = await scripts.readContent(id, force)
  syncDraft(0)
  dirty.value = false
}

/** 把某一集读进草稿 */
function syncDraft(index: number) {
  activeEpisodeIndex.value = index
  const ep = episodes.value[index]
  draft.value = ep ? { index, title: ep.title, content: ep.content } : null
}

function openEpisode(index: number) {
  if (draft.value && draft.value.index === index) return
  if (draft.value) flushDraft()
  syncDraft(index)
}

async function openScript(id: string) {
  if (id !== activeId.value) {
    if (dirty.value && !confirmDiscard()) return
    flushDraft()
    activeId.value = id
    await loadContent(id)
  }
  titleEditing.value = scripts.docs.find((d) => d.id === id)?.title || ''
  detailOpen.value = true
}

function backToLibrary() {
  flushDraft()
  detailOpen.value = false
}

function confirmDiscard(): boolean {
  return window.confirm('当前剧本有未保存的修改，要放弃吗？')
}

function markDirty() {
  dirty.value = true
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 草稿改动后 0.8 秒写回 Markdown 并落盘 */
function scheduleFlush() {
  dirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushDraft, 800)
}

function flushDraft() {
  if (!draft.value || !activeId.value) return
  const { index, title, content } = draft.value
  markdown.value = updateEpisode(markdown.value, index, {
    title: title.trim() || `第 ${index + 1} 集`,
    content
  })
  void persistQuiet()
}

async function commitTitle() {
  if (!activeId.value || !activeDoc.value) return
  const clean = titleEditing.value.trim()
  if (!clean || clean === activeDoc.value.title) {
    titleEditing.value = activeDoc.value.title
    return
  }
  try {
    await scripts.rename(activeId.value, clean)
    markdown.value = await scripts.readContent(activeId.value, true)
    dirty.value = false
    toast.success('已改名')
  } catch (e: any) {
    toast.error(`改名失败：${e?.message ?? e}`)
  }
}

async function persistQuiet() {
  if (!activeId.value) return
  saving.value = true
  try {
    await scripts.setContent(activeId.value, markdown.value)
    dirty.value = false
  } catch (e: any) {
    toast.error(`保存失败：${e?.message ?? e}`)
  } finally {
    saving.value = false
  }
}

async function saveNow() {
  if (!activeId.value) return
  flushDraft()
  await persistQuiet()
  toast.success('已保存到本地 Markdown')
}

/** 改某一集的标题：写草稿，延迟回流到 Markdown */
function onTitleInput(index: number, ev: Event) {
  if (!draft.value || draft.value.index !== index) openEpisode(index)
  if (!draft.value) return
  draft.value.title = (ev.target as HTMLInputElement).value
  scheduleFlush()
}

async function addEpisode() {
  if (!activeId.value) return
  flushDraft()
  const index = await scripts.addEpisode(activeId.value)
  await loadContent(activeId.value, true)
  activeTab.value = 'episodes'
  toast.success(`已新增第 ${index + 1} 集`)
  await nextTick()
  scrollEpisodeIntoView(index)
}

function scrollEpisodeIntoView(index: number) {
  const el = document.getElementById(`ep-${index}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

async function insertEpisodeAfter(index: number) {
  if (!activeId.value) return
  flushDraft()
  const at = await scripts.insertEpisodeAt(activeId.value, index + 1)
  await loadContent(activeId.value, true)
  toast.success('已插入新的一集')
}

async function removeEpisode(index: number) {
  if (!activeId.value) return
  if (episodes.value.length <= 1) {
    toast.warn('至少保留一集')
    return
  }
  const target = episodes.value[index]
  if (!confirm(`删除「${target?.title ?? `第 ${index + 1} 集`}」？`)) return
  draft.value = null
  try {
    await scripts.removeEpisodeAt(activeId.value, index)
  } catch (e: any) {
    toast.error(e?.message ?? '删除失败')
    return
  }
  await loadContent(activeId.value, true)
  toast.success('已删除该集')
}

async function moveEpisode(index: number, offset: -1 | 1) {
  if (!activeId.value) return
  const target = index + offset
  if (target < 0 || target >= episodes.value.length) return
  flushDraft()
  await scripts.reorderEpisode(activeId.value, index, target)
  await loadContent(activeId.value, true)
  syncDraft(target)
}

async function createScript() {
  await scripts.ensureLoaded()
  const doc = await scripts.create({
    title: `未命名剧本 ${scripts.docs.length + 1}`,
    source: 'manual'
  })
  activeId.value = doc.id
  titleEditing.value = doc.title
  detailOpen.value = true
  await loadContent(doc.id, true)
  activeTab.value = 'episodes'
  toast.success('已新建剧本')
}

const llmGroups = computed(() => llmModelGroups(settings.config.llms ?? []))
const llmModel = computed(() => settings.config.llm.model)

const genChoice = computed({
  get() {
    const id = settings.config.activeLlmId
    const model = settings.config.llm.model
    return id && model ? `${id}::${model}` : ''
  },
  set(v: string) {
    const sep = v.indexOf('::')
    if (sep <= 0) return
    settings.selectLlmModel(v.slice(0, sep), v.slice(sep + 2))
  }
})

const episodeHint = ref('')
const episodeWriting = ref(false)
let episodeAbort: AbortController | null = null

async function writeCurrentEpisode() {
  if (!draft.value || episodeWriting.value) return
  if (!llmModel.value) {
    toast.warn('请先在设置里添加并选择模型')
    return
  }
  const hint = episodeHint.value.trim()
  const existing = draft.value.content.trim()
  if (!hint && !existing) {
    toast.warn('先写一句要求，或留一点已有正文')
    return
  }
  episodeWriting.value = true
  episodeAbort = new AbortController()
  try {
    const resp = await callLLM({
      model: llmModel.value,
      disableThinking: true,
      temperature: 0.7,
      signal: episodeAbort.signal,
      messages: [
        {
          role: 'system',
          content:
            '你是短剧编剧。只输出这一集的正文，用简体中文，可以写场次、动作和对白。不要解释，不要加开场白。'
        },
        {
          role: 'user',
          content: `剧本：${activeDoc.value?.title || '未命名剧本'}\n这一集：${draft.value.title}\n已有正文：\n${existing || '（空）'}\n\n要求：${hint || '把这一集写完整，保留已有情节。'}`
        }
      ]
    })
    const text = String(resp.content || '').trim()
    if (!text) throw new Error('模型没有返回内容')
    draft.value.content = text
    scheduleFlush()
    toast.success('这一集写好了')
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (episodeAbort?.signal.aborted) toast.warn('已取消')
    else toast.error(msg || '写这一集失败')
  } finally {
    episodeWriting.value = false
    episodeAbort = null
  }
}

function cancelEpisodeWrite() {
  episodeAbort?.abort()
}

async function importScript() {
  let picked: { text: string; filename: string } | null = null
  try {
    picked = await pickScriptFile()
  } catch (e: any) {
    toast.error(e?.message ?? '导入失败')
    return
  }
  if (!picked) return
  try {
    const doc = await scripts.importMarkdown(picked.text, picked.filename)
    activeId.value = doc.id
    titleEditing.value = doc.title
    detailOpen.value = true
    await loadContent(doc.id, true)
    toast.success(`已导入：${doc.title}`)
  } catch (e: any) {
    toast.error(e?.message ?? '导入失败')
  }
}

async function downloadActive() {
  if (!activeId.value) return
  const ok = await scripts.download(activeId.value)
  if (ok) toast.success('已导出 Markdown')
}

async function revealActive() {
  if (!activeId.value) return
  const ok = await scripts.revealFile(activeId.value)
  if (!ok) toast.warn('暂时打不开（仅桌面端支持）')
}

async function reloadFromDisk() {
  if (!activeId.value) return
  if (dirty.value && !(await confirmDiscard())) return
  await scripts.reloadFromDisk(activeId.value)
  draft.value = null
  await loadContent(activeId.value, true)
  toast.success('已读取磁盘上的最新内容')
}

async function applyToProject() {
  flushDraft()
  await persistQuiet()
  if (!activeDoc.value || !markdown.value.trim()) {
    toast.warn('剧本是空的')
    return
  }
  if (!project.current) {
    toast.warn('请先打开一个项目')
    return
  }
  const doc = activeDoc.value
  const prev = project.current.script
  project.setScript({
    id: prev?.id ?? `s_${Date.now().toString(36)}`,
    topic: doc.title,
    content: markdown.value.trim(),
    keywords: prev?.keywords ?? [],
    style: prev?.style ?? 'cinematic',
    aspectRatio: prev?.aspectRatio ?? project.current.settings.aspectRatio,
    shotDuration: prev?.shotDuration ?? project.current.settings.defaultShotDuration ?? 5,
    playReady: true,
    createdAt: prev?.createdAt ?? Date.now()
  })
  project.applyPlayTitle(doc.title)
  project.setPlayApproved(false)
  await project.save()
  toast.success('已写入当前项目，可去提炼分镜')
  router.push('/studio')
}

async function removeActive() {
  const doc = activeDoc.value
  if (!doc) return
  if (!confirm(`从剧本库删除「${doc.title}」？本地 Markdown 文件也会一起删除。`)) return
  await scripts.remove(doc.id)
  activeId.value = ''
  markdown.value = ''
  draft.value = null
  dirty.value = false
  detailOpen.value = false
  toast.success('已删除')
}

function copyMarkdown() {
  navigator.clipboard.writeText(markdown.value).then(
    () => toast.success('已复制全文'),
    () => toast.error('复制失败')
  )
}

watch(
  () => activeDoc.value?.title,
  (t) => {
    if (t) titleEditing.value = t
  }
)

watch(activeTab, (tab) => {
  if (tab === 'episodes') syncDraft(activeEpisodeIndex.value)
})

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  flushDraft()
})

onMounted(async () => {
  await scripts.refresh()
  const pid = project.current?.id
  const prefer = pid ? scripts.docs.find((d) => d.projectId === pid) : undefined
  const first = prefer ?? scripts.docs[0]
  if (first) {
    activeId.value = first.id
    titleEditing.value = first.title
    await loadContent(first.id)
  }
})
</script>

<template>
  <div class="page" :class="{ detail: detailOpen }">
    <header class="page-head">
      <div>
        <div class="kicker">剧本创作</div>
        <h1>{{ detailOpen ? activeDoc?.title || '剧本' : '剧本项目' }}</h1>
        <p v-if="!detailOpen">
          每个剧本是一个项目。点进去后，左侧是集数，右侧改当前这一集，也可以选模型让 AI 写。
        </p>
      </div>
      <div class="head-actions">
        <GradientButton v-if="detailOpen" type="ghost" @click="backToLibrary">返回剧本列表</GradientButton>
        <GradientButton type="ghost" @click="router.push('/drafts')">资源库</GradientButton>
        <GradientButton type="secondary" icon="📥" title="支持 Markdown、TXT、README 和 Word" @click="importScript">导入剧本</GradientButton>
        <GradientButton icon="＋" @click="createScript">新建剧本</GradientButton>
      </div>
    </header>

    <div v-if="!detailOpen" class="library-tools">
      <input v-model="keyword" class="search" placeholder="搜索剧本名…" />
    </div>
    <div v-if="!detailOpen" class="library">
      <div v-if="!filteredDocs.length" class="empty-mini">
        还没有剧本。新建之后可以在里面让 AI 写，也可以导入已有剧本。
      </div>
      <button
        v-for="d in filteredDocs"
        :key="d.id"
        class="script-card"
        @click="openScript(d.id)"
      >
        <div class="si-title">{{ d.title }}</div>
        <div class="si-meta">
          <Tag size="sm">{{ sourceLabel(d.source) }}</Tag>
          {{ d.episodeCount }} 集 · {{ d.totalWords }} 字
        </div>
        <div class="si-time">{{ fmtTime(d.updatedAt) }}</div>
      </button>
    </div>

    <div v-else class="workspace">
      <aside class="ep-side">
        <div class="side-head">
          <strong>集数</strong>
          <span class="count">{{ episodes.length }}</span>
        </div>
        <div class="list">
          <button
            v-for="(ep, i) in episodes"
            :key="ep.id"
            class="ep-item"
            :class="{ active: activeEpisodeIndex === i }"
            @click="openEpisode(i)"
          >
            <span class="ep-no">{{ i + 1 }}</span>
            <span class="ep-item-title">{{ ep.title }}</span>
            <span class="ep-words">{{ ep.wordCount }} 字</span>
          </button>
        </div>
        <button class="side-foot" @click="addEpisode">＋ 新增一集</button>
      </aside>

      <section class="ep-main">
        <GlassCard v-if="activeDoc && draft" padding="none" class="editor-card">
          <div class="ed-head">
            <input
              v-model="titleEditing"
              class="title-input"
              @change="commitTitle"
              @keydown.enter.prevent="commitTitle"
            />
            <div class="ed-meta">
              <span>{{ episodes.length }} 集</span>
              <span>·</span>
              <span>{{ totalWords }} 字</span>
              <span>·</span>
              <span v-if="saving">保存中…</span>
              <span v-else-if="dirty" class="unsaved">未保存</span>
              <span v-else>已保存</span>
            </div>
            <div class="ed-actions">
              <button class="mini-btn" @click="downloadActive">⬇ 导出</button>
              <button v-if="dirty" class="mini-btn primary" @click="saveNow">保存</button>
              <button class="mini-btn danger" @click="removeActive">删除剧本</button>
            </div>
          </div>
          <div class="episode-editor">
            <div class="episode-tools">
              <input
                class="ep-title-input"
                :value="draft.title"
                @input="onTitleInput(draft.index, $event)"
              />
              <div class="episode-move">
                <button type="button" title="上移" :disabled="draft.index === 0" @click="moveEpisode(draft.index, -1)">↑</button>
                <button
                  type="button"
                  title="下移"
                  :disabled="draft.index === episodes.length - 1"
                  @click="moveEpisode(draft.index, 1)"
                >
                  ↓
                </button>
                <button type="button" title="删除这一集" class="danger" @click="removeEpisode(draft.index)">删除</button>
              </div>
            </div>
            <textarea
              v-model="draft.content"
              class="episode-body"
              placeholder="写这一集的正文，支持 Markdown"
              @input="scheduleFlush"
            />
            <div class="ai-bar">
              <select v-model="genChoice" class="llm-select" :disabled="episodeWriting">
                <option v-if="!llmGroups.some((g) => g.models.length)" value="">请先在设置里添加模型</option>
                <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
                  <option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">
                    {{ m }}
                  </option>
                </optgroup>
              </select>
              <input
                v-model="episodeHint"
                class="ai-hint"
                placeholder="告诉 AI 这一集怎么写，例如：加一场雨夜对峙"
                :disabled="episodeWriting"
                @keydown.enter.prevent="writeCurrentEpisode"
              />
              <button v-if="episodeWriting" class="mini-btn danger" type="button" @click="cancelEpisodeWrite">取消</button>
              <button v-else class="mini-btn primary" type="button" @click="writeCurrentEpisode">AI 写这一集</button>
            </div>
          </div>
          <div class="ed-foot">
            <span class="foot-tip">文件：_scripts/{{ activeDoc.filename }}</span>
            <GradientButton size="sm" type="primary" icon="→" @click="applyToProject">
              送入当前项目
            </GradientButton>
          </div>
        </GlassCard>
      </section>
    </div>

  </div>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 100%;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.kicker {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--color-text-4);
  margin-bottom: 4px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.02em;
  margin: 0 0 6px;
  color: var(--color-text-1);
}
.page-head p {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-3);
  max-width: 640px;
  line-height: 1.6;
}
.head-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.page.detail {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.library-tools {
  display: flex;
}
.library-tools .search {
  width: min(360px, 100%);
}
.library {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  align-content: start;
}
.script-card {
  text-align: left;
  padding: 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-card);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 112px;
  cursor: pointer;
}
.script-card:hover {
  border-color: rgba(126, 180, 255, 0.55);
}
.workspace {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 12px;
}
.ep-side {
  min-height: 0;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ep-item {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 8px;
  width: 100%;
  text-align: left;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  cursor: pointer;
}
.ep-item.active {
  border-color: rgba(126, 180, 255, 0.5);
  background: var(--grad-primary-soft);
}
.ep-item-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ep-main {
  min-height: 0;
  min-width: 0;
}
.ep-main .editor-card {
  height: 100%;
  min-height: 0;
}
.episode-editor {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
}
.episode-tools {
  display: flex;
  gap: 8px;
  align-items: center;
}
.ep-title-input {
  flex: 1;
  min-width: 0;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--color-text-1);
  font-size: 14px;
}
.episode-move {
  display: flex;
  gap: 4px;
}
.episode-move button {
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  cursor: pointer;
}
.episode-move button.danger {
  color: #f87171;
}
.episode-body {
  flex: 1;
  min-height: 240px;
  resize: none;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 12px;
  color: var(--color-text-1);
  font-size: 14px;
  line-height: 1.7;
}
.ai-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.llm-select,
.ai-hint {
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-1);
  height: 34px;
  padding: 0 10px;
  font-size: 12px;
}
.llm-select {
  max-width: 220px;
}
.ai-hint {
  flex: 1;
  min-width: 0;
}

.side {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  position: sticky;
  top: 0;
}
.side-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.search {
  flex: 1;
  min-width: 0;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-1);
  outline: none;
}
.search:focus {
  border-color: var(--color-accent);
}
.count {
  font-size: 11px;
  color: var(--color-text-4);
  flex-shrink: 0;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: calc(100vh - 260px);
  overflow-y: auto;
}
.script-item {
  text-align: left;
  padding: 10px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: var(--color-bg-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: all var(--duration-fast);
}
.script-item:hover {
  border-color: var(--color-border-strong);
}
.script-item.active {
  border-color: rgba(126, 180, 255, 0.5);
  background: var(--grad-primary-soft);
}
.si-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.si-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-3);
}
.si-time {
  font-size: 10px;
  color: var(--color-text-4);
}
.side-foot {
  font-size: 11px;
  color: var(--color-text-3);
  padding: 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
}
.side-foot:hover {
  color: var(--color-text-1);
  background: var(--color-fill);
}

.editor-card {
  min-height: 520px;
  display: flex;
  flex-direction: column;
}
.center {
  align-items: center;
  justify-content: center;
}
.ed-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}
.title-input {
  flex: 1;
  min-width: 200px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 16px;
  font-weight: 650;
  color: var(--color-text-1);
  outline: none;
}
.title-input:hover {
  background: var(--color-fill);
}
.title-input:focus {
  border-color: var(--color-accent);
  background: var(--color-bg-2);
}
.ed-meta {
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
.unsaved {
  color: var(--color-warning);
}
.ed-actions {
  display: flex;
  gap: 6px;
}
.mini-btn {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  color: var(--color-text-2);
  background: transparent;
  transition: all var(--duration-fast);
}
.mini-btn:hover:not(:disabled) {
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
  background: var(--color-fill);
}
.mini-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.mini-btn.primary {
  border-color: rgba(126, 180, 255, 0.4);
  background: var(--grad-primary-soft);
  color: #b9cbff;
}
.mini-btn.danger:hover {
  color: var(--color-error);
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(248, 113, 113, 0.1);
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--color-border);
}
.tabs button {
  font-size: 12px;
  padding: 8px 12px;
  color: var(--color-text-3);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tabs button:hover {
  color: var(--color-text-1);
}
.tabs button.on {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}

.ed-body {
  flex: 1;
  min-height: 380px;
  padding: var(--space-4) var(--space-5);
  overflow-y: auto;
}

.ep-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.ep-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-2);
  overflow: hidden;
  transition: border-color var(--duration-fast);
}
.ep-card.open {
  border-color: rgba(126, 180, 255, 0.4);
}
.ep-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
  cursor: pointer;
}
.ep-no {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 6px;
  background: var(--grad-primary-soft);
  color: var(--color-accent);
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ep-title {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 3px 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
  outline: none;
}
.ep-title:hover {
  background: var(--color-fill);
}
.ep-title:focus {
  border-color: var(--color-accent);
  background: var(--color-bg-1);
}
.ep-words {
  font-size: 11px;
  color: var(--color-text-4);
  flex-shrink: 0;
}
.ep-tools {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.ep-tools button {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--color-text-3);
}
.ep-tools button:hover:not(:disabled) {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.ep-tools button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.ep-tools button.danger:hover {
  color: var(--color-error);
  background: rgba(248, 113, 113, 0.12);
}
.ep-body {
  width: 100%;
  min-height: 220px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-1);
  color: var(--color-text-2);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.75;
  padding: var(--space-3);
  border: none;
  outline: none;
  resize: vertical;
}
.add-ep {
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  padding: 12px;
  font-size: 12px;
  color: var(--color-text-3);
  transition: all var(--duration-fast);
}
.add-ep:hover {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: var(--grad-primary-soft);
}

.md-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
}
.md-editor {
  flex: 1;
  min-height: 420px;
  width: 100%;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-2);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.75;
  padding: var(--space-4);
  outline: none;
  resize: vertical;
}
.md-editor:focus {
  border-color: var(--color-accent);
}
.md-foot {
  display: flex;
  gap: var(--space-2);
}

.preview {
  color: var(--color-text-2);
  font-size: 13.5px;
  line-height: 1.8;
  max-width: 760px;
}
.preview :deep(h1) {
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text-1);
  margin: 0 0 16px;
}
.preview :deep(h2) {
  font-size: 17px;
  font-weight: 650;
  color: var(--color-text-1);
  margin: 28px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
}
.preview :deep(h3) {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-1);
  margin: 20px 0 8px;
}
.preview :deep(p) {
  margin: 0 0 12px;
}
.preview :deep(ul),
.preview :deep(ol) {
  margin: 0 0 12px;
  padding-left: 20px;
}
.preview :deep(li) {
  margin-bottom: 4px;
}
.preview :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 20px 0;
}
.preview :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--color-fill);
  padding: 1px 5px;
  border-radius: 4px;
}
.preview :deep(strong) {
  color: var(--color-text-1);
}

.ed-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--color-border);
}
.foot-tip {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-4);
}

.empty-mini {
  text-align: center;
  color: var(--color-text-4);
  font-size: 12px;
  padding: var(--space-6) var(--space-3);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  line-height: 1.7;
}

.blank {
  text-align: center;
  padding: var(--space-8);
}
.blank-icon {
  font-size: 40px;
  opacity: 0.5;
  margin-bottom: var(--space-3);
}
.blank-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-1);
  margin-bottom: 6px;
}
.blank-desc {
  font-size: 12.5px;
  color: var(--color-text-3);
  max-width: 420px;
  margin: 0 auto var(--space-4);
  line-height: 1.7;
}
.blank-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: center;
}

@media (max-width: 1080px) {
  .body {
    grid-template-columns: 1fr;
  }
  .side {
    position: static;
  }
  .list {
    max-height: 220px;
  }
}

</style>
