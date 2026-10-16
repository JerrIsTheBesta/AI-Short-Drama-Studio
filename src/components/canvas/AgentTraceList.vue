<script setup lang="ts">
import type { TraceRow } from '@/services/canvas/agentTrace'
import AgentRichText from './AgentRichText.vue'

defineProps<{ rows: TraceRow[] }>()
</script>

<template>
  <div class="trace-list">
    <template v-for="s in rows" :key="s.key">
      <div v-if="s.kind === 'intent'" class="intent-tag">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
        </svg>
        <span>意图</span>
        <b>{{ s.label }}</b>
      </div>

      <div v-else-if="s.kind === 'plan' && s.plan" class="plan-card">
        <div class="plan-head">
          <svg class="plan-ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5h10M9 12h10M9 19h10" />
            <circle cx="4.5" cy="5" r="1.6" />
            <circle cx="4.5" cy="12" r="1.6" />
            <circle cx="4.5" cy="19" r="1.6" />
          </svg>
          <div class="plan-txt">
            <p class="plan-title">{{ s.plan.summary }}</p>
            <p v-if="s.plan.calls" class="plan-est">
              约 {{ s.plan.calls }} 次调用 · 约
              {{ Math.max(1, Math.ceil(s.plan.seconds / 60)) }} 分钟
            </p>
          </div>
        </div>
        <ol class="plan-steps">
          <li v-for="step in s.plan.steps" :key="step.key" :class="step.status">
            <span class="st">
              <svg v-if="step.status === 'running'" class="spin" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="8" />
              </svg>
              <svg v-else-if="step.status === 'done'" viewBox="0 0 24 24">
                <path d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else-if="step.status === 'fail'" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
              <i v-else />
            </span>
            <span class="st-title">{{ step.title }}</span>
          </li>
        </ol>
      </div>

      <div v-else-if="s.kind === 'step' || s.kind === 'log'" class="row" :class="[s.kind, s.status]">
        <span class="st">
          <svg v-if="s.status === 'running'" class="spin" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8" />
          </svg>
          <svg v-else-if="s.status === 'done'" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7" />
          </svg>
          <svg v-else-if="s.status === 'fail'" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          <i v-else />
        </span>
        <div class="row-body">
          <p class="row-label">{{ s.label }}</p>
          <AgentRichText
            v-if="s.detail && s.detail !== s.label"
            compact
            class="row-detail"
            :content="s.detail"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.trace-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* ── 意图标签 ── */
.intent-tag {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 5px;
  padding: 3px 10px 3px 7px;
  border-radius: 99px;
  border: 1px solid rgba(167, 139, 250, 0.32);
  background: rgba(167, 139, 250, 0.1);
  color: #c4b5fd;
  font-size: 10px;
  letter-spacing: 0.03em;
}
.intent-tag svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
}
.intent-tag span {
  opacity: 0.7;
}
.intent-tag b {
  font-weight: 650;
  color: #ddd6fe;
}

/* ── 计划卡片 ── */
.plan-card {
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-bg-0);
}
.plan-head {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.plan-ico {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  flex-shrink: 0;
  fill: none;
  stroke: rgba(126, 180, 255, 0.85);
  stroke-width: 1.7;
  stroke-linecap: round;
}
.plan-txt {
  min-width: 0;
}
.plan-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-1);
  line-height: 1.5;
}
.plan-est {
  margin: 3px 0 0;
  font-size: 10.5px;
  color: var(--color-text-4);
  font-variant-numeric: tabular-nums;
}
.plan-steps {
  list-style: none;
  margin: 9px 0 0;
  padding: 8px 0 0;
  border-top: 1px dashed var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plan-steps li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-4);
  transition: color 0.2s;
  min-width: 0;
}
.st-title {
  min-width: 0;
  overflow-wrap: anywhere;
}
.plan-steps li.running {
  color: var(--color-text-1);
}
.plan-steps li.done {
  color: var(--color-text-3);
}
.plan-steps li.fail {
  color: var(--color-error);
}

/* ── 状态图标 ── */
.st {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.st svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.st svg.spin {
  stroke: rgba(126, 180, 255, 0.9);
  stroke-width: 2.4;
  stroke-dasharray: 38 12;
  animation: st-spin 0.9s linear infinite;
}
@keyframes st-spin {
  to {
    transform: rotate(360deg);
  }
}
.st i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--color-text-4);
}
.plan-steps li.done .st,
.row.done .st {
  color: var(--color-success);
}
.plan-steps li.fail .st,
.row.fail .st {
  color: var(--color-error);
}
.plan-steps li.running .st,
.row.running .st {
  color: var(--color-accent);
}

/* ── 执行行 ── */
.row {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  padding: 4px 0;
  font-size: 12px;
  color: var(--color-text-3);
  min-width: 0;
}
.row-body {
  min-width: 0;
}
.row-label {
  margin: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.55;
}
.row.running .row-label {
  color: var(--color-text-1);
}
.row.done .row-label {
  color: var(--color-text-3);
}
.row.fail .row-label {
  color: var(--color-error);
}
.row.log .row-label {
  color: var(--color-text-4);
}
.row-detail {
  margin-top: 4px;
  padding: 6px 9px;
  border-left: 2px solid var(--color-border);
  border-radius: 0 7px 7px 0;
  background: rgba(255, 255, 255, 0.028);
}
.row.fail .row-detail {
  border-left-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.07);
}
</style>
