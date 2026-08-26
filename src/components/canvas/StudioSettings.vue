<script setup lang="ts">
import { ref } from 'vue'
import { useProjectStore, useSettingsStore } from '@/stores'
import { TTS_VOICES } from '@/services/ai/tts'
import EndpointForm from '@/components/settings/EndpointForm.vue'
import {
  IMAGE_PROVIDERS,
  LLM_PROVIDERS,
  MUSIC_PROVIDERS,
  TTS_PROVIDERS,
  VISION_PROVIDERS,
  applyProviderPreset,
  findProvider
} from '@/services/ai/providers'

defineProps<{
  module: 'llm' | 'vision' | 'image' | 'tts' | 'video'
}>()

const settings = useSettingsStore()
const project = useProjectStore()
const addingLlm = ref(false)

function onVoice(v: string) {
  settings.patchTts({ voice: v })
  if (project.current) project.setSettings({ ttsVoice: v })
}

function createLlm(providerId: string) {
  const preset = findProvider(providerId, LLM_PROVIDERS)
  const applied = applyProviderPreset(
    { baseUrl: '', model: '', models: [] },
    preset
  )
  const names = new Set((settings.config.llms ?? []).map((p) => p.name))
  let name = preset.id === 'custom' ? '自定义 LLM' : preset.name
  if (names.has(name)) {
    let i = 2
    while (names.has(`${name} ${i}`)) i += 1
    name = `${name} ${i}`
  }
  settings.addLlm({
    name,
    baseUrl: applied.baseUrl,
    apiKey: '',
    model: applied.model,
    models: applied.models,
    provider: applied.provider
  })
  addingLlm.value = false
}

function removeActiveLlm() {
  const id = settings.config.activeLlmId
  if (!id) return
  settings.removeLlm(id)
}
</script>

