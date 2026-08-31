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
</script>

<template>
  <aside class="stepnav">
    <div class="steps">
      <button
        v-for="(s, i) in steps"
        :key="s.id"
        class="step"
        :class="{
          active: i === currentStepIndex,
          done: isStepDone(i),
          reachable: isStepReachable(i)
        }"
        :disabled="!isStepReachable(i)"
        @click="goStep(i)"
      >
        <div class="indicator">
          <span v-if="isStepDone(i) && i !== currentStepIndex" class="check">✓</span>
          <span v-else class="icon">{{ s.icon }}</span>
        </div>
        <div class="text">
          <div class="label">{{ s.label }}</div>
          <div class="desc">{{ s.desc }}</div>
        </div>
        <div v-if="i < workflowSteps.length - 1" class="connector" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.stepnav {
  width: 220px;
  background: var(--color-bg-1);
  border-right: 1px solid var(--color-border);
  padding: var(--space-5) var(--space-3);
  flex-shrink: 0;
  overflow-y: auto;
}
.steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.step {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  text-align: left;
  color: var(--color-text-3);
  transition: all var(--duration-fast) var(--ease-out);
  cursor: pointer;
}
.step:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.step:not(:disabled):hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.step.active {
  background: var(--grad-primary-soft);
  color: var(--color-text-1);
}
.step.active .indicator {
  background: var(--grad-primary);
  color: white;
  border-color: transparent;
}
.step.done .indicator {
  background: rgba(16, 185, 129, 0.2);
  color: var(--color-success);
  border-color: var(--color-success);
}

.indicator {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all var(--duration-fast);
}
.icon {
  font-size: 14px;
}
.check {
  font-size: 14px;
  font-weight: 700;
}
.text {
  flex: 1;
  min-width: 0;
}
.label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}
.desc {
  font-size: 11px;
  color: var(--color-text-4);
  line-height: 1.3;
}
.connector {
  position: absolute;
  left: 27px;
  top: 100%;
  width: 1px;
  height: 2px;
  background: var(--color-border);
}
</style>
