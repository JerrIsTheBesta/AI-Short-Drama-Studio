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
import { parseScriptDoc, serializeScriptDoc, toEpisodes, updateEpisode } from '@/utils/scriptEpisodes'
import { callLLM } from '@/services/ai/client'
import { assertScriptCompletion } from '@/services/ai/scriptCompletion'
import { SCRIPT_REFERENCE_OPTIONS, normalizeScriptReference, scriptReferenceBrief } from '@/services/ai/scriptReference'
import { SHORT_DRAMA_WRITING_RULES } from '@/services/ai/shortDramaRhythm'
import { importedDirectorPrefix } from '@/services/settings/directorSkill'
import { desktop, isDesktop } from '@/services/desktop'
import { parseJsonRobust } from '@/utils/jsonRepair'
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
type WritingMessage = { role: 'user' | 'assistant'; content: string; episode: number; time: number }
type StoryPlan = { brief: string; outline: string; episodes: Array<{ title: string; summary: string }>; stage: 'outline-review' | 'ready' | 'episode-review' | 'complete'; nextIndex: number }
const writingMessages = ref<WritingMessage[]>([])
const storyPlan = ref<StoryPlan | null>(null)
const writingMode = ref<'auto' | 'series' | 'episode'>('auto')
const planEditing = ref(false)
const planKey = (id: string) => `script-writing-plan:v1:${id}`
const writingHistoryLoading = ref(false)
const writingHistoryError = ref(false)
const writingList = ref<HTMLElement | null>(null)
const writingKey = (id: string) => `script-writing-chat:v1:${id}`
let historyLoadToken = 0
let historyWrites = Promise.resolve()

watch(activeId, async (id) => {
  const token = ++historyLoadToken
  writingMessages.value = []
  storyPlan.value = null
  planEditing.value = false
  writingHistoryError.value = false
  if (!id) return
  writingHistoryLoading.value = true
  try {
    await historyWrites
    const raw = isDesktop() ? await desktop().kvGet(writingKey(id)) : localStorage.getItem(writingKey(id))
    const rows: unknown = raw ? JSON.parse(raw) : []
    if (token !== historyLoadToken) return
    writingMessages.value = Array.isArray(rows) ? rows.filter((row): row is WritingMessage =>
      row && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string' && typeof row.episode === 'number'
    ).slice(-100) : []
    const savedPlan = isDesktop() ? await desktop().kvGet(planKey(id)) : localStorage.getItem(planKey(id))
    if (token !== historyLoadToken) return
    if (savedPlan) {
      const plan = JSON.parse(savedPlan) as StoryPlan
      if (Array.isArray(plan.episodes) && typeof plan.outline === 'string' && ['outline-review', 'ready', 'episode-review', 'complete'].includes(plan.stage)) storyPlan.value = plan
    }
  } catch {
    if (token === historyLoadToken) writingHistoryError.value = true
  } finally {
    if (token === historyLoadToken) writingHistoryLoading.value = false
  }
}, { immediate: true })

function addWritingMessage(id: string, message: WritingMessage) {
  if (id !== activeId.value) return
  writingMessages.value = [...writingMessages.value, message].slice(-100)
  const data = JSON.stringify(writingMessages.value)
  historyWrites = historyWrites.catch(() => {}).then(async () => {
    if (isDesktop()) await desktop().kvSet(writingKey(id), data)
    else localStorage.setItem(writingKey(id), data)
  }).catch(() => { writingHistoryError.value = true })
  void nextTick(() => { if (writingList.value) writingList.value.scrollTop = writingList.value.scrollHeight })
}
async function saveStoryPlan(id: string, plan: StoryPlan | null) {
  const text = JSON.stringify(plan)
  if (isDesktop()) await desktop().kvSet(planKey(id), text)
  else localStorage.setItem(planKey(id), text)
  if (id === activeId.value) storyPlan.value = plan
}
const scriptReferenceType = computed({
  get: () => normalizeScriptReference(settings.config.scriptReferenceType),
  set: (value: string) => settings.update({ scriptReferenceType: normalizeScriptReference(value) })
})
const episodeWriting = ref(false)
const writingPhase = ref<'episode' | 'outline'>('episode')
const episodeElapsed = ref(0)
let episodeTimer: ReturnType<typeof setInterval> | undefined
let episodeAbort: AbortController | null = null

