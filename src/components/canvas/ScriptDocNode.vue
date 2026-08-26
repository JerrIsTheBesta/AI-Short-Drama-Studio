<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useProjectStore, useSettingsStore, useToastStore } from '@/stores'
import { llmChoiceKey, llmModelGroups, parseLlmChoiceKey } from '@/stores/settings'
import { runScriptNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import {
  applyProjectPlayMarkdown,
  composeProjectPlayMarkdown
} from '@/utils/scriptMarkdown'
import { markdownToHtml } from '@/utils/markdown'
import { needsPlayReview } from '@/services/canvas/playGate'
import { extractStageLabel } from '@/services/canvas/pipeline'
import { isPlayReady } from '@/services/ai'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    label?: string
    width?: number
    height?: number
    nodeType?: string
  }
}>()

const MIN_W = 320
const MIN_H = 360

const project = useProjectStore()
const settings = useSettingsStore()
const toast = useToastStore()
const { getViewport, findNode, removeSelectedNodes } = useVueFlow()
const panelOpen = ref(false)

watch(
  () => props.selected,
  (on) => {
    panelOpen.value = Boolean(on)
  },
  { immediate: true }
)

const llmGroups = computed(() => llmModelGroups(settings.config.llms ?? []))
const llmChoice = computed({
  get() {
    const id = settings.config.activeLlmId
    const model = settings.config.llm.model
    return id && model ? llmChoiceKey(id, model) : ''
  },
  set(v: string) {
    const parsed = parseLlmChoiceKey(v)
    if (parsed) settings.selectLlmModel(parsed.profileId, parsed.model)
  }
})
const llmModel = computed(() => settings.config.llm.model)

function patchTopic(v: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, topic: v })
  project.applyPlayTitle(v)
}

function patchDraftBrief(v: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, content: v })
}

const nodeMeta = computed(() => project.current?.canvas?.nodes.find((n) => n.id === props.id))
const width = computed(() => nodeMeta.value?.data.width || props.data.width || 460)
const height = computed(() => nodeMeta.value?.data.height || props.data.height || 720)
const generating = computed(() => isNodeRunning(props.id))
const status = computed(() => nodeMeta.value?.status ?? 'idle')
const waitingReview = computed(() => needsPlayReview(project.current))
const approved = computed(() => Boolean(project.current?.shots.length) && !waitingReview.value)
const playReady = computed(() => isPlayReady(project.current?.script))
const playLabel = computed(() => (playReady.value ? '重新写剧本' : '写剧本'))
const extractLabel = computed(() => extractStageLabel(project.current))

const editing = ref(false)
const draft = ref('')
const dirty = ref(false)
const continueHint = ref('')

const markdown = computed(() => {
  if (!project.current) return '# 剧本\n\n*还没有打开项目。*'
  return composeProjectPlayMarkdown(project.current)
})
const html = computed(() => markdownToHtml(markdown.value))

watch(markdown, (md) => {
  if (!editing.value) {
    draft.value = md
    dirty.value = false
  }
})

function startEdit(ev?: Event) {
  ev?.stopPropagation()
  draft.value = markdown.value
  dirty.value = false
  editing.value = true
}

function cancelEdit(ev?: Event) {
  ev?.stopPropagation()
  editing.value = false
  dirty.value = false
  draft.value = markdown.value
}

async function saveEdit(ev?: Event) {
  ev?.stopPropagation()
  if (!project.current) return
  try {
    const clone = JSON.parse(JSON.stringify(project.current)) as typeof project.current
    if (!clone) return
    applyProjectPlayMarkdown(clone, draft.value)
    if (clone.script) {
      project.setScript({
        ...clone.script,
        playReady: Boolean(clone.script.content?.trim())
      })
    }
    if (clone.subjects) project.setSubjects(clone.subjects)
    if (clone.scenes) project.setScenes(clone.scenes)
    if (clone.shots) project.setShots(clone.shots)
    // 改过剧本后需要重新确认，避免带着旧验收状态往下跑
    if (project.current.playApproved) {
      project.setPlayApproved(false)
    }
    await project.save()
    editing.value = false
    dirty.value = false
    toast.success('剧本已保存，可继续改或点确认通过')
  } catch (e: any) {
    toast.error('保存失败：' + (e?.message || String(e)))
  }
}

async function approvePlay(ev: Event) {
  ev.stopPropagation()
  if (editing.value && dirty.value) {
    await saveEdit()
  }
  project.setPlayApproved(true)
  await project.save()
}

