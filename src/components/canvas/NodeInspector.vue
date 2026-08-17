<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { runCanvasNode } from '@/services/canvas/runner'
import GradientButton from '@/components/common/GradientButton.vue'
import type { CanvasNode } from '@/types'

const props = defineProps<{
  node: CanvasNode | null
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const router = useRouter()
const preview = ref('')
const running = ref(false)

const shot = computed(() => {
  const id = props.node?.data.shotId
  return project.current?.shots.find((s) => s.id === id)
})
const subject = computed(() => {
  const id = props.node?.data.subjectId
  return (project.current?.subjects ?? []).find((s) => s.id === id)
})
const scene = computed(() => {
  const id = props.node?.data.sceneId
  return (project.current?.scenes ?? []).find((s) => s.id === id)
})

const title = computed(() => {
  if (!props.node) return '未选择'
  if (props.node.type === 'script') return project.current?.script?.topic || '文案'
  if (subject.value) return subject.value.name
  if (scene.value) return scene.value.name
  if (shot.value) return `${shot.value.index + 1}. ${shot.value.title}`
  return props.node.data.label || props.node.type
})

async function refreshPreview() {
  preview.value = ''
  if (!props.node) return
  let id: string | undefined
  if (subject.value) id = subject.value.designSheetAssetId
  else if (scene.value) id = scene.value.plateAssetId
  else if (shot.value && props.node.type === 'shotImage') id = shot.value.imageAssetId
  else if (shot.value && props.node.type === 'shotVideo') id = shot.value.videoAssetId
  if (!id) return
  preview.value =
    props.node.type === 'shotVideo'
      ? (await assets.getUrl(id)) || ''
      : (await assets.getUrl(id)) || ''
}

async function run() {
  if (!props.node) return
  running.value = true
  try {
    if (props.node.type === 'export') {
      router.push('/export')
      return
    }
    await runCanvasNode(props.node.id, () => {})
    await refreshPreview()
    toast.success('节点已完成')
  } catch (e: any) {
    toast.error(e.message || '生成失败')
  } finally {
    running.value = false
  }
}

watch(
  () => props.node?.id,
  () => {
    refreshPreview()
  }
)

function patchScript(field: 'topic' | 'content', value: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, [field]: value })
}
</script>

<template>
  <aside class="insp">
    <div v-if="!node" class="empty">点画布上的节点，这里显示详情和生成按钮</div>
    <template v-else>
      <div class="insp-k">{{ node.type }}</div>
      <h3>{{ title }}</h3>
      <p v-if="node.error" class="err">{{ node.error }}</p>

      <template v-if="node.type === 'script' && project.current">
        <label>主题</label>
        <input
          :value="project.current.script?.topic"
          @change="patchScript('topic', ($event.target as HTMLInputElement).value)"
        />
        <label>文案</label>
        <textarea
          rows="8"
          :value="project.current.script?.content"
          @change="patchScript('content', ($event.target as HTMLTextAreaElement).value)"
        />
      </template>

      <template v-else-if="subject">
        <label>外貌锁定</label>
        <textarea
          rows="6"
          :value="subject.description"
          @change="project.updateSubject(subject.id, { description: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="scene">
        <label>环境锁定</label>
        <textarea
          rows="6"
          :value="scene.description"
          @change="project.updateScene(scene.id, { description: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="shot">
        <label>画面描述</label>
        <textarea
          rows="6"
          :value="shot.visualPrompt"
          @change="project.updateShot(shot.id, { visualPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>口播</label>
        <textarea
          rows="3"
          :value="shot.voiceover"
          @change="project.updateShot(shot.id, { voiceover: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <div v-if="preview && node.type === 'shotVideo'" class="prev">
        <video :src="preview" controls playsinline />
      </div>
      <div v-else-if="preview" class="prev">
        <img :src="preview" alt="" />
      </div>

      <GradientButton block :loading="running" @click="run">
        {{
          node.type === 'script'
            ? 'AI 拆分镜并铺画布'
            : node.type === 'export'
              ? '打开导出'
              : '生成这个节点'
        }}
      </GradientButton>
      <button class="ghost" @click="refreshPreview">刷新预览</button>
    </template>
  </aside>
</template>

<style scoped>
.insp {
  width: 300px;
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  background: var(--color-bg-1);
  padding: 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.insp h3 {
  margin: 0;
  font-size: 16px;
}
.insp-k {
  font-size: 10px;
  color: var(--color-text-4);
  text-transform: uppercase;
}
.empty,
.err {
  font-size: 12px;
  color: var(--color-text-3);
}
.err {
  color: var(--color-error);
}
label {
  font-size: 11px;
  color: var(--color-text-4);
}
input,
textarea {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-1);
  padding: 8px;
  font: inherit;
  font-size: 12px;
}
.prev img,
.prev video {
  width: 100%;
  border-radius: 8px;
  display: block;
}
.ghost {
  font-size: 12px;
  color: var(--color-text-3);
  padding: 6px;
}
</style>
