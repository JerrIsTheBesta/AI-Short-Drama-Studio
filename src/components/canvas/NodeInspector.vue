<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectStore, useAssetsStore, useToastStore, useSettingsStore } from '@/stores'
import { llmChoiceKey, llmModelGroups, parseLlmChoiceKey } from '@/stores/settings'
import { runCanvasNode, runScriptNode } from '@/services/canvas/runner'
import { isNodeRunning } from '@/services/canvas/jobs'
import { effectiveShotAudioMode, editableVideoPrompt, needsExternalTts, pushHistory, synthesizeVideoPerformance } from '@/utils/shot'
import { needsPlayReview, PLAY_GATE_MSG } from '@/services/canvas/playGate'
import { generateMusic, refineMusicPrompt, buildMusicPrompt, isPlayReady } from '@/services/ai'
import { friendlyAiError, shouldToastAiError } from '@/services/ai/abort'
import ImageModelSelect from '@/components/settings/ImageModelSelect.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import { openLightbox } from '@/composables/useLightbox'
import { cssAspectRatio } from '@/services/canvas/layout'
import { canBuildExport } from '@/utils/timeline'
import type { CanvasNode, ShotAudioMode } from '@/types'

const props = defineProps<{
  node: CanvasNode | null
}>()

const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const settings = useSettingsStore()
const preview = ref('')
const historyUrls = ref<Record<string, string>>({})
const running = computed(() => (props.node ? isNodeRunning(props.node.id) : false))
const bgmPrompt = ref('')
const bgmUrl = ref('')
const generatingBgm = ref(false)
const bgmError = ref('')
const continueHint = ref('')

const keepAmbientAudio = computed({
  get: () => project.current?.settings.keepAmbientAudio !== false,
  set: (v: boolean) => project.setSettings({ keepAmbientAudio: v })
})
const ambientVolume = computed({
  get: () => project.current?.settings.originalVolume ?? 0.55,
  set: (v: number) => project.setSettings({ originalVolume: v })
})
const bgmVolume = computed({
  get: () => project.current?.settings.bgmVolume ?? 0.35,
  set: (v: number) => project.setSettings({ bgmVolume: v })
})
const burnCaptions = computed({
  get: () => project.current?.settings.burnCaptions !== false,
  set: (v: boolean) => project.setSettings({ burnCaptions: v })
})
const bgmAssetId = computed({
  get: () => project.current?.bgmAssetId || '',
  set: (id: string) => {
    project.setBgm(id || undefined, bgmPrompt.value)
  }
})
const audioAssets = computed(() =>
  assets.all.filter((a) => a.kind === 'audio' && !String(a.filename).startsWith('vo_'))
)
const totalDuration = computed(() => {
  const p = project.current
  if (!p) return 24
  if (p.timeline?.length) {
    return Math.max(
      8,
      p.timeline.filter((c) => c.enabled).reduce((s, c) => s + (c.duration || 0), 0)
    )
  }
  return Math.max(
    8,
    p.shots.reduce((s, sh) => s + (sh.duration || 0), 0)
  )
})
const isExportNode = computed(
  () => props.node?.type === 'export' || props.node?.type === 'final'
)

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
  if (t === 'final') return project.current?.finalVideoAssetId
  if (t === 'subject') return subject.value?.designSheetAssetId
  if (t === 'subjectProps') return subject.value?.propSheetAssetId
  if (t === 'scene') return scene.value?.plateAssetId
  if (t === 'shotBoard') return shot.value?.boardAssetId
  if (t === 'shotImage') return shot.value?.imageAssetId
  if (t === 'shotVideo') return shot.value?.videoAssetId
  if (t === 'audio') return shot.value?.audioAssetId
  if (t === 'imageGen' || t === 'videoGen') return props.node?.data.outputAssetId
  return undefined
})

const hasAsset = computed(() => Boolean(currentAssetId.value))
const waitingReview = computed(() => needsPlayReview(project.current))
const gateBlocked = computed(() => {
  const t = props.node?.type
  return Boolean(
    t &&
      t !== 'script' &&
      t !== 'export' &&
      t !== 'final' &&
      t !== 'imageGen' &&
      t !== 'videoGen' &&
      waitingReview.value
  )
})

