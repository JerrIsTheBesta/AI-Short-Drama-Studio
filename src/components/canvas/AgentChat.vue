<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { runAgentTurn, type AgentEvent, type AgentMessage } from '@/services/canvas/agent'
import { friendlyAiError, isAbortError, isTimeoutAbort } from '@/services/ai/abort'
import { appendAgentMessage, getAgentState, setAgentAutonomy } from '@/services/canvas/taskStore'
import { estimateRequestText } from '@/services/canvas/toolRegistry'
import { onCanvasActivity, type CanvasActivity } from '@/services/canvas/canvasBridge'
import { nextPipelineStep } from '@/services/canvas/pipeline'
import { useProjectStore, useSettingsStore, useToastStore } from '@/stores'
import { desktop, isDesktop } from '@/services/desktop'
import { autodlVideoProfileId } from '@/services/ai/runtime'
import { SCRIPT_REFERENCE_OPTIONS, normalizeScriptReference } from '@/services/ai/scriptReference'
import type { VideoGenModel } from '@/types'
import type { AgentAttachment } from '@/services/canvas/attachments'
import type { TraceRow, TraceStatus } from '@/services/canvas/agentTrace'
import type { AgentAutonomy, AspectRatio, CanvasNode, VideoResolution } from '@/types'
import AgentRichText from './AgentRichText.vue'
import AgentTraceList from './AgentTraceList.vue'
import {
  CUSTOM_STORY_SKILL_ID,
  GENERAL_STORY_SKILL_ID,
  STORY_SKILLS
} from '@/skills/storyStyles'
import {
  parseDirectorSkill,
  pickDirectorSkillFile,
  pickDirectorSkillFolder
} from '@/services/settings/directorSkill'

const props = withDefaults(
  defineProps<{
    selectedNode?: CanvasNode | null
  }>(),
  { selectedNode: null }
)

type StepStatus = TraceStatus

type FeedItem =
  | { id: string; type: 'msg'; role: 'user' | 'assistant'; content: string }
  | { id: string; type: 'run'; rows: TraceRow[] }

const WELCOME =
  '我是这张画布的创作搭档，两种用法都行：\n\n- **一句话开工**：说「写一个修仙短剧，8 个分镜」或「画一张黄昏的海边」，我直接建节点、写提示词、跑生成\n- **自己拼**：在画布空白处右键添加图片 / 视频 / 音频 / 剧本 / 角色 / 道具 / 场景 / 分镜，点选节点后让我改提示词、重跑\n\n我也带本地记忆——说「记住…」以后一直生效。想一次做到底就说「全流程」，否则我做一步停一步等你确认。'

const feed = ref<FeedItem[]>([
  { id: 'welcome', type: 'msg', role: 'assistant', content: WELCOME }
])
const messages = computed<AgentMessage[]>(() =>
  feed.value
    .filter((item): item is Extract<FeedItem, { type: 'msg' }> => item.type === 'msg')
    .map((item) => ({ role: item.role, content: item.content }))
)
const input = ref('')
const busy = ref(false)
const thinking = ref(false)
const log = ref('')
const trace = ref<TraceRow[]>([])
const chips = ref<{ label: string; text: string }[]>([
  { label: '拆剧本', text: '拆剧本' },
  { label: '帮我画一张图', text: '帮我创建一个图片节点并生成：' },
  { label: '看看进度', text: '现在画布什么情况' }
])
const box = ref<HTMLElement | null>(null)
const autonomy = ref<AgentAutonomy>('gated')
const canvasLive = ref(false)
const canvasTrace = ref<TraceRow[]>([])
const project = useProjectStore()
let offActivity: (() => void) | undefined
const settings = useSettingsStore()
const toast = useToastStore()
/** 本轮要带上的本地文件附件（文本内容已在选择时读入） */
const attachments = ref<AgentAttachment[]>([])
const TEXT_ATTACH_FILTERS = [
  { name: '文本文件', extensions: ['txt', 'md', 'markdown', 'fountain', 'srt', 'ass', 'lrc', 'json', 'csv'] }
]

async function pickAttachments() {
  if (!isDesktop()) {
    toast.warn('读取本地文件需要桌面端（已安装的应用）')
    return
  }
  try {
    const files = await desktop().pickFiles(TEXT_ATTACH_FILTERS)
    if (!files?.length) return
    for (const p of files) {
      if (attachments.value.some((a) => a.path === p)) continue
      try {
        const raw = await desktop().readText(p)
        const content = raw.length > 200_000
          ? `${raw.slice(0, 200_000)}\n\n【内容过长，已截取前 200,000 个字符】`
          : raw
        attachments.value.push({ name: p.split(/[\\/]/).pop() || p, path: p, content })
      } catch (e) {
        toast.error(`读取失败：${p.split(/[\\/]/).pop() || p}`)
        console.warn('[agent] 附件读取失败', e)
      }
    }
  } catch (e) {
    toast.error('选择文件失败')
    console.warn('[agent] pickFiles 失败', e)
  }
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1)
}

let controller: AbortController | null = null

/* ── 生成配置：比例 / 图像模型 / 视频模型 / 分辨率，选好即生效 ── */
const ASPECT_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: '16:9', label: '横版 16:9' },
  { value: '9:16', label: '竖版 9:16' },
  { value: '1:1', label: '方形 1:1' },
  { value: '4:3', label: '传统 4:3' },
  { value: '21:9', label: '影院 21:9' }
]
/* 创作偏好弹窗：比例 + 图像/视频模型收进一个面板 */
const prefOpen = ref(false)
const prefTab = ref<'video' | 'image' | 'knowledge'>('video')
/* 父容器 overflow 会裁剪浮层，所以传送到 body 按按钮位置定位 */
const prefBtn = ref<HTMLElement | null>(null)
const prefPanel = ref<HTMLElement | null>(null)
const PANEL_WIDTH = 720
const prefStyle = ref<Record<string, string>>({})

