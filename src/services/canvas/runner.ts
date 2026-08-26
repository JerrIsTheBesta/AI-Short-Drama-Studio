import { useProjectStore, useAssetsStore, useSettingsStore, useLibraryStore } from '@/stores'
import {
  generateImage,
  generateVideo,
  generateSpeech,
  generateStoryboard,
  generatePlay,
  storyboardToShots,
  isPlayReady,
  characterSheetPrompt,
  characterPropSheetPrompt,
  shotBoardPrompt,
  scenePlatePrompt,
  composeVideoPrompt,
  compileH3OfficialPrompt,
  spokenTextOnly,
  enrichVideoPerformance,
  reviewImageQuality,
  reviewVideoQuality,
  reviewSpeechQuality,
  analyzeRemakeVideo,
  remakeShotsFromAnalysis
} from '@/services/ai'
import { blobToChatImageUrl } from '@/services/ai/client'
import { imageModelForProject, getVideoPromptStyle } from '@/services/ai/runtime'
import { collectShotRefIds, collectShotBoardRefIds, collectShotVideoEntries, packVideoRefEntries, composeShotImagePrompt, boundSubjectIds, sceneForShot, subjectsForShot } from '@/utils/consistency'
import { countAddedPlayScenes } from '@/utils/playContinue'
import {
  effectiveImagePrompt,
  needsExternalTts,
  pushHistory,
  resolveH3VoiceMode
} from '@/utils/shot'
import { rebuildCanvasGraph } from './layout'
import { emitCanvasActivity } from './canvasBridge'
import { extractStageLabel } from './pipeline'
import { friendlyAiError } from '@/services/ai/abort'
import { lookFromScript, styleLabel, inferVisualStyleFromText } from '@/utils/visualStyle'
import { playTitleOf, topicFromBrief } from '@/utils/storyBrief'
import { mapPool, withNodeJob, VIDEO_GEN_CONCURRENCY } from './jobs'
import { isPlayApproved, PLAY_GATE_MSG } from './playGate'
import { generateFinalCut } from './exportFinal'
import { setActiveProjectDir } from '@/services/storage'
import type { CanvasNode, Scene, Shot, Subject } from '@/types'

export type RunProgress = (nodeId: string, msg: string) => void
export type NodeRunOpts = { hd?: boolean }

let pendingRun: NodeRunOpts = {}

function evenPx(n: number) {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v + 1
}

function imageGenSize(kind: 'shot' | 'sheet' | 'scene') {
  const project = useProjectStore()
  const hd = Boolean(pendingRun.hd)
  if (kind === 'sheet') {
    return hd ? { width: 2560, height: 1440 } : { width: 1792, height: 1024 }
  }
  const w = project.current?.settings.width ?? 1280
  const h = project.current?.settings.height ?? 720
  if (!hd) return { width: w, height: h }
  const scale = Math.max(1, 2048 / Math.max(w, h))
  return { width: evenPx(w * scale), height: evenPx(h * scale) }
}

function ensureNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function patchNode(
  project: ReturnType<typeof useProjectStore>,
  nodeId: string,
  status: CanvasNode['status'],
  error?: string
) {
  const node = project.current?.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) return
  node.status = status
  node.error = error
}

async function productRefBlobs() {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const blobs: Blob[] = []
  for (const id of project.current?.script?.referenceAssetIds ?? []) {
    const b = await assets.getBlob(id)
    if (b) blobs.push(b)
  }
  return blobs.slice(0, 3)
}

function resolveLlmModel(override?: string): string | undefined {
  const picked = override?.trim()
  if (picked) return picked
  return useSettingsStore().config.llm.model?.trim() || undefined
}

function nodeActivityLabel(node: CanvasNode, p: NonNullable<ReturnType<typeof useProjectStore>['current']>) {
  const subjects = p.subjects ?? []
  const scenes = p.scenes ?? []
  const shots = p.shots ?? []
  const shotNo = (id?: string) => {
    const shot = shots.find((item) => item.id === id)
    return shot ? `第${shot.index + 1}镜` : '分镜'
  }
  switch (node.type) {
    case 'script':
      return '写完整剧本'
    case 'subject':
      return `四视图「${subjects.find((s) => s.id === node.data.subjectId)?.name || '角色'}」`
    case 'subjectProps':
      return `资产图「${subjects.find((s) => s.id === node.data.subjectId)?.name || '角色'}」`
    case 'scene':
      return `场景锚点「${scenes.find((s) => s.id === node.data.sceneId)?.name || '场景'}」`
    case 'shotBoard':
      return `故事看板 ${shotNo(node.data.shotId)}`
    case 'shotImage':
      return `分镜配图 ${shotNo(node.data.shotId)}`
    case 'shotVideo':
      return `分镜视频 ${shotNo(node.data.shotId)}`
    case 'audio':
      return `口播 ${shotNo(node.data.shotId)}`
    case 'export':
    case 'final':
      return '合成成片'
    default:
      return node.data.label || node.type
  }
}

