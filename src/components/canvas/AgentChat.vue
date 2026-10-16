<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { runAgentTurn, type AgentEvent, type AgentMessage } from '@/services/canvas/agent'
import { friendlyAiError, isAbortError, isTimeoutAbort } from '@/services/ai/abort'
import { appendAgentMessage, getAgentState, setAgentAutonomy } from '@/services/canvas/taskStore'
import { estimateRequestText } from '@/services/canvas/toolRegistry'
import { onCanvasActivity, type CanvasActivity } from '@/services/canvas/canvasBridge'
import { nextPipelineStep } from '@/services/canvas/pipeline'
import { useProjectStore, useSettingsStore } from '@/stores'
import type { TraceRow, TraceStatus } from '@/services/canvas/agentTrace'
import type { AgentAutonomy, AspectRatio, CanvasNode } from '@/types'
import AgentMemoryPanel from './AgentMemoryPanel.vue'
import AgentRichText from './AgentRichText.vue'
import AgentTraceList from './AgentTraceList.vue'

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
  '我是这张画布的创作搭档，两种用法都行：\n\n- **一句话开工**：说「写一个修仙短剧，8 个分镜」或「画一张黄昏的海边」，我直接建节点、写提示词、跑生成\n- **自己拼**：在画布空白处右键添加图片 / 视频 / 剧本 / 角色 / 场景 / 分镜，点选节点后让我改提示词、重跑\n\n我也带本地记忆——说「记住…」以后一直生效。想一次做到底就说「全流程」，否则我做一步停一步等你确认。'

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
const modeOpen = ref(false)
const memoryOpen = ref(false)
const canvasLive = ref(false)
const canvasTrace = ref<TraceRow[]>([])
const project = useProjectStore()
let offActivity: (() => void) | undefined
const hoverMode = ref<AgentAutonomy | null>(null)
const settings = useSettingsStore()
let controller: AbortController | null = null

/* ── 生成配置：比例 / 图像模型 / 视频模型，选好即生效，智能体照此执行 ── */
const currentMode = computed(() => MODES.find((m) => m.id === autonomy.value) || MODES[1])
const modeTip = computed(() => {
  const id = hoverMode.value || autonomy.value
  return MODES.find((m) => m.id === id)?.desc || ''
})
const ASPECT_OPTIONS: { value: AspectRatio; label: string }[] = [
  { value: '16:9', label: '横版 16:9' },
  { value: '9:16', label: '竖版 9:16' },
  { value: '1:1', label: '方形 1:1' },
  { value: '4:3', label: '传统 4:3' },
  { value: '21:9', label: '影院 21:9' }
]
/* 创作偏好弹窗：比例 + 图像/视频模型收进一个面板 */
const prefOpen = ref(false)
const prefTab = ref<'video' | 'image'>('video')
/* 父容器 overflow 会裁剪浮层，所以传送到 body 按按钮位置定位 */
const prefBtn = ref<HTMLElement | null>(null)
const prefPanel = ref<HTMLElement | null>(null)
const PANEL_WIDTH = 480
const prefStyle = ref<Record<string, string>>({})

function placePrefPanel() {
  const rect = prefBtn.value?.getBoundingClientRect()
  if (!rect) return
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(PANEL_WIDTH, vw - 24)
  const left = Math.max(12, Math.min(rect.left, vw - width - 12))
  const spaceAbove = rect.top - 12
  const spaceBelow = vh - rect.bottom - 12
  const style: Record<string, string> = { left: `${Math.round(left)}px`, width: `${Math.round(width)}px` }
  // 上下哪边空间大就往哪边展开，不够时压缩高度并内部滚动
  if (spaceAbove >= 260 || spaceAbove >= spaceBelow) {
    style.bottom = `${Math.round(vh - rect.top + 6)}px`
    style.maxHeight = `${Math.round(Math.max(180, Math.min(spaceAbove, 460)))}px`
  } else {
    style.top = `${Math.round(rect.bottom + 6)}px`
    style.maxHeight = `${Math.round(Math.max(180, Math.min(spaceBelow, 460)))}px`
  }
  prefStyle.value = style
}

