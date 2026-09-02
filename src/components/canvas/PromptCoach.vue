<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { optimizeNodePrompt } from '@/services/ai/promptCoach'
import { friendlyAiError, isAbortError, isTimeoutAbort } from '@/services/ai/abort'
import { llmModelGroups } from '@/stores/settings'
import { useProjectStore, useSettingsStore } from '@/stores'
import type { CanvasNode } from '@/types'

const props = defineProps<{
  node: CanvasNode | null
}>()

const project = useProjectStore()
const settings = useSettingsStore()
const input = ref('')
const busy = ref(false)
const status = ref('')
const scriptOpen = ref(false)
const modelOpen = ref(false)
const box = ref<HTMLElement | null>(null)
const feed = ref<Array<{ id: string; role: 'user' | 'assistant'; content: string }>>([
  {
    id: 'welcome',
    role: 'assistant',
    content:
      '选中画布上的图片或视频节点。我只加厚当前提示词的画面，标题和分段格式一律不动。有剧本或剧情备注就贴到下面，扩写时会对照。'
  }
])

type UndoSnap = { nodeId: string; prompt: string }
const undo = ref<UndoSnap | null>(null)
let controller: AbortController | null = null

const nodeKind = computed(() => {
  if (props.node?.type === 'videoGen') return 'video' as const
  if (props.node?.type === 'imageGen') return 'image' as const
  return null
})
const nodeTitle = computed(() => {
  if (!props.node) return ''
  return props.node.data.label || (nodeKind.value === 'video' ? '视频节点' : '图片节点')
})
const nodeKindLabel = computed(() => {
  if (nodeKind.value === 'video') return '图生视频'
  if (nodeKind.value === 'image') return '生图'
  return ''
})
const currentPrompt = computed(() => props.node?.data.prompt?.trim() || '')
const canOptimize = computed(() => Boolean(nodeKind.value) && !busy.value)
const scriptText = computed({
  get: () => project.current?.script?.content || '',
  set(value: string) {
    const script = project.current?.script
    if (!script) return
    project.setScript({ ...script, content: value })
  }
})

const chips = [
  { label: '更有画面感', text: '补构图、光影、材质和空气感。不要改剧情，不要改原文格式。' },
  { label: '写清动作表情', text: '把眉眼嘴、手和身体怎么动写具体。不要改原文格式和分段标题。' },
  { label: '按剧情对齐', text: '对照剧情参考，只写这一镜该发生的事。不要改原文格式。' }
]

const llmList = computed(() => settings.config.llms ?? [])
const llmGroups = computed(() => llmModelGroups(llmList.value))
const activeLlm = computed(
  () => llmList.value.find((p) => p.id === settings.config.activeLlmId) || llmList.value[0]
)
const activeLlmLabel = computed(() => {
  const p = activeLlm.value
  if (!p) return '选择模型'
  return p.model ? `${p.name} · ${p.model}` : p.name
})

function pickLlmModel(profileId: string, model: string) {
  settings.selectLlmModel(profileId, model)
  modelOpen.value = false
}

function onDocPointer(ev: PointerEvent) {
  const el = ev.target as HTMLElement | null
  if (!el?.closest('.bar-pop')) modelOpen.value = false
}

onMounted(() => {
  window.addEventListener('pointerdown', onDocPointer, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointer, true)
})

async function scrollToEnd() {
  await nextTick()
  const el = box.value
  if (el) el.scrollTop = el.scrollHeight
}

function cancel() {
  controller?.abort()
  status.value = '正在停止…'
}

function applyChip(text: string) {
  input.value = input.value.trim() ? `${input.value.trim()}\n${text}` : text
}

async function optimize() {
  if (!props.node || !nodeKind.value || busy.value) return
  const hint = input.value.trim()
  const script = scriptText.value.trim()
  if (!currentPrompt.value && !hint && !script) {
    feed.value.push({
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '先在这个节点里写一句要生成什么，或打开「剧情参考」贴一段剧本。'
    })
    await scrollToEnd()
    return
  }

  const userLine = hint || '帮助优化当前节点的提示词，让画面更仔细。不要改原文格式。'
  feed.value.push({ id: `u-${Date.now()}`, role: 'user', content: userLine })
  input.value = ''
  busy.value = true
  status.value = '正在扩写…'
  const turn = new AbortController()
  controller = turn
  await scrollToEnd()

  try {
    const result = await optimizeNodePrompt(
      {
        kind: nodeKind.value,
        nodeLabel: `${nodeTitle.value} · ${nodeKindLabel.value}`,
        currentPrompt: currentPrompt.value,
        userHint: hint,
        script,
        duration: props.node.data.duration,
        signal: turn.signal
      },
      (msg) => {
        status.value = msg
      }
    )
    undo.value = { nodeId: props.node.id, prompt: props.node.data.prompt || '' }
    project.setCanvasNodePrompt(props.node.id, result.prompt)
    feed.value.push({
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: `${result.note}\n\n已写入「${nodeTitle.value}」。可在节点上继续改，或点「还原上次」退回。`
    })
  } catch (error: unknown) {
    const cancelled = turn.signal.aborted || (isAbortError(error) && !isTimeoutAbort(error))
    feed.value.push({
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: cancelled ? '已停止，节点上的提示词没改。' : `失败：${friendlyAiError(error)}`
    })
  } finally {
    busy.value = false
    status.value = ''
    controller = null
    await scrollToEnd()
  }
}

