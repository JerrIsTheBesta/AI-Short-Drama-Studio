<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AdapterConfig, AdapterType } from '@/services/ai/adapters'
import { analyzeWorkflowWithLlm, validateInputMap } from '@/services/ai/comfyInputMap'
import ComfyWorkflowPanel from '@/components/settings/ComfyWorkflowPanel.vue'

const props = defineProps<{
  kind: 'llm' | 'vision' | 'image' | 'tts' | 'video'
  adapter?: AdapterConfig
  /** 当前接入地址，供 Comfy 列举/拉取工作流 */
  baseUrl?: string
  apiKey?: string
  /** 视频工作流 ID，与 adapter 并列编辑 */
  workflowId?: string
  showWorkflowId?: boolean
}>()

const emit = defineEmits<{
  patch: [patch: { adapter?: AdapterConfig; workflowId?: string }]
}>()
const expanded = ref(false)

const typeOptions: { value: AdapterType | ''; label: string; kinds: string[] }[] = [
  { value: '', label: '自动（按地址推断）', kinds: ['llm', 'vision', 'image', 'tts', 'video'] },
  { value: 'openai-compatible', label: 'OpenAI 兼容（聊天）', kinds: ['llm', 'vision', 'tts'] },
  { value: 'openai-images', label: 'OpenAI Images', kinds: ['image'] },
  { value: 'http-custom', label: '自定义 HTTP（POST + JSON 路径）', kinds: ['image', 'video', 'tts'] },
  { value: 'comfyui-workflow', label: 'ComfyUI 工作流 API（AutoDL 风格）', kinds: ['image', 'video'] },
  { value: 'comfyui-prompt', label: '自建 ComfyUI（/prompt）', kinds: ['image', 'video'] }
]

const options = computed(() => typeOptions.filter((o) => o.kinds.includes(props.kind)))

const typeModel = computed({
  get: () => (props.adapter?.type || '') as AdapterType | '',
  set: (v: AdapterType | '') => patchAdapter({ type: v || undefined }, !v)
})

const pathModel = computed({
  get: () => props.adapter?.path || '',
  set: (v: string) => patchAdapter({ path: v.trim() || undefined })
})
const pollPathModel = computed({
  get: () => props.adapter?.pollPath || props.adapter?.pollUrl || '',
  set: (v: string) => patchAdapter({ pollPath: v.trim() || undefined, pollUrl: v.trim() || undefined })
})
const resultPathModel = computed({
  get: () => props.adapter?.resultJsonPath || '',
  set: (v: string) => patchAdapter({ resultJsonPath: v.trim() || undefined })
})
const pollJsonPathModel = computed({
  get: () => props.adapter?.pollJsonPath || '',
  set: (v: string) => patchAdapter({ pollJsonPath: v.trim() || undefined })
})
const taskIdPathModel = computed({
  get: () => props.adapter?.taskIdJsonPath || '',
  set: (v: string) => patchAdapter({ taskIdJsonPath: v.trim() || undefined })
})
const authHeaderModel = computed({
  get: () => props.adapter?.authHeader || '',
  set: (v: string) => patchAdapter({ authHeader: v.trim() || undefined })
})
const authPrefixModel = computed({
  get: () => props.adapter?.authPrefix ?? '',
  set: (v: string) => patchAdapter({ authPrefix: v })
})
const workflowTemplateModel = computed({
  get: () => props.adapter?.workflowTemplate || '',
  set: (v: string) => patchAdapter({ workflowTemplate: v.trim() || undefined })
})
const workflowIdModel = computed({
  get: () => props.workflowId || '',
  set: (v: string) => emit('patch', { workflowId: v.trim() })
})

const showAdvanced = computed(() => Boolean(props.adapter?.type))

const showComfyTemplate = computed(() => props.adapter?.type === 'comfyui-prompt')
const showHttpCustom = computed(() => props.adapter?.type === 'http-custom')
const showComfyWorkflow = computed(() => props.adapter?.type === 'comfyui-workflow')

function patchAdapter(partial: Partial<AdapterConfig>, clearType = false) {
  const next: AdapterConfig = { ...(props.adapter || {}) }
  Object.assign(next, partial)
  if (clearType) delete next.type
  // 清理空字符串
  for (const key of Object.keys(next) as (keyof AdapterConfig)[]) {
    const val = next[key]
    if (val === '' || val === undefined) delete next[key]
  }
  emit('patch', { adapter: Object.keys(next).length ? next : undefined })
}