function togglePrefPanel() {
  prefOpen.value = !prefOpen.value
  if (prefOpen.value) {
    prefStyle.value = {}
    nextTick(placePrefPanel)
  }
  modeOpen.value = false
}

function closePrefPanel() {
  prefOpen.value = false
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
  settings.selectVideo(id)
}

const MODES: { id: AgentAutonomy; label: string; desc: string }[] = [
  {
    id: 'assist',
    label: '陪我做',
    desc: '每一步都先问你再动手，适合一起磨剧本、分镜和提示词。'
  },
  {
    id: 'gated',
    label: '关键确认',
    desc: '能连续做几步，但写完剧本、拆人物/场景/分镜、验收这些关键点会停下来问你。'
  },
  {
    id: 'autopilot',
    label: '全自动',
    desc: '按你这句话尽量一路做完，中途失败才停。要出片仍需说「全流程」。'
  }
]

const estimate = computed(() => estimateRequestText(input.value))
const statusText = computed(() => {
  if (busy.value) {
    if (thinking.value) return '思考中'
    return log.value || '执行中'
  }
  if (canvasLive.value) return log.value || '画布生成中'
  return currentMode.value.label
})
const statusLive = computed(() => busy.value || canvasLive.value)

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
  autonomy.value = saved.autonomy
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
  window.addEventListener('resize', placePrefPanel)
  window.addEventListener('scroll', placePrefPanel, true)
  window.addEventListener('keydown', onGlobalKey, true)
  offActivity = onCanvasActivity(applyCanvasActivity)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('resize', placePrefPanel)
  window.removeEventListener('scroll', placePrefPanel, true)
  window.removeEventListener('keydown', onGlobalKey, true)
  offActivity?.()
})

function onGlobalKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && prefOpen.value) closePrefPanel()
}

function onDocPointer(ev: PointerEvent) {
  const el = ev.target as HTMLElement | null
  const inPref = !!el && (!!el.closest('.pref-pop') || !!prefPanel.value?.contains(el))
  if (!el?.closest('.bar-pop') && !inPref) {
    modeOpen.value = false
    closePrefPanel()
  }
  if (!el?.closest('.mem-pop')) memoryOpen.value = false
}

