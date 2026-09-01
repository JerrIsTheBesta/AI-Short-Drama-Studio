import { useProjectStore, useAssetsStore, useSettingsStore, useLibraryStore } from '@/stores'
import {
  generateImage,
  generateVideo,
  generateSpeech,
  generateStoryboard,
  generatePlay,
  storyboardToShots,
  applyAestheticToScript,
  isPlayReady,
  composeVideoPrompt,
  buildH3ImageSlots,
  spokenTextOnly,
  compileH3OfficialPrompt,
  extractSpokenFromNotes,
  spokenCueLines,
  nodeTextForbidsSpeech,
  nodeTextHasSpeech,
  enrichVideoPerformance,
  reviewImageQuality,
  reviewVideoQuality,
  reviewSpeechQuality,
  analyzeRemakeVideo,
  remakeShotsFromAnalysis,
  DIGITAL_HUMAN_VISUAL_LOCK,
  DIGITAL_HUMAN_AESTHETIC,
  DIGITAL_HUMAN_AUDIO_DESCRIPTION,
  DIGITAL_HUMAN_SPEAKER_HINT,
  DIGITAL_HUMAN_SPEAKER_NAME,
  DIGITAL_HUMAN_SCENE_NAME,
  DIGITAL_HUMAN_SCENE_DESCRIPTION,
  DIGITAL_HUMAN_SCENE_ANCHOR,
  DIGITAL_HUMAN_IMAGE_ASSIGNMENT,
  cloneVoiceFromSample,
  synthesizeClonedSpeech
} from '@/services/ai'
import { blobToChatImageUrl } from '@/services/ai/client'
import { imageModelForProject, getVideoPromptStyle } from '@/services/ai/runtime'
import { collectShotRefIds, collectShotBoardRefIds, collectShotKeyframeRefIds, collectShotVideoEntries, packVideoRefEntries, boundSubjectIds, sceneAssetForShot, sceneForShot, subjectsForShot, sceneHasKeyProps } from '@/utils/consistency'
import { resolveShotPlace } from '@/utils/shotPlace'
import { videoRequiresStoryboard } from '@/utils/storyboardGate'
import { stillModeForShot, shotsMissingKeyframe, shotsMissingStoryboard } from '@/utils/videoStill'
import {
  extractPlayDirectives,
  extractSceneSlice
} from '@/utils/scriptMarkdown'
import { countAddedPlayScenes } from '@/utils/playContinue'
import {
  needsExternalTts,
  pushHistory,
  resolveH3VoiceMode
} from '@/utils/shot'
import { rebuildCanvasGraph } from './layout'
import { emitCanvasActivity } from './canvasBridge'
import { extractStageLabel, extractStageNoun, nextExtractStage, type ExtractStage } from './pipeline'
import { friendlyAiError } from '@/services/ai/abort'
import { lookFromScript, styleLabel, inferVisualStyleFromText } from '@/utils/visualStyle'
import {
  boardSendPrompt,
  scenePropSendPrompt,
  sceneSendPrompt,
  shotImageSendPrompt,
  defaultShotImagePrompt,
  subjectSendPrompt,
  videoSendPrompt,
  shotDirectorBrief,
  fillEmptyGeneratePrompt
} from '@/utils/nodePrompt'
import { playTitleOf, topicFromBrief } from '@/utils/storyBrief'
import { isNodeRunning, mapPool, withNodeJob, VIDEO_GEN_CONCURRENCY } from './jobs'
import { isPlayApproved, PLAY_GATE_MSG } from './playGate'
import { generateFinalCut } from './exportFinal'
import { setActiveProjectDir } from '@/services/storage'
import { toDigitalHumanWav } from '@/services/ffmpeg'
import type { CanvasNode, ID, Scene, Shot, Subject, VideoGenModel, VideoResolution } from '@/types'
import {
  isH3VideoFamily,
  normalizeH3GenMode,
  normalizeVideoGenModel,
  normalizeVideoResolution,
  videoMaxSeconds,
  videoMinSeconds
} from '@/types'
import { resolvedCanvasReferenceAssetIds } from '@/services/canvas/references'

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
    case 'sceneProps':
      return `关键道具「${scenes.find((s) => s.id === node.data.sceneId)?.name || '场景'}」`
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

function scriptActivityLabel(kind: 'play' | 'extract' | 'continue', stage?: ExtractStage) {
  if (kind === 'extract') {
    if (stage) return `提炼${extractStageNoun(stage)}`
    return extractStageLabel(useProjectStore().current)
  }
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

async function extraRefBlobs(ids: string[] | undefined, label: string) {
  const assets = useAssetsStore()
  const library = useLibraryStore()
  const blobs: Blob[] = []
  const labels: string[] = []
  const seen = new Set<string>()
  for (const id of ids ?? []) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    const b = (await assets.getBlob(id)) || (await library.getBlob(id))
    if (!b) continue
    blobs.push(b)
    labels.push(label)
  }
  return { blobs, labels }
}

type SharedImageCategory = '角色' | '场景' | '道具' | '其他'

async function saveGeneratedImageToSharedLibrary(
  blob: Blob,
  category: SharedImageCategory,
  filename: string,
  prompt: string,
  onProgress?: (msg: string) => void
) {
  onProgress?.(`保存到共用资产库 · ${category}...`)
  return useLibraryStore().addCategorized(blob, category, 'ai-generated', { filename, prompt })
}

