<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useAssetsStore, useProjectStore, useSettingsStore, useToastStore } from '@/stores'
import { runCanvasNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import { TTS_PRESETS } from '@/stores/settings'
import { VOICE_CLONE_MODEL, modelAcceptsReferenceAudio } from '@/services/ai/voiceClone'
import { pickLocalFiles } from '@/utils/pickLocalFiles'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'
import NodeLinkPlus from '@/components/canvas/NodeLinkPlus.vue'

const props = defineProps<{
  id: string
  selected?: boolean
  data: {
    label?: string
    prompt?: string
    outputAssetId?: string
    ttsModel?: string
    referenceAudioAssetId?: string
    clonedVoiceId?: string
    clonedVoiceModel?: string
  }
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const settings = useSettingsStore()
const toast = useToastStore()
const { updateNodeData } = useVueFlow()

const panelOpen = ref(true)
const busyLabel = ref('')
const uploading = ref(false)
const mediaUrl = ref('')
const refUrl = ref('')
const refName = ref('')
let mediaSeq = 0

const node = computed(() => project.current?.canvas?.nodes.find((item) => item.id === props.id))
const prompt = computed({
  get: () => node.value?.data.prompt ?? props.data.prompt ?? '',
  set: (value: string) => {
    project.setCanvasNodePrompt(props.id, value)
    updateNodeData(props.id, { ...props.data, prompt: value, nodeType: 'audioGen' })
  }
})
const outputId = computed(() => node.value?.data.outputAssetId || props.data.outputAssetId || '')
const generating = computed(() => isNodeRunning(props.id) || node.value?.status === 'running')
const hasAsset = computed(() => Boolean(outputId.value))
const title = computed(() => node.value?.data.label || props.data.label || '音频')
const failMsg = computed(() =>
  node.value?.status === 'failed' ? node.value.error || '生成失败' : ''
)
const modelOptions = computed(() => {
  const profile =
    settings.config.ttsProfiles.find((item) => item.id === settings.config.activeTtsId) ||
    settings.config.ttsProfiles[0]
  const names = [
    node.value?.data.ttsModel,
    settings.config.tts.model,
    ...(profile?.models ?? []),
    ...TTS_PRESETS,
    VOICE_CLONE_MODEL
  ]
  return [...new Set(names.map((item) => (item || '').trim()).filter(Boolean))]
})
const selectedModel = computed(
  () => node.value?.data.ttsModel?.trim() || settings.config.tts.model || modelOptions.value[0] || ''
)
const acceptsRef = computed(() => modelAcceptsReferenceAudio(selectedModel.value))
const refId = computed(() => node.value?.data.referenceAudioAssetId || '')

watch(
  () => props.selected,
  (on) => {
    panelOpen.value = Boolean(on)
  },
  { immediate: true }
)

watch(
  outputId,
  async (id) => {
    const seq = ++mediaSeq
    if (!id) {
      mediaUrl.value = ''
      return
    }
    const url = (await assets.getUrl(id)) || ''
    if (seq !== mediaSeq) return
    mediaUrl.value = url
  },
  { immediate: true }
)

watch(
  refId,
  async (id) => {
    if (!id) {
      refUrl.value = ''
      refName.value = ''
      return
    }
    refUrl.value = (await assets.getUrl(id)) || ''
    refName.value = assets.getMeta(id)?.filename || '参考音频'
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  mediaSeq += 1
  mediaUrl.value = ''
  refUrl.value = ''
})

function modelLabel(id: string) {
  if (id === VOICE_CLONE_MODEL || modelAcceptsReferenceAudio(id)) return `${id} · 可参考音频`
  return id
}

function pickModel(ev: Event) {
  const value = (ev.target as HTMLSelectElement).value
  project.patchCanvasNode(props.id, { ttsModel: value })
  updateNodeData(props.id, { ...props.data, ttsModel: value, nodeType: 'audioGen' })
}

async function pickAudioFile(limitMb: number) {
  let file: File | undefined
  try {
    file = (await pickLocalFiles({ kind: 'audio', multiple: false }))[0]
  } catch (e: any) {
    toast.error(e?.message || '读取音频失败')
    return
  }
  if (!file) return
  const looksAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)
  if (!looksAudio) {
    toast.error('请选择音频文件')
    return
  }
  if (file.size > limitMb * 1024 * 1024) {
    toast.error(`音频不能超过 ${limitMb} MB`)
    return
  }
  return file
}

async function uploadOutput() {
  if (uploading.value || generating.value) return
  const file = await pickAudioFile(30)
  if (!file) return
  uploading.value = true
  try {
    const asset = await assets.add(file, 'audio', 'uploaded', {
      filename: file.name,
      projectId: project.current?.id
    })
    project.assignCanvasNodeAsset(props.id, asset.id)
    updateNodeData(props.id, {
      ...props.data,
      outputAssetId: asset.id,
      nodeType: 'audioGen'
    })
    await project.save()
    toast.success('音频已上传')
  } catch (e: any) {
    toast.error(e?.message || '上传失败')
  } finally {
    uploading.value = false
  }
}

async function pickRef() {
  if (uploading.value) return
  const file = await pickAudioFile(10)
  if (!file) return
  uploading.value = true
  try {
    const asset = await assets.add(file, 'audio', 'uploaded', {
      filename: file.name,
      projectId: project.current?.id
    })
    project.patchCanvasNode(props.id, {
      referenceAudioAssetId: asset.id,
      clonedVoiceId: undefined,
      clonedVoiceModel: undefined
    })
    updateNodeData(props.id, {
      ...props.data,
      referenceAudioAssetId: asset.id,
      clonedVoiceId: undefined,
      clonedVoiceModel: undefined,
      nodeType: 'audioGen'
    })
    await project.save()
    toast.success('参考音频已上传，生成时会按这段声音复刻')
  } catch (e: any) {
    toast.error(e?.message || '上传失败')
  } finally {
    uploading.value = false
  }
}

function removeRef() {
  project.patchCanvasNode(props.id, {
    referenceAudioAssetId: undefined,
    clonedVoiceId: undefined,
    clonedVoiceModel: undefined
  })
  updateNodeData(props.id, {
    ...props.data,
    referenceAudioAssetId: undefined,
    clonedVoiceId: undefined,
    clonedVoiceModel: undefined,
    nodeType: 'audioGen'
  })
  toast.success('已移除参考音频')
}

async function generate() {
  if (generating.value) return
  if (!prompt.value.trim()) {
    toast.warn('先写下要说的内容')
    return
  }
  if (acceptsRef.value && !refId.value && !node.value?.data.clonedVoiceId) {
    toast.warn('这个模型需要先上传参考音频')
    return
  }
  busyLabel.value = '合成音频…'
  try {
    await runCanvasNode(props.id, (_id, msg) => {
      busyLabel.value = msg
    })
    const next = project.current?.canvas?.nodes.find((item) => item.id === props.id)
    if (next?.data.outputAssetId) {
      updateNodeData(props.id, { ...next.data, nodeType: 'audioGen' })
    }
    toast.success('音频已生成')
  } catch (e: unknown) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '生成失败', 10000)
  } finally {
    busyLabel.value = ''
  }
}