function placeAnchoredPanel(btn: HTMLElement | null, widthCap: number) {
  const rect = btn?.getBoundingClientRect()
  if (!rect) return null
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(widthCap, vw - 24)
  const left = Math.max(12, Math.min(rect.left, vw - width - 12))
  const spaceAbove = rect.top - 12
  const spaceBelow = vh - rect.bottom - 12
  const style: Record<string, string> = { left: `${Math.round(left)}px`, width: `${Math.round(width)}px` }
  if (spaceAbove >= 260 || spaceAbove >= spaceBelow) {
    style.bottom = `${Math.round(vh - rect.top + 6)}px`
    style.maxHeight = `${Math.round(Math.max(240, Math.min(spaceAbove, 680)))}px`
  } else {
    style.top = `${Math.round(rect.bottom + 6)}px`
    style.maxHeight = `${Math.round(Math.max(240, Math.min(spaceBelow, 680)))}px`
  }
  return style
}

function placePrefPanel() {
  const style = placeAnchoredPanel(prefBtn.value, PANEL_WIDTH)
  if (style) prefStyle.value = style
}

const skillOpen = ref(false)
const skillTab = ref<'style' | 'genre' | 'mine'>('style')
const skillBtn = ref<HTMLElement | null>(null)
const skillPanel = ref<HTMLElement | null>(null)
const skillStyle = ref<Record<string, string>>({})
const importingSkill = ref(false)
const styleSkills = STORY_SKILLS.filter((skill) => skill.group === 'style')
const genreSkills = STORY_SKILLS.filter((skill) => skill.group === 'genre')
const storyIconFiles = import.meta.glob<string>('@/assets/story-icons/*.png', { eager: true, query: '?url', import: 'default' })
function storyIcon(id: string): string {
  const name = id === GENERAL_STORY_SKILL_ID ? 'general' : id
  return Object.entries(storyIconFiles).find(([path]) => path.endsWith(`/${name}.png`))?.[1] || ''
}
const activeStyleId = computed(() => settings.config.storyStyleId || GENERAL_STORY_SKILL_ID)
const activeGenreId = computed(() => settings.config.storyGenreId || GENERAL_STORY_SKILL_ID)
const activeStorySkillId = computed(() => skillTab.value === 'genre' ? activeGenreId.value : activeStyleId.value)
const importedSkill = computed(() => settings.config.directorSkill)
const activeStorySkillName = computed(() => {
  const style = activeStyleId.value === CUSTOM_STORY_SKILL_ID ? importedSkill.value?.name || '我的技能' : STORY_SKILLS.find((skill) => skill.id === activeStyleId.value)?.name || '通用分镜'
  const genre = STORY_SKILLS.find((skill) => skill.id === activeGenreId.value)?.name || '不限题材'
  return `${style} · ${genre}`
})

function placeSkillPanel() {
  const style = placeAnchoredPanel(skillBtn.value, 560)
  if (style) skillStyle.value = style
}

function placeComposerPanels() {
  placePrefPanel()
  placeSkillPanel()
}

function togglePrefPanel() {
  prefOpen.value = !prefOpen.value
  if (prefOpen.value) {
    skillOpen.value = false
    prefStyle.value = {}
    nextTick(placePrefPanel)
  }
}

function closePrefPanel() {
  prefOpen.value = false
}

function toggleSkillPanel() {
  skillOpen.value = !skillOpen.value
  if (skillOpen.value) {
    prefOpen.value = false
    skillStyle.value = {}
    nextTick(placeSkillPanel)
  }
}

function closeSkillPanel() {
  skillOpen.value = false
}

function pickStorySkill(id: string) {
  if (id === GENERAL_STORY_SKILL_ID && skillTab.value === 'genre') {
    settings.update({ storyGenreId: GENERAL_STORY_SKILL_ID })
    return
  }
  settings.selectStorySkill(id)
}

async function saveImportedSkill(picked: { text: string; filename: string } | null) {
  if (!picked) return
  const doc = parseDirectorSkill(picked.text, picked.filename)
  settings.update({ directorSkill: doc })
  settings.selectStorySkill(CUSTOM_STORY_SKILL_ID)
  await settings.flush()
  toast.success(`已导入技能「${doc.name}」。写剧本和拆分镜会按它来。`)
}

async function importStorySkill() {
  importingSkill.value = true
  try {
    await saveImportedSkill(await pickDirectorSkillFile())
  } catch (err: any) {
    toast.error(err?.message || '导入技能失败')
  } finally {
    importingSkill.value = false
  }
}

async function importStorySkillFolder() {
  importingSkill.value = true
  try {
    await saveImportedSkill(await pickDirectorSkillFolder())
  } catch (err: any) {
    toast.error(err?.message || '导入技能失败')
  } finally {
    importingSkill.value = false
  }
}

async function clearImportedSkill() {
  settings.update({ directorSkill: null })
  settings.selectStorySkill(GENERAL_STORY_SKILL_ID)
  await settings.flush()
  toast.success('已清除导入的技能，回到通用分镜')
}

const currentAspectRatio = computed<AspectRatio>(
  () => project.current?.settings?.aspectRatio || '16:9'
)
const imageProfiles = computed(() => settings.config.images ?? [])
const videoProfiles = computed(() => settings.config.videos ?? [])
const activeImage = computed(
  () =>
    imageProfiles.value.find((p) => p.id === settings.config.activeImageId) ||
    imageProfiles.value[0]
)
const activeVideo = computed(
  () =>
    videoProfiles.value.find((p) => p.id === settings.config.activeVideoId) ||
    videoProfiles.value[0]
)
const activeImageLabel = computed(() => {
  const p = activeImage.value
  return p ? `${p.name} · ${p.model}` : '图像模型'
})
const activeVideoLabel = computed(() => {
  const d = videoDefault.value
  if (d) return VIDEO_WORKFLOW_OPTIONS.find((w) => w.value === d)?.name || '视频模型'
  const p = activeVideo.value
  return p ? p.name : '视频模型'
})

/** 比例小图标的内框尺寸（外框固定 40×26 居中） */
function ratioBoxStyle(value: AspectRatio) {
  const map: Record<AspectRatio, [number, number]> = {
    '16:9': [30, 17],
    '9:16': [13, 23],
    '1:1': [19, 19],
    '4:3': [24, 18],
    '21:9': [34, 15]
  }
  const [w, h] = map[value] ?? [30, 17]
  return { width: `${w}px`, height: `${h}px` }
}

