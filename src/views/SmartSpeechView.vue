<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import { useAssetsStore, useProjectStore, useToastStore } from '@/stores'
import { cloneVoiceFromSample, generateVideo, synthesizeClonedSpeech } from '@/services/ai'
import { replaceVideoAudio } from '@/services/ffmpeg'
import type {
  AspectRatio,
  SpeechWorkflowMode,
  SpeechWorkflowOptions,
  TimelineClip,
  Shot
} from '@/types'

const route = useRoute()
const router = useRouter()
const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()

const mode = ref<SpeechWorkflowMode>('digital-human')
const name = ref('')
const script = ref('')
const aspectRatio = ref<AspectRatio>('9:16')
const imageFile = ref<File | null>(null)
const audioFile = ref<File | null>(null)
const videoFiles = ref<File[]>([])
const referenceFiles = ref<File[]>([])
const imageUrl = ref('')
const audioUrl = ref('')
const videoUrls = ref<string[]>([])
const referenceUrls = ref<string[]>([])
const saving = ref(false)
const building = ref(false)
const generationController = ref<AbortController | null>(null)
const generatedPreviewUrls = ref<string[]>([])
const showWorkspace = ref(
  route.query.new !== '1' && project.current?.pipelineMode === 'smart-speech'
)

const options = ref<SpeechWorkflowOptions>({
  removePauses: true,
  removeStumbles: true,
  beauty: true,
  captions: true,
  titles: true,
  keywordCallouts: true,
  soundEffects: true,
  bgm: true,
  aigcInserts: false
})

const modes: Array<{
  id: SpeechWorkflowMode
  eyebrow: string
  title: string
  desc: string
  input: string
}> = [
  {
    id: 'digital-human',
    eyebrow: '图片 + 音频',
    title: '数字人口播',
    desc: '使用人物图锁定形象，用声音样本复刻音色，再让人物按文案开口说话。',
    input: '人物图片、声音样本、口播文案'
  },
  {
    id: 'human-edit',
    eyebrow: '真人原片',
    title: '真人智能精剪',
    desc: '自动识别停顿、卡顿和重复表达，完成美颜、字幕、标题与声音包装。',
    input: '一条或多条真人口播、文案'
  },
  {
    id: 'human-aigc',
    eyebrow: '真人 + AI 分镜',
    title: '真人 AIGC 混剪',
    desc: '以真人口播为主轨，在重点内容处插入 AI 分镜，提升节奏和可看性。',
    input: '真人口播、文案、可选参考图'
  }
]

const currentFlow = computed(() =>
  project.current?.pipelineMode === 'smart-speech' ? project.current.speechWorkflow : undefined
)

const completedVideoCount = computed(() => currentFlow.value?.generatedVideoAssetIds?.length || 0)
const totalDigitalSegments = computed(() =>
  currentFlow.value?.mode === 'digital-human' ? digitalSpeechSegments(project.current?.script?.content || '').length : 0
)

watch(
  () => (currentFlow.value?.generatedVideoAssetIds || []).join('|'),
  async () => {
    generatedPreviewUrls.value.forEach(revoke)
    generatedPreviewUrls.value = []
    const urls: string[] = []
    for (const id of currentFlow.value?.generatedVideoAssetIds || []) {
      const url = await assets.getUrl(id)
      if (url) urls.push(url)
    }
    generatedPreviewUrls.value = urls
  },
  { immediate: true }
)

const selectedMode = computed(() => modes.find((item) => item.id === mode.value)!)

const canCreate = computed(() => {
  if (!name.value.trim() || !script.value.trim()) return false
  if (mode.value === 'digital-human') return !!imageFile.value && !!audioFile.value
  return videoFiles.value.length > 0
})

const stageIndex = computed(() => {
  const stage = currentFlow.value?.stage
  if (stage === 'complete') return 4
  if (stage === 'quality-check') return 3
  if (stage === 'packaging') return 2
  if (stage === 'editing') return 1
  return 0
})

function revoke(url: string) {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

function replaceUrl(previous: string, file?: File) {
  revoke(previous)
  return file ? URL.createObjectURL(file) : ''
}

function pickImage(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || !file.type.startsWith('image/')) return
  imageFile.value = file
  imageUrl.value = replaceUrl(imageUrl.value, file)
}

function pickAudio(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file || (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac)$/i.test(file.name))) {
    toast.warn('请选择 MP3、WAV、M4A 或 AAC 音频')
    return
  }
  audioFile.value = file
  audioUrl.value = replaceUrl(audioUrl.value, file)
}

function pickVideos(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? []).filter(
    (file) => file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(file.name)
  )
  input.value = ''
  videoUrls.value.forEach(revoke)
  videoFiles.value = files.slice(0, 8)
  videoUrls.value = videoFiles.value.map((file) => URL.createObjectURL(file))
}

function pickReferences(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? []).filter((file) => file.type.startsWith('image/'))
  input.value = ''
  const room = Math.max(0, 8 - referenceFiles.value.length)
  const next = files.slice(0, room)
  referenceFiles.value = [...referenceFiles.value, ...next]
  referenceUrls.value = [...referenceUrls.value, ...next.map((file) => URL.createObjectURL(file))]
}

function removeReference(index: number) {
  revoke(referenceUrls.value[index])
  referenceFiles.value = referenceFiles.value.filter((_, i) => i !== index)
  referenceUrls.value = referenceUrls.value.filter((_, i) => i !== index)
}

function setMode(next: SpeechWorkflowMode) {
  mode.value = next
  options.value.aigcInserts = next === 'human-aigc'
  if (next === 'digital-human') options.value.beauty = false
  else options.value.beauty = true
}

function sizeForAspect(ar: AspectRatio) {
  if (ar === '16:9') return { width: 1920, height: 1080 }
  if (ar === '1:1') return { width: 1080, height: 1080 }
  return { width: 1080, height: 1920 }
}

async function saveFile(file: File, kind: 'image' | 'audio' | 'video', projectId: string) {
  return assets.add(file, kind, 'uploaded', { filename: file.name, projectId })
}

