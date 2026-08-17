<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { runAgentTurn, type AgentMessage } from '@/services/canvas/agent'
import GradientButton from '@/components/common/GradientButton.vue'

const messages = ref<AgentMessage[]>([
  {
    role: 'assistant',
    content:
      '我是画布智能体。可以说「按文案拆分镜并出人设」，或「把所有镜头配图再生成视频」。我会在画布上建节点、连线并排队生成。'
  }
])
const input = ref('')
const busy = ref(false)
const log = ref('')
const box = ref<HTMLElement | null>(null)

async function send() {
  const text = input.value.trim()
  if (!text || busy.value) return
  input.value = ''
  messages.value.push({ role: 'user', content: text })
  busy.value = true
  log.value = ''
  try {
    const { reply } = await runAgentTurn(messages.value, text, (m) => {
      log.value = m
    })
    messages.value.push({ role: 'assistant', content: reply })
  } catch (e: any) {
    messages.value.push({ role: 'assistant', content: '失败：' + (e.message || e) })
  } finally {
    busy.value = false
    await nextTick()
    box.value?.scrollTo({ top: box.value.scrollHeight })
  }
}
</script>

<template>
  <aside class="agent">
    <header>
      <strong>智能体</strong>
      <span>{{ busy ? log || '思考中…' : '对话驱动画布' }}</span>
    </header>
    <div ref="box" class="msgs">
      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        {{ m.content }}
      </div>
    </div>
    <form class="composer" @submit.prevent="send">
      <textarea
        v-model="input"
        rows="3"
        placeholder="例如：拆分镜，锁定参考图里的男主，生成人设和第一镜配图"
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
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
header span {
  font-size: 11px;
  color: var(--color-text-4);
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
