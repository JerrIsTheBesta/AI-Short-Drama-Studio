<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { useLightbox } from '@/composables/useLightbox'

const { src, kind, caption, close } = useLightbox()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

watch(src, (url) => {
  document.body.style.overflow = url ? 'hidden' : ''
})

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div v-if="src" class="lb" @click.self="close">
      <button class="lb-close" type="button" title="关闭" @click="close">×</button>
      <img v-if="kind === 'image'" :src="src" :alt="caption" class="lb-media" @click.stop />
      <video
        v-else
        :src="src"
        class="lb-media"
        controls
        autoplay
        playsinline
        @click.stop
      />
      <p v-if="caption" class="lb-cap">{{ caption }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.lb {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(6, 6, 12, 0.88);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 24px 28px;
  cursor: zoom-out;
}
.lb-close {
  position: absolute;
  top: 12px;
  right: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 22px;
  line-height: 1;
  padding: 0;
}
.lb-close:hover {
  background: rgba(255, 255, 255, 0.22);
}
.lb-media {
  max-width: min(96vw, 1400px);
  max-height: calc(100vh - 88px);
  object-fit: contain;
  border-radius: 8px;
  cursor: default;
  box-shadow: 0 16px 60px rgba(0, 0, 0, 0.45);
}
.lb-cap {
  margin: 12px 0 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.72);
}
</style>