function scriptActivityLabel(kind: 'play' | 'extract' | 'continue') {
  if (kind === 'extract') return extractStageLabel(useProjectStore().current)
  if (kind === 'continue') return '续写剧本'
  return '写完整剧本'
}

function trackActivity(
  nodeId: string,
  label: string,
  source: 'canvas' | 'agent',
  report?: (msg: string) => void
) {
  emitCanvasActivity({ kind: 'start', nodeId, label, source })
  return {
    progress(msg: string) {
      report?.(msg)
      emitCanvasActivity({ kind: 'progress', nodeId, label, message: msg, source })
    },
    done(message?: string) {
      emitCanvasActivity({ kind: 'done', nodeId, label, message, source })
    },
    fail(e: unknown) {
      emitCanvasActivity({
        kind: 'error',
        nodeId,
        label,
        message: friendlyAiError(e),
        source
      })
    }
  }
}

export async function generateSubjectSheet(sub: Subject, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const look = lookFromScript(project.current.script)
  const style = look.style
  const refs = await productRefBlobs()
  const useRefs = refs.length > 0 && (Boolean(sub.fromReference) || sub.kind === 'other')
  const prompt = characterSheetPrompt(sub, style, useRefs, look)
  onProgress?.('生成四视图...')
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      referenceImages: useRefs ? refs : undefined,
      referenceLabels: useRefs
        ? refs.map(() => `角色「${sub.name}」参考照片，外貌必须一致`)
        : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `turnaround_${sub.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.('校验人设图片文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`四视图文件无效：${quality.issues.join('；')}`)
  project.updateSubject(sub.id, {
    designSheetAssetId: asset.id,
    designSheetHistoryIds: pushHistory(
      sub.designSheetAssetId,
      asset.id,
      sub.designSheetHistoryIds
    )
  })
  await project.save()
  return asset
}

export async function generateSubjectPropSheet(
  sub: Subject,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const look = lookFromScript(project.current.script)
  const style = look.style
  const prompt = characterPropSheetPrompt(sub, style, look)
  const refs: Blob[] = []
  const labels: string[] = []
  if (sub.designSheetAssetId) {
    const four = await assets.getBlob(sub.designSheetAssetId)
    if (four) {
      refs.push(four)
      labels.push(`四视图「${sub.name}」，资产图里的物件必须能戴在/拿在这个人身上`)
    }
  }
  onProgress?.('生成资产图...')
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      referenceImages: refs.length ? refs : undefined,
      referenceLabels: labels.length ? labels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `props_${sub.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.('校验资产图文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`资产图文件无效：${quality.issues.join('；')}`)
  project.updateSubject(sub.id, {
    propSheetAssetId: asset.id,
    propSheetHistoryIds: pushHistory(sub.propSheetAssetId, asset.id, sub.propSheetHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateScenePlate(scn: Scene, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const look = lookFromScript(project.current.script)
  const style = look.style
  const prompt = scenePlatePrompt(scn, style, look)
  onProgress?.('生成场景锚点图...')
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `anchors_${scn.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.('校验场景图片文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`场景锚点图文件无效：${quality.issues.join('；')}`)
  project.updateScene(scn.id, {
    plateAssetId: asset.id,
    plateHistoryIds: pushHistory(scn.plateAssetId, asset.id, scn.plateHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateShotBoard(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const rebound = boundSubjectIds(shot, project.current.subjects ?? [])
  if (rebound.length) {
    project.updateShot(shot.id, { subjectIds: rebound })
    shot = project.current.shots.find((s) => s.id === shot.id) || { ...shot, subjectIds: rebound }
  }
  const look = lookFromScript(project.current.script)
  const style = look.style
  const bundle = collectShotBoardRefIds(shot, project.current)
  const blobs: Blob[] = []
  const labels: string[] = []
  for (let i = 0; i < bundle.ids.length; i++) {
    const b = await assets.getBlob(bundle.ids[i])
    if (!b) continue
    blobs.push(b)
    labels.push(bundle.labels[i])
  }
  const prompt = shotBoardPrompt(shot, style, look)
  onProgress?.(blobs.length ? `画故事看板（${blobs.length} 张参考）...` : '画故事看板...')
  const size = imageGenSize('shot')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: project.current.settings.aspectRatio,
      referenceImages: blobs.length ? blobs : undefined,
      referenceLabels: labels.length ? labels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `board_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id,
    shotId: shot.id
  })
  onProgress?.('校验故事看板文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`故事看板文件无效：${quality.issues.join('；')}`)
  project.assignShotBoard(shot.id, asset.id)
  await project.save()
  return asset
}

export async function generateShotImage(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const rebound = boundSubjectIds(shot, project.current.subjects ?? [])
  if (rebound.length) {
    project.updateShot(shot.id, { subjectIds: rebound })
    shot = project.current.shots.find((s) => s.id === shot.id) || { ...shot, subjectIds: rebound }
  }
  if (!shot.boardAssetId) {
    await generateShotBoard(shot, onProgress, signal)
    shot = project.current.shots.find((s) => s.id === shot.id) || shot
  }
  const look = lookFromScript(project.current.script)
  const style = look.style
  const bundle = collectShotRefIds(shot, project.current)
  const blobs: Blob[] = []
  const labels: string[] = []
  for (let i = 0; i < bundle.ids.length; i++) {
    const b = await assets.getBlob(bundle.ids[i])
    if (!b) continue
    blobs.push(b)
    labels.push(bundle.labels[i])
  }
  const prompt = composeShotImagePrompt(
    shot,
    project.current,
    effectiveImagePrompt(shot) || shot.title
  )
  onProgress?.(blobs.length ? `图生图（${blobs.length} 张锁定参考）...` : '文生图...')
  const size = imageGenSize('shot')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: project.current.settings.aspectRatio,
      referenceImages: blobs.length ? blobs : undefined,
      referenceLabels: labels.length ? labels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `shot_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id,
    shotId: shot.id
  })
  onProgress?.('校验关键帧文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`关键帧文件无效：${quality.issues.join('；')}`)
  project.assignShotImage(shot.id, asset.id)
  await project.save()
  return asset
}

function refreshShot(shotId: string): Shot {
  const shot = useProjectStore().current?.shots.find((item) => item.id === shotId)
  if (!shot) throw new Error('找不到分镜')
  return shot
}

async function ensureShotVideoRefs(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const project = useProjectStore()
  if (!project.current) throw new Error('没有打开的项目')
  for (const sub of subjectsForShot(shot, project.current)) {
    const latest = (project.current.subjects ?? []).find((item) => item.id === sub.id) || sub
    if (latest.designSheetAssetId) continue
    onProgress?.(`先补「${latest.name}」角色设计图…`)
    await generateSubjectSheet(latest, onProgress, signal)
  }
  const scene = sceneForShot(shot, project.current)
  if (scene && !scene.plateAssetId) {
    onProgress?.(`先补场景「${scene.name}」…`)
    await generateScenePlate(scene, onProgress, signal)
  }
  shot = refreshShot(shot.id)
  if (!shot.boardAssetId) {
    onProgress?.('先补本镜故事看板…')
    await generateShotBoard(shot, onProgress, signal)
  }
  return refreshShot(shot.id)
}

export async function generateShotVideo(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  shot = await ensureShotVideoRefs(shot, onProgress, signal)

  const allEntries = collectShotVideoEntries(shot, project.current)
  const packed = packVideoRefEntries(allEntries)
  if (!packed.length) throw new Error('没有角色设计图、场景图或故事看板，无法出视频。不要用人物+场景配图出片。')
  if (!packed.some((entry) => entry.kind === 'board')) {
    throw new Error('没有本镜故事看板，无法出视频。看板是这一镜的整体故事架构。')
  }
  const blobs: Blob[] = []
  for (const entry of packed) {
    const blob = await assets.getBlob(entry.id)
    if (!blob) throw new Error(`${entry.name || entry.kind} 参考图读取失败`)
    blobs.push(blob)
  }
  const extraChars = allEntries.filter((entry) => entry.kind === 'character').length
    - packed.filter((entry) => entry.kind === 'character').length
  if (extraChars > 0) {
    onProgress?.(`本镜角色太多，已按最多 9 张传：先角色设计图，再场景，再故事看板`)
  }

  const promptStyle = getVideoPromptStyle()
  const cast = subjectsForShot(shot, project.current)
  const scene = sceneForShot(shot, project.current)
  onProgress?.('写细视频内容表现…')
  const performance = await enrichVideoPerformance({
    shot,
    subjects: cast,
    scene,
    signal
  })
  if (performance && performance !== shot.videoPrompt) {
    project.updateShot(shot.id, { videoPrompt: performance })
  }
  const spoken = spokenTextOnly(shot.voiceover || '')
  const visibleSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const onScreenNames = cast.map((subject) => subject.name)
  const voiceMode = spoken ? resolveH3VoiceMode(shot, onScreenNames) : 'none'
  const imageAssignments = packed.map((entry) => entry.label)
  onProgress?.('按 H3 多图参考格式编译提示词…')
  const officialPrompt = await compileH3OfficialPrompt({
    prompt: performance,
    aesthetic: project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
    audioDescription: shot.audioDescription,
    voiceover: spoken,
    voiceMode,
    speakerHint: shot.speakerHint,
    speakerName: visibleSpeaker,
    onScreenNames,
    sceneName: scene?.name,
    sceneDescription: scene?.description,
    sceneLighting: scene?.lighting,
    sceneAnchor: scene?.mainAnchor,
    shotTitle: shot.title,
    imageAssignments,
    duration: shot.duration,
    width: project.current.settings.width,
    height: project.current.settings.height,
    aspectRatio: project.current.settings.aspectRatio,
    cameraMovement: shot.cameraMovement,
    promptStyle,
    signal
  })
  const slotNames = packed.map((entry, index) =>
    entry.kind === 'character'
      ? `图${index + 1}「${entry.name}」人设`
      : entry.kind === 'scene'
        ? `图${index + 1}场景`
        : `图${index + 1}故事看板`
  )
  onProgress?.(`生成视频（${slotNames.join('、')}）…`)
  const result = await generateVideo(
    {
      imageBlob: blobs[0],
      referenceImages: blobs.slice(1),
      prompt: officialPrompt,
      aesthetic: project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
      audioDescription: shot.audioDescription,
      voiceover: spoken,
      voiceMode,
      speakerHint: shot.speakerHint,
      speakerName: visibleSpeaker,
      onScreenNames,
      sceneName: scene?.name,
      sceneDescription: scene?.description,
      sceneLighting: scene?.lighting,
      sceneAnchor: scene?.mainAnchor,
      shotTitle: shot.title,
      imageAssignments,
      duration: shot.duration,
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio,
      cameraMovement: shot.cameraMovement,
      promptStyle,
      signal
    },
    onProgress
  )
  onProgress?.('校验视频文件...')
  const quality = await reviewVideoQuality(result.blob, result.prompt, signal)
  if (!quality.passed) throw new Error(`视频文件无效：${quality.issues.join('；')}`)
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `video_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt: composeVideoPrompt({
      prompt: officialPrompt,
      aesthetic: project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
      audioDescription: shot.audioDescription,
      voiceover: spoken,
      voiceMode,
      speakerHint: shot.speakerHint,
      speakerName: visibleSpeaker,
      onScreenNames,
      sceneName: scene?.name,
      sceneDescription: scene?.description,
      sceneLighting: scene?.lighting,
      sceneAnchor: scene?.mainAnchor,
      shotTitle: shot.title,
      imageAssignments,
      duration: shot.duration,
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio,
      cameraMovement: shot.cameraMovement,
      promptStyle
    }),
    projectId: project.current.id,
    shotId: shot.id
  })
  project.assignShotVideo(shot.id, asset.id)
  await project.save()
  return asset
}

export async function generateShotAudio(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  if (!needsExternalTts(shot)) throw new Error('该分镜未选择后期 TTS，不需要生成独立配音')
  const text = spokenTextOnly(shot.voiceover || '')
  if (!text) throw new Error('该分镜没有口播文案')
  onProgress?.('合成口播...')
  const result = await generateSpeech({
    text,
    voice: project.current.settings.ttsVoice,
    language: 'Chinese',
    instruction: `自然、克制的中文短视频旁白；语速按 ${shot.duration} 秒内说完；标点处真实停顿，不要播音腔，不要夸张情绪。`,
    signal
  })
  const quality = await reviewSpeechQuality(result.blob, text, shot.duration)
  if (!quality.passed) throw new Error(`配音文件或时长校验未通过：${quality.issues.join('；')}。${quality.retryHint || ''}`)
  const asset = await assets.add(result.blob, 'audio', 'ai-generated', {
    filename: `voice_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt: text,
    projectId: project.current.id,
    shotId: shot.id
  })
  project.assignShotAudio(shot.id, asset.id)
  await project.save()
  return asset
}

export async function runGeneratePlay(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  model?: string,
  opts?: { mode?: 'write' | 'continue'; hint?: string; brief?: string }
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const continueMode = opts?.mode === 'continue'
  const brief = opts?.brief?.trim()
  if (continueMode && !isPlayReady(project.current?.script)) {
    throw new Error('请先写好完整剧本，再续写')
  }
  if (brief && !continueMode && project.current?.script) {
    const topic = topicFromBrief(brief) || project.current.script.topic
    const inferred = inferVisualStyleFromText(brief)
    project.current.name = topic
    project.setScript({
      ...project.current.script,
      topic,
      content: brief,
      playReady: false,
      ...(inferred ? { style: inferred } : {})
    })
  }
  if (
    !continueMode &&
    project.current?.pipelineMode === 'remake' &&
    project.current.sourceVideoAssetId &&
    !isPlayReady(project.current.script)
  ) {
    return rerunVideoRemake(onProgress, signal)
  }
  const assets = useAssetsStore()
  if (!project.current?.script) throw new Error('请先填写文案')
  const productImages: string[] = []
  for (const id of (project.current.script.referenceAssetIds ?? []).slice(0, 5)) {
    const blob = await assets.getBlob(id)
    if (!blob) continue
    try {
      productImages.push(await blobToChatImageUrl(blob))
    } catch {
      /* skip */
    }
  }
  const look = lookFromScript(project.current.script)
  if (look.matched && look.matched !== project.current.script.style) {
    onProgress?.(`已按你的原话锁定画风：${styleLabel(look.matched)}`)
    project.setScript({ ...project.current.script, style: look.matched })
  } else if (!look.matched && look.userNamed) {
    onProgress?.(`已按你的原话锁定画风：${look.medium}`)
  }
  const previousPlay = project.current.script.content || ''
  onProgress?.(continueMode ? '续写剧本…' : '写完整剧本…')
  const run = await generatePlay(
    {
      topic: project.current.script.topic,
      content: project.current.script.content,
      style: look.style,
      shotDuration: project.current.script.shotDuration,
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords,
      model: resolveLlmModel(model),
      playMode: continueMode ? 'continue' : 'write',
      continueHint: opts?.hint
    },
    onProgress,
    signal
  )
  if (!continueMode) {
    project.setShots([])
    project.setSubjects([])
    project.setScenes([])
  }
  project.setScript({
    ...project.current.script,
    topic: run.result.topic || project.current.script.topic,
    content: run.result.playMarkdown,
    playReady: true,
    ...(look.matched ? { style: look.matched } : {}),
    ...(run.result.aesthetic ? { aesthetic: run.result.aesthetic } : {}),
    ...(run.result.styleBrief ? { styleBrief: run.result.styleBrief } : {}),
    ...(run.result.colorPalette ? { colorPalette: run.result.colorPalette } : {}),
    ...(run.result.lightingNote ? { lightingNote: run.result.lightingNote } : {})
  })
  project.applyPlayTitle(
    playTitleOf({
      topic: run.result.topic || project.current.script.topic,
      content: run.result.playMarkdown
    })
  )
  if (!continueMode) {
    project.setCanvas(rebuildCanvasGraph(project.current, false))
  }
  project.setPlayApproved(false)
  await project.save()
  if (continueMode) {
    const added = countAddedPlayScenes(previousPlay, run.result.playMarkdown)
    onProgress?.(
      added > 0
        ? `已续写 ${added} 场。已有节点未动，要同步请点「重新提炼节点」。`
        : '剧本已更新。已有节点未动，要同步请点「重新提炼节点」。'
    )
  }
  return run
}

/** 第二步：从完整剧本提炼人物 / 场景 / 分镜节点 */
export async function runExtractStoryboard(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  model?: string
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current?.script) throw new Error('请先填写文案')
  if (!isPlayReady(project.current.script) && !project.current.script.content?.trim()) {
    throw new Error('请先写完整剧本，再提炼节点')
  }
  const productImages: string[] = []
  for (const id of (project.current.script.referenceAssetIds ?? []).slice(0, 5)) {
    const blob = await assets.getBlob(id)
    if (!blob) continue
    try {
      productImages.push(await blobToChatImageUrl(blob))
    } catch {
      /* skip */
    }
  }
  const look = lookFromScript(project.current.script)
  const hasShots = project.current.shots.length > 0
  const existingSubjects = project.current.subjects ?? []
  const existingScenes = project.current.scenes ?? []
  const extractStartAt: 'subjects' | 'scenes' | 'shots' = hasShots
    ? 'subjects'
    : !existingSubjects.length
      ? 'subjects'
      : !existingScenes.length
        ? 'scenes'
        : 'shots'
  onProgress?.(
    extractStartAt === 'subjects'
      ? '先拆人物；完成后立即保存到画布…'
      : extractStartAt === 'scenes'
        ? '人物已保存；继续拆场景…'
        : '人物和场景已保存；继续拆分镜…'
  )
  let finalStagePersisted = false
  const persistStage = async (
    stage: 'subjects' | 'scenes' | 'shots',
    partial: import('@/services/ai/storyboard').StoryboardResult
  ) => {
    if (!project.current) return
    if (stage === 'subjects') {
      project.setSubjects(partial.subjects ?? [])
      if (hasShots) {
        project.setScenes([])
        project.setShots([])
      }
    } else if (stage === 'scenes') {
      project.setSubjects(partial.subjects ?? project.current.subjects ?? [])
      project.setScenes(partial.scenes ?? [])
    } else {
      finalStagePersisted = true
      const stageShots = storyboardToShots(partial)
      if (project.current.pipelineMode === 'remake') {
        for (const shot of stageShots) shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
      }
      project.setSubjects(partial.subjects ?? project.current.subjects ?? [])
      project.setScenes(partial.scenes ?? project.current.scenes ?? [])
      project.setShots(stageShots)
    }
    project.setCanvas(rebuildCanvasGraph(project.current, false))
    await project.save()
    onProgress?.(
      stage === 'subjects'
        ? `人物已写入画布（${project.current.subjects?.length || 0} 个）`
        : stage === 'scenes'
          ? `场景已写入画布（${project.current.scenes?.length || 0} 个）`
          : `分镜已写入画布（${project.current.shots.length} 镜）`
    )
  }
  const run = await generateStoryboard(
    {
      topic: project.current.script.topic,
      content: project.current.script.content,
      style: look.style,
      shotDuration: project.current.script.shotDuration,
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords,
      mode: 'extract',
      model: resolveLlmModel(model),
      extractStartAt,
      extractStopAfter: extractStartAt,
      existingSubjects,
      existingScenes,
      onExtractStage: persistStage
    },
    onProgress,
    signal
  )
  if (extractStartAt !== 'shots') {
    project.setPlayApproved(false)
    await project.save()
    return run
  }
  const shots = storyboardToShots(run.result)
  if (project.current.pipelineMode === 'remake') {
    for (const shot of shots) {
      shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
    }
  }
  if (!finalStagePersisted) {
    project.setShots(shots)
    project.setSubjects(run.result.subjects ?? [])
    project.setScenes(run.result.scenes ?? [])
  }
  if (project.current.script) {
    project.setScript({
      ...project.current.script,
      playReady: true,
      ...(look.matched ? { style: look.matched } : {}),
      ...(run.result.aesthetic ? { aesthetic: run.result.aesthetic } : {}),
      ...(run.result.h3Aesthetic ? { h3Aesthetic: run.result.h3Aesthetic } : {}),
      ...(run.result.styleBrief ? { styleBrief: run.result.styleBrief } : {}),
      ...(run.result.colorPalette ? { colorPalette: run.result.colorPalette } : {}),
      ...(run.result.lightingNote ? { lightingNote: run.result.lightingNote } : {})
    })
  }
  project.setCanvas(rebuildCanvasGraph(project.current, false))
  project.setPlayApproved(false)
  await project.save()
  return run
}

/** 剧本节点动作：默认只写剧本，提炼必须显式传入 extract */
export async function runScriptNode(
  kind: 'play' | 'extract' | 'continue' = 'play',
  onProgress?: RunProgress,
  signal?: AbortSignal,
  model?: string,
  continueHint?: string
) {
  return withNodeJob('script', async () => {
    ensureNotCancelled(signal)
    const project = useProjectStore()
    const source = onProgress ? 'agent' : 'canvas'
    const label = scriptActivityLabel(kind)
    const activity = trackActivity('script', label, source, (msg) => onProgress?.('script', msg))
    patchNode(project, 'script', 'running')
    try {
      if (kind === 'extract') {
        await runExtractStoryboard(activity.progress, signal, model)
      } else if (kind === 'continue') {
        await runGeneratePlay(activity.progress, signal, model, { mode: 'continue', hint: continueHint })
      } else {
        await runGeneratePlay(activity.progress, signal, model)
      }
      patchNode(project, 'script', 'success')
      activity.done(
        kind === 'extract'
          ? `${label}已写入画布`
          : kind === 'continue'
            ? '续写已保存到左侧剧本'
            : '完整剧本已写到画布左侧'
      )
    } catch (e: any) {
      patchNode(project, 'script', 'failed', e?.message ?? String(e))
      activity.fail(e)
      throw e
    }
  })
}

/** @deprecated 兼容旧名：始终只走第一步写剧本，避免一步拆出全部节点 */
export async function runStoryboard(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  return runGeneratePlay(onProgress, signal)
}

/** 视频复刻：存参考视频 + 产品图 → 分析镜头 → 写剧本并提炼节点 */
export async function runVideoRemake(
  input: {
    videoFile: File | Blob
    productFiles?: File[]
    productIds?: string[]
    skipSaveAssets?: boolean
    onProgress?: (msg: string) => void
    signal?: AbortSignal
  }
) {
  ensureNotCancelled(input.signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  if (!input.videoFile) throw new Error('请上传要复刻的参考视频')

  project.current.pipelineMode = 'remake'
  const topic = project.current.script?.topic?.trim() || '视频复刻'
  let productIds = [...(input.productIds ?? [])]

  if (!input.skipSaveAssets) {
    if (!input.productFiles?.length) throw new Error('视频复刻必须上传至少一张产品图')
    input.onProgress?.('保存参考视频…')
    const videoAsset = await assets.add(input.videoFile, 'video', 'uploaded', {
      filename:
        (input.videoFile instanceof File && input.videoFile.name) ||
        `remake_source_${Date.now().toString(36)}`,
      projectId: project.current.id
    })
    project.current.sourceVideoAssetId = videoAsset.id

    input.onProgress?.('保存产品图…')
    productIds = []
    for (const file of input.productFiles.slice(0, 8)) {
      const asset = await assets.add(file, 'image', 'uploaded', {
        filename: file.name || `product_${Date.now().toString(36)}`,
        projectId: project.current.id
      })
      productIds.push(asset.id)
    }
  }

  if (!productIds.length) throw new Error('视频复刻必须上传至少一张产品图')
  if (!project.current.script) throw new Error('请先填写项目主题')

  project.setScript({
    ...project.current.script,
    topic,
    referenceAssetIds: productIds,
    playReady: false
  })
  await project.save()

  try {
    input.onProgress?.('分析参考视频…')
    const analysis = await analyzeRemakeVideo({
      videoBlob: input.videoFile,
      topic,
      aspectRatio: project.current.settings.aspectRatio,
      style: project.current.script.style,
      productCount: productIds.length,
      signal: input.signal,
      onProgress: input.onProgress
    })
    const shots = remakeShotsFromAnalysis(analysis)
    for (const shot of shots) {
      shot.referenceAssetIds = productIds
      shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
    }
    project.setShots(shots)
    project.setSubjects(analysis.result.subjects ?? [])
    project.setScenes(analysis.result.scenes ?? [])
    project.setScript({
      ...project.current.script,
      topic: analysis.topic || topic,
      content: analysis.playMarkdown,
      playReady: true,
      ...(analysis.aesthetic ? { aesthetic: analysis.aesthetic } : {}),
      ...(analysis.result.h3Aesthetic ? { h3Aesthetic: analysis.result.h3Aesthetic } : {}),
      ...(analysis.result.styleBrief ? { styleBrief: analysis.result.styleBrief } : {}),
      ...(analysis.result.colorPalette ? { colorPalette: analysis.result.colorPalette } : {}),
      ...(analysis.result.lightingNote ? { lightingNote: analysis.result.lightingNote } : {})
    })
    project.applyPlayTitle(
      playTitleOf({
        topic: analysis.topic || topic,
        content: analysis.playMarkdown
      })
    )
    project.setCanvas(rebuildCanvasGraph(project.current, false))
    project.setPlayApproved(false)
    await project.save()
    return analysis
  } catch (e) {
    await project.save()
    throw e
  }
}

/** 用项目里已保存的参考视频和产品图重新分析 */
export async function rerunVideoRemake(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current?.sourceVideoAssetId) {
    throw new Error('没有参考视频，请重新创建视频复刻项目')
  }
  const videoBlob = await assets.getBlob(project.current.sourceVideoAssetId)
  if (!videoBlob) throw new Error('参考视频读取失败')
  const productIds = [...(project.current.script?.referenceAssetIds ?? [])]
  if (!productIds.length) throw new Error('没有产品图，请先上传产品图再分析')
  return runVideoRemake({
    videoFile: videoBlob,
    productIds,
    skipSaveAssets: true,
    onProgress,
    signal
  })
}

export async function generateFreeformImage(
  nodeId: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) throw new Error('没有打开的项目')
  const node = p.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error('找不到节点')
  const prompt = node.data.prompt?.trim()
  if (!prompt) throw new Error('请先写提示词')
  onProgress?.('准备参考图...')
  const library = useLibraryStore()
  const blobs: Blob[] = []
  for (const id of node.data.referenceAssetIds ?? []) {
    const b = (await assets.getBlob(id)) || (await library.getBlob(id))
    if (b) blobs.push(b)
  }
  const look = lookFromScript(p.script)
  const size = pendingRun.hd
    ? { width: p.settings.width, height: p.settings.height }
    : { width: Math.min(p.settings.width, 1280), height: Math.min(p.settings.height, 720) }
  onProgress?.('正在出图...')
  const result = await generateImage({
    prompt,
    style: look.style,
    width: size.width,
    height: size.height,
    aspectRatio: p.settings.aspectRatio,
    referenceImages: blobs.length ? blobs : undefined,
    model: imageModelForProject(p.pipelineMode),
    signal
  })
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `${node.data.label || '图片'}.png`,
    prompt,
    projectId: p.id
  })
  project.patchCanvasNode(nodeId, { outputAssetId: asset.id })
  await project.save()
  return asset
}

export async function generateFreeformVideo(
  nodeId: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) throw new Error('没有打开的项目')
  const node = p.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error('找不到节点')
  const prompt = node.data.prompt?.trim()
  if (!prompt) throw new Error('请先写提示词')
  const ids = node.data.referenceAssetIds ?? []
  if (!ids.length) throw new Error('请先选至少一张参考图')
  onProgress?.('读取参考图...')
  const library = useLibraryStore()
  const blobs: Blob[] = []
  for (const id of ids) {
    const b = (await assets.getBlob(id)) || (await library.getBlob(id))
    if (b) blobs.push(b)
  }
  if (!blobs.length) throw new Error('参考图读取失败')
  if (p.folderPath) setActiveProjectDir(p.folderPath)
  const duration =
    node.data.videoModel === 'wan-prime'
      ? Math.min(30, Math.max(2, Math.round(node.data.duration || 8)))
      : Math.min(15, Math.max(1, Math.round(node.data.duration || 8)))
  onProgress?.('正在出视频...')
  const result = await generateVideo(
    {
      prompt,
      imageBlob: blobs[0],
      referenceImages: blobs.slice(1, node.data.videoModel === 'wan-prime' ? 10 : 9),
      duration,
      width: p.settings.width,
      height: p.settings.height,
      aspectRatio: p.settings.aspectRatio,
      voiceMode: 'none',
      promptStyle: 'scene-narrative',
      videoModel: node.data.videoModel === 'wan-prime' ? 'wan-prime' : 'h3',
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `${node.data.label || '视频'}.mp4`,
    prompt,
    projectId: p.id
  })
  project.patchCanvasNode(nodeId, { outputAssetId: asset.id })
  onProgress?.('视频已写入节点')
  await project.save()
  return asset
}

export async function runCanvasNode(
  nodeId: string,
  onProgress?: RunProgress,
  signal?: AbortSignal,
  opts?: NodeRunOpts
) {
  return withNodeJob(nodeId, async () => {
    pendingRun = { hd: Boolean(opts?.hd) }
    ensureNotCancelled(signal)
    const project = useProjectStore()
    const p = project.current
    if (!p?.canvas) throw new Error('画布为空')
    const node = p.canvas.nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error('找不到节点')
    const source = onProgress ? 'agent' : 'canvas'
    const label = nodeActivityLabel(node, p)
    const activity = trackActivity(nodeId, label, source, (msg) => onProgress?.(nodeId, msg))
    const report = activity.progress
    if (
      node.type !== 'script' &&
      node.type !== 'export' &&
      node.type !== 'final' &&
      node.type !== 'imageGen' &&
      node.type !== 'videoGen' &&
      !isPlayApproved(p)
    ) {
      throw new Error(PLAY_GATE_MSG)
    }
    patchNode(project, nodeId, 'running')
    if (node.type === 'export' || node.type === 'final') {
      patchNode(project, node.type === 'export' ? 'final' : 'export', 'running')
    }
    try {
      if (node.type === 'script') {
        await runGeneratePlay(report, signal)
      } else if (node.type === 'subject' && node.data.subjectId) {
        const sub = (p.subjects ?? []).find((s) => s.id === node.data.subjectId)
        if (!sub) throw new Error('找不到主体')
        await generateSubjectSheet(sub, report, signal)
      } else if (node.type === 'subjectProps' && node.data.subjectId) {
        const sub = (p.subjects ?? []).find((s) => s.id === node.data.subjectId)
        if (!sub) throw new Error('找不到主体')
        await generateSubjectPropSheet(sub, report, signal)
      } else if (node.type === 'shotBoard' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('找不到分镜')
        await generateShotBoard(shot, report, signal)
      } else if (node.type === 'scene' && node.data.sceneId) {
        const scn = (p.scenes ?? []).find((s) => s.id === node.data.sceneId)
        if (!scn) throw new Error('找不到场景')
        await generateScenePlate(scn, report, signal)
      } else if (node.type === 'shotImage' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('找不到分镜')
        await generateShotImage(shot, report, signal)
      } else if (node.type === 'shotVideo' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('找不到分镜')
        await generateShotVideo(shot, report, signal)
      } else if (node.type === 'audio' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('找不到分镜')
        await generateShotAudio(shot, report, signal)
      } else if (node.type === 'export' || node.type === 'final') {
        await generateFinalCut(report)
      } else if (node.type === 'imageGen') {
        await generateFreeformImage(node.id, report, signal)
      } else if (node.type === 'videoGen') {
        await generateFreeformVideo(node.id, report, signal)
      } else {
        throw new Error(`未知节点类型：${node.type}`)
      }
      patchNode(project, nodeId, 'success')
      if (node.type === 'export') patchNode(project, 'final', 'success')
      if (node.type === 'final') patchNode(project, 'export', 'success')
      activity.done(`${label}已完成`)
    } catch (e: any) {
      patchNode(project, nodeId, 'failed', e?.message ?? String(e))
      if (node.type === 'export') patchNode(project, 'final', 'failed', e?.message ?? String(e))
      if (node.type === 'final') patchNode(project, 'export', 'failed', e?.message ?? String(e))
      activity.fail(e)
      throw e
    } finally {
      pendingRun = {}
    }
  })
}

export async function generateMissingSheets(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const four = (p.subjects ?? [])
    .filter((s) => !s.designSheetAssetId)
    .map((s) => `subject:${s.id}`)
  await mapPool(four, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingPropSheets(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const props = (p.subjects ?? [])
    .filter((s) => !s.propSheetAssetId)
    .map((s) => `subjectProps:${s.id}`)
  await mapPool(props, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingBoards(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots.filter((s) => !s.boardAssetId).map((s) => `shotBoard:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingPlates(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = (p.scenes ?? []).filter((s) => !s.plateAssetId).map((s) => `scene:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingImages(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots.filter((s) => !s.imageAssetId).map((s) => `shotImage:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingVideos(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots
    .filter((s) => !s.videoAssetId)
    .map((s) => `shotVideo:${s.id}`)
  await mapPool(ids, VIDEO_GEN_CONCURRENCY, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingAudio(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots.filter((s) => needsExternalTts(s) && !s.audioAssetId).map((s) => `audio:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}
