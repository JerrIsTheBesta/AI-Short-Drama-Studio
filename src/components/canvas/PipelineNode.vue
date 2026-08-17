<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useAssetsStore, useProjectStore } from '@/stores'
import type { CanvasNodeType } from '@/types'

const props = defineProps<{
  id: string
  data: {
    subjectId?: string
    sceneId?: string
    shotId?: string
    label?: string
    nodeType?: CanvasNodeType
  }
}>()

const type = computed<CanvasNodeType>(() => props.data.nodeType || 'script')

const project = useProjectStore()
const assets = useAssetsStore()
const mediaUrl = ref('')

const nodeMeta = computed(() => {
  const p = project.current
  const canvasNode = p?.canvas?.nodes.find((n) => n.id === props.id)
  return canvasNode
})

const title = computed(() => {
  if (type.value === 'script') return project.current?.script?.topic || project.current?.name || '文案'
  if (type.value === 'subject') {
    return (project.current?.subjects ?? []).find((s) => s.id === props.data.subjectId)?.name || '主体'
  }
  if (type.value === 'scene') {
    return (project.current?.scenes ?? []).find((s) => s.id === props.data.sceneId)?.name || '场景'
  }
  if (props.data.shotId) {
    const s = project.current?.shots.find((x) => x.id === props.data.shotId)
    return s ? `${s.index + 1}. ${s.title}` : props.data.label
  }
  return props.data.label || type.value
})

const subtitle = computed(() => {
  if (type.value === 'script') return '文案 / 拆分镜'
  if (type.value === 'subject') return '多角度人设'
  if (type.value === 'scene') return '场景底板'
  if (type.value === 'shotImage') return '分镜配图'
  if (type.value === 'shotVideo') return '分镜视频'
  if (type.value === 'audio') return '口播 TTS'
  if (type.value === 'export') return '成片导出'
  return ''
})

const assetId = computed(() => {
  const p = project.current
  if (!p) return undefined
  if (type.value === 'subject') {
    return (p.subjects ?? []).find((s) => s.id === props.data.subjectId)?.designSheetAssetId
  }
  if (type.value === 'scene') {
    return (p.scenes ?? []).find((s) => s.id === props.data.sceneId)?.plateAssetId
  }
  const shot = p.shots.find((s) => s.id === props.data.shotId)
  if (!shot) return undefined
  if (type.value === 'shotImage') return shot.imageAssetId
  if (type.value === 'shotVideo') return shot.videoAssetId
  return undefined
})

const status = computed(() => nodeMeta.value?.status ?? 'idle')

watch(
  assetId,
  () => {
    loadMedia()
  },
  { immediate: true }
)

async function loadMedia() {
  const id = assetId.value
  if (!id) {
    mediaUrl.value = ''
    return
  }
  if (type.value === 'shotVideo') {
    mediaUrl.value = (await assets.ensureThumb(id)) || (await assets.getUrl(id)) || ''
  } else {
    mediaUrl.value = (await assets.getUrl(id)) || ''
  }
}

defineExpose({ loadMedia })
</script>

<template>
  <div class="pnode" :class="[`kind-${type}`, `st-${status}`]">
    <Handle
      v-if="type !== 'script'"
      id="in"
      type="target"
      :position="Position.Left"
      class="hndl"
    />
    <Handle
      v-if="type === 'shotImage'"
      id="char1"
      type="target"
      :position="Position.Left"
      :style="{ top: '28%' }"
      class="hndl"
    />
    <Handle
      v-if="type === 'shotImage'"
      id="char2"
      type="target"
      :position="Position.Left"
      :style="{ top: '50%' }"
      class="hndl"
    />
    <Handle
      v-if="type === 'shotImage'"
      id="scene"
      type="target"
      :position="Position.Left"
      :style="{ top: '72%' }"
      class="hndl"
    />
    <Handle
      v-if="type === 'shotVideo'"
      id="image"
      type="target"
      :position="Position.Left"
      class="hndl"
    />

    <div class="pnode-head">
      <span class="pnode-k">{{ subtitle }}</span>
      <span v-if="status === 'running'" class="badge run">生成中</span>
      <span v-else-if="status === 'failed'" class="badge fail">生成失败</span>
      <span v-else-if="status === 'success'" class="badge ok">完成</span>
    </div>
    <div class="pnode-title">{{ title }}</div>
    <div v-if="type === 'script'" class="pnode-body text">
      {{ (project.current?.script?.content || '还没有正文，在右侧填写或让智能体拆分镜').slice(0, 120) }}
    </div>
    <div v-else-if="type === 'audio'" class="pnode-body wave">
      {{ project.current?.shots.find((s) => s.id === data.shotId)?.voiceover?.slice(0, 40) || '无口播' }}
    </div>
    <div v-else-if="type === 'export'" class="pnode-body text">拼接时间线 · 字幕 · BGM</div>
    <div v-else class="pnode-media">
      <img v-if="mediaUrl" :src="mediaUrl" alt="" />
      <div v-else class="ph">{{ type === 'shotVideo' ? '▶' : '＋' }}</div>
    </div>
    <div v-if="nodeMeta?.error" class="pnode-err">{{ nodeMeta.error }}</div>

    <Handle id="out" type="source" :position="Position.Right" class="hndl" />
  </div>
</template>

<style scoped>
.pnode {
  width: 240px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border-strong);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--shadow-md);
  color: var(--color-text-1);
}
.pnode.st-running {
  border-color: var(--color-accent);
}
.pnode.st-failed {
  border-color: var(--color-error);
}
.pnode.st-success {
  border-color: rgba(16, 185, 129, 0.5);
}
.pnode-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px 0;
}
.pnode-k {
  font-size: 10px;
  color: var(--color-text-4);
  letter-spacing: 0.04em;
}
.pnode-title {
  font-size: 13px;
  font-weight: 700;
  padding: 2px 10px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pnode-media {
  height: 112px;
  background: #0b0b14;
}
.pnode-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ph {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-4);
  font-size: 22px;
}
.pnode-body {
  padding: 8px 10px 12px;
  font-size: 11px;
  color: var(--color-text-3);
  line-height: 1.45;
  min-height: 48px;
}
.pnode-err {
  padding: 4px 10px 8px;
  font-size: 10px;
  color: var(--color-error);
}
.badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 99px;
}
.badge.run {
  background: rgba(124, 58, 237, 0.25);
  color: #c4b5fd;
}
.badge.fail {
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
}
.badge.ok {
  background: rgba(16, 185, 129, 0.2);
  color: #6ee7b7;
}
.hndl {
  width: 8px;
  height: 8px;
  background: #a78bfa;
  border: 1px solid #fff;
}
</style>
