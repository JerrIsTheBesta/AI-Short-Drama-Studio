<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { runCanvasNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { pushHistory } from '@/utils/shot'
import { needsPlayReview, PLAY_GATE_MSG } from '@/services/canvas/playGate'
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
const historyUrls = ref<Record<string, string>>({})
const running = computed(() => (props.node ? isNodeRunning(props.node.id) : false))

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

const currentAssetId = computed(() => {
  const t = props.node?.type
  if (t === 'subject') return subject.value?.designSheetAssetId
  if (t === 'scene') return scene.value?.plateAssetId
  if (t === 'shotImage') return shot.value?.imageAssetId
  if (t === 'shotVideo') return shot.value?.videoAssetId
  if (t === 'audio') return shot.value?.audioAssetId
  return undefined
})

const hasAsset = computed(() => Boolean(currentAssetId.value))
const waitingReview = computed(() => needsPlayReview(project.current))
const gateBlocked = computed(() => {
  const t = props.node?.type
  return Boolean(t && t !== 'script' && t !== 'export' && waitingReview.value)
})

const actionLabel = computed(() => {
  const t = props.node?.type
  const again = hasAsset.value
  if (t === 'script') return project.current?.shots.length ? '重新拆分镜' : '拆分镜'
  if (t === 'subject') return again ? '重新生成人设图' : '生成人设图'
  if (t === 'scene') return again ? '重新生成场景图' : '生成场景图'
  if (t === 'shotImage') return again ? '重新生成配图' : '生成配图'
  if (t === 'shotVideo') return again ? '重新生成视频' : '生成视频'
  if (t === 'audio') return again ? '重新生成口播' : '生成口播'
  if (t === 'export') return '打开导出'
  return again ? '重新生成' : '生成这个节点'
})

const canRun = computed(() => !running.value && !gateBlocked.value)

const kindLabel = computed(() => {
  const t = props.node?.type
  if (t === 'script') return '完整剧本'
  if (t === 'subject') return '人物 · 人设图'
  if (t === 'scene') return '场景 · 底板图'
  if (t === 'shotImage') return '分镜 · 配图'
  if (t === 'shotVideo') return '分镜 · 视频'
  if (t === 'audio') return '分镜 · 口播'
  if (t === 'export') return '成片'
  return t || ''
})

const title = computed(() => {
  if (!props.node) return '未选择'
  if (props.node.type === 'script') return project.current?.script?.topic || '文案'
  if (subject.value) return subject.value.name
  if (scene.value) return scene.value.name
  if (shot.value) return `${shot.value.index + 1}. ${shot.value.title}`
  return props.node.data.label || props.node.type
})

const historyIds = computed(() => {
  const t = props.node?.type
  if (t === 'subject') return subject.value?.designSheetHistoryIds ?? []
  if (t === 'scene') return scene.value?.plateHistoryIds ?? []
  if (t === 'shotImage') return shot.value?.imageHistoryIds ?? []
  if (t === 'shotVideo') return shot.value?.videoHistoryIds ?? []
  return []
})

const imagePromptValue = computed(() => shot.value?.imagePrompt ?? shot.value?.visualPrompt ?? '')
const videoPromptValue = computed(() => shot.value?.videoPrompt ?? shot.value?.visualPrompt ?? '')

async function refreshPreview() {
  preview.value = ''
  const id = currentAssetId.value
  if (!id || !props.node) return
  preview.value = (await assets.getUrl(id)) || ''
}

async function loadHistory() {
  const ids = historyIds.value
  const next: Record<string, string> = {}
  for (const id of ids) {
    const url =
      props.node?.type === 'shotVideo'
        ? (await assets.ensureThumb(id)) || (await assets.getUrl(id))
        : await assets.getUrl(id)
    if (url) next[id] = url
  }
  historyUrls.value = next
}

async function restoreHistory(assetId: string) {
  const t = props.node?.type
  if (t === 'shotImage' && shot.value) project.assignShotImage(shot.value.id, assetId)
  else if (t === 'shotVideo' && shot.value) project.assignShotVideo(shot.value.id, assetId)
  else if (t === 'subject' && subject.value) {
    project.updateSubject(subject.value.id, {
      designSheetAssetId: assetId,
      designSheetHistoryIds: pushHistory(
        subject.value.designSheetAssetId,
        assetId,
        subject.value.designSheetHistoryIds
      )
    })
  } else if (t === 'scene' && scene.value) {
    project.updateScene(scene.value.id, {
      plateAssetId: assetId,
      plateHistoryIds: pushHistory(
        scene.value.plateAssetId,
        assetId,
        scene.value.plateHistoryIds
      )
    })
  } else return
  await project.save()
  await refreshPreview()
  await loadHistory()
  toast.success('已切回这个版本')
}

async function run() {
  if (!props.node) return
  if (gateBlocked.value) {
    toast.warn(PLAY_GATE_MSG)
    return
  }
  try {
    if (props.node.type === 'export') {
      router.push('/export')
      return
    }
    await runCanvasNode(props.node.id, () => {})
    await refreshPreview()
    await loadHistory()
    toast.success(actionLabel.value + '完成')
  } catch (e: any) {
    toast.error(e.message || '生成失败')
  }
}

watch(
  () => [props.node?.id, currentAssetId.value] as const,
  () => {
    refreshPreview()
    loadHistory()
  }
)

watch(running, (now, was) => {
  if (was && !now) {
    refreshPreview()
    loadHistory()
  }
})

function patchScript(field: 'topic' | 'content', value: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, [field]: value })
}

