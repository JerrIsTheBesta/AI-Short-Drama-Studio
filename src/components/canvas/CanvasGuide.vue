<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    agentOpen?: boolean
    agentWidth?: number
    rightWidth?: number
  }>(),
  { agentOpen: true, agentWidth: 440, rightWidth: 0 }
)

const emit = defineEmits<{ (e: 'done'): void }>()

type GuideArea = 'agent' | 'canvas' | null

const steps = [
  {
    area: 'agent' as GuideArea,
    title: '左边：一句话让 AI 开工',
    sub: '把这里当成会干活的搭档，不是问答机器人',
    items: [
      '用大白话说就行：「写一个修仙渡劫短剧，拆 8 个分镜」，它会自己排出步骤再动手。',
      '写 / 改 / 续写剧本，提炼角色、场景、分镜，出人设图、关键帧和分镜视频都能在这儿说。',
      '它有记忆：说「记住我偏好电影感暗调」，之后每次创作都会自动带上。',
      '想精细改某一镜，先在画布上点选那个节点，再告诉它改什么。'
    ]
  },
  {
    area: 'canvas' as GuideArea,
    title: '右边：画布是你手动操作的地方',
    sub: '想精确控制的时候，直接在这儿加东西',
    items: [
      '空白处右键：添加剧本、角色、场景、分镜、图片或视频节点。',
      '每个节点可以单独生成，也能重跑失败的那一个，不用整个项目重来。',
      '选中节点后右侧能改提示词、时长、模型；拖动可以排布节点。',
      '节点之间的连线是「参考关系」：上游的图会给下游当参考。'
    ]
  },
  {
    area: null as GuideArea,
    title: '两个提示',
    sub: '怎么用都行，不用二选一',
    items: [
      '左右两边可以随时混用：先让 AI 打底，再手动改细节，反过来也成立。',
      '顶栏可以切到「经典步骤」，按 文案 → 剧本 → 素材 → 视频 的顺序分步做。'
    ]
  }
]

const index = ref(0)
const step = computed(() => steps[index.value])

const highlight = computed(() => {
  const area = step.value.area
  if (!area) return null
  const left = area === 'agent' ? 0 : props.agentOpen ? props.agentWidth : 0
  const right = area === 'agent' ? 'auto' : props.rightWidth
  if (area === 'agent') {
    if (!props.agentOpen) return null
    return { left: '0px', right: 'auto', width: `${props.agentWidth}px` }
  }
  return { left: `${left}px`, right: `${right}px`, width: 'auto' }
})

function next() {
  if (index.value < steps.length - 1) index.value++
  else finish()
}
function prev() {
  if (index.value > 0) index.value--
}
function finish() {
  emit('done')
}
</script>

<template>
  <div class="guide">
    <template v-if="highlight">
      <div class="hl" :style="highlight">
        <div class="card">
          <div class="step-dot">
            <i v-for="(s, i) in steps" :key="s.title" :class="{ on: i === index, past: i < index }" />
          </div>
          <h3>{{ step.title }}</h3>
          <p class="sub">{{ step.sub }}</p>
          <ul>
            <li v-for="item in step.items" :key="item">{{ item }}</li>
          </ul>
          <div class="foot">
            <span class="count">{{ index + 1 }} / {{ steps.length }}</span>
            <div class="btns">
              <button v-if="index > 0" type="button" class="ghost" @click="prev">上一步</button>
              <button type="button" class="ghost" @click="finish">跳过</button>
              <button type="button" class="primary" @click="next">
                {{ index === steps.length - 1 ? '开始使用' : '下一步' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
    <div v-else class="card float">
      <div class="step-dot">
        <i v-for="(s, i) in steps" :key="s.title" :class="{ on: i === index, past: i < index }" />
      </div>
      <h3>{{ step.title }}</h3>
      <p class="sub">{{ step.sub }}</p>
      <ul>
        <li v-for="item in step.items" :key="item">{{ item }}</li>
      </ul>
      <div class="foot">
        <span class="count">{{ index + 1 }} / {{ steps.length }}</span>
        <div class="btns">
          <button type="button" class="ghost" @click="prev">上一步</button>
          <button type="button" class="primary" @click="next">开始使用</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide {
  position: absolute;
  inset: 0;
  z-index: 60;
  pointer-events: none;
}
.hl {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 16px;
  border: 1px solid rgba(126, 180, 255, 0.55);
  box-shadow: 0 0 0 9999px rgba(6, 7, 10, 0.66);
  pointer-events: auto;
  animation: hl-in 0.28s ease;
}
@keyframes hl-in {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 1;
  }
}
.card {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(440px, calc(100% - 40px));
  max-height: calc(100% - 40px);
  overflow: auto;
  padding: 18px 20px 16px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg-1);
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.45);
  pointer-events: auto;
  animation: card-in 0.24s ease;
}
.card.float {
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.55);
}
@keyframes card-in {
  from {
    opacity: 0;
    transform: translate(-50%, calc(-50% + 10px));
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%);
  }
}
.step-dot {
  display: flex;
  gap: 5px;
  margin-bottom: 11px;
}
.step-dot i {
  width: 18px;
  height: 3px;
  border-radius: 99px;
  background: var(--color-fill-strong);
}
.step-dot i.past {
  background: rgba(126, 180, 255, 0.45);
}
.step-dot i.on {
  background: #8fb0ff;
}
h3 {
  margin: 0 0 3px;
  font-size: 16px;
  font-weight: 680;
  letter-spacing: -0.01em;
  color: var(--color-text-1);
}
.sub {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--color-text-4);
}
ul {
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
li {
  position: relative;
  padding-left: 16px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--color-text-2);
}
li::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 8px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #7eb4ff;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.count {
  font-size: 11px;
  color: var(--color-text-4);
  font-variant-numeric: tabular-nums;
}
.btns {
  display: flex;
  gap: 8px;
}
.btns button {
  margin: 0;
  padding: 7px 14px;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.ghost {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-3);
}
.ghost:hover {
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
}
.primary {
  border: 1px solid rgba(126, 180, 255, 0.5);
  background: rgba(126, 180, 255, 0.16);
  color: #cfe0ff;
}
.primary:hover {
  background: rgba(126, 180, 255, 0.26);
}
</style>