function onPasteWorkflow(ev: ClipboardEvent) {
  const text = ev.clipboardData?.getData('text') || ''
  if (!text.trim().startsWith('{')) return
  try {
    const obj = JSON.parse(text)
    // Comfy export 常为 {prompt: {...}} 或纯 nodes；API 提交体也可能含 client_id
    if (obj && typeof obj === 'object') {
      ev.preventDefault()
      const pretty = JSON.stringify(obj, null, 2)
      patchAdapter({ type: 'comfyui-prompt', workflowTemplate: pretty })
      // 粘贴完就让助手读完节点图，把提示词 / 参考图接到正确的节点上
      void analyzeMap(pretty)
    }
  } catch {
    /* 交给 textarea 正常粘贴 */
  }
}

async function analyzeMap(template: string) {
  try {
    const payload = JSON.parse(template)
    const { map } = await analyzeWorkflowWithLlm(payload)
    const checked = validateInputMap(payload, map)
    if (!checked.bindings.length) return
    patchAdapter({ inputMap: checked })
  } catch {
    /* 分析失败不打断粘贴；可在下方工作流面板里重新分析 */
  }
}
</script>

<template>
  <section class="adapter">
    <button type="button" class="advanced-toggle" @click="expanded = !expanded">
      <span><strong>高级接口兼容</strong><small>大多数官方接口和中转站不需要设置</small></span>
      <b>{{ expanded ? '收起' : '展开' }}</b>
    </button>

    <template v-if="expanded">
    <p class="hint">仅当接口文档明确要求自定义请求路径、鉴权头或 ComfyUI 工作流 JSON 时才修改这里。</p>

    <label>接口协议</label>
    <select v-model="typeModel">
      <option v-for="o in options" :key="o.value || 'auto'" :value="o.value">{{ o.label }}</option>
    </select>

    <template v-if="showWorkflowId">
      <label>工作流 ID</label>
      <input v-model="workflowIdModel" placeholder="AutoDL 工作流名，或自建占位名" />
    </template>

    <template v-if="showAdvanced || showHttpCustom || showComfyWorkflow || showComfyTemplate">
      <label>请求路径 path</label>
      <input
        v-model="pathModel"
        :placeholder="
          showComfyTemplate
            ? '/prompt'
            : showHttpCustom
              ? kind === 'video'
                ? '/v1/videos/generations'
                : '/images/generations'
              : '相对 baseUrl，可留空用默认'
        "
      />

      <label v-if="showHttpCustom || showComfyTemplate">轮询路径 pollUrl / pollPath</label>
      <input
        v-if="showHttpCustom || showComfyTemplate"
        v-model="pollPathModel"
        :placeholder="showComfyTemplate ? '/history/{id}' : '可选，含 {id}，如 /tasks/{id}'"
      />

      <label v-if="showHttpCustom">提交响应里的任务 ID 路径 taskIdJsonPath</label>
      <input
        v-if="showHttpCustom"
        v-model="taskIdPathModel"
        placeholder="可选，如 data.id / task_id"
      />

      <label v-if="showHttpCustom">轮询 JSON 路径 pollJsonPath</label>
      <input
        v-if="showHttpCustom"
        v-model="pollJsonPathModel"
        placeholder="可选，轮询里取状态或结果的路径"
      />

      <label v-if="showHttpCustom || showComfyTemplate">结果 URL 路径 resultJsonPath</label>
      <input
        v-if="showHttpCustom || showComfyTemplate"
        v-model="resultPathModel"
        placeholder="如 data.0.url 或 output.video_url"
      />

      <label>鉴权头名 authHeader</label>
      <input v-model="authHeaderModel" placeholder="默认 Authorization，可改 X-API-Key" />

      <label>鉴权前缀 authPrefix</label>
      <input v-model="authPrefixModel" placeholder="默认 Bearer （本机 Comfy 可填空）" />
      <p class="hint">前缀会直接拼在 Key 前面。AutoDL / 部分网关需要留空（不带 Bearer）。</p>
    </template>

    <ComfyWorkflowPanel
      v-if="showComfyTemplate"
      :adapter="adapter"
      :base-url="baseUrl"
      :api-key="apiKey"
      @patch="(a) => emit('patch', { adapter: a })"
    />
    </template>
  </section>
</template>

<style scoped>
.adapter {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 640px;
  margin-top: 8px;
}
.advanced-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 12px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-1);color:var(--color-text-2);text-align:left;cursor:pointer}.advanced-toggle span{display:grid;gap:2px}.advanced-toggle strong{font-size:12px;color:var(--color-text-1)}.advanced-toggle small{font-size:11px;color:var(--color-text-4);font-weight:400}.advanced-toggle b{font-size:11px;color:var(--color-accent)}
.head h3 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 650;
}
.hint {
  margin: 0 0 4px;
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
label {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
input,
select,
textarea {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-1);
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
  resize: vertical;
  min-height: 140px;
}
</style>