const actionLabel = computed(() => {
  const t = props.node?.type
  const again = hasAsset.value || Boolean(project.current?.finalVideoAssetId)
  if (t === 'script') {
    return isPlayReady(project.current?.script) ? '重新写剧本' : '写剧本'
  }
  if (t === 'subject') return again ? '重新生成四视图' : '生成四视图'
  if (t === 'subjectProps') return again ? '重新生成资产图' : '生成资产图'
  if (t === 'scene') return again ? '重新生成锚点图' : '生成锚点图'
  if (t === 'shotBoard') return again ? '重新生成故事看板' : '生成故事看板'
  if (t === 'shotImage') return again ? '重新生成配图' : '生成配图'
  if (t === 'shotVideo') return again ? '重新生成视频' : '生成视频'
  if (t === 'audio') {
    if (!shot.value || !needsExternalTts(shot.value)) return '无需独立配音'
    return again ? '重新生成口播' : '生成口播'
  }
  if (t === 'export' || t === 'final') return again ? '重新合成视频' : '合成视频'
  return again ? '重新生成' : '生成这个节点'
})

const extractLabel = computed(() =>
  project.current?.shots.length
    ? '重新提炼节点'
    : !(project.current?.subjects?.length)
      ? '第 1 步：提炼人物'
      : !(project.current?.scenes?.length)
        ? '第 2 步：提炼场景'
        : '第 3 步：拆分镜'
)

const isImageNode = computed(() => {
  const t = props.node?.type
  return t === 'subject' || t === 'subjectProps' || t === 'scene' || t === 'shotBoard' || t === 'shotImage'
})

const canRun = computed(() => {
  if (running.value || gateBlocked.value) return false
  if (props.node?.type === 'export' || props.node?.type === 'final') {
    return canBuildExport(project.current)
  }
  if (props.node?.type === 'audio' && shot.value && !needsExternalTts(shot.value)) return false
  return true
})

const previewAspect = computed(() => {
  if (props.node?.type === 'subject' || props.node?.type === 'subjectProps' || props.node?.type === 'scene') {
    return cssAspectRatio('16:9')
  }
  return cssAspectRatio(project.current?.settings.aspectRatio)
})

const kindLabel = computed(() => {
  const t = props.node?.type
  if (t === 'script') return '完整剧本'
  if (t === 'subject') return '人物 · 四视图'
  if (t === 'subjectProps') return '人物 · 资产图'
  if (t === 'scene') return '场景 · 锚点图'
  if (t === 'shotBoard') return '分镜 · 故事看板'
  if (t === 'shotImage') return '分镜 · 配图'
  if (t === 'shotVideo') {
    const d = shot.value?.duration
    return d ? `分镜 · 视频 · ${d}s` : '分镜 · 视频'
  }
  if (t === 'audio') return '分镜 · 口播'
  if (t === 'export') return '视频 · 合成'
  if (t === 'final') return '视频 · 预览'
  if (t === 'imageGen') return '图片生成'
  if (t === 'videoGen') return '图生视频'
  return t || ''
})

const title = computed(() => {
  if (!props.node) return '未选择'
  if (props.node.type === 'script') return project.current?.script?.topic || '文案'
  if (subject.value) return subject.value.name
  if (scene.value) return scene.value.name
  if (shot.value) return `${shot.value.index + 1}. ${shot.value.title}`
  if (props.node.type === 'export') return '合成视频'
  if (props.node.type === 'final') return '视频预览'
  return props.node.data.label || props.node.type
})

const historyIds = computed(() => {
  const t = props.node?.type
  if (t === 'subject') return subject.value?.designSheetHistoryIds ?? []
  if (t === 'subjectProps') return subject.value?.propSheetHistoryIds ?? []
  if (t === 'scene') return scene.value?.plateHistoryIds ?? []
  if (t === 'shotBoard') return shot.value?.boardHistoryIds ?? []
  if (t === 'shotImage') return shot.value?.imageHistoryIds ?? []
  if (t === 'shotVideo') return shot.value?.videoHistoryIds ?? []
  return []
})

const imagePromptValue = computed(() => shot.value?.imagePrompt ?? shot.value?.visualPrompt ?? '')
const videoPromptValue = computed(() => (shot.value ? editableVideoPrompt(shot.value) : ''))
const videoPromptPlaceholder = computed(() =>
  (settings.config.video.promptStyle || 'scene-narrative') === 'formatted'
    ? '每个角色的表情神态、手脚动作、环境怎么动、说什么原词、镜头怎么走。写细才有表现力。'
    : '画面中：站位、发型、衣服、动作、年龄的人是谁。空一行后连续写这一镜怎么演、台词原词、环境动势、镜头怎么收。'
)

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
  else if (t === 'shotBoard' && shot.value) project.assignShotBoard(shot.value.id, assetId)
  else if (t === 'shotVideo' && shot.value) project.assignShotVideo(shot.value.id, assetId)
  else if (t === 'subjectProps' && subject.value) {
    project.updateSubject(subject.value.id, {
      propSheetAssetId: assetId,
      propSheetHistoryIds: pushHistory(
        subject.value.propSheetAssetId,
        assetId,
        subject.value.propSheetHistoryIds
      )
    })
  }
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