/** 视频端点没有模型名，副标题显示服务商或域名 */
function videoSub(p: { provider?: string; baseUrl: string }): string {
  if (p.provider) return p.provider
  try {
    return new URL(p.baseUrl).host
  } catch {
    return p.baseUrl
  }
}

/* 选中后不关面板，方便连续调整 */
function pickAspectRatio(value: AspectRatio) {
  project.setAspectRatio(value)
}

function pickImage(id: string) {
  settings.selectImage(id)
}

function pickVideo(id: string) {
  // 选了具体接入就回到「跟随接入」模式，清掉内置工作流默认
  settings.selectVideoModelDefault(undefined)
  settings.selectVideo(id)
}

/** 与视频节点下拉同款的内置工作流（用设置里的 AutoDL 令牌），创作偏好里也能直接选 */
const VIDEO_WORKFLOW_OPTIONS: { value: VideoGenModel; name: string; desc: string }[] = [
  { value: 'h3', name: 'H3 v5 · 15 秒', desc: 'AutoDL · 人设+场景参考图直接生成' },
  { value: 'h3-v5', name: 'H3 v5 · 10 秒 · 1080p', desc: 'AutoDL · 画质升级版' },
  { value: 'wan-prime', name: '万相 3.0 Prime', desc: '需四宫格关键帧' }
]
const videoDefault = computed(() => settings.config.defaultVideoModel)
const VIDEO_RES_OPTIONS: { value: VideoResolution; label: string }[] = [
  { value: '768p', label: '768p' },
  { value: '1080p', label: '1080p' }
]
const currentVideoResolution = computed<VideoResolution>(
  () => project.current?.settings.defaultVideoResolution || '768p'
)

const scriptReferenceType = computed({
  get: () => normalizeScriptReference(settings.config.scriptReferenceType),
  set: (value: string) => settings.update({ scriptReferenceType: normalizeScriptReference(value) })
})
const videoChoice = computed({
  get: () => videoDefault.value ? `workflow:${videoDefault.value}` : `profile:${activeVideo.value?.id || ''}`,
  set: (value: string) => {
    if (value.startsWith('workflow:')) {
      const workflow = VIDEO_WORKFLOW_OPTIONS.find((item) => item.value === value.slice(9))
      if (workflow) pickVideoWorkflow(workflow.value)
    } else if (value.startsWith('profile:') && value.slice(8)) pickVideo(value.slice(8))
  }
})
const imageChoice = computed({
  get: () => activeImage.value?.id || '',
  set: (value: string) => { if (value) pickImage(value) }
})

function pickVideoResolution(value: VideoResolution) {
  project.setDefaultVideoResolution(value)
}

function pickVideoWorkflow(model: VideoGenModel) {
  settings.selectVideoModelDefault(model)
  // H3 系列内置工作流用 AutoDL 令牌：顺手把当前接入切到 AutoDL，免得提交时还指着别家
  if (model !== 'wan-prime') {
    const autodlId = autodlVideoProfileId()
    if (autodlId) settings.selectVideo(autodlId)
  }
}

/** 与节点下拉一致：给接入线路带上服务商标签 */
function videoProfileTag(p: { provider?: string; baseUrl?: string; adapter?: { type?: string } }): string {
  const zealman = p.provider === 'zealman' || p.adapter?.type === 'zealman-workflow'
  const autodl = !zealman && (p.provider === 'autodl' || /autodl\.art/i.test(p.baseUrl || ''))
  return zealman ? 'Zealman' : autodl ? 'AutoDL' : ''
}

const estimate = computed(() => estimateRequestText(input.value))

/** 自由画布：当前选中节点卡片 */
const selectedGenNode = computed(() => {
  const n = props.selectedNode
  if (!n || (n.type !== 'imageGen' && n.type !== 'videoGen')) return null
  return n
})
const selectedKindLabel = computed(() =>
  selectedGenNode.value?.type === 'videoGen' ? '图生视频' : '生图'
)
const polishChips = [
  { label: '更有画面感', text: '更有画面感：补构图、光影、材质和空气感，不改原文格式' },
  { label: '写清动作表情', text: '把眉眼嘴、手和身体怎么动写具体，不改原文格式' },
  { label: '按剧情对齐', text: '对照剧本，只写这一镜该发生的事，不改原文格式' }
]

onMounted(() => {
  const saved = getAgentState()
  autonomy.value = 'gated'
  void setAgentAutonomy('gated')
  if (saved.messages.length) {
    feed.value = saved.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message, i) => ({
        id: `saved-${i}`,
        type: 'msg' as const,
        role: message.role as 'user' | 'assistant',
        content: message.content
      }))
  }
  window.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('resize', placeComposerPanels)
  window.addEventListener('scroll', placeComposerPanels, true)
  window.addEventListener('keydown', onGlobalKey, true)
  offActivity = onCanvasActivity(applyCanvasActivity)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('resize', placeComposerPanels)
  window.removeEventListener('scroll', placeComposerPanels, true)
  window.removeEventListener('keydown', onGlobalKey, true)
  offActivity?.()
})

function onGlobalKey(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return
  if (prefOpen.value) closePrefPanel()
  if (skillOpen.value) closeSkillPanel()
}

function onDocPointer(ev: PointerEvent) {
  const el = ev.target as HTMLElement | null
  const inPref = !!el && (!!el.closest('.pref-pop') || !!prefPanel.value?.contains(el))
  const inSkill = !!el && (!!el.closest('.skill-pop') || !!skillPanel.value?.contains(el))
  if (!el?.closest('.bar-pop') && !inPref) closePrefPanel()
  if (!el?.closest('.bar-pop') && !inSkill) closeSkillPanel()
}

async function scrollToEnd() {
  await nextTick()
  box.value?.scrollTo({ top: box.value.scrollHeight, behavior: 'smooth' })
}

function upsertStep(key: string, patch: Partial<TraceRow>) {
  const i = trace.value.findIndex((s) => s.key === key)
  if (i >= 0) {
    trace.value[i] = { ...trace.value[i], ...patch }
  } else {
    trace.value = [...trace.value, { key, kind: 'step', label: patch.label || key, ...patch }]
  }
}

