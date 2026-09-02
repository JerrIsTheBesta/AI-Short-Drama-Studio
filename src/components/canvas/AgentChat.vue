<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import { runAgentTurn, type AgentEvent, type AgentMessage } from '@/services/canvas/agent'
import { friendlyAiError, isAbortError, isTimeoutAbort } from '@/services/ai/abort'
import { appendAgentMessage, getAgentState, setAgentAutonomy } from '@/services/canvas/taskStore'
import { estimateRequestText } from '@/services/canvas/toolRegistry'
import { onCanvasActivity, type CanvasActivity } from '@/services/canvas/canvasBridge'
import { nextPipelineStep } from '@/services/canvas/pipeline'
import { useProjectStore, useSettingsStore } from '@/stores'
import { llmModelGroups } from '@/stores/settings'
import type { AgentAutonomy } from '@/types'

type StepStatus = 'running' | 'done' | 'fail'
type TraceRow = {
  key: string
  kind: 'think' | 'plan' | 'step' | 'log'
  label: string
  status?: StepStatus
  detail?: string
}

type FeedItem =
  | { id: string; type: 'msg'; role: 'user' | 'assistant'; content: string }
  | { id: string; type: 'run'; rows: TraceRow[] }

const feed = ref<FeedItem[]>([
  {
    id: 'welcome',
    type: 'msg',
    role: 'assistant',
    content:
      '我能直接读取和操作当前画布：写或修改剧本与分镜、重写某一镜的图片/视频提示词、创建生成节点，并按你的要求出图或出视频。你可以直接说结果，例如“把第3镜改成手持跟拍并重新出图”。关键制作阶段仍会按当前确认模式停下来问你。'
  }
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
  { label: '全流程', text: '全流程跑完' }
])
const box = ref<HTMLElement | null>(null)
const autonomy = ref<AgentAutonomy>('gated')
const modeOpen = ref(false)
const modelOpen = ref(false)
const canvasLive = ref(false)
const canvasTrace = ref<TraceRow[]>([])
const project = useProjectStore()
let offActivity: (() => void) | undefined
const hoverMode = ref<AgentAutonomy | null>(null)
const settings = useSettingsStore()
let controller: AbortController | null = null

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

const currentMode = computed(() => MODES.find((m) => m.id === autonomy.value) || MODES[1])
const modeTip = computed(() => {
  const id = hoverMode.value || autonomy.value
  return MODES.find((m) => m.id === id)?.desc || ''
})

const llmList = computed(() => settings.config.llms ?? [])
const llmGroups = computed(() => llmModelGroups(llmList.value))
const activeLlm = computed(
  () => llmList.value.find((p) => p.id === settings.config.activeLlmId) || llmList.value[0]
)
const activeLlmLabel = computed(() => {
  const p = activeLlm.value
  if (!p) return '选择 LLM'
  return p.model ? `${p.name} · ${p.model}` : p.name
})

const estimate = computed(() => estimateRequestText(input.value))
const statusText = computed(() => {
  if (busy.value) {
    if (thinking.value) return '思考中'
    return log.value || '执行中'
  }
  if (canvasLive.value) return log.value || '画布生成中'
  return currentMode.value.label
})

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
  offActivity = onCanvasActivity(applyCanvasActivity)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointer, true)
  offActivity?.()
})

function onDocPointer(ev: PointerEvent) {
  const el = ev.target as HTMLElement | null
  if (!el?.closest('.bar-pop')) {
    modeOpen.value = false
    modelOpen.value = false
  }
}