async function downloadFinal() {
  const id = project.current?.finalVideoAssetId
  if (!id) {
    toast.warn('还没有合成视频，请先合成')
    return
  }
  const blob = await assets.getBlob(id)
  if (!blob) {
    toast.error('视频文件读取失败')
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.current?.name ?? 'final'}.mp4`
  a.click()
  URL.revokeObjectURL(url)
}

async function refreshBgmPreview() {
  const id = project.current?.bgmAssetId
  if (!id) {
    bgmUrl.value = ''
    return
  }
  bgmUrl.value = (await assets.getUrl(id)) || ''
}

async function ensureBgmPrompt() {
  if (!project.current) return
  if (!bgmPrompt.value.trim()) {
    bgmPrompt.value =
      project.current.bgmPrompt || buildMusicPrompt(project.current)
  }
}

async function generateBgm() {
  if (!project.current) return
  generatingBgm.value = true
  bgmError.value = ''
  try {
    await ensureBgmPrompt()
    let prompt = bgmPrompt.value.trim()
    if (!prompt) {
      prompt = await refineMusicPrompt(project.current)
      bgmPrompt.value = prompt
    }
    const result = await generateMusic({
      prompt,
      duration: totalDuration.value || 24
    })
    const typed = result.blob.type.startsWith('audio/')
      ? result.blob
      : new Blob([result.blob], { type: result.mimeType || 'audio/mpeg' })
    const asset = await assets.add(typed, 'audio', 'ai-generated', {
      filename: `bgm_${Date.now().toString(36)}`,
      prompt,
      projectId: project.current.id
    })
    project.setBgm(asset.id, prompt)
    await project.save()
    await refreshBgmPreview()
    toast.success('整片配乐已生成，可先试听')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    bgmError.value = msg
    toast.error('配乐生成失败：' + msg, 10000)
  } finally {
    generatingBgm.value = false
  }
}

function onBgmPromptBlur() {
  if (!project.current) return
  project.setBgm(project.current.bgmAssetId, bgmPrompt.value)
}

async function run() {
  if (!props.node) return
  if (gateBlocked.value) {
    toast.warn(PLAY_GATE_MSG)
    return
  }
  try {
    if (props.node.type === 'script') {
      await runScriptNode('play', undefined, undefined, llmModel.value)
    } else {
      await runCanvasNode(props.node.id)
    }
    await refreshPreview()
    await loadHistory()
    toast.success(actionLabel.value + '完成')
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '生成失败')
  }
}

async function runContinue() {
  if (!props.node) return
  try {
    await runScriptNode('continue', undefined, undefined, llmModel.value, continueHint.value)
    toast.success('已续写剧本')
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '续写失败')
  }
}

async function runExtract() {
  if (!props.node) return
  try {
    await runScriptNode('extract', undefined, undefined, llmModel.value)
    toast.success('节点已从剧本提炼出来')
  } catch (e: any) {
    if (shouldToastAiError(e)) toast.error(friendlyAiError(e) || '提炼失败')
  }
}

watch(
  () => [props.node?.id, currentAssetId.value] as const,
  () => {
    refreshPreview()
    loadHistory()
  }
)

watch(
  () => [props.node?.type, project.current?.bgmAssetId, project.current?.bgmPrompt] as const,
  async ([type]) => {
    if (type !== 'export' && type !== 'final') return
    await assets.refresh()
    await ensureBgmPrompt()
    await refreshBgmPreview()
  },
  { immediate: true }
)

watch(running, (now, was) => {
  if (was && !now) {
    refreshPreview()
    loadHistory()
  }
})

const llmGroups = computed(() => llmModelGroups(settings.config.llms ?? []))
const llmChoice = computed({
  get() {
    const id = settings.config.activeLlmId
    const model = settings.config.llm.model
    return id && model ? llmChoiceKey(id, model) : ''
  },
  set(v: string) {
    const parsed = parseLlmChoiceKey(v)
    if (parsed) settings.selectLlmModel(parsed.profileId, parsed.model)
  }
})
const llmModel = computed(() => settings.config.llm.model)

function patchScript(field: 'topic' | 'content', value: string) {
  if (!project.current?.script) return
  project.setScript({ ...project.current.script, [field]: value })
  if (field === 'topic') project.applyPlayTitle(value)
}

function resetImagePrompt() {
  if (!shot.value) return
  project.updateShot(shot.value.id, { imagePrompt: shot.value.visualPrompt })
}

function resetVideoPrompt() {
  if (!shot.value) return
  project.updateShot(shot.value.id, { videoPrompt: synthesizeVideoPerformance(shot.value) })
}
</script>

<template>
  <aside class="insp">
    <div v-if="!node" class="empty">点画布上的节点，这里改提示词、单独重新生成</div>
    <template v-else>
      <div class="insp-k">{{ kindLabel }}</div>
      <h3>{{ title }}</h3>
      <p v-if="node.error" class="err">{{ node.error }}</p>
      <p v-else-if="hasAsset && node.type === 'audio'" class="hint">
        点播放可试听口播。改文案后重新生成，只动这一个节点。
      </p>
      <p v-else-if="hasAsset && node.type !== 'script' && node.type !== 'export' && node.type !== 'final'" class="hint">
        改下面提示词后点重新生成，只动这一个节点。点缩略图可看大图。
      </p>

      <p v-else-if="node.type === 'script'" class="hint">
        分两步：先写完整剧本（还不拆节点）。写好后可续写（保留已有场次），或提炼人物、场景、分镜。
      </p>
      <p v-else-if="node.type === 'export'" class="hint">
        先调下方音频与字幕，再点合成。视频会出现在「视频预览」节点。
      </p>
      <p v-else-if="node.type === 'final'" class="hint">
        可预览/下载视频。改音频设置后点重新合成即可。
      </p>
      <p v-else-if="gateBlocked" class="hint">{{ PLAY_GATE_MSG }}</p>

      <div v-if="preview && (node.type === 'shotVideo' || node.type === 'final')" class="prev prev-video">
        <div class="prev-frame" :style="{ aspectRatio: previewAspect }">
          <video :src="preview" controls playsinline preload="auto" />
        </div>
      </div>
      <div v-else-if="preview && node.type === 'audio'" class="prev prev-audio">
        <audio :src="preview" controls preload="auto" />
        <span>试听口播</span>
      </div>
      <button
        v-else-if="preview"
        class="prev"
        type="button"
        title="点击查看大图"
        @click="openLightbox(preview, 'image', title)"
      >
        <div class="prev-frame" :style="{ aspectRatio: previewAspect }">
          <img :src="preview" alt="" />
        </div>
        <span>查看大图</span>
      </button>

      <template v-if="isExportNode && project.current">
        <label>字幕</label>
        <label class="check">
          <input v-model="burnCaptions" type="checkbox" />
          <span>烧录字幕到画面</span>
        </label>

        <label>分镜原声（环境音）</label>
        <div class="seg">
          <button
            type="button"
            class="seg-btn"
            :class="{ on: keepAmbientAudio }"
            @click="keepAmbientAudio = true"
          >
            保留
          </button>
          <button
            type="button"
            class="seg-btn"
            :class="{ on: !keepAmbientAudio }"
            @click="keepAmbientAudio = false"
          >
            去掉
          </button>
        </div>
        <p class="hint">
          {{
            keepAmbientAudio
              ? '保留普通镜头环境音；H3 自带对白 / 口播始终保留。'
              : '静音 TTS / 无口播镜头原声；H3 自带人声不受影响。'
          }}
        </p>
        <div v-if="keepAmbientAudio" class="vol-row">
          <span class="hint">环境音</span>
          <input v-model.number="ambientVolume" type="range" min="0.1" max="1" step="0.05" />
          <span class="hint">{{ Math.round(ambientVolume * 100) }}%</span>
        </div>

        <label>背景音乐</label>
        <textarea
          v-model="bgmPrompt"
          rows="3"
          placeholder="配乐风格，例如：温暖弦乐铺底，不要人声…"
          @blur="onBgmPromptBlur"
        />
        <div class="vol-row">
          <span class="hint">BGM 音量</span>
          <input v-model.number="bgmVolume" type="range" min="0" max="1" step="0.05" />
          <span class="hint">{{ Math.round(bgmVolume * 100) }}%</span>
        </div>
        <div class="bgm-row">
          <GradientButton
            size="sm"
            :loading="generatingBgm"
            :disabled="generatingBgm || running"
            @click="generateBgm"
          >
            {{ bgmAssetId ? '重新生成配乐' : '生成配乐' }}
          </GradientButton>
          <select v-model="bgmAssetId">
            <option value="">不使用 BGM</option>
            <option v-for="a in audioAssets" :key="a.id" :value="a.id">
              {{ a.filename }}
            </option>
          </select>
        </div>
        <audio v-if="bgmUrl" class="bgm-player" :src="bgmUrl" controls />
        <p v-if="bgmError" class="err">{{ bgmError }}</p>
      </template>

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
        <label>写剧本用的 LLM</label>
        <select v-model="llmChoice">
          <option v-if="!llmGroups.some((g) => g.models.length)" value="">请先在设置里添加模型</option>
          <optgroup v-for="g in llmGroups" :key="g.id" :label="g.name">
            <option v-for="m in g.models" :key="`${g.id}::${m}`" :value="`${g.id}::${m}`">{{ m }}</option>
          </optgroup>
        </select>
      </template>

      <template v-else-if="node.type === 'subject' && subject">
        <label>四视图提示词</label>
        <textarea
          rows="9"
          :value="subject.description"
          placeholder="外貌、服装、年龄、气质。改完点重新生成。"
          @input="project.updateSubject(subject.id, { description: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'subjectProps' && subject">
        <label>身上有哪些东西</label>
        <textarea
          rows="9"
          :value="subject.props || ''"
          placeholder="包、证件、平板、鞋、帽子、配饰。改完点生成资产图。"
          @input="project.updateSubject(subject.id, { props: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'scene' && scene">
        <label>地点描述</label>
        <textarea
          rows="6"
          :value="scene.description"
          placeholder="人还没进来时这个地方：地面、光、门窗、材质。"
          @input="project.updateScene(scene.id, { description: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>主锚</label>
        <input
          :value="scene.mainAnchor || ''"
          placeholder="电梯门、接待台、锅灶……摄像能对着的实物"
          @change="project.updateScene(scene.id, { mainAnchor: ($event.target as HTMLInputElement).value })"
        />
        <label>四宫格锚点</label>
        <textarea
          rows="3"
          :value="scene.anchors || ''"
          placeholder="全景；主锚；地面站位；光源或次锚"
          @input="project.updateScene(scene.id, { anchors: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotBoard' && shot">
        <label>故事看板提示词</label>
        <textarea
          rows="9"
          :value="shot.boardPrompt || shot.visualPrompt"
          placeholder="这一镜的起始状态、动作过程、反应和结束状态。改完点生成六格线稿看板。"
          @input="project.updateShot(shot.id, { boardPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotImage' && shot">
        <div class="lab-row">
          <label>本镜配图提示词</label>
          <button class="link" type="button" @click="resetImagePrompt">恢复分镜原文</button>
        </div>
        <textarea
          rows="9"
          :value="imagePromptValue"
          placeholder="这一镜要画什么。只影响配图，不影响视频提示词。"
          @input="project.updateShot(shot.id, { imagePrompt: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <template v-else-if="node.type === 'shotVideo' && shot">
        <div class="lab-row">
          <label>本镜视频内容表现</label>
          <button class="link" type="button" @click="resetVideoPrompt">按分镜动作重写</button>
        </div>
        <p class="hint">
          直接改这段文字。清空后不会自动填回；要点上面「按分镜动作重写」才会用场记再写一段。
          {{
            (settings.config.video.promptStyle || 'scene-narrative') === 'formatted'
              ? '当前是格式化写法。'
              : '当前是场景叙事。'
          }}
        </p>
        <textarea
          rows="8"
          :value="videoPromptValue"
          :placeholder="videoPromptPlaceholder"
          @input="project.updateShot(shot.id, { videoPrompt: ($event.target as HTMLTextAreaElement).value })"
        />
        <label>时长（秒）</label>
        <input
          type="number"
          min="5"
          max="10"
          step="1"
          :value="shot.duration"
          @change="project.updateShot(shot.id, { duration: Math.min(10, Math.max(5, Math.round(Number(($event.target as HTMLInputElement).value) || shot.duration))) })"
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
        <p v-if="!shot.boardAssetId" class="err">这一镜还没有六格故事看板，先生成看板再出视频。</p>
      </template>

      <template v-else-if="node.type === 'audio' && shot">
        <label>人声方案</label>
        <select
          :value="effectiveShotAudioMode(shot)"
          @change="project.setShotAudioMode(shot.id, ($event.target as HTMLSelectElement).value as ShotAudioMode)"
        >
          <option value="h3-dialogue">H3 出镜对白 + 对口型</option>
          <option value="h3-voiceover">H3 画外口播</option>
          <option value="tts">后期 TTS</option>
          <option value="none">无口播</option>
        </select>
        <label>口播文案</label>
        <textarea
          rows="4"
          :value="shot.voiceover"
          placeholder="这一镜要说的话"
          @input="project.updateShot(shot.id, { voiceover: ($event.target as HTMLTextAreaElement).value })"
        />
      </template>

      <div v-if="historyIds.length" class="hist">
        <span>历史版本（点一下切回）</span>
        <div class="hist-row">
          <div v-for="hid in historyIds" :key="hid" class="hist-item">
            <button
              class="hist-thumb"
              type="button"
              title="查看大图"
              @click="openLightbox(historyUrls[hid], 'image')"
            >
              <img v-if="historyUrls[hid]" :src="historyUrls[hid]" alt="" />
            </button>
            <button class="hist-use" type="button" @click="restoreHistory(hid)">切回</button>
          </div>
        </div>
      </div>

      <ImageModelSelect v-if="isImageNode" />
      <template v-if="node.type === 'script' && isPlayReady(project.current?.script)">
        <label>续写方向（可选）</label>
        <textarea
          rows="3"
          :value="continueHint"
          placeholder="例如：再写两场，写父亲回家之后。不填则顺着往下写 2–3 场。"
          @input="continueHint = ($event.target as HTMLTextAreaElement).value"
        />
      </template>
      <GradientButton
        v-if="node.type === 'script' && isPlayReady(project.current?.script)"
        block
        :loading="running"
        :disabled="running"
        @click="runContinue"
      >
        续写剧本
      </GradientButton>
      <GradientButton
        v-if="node.type === 'script'"
        block
        :type="isPlayReady(project.current?.script) ? 'secondary' : undefined"
        :loading="running"
        :disabled="running"
        @click="run"
      >
        {{ actionLabel }}
      </GradientButton>
      <GradientButton
        v-if="node.type === 'script'"
        block
        type="secondary"
        :loading="running"
        :disabled="running || !((project.current?.script?.content || '').trim())"
        @click="runExtract"
      >
        {{ extractLabel }}
      </GradientButton>
      <GradientButton
        v-else
        block
        :loading="running"
        :disabled="!canRun"
        @click="run"
      >
        {{ gateBlocked ? '请先验收剧本' : actionLabel }}
      </GradientButton>
      <GradientButton
        v-if="node.type === 'final' && hasAsset"
        block
        type="secondary"
        @click="downloadFinal"
      >
        下载视频
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
textarea {
  min-height: 120px;
  flex: 1;
}
.prev {
  align-self: flex-start;
  width: 148px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-bg-3);
  cursor: zoom-in;
}
.prev-frame {
  position: relative;
  width: 100%;
  background: var(--color-bg-2);
}
.prev img,
.prev video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center;
  display: block;
}
.prev span {
  display: block;
  font-size: 10px;
  color: var(--color-text-4);
  padding: 4px 6px 5px;
  text-align: center;
}
.prev-audio {
  width: 100%;
  max-width: 100%;
  cursor: default;
  padding: 8px 8px 0;
}
.prev-audio audio {
  width: 100%;
  height: 36px;
  display: block;
}
.prev-video {
  width: 100%;
  max-width: 220px;
  cursor: default;
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
  width: 56px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: none;
}
.hist-thumb {
  width: 56px;
  height: 40px;
  padding: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-bg-3);
  cursor: zoom-in;
}
.hist-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hist-use {
  font-size: 10px;
  padding: 1px 0;
  color: var(--color-text-4);
  background: none;
}
.hist-use:hover {
  color: var(--color-accent);
}
.ghost {
  font-size: 12px;
  color: var(--color-text-3);
  padding: 6px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-2);
}
.check input {
  width: auto;
}
.seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.seg-btn {
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-2);
  border-radius: 8px;
  padding: 8px 6px;
  font-size: 12px;
  cursor: pointer;
}
.seg-btn.on {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-bg-2));
}
.vol-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
}
.vol-row input[type='range'] {
  padding: 0;
  background: transparent;
  border: none;
}
.bgm-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bgm-row select {
  flex: 1;
  min-width: 0;
}
.bgm-player {
  width: 100%;
  height: 32px;
}
</style>