async function createSpeechProject() {
  if (!canCreate.value || saving.value) return
  saving.value = true
  let created = false
  try {
    const p = await project.createNamed(name.value.trim())
    created = true
    const now = Date.now()
    const size = sizeForAspect(aspectRatio.value)
    p.pipelineMode = 'smart-speech'
    p.script = {
      id: `s_${now.toString(36)}`,
      topic: name.value.trim(),
      content: script.value.trim(),
      keywords: [],
      style: 'photorealistic',
      aspectRatio: aspectRatio.value,
      shotDuration: 5,
      playReady: true,
      createdAt: now
    }
    p.settings = {
      ...p.settings,
      aspectRatio: aspectRatio.value,
      width: size.width,
      height: size.height,
      burnCaptions: options.value.captions,
      captionHighlight: options.value.captions && options.value.keywordCallouts,
      captionHighlightColor: '#ffd84d',
      captionHighlightScale: 1.2,
      bgmVolume: options.value.bgm ? p.settings.bgmVolume : 0,
      keepAmbientAudio: mode.value === 'digital-human' ? false : p.settings.keepAmbientAudio
    }

    let imageAssetId: string | undefined
    let audioAssetId: string | undefined
    const videoAssetIds: string[] = []
    const referenceAssetIds: string[] = []

    if (imageFile.value) imageAssetId = (await saveFile(imageFile.value, 'image', p.id)).id
    if (audioFile.value) audioAssetId = (await saveFile(audioFile.value, 'audio', p.id)).id
    for (const file of videoFiles.value) {
      videoAssetIds.push((await saveFile(file, 'video', p.id)).id)
    }
    for (const file of referenceFiles.value) {
      referenceAssetIds.push((await saveFile(file, 'image', p.id)).id)
    }

    p.speechWorkflow = {
      mode: mode.value,
      stage: 'ready',
      imageAssetId,
      voiceSampleAssetId: audioAssetId,
      videoAssetIds,
      referenceAssetIds,
      options: { ...options.value },
      progress: mode.value === 'digital-human'
        ? '人物形象与声音样本已入库，等待克隆音色并生成口播视频'
        : '素材与文案已入库，等待生成基础工程',
      createdAt: now,
      updatedAt: now
    }
    project.setScript(p.script)
    project.setSettings(p.settings)
    await project.save()
    showWorkspace.value = true
    toast.success('智能口播项目已创建')
  } catch (error: any) {
    toast.error(error?.message || '智能口播项目创建失败')
    if (created) showWorkspace.value = true
  } finally {
    saving.value = false
  }
}

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const rest = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rest).padStart(3, '0')}`
}

function captionPhrases(text: string) {
  const sentences = text
    .replace(/\s+/g, '')
    .split(/(?<=[，。！？；：])/)
    .map((part) => part.trim())
    .filter(Boolean)
  const phrases: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= 22) phrases.push(sentence)
    else {
      for (let i = 0; i < sentence.length; i += 18) phrases.push(sentence.slice(i, i + 18))
    }
  }
  return phrases.length ? phrases : [text.trim()]
}

function approximateSrt(text: string, duration: number) {
  const phrases = captionPhrases(text)
  const weights = phrases.map((item) => Math.max(1, item.replace(/[，。！？；：]/g, '').length))
  const total = weights.reduce((sum, item) => sum + item, 0)
  let cursor = 0
  return phrases
    .map((phrase, index) => {
      const partDuration = index === phrases.length - 1 ? duration - cursor : duration * (weights[index] / total)
      const end = Math.min(duration, cursor + Math.max(0.6, partDuration))
      const cue = `${index + 1}\n${srtTime(cursor)} --> ${srtTime(end)}\n${phrase}`
      cursor = end
      return cue
    })
    .join('\n\n')
}

async function buildBaseline() {
  const p = project.current
  const flow = currentFlow.value
  if (!p || !flow || building.value) return
  building.value = true
  generationController.value = new AbortController()
  try {
    const digital = flow.mode === 'digital-human'
    if (digital) {
      await buildDigitalHumanVideo(p, flow, generationController.value.signal)
      return
    }
    const primaryId = digital ? flow.imageAssetId : flow.videoAssetIds[0]
    if (!primaryId) throw new Error('找不到主素材，请重新创建项目')
    const primary = assets.getMeta(primaryId)
    const audio = flow.audioAssetId ? assets.getMeta(flow.audioAssetId) : undefined
    const duration = Math.max(
      1,
      digital && audio?.kind === 'audio'
        ? audio.duration || 8
        : primary?.kind === 'video'
          ? primary.duration || 8
          : 8
    )
    const shotId = `speech_${Date.now().toString(36)}`
    const shot: Shot = {
      id: shotId,
      index: 0,
      title: digital ? '数字人口播主镜头' : '真人口播主镜头',
      visualPrompt: digital
        ? '保持上传人物形象、机位和背景稳定，人物自然面向镜头口播。'
        : '保留真人原片，后续根据逐字识别结果完成卡顿和气口清理。',
      audioDescription: '清晰人声，背景音乐不盖过口播。',
      voiceover: p.script?.content || '',
      audioMode: digital ? 'tts' : 'none',
      duration,
      cameraMovement: 'static',
      imageAssetId: digital ? primaryId : undefined,
      videoAssetId: digital ? undefined : primaryId,
      audioAssetId: digital ? flow.audioAssetId : undefined,
      referenceAssetIds: flow.referenceAssetIds,
      status: digital ? 'image-generated' : 'video-generated'
    }
    const clip: TimelineClip = {
      id: `clip_${Date.now().toString(36)}`,
      shotId,
      startTime: 0,
      duration,
      sourceIn: 0,
      transitionIn: 'none',
      transitionDuration: 0,
      speed: 1,
      volume: 1,
      enabled: true
    }
    project.setShots([shot])
    project.setTimeline([clip])
    if (flow.options.captions && p.script?.content) {
      project.setCaptionSrt(approximateSrt(p.script.content, duration))
    }
    p.speechWorkflow = {
      ...flow,
      stage: 'editing',
      progress: digital
        ? '基础图像口播工程已生成；接入数字人 Provider 后可替换动态主镜头。'
        : '真人主轨已生成；接入 ASR / VAD 后可写入精剪区间。',
      updatedAt: Date.now()
    }
    await project.save()
    toast.success('可编辑基础工程已生成')
  } catch (error: any) {
    const cancelled = generationController.value?.signal.aborted
    const remoteTaskFinishedWithoutVideo = /生成失败|任务完成但没有视频|任务已过期|status.*failed/i.test(
      error?.message || ''
    )
    if (p.speechWorkflow) {
      p.speechWorkflow = {
        ...p.speechWorkflow,
        stage: cancelled ? 'ready' : 'failed',
        progress: cancelled
          ? `已暂停，完成的 ${p.speechWorkflow.generatedVideoAssetIds?.length || 0} 段已保存，下次从断点继续。`
          : p.speechWorkflow.progress,
        activeVideoTaskId: remoteTaskFinishedWithoutVideo ? undefined : p.speechWorkflow.activeVideoTaskId,
        activeVideoTaskSegmentIndex: remoteTaskFinishedWithoutVideo
          ? undefined
          : p.speechWorkflow.activeVideoTaskSegmentIndex,
        error: cancelled ? undefined : error?.message || String(error),
        updatedAt: Date.now()
      }
      await project.save().catch(() => undefined)
    }
    if (cancelled) toast.info('生成已暂停，已完成片段不会丢失')
    else toast.error(error?.message || '基础工程生成失败')
  } finally {
    building.value = false
    generationController.value = null
  }
}

function cancelGeneration() {
  generationController.value?.abort()
}

function digitalSpeechSegments(text: string): string[] {
  const units = text
    .replace(/\s+/g, '')
    .split(/(?<=[。！？；])/)
    .map((part) => part.trim())
    .filter(Boolean)
  const output: string[] = []
  for (const unit of units.length ? units : [text.trim()]) {
    if (unit.length <= 30) {
      output.push(unit)
      continue
    }
    const clauses = unit.split(/(?<=[，、：])/).filter(Boolean)
    let current = ''
    for (const clause of clauses) {
      if (current && current.length + clause.length > 30) {
        output.push(current)
        current = ''
      }
      if (clause.length <= 30) current += clause
      else {
        if (current) output.push(current)
        current = ''
        for (let i = 0; i < clause.length; i += 28) output.push(clause.slice(i, i + 28))
      }
    }
    if (current) output.push(current)
  }
  return output.filter(Boolean)
}

async function updateFlowProgress(message: string) {
  const p = project.current
  if (!p?.speechWorkflow) return
  p.speechWorkflow = { ...p.speechWorkflow, progress: message, updatedAt: Date.now() }
  await project.save()
}

async function buildDigitalHumanVideo(
  p: NonNullable<typeof project.current>,
  flow: NonNullable<typeof currentFlow.value>,
  signal: AbortSignal
) {
  const imageId = flow.imageAssetId
  const sampleId = flow.voiceSampleAssetId || flow.audioAssetId
  if (!imageId || !sampleId) throw new Error('缺少人物图片或声音样本，请重新创建项目')
  const imageBlob = await assets.getBlob(imageId)
  const sampleBlob = await assets.getBlob(sampleId)
  if (!imageBlob || !sampleBlob) throw new Error('人物图片或声音样本读取失败')
  const sampleMeta = assets.getMeta(sampleId)
  const sampleDuration = sampleMeta?.kind === 'audio' ? sampleMeta.duration || 0 : 0
  if (sampleDuration > 0 && sampleDuration < 5) {
    throw new Error('声音样本至少需要 5 秒连续清晰人声，推荐 10–20 秒')
  }

  await updateFlowProgress('正在分析声音样本并创建克隆音色…')
  const cloned = flow.clonedVoiceId
    ? { voiceId: flow.clonedVoiceId, model: flow.clonedVoiceModel || 'qwen3-tts-vc-2026-01-22' }
    : await cloneVoiceFromSample(sampleBlob, `aicut${p.id.replace(/[^a-z0-9]/gi, '').slice(-8)}`, signal)
  if (!p.speechWorkflow) throw new Error('口播流程状态丢失')
  p.speechWorkflow = {
    ...p.speechWorkflow,
    clonedVoiceId: cloned.voiceId,
    clonedVoiceModel: cloned.model,
    progress: '克隆音色已创建，开始按文案生成语音和人物视频…',
    updatedAt: Date.now()
  }
  await project.save()

  const parts = digitalSpeechSegments(p.script?.content || '')
  if (!parts.length) throw new Error('没有可生成的口播文案')
  const shots: Shot[] = []
  const timeline: TimelineClip[] = []
  const videoIds: string[] = []
  const speechIds: string[] = []
  let cursor = 0

  // 兼容已经生成过一部分的旧任务：数组顺序与文案分段顺序一致。
  // 只有视频、语音两个资产都仍然存在时才算完成，绝不重复消耗生成算力。
  const existingVideos = flow.generatedVideoAssetIds || []
  const existingSpeech = flow.generatedSpeechAssetIds || []
  const reusableCount = Math.min(parts.length, existingVideos.length, existingSpeech.length)
  for (let index = 0; index < reusableCount; index++) {
    const videoAsset = assets.getMeta(existingVideos[index])
    const speechAsset = assets.getMeta(existingSpeech[index])
    if (videoAsset?.kind !== 'video' || speechAsset?.kind !== 'audio') break
    const duration = Math.min(
      Math.max(0.1, speechAsset.duration || parts[index].length / 4.2),
      Math.max(0.1, videoAsset.duration || 15)
    )
    const shotId = videoAsset.shotId || speechAsset.shotId || `speech_resume_${index}`
    videoIds.push(videoAsset.id)
    speechIds.push(speechAsset.id)
    shots.push(makeDigitalShot(index, shotId, parts[index], duration, imageId, videoAsset.id, speechAsset.id))
    timeline.push(makeDigitalClip(index, shotId, cursor, duration))
    cursor += duration
  }

  if (videoIds.length) {
    project.setShots(shots)
    project.setTimeline(timeline)
    if (flow.options.captions) project.setCaptionSrt(approximateSrt(parts.slice(0, videoIds.length).join(''), cursor))
    await updateFlowProgress(`已恢复 ${videoIds.length}/${parts.length} 段，继续生成剩余内容…`)
  }

  const resumeStartIndex = videoIds.length
  for (let index = resumeStartIndex; index < parts.length; index++) {
    if (signal.aborted) throw new DOMException('生成已取消', 'AbortError')
    const text = parts[index]
    const shotId = `speech_${Date.now().toString(36)}_${index}`
    let speechBlob: Blob
    let speechAssetId: string
    let speechDuration: number
    const pendingSpeechId =
      p.speechWorkflow?.pendingSegmentIndex === index
        ? p.speechWorkflow.pendingSpeechAssetId
        : undefined
    const pendingSpeechMeta = pendingSpeechId ? assets.getMeta(pendingSpeechId) : undefined
    const pendingSpeechBlob = pendingSpeechId ? await assets.getBlob(pendingSpeechId) : undefined
    if (pendingSpeechMeta?.kind === 'audio' && pendingSpeechBlob) {
      speechBlob = pendingSpeechBlob
      speechAssetId = pendingSpeechMeta.id
      speechDuration = Math.max(2, pendingSpeechMeta.duration || text.length / 4.2)
      await updateFlowProgress(`已恢复第 ${index + 1}/${parts.length} 段克隆语音，不重复合成…`)
    } else {
      await updateFlowProgress(`正在生成第 ${index + 1}/${parts.length} 段克隆语音…`)
      speechBlob = await synthesizeClonedSpeech(text, cloned.voiceId, cloned.model, signal)
      const speechAsset = await assets.add(speechBlob, 'audio', 'ai-generated', {
        filename: `克隆口播_${String(index + 1).padStart(2, '0')}.mp3`, projectId: p.id, shotId
      })
      speechAssetId = speechAsset.id
      speechDuration = Math.max(
        2,
        (speechAsset.kind === 'audio' ? speechAsset.duration : 0) || text.length / 4.2
      )
      p.speechWorkflow = {
        ...p.speechWorkflow!,
        pendingSegmentIndex: index,
        pendingSpeechAssetId: speechAsset.id,
        updatedAt: Date.now()
      }
      await project.save()
    }
    if (speechDuration > 15) {
      throw new Error(`第 ${index + 1} 段克隆语音为 ${speechDuration.toFixed(1)} 秒，超过 H3 单镜 15 秒限制，请把该句拆短后重试`)
    }

    await updateFlowProgress(`正在生成第 ${index + 1}/${parts.length} 段人物开口视频…`)
    const legacyTaskId =
      index === resumeStartIndex
        ? String(flow.error || '').match(/task_id=([^\s]+)/i)?.[1]?.trim()
        : undefined
    const resumeTaskId =
      p.speechWorkflow?.activeVideoTaskSegmentIndex === index
        ? p.speechWorkflow.activeVideoTaskId
        : legacyTaskId
    if (legacyTaskId && !p.speechWorkflow?.activeVideoTaskId) {
      p.speechWorkflow = {
        ...p.speechWorkflow!,
        activeVideoTaskId: legacyTaskId,
        activeVideoTaskSegmentIndex: index,
        error: undefined,
        progress: `已从旧任务恢复第 ${index + 1}/${parts.length} 段 (${legacyTaskId})，不会重复提交…`,
        updatedAt: Date.now()
      }
      await project.save()
    }
    const generated = await generateVideo(
      {
        imageBlob,
        prompt: '人物保持与参考图完全一致，正面看向镜头，自然眨眼和轻微点头，嘴型连续清晰地配合口播，不改变背景，不出现字幕或额外人物。',
        voiceover: text,
        voiceMode: 'dialogue',
        speakerHint: '自然、可信、有亲和力的中文营销口播，语速稳定，吐字清晰',
        speakerName: '画面中的人物',
        duration: Math.min(15, Math.max(3, Math.ceil(speechDuration + 0.4))),
        width: p.settings.width,
        height: p.settings.height,
        aspectRatio: p.settings.aspectRatio,
        cameraMovement: 'static',
        signal,
        resumeTaskId,
        onTaskSubmitted: async (taskId) => {
          p.speechWorkflow = {
            ...p.speechWorkflow!,
            activeVideoTaskId: taskId,
            activeVideoTaskSegmentIndex: index,
            progress: `第 ${index + 1}/${parts.length} 段任务已提交 (${taskId})，正在等待结果…`,
            updatedAt: Date.now()
          }
          await project.save()
        }
      },
      (message) => void updateFlowProgress(`第 ${index + 1}/${parts.length} 段：${message}`)
    )
    await updateFlowProgress(`正在封装第 ${index + 1}/${parts.length} 段克隆声音视频…`)
    const talkingVideo = await replaceVideoAudio(generated.blob, speechBlob, (message) =>
      void updateFlowProgress(`第 ${index + 1}/${parts.length} 段：${message}`)
    )
    const videoAsset = await assets.add(talkingVideo, 'video', 'ai-generated', {
      filename: `数字人口播_${String(index + 1).padStart(2, '0')}.mp4`,
      prompt: generated.prompt,
      projectId: p.id,
      shotId
    })
    videoIds.push(videoAsset.id)
    speechIds.push(speechAssetId)
    const duration = Math.min(
      speechDuration,
      (videoAsset.kind === 'video' ? videoAsset.duration : 0) || generated.duration
    )
    shots.push(makeDigitalShot(index, shotId, text, duration, imageId, videoAsset.id, speechAssetId, generated.prompt))
    timeline.push(makeDigitalClip(index, shotId, cursor, duration))
    cursor += duration
    p.speechWorkflow = {
      ...p.speechWorkflow!,
      generatedVideoAssetIds: [...videoIds],
      generatedSpeechAssetIds: [...speechIds],
      pendingSegmentIndex: undefined,
      pendingSpeechAssetId: undefined,
      activeVideoTaskId: undefined,
      activeVideoTaskSegmentIndex: undefined,
      updatedAt: Date.now()
    }
    project.setShots([...shots])
    project.setTimeline([...timeline])
    if (flow.options.captions) project.setCaptionSrt(approximateSrt(parts.slice(0, videoIds.length).join(''), cursor))
    await project.save()
  }

  project.setShots(shots)
  project.setTimeline(timeline)
  if (flow.options.captions) project.setCaptionSrt(approximateSrt(p.script?.content || '', cursor))
  p.speechWorkflow = {
    ...p.speechWorkflow!,
    stage: 'editing',
    generatedVideoAssetIds: videoIds,
    generatedSpeechAssetIds: speechIds,
    progress: `数字人口播已生成：${parts.length} 段动态视频，已使用克隆音色并写入剪辑时间线。`,
    error: undefined,
    updatedAt: Date.now()
  }
  await project.save()
  toast.success('数字人口播视频已生成')
}

function makeDigitalShot(
  index: number,
  shotId: string,
  text: string,
  duration: number,
  imageId: string,
  videoId: string,
  speechId: string,
  videoPrompt?: string
): Shot {
  return {
    id: shotId,
    index,
    title: `数字人口播 ${index + 1}`,
    visualPrompt: '保持人物身份、服装、背景和机位稳定，自然面向镜头口播。',
    videoPrompt,
    audioDescription: '使用上传声音样本复刻的清晰人声。',
    voiceover: text,
    audioMode: 'tts',
    duration,
    cameraMovement: 'static',
    imageAssetId: imageId,
    videoAssetId: videoId,
    audioAssetId: speechId,
    status: 'video-generated'
  }
}

function makeDigitalClip(index: number, shotId: string, startTime: number, duration: number): TimelineClip {
  return {
    id: `clip_${shotId}`,
    shotId,
    startTime,
    duration,
    sourceIn: 0,
    transitionIn: index ? 'fade' : 'none',
    transitionDuration: index ? 0.18 : 0,
    speed: 1,
    volume: 0,
    enabled: true
  }
}

function startNew() {
  showWorkspace.value = false
  router.replace({ name: 'smart-speech', query: { new: '1' } })
}

onBeforeUnmount(() => {
  revoke(imageUrl.value)
  revoke(audioUrl.value)
  videoUrls.value.forEach(revoke)
  referenceUrls.value.forEach(revoke)
  generatedPreviewUrls.value.forEach(revoke)
})
</script>

<template>
  <main class="speech-page">
    <header class="topbar">
      <button class="back" type="button" @click="router.push('/')">← 返回首页</button>
      <div class="brand-block">
        <span class="brand-dot" />
        <div>
          <strong>智能口播</strong>
          <small>Speech Automation Studio</small>
        </div>
      </div>
      <button v-if="showWorkspace" class="new-task" type="button" @click="startNew">新建口播项目</button>
      <span v-else class="top-note">自动剪辑 · 字幕 · 包装 · AIGC</span>
    </header>

    <div v-if="!showWorkspace" class="setup-shell">
      <section class="intro">
        <span class="kicker">一条专为营销口播设计的生产线</span>
        <h1>选择素材类型，开始自动成片</h1>
        <p>素材、文案和包装偏好一次提交。项目会保留每一步的中间产物，方便人工复核和局部重做。</p>
      </section>

      <section class="mode-grid" aria-label="口播类型">
        <button
          v-for="item in modes"
          :key="item.id"
          type="button"
          class="mode-card"
          :class="{ active: mode === item.id }"
          @click="setMode(item.id)"
        >
          <span class="mode-check">{{ mode === item.id ? '✓' : '' }}</span>
          <small>{{ item.eyebrow }}</small>
          <strong>{{ item.title }}</strong>
          <p>{{ item.desc }}</p>
          <em>{{ item.input }}</em>
        </button>
      </section>

      <div class="form-grid">
        <GlassCard padding="lg" class="input-card">
          <div class="section-title">
            <span>01</span>
            <div>
              <h2>项目与口播文案</h2>
              <p>文案将用于校对语音、拆语义段落和生成字幕包装。</p>
            </div>
          </div>
          <label class="field">
            <span>项目名称</span>
            <input v-model="name" maxlength="48" placeholder="例如：0625 泰安招商口播" />
          </label>
          <label class="field">
            <span>口播文案</span>
            <textarea v-model="script" rows="10" placeholder="粘贴完整口播文案…" />
            <small>{{ script.replace(/\s/g, '').length }} 字</small>
          </label>
          <div class="field">
            <span>成片比例</span>
            <div class="ratio-row">
              <button type="button" :class="{ on: aspectRatio === '9:16' }" @click="aspectRatio = '9:16'">9:16 竖版</button>
              <button type="button" :class="{ on: aspectRatio === '16:9' }" @click="aspectRatio = '16:9'">16:9 横版</button>
              <button type="button" :class="{ on: aspectRatio === '1:1' }" @click="aspectRatio = '1:1'">1:1 方形</button>
            </div>
          </div>
        </GlassCard>

        <div class="right-stack">
          <GlassCard padding="lg" class="input-card">
            <div class="section-title">
              <span>02</span>
              <div>
                <h2>{{ selectedMode.title }}素材</h2>
                <p>{{ selectedMode.input }}</p>
              </div>
            </div>

            <template v-if="mode === 'digital-human'">
              <div class="upload-grid two">
                <label class="upload-box" :class="{ filled: imageFile }">
                  <img v-if="imageUrl" :src="imageUrl" alt="人物预览" />
                  <template v-else>
                    <strong>上传人物图片</strong>
                    <span>正脸、清晰、上半身效果最佳</span>
                  </template>
                  <input type="file" accept="image/*" hidden @change="pickImage" />
                </label>
                <label class="upload-box" :class="{ filled: audioFile }">
                  <template v-if="audioFile">
                    <strong>{{ audioFile.name }}</strong>
                    <audio class="audio-preview" :src="audioUrl" controls @click.stop />
                  </template>
                  <template v-else>
                    <strong>上传声音样本</strong>
                    <span>仅用于克隆音色，推荐 10–20 秒清晰人声</span>
                  </template>
                  <input type="file" accept="audio/*,.mp3,.wav,.m4a,.aac" hidden @change="pickAudio" />
                </label>
              </div>
            </template>

            <template v-else>
              <label class="upload-box wide" :class="{ filled: videoFiles.length }">
                <template v-if="videoFiles.length">
                  <strong>已选择 {{ videoFiles.length }} 条口播视频</strong>
                  <span>{{ videoFiles.map((file) => file.name).join('、') }}</span>
                </template>
                <template v-else>
                  <strong>上传真人口播原片</strong>
                  <span>支持多 take，系统将按文案顺序选择最佳片段</span>
                </template>
                <input type="file" accept="video/*,.mp4,.mov,.webm,.mkv" multiple hidden @change="pickVideos" />
              </label>
              <div v-if="videoUrls.length" class="video-strip">
                <video v-for="url in videoUrls" :key="url" :src="url" muted controls />
              </div>

              <template v-if="mode === 'human-aigc'">
                <label class="upload-box wide compact">
                  <strong>添加 AIGC 参考图（可选）</strong>
                  <span>产品、人物、活动 KV 或场景参考，最多 8 张</span>
                  <input type="file" accept="image/*" multiple hidden @change="pickReferences" />
                </label>
                <div v-if="referenceUrls.length" class="reference-strip">
                  <button v-for="(url, index) in referenceUrls" :key="url" type="button" @click="removeReference(index)">
                    <img :src="url" alt="参考图" />
                    <span>×</span>
                  </button>
                </div>
              </template>
            </template>
          </GlassCard>

          <GlassCard padding="lg" class="input-card">
            <div class="section-title compact-title">
              <span>03</span>
              <div>
                <h2>自动处理项目</h2>
                <p>可在生成基础工程后逐项调整。</p>
              </div>
            </div>
            <div class="option-grid">
              <label v-if="mode !== 'digital-human'"><input v-model="options.removePauses" type="checkbox" /> 去除气口长停顿</label>
              <label v-if="mode !== 'digital-human'"><input v-model="options.removeStumbles" type="checkbox" /> 去除卡顿与重复</label>
              <label v-if="mode !== 'digital-human'"><input v-model="options.beauty" type="checkbox" /> 轻量美颜与肤色</label>
              <label><input v-model="options.captions" type="checkbox" /> 口播字幕</label>
              <label><input v-model="options.titles" type="checkbox" /> 标题与信息条</label>
              <label><input v-model="options.keywordCallouts" type="checkbox" /> 关键词花字</label>
              <label><input v-model="options.soundEffects" type="checkbox" /> 转场与提示音效</label>
              <label><input v-model="options.bgm" type="checkbox" /> BGM 与人声闪避</label>
              <label v-if="mode === 'human-aigc'"><input v-model="options.aigcInserts" type="checkbox" /> 自动插入 AI 分镜</label>
            </div>
          </GlassCard>
        </div>
      </div>

      <footer class="create-bar">
        <div>
          <strong>{{ selectedMode.title }}</strong>
          <span v-if="!canCreate">请补齐项目名、文案和必需素材</span>
          <span v-else>素材完整，可以创建口播项目</span>
        </div>
        <GradientButton size="lg" :loading="saving" :disabled="!canCreate" @click="createSpeechProject">
          创建并进入工作台
        </GradientButton>
      </footer>
    </div>

    <div v-else class="workspace-shell">
      <section class="workspace-head">
        <div>
          <span class="kicker">智能口播工作台</span>
          <h1>{{ project.current?.name }}</h1>
          <p>{{ currentFlow?.progress || '素材已经入库，等待处理。' }}</p>
        </div>
        <div class="workspace-actions">
          <GradientButton type="ghost" @click="router.push('/caption')">字幕包装</GradientButton>
          <GradientButton type="ghost" @click="router.push('/export')">导出成片</GradientButton>
          <GradientButton @click="router.push('/edit')">打开剪辑台</GradientButton>
        </div>
      </section>

      <section class="stage-line">
        <div v-for="(item, index) in ['素材入库', '语音与精剪', '视觉包装', '质检导出']" :key="item" :class="{ done: stageIndex > index, active: stageIndex === index }">
          <span>{{ stageIndex > index ? '✓' : index + 1 }}</span>
          <strong>{{ item }}</strong>
        </div>
      </section>

      <div class="workspace-grid">
        <GlassCard padding="lg" class="work-main">
          <div class="work-title">
            <div>
              <span>当前任务</span>
              <h2>
                {{ currentFlow?.stage === 'editing'
                  ? '数字人口播视频已经就绪'
                  : completedVideoCount
                    ? `已完成 ${completedVideoCount}/${totalDigitalSegments} 段`
                    : '生成可编辑数字人口播视频' }}
              </h2>
            </div>
            <span class="status-pill">
              {{ building ? '生成中' : currentFlow?.stage === 'editing' ? '可编辑' : completedVideoCount ? '可续跑' : '待生成' }}
            </span>
          </div>
          <p class="work-desc">
            <template v-if="currentFlow?.mode === 'digital-human'">
              系统会先从样本音频复刻音色，再按文案分段合成语音，并用人物图逐段生成真实的开口视频。生成结果会自动拼入时间线，原始声音样本不会被当作成片音轨。
            </template>
            <template v-else>
              当前会保留真人原片与原声，生成主时间线和近似字幕。ASR / VAD 接入后，卡顿、气口与多 take 选择会自动写回精剪区间。
            </template>
          </p>
          <div class="deliverable-list">
            <div><span>主素材</span><strong>{{ currentFlow?.mode === 'digital-human' ? '人物图片 + 克隆声音样本' : `${currentFlow?.videoAssetIds.length || 0} 条真人视频` }}</strong></div>
            <div><span>字幕</span><strong>{{ currentFlow?.options.captions ? '自动生成初稿' : '关闭' }}</strong></div>
            <div><span>包装</span><strong>{{ currentFlow?.options.titles ? '标题 / 花字 / CTA 待编排' : '简洁模式' }}</strong></div>
            <div><span>AIGC</span><strong>{{ currentFlow?.options.aigcInserts ? '启用智能插入' : '不插入' }}</strong></div>
          </div>
          <section v-if="currentFlow?.mode === 'digital-human' && generatedPreviewUrls.length" class="generated-section">
            <div class="generated-head">
              <div>
                <strong>已生成视频</strong>
                <span>每完成一段立即保存，可播放、可进入剪辑台查看</span>
              </div>
              <em>{{ generatedPreviewUrls.length }} / {{ totalDigitalSegments }}</em>
            </div>
            <div class="generated-strip">
              <article v-for="(url, index) in generatedPreviewUrls" :key="url">
                <video :src="url" controls preload="metadata" />
                <span>第 {{ index + 1 }} 段 · 已保存</span>
              </article>
            </div>
          </section>
          <div class="work-cta">
            <GradientButton v-if="building" type="ghost" size="lg" @click="cancelGeneration">
              暂停生成并保留进度
            </GradientButton>
            <GradientButton v-else-if="currentFlow?.stage !== 'editing'" size="lg" @click="buildBaseline">
              {{ currentFlow?.mode === 'digital-human'
                ? completedVideoCount
                  ? `继续生成剩余 ${Math.max(0, totalDigitalSegments - completedVideoCount)} 段`
                  : '克隆声音并生成口播视频'
                : '生成可编辑基础工程' }}
            </GradientButton>
            <GradientButton v-else size="lg" @click="router.push('/edit')">进入剪辑台检查</GradientButton>
            <span>{{ completedVideoCount ? '已完成段不会重复提交或覆盖' : '不会覆盖原始上传素材' }}</span>
          </div>
        </GlassCard>

        <aside class="capability-panel">
          <h2>自动化能力状态</h2>
          <div class="capability ready"><span />素材入库与项目持久化<strong>已就绪</strong></div>
          <div class="capability ready"><span />基础时间线与字幕初稿<strong>已就绪</strong></div>
          <div class="capability"><span />ASR / VAD 卡顿气口清理<strong>待接入</strong></div>
          <template v-if="currentFlow?.mode === 'digital-human'">
            <div class="capability ready"><span />声音样本复刻与文案配音<strong>已接入</strong></div>
            <div class="capability ready"><span />人物图动态口播视频生成<strong>已接入</strong></div>
            <div class="capability"><span />音频波形级唇形重定向质检<strong>待增强</strong></div>
          </template>
          <div v-else class="capability"><span />人脸跟踪与轻量美颜<strong>待接入</strong></div>
          <div class="capability"><span />标题花字与品牌模板编排<strong>待接入</strong></div>
          <div v-if="currentFlow?.mode === 'human-aigc'" class="capability"><span />AIGC 插入点与覆盖轨<strong>待接入</strong></div>
          <div class="capability"><span />自动质检与失败回退<strong>待接入</strong></div>
        </aside>
      </div>
    </div>
  </main>
</template>

<style scoped>
.speech-page {
  height: 100%;
  overflow: auto;
  color: var(--color-text-1);
  background: var(--color-bg-0);
}
.topbar {
  height: 68px;
  padding: 0 32px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-1);
  position: sticky;
  top: 0;
  z-index: 20;
}
.back, .new-task {
  width: fit-content;
  color: var(--color-text-2);
  font-size: 13px;
  background: transparent;
}
.back:hover, .new-task:hover { color: var(--color-text-1); }
.new-task { justify-self: end; }
.brand-block { display: flex; gap: 10px; align-items: center; }
.brand-block strong { display: block; font-size: 15px; }
.brand-block small { display: block; color: var(--color-text-3); font-size: 10px; letter-spacing: .12em; margin-top: 2px; }
.brand-dot { width: 10px; height: 24px; border-radius: 8px; background: var(--color-accent); }
.top-note { justify-self: end; color: var(--color-text-3); font-size: 12px; }
.setup-shell, .workspace-shell { max-width: 1240px; margin: 0 auto; padding: 54px 32px 80px; }
.intro { max-width: 720px; margin-bottom: 30px; }
.kicker { display: block; color: var(--color-accent); font-weight: 650; font-size: 12px; letter-spacing: .08em; margin-bottom: 10px; }
.intro h1, .workspace-head h1 { font-size: 32px; line-height: 1.2; margin: 0 0 12px; letter-spacing: -.03em; }
.intro p, .workspace-head p { color: var(--color-text-2); line-height: 1.7; margin: 0; }
.mode-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 22px; }
.mode-card {
  position: relative;
  min-height: 205px;
  padding: 24px;
  text-align: left;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-card);
  color: var(--color-text-1);
  transition: .18s ease;
}
.mode-card:hover { transform: translateY(-2px); border-color: var(--color-border-strong); }
.mode-card.active { border-color: var(--color-accent); background: var(--color-fill); }
.mode-card small { color: var(--color-accent); font-size: 11px; font-weight: 700; }
.mode-card strong { display: block; font-size: 19px; margin: 12px 0 8px; }
.mode-card p { color: var(--color-text-2); font-size: 13px; line-height: 1.6; margin: 0 0 18px; }
.mode-card em { color: var(--color-text-3); font-size: 11px; font-style: normal; }
.mode-check { position: absolute; right: 18px; top: 18px; width: 22px; height: 22px; border: 1px solid var(--color-border-strong); border-radius: 50%; display: grid; place-items: center; color: white; font-size: 12px; }
.mode-card.active .mode-check { background: var(--color-accent); border-color: var(--color-accent); }
.form-grid { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 18px; align-items: start; }
.right-stack { display: grid; gap: 18px; }
.input-card { overflow: visible; }
.section-title { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 22px; }
.section-title > span { color: var(--color-accent); font: 700 11px/1 monospace; padding-top: 5px; }
.section-title h2, .work-title h2, .capability-panel h2 { font-size: 16px; margin: 0 0 5px; }
.section-title p { color: var(--color-text-3); font-size: 12px; margin: 0; }
.compact-title { margin-bottom: 14px; }
.field { display: block; position: relative; margin-bottom: 18px; }
.field > span { display: block; font-size: 12px; font-weight: 650; margin-bottom: 8px; }
.field input, .field textarea { width: 100%; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-1); color: var(--color-text-1); padding: 11px 12px; resize: vertical; }
.field input:focus, .field textarea:focus { border-color: var(--color-accent); outline: none; }
.field > small { position: absolute; right: 9px; bottom: 8px; color: var(--color-text-3); font-size: 10px; }
.ratio-row { display: flex; gap: 8px; }
.ratio-row button { flex: 1; padding: 9px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-1); color: var(--color-text-2); font-size: 12px; }
.ratio-row button.on { border-color: var(--color-accent); color: var(--color-text-1); background: var(--color-fill); }
.upload-grid.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.upload-box { min-height: 164px; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-md); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; cursor: pointer; overflow: hidden; background: var(--color-bg-1); text-align: center; padding: 14px; }
.upload-box:hover { border-color: var(--color-accent); }
.upload-box img { width: 100%; height: 150px; object-fit: cover; border-radius: var(--radius-sm); }
.upload-box strong { font-size: 13px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.upload-box span { color: var(--color-text-3); font-size: 11px; line-height: 1.5; }
.upload-box.wide { min-height: 116px; }
.upload-box.compact { min-height: 82px; margin-top: 12px; }
.audio-preview { width: 100%; height: 36px; }
.video-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
.video-strip video { width: 100%; height: 92px; background: #000; border-radius: var(--radius-sm); object-fit: cover; }
.reference-strip { display: flex; gap: 8px; margin-top: 10px; overflow-x: auto; }
.reference-strip button { position: relative; width: 72px; height: 72px; flex: 0 0 auto; background: transparent; }
.reference-strip img { width: 100%; height: 100%; object-fit: cover; border-radius: var(--radius-sm); }
.reference-strip span { position: absolute; right: 3px; top: 3px; width: 18px; height: 18px; border-radius: 50%; background: rgba(0,0,0,.72); color: #fff; display: grid; place-items: center; }
.option-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
.option-grid label { display: flex; gap: 8px; align-items: center; color: var(--color-text-2); font-size: 12px; }
.option-grid input { accent-color: var(--color-accent); }
.create-bar { position: sticky; bottom: 16px; margin-top: 20px; padding: 16px 18px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--color-border-strong); border-radius: var(--radius-lg); background: var(--color-bg-1); box-shadow: var(--shadow-lg); }
.create-bar strong { display: block; font-size: 13px; }
.create-bar span { display: block; color: var(--color-text-3); font-size: 11px; margin-top: 3px; }
.workspace-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 34px; }
.workspace-actions { display: flex; gap: 8px; }
.stage-line { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; margin-bottom: 20px; }
.stage-line > div { display: flex; align-items: center; gap: 9px; padding: 14px 16px; background: var(--color-bg-card); border: 1px solid var(--color-border); }
.stage-line > div:first-child { border-radius: var(--radius-md) 0 0 var(--radius-md); }
.stage-line > div:last-child { border-radius: 0 var(--radius-md) var(--radius-md) 0; }
.stage-line span { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--color-border-strong); display: grid; place-items: center; color: var(--color-text-3); font-size: 10px; }
.stage-line strong { font-size: 12px; color: var(--color-text-3); }
.stage-line .active { border-color: var(--color-accent); }
.stage-line .active span, .stage-line .done span { background: var(--color-accent); border-color: var(--color-accent); color: white; }
.stage-line .active strong, .stage-line .done strong { color: var(--color-text-1); }
.workspace-grid { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 18px; align-items: start; }
.work-main { min-height: 420px; }
.work-title { display: flex; justify-content: space-between; align-items: flex-start; }
.work-title > div > span { color: var(--color-text-3); font-size: 11px; }
.work-title h2 { margin-top: 5px; font-size: 22px; }
.status-pill { padding: 5px 9px; border-radius: 999px; color: var(--color-accent); background: var(--color-fill); font-size: 10px; }
.work-desc { color: var(--color-text-2); line-height: 1.75; font-size: 13px; padding: 18px 0; border-bottom: 1px solid var(--color-border); }
.deliverable-list { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 22px 0 30px; }
.deliverable-list > div { padding: 14px; border-radius: var(--radius-md); background: var(--color-bg-1); }
.deliverable-list span { display: block; color: var(--color-text-3); font-size: 10px; margin-bottom: 6px; }
.deliverable-list strong { font-size: 12px; }
.generated-section { margin: -12px 0 26px; padding-top: 18px; border-top: 1px solid var(--color-border); }
.generated-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.generated-head > div { display: flex; flex-direction: column; gap: 4px; }
.generated-head strong { font-size: 13px; }
.generated-head span { color: var(--color-text-3); font-size: 10px; }
.generated-head em { color: var(--color-primary); font-size: 12px; font-style: normal; font-weight: 700; }
.generated-strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(132px, 168px); gap: 10px; overflow-x: auto; padding-bottom: 8px; }
.generated-strip article { overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-1); }
.generated-strip video { display: block; width: 100%; aspect-ratio: 9 / 16; max-height: 220px; object-fit: cover; background: #000; }
.generated-strip span { display: block; padding: 8px 9px; color: var(--color-text-2); font-size: 10px; }
.work-cta { display: flex; align-items: center; gap: 14px; }
.work-cta > span { color: var(--color-text-3); font-size: 11px; }
.capability-panel { padding: 22px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-bg-card); }
.capability-panel h2 { margin-bottom: 16px; }
.capability { display: grid; grid-template-columns: 8px 1fr auto; gap: 9px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--color-border); font-size: 11px; color: var(--color-text-2); }
.capability:last-child { border-bottom: 0; }
.capability > span { width: 7px; height: 7px; border-radius: 50%; background: var(--color-text-3); }
.capability strong { color: var(--color-text-3); font-size: 10px; }
.capability.ready > span { background: var(--color-success); }
.capability.ready strong { color: var(--color-success); }
@media (max-width: 900px) {
  .mode-grid, .form-grid, .workspace-grid { grid-template-columns: 1fr; }
  .topbar { grid-template-columns: auto 1fr auto; }
  .brand-block { justify-self: center; }
  .workspace-head { align-items: flex-start; flex-direction: column; }
  .workspace-actions { flex-wrap: wrap; }
}
</style>
