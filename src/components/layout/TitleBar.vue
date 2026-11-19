<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { desktop, isDesktop } from '@/services/desktop'
import ThemeToggle from '@/components/common/ThemeToggle.vue'

const route = useRoute()
const router = useRouter()

function goHome() {
  if (route.name === 'home') {
    window.dispatchEvent(new CustomEvent('aicut:home'))
    return
  }
  router.push({ name: 'home' })
}

/** 无边框窗口里必须画出顶栏；不依赖 preload 是否已经挂上 */
const show = /electron/i.test(navigator.userAgent) || isDesktop()
const maximized = ref(false)
let off: (() => void) | undefined

onMounted(async () => {
  if (!isDesktop()) return
  try {
    maximized.value = await desktop().isMaximized()
    off = desktop().onMaximized((v) => {
      maximized.value = v
    })
  } catch {
    /* ignore */
  }
})

onUnmounted(() => off?.())

function run(fn: () => void) {
  try {
    fn()
  } catch (e) {
    console.error('[titlebar]', e)
  }
}
</script>

<template>
  <header v-if="show" class="titlebar win-titlebar">
    <button type="button" class="brand" title="剧流 Studio" @click="goHome">
      <img class="mark" src="/logo.png" alt="" />
      <span class="name">剧流 Studio</span>
    </button>
    <div class="controls">
      <ThemeToggle class="theme" />
      <button type="button" class="ctrl" title="最小化" @click="run(() => desktop().minimize())">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6h8" />
        </svg>
      </button>
      <button
        type="button"
        class="ctrl"
        :title="maximized ? '还原' : '最大化'"
        @click="run(() => desktop().toggleMaximize())"
      >
        <svg v-if="!maximized" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" />
        </svg>
        <svg v-else viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 4.5h5v5h-5zM4 3h5.5v5.5" />
        </svg>
      </button>
      <button type="button" class="ctrl close" title="关闭" @click="run(() => desktop().closeWindow())">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3L3 9" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  background: var(--color-bg-1);
  border-bottom: 1px solid var(--color-border);
  user-select: none;
  position: relative;
  z-index: 1000;
  -webkit-app-region: drag;
  app-region: drag;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0 14px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.mark {
  width: 18px;
  height: 18px;
  object-fit: contain;
  display: block;
}
.name {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.3px;
  color: var(--color-text-1);
}
.controls {
  display: flex;
  align-items: center;
  margin-left: auto;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.theme {
  margin-right: 6px;
}
.ctrl {
  width: 52px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-2);
  background: transparent;
  border-radius: 0;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.ctrl svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ctrl:hover {
  background: var(--color-fill-hover);
  color: var(--color-text-1);
}
.ctrl.close:hover {
  background: #e81123;
  color: #fff;
}
</style>

<style>
/* 不走 scoped：Electron 对带 data-v 的 -webkit-app-region 经常不生效 */
.win-titlebar {
  -webkit-app-region: drag !important;
  app-region: drag !important;
}
.win-titlebar .brand,
.win-titlebar .ctrl,
.win-titlebar .controls {
  -webkit-app-region: no-drag !important;
  app-region: no-drag !important;
}
</style>