function upsertCanvasStep(key: string, patch: Partial<TraceRow>) {
  const i = canvasTrace.value.findIndex((s) => s.key === key)
  if (i >= 0) {
    canvasTrace.value[i] = { ...canvasTrace.value[i], ...patch }
  } else {
    canvasTrace.value = [...canvasTrace.value, { key, kind: 'step', label: patch.label || key, ...patch }]
  }
}

/** 计划卡片与执行步骤的状态同步 */
function syncPlanSteps(stepKey: string, status: StepStatus) {
  for (const row of trace.value) {
    if (row.kind !== 'plan' || !row.plan) continue
    const step = row.plan.steps.find((s) => s.key === stepKey)
    if (step) step.status = status
  }
}

function onProgress(ev: AgentEvent) {
  log.value = ev.label
  if (ev.kind === 'intent') {
    trace.value = [
      { key: 'intent', kind: 'intent', label: ev.label },
      ...trace.value.filter((r) => r.kind !== 'intent')
    ]
  } else if (ev.kind === 'plan' && ev.plan) {
    const i = trace.value.findIndex((s) => s.kind === 'plan')
    const row: TraceRow = { key: 'plan', kind: 'plan', label: ev.label, plan: ev.plan }
    if (i >= 0) trace.value[i] = row
    else trace.value = [...trace.value.filter((r) => r.kind !== 'plan'), row]
  } else if (ev.kind === 'think') {
    thinking.value = true
    const i = trace.value.findIndex((s) => s.kind === 'think')
    const row: TraceRow = { key: 'think', kind: 'think', label: ev.label, status: 'running' }
    if (i >= 0) trace.value[i] = row
    else trace.value = [row, ...trace.value]
  } else if (ev.kind === 'step' && ev.step) {
    thinking.value = false
    const think = trace.value.find((s) => s.kind === 'think' && s.status === 'running')
    if (think) think.status = 'done'
    upsertStep(ev.step, {
      kind: 'step',
      label: ev.label,
      status: ev.status || 'running'
    })
    syncPlanSteps(ev.step, ev.status || 'running')
  } else if (ev.kind === 'log') {
    thinking.value = ev.label.includes('想')
    const running = [...trace.value].reverse().find((s) => s.kind === 'step' && s.status === 'running')
    const landed = /已上画布|已写入画布|已交付 \d+ 个可编辑分镜/.test(ev.label)
    if (running && (ev.step === running.key || !ev.step)) {
      running.detail = ev.label
      if (landed) {
        running.status = 'done'
        running.label = ev.label
      }
    } else {
      trace.value = [
        ...trace.value,
        { key: `log-${trace.value.length}`, kind: 'log', label: ev.label }
      ]
    }
  }
  void scrollToEnd()
}

function applyCanvasActivity(ev: CanvasActivity) {
  if (ev.source === 'agent' && busy.value) return
  canvasLive.value = true
  if (!busy.value) log.value = ev.message || ev.label
  const landed = /已上画布|已写入画布/.test(ev.message || ev.label || '')
  upsertCanvasStep(ev.nodeId, {
    kind: 'step',
    label: landed && ev.message ? ev.message : ev.label,
    status:
      ev.kind === 'done' || landed ? 'done' : ev.kind === 'error' ? 'fail' : 'running',
    detail: ev.message
  })
  if (ev.kind === 'done' || ev.kind === 'error') {
    void finishCanvasRun(ev)
  }
  void scrollToEnd()
}

async function finishCanvasRun(ev: CanvasActivity) {
  const stillRunning = canvasTrace.value.some(
    (row) => row.kind === 'step' && row.status === 'running' && row.key !== ev.nodeId
  )
  if (stillRunning) return
  if (canvasTrace.value.length) {
    feed.value.push({
      id: `canvas-${Date.now()}`,
      type: 'run',
      rows: canvasTrace.value.map((row) => ({ ...row }))
    })
  }
  const next = nextPipelineStep(project.current)
  const content =
    ev.kind === 'error'
      ? `画布上的「${ev.label}」失败了。\n原因：${ev.message || '未知错误'}\n可以改提示词后在右侧重试，或让我来处理。`
      : `画布上的「${ev.label}」已完成。${ev.message ? `\n${ev.message}` : ''}\n${
          next ? `下一步是「${next.label}」。回「继续」只做这一步。` : '需要继续就直接说下一步。'
        }`
  feed.value.push({ id: `a-${Date.now()}`, type: 'msg', role: 'assistant', content })
  await appendAgentMessage('assistant', content)
  if (!busy.value) {
    chips.value = next
      ? [
          { label: `继续：${next.label}`, text: '继续' },
          { label: '先看看', text: '先看看' }
        ]
      : []
  }
  canvasLive.value = false
  canvasTrace.value = []
  if (!busy.value) log.value = ''
  await scrollToEnd()
}

async function sendText(text: string) {
  const t = text.trim()
  if (!t || busy.value) return
  input.value = ''
  const attachedNames = attachments.value.map((a) => a.name)
  const display = attachedNames.length ? `${t}\n\n📎 ${attachedNames.join('、')}` : t
  const attachOptions = attachments.value.slice()
  feed.value.push({ id: `u-${Date.now()}`, type: 'msg', role: 'user', content: display })
  await appendAgentMessage('user', t)
  attachments.value = []
  busy.value = true
  thinking.value = true
  log.value = attachedNames.length ? `读取附件 ${attachedNames.join('、')}…` : '开始…'
  trace.value = [{ key: 'think', kind: 'think', label: '在想怎么做…', status: 'running' }]
  chips.value = []
  const turnController = new AbortController()
  controller = turnController
  await scrollToEnd()
  try {
    const result = await runAgentTurn(messages.value, t, onProgress, {
      signal: turnController.signal,
      autonomy: autonomy.value,
      selectedNodeId: selectedGenNode.value?.id,
      attachments: attachOptions
    })
    thinking.value = false
    const think = trace.value.find((s) => s.kind === 'think' && s.status === 'running')
    if (think) think.status = 'done'
    for (const row of trace.value) {
      if (row.kind === 'plan' && row.plan) {
        for (const step of row.plan.steps) {
          if (step.status === 'running') step.status = 'done'
        }
      }
    }
    if (trace.value.length) {
      feed.value.push({ id: `run-${Date.now()}`, type: 'run', rows: trace.value.map((row) => ({ ...row, plan: row.plan ? { ...row.plan, steps: row.plan.steps.map((s) => ({ ...s })) } : undefined })) })
    }
    feed.value.push({ id: `a-${Date.now()}`, type: 'msg', role: 'assistant', content: result.reply })
    await appendAgentMessage('assistant', result.reply)
    chips.value = result.chips
  } catch (e: any) {
    thinking.value = false
    attachments.value = attachOptions
    const cancelled = turnController.signal.aborted || (isAbortError(e) && !isTimeoutAbort(e))
    const content = cancelled
      ? '已停止。已完成的产物会保留，未开始的步骤不会继续。'
      : '失败：' + friendlyAiError(e)
    feed.value.push({ id: `a-${Date.now()}`, type: 'msg', role: 'assistant', content })
    await appendAgentMessage('assistant', content)
  } finally {
    busy.value = false
    thinking.value = false
    trace.value = []
    controller = null
    await scrollToEnd()
  }
}

