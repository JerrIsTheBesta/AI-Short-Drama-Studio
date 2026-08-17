<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue'

const props = defineProps<{
  src: string
  type: 'image' | 'video' | 'audio'
  /** 是否自动播放 */
  autoplay?: boolean
  /** 是否循环 */
  loop?: boolean
  /** 是否静音 */
  muted?: boolean
  /** 是否显示控制条 */
  controls?: boolean
  /** 视频封面 */
  poster?: string
  /** 圆角大小 */
  rounded?: boolean
}>()

const videoRef = ref<HTMLVideoElement | null>(null)
const audioRef = ref<HTMLAudioElement | null>(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)

watch(
  () => props.src,
  () => {
    isPlaying.value = false
    currentTime.value = 0
    duration.value = 0
  }
)

function onTimeUpdate(e: Event) {
  currentTime.value = (e.target as HTMLMediaElement).currentTime
}
function onLoaded(e: Event) {
  duration.value = (e.target as HTMLMediaElement).duration
}
function onPlay() { isPlaying.value = true }
function onPause() { isPlaying.value = false }
function onEnded() { isPlaying.value = false }

function togglePlay() {
  const v = videoRef.value ?? audioRef.value
  if (!v) return
  if (v.paused) v.play()
  else v.pause()
}

function fmt(t: number) {
  if (!isFinite(t)) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const progressPct = computed(() =>
  duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0
)

onUnmounted(() => {
  videoRef.value?.pause()
  audioRef.value?.pause()
})
</script>

<template>
  <div class="media-preview" :class="{ rounded }">
    <img
      v-if="type === 'image'"
      :src="src"
      class="img"
      :class="{ rounded }"
      alt=""
    />
    <template v-else-if="type === 'video'">
      <video
        ref="videoRef"
        :src="src"
        :autoplay="autoplay"
        :loop="loop"
        :muted="muted ?? true"
        :poster="poster"
        :controls="controls"
        class="vid"
        :class="{ rounded }"
        @timeupdate="onTimeUpdate"
        @loadedmetadata="onLoaded"
        @play="onPlay"
        @pause="onPause"
        @ended="onEnded"
      />
      <button v-if="!controls" class="play-btn" @click="togglePlay">
        <span v-if="isPlaying">❚❚</span>
        <span v-else>▶</span>
      </button>
    </template>
    <template v-else-if="type === 'audio'">
      <div class="audio-wrap">
        <button class="audio-play" @click="togglePlay">
          <span v-if="isPlaying">❚❚</span>
          <span v-else>▶</span>
        </button>
        <div class="audio-info">
          <div class="audio-bar">
            <div class="audio-bar-fill" :style="{ width: progressPct + '%' }"></div>
          </div>
          <div class="audio-time">
            <span>{{ fmt(currentTime) }}</span>
            <span>{{ fmt(duration) }}</span>
          </div>
        </div>
        <audio
          ref="audioRef"
          :src="src"
          :loop="loop"
          @timeupdate="onTimeUpdate"
          @loadedmetadata="onLoaded"
          @play="onPlay"
          @pause="onPause"
          @ended="onEnded"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.media-preview {
  position: relative;
  width: 100%;
  background: #000;
  overflow: hidden;
}
.rounded {
  border-radius: var(--radius-md);
}
.img,
.vid {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.play-btn {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border: 2px solid rgba(255, 255, 255, 0.3);
  transition: all var(--duration-fast) var(--ease-out);
  backdrop-filter: blur(8px);
}
.play-btn:hover {
  background: rgba(0, 0, 0, 0.8);
  transform: translate(-50%, -50%) scale(1.05);
}
.audio-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--color-bg-2);
  width: 100%;
}
.audio-play {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--grad-primary);
  color: white;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.audio-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.audio-bar {
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.audio-bar-fill {
  height: 100%;
  background: var(--grad-primary);
  transition: width 0.1s linear;
}
.audio-time {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--color-text-3);
  font-variant-numeric: tabular-nums;
}
</style>
