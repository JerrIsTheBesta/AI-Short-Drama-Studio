import { useProjectStore, useAssetsStore } from '@/stores'
import {
  generateImage,
  generateVideo,
  generateSpeech,
  generateStoryboard,
  generatePlay,
  storyboardToShots,
  isPlayReady,
  characterSheetPrompt,
  scenePlatePrompt,
  composeVideoPrompt,
  spokenTextOnly,
  h3IdentityLockFromFrame,
  enrichVideoPerformance,
  reviewImageQuality,
  reviewVideoQuality,
  reviewSpeechQuality,
  analyzeRemakeVideo,
  remakeShotsFromAnalysis
} from '@/services/ai'
import { blobToChatImageUrl } from '@/services/ai/client'
import { imageModelForProject } from '@/services/ai/runtime'
import { collectShotRefIds, composeShotImagePrompt, sceneForShot, subjectsForShot, videoExtraRefIds, videoExtraRefLead } from '@/utils/consistency'
import {
  effectiveImagePrompt,
  h3VoiceMode,
  needsExternalTts,
  pushHistory
} from '@/utils/shot'
import { rebuildCanvasGraph } from './layout'
import { lookFromScript, styleLabel } from '@/utils/visualStyle'
import { mapPool, withNodeJob } from './jobs'
import { isPlayApproved, PLAY_GATE_MSG } from './playGate'
import { generateFinalCut } from './exportFinal'
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
  onProgress?.('生成人设图...')
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
    filename: `character_${sub.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.('校验人设图片文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`人设图文件无效：${quality.issues.join('；')}`)
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

export async function generateScenePlate(scn: Scene, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const look = lookFromScript(project.current.script)
  const style = look.style
  const prompt = scenePlatePrompt(scn, style, look)
  onProgress?.('生成场景底板...')
  const size = imageGenSize('scene')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: project.current.settings.aspectRatio,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `scene_${scn.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.('校验场景图片文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`场景图文件无效：${quality.issues.join('；')}`)
  project.updateScene(scn.id, {
    plateAssetId: asset.id,
    plateHistoryIds: pushHistory(scn.plateAssetId, asset.id, scn.plateHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateShotImage(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
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

export async function generateShotVideo(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  if (!shot.imageAssetId) throw new Error('请先生成该分镜的配图')
  const main = await assets.getBlob(shot.imageAssetId)
  if (!main) throw new Error('配图读取失败')
  onProgress?.('识别画面人物…')
  const identityLock = await h3IdentityLockFromFrame({
    imageBlob: main,
    subjects: subjectsForShot(shot, project.current),
    signal
  })
  onProgress?.('写细视频内容表现…')
  const performance = await enrichVideoPerformance({
    shot,
    subjects: subjectsForShot(shot, project.current),
    scene: sceneForShot(shot, project.current),
    signal
  })
  if (performance && performance !== shot.videoPrompt) {
    project.updateShot(shot.id, { videoPrompt: performance })
  }
  const extraIds = videoExtraRefIds(shot).slice(0, 2)
  const extras: Blob[] = []
  for (const id of extraIds) {
    const b = await assets.getBlob(id)
    if (b) extras.push(b)
  }
  const lead = extras.length ? videoExtraRefLead(shot, project.current) : ''
  const prompt = [lead, identityLock, performance].filter(Boolean).join('\n\n')
  onProgress?.(
    extras.length ? `生成视频（本镜配图 + ${extras.length} 张参考）…` : '生成视频（仅本镜配图）…'
  )
  const result = await generateVideo(
    {
      imageBlob: main,
      referenceImages: extras.length ? extras : undefined,
      prompt,
      aesthetic: project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
      audioDescription: shot.audioDescription,
      voiceover: shot.voiceover,
      voiceMode: h3VoiceMode(shot),
      speakerHint: shot.speakerHint,
      duration: shot.duration,
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio,
      cameraMovement: shot.cameraMovement,
      signal
    },
    onProgress
  )
  onProgress?.('校验视频文件...')
  const quality = await reviewVideoQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`视频文件无效：${quality.issues.join('；')}`)
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `video_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt: composeVideoPrompt({
      prompt,
      aesthetic: project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
      audioDescription: shot.audioDescription,
      voiceover: shot.voiceover,
      voiceMode: h3VoiceMode(shot),
      speakerHint: shot.speakerHint,
      duration: shot.duration,
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio,
      cameraMovement: shot.cameraMovement
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

export async function runGeneratePlay(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  if (
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
  onProgress?.('写完整剧本…')
  const run = await generatePlay(
    {
      topic: project.current.script.topic,
      content: project.current.script.content,
      style: look.style,
      shotDuration: project.current.script.shotDuration,
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords
    },
    onProgress,
    signal
  )
  // 只落剧本，清空旧节点，等第二步再提炼
  project.setShots([])
  project.setSubjects([])
  project.setScenes([])
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
  project.setCanvas(rebuildCanvasGraph(project.current, false))
  project.setPlayApproved(false)
  await project.save()
  return run
}

/** 第二步：从完整剧本提炼人物 / 场景 / 分镜节点 */
export async function runExtractStoryboard(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
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
  onProgress?.('从剧本提炼节点…')
  const run = await generateStoryboard(
    {
      topic: project.current.script.topic,
      content: project.current.script.content,
      style: look.style,
      shotDuration: project.current.script.shotDuration,
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords,
      mode: 'extract'
    },
    onProgress,
    signal
  )
  const shots = storyboardToShots(run.result)
  if (project.current.pipelineMode === 'remake') {
    for (const shot of shots) {
      shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
    }
  }
  project.setShots(shots)
  project.setSubjects(run.result.subjects ?? [])
  project.setScenes(run.result.scenes ?? [])
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
  kind: 'play' | 'extract' = 'play',
  onProgress?: RunProgress,
  signal?: AbortSignal
) {
  return withNodeJob('script', async () => {
    ensureNotCancelled(signal)
    const project = useProjectStore()
    const report = (msg: string) => onProgress?.('script', msg)
    patchNode(project, 'script', 'running')
    try {
      if (kind === 'extract') {
        await runExtractStoryboard(report, signal)
      } else {
        await runGeneratePlay(report, signal)
      }
      patchNode(project, 'script', 'success')
    } catch (e: any) {
      patchNode(project, 'script', 'failed', e?.message ?? String(e))
      throw e
    }
  })
}

/** @deprecated 兼容旧名：始终只走第一步写剧本，避免一步拆出全部节点 */
export async function runStoryboard(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  return runGeneratePlay(onProgress, signal)
}

/** 视频复刻：存参考成片 + 产品图 → 分析镜头 → 写剧本并提炼节点 */
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
    const report = (msg: string) => onProgress?.(nodeId, msg)
    if (
      node.type !== 'script' &&
      node.type !== 'export' &&
      node.type !== 'final' &&
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
      } else {
        throw new Error(`未知节点类型：${node.type}`)
      }
      patchNode(project, nodeId, 'success')
      if (node.type === 'export') patchNode(project, 'final', 'success')
      if (node.type === 'final') patchNode(project, 'export', 'success')
    } catch (e: any) {
      patchNode(project, nodeId, 'failed', e?.message ?? String(e))
      if (node.type === 'export') patchNode(project, 'final', 'failed', e?.message ?? String(e))
      if (node.type === 'final') patchNode(project, 'export', 'failed', e?.message ?? String(e))
      throw e
    } finally {
      pendingRun = {}
    }
  })
}

export async function generateMissingSheets(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = (p.subjects ?? [])
    .filter((s) => !s.designSheetAssetId)
    .map((s) => `subject:${s.id}`)
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
    .filter((s) => s.imageAssetId && !s.videoAssetId)
    .map((s) => `shotVideo:${s.id}`)
  await mapPool(ids, 2, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingAudio(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots.filter((s) => needsExternalTts(s) && !s.audioAssetId).map((s) => `audio:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}