function startWriting() {
  episodeWriting.value = true
  episodeElapsed.value = 0
  episodeTimer = setInterval(() => { episodeElapsed.value++ }, 1000)
  episodeAbort = new AbortController()
  return episodeAbort
}

function finishWriting() {
  if (episodeTimer) clearInterval(episodeTimer)
  episodeTimer = undefined
  episodeWriting.value = false
  episodeAbort = null
}

async function writeStoryPlan(brief: string, revision = false) {
  const id = activeId.value
  if (!id || !llmModel.value || episodeWriting.value) return
  const oldPlan = revision ? storyPlan.value : null
  if (!brief.trim() && !oldPlan) { toast.warn('请先描述题材、人物或故事想法'); return }
  writingPhase.value = 'outline'
  const controller = startWriting()
  const request = brief.trim() || oldPlan?.brief || ''
  addWritingMessage(id, { role: 'user', content: request, episode: -1, time: Date.now() })
  try {
    const resp = await callLLM({
      model: llmModel.value, disableThinking: true, temperature: 0.6, useProviderOutputLimit: true,
      timeoutMs: 300_000, signal: controller.signal,
      messages: [
        { role: 'system', content: `${importedDirectorPrefix()}${SHORT_DRAMA_WRITING_RULES}\n你是专业短剧编剧。先为整部剧策划大纲与分集目录，不写剧本正文。尊重用户指定的集数、时长、题材和结局；未指定集数时先规划适合短剧的 8 集，并在大纲中说明可修改。每集明确戏剧任务、冲突变化和下集钩子，人物关系和事件因果前后一致。只输出合法 JSON：{"outline":"故事梗概、人物设定及关系、世界规则和情绪主线","episodes":[{"title":"第1集标题","summary":"本集推进与结尾"}]}。不要用 Markdown 代码块。\n${scriptReferenceBrief(settings.config.scriptReferenceType, request)}` },
        { role: 'user', content: `${revision && oldPlan ? `原大纲：${oldPlan.outline}\n原分集目录：${JSON.stringify(oldPlan.episodes)}\n修改要求：` : '创作需求：'}${request}` }
      ]
    })
    assertScriptCompletion(resp)
    const parsed = parseJsonRobust(resp.content)
    const outline = typeof parsed?.outline === 'string' ? parsed.outline.trim() : ''
    const rows = Array.isArray(parsed?.episodes) ? parsed.episodes : []
    const planned = rows.map((row: any) => ({ title: String(row?.title || '').trim(), summary: String(row?.summary || '').trim() }))
    if (!outline || !planned.length || planned.length > 100 || planned.some((row: { title: string; summary: string }) => !row.title || !row.summary)) throw new Error('大纲格式不完整，请重试或减少单次规划的集数。')
    if (controller.signal.aborted || activeId.value !== id) throw new Error('写作已取消或已切换剧本')
    await saveStoryPlan(id, { brief: revision && oldPlan ? `${oldPlan.brief}\n修改：${request}` : request, outline, episodes: planned, stage: 'outline-review', nextIndex: 0 })
    episodeHint.value = ''
    planEditing.value = true
    addWritingMessage(id, { role: 'assistant', content: `已整理故事大纲和 ${planned.length} 集目录。请先检查、修改，确认后我再写第一集。`, episode: -1, time: Date.now() })
  } catch (error: any) {
    const message = controller.signal.aborted ? '本次大纲生成已取消。' : `大纲生成未完成：${error?.message || '请重试'}`
    if (activeId.value === id) addWritingMessage(id, { role: 'assistant', content: message, episode: -1, time: Date.now() })
    toast.warn(message)
  } finally { finishWriting() }
}