function cancel() {
  controller?.abort()
  log.value = '正在停止…'
}

const copiedMsg = ref('')
let msgTimer: ReturnType<typeof setTimeout> | undefined

async function copyMsg(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      return
    }
  }
  copiedMsg.value = id
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(() => (copiedMsg.value = ''), 1500)
}

async function send() {
  await sendText(input.value)
}

function visibleRows(rows: TraceRow[]) {
  return rows.filter((row) => row.kind !== 'think')
}
</script>

<template>
  <aside class="agent">
    <section class="target" :class="{ empty: !selectedGenNode }">
      <p class="k">当前选中</p>
      <p v-if="selectedGenNode" class="name">
        {{ selectedGenNode.data.label || selectedGenNode.id }}
        <small>{{ selectedKindLabel }}</small>
      </p>
      <p v-else class="name dim">还没选节点。点画布上的图片或视频节点，我来改它的提示词。</p>
      <p v-if="selectedGenNode?.data.prompt" class="preview">{{ selectedGenNode.data.prompt }}</p>
      <div v-if="selectedGenNode && !busy" class="target-chips">
        <button v-for="c in polishChips" :key="c.label" type="button" @click="sendText(c.text)">
          {{ c.label }}
        </button>
      </div>
    </section>

    <div ref="box" class="msgs">
      <template v-for="item in feed" :key="item.id">
        <div v-if="item.type === 'msg'" class="msg" :class="item.role">
          <span v-if="item.role === 'assistant'" class="msg-avatar"><i /></span>
          <div class="bubble">
            <AgentRichText :content="item.content" />
            <button
              v-if="item.role === 'assistant'"
              type="button"
              class="bubble-copy"
              :class="{ ok: copiedMsg === item.id }"
              :title="copiedMsg === item.id ? '已复制' : '复制这条回复'"
              @click="copyMsg(item.id, item.content)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="9" y="9" width="11" height="11" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h8" />
              </svg>
            </button>
          </div>
        </div>
        <div v-else class="turn">
          <AgentTraceList :rows="visibleRows(item.rows)" />
        </div>
      </template>

      <div v-if="canvasLive && canvasTrace.length" class="turn">
        <AgentTraceList :rows="canvasTrace" />
      </div>

      <div v-if="busy" class="turn">
        <div v-if="thinking" class="think">
          <span class="dot-pulse"><i /><i /><i /></span>
          <span>思考中</span>
        </div>
        <AgentTraceList :rows="visibleRows(trace)" />
      </div>
    </div>

    <div v-if="chips.length && !busy && !canvasLive" class="chips">
      <button v-for="c in chips" :key="c.text + c.label" type="button" @click="sendText(c.text)">
        {{ c.label }}
      </button>
    </div>

    <form class="composer" @submit.prevent="send">
      <p v-if="input.trim() && estimate.calls" class="estimate">
        预计 {{ estimate.calls }} 次调用 · 约 {{ Math.max(1, Math.ceil(estimate.seconds / 60)) }} 分钟
      </p>
      <div class="box" :class="{ busy }">
        <div v-if="attachments.length" class="attach-chips">
          <span v-for="(a, i) in attachments" :key="a.path || a.name" class="attach-chip">
            📎 {{ a.name }}
            <button type="button" :disabled="busy" title="移除附件" @click="removeAttachment(i)">×</button>
          </span>
        </div>
        <textarea
          v-model="input"
          rows="5"
          :disabled="busy"
          placeholder="说一句话就行，例如：写一个修仙短剧并出 8 个分镜 / 画一张黄昏的海边 / 把第 3 镜改成手持跟拍"
          @keydown.enter.exact.prevent="send"
        />
        <div class="bar">
          <div class="bar-pop">
            <button
              type="button"
              class="bar-btn attach-btn"
              :disabled="busy"
              title="附加本地文件（txt / md / 剧本等文本），或直接在消息里写文件路径"
              @click.stop="pickAttachments"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12.5l-8.2 8.2a5.6 5.6 0 0 1-7.9-7.9L13 4.7a3.8 3.8 0 0 1 5.4 5.4l-8.1 8.1a1.9 1.9 0 0 1-2.7-2.7l7.5-7.5" />
              </svg>
              <span>附件</span>
            </button>
          </div>
          <div class="bar-pop pref-pop">
            <button
              ref="prefBtn"
              type="button"
              class="bar-btn pref-btn"
              :disabled="busy"
              :title="`创作偏好：比例 ${currentAspectRatio} · 图像 ${activeImageLabel} · 视频 ${activeVideoLabel}`"
              @click.stop="togglePrefPanel"
            >
              <svg viewBox="0 0 24 24" class="pref-icon" aria-hidden="true">
                <path d="M4 8h10M18 8h2M4 16h2M10 16h10" />
                <circle cx="16" cy="8" r="2.2" />
                <circle cx="8" cy="16" r="2.2" />
              </svg>
              <span>创作偏好</span>
            </button>
            <Teleport to="body">
              <div
                v-if="prefOpen"
                ref="prefPanel"
                class="pref-panel"
                :class="{ floating: true }"
                :style="prefStyle"
                @click.stop
              >
              <div class="pref-tabs">
                <button
                  type="button"
                  :class="{ on: prefTab === 'video' }"
                  @click="prefTab = 'video'"
                >
                  视频偏好
                </button>
                <button
                  type="button"
                  :class="{ on: prefTab === 'image' }"
                  @click="prefTab = 'image'"
                >
                  图片偏好
                </button>
                <button type="button" :class="{ on: prefTab === 'knowledge' }" @click="prefTab = 'knowledge'">写作知识库</button>
              </div>
              <div v-if="prefTab !== 'knowledge'" class="pref-body">
                <div class="pref-models">
                  <p class="pref-k">模型选择</p>
                  <template v-if="prefTab === 'video'">
                    <select v-model="videoChoice" class="pref-select" aria-label="选择视频模型">
                      <optgroup label="内置工作流">
                        <option v-for="w in VIDEO_WORKFLOW_OPTIONS" :key="w.value" :value="`workflow:${w.value}`">{{ w.name }}</option>
                      </optgroup>
                      <optgroup v-if="videoProfiles.length" label="已配置的视频接入">
                        <option v-for="p in videoProfiles" :key="p.id" :value="`profile:${p.id}`">{{ videoProfileTag(p) ? `${videoProfileTag(p)} · ${p.name}` : p.name }}</option>
                      </optgroup>
                      <option v-if="!videoProfiles.length && !videoDefault" value="profile:">请选择视频模型</option>
                    </select>
                    <p class="pref-k pref-k-gap">视频分辨率</p>
                    <div class="res-row">
                      <button
                        v-for="r in VIDEO_RES_OPTIONS"
                        :key="r.value"
                        type="button"
                        class="res-btn"
                        :class="{ on: currentVideoResolution === r.value }"
                        @click="pickVideoResolution(r.value)"
                      >
                        {{ r.label }}
                      </button>
                    </div>
                    <p class="pref-hint">1080p 只在 H3 v5 上出到 1080p，其它模型仍按 768p。</p>
                  </template>
                  <template v-else>
                    <select v-model="imageChoice" class="pref-select" aria-label="选择图像模型">
                      <option v-if="!imageProfiles.length" value="">请先在设置中添加图像模型</option>
                      <option v-for="p in imageProfiles" :key="p.id" :value="p.id">{{ p.name }} · {{ p.model }}</option>
                    </select>
                  </template>
                </div>
                <div class="pref-ratios">
                  <p class="pref-k">画面比例</p>
                  <div class="ratio-grid">
                    <button
                      v-for="a in ASPECT_OPTIONS"
                      :key="a.value"
                      type="button"
                      class="ratio-item"
                      :class="{ on: currentAspectRatio === a.value }"
                      @click="pickAspectRatio(a.value)"
                    >
                      <span class="ratio-box" :style="ratioBoxStyle(a.value)" />
                      <span class="ratio-label">{{ a.value }}</span>
                    </button>
                  </div>
                  <p class="pref-hint">选好即生效，智能体生成图片和视频都会照此执行；单个节点仍可单独指定模型。</p>
                </div>
              </div>
              <div v-else class="knowledge-preference">
                <p class="pref-k">选择写作知识库</p>
                <p class="pref-hint">写剧本时参考内置写作方法和原创对白示例；自动匹配按题材关键词选择，与剧本管理同步。</p>
                <div class="knowledge-grid"><button v-for="item in SCRIPT_REFERENCE_OPTIONS" :key="item.value" type="button" class="knowledge-option" :class="{ on: scriptReferenceType === item.value }" @click="scriptReferenceType = item.value">{{ item.label }}</button></div>
              </div>
              </div>
            </Teleport>
          </div>
          <div class="bar-pop skill-pop">
            <button
              ref="skillBtn"
              type="button"
              class="bar-btn pref-btn"
              :class="{ on: activeStyleId !== GENERAL_STORY_SKILL_ID || activeGenreId !== GENERAL_STORY_SKILL_ID }"
              :disabled="busy"
              :title="`技能：${activeStorySkillName}`"
              @click.stop="toggleSkillPanel"
            >
              <svg viewBox="0 0 24 24" class="pref-icon" aria-hidden="true">
                <path d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5V20l-6.5-3.2L5.5 20V6A1.5 1.5 0 0 1 7 4.5Z" />
              </svg>
              <span>技能</span>
            </button>
            <Teleport to="body">
              <div
                v-if="skillOpen"
                ref="skillPanel"
                class="pref-panel skill-panel"
                :style="skillStyle"
                @click.stop
              >
                <div class="pref-tabs">
                  <button type="button" :class="{ on: skillTab === 'style' }" @click="skillTab = 'style'">分镜方式</button>
                  <button type="button" :class="{ on: skillTab === 'genre' }" @click="skillTab = 'genre'">题材与内容</button>
                  <button type="button" :class="{ on: skillTab === 'mine' }" @click="skillTab = 'mine'">我的</button>
                </div>
                <div class="skill-body">
                  <button
                    type="button"
                    class="pref-model"
                    :class="{ on: activeStorySkillId === GENERAL_STORY_SKILL_ID }"
                    @click="pickStorySkill(GENERAL_STORY_SKILL_ID)"
                  >
                    <span class="pref-radio" />
                    <img v-if="storyIcon(GENERAL_STORY_SKILL_ID)" class="skill-icon" :src="storyIcon(GENERAL_STORY_SKILL_ID)" alt="" />
                    <span class="pref-model-text">
                      <b>{{ skillTab === 'genre' ? '不限题材' : '通用分镜' }}</b>
                      <small>{{ skillTab === 'genre' ? '跟随用户要求，不指定题材。' : '按故事需要选择镜头方式。' }}</small>
                    </span>
                  </button>
                  <template v-if="skillTab === 'style'">
                    <button
                      v-for="skill in styleSkills"
                      :key="skill.id"
                      type="button"
                      class="pref-model"
                      :class="{ on: activeStorySkillId === skill.id }"
                      @click="pickStorySkill(skill.id)"
                    >
                      <span class="pref-radio" />
                      <img v-if="storyIcon(skill.id)" class="skill-icon" :src="storyIcon(skill.id)" alt="" />
                      <span class="pref-model-text">
                        <b>{{ skill.name }}</b>
                        <small>{{ skill.summary }}</small>
                      </span>
                    </button>
                  </template>
                  <template v-else-if="skillTab === 'genre'">
                    <button
                      v-for="skill in genreSkills"
                      :key="skill.id"
                      type="button"
                      class="pref-model"
                      :class="{ on: activeStorySkillId === skill.id }"
                      @click="pickStorySkill(skill.id)"
                    >
                      <span class="pref-radio" />
                      <img v-if="storyIcon(skill.id)" class="skill-icon" :src="storyIcon(skill.id)" alt="" />
                      <span class="pref-model-text">
                        <b>{{ skill.name }}</b>
                        <small>{{ skill.summary }}</small>
                      </span>
                    </button>
                  </template>
                  <template v-else>
                    <button
                      v-if="importedSkill"
                      type="button"
                      class="pref-model"
                      :class="{ on: activeStorySkillId === CUSTOM_STORY_SKILL_ID }"
                      @click="pickStorySkill(CUSTOM_STORY_SKILL_ID)"
                    >
                      <span class="pref-radio" />
                      <span class="pref-model-text">
                        <b>{{ importedSkill.name }}</b>
                        <small>{{ importedSkill.filename || '导入的 SKILL.md' }}</small>
                      </span>
                    </button>
                    <p v-else class="pref-empty">还没有导入。可以放一份 SKILL.md 或 README.md。</p>
                    <div class="skill-acts">
                      <button type="button" class="skill-act" :disabled="importingSkill" @click="importStorySkill">
                        {{ importingSkill ? '正在读取…' : importedSkill ? '更换技能' : '导入技能' }}
                      </button>
                      <button
                        v-if="isDesktop()"
                        type="button"
                        class="skill-act"
                        :disabled="importingSkill"
                        @click="importStorySkillFolder"
                      >
                        导入文件夹
                      </button>
                      <button v-if="importedSkill" type="button" class="skill-act danger" @click="clearImportedSkill">清除</button>
                    </div>
                  </template>
                  <p class="pref-hint">分镜方式与题材可以同时选择。写剧本、拆分镜和优化视频提示词时作为建议参考；用户要求和剧本内容优先。</p>
                </div>
              </div>
            </Teleport>
          </div>
          <button
            v-if="busy"
            type="button"
            class="icon-act stop"
            title="停止"
            @click="cancel"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="1.5" />
            </svg>
          </button>
          <button
            v-else
            type="submit"
            class="icon-act send"
            title="发送"
            :disabled="!input.trim()"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h12M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </form>
  </aside>