function pickLlmModel(profileId: string, model: string) {
  settings.selectLlmModel(profileId, model)
  modelOpen.value = false
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

function onProgress(ev: AgentEvent) {
  log.value = ev.label
  if (ev.kind === 'think') {
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
      ? `画布上的「${ev.label}」失败了。\n原因：${ev.message || '未知错误'}\n可以改提示词后在右侧重试，或回「继续」走别的步骤。`
      : `画布上的「${ev.label}」已完成。${ev.message ? `\n${ev.message}` : ''}\n${
          next ? `下一步是「${next.label}」。回「继续」只做这一步。` : '这条流水线目前齐了。'
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
      autonomy: autonomy.value
    })
    thinking.value = false
    const think = trace.value.find((s) => s.kind === 'think' && s.status === 'running')
    if (think) think.status = 'done'
    if (trace.value.length) {
      feed.value.push({ id: `run-${Date.now()}`, type: 'run', rows: trace.value.map((row) => ({ ...row })) })
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

async function send() {
  await sendText(input.value)
}
</script>

<template>
  <aside class="agent">
    <header class="head">
      <strong>智能体</strong>
      <span :class="{ live: busy || canvasLive }">{{ statusText }}</span>
    </header>

    <div ref="box" class="msgs">
      <template v-for="item in feed" :key="item.id">
        <div v-if="item.type === 'msg'" class="msg" :class="item.role">
          {{ item.content }}
        </div>
        <div v-else class="turn">
          <ol class="trace">
            <li
              v-for="s in item.rows.filter((row) => row.kind !== 'think')"
              :key="s.key"
              :class="[s.kind, s.status]"
            >
              <i />
              <div>
                <p>{{ s.label }}</p>
                <small v-if="s.detail">{{ s.detail }}</small>
              </div>
            </li>
          </ol>
        </div>
      </template>

      <div v-if="canvasLive && canvasTrace.length" class="turn live">
        <ol class="trace">
          <li
            v-for="s in canvasTrace"
            :key="'c-' + s.key"
            :class="[s.kind, s.status]"
          >
            <i />
            <div>
              <p>{{ s.label }}</p>
              <small v-if="s.detail">{{ s.detail }}</small>
            </div>
          </li>
        </ol>
      </div>

      <div v-if="busy" class="turn live">
        <div v-if="thinking" class="think">
          <i class="dots" />
          <span>思考中</span>
        </div>
        <ol class="trace">
          <li
            v-for="s in trace.filter((row) => row.kind !== 'think')"
            :key="s.key"
            :class="[s.kind, s.status]"
          >
            <i />
            <div>
              <p>{{ s.label }}</p>
              <small v-if="s.detail">{{ s.detail }}</small>
            </div>
          </li>
        </ol>
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
      <div class="box">
        <textarea
          v-model="input"
          rows="5"
          :disabled="busy"
          placeholder="直接说你想让画布变成什么样，例如：改第3镜提示词并重新出图"
          @keydown.enter.exact.prevent="send"
        />
        <div class="bar">
          <div class="bar-pop">
            <button
              type="button"
              class="bar-btn"
              :disabled="busy"
              :title="currentMode.desc"
              @click.stop="modeOpen = !modeOpen; modelOpen = false"
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
          <div class="bar-pop model-pop">
            <button
              type="button"
              class="bar-btn model-btn"
              :disabled="busy"
              :title="activeLlmLabel"
              @click.stop="modelOpen = !modelOpen; modeOpen = false"
            >
              <span>{{ activeLlmLabel }}</span>
              <i />
            </button>
            <div v-if="modelOpen" class="menu model-menu" @click.stop>
              <p class="menu-k">选择模型</p>
              <p v-if="!llmGroups.length" class="empty">请先到设置里添加 LLM，并填模型名</p>
              <template v-for="g in llmGroups" :key="g.id">
                <p class="menu-g">{{ g.name }}</p>
                <p v-if="!g.models.length" class="empty">这项还没填模型名</p>
                <button
                  v-for="m in g.models"
                  :key="`${g.id}::${m}`"
                  type="button"
                  class="model-item"
                  :class="{ on: g.id === settings.config.activeLlmId && m === settings.config.llm.model }"
                  @click="pickLlmModel(g.id, m)"
                >
                  <span>{{ m }}</span>
                </button>
              </template>
            </div>
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
  width: 440px;
  flex-shrink: 0;
  min-width: 0;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-1);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-x: hidden;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px 10px;
}
.head strong {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.head span {
  font-size: 11px;
  color: var(--color-text-4);
}
.head span.live {
  color: var(--color-text-1);
}
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
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  max-width: 100%;
}
.msg.user {
  align-self: flex-end;
  max-width: 88%;
  padding: 8px 12px;
  border-radius: 12px 12px 4px 12px;
  background: var(--color-fill);
  color: var(--color-text-1);
}
.msg.assistant {
  color: var(--color-text-2);
  padding: 0;
  background: none;
}
.turn {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0 2px;
  border-top: 1px solid var(--color-border);
}
.think {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-3);
}
.dots {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-1);
  box-shadow: 12px 0 0 var(--color-text-1), 24px 0 0 var(--color-text-1);
  animation: pulse 1s ease-in-out infinite;
  margin-right: 24px;
}
@keyframes pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.trace {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.trace li {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  padding: 5px 0;
  font-size: 12px;
  color: var(--color-text-3);
  min-width: 0;
}
.trace li i {
  width: 7px;
  height: 7px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--color-text-4);
}
.trace li p,
.trace li small {
  margin: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.trace li small {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--color-text-4);
}
.trace li.think.running,
.trace li.step.running {
  color: var(--color-text-1);
}
.trace li.running i {
  background: var(--color-text-1);
  box-shadow: none;
}
.trace li.done {
  color: var(--color-text-3);
}
.trace li.done i {
  background: var(--color-success);
}
.trace li.fail {
  color: var(--color-error);
}
.trace li.fail i {
  background: var(--color-error);
}
.trace li.log {
  color: var(--color-text-4);
}
.trace li.log i {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--color-text-4);
}
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
  padding: 5px 10px;
  border: 1px solid var(--color-border);
  border-radius: 99px;
  background: transparent;
  color: var(--color-text-2);
  font-size: 11px;
  cursor: pointer;
}
.chips button:hover {
  border-color: var(--color-text-1);
  color: var(--color-text-1);
}
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
  border-radius: 12px;
  padding: 8px 8px 6px;
}
textarea {
  width: 100%;
  min-height: 108px;
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
.model-pop {
  min-width: 0;
  flex: 1;
  max-width: 220px;
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
.model-btn {
  width: 100%;
  max-width: 100%;
}
.model-btn span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
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
  width: 28px;
  height: 28px;
  margin: 0 0 0 auto;
  padding: 0;
  border: none;
  border-radius: 8px;
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
  background: #ececef;
  color: #111;
  border-radius: 50%;
}
.send:disabled {
  opacity: 0.35;
  cursor: default;
}
.stop {
  background: transparent;
  color: var(--color-error);
  border: 1px solid rgba(185, 28, 28, 0.35);
}
.stop svg {
  fill: currentColor;
  stroke: none;
}
</style>
