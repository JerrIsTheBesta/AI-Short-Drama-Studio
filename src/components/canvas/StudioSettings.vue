<script setup lang="ts">
import { computed, ref } from 'vue'
import { useProjectStore, useSettingsStore, uniqueProfileName } from '@/stores'
import { TTS_VOICES } from '@/services/ai/tts'
import EndpointForm from '@/components/settings/EndpointForm.vue'
import ProfileLibrary from '@/components/settings/ProfileLibrary.vue'
import { type VideoStillMode } from '@/types/canvas'
import { syncH3ShotStillModes } from '@/services/canvas/videoModel'
import {
  IMAGE_PROVIDERS,
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  VIDEO_PROVIDERS,
  VISION_PROVIDERS,
  applyProviderPreset,
  findProvider,
  type ProviderPreset
} from '@/services/ai/providers'

defineProps<{
  module: 'llm' | 'vision' | 'image' | 'tts' | 'video'
}>()

const settings = useSettingsStore()
const project = useProjectStore()
const showVideoKey = ref(false)

const llmName = computed({
  get: () => settings.config.llms.find((p) => p.id === settings.config.activeLlmId)?.name ?? '',
  set: (v: string) => settings.renameLlm(v)
})
const visionName = computed({
  get: () => settings.config.visions.find((p) => p.id === settings.config.activeVisionId)?.name ?? '',
  set: (v: string) => settings.renameVision(v)
})
const imageName = computed({
  get: () => settings.config.images.find((p) => p.id === settings.config.activeImageId)?.name ?? '',
  set: (v: string) => settings.renameImage(v)
})
const ttsName = computed({
  get: () => settings.config.ttsProfiles.find((p) => p.id === settings.config.activeTtsId)?.name ?? '',
  set: (v: string) => settings.renameTts(v)
})
const videoName = computed({
  get: () => settings.config.videos.find((p) => p.id === settings.config.activeVideoId)?.name ?? '',
  set: (v: string) => settings.renameVideo(v)
})
const videoUrl = computed({
  get: () => settings.config.video.baseUrl,
  set: (v: string) => settings.patchVideo({ baseUrl: v })
})
const videoWorkflow = computed({
  get: () => settings.config.video.workflowId,
  set: (v: string) => settings.patchVideo({ workflowId: v })
})
const videoKey = computed({
  get: () => settings.config.video.apiKey,
  set: (v: string) => settings.patchVideo({ apiKey: v })
})
const ttsVoice = computed({
  get: () => settings.config.tts.voice,
  set: (v: string) => onVoice(v)
})

function onVoice(v: string) {
  settings.patchTts({ voice: v })
  if (project.current) project.setSettings({ ttsVoice: v })
}

function subtitle(p: { models?: string[]; model?: string; workflowId?: string }) {
  if (p.workflowId) return p.workflowId
  const n = p.models?.length || 0
  if (n) return `${n} 个模型 · ${p.model || '未选'}`
  return p.model || '未选模型'
}

function createNamed(
  kind: 'llm' | 'vision' | 'image' | 'tts',
  providerId: string,
  presets: ProviderPreset[],
  existing: string[],
  fallbackName: string
) {
  const preset = findProvider(providerId, presets)
  const applied = applyProviderPreset({ baseUrl: '', model: '', models: [] }, preset)
  const name = uniqueProfileName(
    existing,
    preset.id === 'custom' ? fallbackName : preset.name
  )
  const seed = {
    name,
    baseUrl: applied.baseUrl,
    apiKey: '',
    model: applied.model,
    models: applied.models,
    provider: applied.provider
  }
  if (kind === 'llm') settings.addLlm(seed)
  else if (kind === 'vision') settings.addVision(seed)
  else if (kind === 'image') settings.addImage(seed)
  else settings.addTts(seed)
}

function createVideo(providerId: string) {
  const preset = findProvider(providerId, VIDEO_PROVIDERS)
  const name = uniqueProfileName(
    settings.config.videos.map((p) => p.name),
    preset.id === 'custom' ? '自定义视频' : preset.name
  )
  settings.addVideo({
    name,
    baseUrl: preset.baseUrl || '',
    apiKey: '',
    workflowId: preset.defaultModel || '',
    promptStyle: 'scene-narrative',
    provider: preset.id,
    stillMode: preset.id === 'autodl' ? 'identity' : 'keyframe'
  })
}

function patchVideoStillMode(mode: VideoStillMode) {
  settings.patchVideo({ stillMode: mode })
  syncH3ShotStillModes(mode)
}
</script>

