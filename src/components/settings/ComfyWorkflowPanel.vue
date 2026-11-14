<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AdapterConfig } from '@/services/ai/adapters'
import {
  analyzeWorkflowWithLlm,
  describeInputMap,
  describeWorkflowKind,
  guessInputMap,
  COMFY_ROLE_LABEL,
  sanitizeInputMap,
  type ComfyInputBinding,
  type ComfyInputRole,
  validateInputMap,
  type ComfyInputMap
} from '@/services/ai/comfyInputMap'
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
  draftOnly?: boolean
}>()

const emit = defineEmits<{
  patch: [adapter: AdapterConfig]
  confirmed: []
  imported: [name: string]
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
const triedUrls = ref<string[]>([])
const showTried = ref(false)
const analyzing = ref(false)
const mapInfo = ref<ComfyInputMap | null>(props.adapter?.inputMap || null)
const mapDraft = ref('')
const showMapJson = ref(false)
const editableMap = ref<ComfyInputBinding[]>([])
const inputs = computed(() => {
  try {
    const value = JSON.parse(props.adapter?.workflowTemplate || '{}')
    return Object.entries(value.prompt || value).flatMap(([id, node]: [string, any]) =>
      Object.entries(node?.inputs || {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string')
        .map(([field, v]) => ({ key: JSON.stringify([id, field]), label: `#${id} ${node._meta?.title || node.class_type} · ${field} = ${String(v).slice(0, 36)}` })))
  } catch { return [] }
})
function setTarget(binding: ComfyInputBinding, event: Event) {
  const [nodeId, field] = JSON.parse((event.target as HTMLSelectElement).value)
  Object.assign(binding, { nodeId, field })
}
function confirmBindings() {
  const map = validateInputMap(JSON.parse(props.adapter?.workflowTemplate || '{}'), { ...guessInputMap({}), ...mapInfo.value, bindings: editableMap.value.map(b => ({ ...b })) })
  if (map.bindings.length !== editableMap.value.length || map.bindings.some(b => b.role === 'length' && !b.durationUnit)) {
    status.value = '请先为每行选择有效的节点字段，并为时长选择单位。'
    toast.error(status.value)
    return
  }
  commitTemplate(props.adapter!.workflowTemplate!, '已确认输入映射', map)
  emit('confirmed')
}
function inspectLocally(template: string) {
  const map = validateInputMap(JSON.parse(template), guessInputMap(JSON.parse(template)))
  commitTemplate(template, '已本地识别，请核对输入映射；也可选择让助手分析。', map)
}

watch(
  () => props.adapter?.workflowTemplate,
  (v) => {
    if (v !== draft.value) draft.value = v || ''
  }
)
watch(
  () => props.adapter?.inputMap,
  (v) => {
    editableMap.value = (v?.bindings || []).map(b => ({ ...b }))
    if (v && (!mapInfo.value || JSON.stringify(v) !== JSON.stringify(mapInfo.value))) {
      mapInfo.value = v
      mapDraft.value = JSON.stringify(v, null, 2)
    }
  },
  { immediate: true }
)

const hasTemplate = computed(() => Boolean(props.adapter?.workflowTemplate?.trim()))
const hasMap = computed(() => Boolean(mapInfo.value?.bindings?.length))
const mapText = computed(() =>
  mapInfo.value
    ? `${describeWorkflowKind(mapInfo.value.kind)}${mapInfo.value.summary ? ` · ${mapInfo.value.summary}` : ''}：${describeInputMap(mapInfo.value)}`
    : ''
)

function commitTemplate(template: string, detail: string, map?: ComfyInputMap | null) {
  const next: AdapterConfig = {
    ...(props.adapter || {}),
    type: 'comfyui-prompt',
    path: props.adapter?.path || '/prompt',
    pollPath: props.adapter?.pollPath || '/history/{id}',
    workflowTemplate: template,
    ...(map ? { inputMap: map } : {})
  }
  draft.value = template
  emit('patch', next)
  status.value = detail
  if (!props.draftOnly) toast.success('工作流模板已保存到当前接入')
}

/** 让助手读懂节点图，产出「提示词 / 参考图写到哪个节点」的映射 */
async function analyzeWithAssistant(payload: any, template: string, silent = false) {
  analyzing.value = true
  try {
    const { map, error } = await analyzeWorkflowWithLlm(payload)
    const checked = validateInputMap(payload, map)
    mapInfo.value = checked
    mapDraft.value = JSON.stringify(checked, null, 2)
    if (!checked.bindings.length) {
      status.value = `助手没能在这个工作流里定位到可注入的输入（${error || '未知原因'}）。可手动编辑映射 JSON。`
      if (!silent) toast.error(status.value)
      return
    }
    commitTemplate(template, `已接入输入：${describeInputMap(checked)}${error ? `（助手提示：${error}）` : ''}`, checked)
  } catch (e: any) {
    status.value = `助手分析失败：${e?.message || e}`
    if (!silent) toast.error(status.value)
  } finally {
    analyzing.value = false
  }
}

async function onValidateAndSave() {
  const parsed = parseComfyWorkflowJson(draft.value)
  status.value = parsed.detail
  if (!parsed.ok || !parsed.template) {
    toast.error(parsed.detail)
    return
  }
  // 先落盘模板，再让助手分析映射（分析失败也至少保住了工作流本身）
  inspectLocally(parsed.template)
}

async function onReanalyze() {
  const template = draft.value || props.adapter?.workflowTemplate || ''
  if (!template.trim()) {
    toast.error('还没有工作流内容')
    return
  }
  const parsed = parseComfyWorkflowJson(template)
  if (!parsed.ok || !parsed.template) {
    toast.error(parsed.detail)
    return
  }
  const tpl = parsed.template
  await analyzeWithAssistant(parsed.payload || JSON.parse(tpl), tpl)
}

function onSaveMapJson() {
  try {
    const candidate = sanitizeInputMap(JSON.parse(mapDraft.value))
    if (!candidate) throw new Error('无效的输入映射')
    const obj = validateInputMap(JSON.parse(props.adapter?.workflowTemplate || '{}'), candidate)
    mapInfo.value = obj
    emit('patch', { ...(props.adapter || {}), inputMap: obj })
    status.value = `映射已更新：${describeInputMap(obj)}`
    toast.success(props.draftOnly ? '映射已更新，请确认后保存工作流' : '输入映射已保存')
  } catch (e: any) {
    toast.error(`映射 JSON 无效：${e?.message || e}`)
  }
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

async function applyParsed(parsed: Awaited<ReturnType<typeof parseComfyWorkflowJson>>, name = '') {
  status.value = parsed.detail
  triedUrls.value = parsed.tried || []
  showTried.value = triedUrls.value.length > 0
  if (!parsed.ok || !parsed.template) {
    toast.error(parsed.detail)
    return
  }
  inspectLocally(parsed.template)
  emit('imported', name.replace(/\.json$/i, '').trim())
}

async function onPickDiscovered() {
  const item = discovered.value.find((w) => w.id === selectedId.value)
  if (!item) return
  if (!props.baseUrl) return
  const parsed = await fetchComfyUserdataWorkflow({
    baseUrl: props.baseUrl,
    path: item.path || item.name,
    apiKey: props.apiKey,
    adapter: props.adapter,
    root: item.root,
    endpoint: item.endpoint,
    source: item.source
  })
  await applyParsed(parsed, item.name)
}

async function onImportUrl() {
  const parsed = await fetchWorkflowFromUrl(importUrl.value, props.apiKey, props.adapter)
  let name = ''
  try { name = decodeURIComponent(new URL(importUrl.value.trim()).pathname.split('/').pop() || '') } catch { /* use default name */ }
  await applyParsed(parsed, name)
}

async function onFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const parsed = await readWorkflowFile(file)
  await applyParsed(parsed, file.name)
  input.value = ''
}

function clearTemplate() {
  const next: AdapterConfig = { ...(props.adapter || {}), type: 'comfyui-prompt' }
  delete next.workflowTemplate
  delete next.inputMap
  draft.value = ''
  mapInfo.value = null
  mapDraft.value = ''
  emit('patch', next)
  status.value = '已清空工作流模板与输入映射'
}
</script>

<template>
  <section class="wf">
    <header class="head">
      <h4>Comfy 工作流模板</h4>
      <p class="hint">
        在 ComfyUI 菜单选择 <strong>Save (API Format)</strong> 导出 JSON，粘贴到下方点「校验并保存」。
        助手会读完节点结构，判断提示词 / 参考图 / 参数该注入到哪个节点的哪个字段 ——
        不同工作流的节点命名差异很大，不靠写死规则猜。界面格式（含 nodes/links）无法直接出片。
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
      <button type="button" class="go" :disabled="analyzing" @click="onValidateAndSave">
        {{ analyzing ? '助手分析中…' : draftOnly ? '校验 JSON' : '校验并保存' }}
      </button>
      <button type="button" class="mini" :disabled="analyzing || !draft.trim()" @click="onReanalyze">
        {{ analyzing ? '分析中…' : (hasMap ? '重新让助手分析' : '用助手分析工作流') }}
      </button>
      <button type="button" class="mini ghost" :disabled="!hasTemplate" @click="clearTemplate">清空</button>
    </div>
    <p v-if="status" class="status" role="status">{{ status }}</p>

    <div v-if="mapInfo" class="map">
      <p class="map-head">
        <span class="tag" :class="{ warn: !hasMap }">{{ hasMap ? '输入已接入' : '未接入输入' }}</span>
        <span>{{ describeWorkflowKind(mapInfo.kind) }}<template v-if="mapInfo.summary"> · {{ mapInfo.summary }}</template></span>
        <span v-if="mapInfo.source === 'heuristic'" class="tag warn">规则兜底</span>
      </p>
      <ul v-if="hasMap" class="map-list">
        <li v-for="(b, i) in mapInfo.bindings" :key="i">
          <code>#{{ b.nodeId }}.{{ b.field }}</code> ← {{ b.note || b.role }}
        </li>
      </ul>
      <p v-if="mapInfo.notes" class="hint">{{ mapInfo.notes }}</p>
      <p v-if="!hasMap" class="hint">
        助手没定位到输入节点，生成时会跑工作流里写死的内容。可手动改下面的映射，或换一个工作流。
      </p>
      <div v-if="hasTemplate">
        <p>核对输入映射（候选字段显示工作流默认值）</p>
        <div v-for="(binding, index) in editableMap" :key="index" class="mapping-row">
          <select v-model="binding.role" aria-label="参数用途"><option v-for="(label, key) in COMFY_ROLE_LABEL" :key="key" :value="key">{{ label }}</option></select>
          <select :value="JSON.stringify([binding.nodeId, binding.field])" aria-label="节点字段" @change="setTarget(binding, $event)"><option :value="JSON.stringify(['',''])" disabled>选择节点字段</option><option v-for="option in inputs" :key="option.key" :value="option.key">{{ option.label }}</option></select>
          <select v-if="binding.role === 'length'" v-model="binding.durationUnit" aria-label="时长单位"><option :value="undefined">选择单位</option><option value="seconds">秒</option><option value="frames">帧</option></select>
          <button type="button" class="mini" @click="editableMap.splice(index, 1)">移除</button>
        </div>
        <button type="button" class="mini" @click="editableMap.push({ role: 'prompt' as ComfyInputRole, nodeId: '', field: '' })">添加映射</button>
        <button type="button" class="go" @click="confirmBindings">确认映射</button>
      </div>
      <button type="button" class="mini ghost" @click="showMapJson = !showMapJson">
        {{ showMapJson ? '收起映射 JSON' : '手动编辑映射 JSON' }}
      </button>
      <template v-if="showMapJson">
        <textarea v-model="mapDraft" rows="8" spellcheck="false" />
        <div class="row">
          <button type="button" class="mini" @click="onSaveMapJson">保存映射</button>
        </div>
      </template>
    </div>
    <div v-if="triedUrls.length" class="diag">
      <button type="button" class="mini ghost" @click="showTried = !showTried">
        {{ showTried ? '收起' : '查看尝试过的地址' }}（{{ triedUrls.length }}）
      </button>
      <ul v-if="showTried">
        <li v-for="(u, i) in triedUrls" :key="i"><code>{{ u }}</code></li>
      </ul>
      <p v-if="showTried" class="hint">
        把上面任一地址贴到浏览器地址栏打开：能下载到 JSON 就说明地址对（把那条发我），同样 404 说明该服务不提供按路径读文件。
      </p>
    </div>
  </section>
</template>

<style scoped>
.mapping-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.mapping-row select { min-width: 0; max-width: 100%; background: var(--color-bg-2); color: inherit; }
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
.map {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.map-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--color-text-2);
}
.tag {
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  background: var(--color-success, #34d399);
  color: #06281f;
  font-weight: 600;
}
.tag.warn {
  background: var(--color-warning, #fbbf24);
  color: #3b2505;
}
.map-list {
  margin: 0;
  padding: 0 0 0 16px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.7;
}
.map-list code {
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--color-bg-3);
}
.diag {
  margin-top: 6px;
}
.diag ul {
  margin: 6px 0 0;
  padding: 8px 10px;
  max-height: 190px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  list-style: none;
}
.diag li {
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
