<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useAssetsStore, useProjectStore, useToastStore } from '@/stores'
import { concatVideos } from '@/services/ffmpeg'
import { probeMedia } from '@/services/ffmpeg/probe'
import NodeBusyOverlay from '@/components/canvas/NodeBusyOverlay.vue'
import NodeLinkPlus from '@/components/canvas/NodeLinkPlus.vue'
import type { CanvasNode } from '@/types'

const props = defineProps<{
  id: string
  selected?: boolean
  data: { label?: string; outputAssetId?: string }
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const busy = ref('')
const previewUrl = ref('')

const node = computed(() => project.current?.canvas?.nodes.find((item) => item.id === props.id))
const incoming = computed(() => {
  const canvas = project.current?.canvas
  if (!canvas) return []
  return canvas.edges
    .filter((edge) => edge.target === props.id)
    .map((edge) => canvas.nodes.find((item) => item.id === edge.source))
    .filter((item): item is CanvasNode => Boolean(item))
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
})

function videoAssetId(item: CanvasNode): string | undefined {
  if (item.type === 'videoGen' || item.type === 'compose') return item.data.outputAssetId
  if (item.type === 'shotVideo') {
    return project.current?.shots.find((shot) => shot.id === item.data.shotId)?.videoAssetId
  }
  return undefined
}

const readyCount = computed(() => incoming.value.filter((item) => videoAssetId(item)).length)
const hasOutput = computed(() => Boolean(node.value?.data.outputAssetId || props.data.outputAssetId))

watch(
  () => node.value?.data.outputAssetId,
  async (id) => {
    previewUrl.value = id ? (await assets.getUrl(id)) || '' : ''
  },
  { immediate: true }
)

function outputSize(): { width: number; height: number } {
  const ratio = project.current?.settings.aspectRatio || '16:9'
  if (ratio === '9:16') return { width: 720, height: 1280 }
  if (ratio === '1:1') return { width: 720, height: 720 }
  if (ratio === '4:3') return { width: 960, height: 720 }
  if (ratio === '21:9') return { width: 1680, height: 720 }
  return { width: 1280, height: 720 }
}

async function compose() {
  if (busy.value) return
  const clips = incoming.value.filter((item) => videoAssetId(item))
  if (!clips.length) {
    toast.warn(incoming.value.length ? '接到这里的视频还没生成' : '先把视频节点接到合成节点上')
    return
  }
  busy.value = '准备片段…'
  try {
    const segments = []
    let width = 0
    let height = 0
    for (const item of clips) {
      const assetId = videoAssetId(item)
      const blob = assetId ? await assets.getBlob(assetId) : undefined
      if (!blob) continue
      const info = await probeMedia(blob)
      if (!width && info.width && info.height) {
        width = info.width
        height = info.height
      }
      const duration = info.duration && info.duration > 0.2 ? info.duration : item.data.duration || 5
      segments.push({ blob, sourceIn: 0, duration })
    }
    if (!segments.length) {
      toast.warn('接到这里的视频还没生成')
      return
    }
    const size = width && height ? { width, height } : outputSize()
    const even = (n: number) => {
      const v = Math.max(2, Math.round(n))
      return v % 2 === 0 ? v : v - 1
    }
    busy.value = '正在合成…'
    const blob = await concatVideos(segments, {
      width: even(size.width),
      height: even(size.height),
      fps: 30,
      onProgress: (msg) => {
        busy.value = msg || '正在合成…'
      }
    })
    const asset = await assets.add(blob, 'video', 'ai-generated', {
      filename: '合成.mp4',
      projectId: project.current?.id,
      prompt: clips.map((item) => item.data.label || '视频').join(' + ')
    })
    project.assignCanvasNodeAsset(props.id, asset.id)
    previewUrl.value = (await assets.getUrl(asset.id)) || ''
    toast.success('视频已合成')
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '合成失败')
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="fnode kind-compose" :class="{ on: selected, busy: !!busy }">
    <NodeLinkPlus :node-id="id" />
    <Handle id="in" type="target" :position="Position.Left" class="hndl" />

    <div v-if="selected" class="toolbar-wrap nodrag nowheel" @mousedown.stop @click.stop>
      <button type="button" class="go" :disabled="!!busy" @click="compose">{{ hasOutput ? '重新合成' : '合成视频' }}</button>
    </div>

    <div class="media">
      <video v-if="previewUrl" class="player nodrag nowheel" :src="previewUrl" controls @mousedown.stop />
      <button v-else type="button" class="ph nodrag" :disabled="!!busy" @click.stop="compose">
        <span class="mark" aria-hidden="true"></span>
        <span>{{ incoming.length ? `${readyCount}/${incoming.length} 段可合成` : '把视频接到这里' }}</span>
      </button>
      <NodeBusyOverlay v-if="busy" :label="busy" />
    </div>

    <div class="name">
      <span class="kind">合成</span>
      <span class="title">{{ incoming.length ? `${incoming.length} 段` : '成片' }}</span>
    </div>

    <Handle id="out" type="source" :position="Position.Right" class="hndl" />
  </div>
</template>

<style scoped>
.fnode {
  position: relative;
  width: 240px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-node-border);
  border-radius: 6px;
  overflow: visible;
  color: var(--color-text-1);
  box-shadow: var(--shadow-node);
}
.fnode.on {
  border-color: var(--color-text-1);
  box-shadow: 0 0 0 1px var(--color-text-1), var(--shadow-md);
}
.toolbar-wrap {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  z-index: 6;
  transform: translateX(-50%);
}
.go {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg-2);
  color: var(--color-text-1);
  cursor: pointer;
}
.go:disabled {
  opacity: 0.55;
  cursor: default;
}
.media {
  position: relative;
  height: 148px;
  overflow: hidden;
  border-radius: 6px 6px 0 0;
  background: #16161c;
}
.player {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.ph {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--color-text-3, #9a96ab);
  cursor: pointer;
}
.ph .mark {
  position: relative;
  width: 22px;
  height: 16px;
}
.ph .mark::before,
.ph .mark::after {
  content: "";
  position: absolute;
  border: 1.5px solid currentColor;
  border-radius: 2px;
}
.ph .mark::before {
  top: 0;
  left: 0;
  width: 9px;
  height: 6px;
  box-shadow: 11px 0 0 -1px transparent;
}
.ph .mark::after {
  right: 0;
  bottom: 0;
  width: 16px;
  height: 7px;
}
.name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 10px;
}
.kind {
  color: var(--color-text-3, #9a96ab);
  font-size: 12px;
}
.title {
  min-width: 0;
  overflow: hidden;
  font-weight: 650;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