<template>
  <div class="mods">
    <template v-if="module === 'llm'">
      <ProfileLibrary
        title="已保存的语言模型"
        hint="每种接入保存成一项。同一项下面可加多个模型名，智能体和写剧本时就能切换。"
        :profiles="settings.config.llms.map((p) => ({ id: p.id, name: p.name, subtitle: subtitle(p) }))"
        :active-id="settings.config.activeLlmId"
        :providers="LLM_PROVIDERS"
        @select="settings.selectLlm"
        @create="createNamed('llm', $event, LLM_PROVIDERS, settings.config.llms.map((p) => p.name), '自定义 LLM')"
        @remove="settings.removeLlm(settings.config.activeLlmId)"
      />
      <label class="name-label">名称</label>
      <input
        class="name-input"
        v-model="llmName"
        placeholder="例如 DeepSeek 官方"
      />
      <EndpointForm
        title="连接信息"
        hint="智能体、写剧本、提炼分镜、以及设置页的接入助手，都用当前选中的这一套。"
        :presets="LLM_PROVIDERS"
        :base-url="settings.config.llm.baseUrl"
        :api-key="settings.config.llm.apiKey"
        :model="settings.config.llm.model"
        :models="settings.config.llm.models"
        :provider="settings.config.llm.provider"
        @patch="settings.patchLlm($event)"
        @add-model="settings.addModel('llm', $event)"
        @remove-model="settings.removeModel('llm', $event)"
      />
    </template>

    <template v-else-if="module === 'vision'">
      <ProfileLibrary
        title="已保存的视觉接入"
        hint="看图、质检用。可保存多套，在需要视觉能力的功能里切换。"
        :profiles="settings.config.visions.map((p) => ({ id: p.id, name: p.name, subtitle: subtitle(p) }))"
        :active-id="settings.config.activeVisionId"
        :providers="VISION_PROVIDERS"
        @select="settings.selectVision"
        @create="createNamed('vision', $event, VISION_PROVIDERS, settings.config.visions.map((p) => p.name), '自定义视觉')"
        @remove="settings.removeVision(settings.config.activeVisionId)"
      />
      <label class="name-label">名称</label>
      <input
        class="name-input"
        v-model="visionName"
        placeholder="例如 阿里云百炼视觉"
      />
      <EndpointForm
        title="连接信息"
        hint="只在看图、对画面做质检时调用，不参与写剧本。"
        :presets="VISION_PROVIDERS"
        :base-url="settings.config.vision.baseUrl"
        :api-key="settings.config.vision.apiKey"
        :model="settings.config.vision.model"
        :models="settings.config.vision.models"
        :provider="settings.config.vision.provider"
        @patch="settings.patchVision($event)"
        @add-model="settings.addModel('vision', $event)"
        @remove-model="settings.removeModel('vision', $event)"
      />
    </template>

    <template v-else-if="module === 'image'">
      <ProfileLibrary
        title="已保存的生图接入"
        hint="角色设计、场景图、故事看板。保存多套后，出图节点里可以直接切换。"
        :profiles="settings.config.images.map((p) => ({ id: p.id, name: p.name, subtitle: subtitle(p) }))"
        :active-id="settings.config.activeImageId"
        :providers="IMAGE_PROVIDERS"
        @select="settings.selectImage"
        @create="createNamed('image', $event, IMAGE_PROVIDERS, settings.config.images.map((p) => p.name), '自定义生图')"
        @remove="settings.removeImage(settings.config.activeImageId)"
      />
      <label class="name-label">名称</label>
      <input
        class="name-input"
        v-model="imageName"
        placeholder="例如 火山方舟 Seedream"
      />
      <EndpointForm
        title="连接信息"
        hint="选接入后填 Key，把要用的模型名加进列表。生成图片时可以直接切换。"
        :presets="IMAGE_PROVIDERS"
        :base-url="settings.config.image.baseUrl"
        :api-key="settings.config.image.apiKey"
        :model="settings.config.image.model"
        :models="settings.config.image.models"
        :provider="settings.config.image.provider"
        @patch="settings.patchImage($event)"
        @add-model="settings.addModel('image', $event)"
        @remove-model="settings.removeModel('image', $event)"
      />
    </template>

    <template v-else-if="module === 'tts'">
      <ProfileLibrary
        title="已保存的配音接入"
        hint="后期独立口播。百炼走语音合成接口，不是聊天补全。"
        :profiles="settings.config.ttsProfiles.map((p) => ({ id: p.id, name: p.name, subtitle: subtitle(p) }))"
        :active-id="settings.config.activeTtsId"
        :providers="TTS_PROVIDERS"
        @select="settings.selectTts"
        @create="createNamed('tts', $event, TTS_PROVIDERS, settings.config.ttsProfiles.map((p) => p.name), '自定义配音')"
        @remove="settings.removeTts(settings.config.activeTtsId)"
      />
      <label class="name-label">名称</label>
      <input
        class="name-input"
        v-model="ttsName"
        placeholder="例如 阿里云百炼 TTS"
      />
      <EndpointForm
        title="连接信息"
        hint="口播 TTS。配好后可在字幕页和口播节点里选用。"
        :presets="TTS_PROVIDERS"
        :base-url="settings.config.tts.baseUrl"
        :api-key="settings.config.tts.apiKey"
        :model="settings.config.tts.model"
        :models="settings.config.tts.models"
        :provider="settings.config.tts.provider"
        @patch="settings.patchTts($event)"
        @add-model="settings.addModel('tts', $event)"
        @remove-model="settings.removeModel('tts', $event)"
      >
        <label class="extra-label">音色</label>
        <select v-model="ttsVoice">
          <option v-for="v in TTS_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
        </select>
      </EndpointForm>
    </template>

    <template v-else-if="module === 'video'">
      <ProfileLibrary
        title="已保存的视频接入"
        hint="图生视频工作流。多套令牌或工作流可以分开保存，出视频时选用。"
        :profiles="settings.config.videos.map((p) => ({ id: p.id, name: p.name, subtitle: subtitle(p) }))"
        :active-id="settings.config.activeVideoId"
        :providers="VIDEO_PROVIDERS"
        @select="settings.selectVideo"
        @create="createVideo"
        @remove="settings.removeVideo(settings.config.activeVideoId)"
      />
      <label class="name-label">名称</label>
      <input
        class="name-input"
        v-model="videoName"
        placeholder="例如 AutoDL H3"
      />
      <section class="video">
        <h3>图生视频</h3>
        <p class="hint">
          H3 走 AutoDL 算力上的 ComfyUI 工作流，不是海螺官方接口。节点也可改选阿里云万相 3.0 Prime。
          可在此添加其它工作流；参考图方式决定出视频前要不要铺分镜关键帧。
        </p>
        <label>参考图方式</label>
        <div class="style-cards">
          <button
            type="button"
            :class="{ on: (settings.config.video.stillMode || 'identity') === 'identity' }"
            @click="patchVideoStillMode('identity')"
          >
            <strong>人设 + 场景</strong>
            <span>H3 推荐。出视频只传角色设计图和场景图，不经过分镜关键帧或故事看板，减少多人物。</span>
          </button>
          <button
            type="button"
            :class="{ on: settings.config.video.stillMode === 'keyframe' }"
            @click="patchVideoStillMode('keyframe')"
          >
            <strong>人设 + 场景 + 关键帧</strong>
            <span>万相及其他模型。画布会铺「分镜关键帧」，出视频前先出四宫格。</span>
          </button>
          <button
            type="button"
            :class="{ on: settings.config.video.stillMode === 'storyboard' }"
            @click="patchVideoStillMode('storyboard')"
          >
            <strong>人设 + 场景 + 故事看板</strong>
            <span>短剧可选。画布铺看板，出视频带上六格动作计划。</span>
          </button>
        </div>
        <label>提示词写法</label>
        <div class="style-cards">
          <button
            type="button"
            :class="{ on: (settings.config.video.promptStyle || 'scene-narrative') === 'scene-narrative' }"
            @click="settings.patchVideo({ promptStyle: 'scene-narrative' })"
          >
            <strong>场景叙事</strong>
            <span>选 H3 时按 Ref2VA 六段出片：人设/场景/看板不是首帧。[Shot 1] 不加时间戳。台词只进 &lt;d&gt; 标签。选万相不套这套格式。</span>
          </button>
          <button
            type="button"
            :class="{ on: settings.config.video.promptStyle === 'formatted' }"
            @click="settings.patchVideo({ promptStyle: 'formatted' })"
          >
            <strong>格式化</strong>
            <span>人物图 + 空镜底板直接出视频。按 Aesthetic / SHOT / Visual Prompt 结构组装。</span>
          </button>
        </div>
        <label>服务地址</label>
        <input
          v-model="videoUrl"
          placeholder="https://autodl.art"
        />
        <label>工作流 ID</label>
        <input
          v-model="videoWorkflow"
          placeholder="minimax_h3_lightx2v_v5_15s"
        />
        <label>令牌</label>
        <div class="secret">
          <input
            :type="showVideoKey ? 'text' : 'password'"
            autocomplete="off"
            v-model="videoKey"
            placeholder="AutoDL Token"
          />
          <button type="button" class="eye" @click="showVideoKey = !showVideoKey">
            {{ showVideoKey ? '隐藏' : '显示' }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.mods {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.video {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 640px;
}
.video h3 {
  margin: 0 0 2px;
  font-size: 15px;
  font-weight: 650;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.5;
}
label,
.extra-label,
.name-label {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
input,
select {
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
.secret {
  display: flex;
  gap: 6px;
  max-width: 640px;
}
.secret input {
  flex: 1;
  min-width: 0;
}
.eye {
  flex-shrink: 0;
  margin: 0;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
  font-size: 12px;
  white-space: nowrap;
}
.eye:hover {
  color: var(--color-text-1);
}
.name-input {
  max-width: 640px;
}
.style-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0 10px;
}
.style-cards button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  text-align: left;
}
.style-cards button.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: var(--color-fill);
}
.style-cards strong {
  font-size: 13px;
}
.style-cards span {
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-4);
}
</style>