async function writePlannedEpisode() {
  const plan = storyPlan.value
  const id = activeId.value
  if (!plan || !id || episodeWriting.value || !llmModel.value || plan.stage !== 'ready') return
  const index = plan.nextIndex
  const episode = plan.episodes[index]
  if (!episode) return
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  flushDraft()
  const parsed = parseScriptDoc(markdown.value)
  if (index > parsed.episodes.length) { toast.warn('集数目录已改变，请先检查剧本。'); return }
  if (index > 0 && parsed.episodes.slice(0, index).some((item) => !item.content.trim())) { toast.warn('前面有尚未完成的集数，请先补全再继续。'); return }
  const existing = parsed.episodes[index]?.content.trim() || ''
  if (existing && !confirm(`第 ${index + 1} 集已有正文。继续会用 AI 结果替换这一集，确定吗？`)) return
  const snapshot = markdown.value
  const prior = parsed.episodes.slice(0, index).map((ep, i) => `第${i + 1}集 ${ep.title}\n${ep.content}`).join('\n\n')
  writingPhase.value = 'episode'
  const controller = startWriting()
  addWritingMessage(id, { role: 'assistant', content: `开始写第 ${index + 1} 集：${episode.title}。完成后会等你确认。`, episode: index, time: Date.now() })
  try {
    const resp = await callLLM({ model: llmModel.value, disableThinking: true, temperature: 0.6, useProviderOutputLimit: true, timeoutMs: 300_000, signal: controller.signal,
      messages: [
        { role: 'system', content: `${importedDirectorPrefix()}${SHORT_DRAMA_WRITING_RULES}\n你是专业短剧编剧。只写指定这一集的完整正文，使用简体中文，包含具体场次、行动与自然对白。忠实遵循已确认大纲和前文，承接人物关系、时间、地点、物件和未解冲突；不得重写已完成集或抢写下一集。场次使用三级标题，禁止输出一级或二级标题。只输出本集 Markdown 正文。\n${scriptReferenceBrief(settings.config.scriptReferenceType, plan.brief, plan.outline, episode.summary)}` },
        { role: 'user', content: `用户创作需求：${plan.brief}\n已确认大纲：${plan.outline}\n完整分集目录：${JSON.stringify(plan.episodes)}\n已完成前文${prior.length > 30000 ? '（仅显示最近部分，更早剧情请参考分集目录）' : ''}：\n${prior.slice(-30000) || '（第一集）'}\n当前要写：第 ${index + 1} 集 ${episode.title}\n本集任务：${episode.summary}\n${existing ? `需要替换的原正文：\n${existing}` : ''}` }
      ] })
    assertScriptCompletion(resp)
    const body = String(resp.content || '').replace(/^```(?:markdown|md|text)?\s*/i, '').replace(/\s*```$/, '').trim().replace(/^#{1,2}\s+/gm, '### ')
    if (!body) throw new Error('模型没有返回正文')
    if (controller.signal.aborted || activeId.value !== id || markdown.value !== snapshot) throw new Error('剧本已切换或正文发生变化，结果未覆盖原文，请重试。')
    if (index === parsed.episodes.length) parsed.episodes.push({ title: episode.title, content: body })
    else parsed.episodes[index] = { title: episode.title, content: body }
    const updated = serializeScriptDoc(parsed)
    await scripts.setContent(id, updated)
    markdown.value = updated
    syncDraft(index)
    dirty.value = false
    const reviewPlan: StoryPlan = { ...plan, stage: 'episode-review' }
    try {
      await saveStoryPlan(id, reviewPlan)
    } catch {
      if (activeId.value === id) storyPlan.value = reviewPlan
      toast.warn('本集正文已保存，但创作进度保存失败；请检查存储后再确认下一集。')
    }
    addWritingMessage(id, { role: 'assistant', content: `第 ${index + 1} 集已写入正文。请检查并修改，确认后我再写下一集。`, episode: index, time: Date.now() })
  } catch (error: any) {
    const message = controller.signal.aborted ? '本集写作已取消，正文未更改。' : `本集写作未完成：${error?.message || '请重试'}`
    if (activeId.value === id) addWritingMessage(id, { role: 'assistant', content: message, episode: index, time: Date.now() })
    toast.warn(message)
  } finally { finishWriting() }
}

async function confirmStoryPlan() {
  const plan = storyPlan.value
  if (!plan || !activeId.value || episodeWriting.value) return
  if (!plan.outline.trim() || plan.episodes.some((episode) => !episode.title.trim() || !episode.summary.trim())) { toast.warn('请先补全大纲和每集内容'); return }
  try {
    await saveStoryPlan(activeId.value, { ...plan, stage: 'ready', nextIndex: 0 })
    planEditing.value = false
    episodeHint.value = ''
    await writePlannedEpisode()
  } catch (error: any) { toast.error(error?.message || '保存大纲失败') }
}

async function savePlanDraft() {
  if (!storyPlan.value || !activeId.value || episodeWriting.value) return
  try {
    await saveStoryPlan(activeId.value, { ...storyPlan.value, episodes: storyPlan.value.episodes.map((item) => ({ ...item })) })
    toast.success('大纲草稿已保存')
  } catch (error: any) { toast.error(error?.message || '保存大纲失败') }
}

async function confirmEpisodeAndContinue() {
  const plan = storyPlan.value
  const id = activeId.value
  if (!plan || !id || episodeWriting.value || plan.stage !== 'episode-review') return
  if (draft.value && draft.value.index !== plan.nextIndex) { toast.warn(`请先切换到第 ${plan.nextIndex + 1} 集检查正文`); return }
  if (!draft.value?.content.trim()) { toast.warn('这一集正文为空，请先补全'); return }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  markdown.value = updateEpisode(markdown.value, draft.value.index, { title: draft.value.title, content: draft.value.content })
  try {
    await scripts.setContent(id, markdown.value)
    dirty.value = false
    episodeHint.value = ''
    const nextIndex = plan.nextIndex + 1
    if (nextIndex >= plan.episodes.length) {
      await saveStoryPlan(id, { ...plan, nextIndex, stage: 'complete' })
      addWritingMessage(id, { role: 'assistant', content: '全部分集已确认完成。', episode: -1, time: Date.now() })
      return
    }
    await saveStoryPlan(id, { ...plan, nextIndex, stage: 'ready' })
    await writePlannedEpisode()
  } catch (error: any) { toast.error(error?.message || '保存失败，请重试') }
}

async function writeCurrentEpisode() {
  if (!draft.value || episodeWriting.value) return
  if (!llmModel.value) {
    toast.warn('请先在设置里添加并选择模型')
    return
  }
  const hint = episodeHint.value.trim()
  const existing = draft.value.content.trim()
  if (writingHistoryLoading.value) { toast.warn('正在读取对话记录，请稍候'); return }
  if (storyPlan.value?.stage === 'outline-review' && /^\s*(?:确认|通过|开始写|可以|下一步)\s*[。！!]*$/.test(hint)) { await confirmStoryPlan(); return }
  if (storyPlan.value?.stage === 'episode-review' && /^\s*(?:确认|通过|继续|下一集|可以|下一步)\s*[。！!]*$/.test(hint)) { await confirmEpisodeAndContinue(); return }
  if (storyPlan.value?.stage === 'outline-review' && hint && writingMode.value !== 'episode') { await writeStoryPlan(hint, true); return }
  const wantsSeries = writingMode.value === 'series' || (writingMode.value === 'auto' && (/(?:整部|整剧|全集|分集大纲|分集目录|多集)|(?:写|创作|策划|生成).{0,30}(?:短剧|剧本)(?!.*(?:本集|这一集|当前集))/.test(hint) || (!existing && /题材|科幻|悬疑|古装|都市|甜宠|穿越|重生|家庭伦理/.test(hint) && !/本集|这一集|当前集/.test(hint))))
  if (wantsSeries && hint) {
    if (storyPlan.value && !confirm('重新规划会替换当前大纲，已写好的剧本正文不会删除。继续吗？')) return
    await writeStoryPlan(hint)
    return
  }
  if (!hint && !existing) {
    toast.warn('先写一句要求，或留一点已有正文')
    return
  }
  const conversation = writingMessages.value.filter((message) => message.episode === draft.value?.index && message.role === 'user').slice(-6)
  episodeWriting.value = true
  writingPhase.value = 'episode'
  episodeElapsed.value = 0
  episodeTimer = setInterval(() => { episodeElapsed.value++ }, 1000)
  episodeAbort = new AbortController()
  const targetDocId = activeDoc.value?.id
  const targetDraft = draft.value
  if (targetDocId) addWritingMessage(targetDocId, { role: 'user', content: hint || '请根据已有正文写完整这一集。', episode: targetDraft.index, time: Date.now() })
  try {
    const resp = await callLLM({
      model: llmModel.value,
      disableThinking: true,
      useProviderOutputLimit: true,
      timeoutMs: 300_000,
      temperature: 0.7,
      signal: episodeAbort.signal,
      messages: [
        {
          role: 'system',
          content:
            `${importedDirectorPrefix()}${SHORT_DRAMA_WRITING_RULES}\n你是短剧编剧。只输出这一集的正文，用简体中文，可以写场次、动作和对白。不要解释，不要加开场白。\n${scriptReferenceBrief(settings.config.scriptReferenceType, activeDoc.value?.title, draft.value.title, existing, hint)}`
        },
        {
          role: 'user',
          content: `剧本：${activeDoc.value?.title || '未命名剧本'}\n这一集：${draft.value.title}\n此前本集的用户写作要求（仅供上下文参考，当前要求优先）：\n${conversation.map((item) => item.content).join('\n') || '（无）'}\n已有正文：\n${existing || '（空）'}\n\n当前要求：${hint || '把这一集写完整，保留已有情节。'}`
        }
      ]
    })
    assertScriptCompletion(resp)
    const text = String(resp.content || '').trim()
    if (!text) throw new Error('模型没有返回内容')
    if (episodeAbort.signal.aborted) throw new Error('已取消')
    if (activeDoc.value?.id !== targetDocId || draft.value !== targetDraft) {
      toast.warn('写作期间切换了剧本或集数，结果未覆盖当前正文，请回到原集重试。')
      return
    }
    draft.value.content = text
    if (targetDocId) addWritingMessage(targetDocId, { role: 'assistant', content: '已完成本集正文，内容已写入中间编辑区。可以继续提出修改要求。', episode: targetDraft.index, time: Date.now() })
    episodeHint.value = ''
    scheduleFlush()
    toast.success('这一集写好了')
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (episodeAbort?.signal.aborted) toast.warn('已取消')
    else toast.error(msg || '写这一集失败')
    if (targetDocId && activeId.value === targetDocId) addWritingMessage(targetDocId, { role: 'assistant', content: episodeAbort?.signal.aborted ? '本次写作已取消，正文未更改。' : `本次写作未完成：${msg || '请重试'}`, episode: targetDraft.index, time: Date.now() })
  } finally {
    if (episodeTimer) clearInterval(episodeTimer)
    episodeTimer = undefined
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
  episodeAbort?.abort()
  if (episodeTimer) clearInterval(episodeTimer)
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
        <GradientButton type="ghost" @click="router.push('/')">返回首页</GradientButton>
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
            <div class="episode-body-wrap" :aria-busy="episodeWriting">
              <textarea
                v-model="draft.content"
                class="episode-body"
                placeholder="写这一集的正文，支持 Markdown"
                :readonly="episodeWriting"
                @input="scheduleFlush"
              />
              <div v-if="episodeWriting" class="episode-writing-overlay" role="status" aria-live="polite">
                <span class="episode-writing-spinner" aria-hidden="true" />
                <strong>{{ writingPhase === 'outline' ? 'AI 正在策划大纲' : 'AI 正在创作这一集' }}</strong>
                <span>已等待 {{ episodeElapsed }} 秒 · {{ writingPhase === 'outline' ? '完成后请先确认大纲' : '完成后自动填入正文' }}</span>
                <button type="button" class="mini-btn" @click="cancelEpisodeWrite">取消生成</button>
              </div>
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
      <aside v-if="activeDoc && draft" class="writing-agent" aria-label="AI 剧本助手">
        <header class="writing-agent-head">
          <span class="writing-agent-icon" aria-hidden="true">✦</span>
          <div><strong>剧本助手</strong><p>一起打磨人物、对白和故事</p></div>
        </header>
        <div ref="writingList" class="writing-history" aria-live="polite">
          <div class="writing-message assistant"><span>剧本助手</span><p>告诉我你想写什么，或说说这一集需要怎样修改。完成后正文会显示在左侧编辑区。</p></div>
          <p v-if="writingHistoryLoading" class="writing-note">正在读取对话记录…</p>
          <p v-if="writingHistoryError" class="writing-note">对话记录读取或保存失败，正文不受影响。</p>
          <div v-for="(message, i) in writingMessages" :key="`${message.time}-${i}`" class="writing-message" :class="message.role">
            <span>{{ message.role === 'user' ? '你' : '剧本助手' }} · 第 {{ message.episode + 1 }} 集</span>
            <p>{{ message.content }}</p>
          </div>
          <div v-if="episodeWriting" class="writing-message assistant writing-pending" role="status">
            <span>剧本助手</span><p><i class="writing-pulse" /> {{ writingPhase === 'outline' ? '正在策划大纲' : '正在创作本集' }}，已等待 {{ episodeElapsed }} 秒</p>
          </div>
          <section v-if="storyPlan" class="story-plan">
            <div class="story-plan-heading"><strong>整剧策划 · {{ storyPlan.episodes.length }} 集</strong><button type="button" :disabled="episodeWriting" @click="planEditing = !planEditing">{{ planEditing ? '收起' : '查看大纲' }}</button></div>
            <p class="story-plan-status">{{ storyPlan.stage === 'outline-review' ? '等待确认大纲' : storyPlan.stage === 'episode-review' ? `第 ${storyPlan.nextIndex + 1} 集等待确认` : storyPlan.stage === 'complete' ? '全部分集已确认' : `准备写第 ${storyPlan.nextIndex + 1} 集` }}</p>
            <div v-if="planEditing" class="story-plan-content">
              <label>故事大纲与人物设定<textarea v-model="storyPlan.outline" :readonly="storyPlan.stage !== 'outline-review' || episodeWriting" rows="7" /></label>
              <label v-for="(episode, index) in storyPlan.episodes" :key="index">第 {{ index + 1 }} 集<input v-model="episode.title" :readonly="storyPlan.stage !== 'outline-review' || episodeWriting" /><textarea v-model="episode.summary" :readonly="storyPlan.stage !== 'outline-review' || episodeWriting" rows="3" /></label>
              <p v-if="storyPlan.stage === 'outline-review'">可直接修改大纲和每集内容，确认时保存；也可以在下方输入修改要求让 AI 调整。</p>
              <button v-if="storyPlan.stage === 'outline-review'" type="button" class="story-plan-save" :disabled="episodeWriting" @click="savePlanDraft">保存大纲草稿</button>
            </div>
            <button v-if="storyPlan.stage === 'outline-review'" type="button" class="story-plan-confirm" :disabled="episodeWriting" @click="confirmStoryPlan">确认大纲并写第一集</button>
            <button v-else-if="storyPlan.stage === 'episode-review'" type="button" class="story-plan-confirm" :disabled="episodeWriting" @click="confirmEpisodeAndContinue">{{ storyPlan.nextIndex + 1 >= storyPlan.episodes.length ? '确认本集，完成创作' : '确认本集并写下一集' }}</button>
            <button v-else-if="storyPlan.stage === 'ready'" type="button" class="story-plan-confirm" :disabled="episodeWriting" @click="writePlannedEpisode">继续写第 {{ storyPlan.nextIndex + 1 }} 集</button>
          </section>
        </div>
        <div class="writing-compose">
          <div class="writing-options">
            <label><span>语言模型</span><select v-model="genChoice" :disabled="episodeWriting" aria-label="语言模型">
              <option v-if="!llmGroups.some((g) => g.models.length)" value="">请先在设置里添加模型</option>
              <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name"><option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">{{ m }}</option></optgroup>
            </select></label>
            <label><span>写作知识库</span><select v-model="scriptReferenceType" :disabled="episodeWriting" aria-label="选择写作知识库参考类型">
              <option v-for="item in SCRIPT_REFERENCE_OPTIONS" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select></label>
          </div>
          <label class="writing-mode"><span>创作方式</span><select v-model="writingMode" :disabled="episodeWriting"><option value="auto">自动判断</option><option value="series">整部剧本 · 先大纲</option><option value="episode">只写当前一集</option></select></label>
          <textarea v-model="episodeHint" class="writing-input" placeholder="告诉我这一集想怎么写，或需要修改哪里…" :disabled="episodeWriting" @keydown.ctrl.enter.prevent="writeCurrentEpisode" />
          <div class="writing-actions"><span>Ctrl + Enter 发送</span><button v-if="episodeWriting" class="writing-send cancel" type="button" @click="cancelEpisodeWrite">取消生成</button><button v-else class="writing-send" type="button" :disabled="writingHistoryLoading" @click="writeCurrentEpisode">发送 ✦</button></div>
        </div>
      </aside>
    </div>

  </div>
</template>

<style scoped>
.page {
  --color-bg-0: #0c0b14;
  --color-bg-1: #141226;
  --color-bg-2: #1b192b;
  --color-bg-card: #151323;
  --color-border: rgba(196, 180, 255, 0.12);
  --color-accent: #a28bff;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background: radial-gradient(750px 420px at 92% 0%, rgba(98, 54, 196, .13), transparent 65%), #0c0b14;
  color: #f4f1ff;
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
  padding: 10px 16px 14px;
  gap: 10px;
}
.page.detail .page-head { align-items: center; gap: 8px; }
.page.detail .page-head > div:first-child { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.page.detail .kicker { margin: 0; white-space: nowrap; letter-spacing: 0; }
.page.detail .page-head h1 { margin: 0; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page.detail .head-actions { gap: 6px; }
.page.detail .head-actions :deep(button) { min-height: 32px; padding: 5px 11px; font-size: 12px; }
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
  grid-template-columns: 200px minmax(320px, 1fr) minmax(280px, 340px);
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
  border-color: rgba(162, 139, 255, 0.6);
  background: rgba(109, 77, 255, 0.16);
}
.writing-agent {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(196, 180, 255, .14);
  border-radius: 16px;
  background: #151323;
}
.writing-agent-head { display: flex; align-items: center; gap: 11px; padding: 17px; border-bottom: 1px solid rgba(196, 180, 255, .1); }
.writing-agent-head strong { color: #f4f1ff; font-size: 14px; }
.writing-agent-head p { margin: 4px 0 0; color: #9992b3; font-size: 11px; }
.writing-agent-icon { display: grid; place-items: center; flex: 0 0 36px; height: 36px; border-radius: 11px; color: #e3d8ff; background: #5940bf; font-size: 20px; }
.writing-history { flex: 1; min-height: 120px; overflow-y: auto; padding: 18px 14px; display: flex; flex-direction: column; gap: 16px; }
.writing-message { max-width: 96%; align-self: flex-start; min-width: 0; }
.writing-message.user { align-self: flex-end; }
.writing-message > span { display: block; margin: 0 4px 6px; color: #9189aa; font-size: 11px; }
.writing-message.user > span { text-align: right; }
.writing-message p { margin: 0; padding: 11px 12px; border: 1px solid rgba(196, 180, 255, .08); border-radius: 4px 13px 13px 13px; background: #211e32; color: #e3dff0; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
.writing-message.user p { border: 1px solid rgba(156, 130, 255, .3); border-radius: 13px 4px 13px 13px; background: #473987; color: #fff; }
.writing-note { margin: 0; color: #aaa0bf; font-size: 12px; }
.writing-compose { padding: 13px; border-top: 1px solid rgba(196, 180, 255, .1); }
.story-plan { padding: 12px; border: 1px solid rgba(162, 139, 255, .25); border-radius: 12px; background: #201b35; }
.story-plan-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: #f4f1ff; font-size: 12px; }
.story-plan-heading button { border: 0; background: transparent; color: #b5a4ff; cursor: pointer; font-size: 11px; }
.story-plan-status { margin: 7px 0; color: #b8aed2; font-size: 11px; }
.story-plan-content { display: flex; flex-direction: column; gap: 10px; max-height: 300px; overflow: auto; margin: 10px 0; }
.story-plan-content label { display: flex; flex-direction: column; gap: 5px; color: #c9c1de; font-size: 11px; }
.story-plan-content textarea, .story-plan-content input, .writing-mode select { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid rgba(196, 180, 255, .16); border-radius: 8px; background: #151323; color: #eeeafa; font: inherit; line-height: 1.5; }
.story-plan-content textarea { resize: vertical; }
.story-plan-content p { margin: 0; color: #aaa0bf; font-size: 11px; line-height: 1.5; }
.story-plan-confirm { width: 100%; padding: 9px; border: 1px solid #8a70ef; border-radius: 8px; background: #5d44c7; color: white; cursor: pointer; font-size: 12px; }
.story-plan-confirm:disabled { opacity: .5; cursor: default; }
.story-plan-save { align-self: flex-start; padding: 6px 10px; border: 1px solid rgba(162, 139, 255, .35); border-radius: 7px; background: transparent; color: #cabfff; cursor: pointer; font-size: 11px; }
.writing-mode { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: #a8a0bd; font-size: 11px; }
.writing-mode span { flex-shrink: 0; }
.writing-mode select { height: 32px; padding: 0 8px; background: #201d30; }
.writing-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
.writing-options label { display: flex; min-width: 0; flex-direction: column; gap: 5px; color: #a8a0bd; font-size: 11px; }
.writing-options select { width: 100%; min-width: 0; height: 34px; padding: 0 8px; border: 1px solid rgba(196, 180, 255, .16); border-radius: 8px; background: #201d30; color: #e8e3f5; font-size: 11px; }
.writing-input { display: block; width: 100%; min-height: 86px; box-sizing: border-box; resize: vertical; padding: 11px; border: 1px solid rgba(196, 180, 255, .15); border-radius: 10px; outline: none; background: #201d30; color: #f4f1ff; font: inherit; font-size: 12px; line-height: 1.6; }
.writing-input:focus { border-color: #927aff; }
.writing-input::placeholder { color: #817a98; }
.writing-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
.writing-actions > span { color: #817a98; font-size: 10px; }
.writing-send { padding: 8px 15px; border: 0; border-radius: 9px; background: #7555f5; color: white; font-size: 12px; font-weight: 600; cursor: pointer; }
.writing-send:hover { background: #896dff; }
.writing-send:disabled { opacity: .5; cursor: default; }
.writing-send.cancel { background: #342c48; }
.writing-pulse { display: inline-block; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; background: #b5a3ff; animation: writing-pulse 1s ease-in-out infinite alternate; }
@keyframes writing-pulse { to { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .writing-pulse { animation: none; } }
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
.episode-body-wrap {
  position: relative;
  flex: 1;
  min-height: 240px;
  display: flex;
}
.episode-body {
  flex: 1;
  width: 100%;
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
.episode-writing-overlay {
  position: absolute;
  inset: 1px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-radius: 9px;
  background: rgba(18, 19, 27, 0.88);
  color: var(--color-text-1);
  font-size: 13px;
}
.episode-writing-overlay > span:not(.episode-writing-spinner) { color: var(--color-text-3); font-size: 12px; }
.episode-writing-spinner {
  width: 30px;
  height: 30px;
  border: 3px solid rgba(126, 180, 255, 0.2);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: episode-writing-spin 0.85s linear infinite;
}
@keyframes episode-writing-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .episode-writing-spinner { animation: none; } }
.ai-bar {
  display: flex;
  gap: 8px;
  align-items: center;
}
.llm-select,
.reference-select,
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
.reference-select-label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  color: var(--color-text-3);
  font-size: 12px;
}
.reference-select { max-width: 160px; }
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
  .workspace { grid-template-columns: 150px minmax(250px, 1fr) minmax(240px, 290px); }
  .ai-bar { flex-wrap: wrap; }
  .ai-hint { flex: 1 1 220px; }
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
@media (max-width: 760px) {
  .page.detail { height: auto; overflow: visible; }
  .workspace { display: flex; flex-direction: column; }
  .ep-side { max-height: 200px; }
  .ep-main .editor-card { min-height: 500px; }
  .writing-agent { min-height: 440px; }
}

</style>
