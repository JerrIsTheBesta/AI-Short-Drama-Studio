<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSettingsStore } from '@/stores'
import ComfyWorkflowPanel from './ComfyWorkflowPanel.vue'
import { normalizeComfyBaseUrl } from '@/services/settings/comfyQuickAdd'
import type { AdapterConfig } from '@/services/ai/adapters'

const settings = useSettingsStore()
const url = ref('http://127.0.0.1:8188')
const token = ref('')
const name = ref('')
const kind = ref<'image' | 'video' | 'other'>('video')
const adapter = ref<AdapterConfig>({ type: 'comfyui-prompt', authPrefix: '' })
const message = ref('')
const feedback = ref<'error' | 'success' | 'info'>('info')
const editing = ref('')
const confirmed = ref(false)
const dirty = ref(false)
const otherKey = 'ai-cut:comfy-other-workflows'
const other = ref<Array<{ id: string; name: string; baseUrl: string; adapter: AdapterConfig }>>([])
try { other.value = JSON.parse(localStorage.getItem(otherKey) || '[]') } catch { /* empty catalog */ }
const workflows = computed(() => [
  ...settings.config.images.filter(p => p.adapter?.type === 'comfyui-prompt').map(p => ({ ...p, kind: 'image' as const })),
  ...settings.config.videos.filter(p => p.adapter?.type === 'comfyui-prompt').map(p => ({ ...p, kind: 'video' as const })),
  ...other.value.map(p => ({ ...p, apiKey: '', kind: 'other' as const }))
])
const labels = { image: '图片', video: '视频', other: '其他（仅收藏）' }
const normalized = computed(() => {
  try {
    const u = new URL(normalizeComfyBaseUrl(url.value))
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash ? u.href.replace(/\/$/, '') : ''
  } catch { return '' }
})
function load(id: string) {
  const row = workflows.value.find(p => p.id === id)
  if (!row) return
  editing.value = id
  confirmed.value = false
  dirty.value = false
  url.value = row.baseUrl
  token.value = row.apiKey
  name.value = row.name
  kind.value = row.kind
  adapter.value = { ...row.adapter, type: 'comfyui-prompt' }
  message.value = ''
}
function reset() {
  editing.value = ''
  confirmed.value = false
  dirty.value = false
  name.value = ''
  adapter.value = { type: 'comfyui-prompt', authPrefix: '' }
  message.value = ''
}
function remove(id: string) {
  const row = workflows.value.find(p => p.id === id)
  if (!row || !window.confirm(`删除「${row.name}」的本机配置？不会删除 ComfyUI 服务器上的工作流或文件。引用它的旧节点需要重新选择工作流。`)) return
  if (row.kind === 'image') settings.removeImage(id, true)
  else if (row.kind === 'video') settings.removeVideo(id, true)
  else {
    other.value = other.value.filter(p => p.id !== id)
    localStorage.setItem(otherKey, JSON.stringify(other.value))
  }
  if (editing.value === id) reset()
  feedback.value = 'success'
  message.value = '已删除本机工作流配置。'
}
function onImported(suggested: string) {
  if (!name.value.trim()) name.value = suggested || 'ComfyUI 工作流'
  feedback.value = 'info'
  message.value = '已导入工作流。请核对参数后点击「确认映射」，再保存。'
}
function onConfirmed() {
  confirmed.value = true
  feedback.value = 'success'
  message.value = '映射已确认。点击「保存工作流」或右下角「保存改动」即可登记。'
}
function save(): boolean {
  const fail = (reason: string) => { feedback.value = 'error'; message.value = reason; return false }
  if (!normalized.value) return fail('请填写有效的 ComfyUI 地址。')
  if (!adapter.value.workflowTemplate) return fail('请先导入 API 格式的工作流 JSON，或粘贴后点击「校验 JSON」。')
  if (!name.value.trim()) return fail('请填写工作流名称，再保存。')
  const draft = { name: name.value.trim(), baseUrl: normalized.value, apiKey: token.value.trim(), adapter: adapter.value, provider: 'custom' }
  if (kind.value === 'video' && (!confirmed.value || !adapter.value.inputMap?.bindings.some(b => b.role === 'length' && b.durationUnit))) {
    return fail('请为视频配置时长节点和单位，再点击「确认映射」。')
  }
  let id = editing.value
  if (kind.value === 'image') {
    if (id) { settings.selectImage(id); settings.patchImage(draft) }
    else id = settings.addImage({ ...draft, model: 'comfyui', models: ['comfyui'] })
  } else if (kind.value === 'video') {
    if (id) { settings.selectVideo(id); settings.patchVideo(draft) }
    else id = settings.addVideo({ ...draft, workflowId: 'comfyui-local', stillMode: 'keyframe' })
  } else {
    id ||= crypto.randomUUID()
    other.value = [...other.value.filter(p => p.id !== id), { id, name: draft.name, baseUrl: draft.baseUrl, adapter: draft.adapter }]
    localStorage.setItem(otherKey, JSON.stringify(other.value))
  }
  editing.value = id
  dirty.value = false
  feedback.value = 'success'
  message.value = kind.value === 'video' ? '视频工作流已保存，可在视频节点的「模型 → ComfyUI 工作流」中选择。' : '工作流已保存。图片工作流可在创作偏好 → ComfyUI 中选择；其他类型仅收藏。'
  return true
}
defineExpose({ savePending: () => !dirty.value || save() })
</script>

