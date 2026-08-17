<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useProjectStore, useSettingsStore, useToastStore } from '@/stores'
import GradientButton from '@/components/common/GradientButton.vue'

const router = useRouter()
const route = useRoute()
const project = useProjectStore()
const settings = useSettingsStore()
const toast = useToastStore()

const editing = ref(false)
const nameInput = ref('')

const projectName = computed(() => project.current?.name ?? '未命名项目')
const aiModeLabel = computed(() =>
  settings.config.aiMode === 'real' ? '🔌 真实 API' : '🎭 演示模式'
)

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
        <span class="logo-mark">▶</span>
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
      <span class="ai-mode" :class="`mode-${settings.config.aiMode}`">
        {{ aiModeLabel }}
      </span>
      <button
        class="icon-btn"
        @click="router.push('/studio')"
        title="无限画布"
      >
        🖼
      </button>
      <button
        class="icon-btn"
        @click="router.push('/drafts')"
        title="资源库（全部图片/视频）"
      >
        📦
      </button>
      <button class="icon-btn" @click="router.push('/settings')" title="设置">
        ⚙
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
  background: rgba(18, 18, 31, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
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
  background: rgba(255, 255, 255, 0.05);
}
.logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--grad-primary);
  color: white;
  font-size: 12px;
  box-shadow: 0 0 12px rgba(124, 58, 237, 0.4);
}
.logo-text {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
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
  background: rgba(255, 255, 255, 0.05);
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

.ai-mode {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  font-weight: 600;
  letter-spacing: 0.3px;
}
.mode-mock {
  background: rgba(245, 158, 11, 0.15);
  color: #fcd34d;
}
.mode-real {
  background: rgba(16, 185, 129, 0.15);
  color: #6ee7b7;
}

.icon-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-3);
  font-size: 16px;
  transition: all var(--duration-fast);
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text-1);
}
</style>