const live = ref<{ w: number; h: number } | null>(null)

function patchSize(w: number, h: number) {
  const canvas = project.current?.canvas
  if (!canvas) return
  const nodes = canvas.nodes.map((n) =>
    n.id === props.id ? { ...n, data: { ...n.data, width: w, height: h } } : n
  )
  project.setCanvas({ ...canvas, nodes })
}

let dragging: {
  kind: 'se' | 'e' | 's'
  sx: number
  sy: number
  sw: number
  sh: number
} | null = null

function flowEl() {
  return document.querySelector(`.vue-flow__node[data-id="${props.id}"]`) as HTMLElement | null
}

function applyBox(w: number, h: number) {
  live.value = { w, h }
  const el = flowEl()
  if (el) {
    el.style.width = `${w}px`
    el.style.height = `${h}px`
  }
}

function onResizeStart(kind: 'se' | 'e' | 's', e: PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragging = {
    kind,
    sx: e.clientX,
    sy: e.clientY,
    sw: width.value,
    sh: height.value
  }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
}

function onResizeMove(e: PointerEvent) {
  if (!dragging) return
  const zoom = getViewport().zoom || 1
  const dx = (e.clientX - dragging.sx) / zoom
  const dy = (e.clientY - dragging.sy) / zoom
  const w = dragging.kind === 's' ? dragging.sw : Math.max(MIN_W, dragging.sw + dx)
  const h = dragging.kind === 'e' ? dragging.sh : Math.max(MIN_H, dragging.sh + dy)
  applyBox(w, h)
}

function onResizeEnd() {
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
  if (live.value) patchSize(Math.round(live.value.w), Math.round(live.value.h))
  live.value = null
  dragging = null
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
})

function dismissPanel() {
  panelOpen.value = false
  const n = findNode(props.id)
  if (n) removeSelectedNodes([n])
}

async function generateThis(ev: Event, kind: 'play' | 'extract' | 'continue' = 'play') {
  ev.stopPropagation()
  if (generating.value) return
  if (editing.value) {
    toast.warn('请先保存或取消剧本编辑')
    return
  }
  if (kind === 'extract' && !playReady.value && !(project.current?.script?.content || '').trim()) {
    toast.warn('请先写完整剧本，再提炼节点')
    return
  }
  if (kind === 'continue' && !playReady.value) {
    toast.warn('请先写好完整剧本，再续写')
    return
  }
  dismissPanel()
  try {
    await runScriptNode(kind, undefined, undefined, llmModel.value, continueHint.value)
  } catch (e) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e))
  }
}
</script>