async function chooseAutonomy(mode: AgentAutonomy) {
  autonomy.value = mode
  modeOpen.value = false
  hoverMode.value = null
  await setAgentAutonomy(mode)
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
  feed.value.push({ id: `u-${Date.now()}`, type: 'msg', role: 'user', content: t })
  await appendAgentMessage('user', t)
  busy.value = true
  thinking.value = true
  log.value = '开始…'
  trace.value = [{ key: 'think', kind: 'think', label: '在想怎么做…', status: 'running' }]
  chips.value = []
  const turnController = new AbortController()
  controller = turnController
  await scrollToEnd()
  try {
    const result = await runAgentTurn(messages.value, t, onProgress, {
      signal: turnController.signal,
      autonomy: autonomy.value,
      selectedNodeId: selectedGenNode.value?.id
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
    <header class="head">
      <div class="head-id">
        <span class="avatar" :class="{ live: statusLive }"><i /></span>
        <div class="head-txt">
          <strong>智能体</strong>
          <span class="sub" :class="{ live: statusLive }">{{ statusText }}</span>
        </div>
      </div>
      <div class="mem-pop">
        <button
          type="button"
          class="head-btn"
          :class="{ on: memoryOpen }"
          title="本地记忆"
          @click.stop="memoryOpen = !memoryOpen"
        >
          <svg viewBox="0 0 24 24">
            <path d="M12 4a4 4 0 0 1 4 4c1.8.6 3 2.2 3 4.2A4.3 4.3 0 0 1 14.7 16H9.3A4.3 4.3 0 0 1 5 12.2c0-2 1.2-3.6 3-4.2a4 4 0 0 1 4-4z" />
            <path d="M9 16v2.5M15 16v2.5M12 16V20" />
          </svg>
        </button>
        <AgentMemoryPanel v-if="memoryOpen" @close="memoryOpen = false" />
      </div>
    </header>

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
              class="bar-btn"
              :disabled="busy"
              :title="currentMode.desc"
              @click.stop="modeOpen = !modeOpen; prefOpen = false"
            >
              {{ currentMode.label }}
              <i />
            </button>
            <div v-if="modeOpen" class="menu" @click.stop>
              <button
                v-for="m in MODES"
                :key="m.id"
                type="button"
                :class="{ on: autonomy === m.id }"
                @mouseenter="hoverMode = m.id"
                @mouseleave="hoverMode = null"
                @click="chooseAutonomy(m.id)"
              >
                {{ m.label }}
              </button>
              <p class="tip">{{ modeTip }}</p>
            </div>
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
              </div>
              <div class="pref-body">
                <div class="pref-models">
                  <p class="pref-k">模型选择</p>
                  <template v-if="prefTab === 'video'">
                    <p v-if="!videoProfiles.length" class="pref-empty">
                      还没有视频模型，去「设置」里添加一个
                    </p>
                    <button
                      v-for="p in videoProfiles"
                      :key="p.id"
                      type="button"
                      class="pref-model"
                      :class="{ on: p.id === activeVideo?.id }"
                      @click="pickVideo(p.id)"
                    >
                      <span class="pref-radio" />
                      <span class="pref-model-text">
                        <b>{{ p.name }}</b>
                        <small>{{ videoSub(p) }}</small>
                      </span>
                    </button>
                  </template>
                  <template v-else>
                    <p v-if="!imageProfiles.length" class="pref-empty">
                      还没有图像模型，去「设置」里添加一个
                    </p>
                    <button
                      v-for="p in imageProfiles"
                      :key="p.id"
                      type="button"
                      class="pref-model"
                      :class="{ on: p.id === activeImage?.id }"
                      @click="pickImage(p.id)"
                    >
                      <span class="pref-radio" />
                      <span class="pref-model-text">
                        <b>{{ p.name }}</b>
                        <small>{{ p.model }}</small>
                      </span>
                    </button>
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

/* ── 头部 ── */
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 12px 10px 16px;
}
.head-id {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.avatar {
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: 9px;
  background: linear-gradient(135deg, #7eb4ff 0%, #a78bfa 60%, #f0abfc 100%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.avatar i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgba(16, 19, 26, 0.85);
  transition: background 0.25s;
}
.avatar.live i {
  background: #4ade80;
  box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.25);
  animation: breathe 1.6s ease-in-out infinite;
}
@keyframes breathe {
  0%, 100% { box-shadow: 0 0 0 2px rgba(74, 222, 128, 0.18); }
  50% { box-shadow: 0 0 0 5px rgba(74, 222, 128, 0.1); }
}
.head-txt {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.head-txt strong {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.head-txt .sub {
  font-size: 10px;
  color: var(--color-text-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}
.head-txt .sub.live {
  color: var(--color-accent);
}
.head-btn {
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.head-btn:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.head-btn.on {
  background: rgba(126, 180, 255, 0.14);
  border-color: rgba(126, 180, 255, 0.4);
  color: var(--color-accent);
}
.head-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.mem-pop {
  position: relative;
  flex-shrink: 0;
}

/* ── 选中节点卡片（自由画布） ── */
.target {
  margin: 0 14px 8px;
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
  border: 1px solid var(--color-border);
  border-radius: 99px;
  background: transparent;
  color: var(--color-text-2);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.chips button:hover {
  border-color: rgba(126, 180, 255, 0.5);
  background: rgba(126, 180, 255, 0.08);
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
.bar-btn {
  height: 28px;
  margin: 0;
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: var(--color-fill);
  color: var(--color-text-2);
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  white-space: nowrap;
  overflow: hidden;
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
  max-height: 260px;
  overflow: auto;
}
.pref-k {
  margin: 2px 4px 8px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--color-text-4);
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