<template>
  <section class="comfy-page" @input="dirty = true">
    <h2>ComfyUI 接入</h2>
    <p>填写地址 → 导入 API 格式工作流 → 确认参数 → 保存。</p>
    <label>ComfyUI 地址<input v-model="url" placeholder="http://127.0.0.1:8188" /></label>
    <label>API Token（可选）<input v-model="token" type="password" autocomplete="off" /></label>
    <label>工作流名称<input v-model="name" placeholder="例如：U24 双采参考视频" /></label>
    <label>用途<select v-model="kind" :disabled="!!editing"><option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option></select></label>
    <ComfyWorkflowPanel v-if="normalized" :key="editing || 'new'" draft-only :adapter="adapter" :base-url="normalized" :api-key="token" @patch="adapter = $event; confirmed = false; dirty = true; message = ''" @imported="onImported" @confirmed="onConfirmed" />
    <p v-if="adapter.workflowTemplate && !editing">已导入草稿，尚未加入节点列表。请确认映射后点击下方「保存工作流」。</p>
    <p>参考图生成前会通过 ComfyUI 的上传接口传入。视频时长请确认映射的是秒数，或带有明确帧率的帧数。</p>
    <div class="actions"><button type="button" @click="save">保存工作流</button><button type="button" @click="reset">新建工作流</button></div>
    <p v-if="message" class="feedback" :class="feedback" :role="feedback === 'error' ? 'alert' : 'status'"><strong>{{ feedback === 'error' ? '未保存' : feedback === 'success' ? '已完成' : '下一步' }}：</strong>{{ message }}</p>
    <h3>已配置工作流</h3>
    <p v-if="!workflows.length">暂无工作流</p>
    <div v-for="p in workflows" :key="p.id" class="actions">
      <button class="workflow-name" type="button" @click="load(p.id)">{{ labels[p.kind] }} · {{ p.name }}</button>
      <button type="button" :aria-label="`删除工作流 ${p.name}`" @click="remove(p.id)">删除</button>
    </div>
  </section>
</template>

<style scoped>
.comfy-page { display: grid; gap: 12px; max-width: 760px; }
.comfy-page h2, .comfy-page h3, .comfy-page p { margin: 0; }
.comfy-page p { color: var(--color-text-3); }
label { display: grid; gap: 4px; }
input, select, button { padding: 8px 10px; color: inherit; background: var(--color-bg-2); border: 1px solid var(--color-border); border-radius: 6px; }
button { cursor: pointer; text-align: left; }
button:disabled { opacity: .5; cursor: default; }
.actions { display: flex; gap: 8px; }
.comfy-page .feedback { padding: 10px 12px; border: 1px solid currentColor; border-radius: 8px; color: #93c5fd; background: #3b82f620; }
.comfy-page .feedback.error { color: #fca5a5; background: #ef444423; }
.comfy-page .feedback.success { color: #86efac; background: #22c55e20; }
.workflow-name { flex: 1; }
</style>