<template>
  <div class="sdoc" :class="[`st-${status}`, { editing, on: selected && panelOpen, busy: generating }]">
    <div class="sdoc-card">
    <div class="sdoc-head">
      <div class="sdoc-titles">
        <span class="sdoc-k">完整剧本</span>
        <strong>{{ project.current?.script?.topic || project.current?.name || '剧本' }}</strong>
      </div>
      <div class="sdoc-actions nodrag">
        <template v-if="editing">
          <button type="button" class="sdoc-btn ghost" @click="cancelEdit" @mousedown.stop>取消</button>
          <button type="button" class="sdoc-btn primary" @click="saveEdit" @mousedown.stop>
            保存{{ dirty ? '*' : '' }}
          </button>
        </template>
        <template v-else>
          <button
            v-if="playReady"
            type="button"
            class="sdoc-btn"
            :disabled="generating"
            @click="generateThis($event, 'continue')"
            @mousedown.stop
          >
            续写
          </button>
          <button type="button" class="sdoc-btn" @click="startEdit" @mousedown.stop>✎ 编辑</button>
        </template>
      </div>
    </div>

    <textarea
      v-if="editing"
      v-model="draft"
      class="sdoc-edit nowheel nodrag"
      spellcheck="false"
      @input="dirty = true"
      @mousedown.stop
    />
    <div v-else class="sdoc-md nowheel nodrag" :class="{ 'has-panel': selected && panelOpen }" v-html="html" />

    <div v-if="playReady && !project.current?.shots.length && !editing" class="sdoc-gate nodrag">
      <span>按人物、场景、分镜分三步提炼；每一步完成就立即保存，下一步由你确认后再运行。</span>
      <button type="button" :disabled="generating" @click="generateThis($event, 'extract')" @mousedown.stop>
        {{ extractLabel }}
      </button>
    </div>
    <div v-else-if="waitingReview && !editing" class="sdoc-gate nodrag">
      <span>请先验收这份剧本。可点「编辑」或「续写」后再确认。确认后才做人设、配图、视频。</span>
      <button type="button" @click="approvePlay" @mousedown.stop>确认通过</button>
    </div>
    <div v-else-if="approved && !editing" class="sdoc-ok nodrag">
      剧本已确认。仍可点「续写」往后加场，或点「编辑」改字；改完需重新确认。
    </div>
    <p v-if="nodeMeta?.error" class="sdoc-err">{{ nodeMeta.error }}</p>
    <NodeBusyOverlay v-if="generating" label="生成中" />
    <Handle id="out" type="source" :position="Position.Right" class="hndl" />
    <div class="rz rz-e nodrag nopan" title="横向缩放" @pointerdown="onResizeStart('e', $event)" />
    <div class="rz rz-s nodrag nopan" title="纵向缩放" @pointerdown="onResizeStart('s', $event)" />
    <div class="rz rz-se nodrag nopan" title="拖动缩放" @pointerdown="onResizeStart('se', $event)" />
    </div>

    <transition name="float-down">
      <div
        v-if="selected && panelOpen && !editing"
        class="prompt nodrag nowheel"
        @mousedown.stop
        @click.stop
      >
        <label>主题 / 你想拍什么</label>
        <textarea
          rows="4"
          :value="project.current?.script?.topic || ''"
          placeholder="主题、故事、风格、时长……想拍什么就写什么"
          @input="patchTopic(($event.target as HTMLTextAreaElement).value)"
        />
        <template v-if="!playReady">
          <label>草稿（可选）</label>
          <textarea
            rows="3"
            :value="project.current?.script?.content || ''"
            placeholder="已有大纲、台词或备注，会一起交给模型"
            @input="patchDraftBrief(($event.target as HTMLTextAreaElement).value)"
          />
        </template>
        <p v-else class="prompt-hint">续写会保留已有场次，只往后加。重新写剧本会整篇重来并清空节点。</p>
        <template v-if="playReady">
          <label>续写方向（可选）</label>
          <textarea
            rows="3"
            :value="continueHint"
            placeholder="例如：再写两场，写父亲回家之后怎么说。不填则顺着往下写 2–3 场。"
            @input="continueHint = ($event.target as HTMLTextAreaElement).value"
          />
        </template>
        <div class="prompt-foot">
          <label class="model-pick">
            <span>LLM</span>
            <select v-model="llmChoice">
              <option v-if="!llmGroups.some((g) => g.models.length)" value="">请先在设置里添加模型</option>
              <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
                <option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">{{ m }}</option>
              </optgroup>
            </select>
          </label>
          <button
            type="button"
            class="ghost"
            :disabled="generating || (!playReady && !(project.current?.script?.content || '').trim())"
            @click="generateThis($event, 'extract')"
          >
            {{ extractLabel }}
          </button>
          <button
            v-if="playReady"
            type="button"
            class="ghost"
            :disabled="generating || !llmModel"
            :title="playLabel"
            @click="generateThis($event, 'play')"
          >
            重写
          </button>
          <button
            type="button"
            class="go"
            :disabled="generating || !llmModel"
            :title="playReady ? '续写剧本' : playLabel"
            @click="generateThis($event, playReady ? 'continue' : 'play')"
          >
            ↑
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.sdoc {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: visible;
  color: var(--color-text-1);
}
.sdoc.on {
  z-index: 4;
}
.sdoc.st-running,
.sdoc.busy {
  z-index: 5;
}
.sdoc-card {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-1);
  border: 1px solid var(--color-node-border);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-node);
  position: relative;
}
.sdoc.editing .sdoc-card {
  border-color: var(--color-accent);
}
.sdoc.on .sdoc-card {
  border-color: var(--color-text-1);
  box-shadow: 0 0 0 1px var(--color-text-1), var(--shadow-md);
}
.sdoc.st-running .sdoc-card,
.sdoc.busy .sdoc-card {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px rgba(126, 180, 255, 0.28);
  animation: node-busy 1.35s ease-in-out infinite;
}
@keyframes node-busy {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgba(126, 180, 255, 0.22);
  }
  50% {
    box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.4);
  }
}
.sdoc.st-failed .sdoc-card {
  border-color: var(--color-error);
}
.sdoc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-node-well);
  flex-shrink: 0;
  cursor: grab;
}
.sdoc-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.sdoc-k {
  font-size: 10px;
  color: var(--color-text-4);
  letter-spacing: 0.06em;
}
.sdoc-titles strong {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sdoc-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.sdoc-btn {
  flex-shrink: 0;
  font-size: 11px;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
  border: none;
  cursor: pointer;
}
.sdoc-btn:hover {
  background: var(--color-accent);
  color: #fff;
}
.sdoc-btn.primary {
  background: var(--color-accent);
  color: #fff;
}
.sdoc-btn.ghost {
  background: transparent;
  border: 1px solid var(--color-border);
}
.sdoc-md,
.sdoc-edit {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px 20px;
  cursor: text;
}
.sdoc-md.has-panel {
  padding-bottom: 240px;
}
.sdoc-edit {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: var(--color-bg-1);
  color: var(--color-text-1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.65;
}
.sdoc-md :deep(h1) {
  margin: 0 0 14px;
  font-size: 22px;
  font-weight: 800;
  line-height: 1.3;
  color: var(--color-text-1);
}
.sdoc-md :deep(h2) {
  margin: 20px 0 8px;
  padding-bottom: 6px;
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-1);
  border-bottom: 1px solid var(--color-border);
}
.sdoc-md :deep(h3) {
  margin: 14px 0 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-2);
}
.sdoc-md :deep(p) {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--color-text-2);
}
.sdoc-md :deep(ul),
.sdoc-md :deep(ol) {
  margin: 0 0 10px;
  padding-left: 1.2em;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--color-text-2);
}
.sdoc-md :deep(li) {
  margin: 3px 0;
}
.sdoc-md :deep(strong) {
  color: var(--color-text-1);
  font-weight: 700;
}
.sdoc-md :deep(em) {
  color: var(--color-text-3);
}
.sdoc-md :deep(code) {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--color-bg-3);
}
.sdoc-md :deep(hr) {
  border: none;
  border-top: 1px dashed var(--color-border);
  margin: 12px 0;
}
.sdoc-err {
  margin: 0;
  padding: 6px 14px 10px;
  font-size: 11px;
  color: var(--color-error);
}
.sdoc-gate {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(245, 158, 11, 0.12);
  border-top: 1px solid rgba(251, 191, 36, 0.35);
  flex-shrink: 0;
}
.sdoc-gate span {
  font-size: 12px;
  color: var(--color-warning);
  line-height: 1.4;
}
.sdoc-gate button {
  flex-shrink: 0;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  background: #f59e0b;
  color: #111;
  font-weight: 700;
}
.sdoc-ok {
  padding: 8px 14px;
  font-size: 11px;
  color: var(--color-success);
  border-top: 1px solid rgba(16, 185, 129, 0.25);
  flex-shrink: 0;
}
.hndl {
  width: 8px;
  height: 8px;
  background: var(--color-accent);
  border: 1px solid #fff;
}
.rz {
  position: absolute;
  z-index: 4;
}
.rz-e {
  top: 28px;
  right: 0;
  width: 8px;
  height: calc(100% - 36px);
  cursor: ew-resize;
}
.rz-s {
  left: 0;
  bottom: 0;
  width: calc(100% - 14px);
  height: 8px;
  cursor: ns-resize;
}
.rz-se {
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
}
.rz-se::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--color-text-3);
  border-bottom: 2px solid var(--color-text-3);
}
.prompt {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  top: auto;
  z-index: 5;
  width: auto;
  transform: none;
  transform-origin: 50% 100%;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.prompt label {
  display: block;
  margin: 0 0 4px;
  font-size: 10px;
  color: var(--color-text-4);
}
.prompt textarea {
  width: 100%;
  min-height: 72px;
  margin: 0 0 8px;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
}
.prompt-hint {
  margin: 0 0 8px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-text-4);
}
.prompt-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.model-pick {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}
.model-pick span {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-4);
}
.model-pick select {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 26px 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background-color: var(--color-bg-1);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%23ececef' d='M1.2 1.2L6 6l4.8-4.8' stroke='%23ececef' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
  color: var(--color-text-1);
  font-size: 11px;
  appearance: none;
}
.prompt-foot .ghost {
  flex-shrink: 0;
  margin: 0;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-2);
  font-size: 11px;
  cursor: pointer;
}
.prompt-foot .ghost:disabled,
.prompt-foot .go:disabled {
  opacity: 0.4;
  cursor: default;
}
.prompt-foot .go {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #ececef;
  color: #111;
  font-size: 16px;
  cursor: pointer;
}
.float-down-enter-active,
.float-down-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.float-down-enter-from,
.float-down-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