async function downloadAsset() {
  if (!outputId.value) return
  const blob = await assets.getBlob(outputId.value)
  if (!blob) {
    toast.error('素材读取失败')
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.value}.mp3`
  a.click()
  URL.revokeObjectURL(url)
}

function duplicateSelf() {
  const nid = project.duplicateCanvasNode(props.id)
  if (!nid) {
    toast.warn('复制失败')
    return
  }
  toast.success('已复制节点')
}

function removeSelf() {
  project.removeCanvasNode(props.id)
}
</script>

<template>
  <div class="fnode kind-audio" :class="{ on: selected && panelOpen, empty: !hasAsset, busy: generating }">
    <NodeLinkPlus :node-id="id" />
    <Handle id="in" type="target" :position="Position.Left" class="hndl" />

    <transition name="float-up">
      <div v-if="selected && panelOpen" class="toolbar-wrap nodrag nowheel" @mousedown.stop @click.stop>
        <div class="toolbar">
          <button type="button" :disabled="generating" @click="generate"><span>↺</span>{{ hasAsset ? '重做' : '出音频' }}</button>
          <button type="button" :disabled="uploading || generating" @click="uploadOutput"><span>↑</span>{{ uploading ? '上传中' : '上传' }}</button>
          <button type="button" @click="duplicateSelf"><span>❐</span>复制</button>
          <button v-if="hasAsset" type="button" @click="downloadAsset"><span>⬇</span>下载</button>
          <button type="button" @click="removeSelf">删除</button>
        </div>
      </div>
    </transition>

    <div class="media">
      <audio v-if="mediaUrl" class="player nodrag nowheel" :src="mediaUrl" controls @mousedown.stop />
      <button v-else type="button" class="ph nodrag" :disabled="uploading || generating" @click.stop="uploadOutput">
        <span class="wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span>{{ uploading ? '上传中…' : '上传音频' }}</span>
      </button>
      <NodeBusyOverlay v-if="generating" :label="busyLabel || '合成音频…'" />
      <div v-if="failMsg && !generating" class="fail" :title="failMsg">{{ failMsg }}</div>
    </div>

    <div class="name">
      <span class="kind">音频</span>
      <span class="title">{{ title }}</span>
    </div>

    <transition name="float-down">
      <div
        v-if="selected && panelOpen"
        class="prompt nodrag nowheel"
        @pointerdown.stop
        @mousedown.stop
        @click.stop
      >
        <textarea v-model="prompt" rows="4" placeholder="写下要说的话，或直接上传一段音频。支持参考音频的模型还可以上传声音样本。" />
        <button type="button" class="upload own" :disabled="uploading || generating" @click="uploadOutput">
          {{ uploading ? '上传中…' : hasAsset ? '更换音频' : '上传音频' }}
        </button>
        <label class="model">
          <span>配音模型</span>
          <select :value="selectedModel" @change="pickModel">
            <option v-for="id in modelOptions" :key="id" :value="id">{{ modelLabel(id) }}</option>
          </select>
        </label>
        <div v-if="acceptsRef" class="ref">
          <template v-if="refUrl">
            <audio class="ref-player nodrag nowheel" :src="refUrl" controls @mousedown.stop />
            <span class="ref-name" :title="refName">{{ refName }}</span>
            <button type="button" class="ghost" @click="removeRef">移除</button>
          </template>
          <button v-else type="button" class="upload" :disabled="uploading" @click="pickRef">
            {{ uploading ? '上传中…' : '上传参考音频' }}
          </button>
          <p>生成时会用这段样本复刻音色。</p>
        </div>
        <div class="foot">
          <button class="go" type="button" :disabled="generating" @click="generate">↑</button>
        </div>
      </div>
    </transition>

    <Handle id="out" type="source" :position="Position.Right" class="hndl" />
  </div>
</template>

<style scoped>
.fnode {
  position: relative;
  width: 240px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-node-border);
  border-radius: 6px;
  color: var(--color-text-1);
  box-shadow: var(--shadow-node);
}
.fnode.on {
  border-color: var(--color-text-1);
  box-shadow: 0 0 0 1px var(--color-text-1), var(--shadow-md);
  z-index: 4;
}
.fnode.busy {
  border-color: var(--color-accent);
  z-index: 5;
}
.toolbar-wrap {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  z-index: 6;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 10px;
  background: #2a2a32;
  border: 1px solid var(--color-border);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
}
.toolbar > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-1);
  cursor: pointer;
  font-size: 12px;
}
.toolbar > button:hover {
  background: rgba(255, 255, 255, 0.08);
}
.toolbar > button:disabled {
  opacity: 0.45;
  cursor: default;
}
.media {
  position: relative;
  height: 92px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 5px 5px 0 0;
  background:
    radial-gradient(circle at 20% 20%, rgba(126, 180, 255, 0.16), transparent 46%),
    var(--color-bg-2);
}
.player {
  width: calc(100% - 16px);
}
.ph {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  cursor: pointer;
}
.ph:disabled {
  cursor: default;
}
.wave {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 22px;
}
.wave i {
  display: block;
  width: 3px;
  border-radius: 2px;
  background: currentColor;
}
.wave i:nth-child(1) { height: 8px; }
.wave i:nth-child(2) { height: 16px; }
.wave i:nth-child(3) { height: 22px; }
.wave i:nth-child(4) { height: 12px; }
.wave i:nth-child(5) { height: 18px; }
.fail {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 6px;
  color: var(--color-error, #f87171);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.name {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 10px;
  font-size: 12px;
}
.kind {
  color: var(--color-accent);
  font-weight: 700;
}
.title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prompt {
  position: absolute;
  left: 0;
  top: calc(100% + 8px);
  z-index: 5;
  width: 360px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
}
.prompt textarea {
  width: 100%;
  min-height: 88px;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 13px;
  line-height: 1.55;
  font-family: inherit;
}
.model {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: var(--color-text-3);
  font-size: 12px;
}
.model select {
  flex: 1;
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
}
.ref {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ref p {
  width: 100%;
  margin: 0;
  color: var(--color-text-3);
  font-size: 11px;
  line-height: 1.45;
}
.upload,
.ghost,
.go {
  margin: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  cursor: pointer;
}
.upload,
.ghost {
  height: 30px;
  padding: 0 10px;
  font-size: 12px;
}
.upload.own {
  margin-top: 8px;
}
.ref-player {
  width: 180px;
  height: 30px;
}
.ref-name {
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-text-2);
}
.foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.go {
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: var(--color-text-1);
  color: var(--color-bg-1);
  font-weight: 700;
}
.go:disabled,
.upload:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
