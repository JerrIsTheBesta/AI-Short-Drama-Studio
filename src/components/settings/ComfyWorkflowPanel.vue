<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AdapterConfig } from '@/services/ai/adapters'
import {
  discoverComfyWorkflows,
  fetchComfyUserdataWorkflow,
  fetchWorkflowFromUrl,
  parseComfyWorkflowJson,
  readWorkflowFile,
  type DiscoveredWorkflow
} from '@/services/settings/comfyWorkflows'
import { useToastStore } from '@/stores'

const props = defineProps<{
  adapter?: AdapterConfig
  baseUrl?: string
  apiKey?: string
}>()

const emit = defineEmits<{
  patch: [adapter: AdapterConfig]
}>()

const toast = useToastStore()
const draft = ref(props.adapter?.workflowTemplate || '')
const status = ref('')
const discovering = ref(false)
const discovered = ref<DiscoveredWorkflow[]>([])
const discoverMsg = ref('')
const selectedId = ref('')
const importUrl = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.adapter?.workflowTemplate,
  (v) => {
    if (v !== draft.value) draft.value = v || ''
  }
)

const hasTemplate = computed(() => Boolean(props.adapter?.workflowTemplate?.trim()))

function commitTemplate(template: string, detail: string) {
  const next: AdapterConfig = {
    ...(props.adapter || {}),
    type: 'comfyui-prompt',
    path: props.adapter?.path || '/prompt',
    pollPath: props.adapter?.pollPath || '/history/{id}',
    workflowTemplate: template
  }
  draft.value = template
  emit('patch', next)
  status.value = detail
  toast.success('工作流模板已保存到当前接入')
}

function onValidateAndSave() {
  const parsed = parseComfyWorkflowJson(draft.value)
  status.value = parsed.detail
  if (!parsed.ok || !parsed.template) {
    toast.error(parsed.detail)
    return
  }
  commitTemplate(parsed.template, parsed.detail)
}

function onPaste(ev: ClipboardEvent) {
  const text = ev.clipboardData?.getData('text') || ''
  if (!text.trim().startsWith('{')) return
  // 让浏览器先写入，再在 next tick 校验提示
  setTimeout(() => {
    const parsed = parseComfyWorkflowJson(draft.value || text)
    status.value = parsed.detail
  }, 0)
}

async function onDiscover() {
  if (!props.baseUrl?.trim()) {
    toast.error('请先填写 ComfyUI 地址')
    return
  }
  discovering.value = true
  discoverMsg.value = ''
  discovered.value = []
  selectedId.value = ''
  try {
    const res = await discoverComfyWorkflows({
      baseUrl: props.baseUrl,
      apiKey: props.apiKey,
      adapter: props.adapter
    })
    discovered.value = res.workflows
    discoverMsg.value = res.message
    if (!res.reachable) toast.error(res.message)
    else if (!res.workflows.length) toast.info(res.message, 4000)
    else toast.success(res.message)
  } catch (e: any) {
    discoverMsg.value = e?.message || String(e)
    toast.error(discoverMsg.value)
  } finally {
    discovering.value = false
  }
}

async function onPickDiscovered() {
  const item = discovered.value.find((w) => w.id === selectedId.value)
  if (!item) return
  if (!props.baseUrl) return
  const parsed = await fetchComfyUserdataWorkflow({
    baseUrl: props.baseUrl,
    path: item.path || item.name,
    apiKey: props.apiKey,
    adapter: props.adapter
  })
  status.value = parsed.detail
  if (!parsed.ok || !parsed.template) {
    toast.error(parsed.detail)
    return
  }
  commitTemplate(parsed.template, parsed.detail)
}

async function onImportUrl() {
  const parsed = await fetchWorkflowFromUrl(importUrl.value, props.apiKey, props.adapter)
  status.value = parsed.detail
  if (!parsed.ok || !parsed.template) {
    toast.error(parsed.detail)
    return
  }
  commitTemplate(parsed.template, parsed.detail)
}

