<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  clearMemories,
  forgetMemory,
  listMemories,
  rememberMemory,
  togglePinMemory,
  type AgentMemoryEntry,
  type MemoryScope
} from '@/services/memory/memoryStore'

const emit = defineEmits<{ (e: 'close'): void }>()

const entries = ref<AgentMemoryEntry[]>([])
const loading = ref(true)
const draft = ref('')
const draftScope = ref<MemoryScope>('project')
const adding = ref(false)

const KIND_LABEL: Record<string, string> = {
  preference: '偏好',
  fact: '事实',
  note: '笔记'
}

async function reload() {
  loading.value = true
  entries.value = await listMemories()
  loading.value = false
}

function byScope(scope: MemoryScope) {
  return entries.value.filter((e) => e.scope === scope)
}

async function add() {
  const text = draft.value.trim()
  if (!text || adding.value) return
  adding.value = true
  await rememberMemory(text, { scope: draftScope.value, kind: 'note' })
  draft.value = ''
  adding.value = false
  await reload()
}

async function remove(id: string) {
  await forgetMemory(id)
  await reload()
}

async function pin(id: string) {
  await togglePinMemory(id)
  await reload()
}

async function clear(scope: MemoryScope) {
  await clearMemories(scope)
  await reload()
}

onMounted(reload)
</script>

<template>
  <div class="mem-panel" @click.stop>
    <header class="mem-head">
      <strong>记忆</strong>
      <button type="button" class="mem-close" title="关闭" @click="emit('close')">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </header>

    <div class="mem-body">
      <p v-if="loading" class="mem-empty">读取中…</p>
      <template v-else>
        <section class="mem-group">
          <div class="mem-group-head">
            <span>本项目</span>
            <button
              v-if="byScope('project').length"
              type="button"
              class="mem-clear"
              @click="clear('project')"
            >
              清空
            </button>
          </div>
          <p v-if="!byScope('project').length" class="mem-empty">
            还没有。对我说「在这个项目里记住…」就会记在这里。
          </p>
          <div v-for="m in byScope('project')" :key="m.id" class="mem-item" :class="{ pinned: m.pinned }">
            <span class="mem-kind">{{ KIND_LABEL[m.kind] || '笔记' }}</span>
            <p>{{ m.content }}</p>
            <div class="mem-acts">
              <button type="button" :title="m.pinned ? '取消置顶' : '置顶'" @click="pin(m.id)">
                <svg viewBox="0 0 24 24"><path d="M12 3l2.4 5.3 5.6.6-4.2 3.9 1.2 5.6-5-2.9-5 2.9 1.2-5.6L4 8.9l5.6-.6z" /></svg>
              </button>
              <button type="button" title="删除" @click="remove(m.id)">
                <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" /></svg>
              </button>
            </div>
          </div>
        </section>

        <section class="mem-group">
          <div class="mem-group-head">
            <span>长期记忆</span>
            <button
              v-if="byScope('global').length"
              type="button"
              class="mem-clear"
              @click="clear('global')"
            >
              清空
            </button>
          </div>
          <p v-if="!byScope('global').length" class="mem-empty">
            跨项目通用。对我说「记住我喜欢竖屏暗色调」就会记在这里。
          </p>
          <div v-for="m in byScope('global')" :key="m.id" class="mem-item" :class="{ pinned: m.pinned }">
            <span class="mem-kind">{{ KIND_LABEL[m.kind] || '笔记' }}</span>
            <p>{{ m.content }}</p>
            <div class="mem-acts">
              <button type="button" :title="m.pinned ? '取消置顶' : '置顶'" @click="pin(m.id)">
                <svg viewBox="0 0 24 24"><path d="M12 3l2.4 5.3 5.6.6-4.2 3.9 1.2 5.6-5-2.9-5 2.9 1.2-5.6L4 8.9l5.6-.6z" /></svg>
              </button>
              <button type="button" title="删除" @click="remove(m.id)">
                <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0l1 13h8l1-13" /></svg>
              </button>
            </div>
          </div>
        </section>
      </template>
    </div>

    <footer class="mem-foot">
      <div class="mem-scope">
        <button
          type="button"
          :class="{ on: draftScope === 'project' }"
          @click="draftScope = 'project'"
        >
          本项目
        </button>
        <button
          type="button"
          :class="{ on: draftScope === 'global' }"
          @click="draftScope = 'global'"
        >
          长期
        </button>
      </div>
      <div class="mem-input">
        <input
          v-model="draft"
          type="text"
          placeholder="手动记一条，例如：默认竖屏 9:16"
          @keydown.enter.prevent="add"
        />
        <button type="button" :disabled="!draft.trim() || adding" @click="add">记下</button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.mem-panel {
  position: absolute;
  top: 46px;
  right: 10px;
  z-index: 30;
  width: 300px;
  max-width: calc(100% - 20px);
  max-height: min(480px, calc(100% - 60px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg-1);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  animation: mem-in 0.18s ease;
}
@keyframes mem-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.mem-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
}
.mem-head strong {
  font-size: 12px;
  font-weight: 650;
}
.mem-close {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.mem-close:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.mem-close svg {
  width: 12px;
  height: 12px;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
  stroke-linecap: round;
}
.mem-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.mem-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--color-text-3);
}
.mem-clear {
  border: none;
  background: transparent;
  color: var(--color-text-4);
  font-size: 10px;
  cursor: pointer;
  padding: 2px 4px;
}
.mem-clear:hover {
  color: var(--color-error);
}
.mem-empty {
  margin: 0 0 4px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-4);
}
.mem-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 7px 8px;
  margin-bottom: 6px;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  background: var(--color-bg-0);
}
.mem-item.pinned {
  border-color: rgba(126, 180, 255, 0.45);
}
.mem-kind {
  flex-shrink: 0;
  margin-top: 1px;
  padding: 1px 6px;
  border-radius: 99px;
  background: var(--color-fill);
  color: var(--color-text-3);
  font-size: 10px;
}
.mem-item p {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-text-2);
  overflow-wrap: anywhere;
}
.mem-acts {
  flex-shrink: 0;
  display: flex;
  gap: 2px;
}
.mem-acts button {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--color-text-4);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.mem-acts button:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.mem-acts svg {
  width: 12px;
  height: 12px;
  stroke: currentColor;
  stroke-width: 1.8;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.mem-item.pinned .mem-acts button:first-child {
  color: var(--color-accent);
}
.mem-item.pinned .mem-acts button:first-child svg {
  fill: currentColor;
}
.mem-foot {
  border-top: 1px solid var(--color-border);
  padding: 8px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mem-scope {
  display: flex;
  gap: 4px;
}
.mem-scope button {
  flex: 1;
  margin: 0;
  padding: 4px 0;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 11px;
  cursor: pointer;
}
.mem-scope button.on {
  border-color: rgba(126, 180, 255, 0.5);
  background: rgba(126, 180, 255, 0.12);
  color: var(--color-text-1);
}
.mem-input {
  display: flex;
  gap: 6px;
}
.mem-input input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
  outline: none;
}
.mem-input input:focus {
  border-color: rgba(126, 180, 255, 0.5);
}
.mem-input button {
  flex-shrink: 0;
  margin: 0;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: var(--color-accent);
  color: #10131a;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.mem-input button:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
