<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { runAgentTurn, type AgentEvent, type AgentMessage } from '@/services/canvas/agent'
import GradientButton from '@/components/common/GradientButton.vue'

const messages = ref<AgentMessage[]>([
  {
    role: 'assistant',
    content:
      '跟我说你要拍什么。需求不清楚我会先问。拆完剧本会写到画布左侧，每一步做完问你要不要继续。说「全流程」才自动跑完。'
  }
])
const input = ref('')
const busy = ref(false)
const log = ref('')
const steps = ref<{ key: string; label: string; status: 'running' | 'done' | 'fail' }[]>([])
const chips = ref<{ label: string; text: string }[]>([
  { label: '拆剧本', text: '拆剧本' },
  { label: '全流程', text: '全流程跑完' }
])
const box = ref<HTMLElement | null>(null)

function onProgress(ev: AgentEvent) {
  log.value = ev.label
  if (ev.kind === 'step' && ev.step) {
    const i = steps.value.findIndex((s) => s.key === ev.step)
    const row = { key: ev.step, label: ev.label, status: ev.status || 'running' }
    if (i >= 0) steps.value[i] = row
    else steps.value = [...steps.value, row]
  }
}

async function sendText(text: string) {
  const t = text.trim()
  if (!t || busy.value) return
  input.value = ''
  messages.value.push({ role: 'user', content: t })
  busy.value = true
  log.value = '开始…'
  steps.value = []
  chips.value = []
  try {
    const result = await runAgentTurn(messages.value, t, onProgress)
    messages.value.push({ role: 'assistant', content: result.reply })
    chips.value = result.chips
  } catch (e: any) {
    messages.value.push({ role: 'assistant', content: '失败：' + (e.message || e) })
  } finally {
    busy.value = false
    await nextTick()
    box.value?.scrollTo({ top: box.value.scrollHeight })
  }
}

async function send() {
  await sendText(input.value)
}
</script>

<template>
  <aside class="agent">
    <header>
      <strong>智能体</strong>
      <span :class="{ live: busy }">{{ busy ? log || '进行中…' : '做完一步再问你' }}</span>
    </header>
    <div v-if="busy || steps.length" class="progress">
      <div v-for="s in steps" :key="s.key" class="p-row" :class="s.status">
        <i />
        <span>{{ s.label }}</span>
      </div>
    </div>
    <div ref="box" class="msgs">
      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        {{ m.content }}
      </div>
    </div>
    <div v-if="chips.length && !busy" class="chips">
      <button v-for="c in chips" :key="c.text + c.label" type="button" @click="sendText(c.text)">
        {{ c.label }}
      </button>
    </div>
    <form class="composer" @submit.prevent="send">
      <textarea
        v-model="input"
        rows="3"
        placeholder="说主题，或点下面的「继续」。需求不清我会先问。"
        @keydown.enter.exact.prevent="send"
      />
      <GradientButton size="sm" :loading="busy" :disabled="!input.trim()" @click="send">
        发送
      </GradientButton>
    </form>
  </aside>
</template>

<style scoped>
.agent {
  width: 300px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-1);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
header {
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
header span {
  font-size: 11px;
  color: var(--color-text-4);
}
header span.live {
  color: #c4b5fd;
}
.progress {
  padding: 8px 14px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: rgba(124, 58, 237, 0.06);
  max-height: 160px;
  overflow-y: auto;
  flex-shrink: 0;
}
.p-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-3);
}
.p-row i {
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--color-text-4);
  flex-shrink: 0;
}
.p-row.running {
  color: #ddd6fe;
}
.p-row.running i {
  background: #a78bfa;
  box-shadow: 0 0 8px #a78bfa;
}
.p-row.done {
  color: #6ee7b7;
}
.p-row.done i {
  background: #34d399;
}
.p-row.fail {
  color: #fca5a5;
}
.p-row.fail i {
  background: #f87171;
}
.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.msg {
  font-size: 12px;
  line-height: 1.5;
  padding: 8px 10px;
  border-radius: 10px;
  white-space: pre-wrap;
}
.msg.user {
  background: var(--grad-primary-soft);
  align-self: flex-end;
  max-width: 92%;
}
.msg.assistant {
  background: var(--color-bg-2);
  max-width: 100%;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px 0;
  flex-shrink: 0;
}
.chips button {
  font-size: 11px;
  padding: 5px 10px;
  border-radius: 99px;
  background: var(--color-bg-3);
  color: var(--color-text-2);
  border: 1px solid var(--color-border);
}
.chips button:hover {
  background: var(--color-accent);
  color: #fff;
  border-color: transparent;
}
.composer {
  padding: 10px;
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
textarea {
  width: 100%;
  resize: none;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-1);
  padding: 8px;
  font: inherit;
  font-size: 12px;
}
</style>