</template>

<style scoped>
.agent {
  position: relative;
  width: 100%;
  height: 100%;
  flex-shrink: 0;
  min-width: 0;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-1);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-x: hidden;
}

/* ── 选中节点卡片（自由画布） ── */
.target {
  margin: 12px 14px 8px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(126, 180, 255, 0.06), rgba(126, 180, 255, 0.02));
}
.target.empty {
  border-style: dashed;
  background: none;
}
.k {
  margin: 0;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.06em;
  color: var(--color-text-4);
}
.name {
  margin: 4px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
}
.name small {
  margin-left: 8px;
  font-weight: 400;
  color: var(--color-text-3);
}
.name.dim,
.preview.dim {
  font-weight: 400;
  color: var(--color-text-4);
}
.preview {
  margin: 6px 0 0;
  max-height: 60px;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.55;
  color: var(--color-text-3);
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.target-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}
.target-chips button {
  margin: 0;
  padding: 3px 9px;
  border: 1px solid rgba(126, 180, 255, 0.3);
  border-radius: 99px;
  background: rgba(126, 180, 255, 0.08);
  color: var(--color-accent);
  font-size: 11px;
  cursor: pointer;
}
.target-chips button:hover {
  background: rgba(126, 180, 255, 0.16);
}

/* ── 消息流 ── */
.msgs {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 8px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  animation: msg-in 0.24s ease;
}
@keyframes msg-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.msg.user {
  justify-content: flex-end;
}
.msg-avatar {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  margin-top: 2px;
  border-radius: 8px;
  background: linear-gradient(135deg, #7eb4ff 0%, #a78bfa 60%, #f0abfc 100%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.msg-avatar i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(16, 19, 26, 0.8);
}
.bubble {
  min-width: 0;
  max-width: 100%;
  padding: 9px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.msg.user .bubble {
  max-width: 88%;
  padding: 8px 12px;
  border-radius: 14px 14px 4px 14px;
  background: linear-gradient(135deg, rgba(126, 180, 255, 0.22), rgba(167, 139, 250, 0.18));
  border: 1px solid rgba(126, 180, 255, 0.25);
  color: var(--color-text-1);
}
.msg.assistant .bubble {
  position: relative;
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: 4px 12px 12px 12px;
  background: var(--color-bg-2);
}
.bubble-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-1);
  color: var(--color-text-4);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.msg:hover .bubble-copy {
  opacity: 1;
}
.bubble-copy:hover {
  color: var(--color-text-1);
  border-color: rgba(126, 180, 255, 0.5);
}
.bubble-copy.ok {
  opacity: 1;
  color: var(--color-success);
  border-color: rgba(74, 222, 128, 0.5);
}
.bubble-copy svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.turn {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0 2px;
  border-top: 1px solid var(--color-border);
  min-width: 0;
}

/* ── 执行轨迹 ── */
.think {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-3);
}
.dot-pulse {
  display: inline-flex;
  gap: 4px;
}
.dot-pulse i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-text-1);
  animation: dot-bounce 1s ease-in-out infinite;
}
.dot-pulse i:nth-child(2) { animation-delay: 0.15s; }
.dot-pulse i:nth-child(3) { animation-delay: 0.3s; }
@keyframes dot-bounce {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}
/* ── 快捷指令 ── */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 10px;
  min-width: 0;
  overflow-x: hidden;
}
.chips button {
  margin: 0;
  padding: 5px 12px;
  border: none;
  border-radius: 99px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 11px;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.chips button:hover {
  background: var(--color-fill-hover);
  color: var(--color-text-1);
}

/* ── 输入区 ── */
.composer {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--color-border);
  min-width: 0;
}
.estimate {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
.box {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 14px;
  padding: 8px 8px 6px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.box:focus-within {
  border-color: rgba(126, 180, 255, 0.5);
  box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.1);
}
textarea {
  width: 100%;
  min-height: 96px;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text-1);
  padding: 4px 6px 8px;
  font: inherit;
  font-size: 13px;
  line-height: 1.55;
}
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  min-width: 0;
}
.bar-pop {
  position: relative;
  flex-shrink: 0;
}
.attach-btn svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.attach-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 6px 6px;
}
.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(126, 180, 255, 0.12);
  color: #9db9ff;
  font-size: 11px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.attach-chip button {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 0 1px;
}
.bar-btn {
  height: 28px;
  margin: 0;
  min-width: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
  transition: background-color 0.15s, color 0.15s;
}
.bar-btn:hover:not(:disabled) {
  background: var(--color-fill-hover);
  color: var(--color-text-1);
}
.bar-btn:active:not(:disabled) {
  background: var(--color-fill-strong);
}
.bar-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.bar-btn i {
  width: 0;
  height: 0;
  border-left: 3.5px solid transparent;
  border-right: 3.5px solid transparent;
  border-top: 4px solid currentColor;
  opacity: 0.7;
}
.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 8;
  width: 220px;
  padding: 6px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-1);
  box-shadow: var(--shadow-md);
}
.model-menu {
  width: 248px;
  max-height: 280px;
  overflow: auto;
  right: 0;
  left: auto;
}
/* ── 创作偏好弹窗 ── */
.pref-btn {
  gap: 5px;
  padding: 0 10px;
}
.pref-btn.on {
  color: var(--color-text-1);
  background: var(--color-fill);
}
.skill-panel {
  width: 560px;
}
.skill-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
}
.skill-body .pref-model { align-items: center; min-height: 58px; }
.skill-body .pref-radio { margin-top: 0; }
.skill-icon { width: 44px; height: 44px; object-fit: contain; flex: 0 0 44px; }
.skill-body .pref-model-text small { white-space: normal; line-height: 1.45; }
.skill-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.skill-act {
  height: 30px;
  margin: 0;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
  cursor: pointer;
}
.skill-act.danger {
  color: var(--color-error, #f87171);
}
.skill-act:disabled {
  opacity: 0.45;
  cursor: default;
}
.pref-icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
}
.pref-panel {
  position: fixed;
  z-index: 2000;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-bg-1);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
  overflow: auto;
  animation: pref-pop 0.12s ease-out;
}
@keyframes pref-pop {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.pref-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px 0;
}
.pref-tabs button {
  margin: 0;
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.pref-tabs button.on {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.pref-body {
  display: grid;
  grid-template-columns: 1fr 190px;
  gap: 0;
  padding: 10px;
}
.pref-models {
  min-width: 0;
  padding-right: 10px;
  border-right: 1px solid var(--color-border);
  max-height: 520px;
  overflow: auto;
}
.pref-select {
  display: block;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
}
.knowledge-preference { padding: 14px; }
.knowledge-preference .pref-hint { margin: 4px 0 14px; }
.knowledge-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 8px; }
.knowledge-option { padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-2); color: var(--color-text-2); text-align: left; cursor: pointer; }
.knowledge-option.on { border-color: var(--color-accent); color: var(--color-text-1); background: var(--color-fill); }
.pref-k-gap {
  margin-top: 14px;
}
.res-row {
  display: flex;
  gap: 8px;
  padding: 0 4px 6px;
}
.res-btn {
  height: 32px;
  min-width: 72px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  font-size: 12px;
  cursor: pointer;
}
.res-btn.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: var(--grad-primary-soft, rgba(126, 180, 255, 0.16));
}