function restoreLast() {
  const snap = undo.value
  if (!snap || !project.current?.canvas?.nodes.some((item) => item.id === snap.nodeId)) return
  project.setCanvasNodePrompt(snap.nodeId, snap.prompt)
  const label =
    project.current.canvas.nodes.find((item) => item.id === snap.nodeId)?.data.label || '该节点'
  undo.value = null
  feed.value.push({
    id: `a-${Date.now()}`,
    role: 'assistant',
    content: `已把「${label}」的提示词还原成优化前的版本。`
  })
  void scrollToEnd()
}
</script>

<template>
  <aside class="agent">
    <header class="head">
      <strong>提示词智能体</strong>
      <span :class="{ live: busy }">{{ busy ? status || '优化中' : '扩写当前节点' }}</span>
    </header>

    <section class="target" :class="{ empty: !nodeKind }">
      <p class="k">当前选中</p>
      <p v-if="nodeKind" class="name">{{ nodeTitle }}<small>{{ nodeKindLabel }}</small></p>
      <p v-else class="name dim">还没有选节点。点画布上的图片或视频节点。</p>
      <p v-if="currentPrompt" class="preview">{{ currentPrompt }}</p>
      <p v-else-if="nodeKind" class="preview dim">这个节点还没有提示词。</p>
    </section>

    <section class="script">
      <button type="button" class="script-tog" @click="scriptOpen = !scriptOpen">
        剧情参考{{ scriptText.trim() ? ' · 已填写' : '' }}
        <i :class="{ open: scriptOpen }" />
      </button>
      <textarea
        v-if="scriptOpen"
        v-model="scriptText"
        rows="6"
        placeholder="可选用。贴本章剧本或这几镜的剧情，优化时会对照，不会把整章塞进一镜。"
      />
    </section>

    <div ref="box" class="msgs">
      <div v-for="item in feed" :key="item.id" class="msg" :class="item.role">
        {{ item.content }}
      </div>
      <div v-if="busy" class="think">
        <i class="dots" />
        <span>{{ status || '正在扩写' }}</span>
      </div>
    </div>

    <div v-if="!busy" class="chips">
      <button v-for="c in chips" :key="c.label" type="button" @click="applyChip(c.text)">
        {{ c.label }}
      </button>
      <button v-if="undo" type="button" @click="restoreLast">还原上次</button>
    </div>

    <form class="composer" @submit.prevent="optimize">
      <div class="box">
        <textarea
          v-model="input"
          rows="5"
          :disabled="busy"
          placeholder="可选用。例如：再暗一点、手部动作写清楚、按剧本里亭卒盘问这一段。"
          @keydown.enter.exact.prevent="optimize"
        />
        <div class="bar">
          <div class="bar-pop model-pop">
            <button
              type="button"
              class="bar-btn model-btn"
              :disabled="busy"
              :title="activeLlmLabel"
              @click.stop="modelOpen = !modelOpen"
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
            title="帮助优化"
            :disabled="!canOptimize"
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
  width: 100%;
  height: 100%;
  min-width: 0;
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
.target,
.script {
  margin: 0 16px 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-0);
}
.target.empty {
  border-style: dashed;
}
.k,
.script-tog {
  margin: 0;
  font-size: 11px;
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
  margin: 8px 0 0;
  max-height: 72px;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text-3);
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.script {
  padding: 0;
}
.script-tog {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.script-tog i {
  width: 6px;
  height: 6px;
  border-right: 1.5px solid var(--color-text-4);
  border-bottom: 1.5px solid var(--color-text-4);
  transform: rotate(-45deg);
}
.script-tog i.open {
  transform: rotate(45deg);
  margin-top: -3px;
}
.script textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 0 12px 10px;
  border: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
}
.msgs {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 4px 16px 16px;
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
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 10px;
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
.box {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 8px 8px 6px;
}
.box textarea {
  width: 100%;
  min-height: 108px;
  box-sizing: border-box;
  margin: 0;
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
.model-btn:disabled {
  opacity: 0.45;
  cursor: default;
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
.menu-k,
.menu-g {
  margin: 8px 8px 4px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--color-text-4);
}
.menu-k {
  margin-top: 2px;
}
.empty {
  margin: 0 8px 8px;
  font-size: 11px;
  color: var(--color-text-4);
}
.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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
.model-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-item.on,
.model-item:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
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