export async function generateSubjectSheet(sub: Subject, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const latest = (project.current.subjects ?? []).find((s) => s.id === sub.id) || sub
  const look = lookFromScript(project.current.script)
  const style = look.style
  const product = await productRefBlobs()
  const extras = await extraRefBlobs(latest.referenceAssetIds, `角色「${latest.name}」补充参考，外貌必须一致`)
  const useProduct = product.length > 0 && (Boolean(latest.fromReference) || latest.kind === 'other')
  const refs = [...(useProduct ? product : []), ...extras.blobs].slice(0, 10)
  const labels = [
    ...(useProduct ? product.map(() => `角色「${latest.name}」参考照片，外貌必须一致`) : []),
    ...extras.labels
  ].slice(0, 10)
  const prompt = subjectSendPrompt(latest, project.current)
  if (prompt !== (latest.sheetPrompt || '')) {
    project.updateSubject(latest.id, { sheetPrompt: prompt })
  }
  onProgress?.(refs.length ? `生成四视图（${refs.length} 张参考）...` : '生成四视图...')
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
    filename: `turnaround_${latest.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.('校验人设图片文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`四视图文件无效：${quality.issues.join('；')}`)
  await saveGeneratedImageToSharedLibrary(result.blob, '角色', asset.filename, prompt, onProgress)
  project.updateSubject(latest.id, {
    designSheetAssetId: asset.id,
    designSheetHistoryIds: pushHistory(
      latest.designSheetAssetId,
      asset.id,
      latest.designSheetHistoryIds
    )
  })
  await project.save()
  return asset
}

export async function generateScenePropSheet(
  scn: Scene,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const latest = (project.current.scenes ?? []).find((s) => s.id === scn.id) || scn
  if (!sceneHasKeyProps(latest)) throw new Error('当前场景没有关键道具；请先填写 1—4 件明显或推动剧情的道具')
  const look = lookFromScript(project.current.script)
  const style = look.style
  const prompt = scenePropSendPrompt(latest, project.current)
  if (!latest.propSheetPrompt?.trim()) {
    project.updateScene(latest.id, { propSheetPrompt: prompt })
  }
  const refs: Blob[] = []
  const labels: string[] = []
  if (latest.plateAssetId) {
    const plate = await assets.getBlob(latest.plateAssetId)
    if (plate) {
      refs.push(plate)
      labels.push(`场景锚点「${latest.name}」，关键道具的时代、材质与配色必须匹配这个场景`)
    }
  }
  const extras = await extraRefBlobs(latest.propReferenceAssetIds, `关键道具补充参考，物件外观必须一致`)
  refs.push(...extras.blobs)
  labels.push(...extras.labels)
  const clippedRefs = refs.slice(0, 10)
  const clippedLabels = labels.slice(0, 10)
  onProgress?.(clippedRefs.length ? `生成关键道具图（${clippedRefs.length} 张参考）...` : '生成关键道具图...')
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      referenceImages: clippedRefs.length ? clippedRefs : undefined,
      referenceLabels: clippedLabels.length ? clippedLabels : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `scene_props_${latest.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.('校验关键道具图文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`关键道具图文件无效：${quality.issues.join('；')}`)
  await saveGeneratedImageToSharedLibrary(result.blob, '道具', asset.filename, prompt, onProgress)
  project.updateScene(latest.id, {
    propSheetAssetId: asset.id,
    propSheetHistoryIds: pushHistory(latest.propSheetAssetId, asset.id, latest.propSheetHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateScenePlate(scn: Scene, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const latest = (project.current.scenes ?? []).find((s) => s.id === scn.id) || scn
  const look = lookFromScript(project.current.script)
  const style = look.style
  const extras = await extraRefBlobs(latest.referenceAssetIds, `场景「${latest.name}」参考，空间和光线必须一致`)
  const prompt = sceneSendPrompt(latest, project.current)
  if (!latest.platePrompt?.trim()) {
    project.updateScene(latest.id, { platePrompt: prompt })
  }
  onProgress?.(extras.blobs.length ? `生成场景锚点图（${extras.blobs.length} 张参考）...` : '生成场景锚点图...')
  const size = imageGenSize('sheet')
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio: '16:9',
      referenceImages: extras.blobs.length ? extras.blobs.slice(0, 10) : undefined,
      referenceLabels: extras.labels.length ? extras.labels.slice(0, 10) : undefined,
      model: imageModelForProject(project.current.pipelineMode),
      signal
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `anchors_${latest.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  onProgress?.('校验场景图片文件...')
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw new Error(`场景锚点图文件无效：${quality.issues.join('；')}`)
  await saveGeneratedImageToSharedLibrary(result.blob, '场景', asset.filename, prompt, onProgress)
  project.updateScene(latest.id, {
    plateAssetId: asset.id,
    plateHistoryIds: pushHistory(latest.plateAssetId, asset.id, latest.plateHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateShotBoard(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  if (project.current && !videoRequiresStoryboard(project.current)) {
    return generateShotImage(shot, onProgress, signal)
  }
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
    const b = (await assets.getBlob(bundle.ids[i])) || (await useLibraryStore().getBlob(bundle.ids[i]))
    if (!b) continue
    blobs.push(b)
    labels.push(bundle.labels[i])
  }
  const prompt = boardSendPrompt(shot, project.current)
  if (!shot.boardPrompt?.trim()) {
    project.updateShot(shot.id, { boardPrompt: prompt })
  }
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
  await saveGeneratedImageToSharedLibrary(result.blob, '其他', asset.filename, prompt, onProgress)
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
  if (videoRequiresStoryboard(project.current) && !shot.boardAssetId) {
    await generateShotBoard(shot, onProgress, signal)
    shot = project.current.shots.find((s) => s.id === shot.id) || shot
  } else {
    for (const sub of subjectsForShot(shot, project.current)) {
      const latest = (project.current.subjects ?? []).find((item) => item.id === sub.id) || sub
      if (latest.designSheetAssetId) continue
      onProgress?.(`先补「${latest.name}」角色设计图…`)
      await generateSubjectSheet(latest, onProgress, signal)
    }
    const scene = sceneAssetForShot(shot, project.current)
    if (scene && !scene.plateAssetId) {
      onProgress?.(`先补场景「${scene.name}」…`)
      await generateScenePlate(scene, onProgress, signal)
    }
    shot = project.current.shots.find((s) => s.id === shot.id) || shot
  }
  const look = lookFromScript(project.current.script)
  const style = look.style
  const bundle = videoRequiresStoryboard(project.current)
    ? collectShotRefIds(shot, project.current)
    : collectShotKeyframeRefIds(shot, project.current)
  const blobs: Blob[] = []
  const labels: string[] = []
  const library = useLibraryStore()
  for (let i = 0; i < bundle.ids.length; i++) {
    const b = (await assets.getBlob(bundle.ids[i])) || (await library.getBlob(bundle.ids[i]))
    if (!b) continue
    blobs.push(b)
    labels.push(bundle.labels[i])
  }
  let prompt = shotImageSendPrompt(shot, project.current)
  if (!videoRequiresStoryboard(project.current) && !/2\s*列|四宫格|正好\s*4\s*格/.test(prompt)) {
    prompt = defaultShotImagePrompt(shot, project.current)
  }
  if (prompt !== (shot.imagePrompt || '')) {
    project.updateShot(shot.id, { imagePrompt: prompt })
  }
  onProgress?.(blobs.length ? `画四宫格关键帧（${blobs.length} 张人物/场景参考）...` : '画四宫格关键帧...')
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
  await saveGeneratedImageToSharedLibrary(result.blob, '其他', asset.filename, prompt, onProgress)
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
  const scene = sceneAssetForShot(shot, project.current)
  if (scene) {
    if (shot.sceneId !== scene.id) {
      project.updateShot(shot.id, { sceneId: scene.id })
    }
    const latestScene = (project.current.scenes ?? []).find((item) => item.id === scene.id) || scene
    if (!latestScene.plateAssetId) {
      onProgress?.(`先补场景「${latestScene.name}」…`)
      await generateScenePlate(latestScene, onProgress, signal)
    }
  }
  shot = refreshShot(shot.id)
  const stillMode = stillModeForShot(shot, project.current)
  if (stillMode === 'storyboard' && !shot.boardAssetId) {
    onProgress?.('先补本镜故事看板…')
    await generateShotBoard(shot, onProgress, signal)
  } else if (stillMode === 'keyframe' && !shot.imageAssetId) {
    onProgress?.('先生成本镜四宫格关键帧…')
    await generateShotImage(shot, onProgress, signal)
  }
  return refreshShot(shot.id)
}

/**
 * 智能口播单镜重做：只允许项目上传的人物图作为唯一视觉参考。
 * 不能走电影分镜的“人设图 + 场景图 + 故事看板”收集器，否则会丢掉原人物并随机造人。
 */
async function regenerateDigitalHumanShot(
  shot: Shot,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  const flow = p?.speechWorkflow
  if (!p || p.pipelineMode !== 'smart-speech' || flow?.mode !== 'digital-human') {
    throw new Error('当前不是数字人口播项目')
  }
  const referenceId = flow.imageAssetId
  if (!referenceId) {
    throw new Error('数字人口播人物参考图已丢失，已阻止随机生成人物。请重新上传人物图后再生成。')
  }
  const referenceBlob = await assets.getBlob(referenceId)
  if (!referenceBlob) {
    throw new Error('数字人口播人物参考图文件读取失败，已阻止提交生成任务。')
  }
  const spoken = spokenTextOnly(shot.voiceover || '')
  if (!spoken) throw new Error('该镜头没有口播原文')
  let cloned = flow.clonedVoiceId
    ? { voiceId: flow.clonedVoiceId, model: flow.clonedVoiceModel || 'qwen3-tts-vc-2026-01-22' }
    : null
  if (!cloned) {
    const sampleId = flow.voiceSampleAssetId || flow.audioAssetId
    const sampleBlob = sampleId ? await assets.getBlob(sampleId) : undefined
    if (!sampleBlob) throw new Error('缺少声音样本，无法克隆音色后再按台词合成')
    onProgress?.('正在用上传音频克隆音色…')
    cloned = await cloneVoiceFromSample(sampleBlob, `aicut${p.id.replace(/[^a-z0-9]/gi, '').slice(-8)}`, signal)
    p.speechWorkflow = {
      ...flow,
      clonedVoiceId: cloned.voiceId,
      clonedVoiceModel: cloned.model,
      updatedAt: Date.now()
    }
    await project.save()
  }
  onProgress?.('正在用克隆音色按台词合成人声…')
  const rawSpeech = await synthesizeClonedSpeech(spoken, cloned.voiceId, cloned.model, signal)
  const speechBlob = (await toDigitalHumanWav(rawSpeech, onProgress)).blob
  const speechAsset = await assets.add(speechBlob, 'audio', 'ai-generated', {
    filename: `口播_${String(shot.index + 1).padStart(2, '0')}_${Date.now().toString(36)}.wav`,
    prompt: spoken,
    projectId: p.id,
    shotId: shot.id
  })
  project.assignShotAudio(shot.id, speechAsset.id)
  const speechIds = [...(flow.generatedSpeechAssetIds || [])]
  speechIds[shot.index] = speechAsset.id
  if (p.speechWorkflow) {
    p.speechWorkflow = { ...p.speechWorkflow, generatedSpeechAssetIds: speechIds, updatedAt: Date.now() }
  }

  if (shot.imageAssetId !== referenceId) {
    project.updateShot(shot.id, { imageAssetId: referenceId })
    await project.save()
  }
  onProgress?.('已锁定项目人物图（唯一参考），正在生成同人物口播…')
  const result = await generateVideo(
    {
      imageBlob: referenceBlob,
      prompt: DIGITAL_HUMAN_VISUAL_LOCK,
      aesthetic: DIGITAL_HUMAN_AESTHETIC,
      audioDescription: DIGITAL_HUMAN_AUDIO_DESCRIPTION,
      voiceover: spoken,
      voiceMode: 'dialogue',
      speakerHint: DIGITAL_HUMAN_SPEAKER_HINT,
      speakerName: DIGITAL_HUMAN_SPEAKER_NAME,
      onScreenNames: [DIGITAL_HUMAN_SPEAKER_NAME],
      sceneName: DIGITAL_HUMAN_SCENE_NAME,
      sceneDescription: DIGITAL_HUMAN_SCENE_DESCRIPTION,
      sceneAnchor: DIGITAL_HUMAN_SCENE_ANCHOR,
      shotTitle: 'Locked single-person talking head',
      imageAssignments: [DIGITAL_HUMAN_IMAGE_ASSIGNMENT],
      duration: Math.min(15, Math.max(5, Math.ceil(shot.duration))),
      width: p.settings.width,
      height: p.settings.height,
      aspectRatio: p.settings.aspectRatio,
      cameraMovement: 'static',
      audioBlob: speechBlob,
      audioSync: true,
      promptAsIs: true,
      mode: 'I2VA',
      signal,
      resumeTaskId: shot.videoTaskId,
      onTaskSubmitted: async (taskId) => {
        project.updateShot(shot.id, { videoTaskId: taskId })
        await project.save()
      }
    },
    onProgress
  )
  ensureNotCancelled(signal)
  const quality = await reviewVideoQuality(result.blob, result.prompt, signal)
  if (!quality.passed) throw new Error(`视频文件无效：${quality.issues.join('；')}`)
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `digital_human_${shot.index + 1}_${Date.now().toString(36)}.mp4`,
    prompt: result.prompt,
    projectId: p.id,
    shotId: shot.id
  })
  project.assignShotVideo(shot.id, asset.id)
  project.updateShot(shot.id, { videoTaskId: undefined })
  const generatedIds = [...(flow.generatedVideoAssetIds || [])]
  generatedIds[shot.index] = asset.id
  p.speechWorkflow = {
    ...flow,
    generatedVideoAssetIds: generatedIds,
    progress: `第 ${shot.index + 1} 段已用原人物参考图重新生成。`,
    updatedAt: Date.now()
  }
  await project.save()
  return asset
}

async function loadRefImageBlob(id: ID, label: string): Promise<Blob> {
  const assets = useAssetsStore()
  const library = useLibraryStore()
  const blob = (await assets.getBlob(id)) || (await library.getBlob(id))
  if (!blob) throw new Error(`${label}读取失败`)
  return blob
}

function canvasVideoNodeForShot(shot: Shot) {
  return useProjectStore().current?.canvas?.nodes.find(
    (n) => n.type === 'shotVideo' && n.data.shotId === shot.id
  )
}

function canvasVideoModelForShot(shot: Shot): VideoGenModel {
  return normalizeVideoGenModel(canvasVideoNodeForShot(shot)?.data.videoModel)
}

function canvasVideoResolutionForShot(shot: Shot, videoModel: VideoGenModel): VideoResolution {
  return normalizeVideoResolution(canvasVideoNodeForShot(shot)?.data.videoResolution, videoModel)
}

function clampVideoDuration(raw: number | undefined, videoModel: VideoGenModel, fallback = 5) {
  const min = videoMinSeconds(videoModel)
  const max = videoMaxSeconds(videoModel)
  return Math.min(max, Math.max(min, Math.round(raw || fallback)))
}

function shotUsesFl2va(shot: Shot, videoModel: VideoGenModel): boolean {
  return videoModel !== 'wan-prime' && normalizeH3GenMode(shot.h3GenMode) === 'fl2va'
}

export function seedEmptyShotVideoPrompts() {
  const project = useProjectStore()
  const p = project.current
  if (!p) return
  for (const shot of p.shots) {
    const patch = fillEmptyGeneratePrompt('shotVideo', p, shot)
    if (patch) project.updateShot(shot.id, patch)
  }
}

export function rebindShotScenes() {
  const project = useProjectStore()
  const p = project.current
  if (!p) return
  for (const shot of p.shots) {
    const scene = sceneAssetForShot(shot, p)
    if (scene && shot.sceneId !== scene.id) {
      project.updateShot(shot.id, { sceneId: scene.id })
    }
  }
}

export async function generateShotVideo(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  shot = refreshShot(shot.id)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const promptPatch = fillEmptyGeneratePrompt('shotVideo', project.current, shot)
  if (promptPatch) {
    project.updateShot(shot.id, promptPatch)
    shot = refreshShot(shot.id)
  }
  if (
    project.current.pipelineMode === 'smart-speech' &&
    project.current.speechWorkflow?.mode === 'digital-human'
  ) {
    return regenerateDigitalHumanShot(shot, onProgress, signal)
  }
  const videoModel = canvasVideoModelForShot(shot)
  if (shotUsesFl2va(shot, videoModel)) {
    const firstId = shot.firstFrameAssetId || shot.imageAssetId
    const lastId = shot.lastFrameAssetId
    if (!firstId) throw new Error('首尾帧模式需要首帧。请选择首帧，或先给本镜配图。')
    if (!lastId) throw new Error('首尾帧模式需要尾帧。请选择尾帧。')
    onProgress?.('读取首帧和尾帧…')
    const firstBlob = await loadRefImageBlob(firstId, '首帧')
    const lastBlob = await loadRefImageBlob(lastId, '尾帧')
    const promptStyle = getVideoPromptStyle()
    const cast = subjectsForShot(shot, project.current)
    const scene = sceneForShot(shot, project.current)
    const place = resolveShotPlace(shot, scene)
    const spoken = spokenTextOnly(shot.voiceover || '')
    const visibleSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
    const onScreenNames = cast.map((subject) => subject.name)
    const voiceMode = spoken ? resolveH3VoiceMode(shot, onScreenNames) : 'none'
    shot = refreshShot(shot.id)
    const officialPrompt = videoSendPrompt(shot, project.current)
    onProgress?.('使用节点上的完整提示词出视频（首尾帧）…')
    const result = await generateVideo(
      {
        imageBlob: firstBlob,
        lastFrameBlob: lastBlob,
        prompt: officialPrompt,
        promptAsIs: true,
        aesthetic: project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
        audioDescription: shot.audioDescription,
        voiceover: spoken,
        voiceMode,
        speakerHint: shot.speakerHint,
        speakerName: visibleSpeaker,
        onScreenNames,
        sceneName: place.name,
        sceneLighting: place.lighting,
        shotTitle: shot.title,
        duration: clampVideoDuration(shot.duration, videoModel),
        width: project.current.settings.width,
        height: project.current.settings.height,
        aspectRatio: project.current.settings.aspectRatio,
        cameraMovement: shot.cameraMovement,
        promptStyle,
        videoModel: 'h3',
        videoResolution: canvasVideoResolutionForShot(shot, videoModel),
        h3GenMode: 'fl2va',
        mode: 'I2VA',
        signal,
        resumeTaskId: shot.videoTaskId,
        onTaskSubmitted: async (taskId) => {
          project.updateShot(shot.id, { videoTaskId: taskId })
          await project.save()
        }
      },
      onProgress
    )
    onProgress?.('校验视频文件...')
    const quality = await reviewVideoQuality(result.blob, result.prompt, signal)
    if (!quality.passed) throw new Error(`视频文件无效：${quality.issues.join('；')}`)
    const asset = await assets.add(result.blob, 'video', 'ai-generated', {
      filename: `video_${shot.index + 1}_${Date.now().toString(36)}`,
      prompt: result.prompt,
      projectId: project.current.id,
      shotId: shot.id
    })
    project.assignShotVideo(shot.id, asset.id)
    project.updateShot(shot.id, { videoTaskId: undefined })
    await project.save()
    return asset
  }
  shot = await ensureShotVideoRefs(shot, onProgress, signal)

  const stillMode = stillModeForShot(shot, project.current)
  const allEntries = collectShotVideoEntries(shot, project.current)
  let packed = packVideoRefEntries(allEntries)
  if (stillMode === 'keyframe' && !packed.some((entry) => entry.kind === 'keyframe') && shot.imageAssetId) {
    packed = [
      {
        id: shot.imageAssetId,
        kind: 'keyframe',
        name: 'keyframe',
        label: '2x2 four-panel keyframe for [Shot 1]; exactly 4 cells'
      },
      ...packed.filter((entry) => entry.id !== shot.imageAssetId)
    ]
  }
  if (stillMode === 'storyboard' && !packed.some((entry) => entry.kind === 'board')) {
    throw new Error('没有本镜故事看板，无法出视频。看板是这一镜的整体故事架构。')
  }
  if (stillMode === 'keyframe' && !packed.some((entry) => entry.kind === 'keyframe')) {
    throw new Error('没有本镜四宫格关键帧，无法出视频。当前模型需要分镜关键帧。')
  }
  if ((project.current.scenes ?? []).length && !packed.some((entry) => entry.kind === 'scene')) {
    const scene = sceneAssetForShot(shot, project.current)
    throw new Error(
      scene
        ? `没有场景「${scene.name}」的场景图，无法出视频。请先生成该场景图。`
        : '没有场景图，无法出视频。请先做场景图，或把本镜绑到场景。'
    )
  }
  if (!packed.length) {
    throw new Error(
      stillMode === 'identity'
        ? '没有参考图，无法出视频。请先做角色设计图和场景图，或给这一镜加参考图。'
        : '没有参考图，无法出视频。请先做人设、场景、配图，或给这一镜加参考图。'
    )
  }
  const blobs: Blob[] = []
  const library = useLibraryStore()
  for (const entry of packed) {
    const blob = (await assets.getBlob(entry.id)) || (await library.getBlob(entry.id))
    if (!blob) throw new Error(`${entry.name || entry.kind} 参考图读取失败`)
    blobs.push(blob)
  }
  const extraChars = allEntries.filter((entry) => entry.kind === 'character').length
    - packed.filter((entry) => entry.kind === 'character').length
  const extraDropped = allEntries.filter((entry) => entry.kind === 'extra').length
    - packed.filter((entry) => entry.kind === 'extra').length
  if (extraChars > 0 || extraDropped > 0) {
    onProgress?.(`参考图已按最多 9 张打包：角色设计图、场景${stillMode === 'keyframe' ? '、四宫格关键帧' : stillMode === 'storyboard' ? '、故事看板' : ''}，再加你补充的参考`)
  }

  const promptStyle = getVideoPromptStyle()
  const cast = subjectsForShot(shot, project.current)
  const scene = sceneForShot(shot, project.current)
  const place = resolveShotPlace(shot, scene)
  const spoken = spokenTextOnly(shot.voiceover || '')
  const visibleSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const onScreenNames = cast.map((subject) => subject.name)
  const voiceMode = spoken ? resolveH3VoiceMode(shot, onScreenNames) : 'none'
  const imageSlots = buildH3ImageSlots(packed)
  const imageAssignments = imageSlots.map((slot) => slot.job)
  const hasIdentityRefs = packed.some(
    (entry) => entry.kind === 'character' || entry.kind === 'scene' || entry.kind === 'board'
  )
  const hasKeyframeFrame = packed.some((entry) => entry.kind === 'keyframe')
  const h3Mode = hasKeyframeFrame || hasIdentityRefs || packed.length > 1 ? 'R2VA' : 'I2VA'
  shot = refreshShot(shot.id)
  const officialPrompt = videoSendPrompt(shot, project.current)
  onProgress?.('使用节点上的完整提示词出视频…')
  const slotNames = packed.map((entry, index) =>
    entry.kind === 'character'
      ? `图${index + 1}「${entry.name}」人设`
      : entry.kind === 'scene'
        ? `图${index + 1}场景`
        : entry.kind === 'extra'
          ? `图${index + 1}补充参考`
            : entry.kind === 'keyframe'
            ? `图${index + 1}四宫格关键帧`
            : `图${index + 1}故事看板`
  )
  onProgress?.(`生成视频（${slotNames.join('、')}）…`)
  const result = await generateVideo(
    {
      imageBlob: blobs[0],
      referenceImages: blobs.slice(1),
      prompt: officialPrompt,
      promptAsIs: true,
      aesthetic: project.current.script?.h3Aesthetic || project.current.script?.aesthetic,
      audioDescription: shot.audioDescription,
      voiceover: spoken,
      voiceMode,
      speakerHint: shot.speakerHint,
      speakerName: visibleSpeaker,
      onScreenNames,
      sceneName: place.name,
      sceneLighting: place.lighting,
      shotTitle: shot.title,
      imageAssignments,
      imageSlots,
      duration: clampVideoDuration(shot.duration, videoModel),
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio,
      cameraMovement: shot.cameraMovement,
      promptStyle,
      videoModel,
      videoResolution: canvasVideoResolutionForShot(shot, videoModel),
      h3GenMode: 'reference',
      mode: h3Mode,
      signal,
      resumeTaskId: shot.videoTaskId,
      onTaskSubmitted: async (taskId) => {
        project.updateShot(shot.id, { videoTaskId: taskId })
        await project.save()
      }
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
      sceneName: place.name,
      sceneLighting: place.lighting,
      shotTitle: shot.title,
      imageAssignments,
      imageSlots,
      duration: shot.duration,
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio,
      cameraMovement: shot.cameraMovement,
      promptStyle,
      mode: h3Mode
    }),
    projectId: project.current.id,
    shotId: shot.id
  })
  project.assignShotVideo(shot.id, asset.id)
  project.updateShot(shot.id, { videoTaskId: undefined })
  await project.save()
  return asset
}

/** 按本镜场记和章节剧本，用导演口吻重写视频内容表现。 */
export async function rewriteShotPerformance(shot: Shot, signal?: AbortSignal): Promise<string> {
  const project = useProjectStore()
  if (!project.current) throw new Error('没有打开的项目')
  const shots = project.current.shots
  const shotIndex = shots.findIndex((item) => item.id === shot.id)
  const scene = sceneForShot(shot, project.current)
  const play = project.current.script?.content || ''
  const performance = await enrichVideoPerformance({
    shot,
    force: true,
    prevShot: shotIndex > 0 ? shots[shotIndex - 1] : undefined,
    nextShot: shotIndex >= 0 ? shots[shotIndex + 1] : undefined,
    subjects: subjectsForShot(shot, project.current),
    scene,
    chapterNotes: extractPlayDirectives(play),
    sceneExcerpt: extractSceneSlice(play, scene?.name),
    signal
  })
  project.updateShot(shot.id, { videoPrompt: performance })
  return optimizeShotVideoPrompt({ ...shot, videoPrompt: performance }, signal)
}

/** 把节点上现有的提示词编成 H3 官方格式。以框里的原文为准，不拿空口播栏覆盖台词。 */
export async function optimizeShotVideoPrompt(shot: Shot, signal?: AbortSignal): Promise<string> {
  const project = useProjectStore()
  if (!project.current) throw new Error('没有打开的项目')
  shot = refreshShot(shot.id)
  const p = project.current
  const packed = packVideoRefEntries(collectShotVideoEntries(shot, p))
  const imageSlots = buildH3ImageSlots(packed)
  const cast = subjectsForShot(shot, p)
  const scene = sceneForShot(shot, p)
  const place = resolveShotPlace(shot, scene)
  const onScreenNames = cast.map((item) => item.name)
  const nodeText = (shot.compiledVideoPrompt || '').trim()
  const performance = (shot.videoPrompt || '').trim()
  const brief = shotDirectorBrief(shot, p)
  const source = [
    nodeText ? `【节点当前提示词，改写以此为准】\n${nodeText}` : '',
    performance && performance !== nodeText ? `【本镜场记】\n${performance}` : '',
    brief && !nodeText.includes(brief) ? `【分镜字段】\n${brief}` : '',
    shot.voiceover?.trim() ? `【口播栏】\n${shot.voiceover.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  const spokenPool = [nodeText, performance, shot.voiceover, shot.audioDescription].filter(Boolean).join('\n')
  const cueLines = [...extractSpokenFromNotes(spokenPool), ...spokenCueLines(shot.voiceover || '')].filter(
    (line, i, all) => line && all.indexOf(line) === i
  )
  const hasSpeech = cueLines.length > 0 || nodeTextHasSpeech(spokenPool)
  const silent = !hasSpeech && nodeTextForbidsSpeech(spokenPool)
  const resolvedVoice = resolveH3VoiceMode(shot, onScreenNames)
  const voiceMode = silent ? 'none' : hasSpeech ? (resolvedVoice === 'voiceover' ? 'voiceover' : 'dialogue') : resolvedVoice
  const visibleSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const castNotes = cast
    .map((item, i) => {
      const look = [item.role, item.description].filter(Boolean).join('。')
      return `S${i + 1} ${item.name}${look ? `：${look}` : ''}`
    })
    .join('\n')
  const compiled = await compileH3OfficialPrompt({
    prompt: [source, castNotes ? `人物（S 序号按出场顺序；写英文外貌+(S1)，中文名只用来对上对白说话人）：\n${castNotes}` : '']
      .filter(Boolean)
      .join('\n\n'),
    aesthetic: p.script?.h3Aesthetic || p.script?.aesthetic,
    audioDescription: shot.audioDescription,
    voiceover: cueLines.length ? cueLines.join('\n') : '',
    voiceMode,
    speakerHint: shot.speakerHint,
    speakerName: visibleSpeaker,
    onScreenNames,
    sceneName: place.name,
    sceneDescription: scene?.description,
    sceneLighting: place.lighting,
    sceneAnchor: scene?.mainAnchor,
    shotTitle: shot.title,
    imageAssignments: imageSlots.map((slot) => slot.job),
    imageSlots,
    duration: shot.duration,
    width: p.settings.width,
    height: p.settings.height,
    aspectRatio: p.settings.aspectRatio,
    cameraMovement: shot.cameraMovement,
    shotSize: shot.shotSize,
    blocking: shot.blocking,
    eyeline: shot.eyeline,
    continuity: shot.continuity,
    purpose: shot.purpose,
    promptStyle: getVideoPromptStyle(),
    mode: 'R2VA',
    forceIntegrated: true,
    signal
  })
  project.updateShot(shot.id, { compiledVideoPrompt: compiled })
  await project.save()
  return compiled
}

export async function generateShotAudio(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  if (!needsExternalTts(shot, project.current)) throw new Error('该分镜未选择后期 TTS，不需要生成独立配音')
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
      continueHint: opts?.hint,
      workflowMode: project.current.script.workflowMode
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
  if (project.current.pipelineMode !== 'img2video') project.setPlayApproved(false)
  await project.save()
  if (continueMode) {
    const added = countAddedPlayScenes(previousPlay, run.result.playMarkdown)
    onProgress?.(
      added > 0
        ? `已续写 ${added} 场。已有人物和场景未动，要同步新场请在「分镜关键帧」分组点重新提取。`
        : '剧本已更新。已有节点未动，要同步请在对应分组点重新提取。'
    )
  }
  return run
}

function normExtractName(name: string) {
  return String(name || '').replace(/\s+/g, '').toLowerCase()
}

function mergeByName<T extends { id: string; name: string }>(
  next: T[],
  prev: T[],
  prefix: string,
  take: (fresh: T, old: T) => T
): T[] {
  const leftover = [...prev]
  const out: T[] = []
  for (const item of next) {
    const idx = leftover.findIndex((row) => normExtractName(row.name) === normExtractName(item.name))
    if (idx >= 0) out.push(take(item, leftover.splice(idx, 1)[0]))
    else out.push(item)
  }
  const seen = new Set<string>()
  return out.map((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      return item
    }
    let i = 1
    while (seen.has(`${prefix}_${i}`)) i += 1
    const id = `${prefix}_${i}`
    seen.add(id)
    return { ...item, id }
  })
}

function mergeSubjectAssets(next: Subject[], prev: Subject[]): Subject[] {
  return mergeByName(next, prev, 'sub', (fresh, old) => ({
    ...fresh,
    id: old.id,
    designSheetAssetId: old.designSheetAssetId,
    designSheetHistoryIds: old.designSheetHistoryIds,
    propSheetAssetId: old.propSheetAssetId,
    propSheetHistoryIds: old.propSheetHistoryIds,
    referenceAssetIds: old.referenceAssetIds,
    propReferenceAssetIds: old.propReferenceAssetIds
  }))
}

function mergeSceneAssets(next: Scene[], prev: Scene[]): Scene[] {
  return mergeByName(next, prev, 'scn', (fresh, old) => ({
    ...fresh,
    id: old.id,
    plateAssetId: old.plateAssetId,
    plateHistoryIds: old.plateHistoryIds,
    propSheetAssetId: old.propSheetAssetId,
    propSheetHistoryIds: old.propSheetHistoryIds,
    referenceAssetIds: old.referenceAssetIds,
    propReferenceAssetIds: old.propReferenceAssetIds
  }))
}

function mergeShotAssets(next: Shot[], prev: Shot[]): Shot[] {
  return next.map((shot, i) => {
    const old = prev[i]
    if (!old) return shot
    return {
      ...shot,
      id: old.id,
      boardAssetId: old.boardAssetId,
      boardHistoryIds: old.boardHistoryIds,
      imageAssetId: old.imageAssetId,
      videoAssetId: old.videoAssetId,
      audioAssetId: old.audioAssetId,
      imageHistoryIds: old.imageHistoryIds,
      videoHistoryIds: old.videoHistoryIds,
      audioHistoryIds: old.audioHistoryIds,
      referenceAssetIds: old.referenceAssetIds,
      captionOverride: old.captionOverride,
      notes: old.notes,
      status: old.videoAssetId ? 'video-generated' : old.imageAssetId ? 'image-generated' : shot.status
    }
  })
}

/** 第二步：从完整剧本提炼人物 / 场景 / 分镜。可指定只重提其中一组，已生成的图和视频按名字/镜号保留。 */
export async function runExtractStoryboard(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  model?: string,
  stage?: ExtractStage
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current?.script) throw new Error('请先填写文案')
  if (!isPlayReady(project.current.script) && !project.current.script.content?.trim()) {
    throw new Error('请先写完整剧本，再提炼节点')
  }
  const existingSubjects = project.current.subjects ?? []
  const existingScenes = project.current.scenes ?? []
  const extractStartAt = stage || nextExtractStage(project.current)
  if (!extractStartAt) {
    throw new Error('人物、场景和分镜都已提炼。要改某一组，请在对应分组上点「重新提取」。')
  }
  if (extractStartAt === 'shots' && !existingSubjects.length) {
    throw new Error('请先提取人物，再拆分镜')
  }
  if (extractStartAt === 'shots' && !existingScenes.length) {
    throw new Error('请先提取场景描点，再拆分镜')
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
  const keepApproved = Boolean(stage && isPlayApproved(project.current))
  onProgress?.(
    extractStartAt === 'subjects'
      ? `${stage ? '重新提取人物' : '先拆人物'}；已有场景和分镜会保留…`
      : extractStartAt === 'scenes'
        ? `${stage ? '重新提取场景描点' : '人物已保存；继续拆场景'}；已有人物和分镜会保留…`
        : `${stage ? '重新提取分镜' : '人物和场景已保存；继续拆分镜'}；已生成的看板/配图/视频按镜号保留…`
  )
  let finalStagePersisted = false
  const persistStage = async (
    done: ExtractStage,
    partial: import('@/services/ai/storyboard').StoryboardResult
  ) => {
    if (!project.current) return
    if (done === 'subjects') {
      project.setSubjects(mergeSubjectAssets(partial.subjects ?? [], project.current.subjects ?? []))
    } else if (done === 'scenes') {
      project.setScenes(mergeSceneAssets(partial.scenes ?? [], project.current.scenes ?? []))
      if (project.current.script) {
        const script = { ...project.current.script }
        applyAestheticToScript(script, partial)
        project.setScript(script)
      }
    } else {
      finalStagePersisted = true
      const stageShots = storyboardToShots(partial)
      if (project.current.pipelineMode === 'remake') {
        for (const shot of stageShots) shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
      }
      project.setShots(mergeShotAssets(stageShots, project.current.shots))
      rebindShotScenes()
      seedEmptyShotVideoPrompts()
    }
    project.setCanvas(rebuildCanvasGraph(project.current, true))
    const landed =
      done === 'subjects'
        ? `✓ 人物已上画布（${project.current.subjects?.length || 0} 个），本步完成`
        : done === 'scenes'
          ? `✓ 场景已上画布（${project.current.scenes?.length || 0} 个），本步完成`
          : `✓ 分镜已上画布（${project.current.shots.length} 镜），本步完成`
    onProgress?.(landed)
    await project.save()
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
      workflowMode: project.current.script.workflowMode,
      onExtractStage: persistStage
    },
    onProgress,
    signal
  )
  if (extractStartAt === 'shots' && !finalStagePersisted) {
    const shots = storyboardToShots(run.result)
    if (project.current.pipelineMode === 'remake') {
      for (const shot of shots) shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
    }
    project.setShots(mergeShotAssets(shots, project.current.shots))
    rebindShotScenes()
    seedEmptyShotVideoPrompts()
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
  if (!finalStagePersisted || extractStartAt !== 'shots') {
    project.setCanvas(rebuildCanvasGraph(project.current, true))
  }
  if (!keepApproved) project.setPlayApproved(false)
  if (project.dirty) await project.save()
  return run
}

const GROUP_GEN_TYPES = new Set(['subject', 'scene', 'shotBoard', 'shotImage', 'sceneProps', 'shotVideo'])
const IMAGE_GEN_CONCURRENCY = 3

export function groupGenerateJobId(groupId: string) {
  return `${groupId}:gen`
}

function groupChildNodeIds(groupId: string): string[] {
  const nodes = useProjectStore().current?.canvas?.nodes ?? []
  return nodes.filter((n) => n.parentGroupId === groupId && GROUP_GEN_TYPES.has(n.type)).map((n) => n.id)
}

/** 分组标题栏「一键生成」：并行跑这一组下面的全部出图节点。 */
export async function runGenerateGroup(
  groupId: string,
  onProgress?: RunProgress,
  signal?: AbortSignal
) {
  if (
    groupId !== 'group-subjects' &&
    groupId !== 'group-scenes' &&
    groupId !== 'group-shots' &&
    groupId !== 'group-videos'
  ) {
    throw new Error('这个分组不能一键生成')
  }
  const project = useProjectStore()
  const p = project.current
  if (!p?.canvas) throw new Error('画布为空')
  if (!isPlayApproved(p)) throw new Error(PLAY_GATE_MSG)
  const ids = groupChildNodeIds(groupId)
  if (!ids.length) throw new Error('这一组还没有可生成的节点')
  const pending = ids.filter((id) => !isNodeRunning(id))
  if (!pending.length) throw new Error('这一组已在生成中')
  return withNodeJob(groupGenerateJobId(groupId), async () => {
    ensureNotCancelled(signal)
    const source = onProgress ? 'agent' : 'canvas'
    const noun =
      groupId === 'group-subjects'
        ? '人物四视图'
        : groupId === 'group-scenes'
          ? '场景锚点图'
          : groupId === 'group-videos'
            ? '分镜视频'
            : '分镜关键帧'
    const activity = trackActivity(groupId, `一键生成${noun}`, source, (msg) => onProgress?.(groupId, msg))
    try {
      activity.progress(`同时生成 ${pending.length} 个节点…`)
      await mapPool(
        pending,
        groupId === 'group-videos' ? VIDEO_GEN_CONCURRENCY : IMAGE_GEN_CONCURRENCY,
        (id) => runCanvasNode(id, (nid, msg) => onProgress?.(nid, msg), signal)
      )
      activity.done(`${noun}已全部提交`)
    } catch (e: any) {
      activity.fail(e)
      throw e
    }
  })
}

/** 分组标题栏「重新提取」：只重提这一组，不清空其它组。 */
export async function runExtractGroup(
  groupId: string,
  onProgress?: RunProgress,
  signal?: AbortSignal,
  model?: string
) {
  const stage: ExtractStage | undefined =
    groupId === 'group-subjects'
      ? 'subjects'
      : groupId === 'group-scenes'
        ? 'scenes'
        : groupId === 'group-shots' || groupId === 'group-videos'
          ? 'shots'
          : undefined
  if (!stage) throw new Error('这个分组不能重新提取')
  return withNodeJob(groupId, async () => {
    ensureNotCancelled(signal)
    const project = useProjectStore()
    const source = onProgress ? 'agent' : 'canvas'
    const label = `重新提取${extractStageNoun(stage)}`
    const activity = trackActivity(groupId, label, source, (msg) => onProgress?.(groupId, msg))
    patchNode(project, groupId, 'running')
    try {
      await runExtractStoryboard(activity.progress, signal, model, stage)
      patchNode(project, groupId, 'success')
      activity.done(`${extractStageNoun(stage)}已重新写入画布`)
    } catch (e: any) {
      patchNode(project, groupId, 'failed', e?.message ?? String(e))
      activity.fail(e)
      throw e
    }
  })
}

/** 剧本节点动作：默认只写剧本，提炼必须显式传入 extract */
export async function runScriptNode(
  kind: 'play' | 'extract' | 'continue' = 'play',
  onProgress?: RunProgress,
  signal?: AbortSignal,
  model?: string,
  continueHint?: string,
  extractStage?: ExtractStage
) {
  return withNodeJob('script', async () => {
    ensureNotCancelled(signal)
    const project = useProjectStore()
    const source = onProgress ? 'agent' : 'canvas'
    const label = scriptActivityLabel(kind, extractStage)
    const activity = trackActivity('script', label, source, (msg) => onProgress?.('script', msg))
    patchNode(project, 'script', 'running')
    try {
      if (kind === 'extract') {
        await runExtractStoryboard(activity.progress, signal, model, extractStage)
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
    rebindShotScenes()
    seedEmptyShotVideoPrompts()
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
  for (const id of resolvedCanvasReferenceAssetIds(p, node)) {
    const b = (await assets.getBlob(id)) || (await library.getBlob(id))
    if (b) blobs.push(b)
  }
  const look = lookFromScript(p.script)
  const size = { width: p.settings.width, height: p.settings.height }
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
  await saveGeneratedImageToSharedLibrary(result.blob, '其他', asset.filename, prompt, onProgress)
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
  const ids = resolvedCanvasReferenceAssetIds(p, node)
  const videoModel = normalizeVideoGenModel(node.data.videoModel)
  const useFl2va = isH3VideoFamily(videoModel) && normalizeH3GenMode(node.data.h3GenMode) === 'fl2va'
  const firstId = node.data.firstFrameAssetId || ids[0]
  const lastId = node.data.lastFrameAssetId || ids[1]
  if (useFl2va) {
    if (!firstId) throw new Error('请先选首帧')
    if (!lastId) throw new Error('请先选尾帧')
  } else if (!ids.length) {
    throw new Error('请先选至少一张参考图')
  }
  onProgress?.(useFl2va ? '读取首帧和尾帧...' : '读取参考图...')
  const library = useLibraryStore()
  const blobs: Blob[] = []
  if (useFl2va) {
    blobs.push(await loadRefImageBlob(firstId, '首帧'))
    blobs.push(await loadRefImageBlob(lastId, '尾帧'))
  } else {
    for (const id of ids) {
      const b = (await assets.getBlob(id)) || (await library.getBlob(id))
      if (b) blobs.push(b)
    }
    if (!blobs.length) throw new Error('参考图读取失败')
    if (blobs.length < ids.length) {
      onProgress?.(`有 ${ids.length - blobs.length} 张参考图读不到，已跳过`)
    }
  }
  if (p.folderPath) setActiveProjectDir(p.folderPath)
  const duration = clampVideoDuration(node.data.duration, videoModel, 8)
  const imageSlots = blobs.map((_, i) => {
    const index = i + 1
    return {
      index,
      kind: 'extra' as const,
      name: useFl2va
        ? index === 1
          ? 'first frame'
          : 'last frame'
        : index === 1
          ? 'first frame'
          : `user reference ${index}`,
      job: useFl2va
        ? index === 1
          ? `<Picture 1> is the first frame of the target video.`
          : `<Picture 2> is the last frame of the target video.`
        : index === 1
          ? `<Picture 1> is the first frame of the target video.`
          : `<Picture ${index}> is an additional user reference. Match people, clothing, product, setting or style from this image. Do not treat it as another first frame.`
    }
  })
  onProgress?.(
    useFl2va ? '正在出视频（首尾帧）...' : `正在出视频（${blobs.length} 张参考图）...`
  )
  const result = await generateVideo(
    {
      prompt,
      promptAsIs: true,
      imageBlob: blobs[0],
      lastFrameBlob: useFl2va ? blobs[1] : undefined,
      referenceImages: useFl2va ? [] : blobs.slice(1, videoModel === 'wan-prime' ? 10 : 9),
      imageSlots,
      duration,
      width: p.settings.width,
      height: p.settings.height,
      aspectRatio: p.settings.aspectRatio,
      voiceMode: 'none',
      promptStyle: 'scene-narrative',
      videoModel,
      videoResolution: node.data.videoResolution,
      h3GenMode: useFl2va ? 'fl2va' : 'reference',
      mode: 'I2VA',
      signal,
      resumeTaskId: node.data.videoTaskId,
      onTaskSubmitted: async (taskId) => {
        project.patchCanvasNode(nodeId, { videoTaskId: taskId })
        await project.save()
      }
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `${node.data.label || '视频'}.mp4`,
    prompt,
    projectId: p.id
  })
  project.patchCanvasNode(nodeId, { outputAssetId: asset.id, videoTaskId: undefined })
  onProgress?.('视频已写入节点')
  await project.save()
  return asset
}

export async function optimizeFreeformVideoPrompt(nodeId: string, signal?: AbortSignal): Promise<string> {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const p = project.current
  if (!p) throw new Error('没有打开的项目')
  const node = p.canvas?.nodes.find((n) => n.id === nodeId)
  if (!node || node.type !== 'videoGen') throw new Error('找不到图生视频节点')
  const source = (node.data.prompt || '').trim()
  if (!source) throw new Error('请先写提示词')
  const videoModel = normalizeVideoGenModel(node.data.videoModel)
  if (videoModel === 'wan-prime') throw new Error('万相节点不走 H3 格式，直接改提示词即可')
  const ids = resolvedCanvasReferenceAssetIds(p, node)
  const useFl2va = isH3VideoFamily(videoModel) && normalizeH3GenMode(node.data.h3GenMode) === 'fl2va'
  const slotEntries = (
    useFl2va
      ? [
          { kind: 'extra' as const, name: 'first frame' },
          { kind: 'extra' as const, name: 'last frame' }
        ]
      : ids.map((_, i) => ({
          kind: 'extra' as const,
          name: i === 0 ? 'first frame' : `user reference ${i + 1}`
        }))
  )
  const imageSlots = buildH3ImageSlots(slotEntries)
  const cueLines = [...extractSpokenFromNotes(source), ...spokenCueLines(source)].filter(
    (line, i, all) => line && all.indexOf(line) === i
  )
  const hasSpeech = cueLines.length > 0 || nodeTextHasSpeech(source)
  const silent = !hasSpeech && nodeTextForbidsSpeech(source)
  const compiled = await compileH3OfficialPrompt({
    prompt: `【节点当前提示词，改写以此为准】\n${source}`,
    aesthetic: p.script?.h3Aesthetic || p.script?.aesthetic,
    voiceover: cueLines.join('\n'),
    voiceMode: silent || !hasSpeech ? 'none' : 'dialogue',
    imageAssignments: imageSlots.map((slot) => slot.job),
    imageSlots,
    duration: clampVideoDuration(node.data.duration, videoModel, 8),
    width: p.settings.width,
    height: p.settings.height,
    aspectRatio: p.settings.aspectRatio,
    cameraMovement: 'static',
    promptStyle: getVideoPromptStyle(),
    mode: useFl2va ? 'I2VA' : 'R2VA',
    forceIntegrated: true,
    signal
  })
  project.patchCanvasNode(nodeId, { prompt: compiled })
  await project.save()
  return compiled
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
      } else if (node.type === 'sceneProps' && node.data.sceneId) {
        const scn = (p.scenes ?? []).find((s) => s.id === node.data.sceneId)
        if (!scn) throw new Error('找不到场景')
        await generateScenePropSheet(scn, report, signal)
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
        const shot = project.current?.shots.find((s) => s.id === node.data.shotId)
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
  const props = (p.scenes ?? [])
    .filter((s) => sceneHasKeyProps(s) && !s.propSheetAssetId)
    .map((s) => `sceneProps:${s.id}`)
  await mapPool(props, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}

export async function generateMissingBoards(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const boardIds = shotsMissingStoryboard(p).map((s) => `shotBoard:${s.id}`)
  if (boardIds.length) {
    await mapPool(boardIds, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
  }
  await generateMissingImages(onProgress, signal)
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
  const ids = shotsMissingKeyframe(p).map((s) => `shotImage:${s.id}`)
  if (!ids.length) return
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
  const ids = p.shots.filter((s) => needsExternalTts(s, p) && !s.audioAssetId).map((s) => `audio:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}