async function onFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const parsed = await readWorkflowFile(file)
  status.value = parsed.detail
  if (!parsed.ok || !parsed.template) {
    toast.error(parsed.detail)
  } else {
    commitTemplate(parsed.template, parsed.detail)
  }
  input.value = ''
}

function clearTemplate() {
  const next: AdapterConfig = { ...(props.adapter || {}), type: 'comfyui-prompt' }
  delete next.workflowTemplate
  draft.value = ''
  emit('patch', next)
  status.value = '已清空工作流模板'
}
</script>

<template>
  <section class="wf">
    <header class="head">
      <h4>Comfy 工作流模板</h4>
      <p class="hint">
        在 ComfyUI 菜单选择 <strong>Save (API Format)</strong> 导出 JSON，粘贴到下方并保存。
        界面格式（含 nodes/links）无法直接出片。可用占位
        <code v-pre>{{prompt}}</code>、<code v-pre>{{image}}</code>、<code v-pre>{{negative}}</code>。
      </p>
      <p class="badge" :class="{ on: hasTemplate }">
        {{ hasTemplate ? '已配置 workflowTemplate' : '尚未配置 — 出图/出视频前必须粘贴' }}
      </p>
    </header>

    <div class="row">
      <button type="button" class="mini" :disabled="discovering || !baseUrl" @click="onDiscover">
        {{ discovering ? '探测中…' : '从 Comfy 刷新列表' }}
      </button>
      <button type="button" class="mini ghost" @click="fileInput?.click()">从文件导入</button>
      <input ref="fileInput" type="file" accept="application/json,.json" class="hidden" @change="onFileChange" />
    </div>
    <p v-if="discoverMsg" class="hint">{{ discoverMsg }}</p>

    <template v-if="discovered.length">
      <label>已发现的工作流文件</label>
      <div class="row">
        <select v-model="selectedId">
          <option value="">选择…</option>
          <option v-for="w in discovered" :key="w.id" :value="w.id">{{ w.name }}</option>
        </select>
        <button type="button" class="mini" :disabled="!selectedId" @click="onPickDiscovered">载入并校验</button>
      </div>
    </template>

    <label>或从 URL 导入</label>
    <div class="row">
      <input v-model="importUrl" placeholder="https://…/workflow-api.json" />
      <button type="button" class="mini" @click="onImportUrl">拉取</button>
    </div>

    <label>workflowTemplate（API Format JSON）</label>
    <textarea
      v-model="draft"
      rows="12"
      spellcheck="false"
      placeholder='{"prompt":{...},"client_id":"ai-cut"}'
      @paste="onPaste"
    />
    <div class="row">
      <button type="button" class="go" @click="onValidateAndSave">校验并保存</button>
      <button type="button" class="mini ghost" :disabled="!hasTemplate" @click="clearTemplate">清空</button>
    </div>
    <p v-if="status" class="status">{{ status }}</p>
  </section>
</template>

<style scoped>
.wf {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--color-border);
}
.head h4 {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 650;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.5;
}
.hint code {
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--color-bg-3);
}
.badge {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--color-warning, #fbbf24);
}
.badge.on {
  color: var(--color-success, #34d399);
}
label {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
input,
select,
textarea {
  flex: 1;
  min-width: 0;
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-1);
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
}
textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  resize: vertical;
  min-height: 160px;
}
.mini,
.go {
  margin: 0;
  padding: 7px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.mini {
  border: 1px solid var(--color-border);
  background: var(--color-bg-3);
  color: var(--color-text-2);
}
.mini.ghost {
  background: transparent;
}
.mini:disabled,
.go:disabled {
  opacity: 0.5;
  cursor: default;
}
.go {
  border: 0;
  background: var(--grad-primary, linear-gradient(90deg, #7c3aed, #2563eb));
  color: #fff;
  font-weight: 600;
}
.hidden {
  display: none;
}
.status {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.45;
}
</style>
