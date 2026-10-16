<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { computed } from 'vue'
import { workflowSteps } from '@/router'
import { useProjectStore } from '@/stores'

const route = useRoute()
const router = useRouter()
const project = useProjectStore()

const steps = computed(() => [...workflowSteps])

const currentStepIndex = computed(() => {
  return steps.value.findIndex((s) => s.route === route.path)
})

function isStepDone(index: number): boolean {
  if (!project.current) return false
  const step = steps.value[index]
  if (!step) return false
  switch (step.id) {
    case 'script':
      return !!project.current.script
    case 'storyboard':
      return project.current.shots.length > 0
    case 'image':
      return project.current.shots.some((s) => s.imageAssetId)
    case 'video':
      return project.current.shots.some((s) => s.videoAssetId)
    case 'edit':
      return project.current.timeline.length > 0
    case 'caption':
      return project.current.timeline.length > 0
    case 'export':
      return false
    default:
      return false
  }
}

function isStepReachable(index: number): boolean {
  const step = steps.value[index]
  if (!step) return false
  if (step.id === 'drafts') return true
  if (index === 0) return true
  if (index <= currentStepIndex.value) return true
  return isStepDone(index - 1)
}

function goStep(index: number) {
  if (isStepReachable(index)) {
    router.push(steps.value[index].route)
  }
}

const doneCount = computed(
  () => steps.value.filter((_, i) => isStepDone(i)).length
)
const progress = computed(() =>
  steps.value.length ? Math.round((doneCount.value / steps.value.length) * 100) : 0
)
</script>

<template>
  <aside class="stepnav">
    <div class="nav-head">
      <div class="nav-title">
        <span class="nav-kicker">制作流程</span>
        <span class="nav-count">{{ doneCount }}/{{ steps.length }}</span>
      </div>
      <div class="nav-bar">
        <i :style="{ width: `${progress}%` }" />
      </div>
    </div>

    <ol class="steps">
      <li
        v-for="(s, i) in steps"
        :key="s.id"
        class="step"
        :class="{
          active: i === currentStepIndex,
          done: isStepDone(i) && i !== currentStepIndex,
          locked: !isStepReachable(i)
        }"
      >
        <button type="button" class="step-btn" :disabled="!isStepReachable(i)" @click="goStep(i)">
          <span class="dot">
            <svg v-if="isStepDone(i) && i !== currentStepIndex" viewBox="0 0 24 24">
              <path d="M5 13l4 4L19 7" />
            </svg>
            <span v-else-if="i === currentStepIndex" class="pulse" />
            <span v-else class="num">{{ i + 1 }}</span>
          </span>
          <span class="text">
            <span class="label">{{ s.label }}</span>
            <span class="desc">{{ s.desc }}</span>
          </span>
          <svg v-if="!isStepReachable(i)" class="lock" viewBox="0 0 24 24">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </button>
        <span v-if="i < steps.length - 1" class="line" :class="{ on: isStepDone(i) }" />
      </li>
    </ol>
  </aside>
</template>

<style scoped>
.stepnav {
  width: 212px;
  flex-shrink: 0;
  padding: 14px 10px 18px;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-1);
  overflow-y: auto;
}

/* ── 顶部进度 ── */
.nav-head {
  padding: 2px 6px 12px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--color-border);
}
.nav-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.nav-kicker {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--color-text-4);
}
.nav-count {
  font-size: 11px;
  color: var(--color-text-3);
  font-variant-numeric: tabular-nums;
}
.nav-bar {
  height: 3px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}
.nav-bar i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, #7eb4ff, #a78bfa);
  transition: width 0.3s ease;
}

/* ── 步骤列表 ── */
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
}
.step {
  position: relative;
}
.step-btn {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin: 0;
  padding: 8px 9px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.16s, border-color 0.16s;
}
.step-btn:disabled {
  cursor: not-allowed;
}
.step:not(.locked) .step-btn:hover {
  background: rgba(255, 255, 255, 0.045);
}
.step.active .step-btn {
  border-color: rgba(126, 180, 255, 0.34);
  background: rgba(126, 180, 255, 0.11);
}

/* 序号 / 状态点 */
.dot {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-4);
  font-size: 11px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  transition: all 0.18s;
}
.dot svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: var(--color-success);
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.step.done .dot {
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(74, 222, 128, 0.12);
}
.step.active .dot {
  border-color: rgba(126, 180, 255, 0.6);
  background: rgba(126, 180, 255, 0.16);
  box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.12);
}
.pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #7eb4ff;
  box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.2);
  animation: step-pulse 1.8s ease-in-out infinite;
}
@keyframes step-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgba(126, 180, 255, 0.18);
  }
  50% {
    box-shadow: 0 0 0 5px rgba(126, 180, 255, 0.09);
  }
}

/* 文案 */
.text {
  min-width: 0;
  display: grid;
  gap: 1px;
}
.label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.16s;
}
.desc {
  font-size: 10.5px;
  color: var(--color-text-4);
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.step.active .label {
  color: var(--color-text-1);
}
.step.done .label {
  color: var(--color-text-2);
}
.step-btn:hover .label {
  color: var(--color-text-1);
}
.step.locked .text {
  opacity: 0.45;
}

.lock {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: var(--color-text-4);
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.7;
}

/* 连接线 */
.line {
  position: absolute;
  left: 20px;
  top: 30px;
  bottom: -2px;
  width: 1px;
  background: var(--color-border);
}
.line.on {
  background: linear-gradient(180deg, rgba(74, 222, 128, 0.55), rgba(126, 180, 255, 0.35));
}

@media (max-width: 1100px) {
  .stepnav {
    width: 176px;
    padding-inline: 8px;
  }
  .desc {
    display: none;
  }
}
</style>