/* 偏好面板里的分组小标题（视频工作流 / 已配置接入） */
.pref-g {
  margin: 10px 4px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--color-text-4);
}
.pref-g:first-child {
  margin-top: 2px;
}
.pref-empty {
  margin: 4px;
  padding: 10px;
  font-size: 11px;
  color: var(--color-text-4);
}
.pref-model {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  margin: 0 0 2px;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.pref-model:hover {
  background: var(--color-fill);
}
.pref-model.on {
  background: var(--color-fill);
}
.pref-radio {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  margin-top: 2px;
  border: 1.5px solid var(--color-text-4);
  border-radius: 50%;
}
.pref-model.on .pref-radio {
  border-color: var(--color-primary, #7c6cff);
  background: var(--color-primary, #7c6cff);
  box-shadow: inset 0 0 0 2.5px var(--color-bg-1);
}
.pref-model-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pref-model-text b {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pref-model-text small {
  font-size: 10.5px;
  color: var(--color-text-4);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pref-ratios {
  padding-left: 12px;
}
.ratio-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ratio-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 56px;
  height: 56px;
  margin: 0;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: transparent;
  color: var(--color-text-3);
  cursor: pointer;
}
.ratio-item:hover {
  background: var(--color-fill);
}
.ratio-item.on {
  border-color: var(--color-primary, #7c6cff);
  background: var(--color-fill);
  color: var(--color-text-1);
}
.ratio-box {
  border: 1.5px solid currentColor;
  border-radius: 3px;
}
.ratio-label {
  font-size: 10px;
}
.pref-hint {
  margin: 10px 2px 2px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--color-text-4);
}
.menu-g {
  margin: 8px 8px 4px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--color-text-4);
}
.menu-g:first-of-type {
  margin-top: 2px;
}
.empty {
  margin: 0 8px 8px;
  font-size: 11px;
  color: var(--color-text-4);
}
.menu > button,
.model-item {
  display: block;
  width: 100%;
  margin: 0;
  padding: 7px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-2);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.model-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.menu > button.on,
.menu > button:hover,
.model-item.on,
.model-item:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.tip {
  margin: 6px 2px 2px;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-4);
}
.icon-act {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  margin: 0 0 0 auto;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-act svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.send {
  background: linear-gradient(135deg, #7eb4ff, #a78bfa);
  color: #fff;
  transition: transform 0.12s, box-shadow 0.2s;
}
.send:hover:not(:disabled) {
  box-shadow: 0 4px 14px rgba(126, 180, 255, 0.35);
  transform: translateY(-1px);
}
.send:disabled {
  opacity: 0.35;
  cursor: default;
}
.stop {
  background: transparent;
  color: var(--color-error);
  border: 1px solid rgba(185, 28, 28, 0.35);
  border-radius: 10px;
}
.stop svg {
  fill: currentColor;
  stroke: none;
}
</style>