<template>
  <div class="mods">
    <section v-if="module === 'llm'" class="llm-lib">
      <div class="llm-head">
        <h4>已保存的 LLM</h4>
        <button type="button" class="add-llm" @click="addingLlm = !addingLlm">
          {{ addingLlm ? '取消' : '添加' }}
        </button>
      </div>
      <p class="hint">每种接入保存成一项（官方或聚合）。同一项下面可加多个模型名，智能体和写剧本时就能切换。</p>
      <div v-if="addingLlm" class="add-pick">
        <p>选择接入方式</p>
        <button
          v-for="p in LLM_PROVIDERS"
          :key="p.id"
          type="button"
          :title="p.hint"
          @click="createLlm(p.id)"
        >
          {{ p.name }}
        </button>
      </div>
      <div class="llm-cards">
        <button
          v-for="p in settings.config.llms"
          :key="p.id"
          type="button"
          :class="{ on: p.id === settings.config.activeLlmId }"
          @click="settings.selectLlm(p.id)"
        >
          <strong>{{ p.name }}</strong>
          <span>{{ p.models?.length ? `${p.models.length} 个模型 · ${p.model || '未选'}` : p.model || '未选模型' }}</span>
        </button>
      </div>
    </section>

    <template v-if="module === 'llm'">
      <label class="name-label">名称</label>
      <input
        class="name-input"
        :value="settings.config.llms.find((p) => p.id === settings.config.activeLlmId)?.name"
        placeholder="例如 DeepSeek 官方"
        @change="settings.renameLlm(($event.target as HTMLInputElement).value)"
      />
      <EndpointForm
        title="连接信息"
        hint="智能体、写剧本、提炼分镜都用当前选中的这一套。聚合平台只需一套 Key，在下方把要用的模型名都加进来。"
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
      <button
        v-if="(settings.config.llms?.length || 0) > 1"
        type="button"
        class="danger"
        @click="removeActiveLlm"
      >
        删除这项 LLM
      </button>
    </template>

    <EndpointForm
      v-else-if="module === 'vision'"
      title="视觉理解"
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

    <EndpointForm
      v-else-if="module === 'image'"
      title="生图"
      hint="角色设计、资产图、场景宫格和故事看板。选接入后填 Key，把要用的模型名加进列表。生成图片时可以直接切换。"
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

    <EndpointForm
      v-else-if="module === 'tts'"
      title="配音 TTS"
      hint="后期独立口播。百炼走语音合成接口，不是聊天补全。"
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
      <select :value="settings.config.tts.voice" @change="onVoice(($event.target as HTMLSelectElement).value)">
        <option v-for="v in TTS_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
      </select>
    </EndpointForm>

    <template v-else-if="module === 'video'">
      <section class="video">
        <h3>图生视频</h3>
        <p class="hint">AutoDL.art MiniMax H3 图+音频生视频（minimax_h3_image_audio_to_video_v2_15s），分辨率固定 768p。多个镜头可以同时提交。</p>
        <label>提示词写法</label>
        <div class="style-cards">
          <button
            type="button"
            :class="{ on: (settings.config.video.promptStyle || 'scene-narrative') === 'scene-narrative' }"
            @click="settings.patchVideo({ promptStyle: 'scene-narrative' })"
          >
            <strong>场景叙事</strong>
            <span>按 H3 官方 I2VA 英文三段式出片。图槽传角色设计图、场景图和本镜故事看板，不传人物+场景配图。台词只进 &lt;d&gt; 标签；没有口播就写 No dialogue。</span>
          </button>
          <button
            type="button"
            :class="{ on: settings.config.video.promptStyle === 'formatted' }"
            @click="settings.patchVideo({ promptStyle: 'formatted' })"
          >
            <strong>格式化</strong>
            <span>人物图 + 空镜底板直接出视频。按 Aesthetic / SHOT / Visual Prompt 结构组装，适合画面里还没合成好人。</span>
          </button>
        </div>
        <label>服务地址</label>
        <input
          :value="settings.config.video.baseUrl"
          placeholder="https://autodl.art"
          @change="settings.patchVideo({ baseUrl: ($event.target as HTMLInputElement).value.trim() })"
        />
        <label>工作流 ID</label>
        <input
          :value="settings.config.video.workflowId"
          placeholder="minimax_h3_image_audio_to_video_v2_15s"
          @change="settings.patchVideo({ workflowId: ($event.target as HTMLInputElement).value.trim() })"
        />
        <label>令牌</label>
        <input
          type="password"
          autocomplete="off"
          :value="settings.config.video.apiKey"
          placeholder="AutoDL.art Token"
          @change="settings.patchVideo({ apiKey: ($event.target as HTMLInputElement).value.trim() })"
        />
      </section>

      <EndpointForm
        title="配乐"
        hint="整片 BGM，可选。"
        :presets="MUSIC_PROVIDERS"
        :base-url="settings.config.music.baseUrl"
        :api-key="settings.config.music.apiKey"
        :model="settings.config.music.model"
        :models="settings.config.music.models"
        :provider="settings.config.music.provider"
        @patch="settings.patchMusic($event)"
        @add-model="settings.addModel('music', $event)"
        @remove-model="settings.removeModel('music', $event)"
      />
    </template>
  </div>
</template>

<style scoped>
.mods {
  display: flex;
  flex-direction: column;
  gap: 28px;
}
.video {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 560px;
}
.video h3 {
  margin: 0 0 2px;
  font-size: 16px;
  font-weight: 700;
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.5;
}
label,
.extra-label {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-4);
}
input,
select {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-1);
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
}
.llm-lib {
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.llm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.llm-head h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}
.add-llm {
  margin: 0;
  padding: 5px 12px;
  border-radius: 8px;
  background: var(--color-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 650;
}
.add-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px;
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-2);
}
.add-pick p {
  width: 100%;
  margin: 0 0 2px;
  font-size: 12px;
  color: var(--color-text-4);
}
.add-pick button {
  margin: 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
  font-size: 12px;
}
.add-pick button:hover {
  color: var(--color-text-1);
  background: var(--color-accent);
}
.llm-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.llm-cards button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 0;
  min-width: 120px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  text-align: left;
}
.llm-cards button.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: var(--color-fill);
}
.llm-cards strong {
  font-size: 13px;
}
.llm-cards span {
  font-size: 11px;
  color: var(--color-text-4);
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
  border-radius: 10px;
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
.name-label {
  margin-top: 0;
  font-size: 11px;
  color: var(--color-text-4);
}
.name-input {
  max-width: 560px;
}
.danger {
  max-width: 560px;
  margin: 0;
  padding: 8px 12px;
  border: 1px solid rgba(248, 113, 113, 0.35);
  border-radius: 8px;
  background: transparent;
  color: #fca5a5;
  font-size: 12px;
}
</style>
