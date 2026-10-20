<script setup lang="ts">
import { computed, ref } from 'vue'
import { endpointReady, useSettingsStore, useToastStore } from '@/stores'
import { AUTODL_BASE_URL, AUTODL_WORKFLOWS } from '@/services/ai/autodl'

const settings = useSettingsStore()
const toast = useToastStore()
const token = ref(settings.config.autodlToken || '')
const existing = computed(() =>
  settings.config.videos.filter((item) => item.provider === 'autodl' && Boolean(item.apiKey))
)
const configured = computed(() => Boolean(settings.config.autodlToken) && existing.value.length > 0)

function apply() {
  const key = token.value.trim()
  if (!key) {
    toast.error('请填写 AutoDL Token（在 AutoDL 控制台 → API 界面创建/复制）')
    return
  }
  settings.setAutodlToken(key)
  const previous = settings.config.activeVideoId
  for (const workflow of AUTODL_WORKFLOWS) {
    const profile = settings.config.videos.find(
      (item) => item.provider === 'autodl' && item.workflowId === workflow.id
    )
    const values = {
      name: workflow.name,
      baseUrl: AUTODL_BASE_URL,
      apiKey: key,
      workflowId: workflow.id,
      provider: 'autodl',
      stillMode: 'identity' as const,
      promptStyle: 'scene-narrative' as const,
      adapter: { type: 'comfyui-workflow' as const }
    }
    if (profile) {
      settings.selectVideo(profile.id)
      settings.patchVideo(values)
    } else settings.addVideo(values)
  }
  // 之前选中的视频接入可用就保持不动；不可用（比如默认接入没填 Key）则切到 H3 默认工作流。
  const previousProfile = settings.config.videos.find((item) => item.id === previous)
  if (previousProfile && endpointReady(previousProfile)) {
    settings.selectVideo(previous)
  } else {
    const fallback = settings.config.videos.find(
      (item) => item.provider === 'autodl' && item.workflowId === AUTODL_WORKFLOWS[0].id
    )
    if (fallback) settings.selectVideo(fallback.id)
  }
  toast.success('AutoDL 已配置，H3 系列模型可以直接用了')
}
</script>

<template>
  <div class="autodl-settings">
    <section class="panel">
      <div class="heading">
        <div><h2>AutoDL 算力</h2><p>H3 系列图生视频都走 AutoDL。只需填写一个 AutoDL Token，内置工作流自动配好，地址不用改。</p></div>
        <span class="badge" :class="{ ok: configured }">{{ configured ? '已配置' : '待配置' }}</span>
      </div>
      <label for="autodl-token">AutoDL Token</label>
      <div class="url-row">
        <input
          id="autodl-token"
          v-model="token"
          type="password"
          autocomplete="off"
          placeholder="在 AutoDL 控制台 → API 界面复制令牌"
          @keyup.enter="apply"
        />
        <button type="button" @click="apply">应用配置</button>
      </div>
      <p class="hint">
        Token 只保存在本机，且只用于 AutoDL 接入。获取方式：登录
        <a href="https://www.autodl.com" target="_blank" rel="noopener">autodl.com</a>
        → 控制台 → API 界面 → 复制令牌。
      </p>
    </section>
    <section class="panel">
      <h2>内置 H3 工作流（填完 Token 自动可用）</h2>
      <div class="workflow-list">
        <article v-for="workflow in AUTODL_WORKFLOWS" :key="workflow.id">
          <strong>{{ workflow.name }}</strong>
          <span>{{ workflow.mode === 'fl2va' ? '首尾帧' : workflow.mode === 'audio-sync' ? '口播' : '图生视频' }}</span>
          <small>{{ workflow.note }} · 最长 {{ workflow.maxDuration }} 秒</small>
        </article>
      </div>
    </section>
    <section v-if="configured" class="panel">
      <h2>已接入</h2>
      <ul class="ready-list">
        <li v-for="profile in existing" :key="profile.id">
          <b>{{ profile.name }}</b>
          <span>{{ profile.workflowId }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.autodl-settings{display:grid;gap:16px;max-width:820px}.panel{padding:20px;border:1px solid var(--color-border);border-radius:12px;background:var(--color-bg-1)}.heading{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}h2{margin:0 0 7px;font-size:16px}p{margin:0;color:var(--color-text-3);font-size:12px;line-height:1.6}.badge{padding:5px 9px;border-radius:999px;background:rgba(255,255,255,.08);color:var(--color-text-3);font-size:11px;white-space:nowrap}.badge.ok{background:rgba(66,199,124,.16);color:#57d08b}label{display:block;margin:18px 0 7px;color:var(--color-text-2);font-size:12px}.url-row{display:flex;gap:8px}input{flex:1;min-width:0;height:38px;padding:0 12px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-2);color:var(--color-text-1);outline:none}input:focus{border-color:#6792ff}button{height:38px;padding:0 16px;border:0;border-radius:8px;background:#5686f5;color:#fff;cursor:pointer}.hint{margin-top:9px}.hint a{color:#7fa7ff}.workflow-list{display:grid;gap:8px;margin-top:12px}article{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;padding:13px 14px;border:1px solid var(--color-border);border-radius:9px;background:var(--color-bg-2)}article strong{overflow-wrap:anywhere;font-size:12px}article span{color:#83a8ff;font-size:11px}article small{grid-column:1/-1;color:var(--color-text-4)}.ready-list{display:grid;gap:6px;margin:10px 0 0;padding:0;list-style:none}.ready-list li{display:flex;justify-content:space-between;gap:12px;padding:9px 12px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-2);font-size:12px}.ready-list span{color:var(--color-text-4);overflow-wrap:anywhere}
</style>
