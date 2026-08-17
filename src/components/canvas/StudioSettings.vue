<script setup lang="ts">
import { ref } from 'vue'
import { useProjectStore, useSettingsStore } from '@/stores'
import { TTS_VOICES } from '@/services/ai/tts'
import { getAIMode } from '@/services/ai/client'

const settings = useSettingsStore()
const project = useProjectStore()
const llmDraft = ref('')
const imageDraft = ref('')
const ttsDraft = ref('')

function addLlm() {
  settings.addModel('llm', llmDraft.value)
  llmDraft.value = ''
}
function addImage() {
  settings.addModel('image', imageDraft.value)
  imageDraft.value = ''
}
function addTts() {
  settings.addModel('tts', ttsDraft.value)
  ttsDraft.value = ''
}

function onVoice(v: string) {
  settings.patchTts({ voice: v })
  if (project.current) project.setSettings({ ttsVoice: v })
}
</script>

<template>
  <aside class="panel">
    <p class="lead">配好地址和密钥，模型就能在下拉里选。改完立刻生效，不用重启。</p>

    <section>
      <h4>模式</h4>
      <div class="seg">
        <button :class="{ on: settings.config.aiMode === 'mock' }" @click="settings.update({ aiMode: 'mock' })">
          演示
        </button>
        <button :class="{ on: settings.config.aiMode === 'real' }" @click="settings.update({ aiMode: 'real' })">
          真实 API
        </button>
      </div>
      <p class="hint">当前：{{ getAIMode() === 'real' ? '走真实接口' : '演示数据' }}</p>
    </section>

    <section>
      <h4>LLM · 分镜 / 智能体</h4>
      <label>接口地址</label>
      <input
        :value="settings.config.llm.baseUrl"
        placeholder="https://api.apiyi.com/v1"
        @change="settings.patchLlm({ baseUrl: ($event.target as HTMLInputElement).value.trim() })"
      />
      <label>API Key</label>
      <input
        type="password"
        autocomplete="off"
        :value="settings.config.llm.apiKey"
        placeholder="sk-…"
        @change="settings.patchLlm({ apiKey: ($event.target as HTMLInputElement).value.trim() })"
      />
      <label>当前模型</label>
      <select
        :value="settings.config.llm.model"
        @change="settings.patchLlm({ model: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="m in settings.config.llm.models" :key="m" :value="m">{{ m }}</option>
      </select>
      <div class="add-row">
        <input v-model="llmDraft" placeholder="添加模型名" @keydown.enter.prevent="addLlm" />
        <button class="mini" @click="addLlm">添加</button>
      </div>
    </section>

    <section>
      <h4>生图</h4>
      <label>接口地址</label>
      <input
        :value="settings.config.image.baseUrl"
        placeholder="https://api.apiyi.com/v1"
        @change="settings.patchImage({ baseUrl: ($event.target as HTMLInputElement).value.trim() })"
      />
      <label>API Key</label>
      <input
        type="password"
        autocomplete="off"
        :value="settings.config.image.apiKey"
        placeholder="sk-…"
        @change="settings.patchImage({ apiKey: ($event.target as HTMLInputElement).value.trim() })"
      />
      <label>当前模型</label>
      <select
        :value="settings.config.image.model"
        @change="settings.patchImage({ model: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="m in settings.config.image.models" :key="m" :value="m">{{ m }}</option>
      </select>
      <div class="add-row">
        <input v-model="imageDraft" placeholder="添加模型名" @keydown.enter.prevent="addImage" />
        <button class="mini" @click="addImage">添加</button>
      </div>
    </section>

    <section>
      <h4>配音</h4>
      <label>接口地址</label>
      <input
        :value="settings.config.tts.baseUrl"
        placeholder="https://dashscope.aliyuncs.com/api/v1"
        @change="settings.patchTts({ baseUrl: ($event.target as HTMLInputElement).value.trim() })"
      />
      <label>API Key</label>
      <input
        type="password"
        autocomplete="off"
        :value="settings.config.tts.apiKey"
        placeholder="sk-…"
        @change="settings.patchTts({ apiKey: ($event.target as HTMLInputElement).value.trim() })"
      />
      <label>当前模型</label>
      <select
        :value="settings.config.tts.model"
        @change="settings.patchTts({ model: ($event.target as HTMLSelectElement).value })"
      >
        <option v-for="m in settings.config.tts.models" :key="m" :value="m">{{ m }}</option>
      </select>
      <div class="add-row">
        <input v-model="ttsDraft" placeholder="添加模型名" @keydown.enter.prevent="addTts" />
        <button class="mini" @click="addTts">添加</button>
      </div>
      <label>音色</label>
      <select :value="settings.config.tts.voice" @change="onVoice(($event.target as HTMLSelectElement).value)">
        <option v-for="v in TTS_VOICES" :key="v.id" :value="v.id">{{ v.label }}</option>
      </select>
    </section>

    <section>
      <h4>图生视频</h4>
      <label>ComfyUI 地址</label>
      <input
        :value="settings.config.video.baseUrl"
        placeholder="https://host:port"
        @change="settings.patchVideo({ baseUrl: ($event.target as HTMLInputElement).value.trim() })"
      />
      <label>工作流 ID</label>
      <input
        :value="settings.config.video.workflowId"
        @change="settings.patchVideo({ workflowId: ($event.target as HTMLInputElement).value.trim() })"
      />
      <label>API Key（可空）</label>
      <input
        type="password"
        autocomplete="off"
        :value="settings.config.video.apiKey"
        @change="settings.patchVideo({ apiKey: ($event.target as HTMLInputElement).value.trim() })"
      />
    </section>
  </aside>
</template>

<style scoped>
.panel {
  width: 300px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 12px 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.lead,
.hint {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-4);
  line-height: 1.5;
}
section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
h4 {
  margin: 0 0 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-2);
}
label {
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
  padding: 7px 8px;
  font: inherit;
  font-size: 12px;
}
.seg {
  display: flex;
  gap: 6px;
}
.seg button {
  flex: 1;
  font-size: 12px;
  padding: 6px;
  border-radius: 6px;
  color: var(--color-text-3);
  background: var(--color-bg-2);
}
.seg button.on {
  color: var(--color-text-1);
  background: var(--color-accent);
}
.add-row {
  display: flex;
  gap: 6px;
}
.add-row input {
  flex: 1;
  min-width: 0;
}
.mini {
  font-size: 12px;
  padding: 0 10px;
  border-radius: 6px;
  color: var(--color-text-2);
  background: var(--color-bg-3);
  white-space: nowrap;
}
.mini:hover {
  color: var(--color-text-1);
}
</style>