function resetImagePrompt() {
  if (!shot.value) return
  project.updateShot(shot.value.id, { imagePrompt: shot.value.visualPrompt })
}

function resetVideoPrompt() {
  if (!shot.value) return
  project.updateShot(shot.value.id, { videoPrompt: shot.value.visualPrompt })
}
</script>

<template>
  <aside class="insp">
    <div v-if="!node" class="empty">点画布上的节点，这里改提示词、单独重新生成</div>
    <template v-else>
      <div class="insp-k">{{ kindLabel }}</div>
      <h3>{{ title }}</h3>
      <p v-if="node.error" class="err">{{ node.error }}</p>
      <p v-else-if="hasAsset && node.type !== 'script' && node.type !== 'export'" class="hint">
        改下面提示词后点重新生成，只动这一个节点
      </p>

      <p v-else-if="node.type === 'script'" class="hint">
        拆完先看左侧完整剧本。确认通过后才做人设和配图；说「全流程」才会自动跑完。
      </p>
      <p v-else-if="gateBlocked" class="hint">{{ PLAY_GATE_MSG }}</p>

      <template v-if="node.type === 'script' && project.current">
        <label>主题</label>
        <input
          :value="project.current.script?.topic"
          @input="patchScript('topic', ($event.target as HTMLInputElement).value)"
        />
        <label>文案（Markdown，可用 # 大标题 ## 小标题）</label>
        <textarea
          rows="12"
          :value="project.current.script?.content"
          @input="patchScript('content', ($event.target as HTMLTextAreaElement).value)"
        />
        <GradientButton
          v-if="waitingReview"
          block
          type="secondary"
          @click="project.setPlayApproved(true)"
        >
          确认通过，往下做人设
        </GradientButton>
      </template>

      <template v-else-if="node.type === 'subject' && subject">
        <label>人设生图提示词</label>
        <textarea
          rows="7"
          :value="subject.description"
          placeholder="外貌、服装、年龄、气质。改完点重新生成。"
          @input="project.updateSubject(subject.id, { description: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'scene' && scene">
        <label>场景生图提示词</label>
        <textarea
          rows="7"
          :value="scene.description"
          placeholder="地点、时间、天气、光线、材质。改完点重新生成。"
          @input="project.updateScene(scene.id, { description: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotImage' && shot">
        <div class="lab-row">
          <label>本镜配图提示词</label>
          <button class="link" type="button" @click="resetImagePrompt">恢复分镜原文</button>
        </div>
        <textarea
          rows="7"
          :value="imagePromptValue"
          placeholder="这一镜要画什么。只影响配图，不影响视频提示词。"
          @input="project.updateShot(shot.id, { imagePrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotVideo' && shot">
        <div class="lab-row">
          <label>本镜视频提示词</label>
          <button class="link" type="button" @click="resetVideoPrompt">恢复分镜原文</button>
        </div>
        <textarea
          rows="6"
          :value="videoPromptValue"
          placeholder="运镜、动作、节奏。只影响视频，不改配图。"
          @input="project.updateShot(shot.id, { videoPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>运镜</label>
        <select
          :value="shot.cameraMovement"
          @change="project.updateShot(shot.id, { cameraMovement: ($event.target as HTMLSelectElement).value as any })"
        >
          <option value="static">固定</option>
          <option value="push">推</option>
          <option value="pull">拉</option>
          <option value="pan">摇</option>
          <option value="tilt">移</option>
          <option value="orbit">环绕</option>
        </select>
        <p v-if="!shot.imageAssetId" class="err">这一镜还没有配图，先生成配图再出视频。</p>
      </template>

      <template v-else-if="node.type === 'audio' && shot">
        <label>口播文案</label>
        <textarea
          rows="4"
          :value="shot.voiceover"
          placeholder="这一镜要说的话"
          @input="project.updateShot(shot.id, { voiceover: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <div v-if="preview && node.type === 'shotVideo'" class="prev">
        <video :src="preview" controls playsinline />
      </div>
      <div v-else-if="preview" class="prev">
        <img :src="preview" alt="" />
      </div>

      <div v-if="historyIds.length" class="hist">
        <span>历史版本（点一下切回）</span>
        <div class="hist-row">
          <button
            v-for="hid in historyIds"
            :key="hid"
            class="hist-item"
            type="button"
            title="切回这个版本"
            @click="restoreHistory(hid)"
          >
            <img v-if="historyUrls[hid]" :src="historyUrls[hid]" alt="" />
          </button>
        </div>
      </div>

      <GradientButton block :loading="running" :disabled="!canRun" @click="run">
        {{ gateBlocked ? '请先验收剧本' : actionLabel }}
      </GradientButton>
      <button class="ghost" type="button" @click="refreshPreview">刷新预览</button>
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
.err,
.hint {
  font-size: 12px;
  color: var(--color-text-3);
  margin: 0;
}
.err {
  color: var(--color-error);
}
.lab-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.link {
  font-size: 11px;
  color: var(--color-accent);
  padding: 0;
  background: none;
}
label {
  font-size: 11px;
  color: var(--color-text-4);
}
input,
textarea,
select {
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
.hist {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hist > span {
  font-size: 11px;
  color: var(--color-text-4);
}
.hist-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.hist-item {
  width: 48px;
  height: 36px;
  padding: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-bg-3);
}
.hist-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ghost {
  font-size: 12px;
  color: var(--color-text-3);
  padding: 6px;
}
</style>
