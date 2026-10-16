<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useProjectStore, useToastStore } from '@/stores'
import GradientButton from '@/components/common/GradientButton.vue'

const router = useRouter()
const route = useRoute()
const project = useProjectStore()
const toast = useToastStore()

const editing = ref(false)
const nameInput = ref('')

const projectName = computed(() => project.current?.name ?? '未命名项目')

function startEdit() {
  editing.value = true
  nameInput.value = projectName.value
}
function commitEdit() {
  if (project.current && nameInput.value.trim()) {
    project.current.name = nameInput.value.trim()
    project.current.updatedAt = Date.now()
    project.save()
  }
  editing.value = false
}
function cancelEdit() {
  editing.value = false
}

function goHome() {
  router.push('/')
}

function newProject() {
  project.createNamed(
    `项目 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
  ).then(() => {
    toast.success('新项目已创建')
    router.push('/studio')
  })
}
</script>

<template>
  <header class="topbar">
    <div class="left">
      <button class="logo" @click="goHome">
        <img class="logo-mark" src="/logo.png" alt="" />
        <span class="logo-text">剧流 Studio</span>
      </button>

      <div class="divider" />

      <div v-if="editing" class="rename">
        <input
          v-model="nameInput"
          class="name-input"
          @keydown.enter="commitEdit"
          @keydown.escape="cancelEdit"
          @blur="commitEdit"
          autofocus
        />
      </div>
      <button v-else class="project-name" @click="startEdit" title="点击重命名">
        <span>{{ projectName }}</span>
        <span class="pencil">✎</span>
      </button>

      <span v-if="project.dirty" class="dirty-dot" title="未保存"></span>
      <span v-else-if="project.lastSavedAt" class="saved">已保存</span>
    </div>

    <div class="right">
      <button class="text-btn accent" @click="router.push('/studio')" title="回到无限画布">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18M9 4v16" />
        </svg>
        无限画布
      </button>
      <button class="text-btn" @click="router.push('/scripts')" title="剧本库（本地 Markdown）">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
          <path d="M15 3v5h5M8.5 13h7M8.5 17h4" />
        </svg>
        剧本
      </button>
      <button class="text-btn" @click="router.push('/')" title="项目列表">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 10l8-6 8 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
        </svg>
        项目
      </button>
      <button class="text-btn" @click="router.push('/drafts')" title="资源库（全部图片/视频）">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7l8-4 8 4v10l-8 4-8-4z" />
          <path d="M4 7l8 4 8-4M12 11v10" />
        </svg>
        资源库
      </button>
      <button class="icon-btn" @click="router.push('/settings')" title="设置">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"
          />
        </svg>
      </button>
      <GradientButton size="sm" type="secondary" icon="+" @click="newProject">
        新项目
      </GradientButton>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 var(--space-5);
  background: var(--color-bg-1);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  z-index: 10;
  -webkit-app-region: drag;
  app-region: drag;
}
.left,
.right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.logo {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 10px;
  border-radius: var(--radius-md);
  transition: background var(--duration-fast);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.logo:hover {
  background: var(--color-fill);
}
.logo-mark {
  display: block;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  object-fit: contain;
}
.logo-text {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--color-text-1);
}
.divider {
  width: 1px;
  height: 24px;
  background: var(--color-border);
}
.project-name {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--color-text-2);
  border-radius: var(--radius-sm);
  transition: all var(--duration-fast);
}
.project-name:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.pencil {
  font-size: 11px;
  opacity: 0.4;
}
.rename {
  display: flex;
  align-items: center;
}
.name-input {
  background: var(--color-bg-2);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 5px 10px;
  font-size: 13px;
  outline: none;
  color: var(--color-text-1);
  min-width: 200px;
}
.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  box-shadow: 0 0 6px var(--color-warning);
}
.saved {
  font-size: 11px;
  color: var(--color-text-4);
}

.icon-btn {
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-3);
  transition: all 0.15s;
}
.icon-btn svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--color-border);
  color: var(--color-text-1);
}
.text-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--color-text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.text-btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.text-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.16);
  color: var(--color-text-1);
}
.text-btn.accent {
  border-color: rgba(126, 180, 255, 0.34);
  background: rgba(126, 180, 255, 0.12);
  color: #b9cbff;
}
.text-btn.accent:hover {
  border-color: rgba(126, 180, 255, 0.6);
  background: rgba(126, 180, 255, 0.18);
  color: #dce5ff;
}
</style>
