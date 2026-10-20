import {
  useProjectStore,
  useAssetsStore,
  useSettingsStore,
  useLibraryStore,
  useScriptsStore
} from '@/stores'
import {
  generateImage,
  generateVideo,
  generateSpeech,
  generateStoryboard,
  generatePlay,
  storyboardToShots,
  applyAestheticToScript,
  isPlayReady,
  buildH3ImageSlots,
  spokenTextOnly,
  compileH3OfficialPrompt,
  extractSpokenFromNotes,
  spokenCueLines,
  ensurePictureIdentity,
  compiledH3PromptNeedsRebuild,
  enrichVideoPerformance,
  reviewImageQuality,
  reviewVideoQuality,
  reviewSpeechQuality,
  analyzeRemakeVideo,
  remakeShotsFromAnalysis,
  extractTargetDurationSec,
  bindShotVoiceHints,
  FALLBACK_VOICE_PROMPT,
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
import { stillModeForShot, shotsMissingKeyframe, shotsMissingStoryboard, needsShotFrames, shotUsesFrames } from '@/utils/videoStill'
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
import { rebuildCanvasGraph, absoluteCanvasPosition, nextFreeformPosition, NODE_W } from './layout'
import { emitCanvasActivity, revealCanvas, selectCanvasNode } from './canvasBridge'
import { extractStageLabel, extractStageNoun, nextExtractStage, type ExtractStage } from './pipeline'
import { friendlyAiError } from '@/services/ai/abort'
import { lookFromScript, lookFromTexts, styleLabel, inferVisualStyleFromText } from '@/utils/visualStyle'
import { aspectToSize } from '@/utils/aspect'
import {
  boardSendPrompt,
  scenePropSendPrompt,
  sceneSendPrompt,
  shotImageSendPrompt,
  defaultShotImagePrompt,
  shotFrameSendPrompt,
  shotVoiceBlock,
  subjectSendPrompt,
  videoSendPrompt,
  shotDirectorBrief
} from '@/utils/nodePrompt'
import { playTitleOf, topicFromBrief } from '@/utils/storyBrief'
import { isNodeRunning, mapPool, withNodeJob, VIDEO_GEN_CONCURRENCY } from './jobs'
import { isPlayApproved, PLAY_GATE_MSG } from './playGate'
import { generateFinalCut } from './exportFinal'
import { setActiveProjectDir } from '@/services/storage'
import { toDigitalHumanWav, extractVideoLastFrame } from '@/services/ffmpeg'
import type { AspectRatio, CanvasNode, ID, Project, Scene, Shot, Subject, VideoGenModel, VideoResolution } from '@/types'
import {
  isH3VideoFamily,
  normalizeH3GenMode,
  normalizeVideoGenModel,
  normalizeVideoResolution,
  videoMaxRefImages,
  videoMaxSeconds,
  videoMinSeconds
} from '@/types'
import { canvasReferenceSlotEntries, resolvedCanvasReferenceAssetIds } from '@/services/canvas/references'

export type RunProgress = (nodeId: string, msg: string) => void
export type NodeRunOpts = { hd?: boolean }

let pendingRun: NodeRunOpts = {}

function evenPx(n: number) {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v + 1
}

function imageGenSize(kind: 'shot' | 'sheet' | 'scene', aspectRatio?: AspectRatio) {
  const project = useProjectStore()
  const hd = Boolean(pendingRun.hd)
  if (kind === 'sheet') {
    return hd ? { width: 2560, height: 1440 } : { width: 1792, height: 1024 }
  }
  const base = aspectRatio
    ? aspectToSize(aspectRatio)
    : {
        width: project.current?.settings.width ?? 1280,
        height: project.current?.settings.height ?? 720
      }
  const w = base.width
  const h = base.height
  if (!hd) return { width: w, height: h }
  const scale = Math.max(1, 2048 / Math.max(w, h))
  return { width: evenPx(w * scale), height: evenPx(h * scale) }
}

function canvasNodeAspect(node: CanvasNode | undefined, fallback: AspectRatio): AspectRatio {
  return node?.data.aspectRatio ?? fallback
}

function shotNodeAspect(
  project: NonNullable<ReturnType<typeof useProjectStore>['current']>,
  shotId: string,
  type: 'shotBoard' | 'shotImage' | 'shotVideo'
): AspectRatio {
  return canvasNodeAspect(
    project.canvas?.nodes.find((node) => node.type === type && node.data.shotId === shotId),
    project.settings.aspectRatio
  )
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

/** 剧本正文指纹：断点标记只在同一段剧本上复用，文本一变就作废。 */
function scriptPlayKey(content: string): string {
  const text = String(content || '')
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return `${text.length}-${(hash >>> 0).toString(36)}`
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
  const aspectRatio = shotNodeAspect(project.current, shot.id, 'shotBoard')
  const size = imageGenSize('shot', aspectRatio)
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio,
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
  const aspectRatio = shotNodeAspect(project.current, shot.id, 'shotImage')
  const size = imageGenSize('shot', aspectRatio)
  const result = await generateImage(
    {
      prompt,
      style,
      width: size.width,
      height: size.height,
      aspectRatio,
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

/** 本镜出场人物 + 所在场景的参考图，用来合成首尾帧。看板模式再带上故事看板。 */
async function collectFrameRefBlobs(
  shot: Shot,
  project: Project,
  onProgress?: (msg: string) => void
): Promise<{ blobs: Blob[]; labels: string[] }> {
  const assets = useAssetsStore()
  const library = useLibraryStore()
  // 帧图要的是「这一格画面长什么样」，所以用完整参考包（四视图 + 道具 + 场景底板），
  // 不用四宫格关键帧 —— 那是网格版式，拿来当首尾帧会把宫格画进去。
  const bundle = collectShotRefIds(shot, project)
  const blobs: Blob[] = []
  const labels: string[] = []
  for (let i = 0; i < bundle.ids.length; i++) {
    const blob = (await assets.getBlob(bundle.ids[i])) || (await library.getBlob(bundle.ids[i]))
    if (!blob) continue
    blobs.push(blob)
    labels.push(bundle.labels[i])
  }
  if (!blobs.length) {
    onProgress?.('没有人物/场景参考图，先按分镜描述直接画帧。')
  }
  return { blobs, labels }
}

/** 画一张帧图并落到资源库 */
async function renderShotFrame(
  shot: Shot,
  which: 'start' | 'end',
  blobs: Blob[],
  labels: string[],
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const prompt = shotFrameSendPrompt(shot, project.current, which)
  const look = lookFromScript(project.current.script)
  const aspectRatio = shotNodeAspect(project.current, shot.id, 'shotImage')
  const size = imageGenSize('shot', aspectRatio)
  const word = which === 'start' ? '起始帧' : '结束帧'
  onProgress?.(`画这一镜的${word}（${blobs.length} 张人物/场景参考）...`)
  const fail = (e: any) => {
    const reason = friendlyAiError(e) || e?.message || '未知原因'
    // 把失败定位到「第几镜的哪一张帧」，否则节点上只显示一句笼统的失败
    return new Error(`第 ${shot.index + 1} 镜${word}没画出来：${reason}`)
  }
  let result
  try {
    result = await generateImage(
      {
        prompt,
        style: look.style,
        width: size.width,
        height: size.height,
        aspectRatio,
        referenceImages: blobs.length ? blobs : undefined,
        referenceLabels: labels.length ? labels : undefined,
        model: imageModelForProject(project.current.pipelineMode),
        signal
      },
      onProgress
    )
  } catch (e: any) {
    throw fail(e)
  }
  onProgress?.(`校验${word}文件...`)
  const quality = await reviewImageQuality(result.blob, prompt, signal)
  if (!quality.passed) throw fail(new Error(`${word}文件无效：${quality.issues.join('；')}`))
  try {
    const asset = await assets.add(result.blob, 'image', 'ai-generated', {
      filename: `shot${shot.index + 1}_${which}frame_${Date.now().toString(36)}`,
      prompt,
      projectId: project.current.id,
      shotId: shot.id
    })
    return asset
  } catch (e: any) {
    throw fail(e)
  }
}

/**
 * 首尾帧：用本镜的人物 + 场景，专门合成「开始这一帧」和「结束这一帧」。
 * 结束帧把刚画好的起始帧也当参考图，保证同一镜内脸、服装、机位、光线一致；
 * 起始帧则把上一镜的结束帧带上，让镜与镜之间接着走。
 */
export async function generateShotFramePair(
  shot: Shot,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const rebound = boundSubjectIds(shot, project.current.subjects ?? [])
  if (rebound.length) {
    project.updateShot(shot.id, { subjectIds: rebound })
    shot = refreshShot(shot.id)
  }
  // 补依赖只为了让帧图更准，不是画帧的前提：哪一张没补上都只记一笔，照常画帧。
  // 以前这里一失败整对帧就没了，界面上表现为「点了生成、什么都没出来」。
  // 首尾帧镜头不补故事看板——视频吃的就是这两张帧，看板在这条链路里是多余的。
  try {
    if (videoRequiresStoryboard(project.current) && !shotUsesFrames(shot, project.current) && !shot.boardAssetId) {
      await generateShotBoard(shot, onProgress, signal)
      shot = refreshShot(shot.id)
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
      shot = refreshShot(shot.id)
    }
  } catch (e: any) {
    onProgress?.(`依赖没补齐（${friendlyAiError(e) || e?.message || '未知原因'}），先按现有参考画帧。`)
    shot = refreshShot(shot.id)
  }
  const { blobs, labels } = await collectFrameRefBlobs(shot, project.current, onProgress)

  // 起始帧：带上上一镜的结束帧，衔接从上一镜的画面接着走
  const ordered = [...project.current.shots].sort((a, b) => a.index - b.index)
  const pos = ordered.findIndex((item) => item.id === shot.id)
  const prevShot = pos > 0 ? ordered[pos - 1] : undefined
  const prevTailId = pos > 0 ? prevShot?.lastFrameAssetId : undefined
  const startBlobs = [...blobs]
  const startLabels = [...labels]
  if (prevTailId) {
    const tail = await tryLoadRefImageBlob(prevTailId)
    if (tail) {
      startBlobs.push(tail)
      startLabels.push('the last frame of the previous shot; continue from this exact framing and lighting')
    }
  }
  const startAsset = await renderShotFrame(shot, 'start', startBlobs, startLabels, onProgress, signal)
  project.updateShot(shot.id, { firstFrameAssetId: startAsset.id })
  shot = refreshShot(shot.id)
  await project.save()

  // 结束帧：把刚画好的起始帧放进去，锁住同一镜的人物、机位和光线
  const startBlob = await assets.getBlob(startAsset.id)
  const endBlobs = startBlob ? [...blobs, startBlob] : [...blobs]
  const endLabels = [
    ...labels,
    'the first frame of this same shot; keep identical camera, lens, outfit and lighting'
  ]
  const endAsset = await renderShotFrame(shot, 'end', endBlobs, endLabels, onProgress, signal)
  const patch: Partial<Shot> = { lastFrameAssetId: endAsset.id }
  if (!shot.startFramePrompt?.trim()) patch.startFramePrompt = shotFrameSendPrompt(shot, project.current, 'start')
  if (!shot.endFramePrompt?.trim()) patch.endFramePrompt = shotFrameSendPrompt(shot, project.current, 'end')
  project.updateShot(shot.id, patch)
  await project.save()
  onProgress?.('起始帧和结束帧都已生成，可以直接出视频了。')
  return { first: startAsset, last: endAsset }
}

/** 只重画一张帧（起始帧或结束帧） */
export async function regenerateShotFrame(
  shot: Shot,
  which: 'start' | 'end',
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  shot = refreshShot(shot.id)
  const { blobs, labels } = await collectFrameRefBlobs(shot, project.current, onProgress)
  if (which === 'end') {
    const firstId = shot.firstFrameAssetId
    const first = firstId ? await tryLoadRefImageBlob(firstId) : undefined
    if (first) {
      blobs.push(first)
      labels.push('the first frame of this same shot; keep identical camera, lens, outfit and lighting')
    }
  } else {
    const ordered = [...project.current.shots].sort((a, b) => a.index - b.index)
    const pos = ordered.findIndex((item) => item.id === shot.id)
    const prevTailId = pos > 0 ? ordered[pos - 1]?.lastFrameAssetId : undefined
    const tail = prevTailId ? await tryLoadRefImageBlob(prevTailId) : undefined
    if (tail) {
      blobs.push(tail)
      labels.push('the last frame of the previous shot; continue from this exact framing and lighting')
    }
  }
  const asset = await renderShotFrame(shot, which, blobs, labels, onProgress, signal)
  const old = which === 'start' ? shot.firstFrameAssetId : shot.lastFrameAssetId
  if (old && old !== asset.id) await assets.remove(old).catch(() => undefined)
  project.updateShot(
    shot.id,
    which === 'start' ? { firstFrameAssetId: asset.id } : { lastFrameAssetId: asset.id }
  )
  await project.save()
  return asset
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
  // 走首尾帧的镜头视频直接吃起始帧/结束帧，出片前不再补关键帧/看板
  const stillMode = stillModeForShot(shot, project.current)
  if (!shotUsesFrames(shot, project.current) && stillMode === 'storyboard' && !shot.boardAssetId) {
    onProgress?.('先补本镜故事看板…')
    await generateShotBoard(shot, onProgress, signal)
  } else if (!shotUsesFrames(shot, project.current) && stillMode === 'keyframe' && !shot.imageAssetId) {
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
  const aspectRatio = shotNodeAspect(p, shot.id, 'shotVideo')
  const videoSize = aspectToSize(aspectRatio)
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
      width: videoSize.width,
      height: videoSize.height,
      aspectRatio,
      cameraMovement: 'static',
      audioBlob: speechBlob,
      audioSync: true,
      promptAsIs: true,
      mode: 'I2VA',
      videoProfileId: shot.videoProfileId,
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

/** 软读取参考图：图丢了/读不出来就当没有，不抛错。用于「有就用、没有就降级」的场景。 */
async function tryLoadRefImageBlob(id: ID): Promise<Blob | undefined> {
  const assets = useAssetsStore()
  const library = useLibraryStore()
  try {
    return (await assets.getBlob(id)) || (await library.getBlob(id)) || undefined
  } catch {
    return undefined
  }
}

function canvasVideoNodeForShot(shot: Shot) {
  return useProjectStore().current?.canvas?.nodes.find(
    (n) => n.type === 'shotVideo' && n.data.shotId === shot.id
  )
}

function canvasVideoModelForShot(shot: Shot): VideoGenModel {
  const nodeModel = canvasVideoNodeForShot(shot)?.data.videoModel
  if (nodeModel) return normalizeVideoGenModel(nodeModel)
  // 节点没单独选过时，跟「创作偏好」里选的默认视频模型走
  const preferred = useSettingsStore().config.defaultVideoModel
  if (preferred) return normalizeVideoGenModel(preferred)
  return normalizeVideoGenModel(undefined)
}

function canvasVideoResolutionForShot(shot: Shot, videoModel: VideoGenModel): VideoResolution {
  return normalizeVideoResolution(canvasVideoNodeForShot(shot)?.data.videoResolution, videoModel)
}

function clampVideoDuration(raw: number | undefined, videoModel: VideoGenModel, fallback = 5) {
  const min = videoMinSeconds(videoModel)
  const max = videoMaxSeconds(videoModel)
  return Math.min(max, Math.max(min, Math.round(raw || fallback)))
}

function storyboardVideoModel(): VideoGenModel {
  const p = useProjectStore().current
  const existing = p?.canvas?.nodes.find((node) => node.type === 'shotVideo')
  if (existing?.data.videoModel) return normalizeVideoGenModel(existing.data.videoModel)
  const preferred = useSettingsStore().config.defaultVideoModel
  if (preferred) return normalizeVideoGenModel(preferred)
  const cfg = useSettingsStore().config.video
  const marker = `${cfg.provider || ''} ${cfg.workflowId || ''} ${cfg.adapter?.type || ''}`.toLowerCase()
  if (/dashscope|wan/.test(marker)) return 'wan-prime'
  if (/h3.*v5/.test(marker) && !/15s/.test(marker)) return 'h3-v5'
  return 'h3'
}

function shotUsesFl2va(shot: Shot, videoModel: VideoGenModel): boolean {
  return videoModel !== 'wan-prime' && normalizeH3GenMode(shot.h3GenMode) === 'fl2va'
}

/**
 * 项目级「首尾帧链」是否开启。
 * 这个模式下第 N 镜的首帧来自第 N-1 镜视频的末帧，所以镜头之间必须串行：
 * 并发提交时上一镜还没出片，首帧只能落回本镜配图，连续性直接断掉。
 */
export function isFl2vaChainActive(project?: { settings?: { h3ShotChainMode?: 'auto' | 'fl2va' } } | null): boolean {
  return (project?.settings?.h3ShotChainMode || 'auto') === 'fl2va'
}

/** 首尾帧链：本镜出片成功后，把末帧固化成下一镜的首帧（不覆盖用户手动指定的首帧）。 */
async function chainLastFrameToNextShot(
  shot: Shot,
  videoAssetId: ID,
  onProgress?: (msg: string) => void
) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) return
  const ordered = [...p.shots].sort((a, b) => a.index - b.index)
  const next = ordered.find((s) => s.index === shot.index + 1)
  if (!next) return
  // 用户自己挑过的首帧不动；上一次自动固化的末帧已经过期（本镜重跑过），要换掉
  const existing = next.firstFrameAssetId
  if (existing) {
    const meta = assets.getMeta(existing)
    const autoChained = Boolean(meta && /^shot\d+_lastframe_/.test(meta.filename || ''))
    if (!autoChained) return
    await assets.remove(existing).catch(() => undefined)
  }
  const blob = await assets.getBlob(videoAssetId)
  if (!blob) return
  try {
    onProgress?.('截取本镜末帧，接到下一镜首帧…')
    const frame = await extractVideoLastFrame(blob)
    const asset = await assets.add(frame, 'image', 'ai-generated', {
      filename: `shot${shot.index + 1}_lastframe_${Date.now().toString(36)}`,
      projectId: p.id,
      shotId: shot.id
    })
    project.updateShot(next.id, { firstFrameAssetId: asset.id })
    await project.save()
    onProgress?.(`第 ${next.index + 1} 镜首帧已用第 ${shot.index + 1} 镜末帧`)
  } catch (e: any) {
    // 抽帧失败不影响本镜结果，下一镜仍会实时从上一镜视频里截
    onProgress?.(`末帧固化失败，下一镜出片时会实时截取：${e?.message || e}`)
  }
}

/** 把画布节点按镜号排序，保证首尾帧链从第一镜开始依次推进 */
function sortNodeIdsByShotIndex(p: Project, ids: string[]): string[] {
  const indexByShot = new Map(p.shots.map((s) => [s.id, s.index]))
  const rank = (id: string) => {
    const node = p.canvas?.nodes?.find((n) => n.id === id)
    const sid = node?.data?.shotId
    const idx = sid ? indexByShot.get(sid) : undefined
    return idx ?? Number.MAX_SAFE_INTEGER
  }
  return [...ids].sort((a, b) => rank(a) - rank(b))
}

/** 这张图还被别处用着吗？决定「重截尾帧」时旧图能不能顺手清掉。 */
function assetStillInUse(p: Project, assetId: ID): boolean {
  for (const n of p.canvas?.nodes ?? []) {
    if (n.data.outputAssetId === assetId) return true
    if ((n.data.referenceAssetIds ?? []).includes(assetId)) return true
    if (n.data.firstFrameAssetId === assetId || n.data.lastFrameAssetId === assetId) return true
  }
  for (const s of p.shots ?? []) {
    if (
      s.imageAssetId === assetId ||
      s.boardAssetId === assetId ||
      s.firstFrameAssetId === assetId ||
      s.lastFrameAssetId === assetId
    ) {
      return true
    }
  }
  return false
}

/**
 * 截取视频最后一帧，在视频节点旁边落一个图片节点。
 * 这张图可以当下一段的首帧、当参考图继续生图，也可以单独下载再加工。
 * 同一个视频重复截取时只刷新那一个节点，不会堆出一串重复节点。
 */
export async function grabVideoLastFrameNode(
  nodeId: string,
  onProgress?: (msg: string) => void
): Promise<ID> {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p?.canvas) throw new Error('画布还没有准备好')
  const node = p.canvas.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error('找不到这个视频节点')
  const shot = node.data.shotId ? p.shots.find((s) => s.id === node.data.shotId) : undefined
  const videoId =
    node.type === 'final' || node.type === 'export' ? p.finalVideoAssetId : shot?.videoAssetId
  if (!videoId) throw new Error('这个节点还没有视频，先生成视频再截取尾帧')
  const blob = await assets.getBlob(videoId)
  if (!blob) throw new Error('视频读取失败')
  onProgress?.('截取最后一帧…')
  const frame = await extractVideoLastFrame(blob)
  const asset = await assets.add(frame, 'image', 'extracted', {
    filename: `lastframe_${shot ? `shot${shot.index + 1}_` : ''}${Date.now().toString(36)}`,
    projectId: p.id,
    shotId: shot?.id
  })

  const frameNodeId = `lastFrame:${node.id}`
  const label = shot ? `第 ${shot.index + 1} 镜 · 尾帧` : '成片尾帧'
  const existing = p.canvas.nodes.find((n) => n.id === frameNodeId)
  if (existing) {
    const old = existing.data.outputAssetId
    existing.data = { ...existing.data, label, outputAssetId: asset.id }
    existing.status = 'success'
    existing.error = undefined
    if (old && old !== asset.id && !assetStillInUse(p, old)) {
      await assets.remove(old).catch(() => undefined)
    }
  } else {
    // 落在自由创作区最右侧，纵向跟这个视频对齐——一眼看出是哪一镜截出来的，
    // 又不会压到右边的口播/合成分组上。
    const abs = absoluteCanvasPosition(p.canvas.nodes, node)
    const groups = p.canvas.nodes.filter((n) => n.type === 'groupFrame')
    const right = groups.length
      ? Math.max(...groups.map((g) => g.position.x + (Number(g.data.width) || NODE_W)))
      : abs.x + NODE_W
    const pos = nextFreeformPosition(p.canvas.nodes, { click: { x: right + 48, y: abs.y } })
    p.canvas.nodes = [
      ...p.canvas.nodes,
      {
        id: frameNodeId,
        type: 'imageGen',
        position: { x: pos.x, y: pos.y },
        data: {
          label,
          prompt: '',
          referenceAssetIds: [],
          referenceSourceNodeIds: [],
          aspectRatio: p.settings.aspectRatio,
          outputAssetId: asset.id
        },
        status: 'success'
      }
    ]
    const edgeId = `e-${node.id}-${frameNodeId}`
    if (!p.canvas.edges.some((e) => e.id === edgeId)) {
      p.canvas.edges = [
        ...p.canvas.edges,
        {
          id: edgeId,
          source: node.id,
          target: frameNodeId,
          sourceHandle: 'out',
          targetHandle: 'in'
        }
      ]
    }
  }
  await project.save()
  selectCanvasNode(frameNodeId)
  revealCanvas(frameNodeId)
  onProgress?.('尾帧已放进视频旁边的图片节点')
  return frameNodeId
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
  if (!(shot.compiledVideoPrompt || '').trim()) {
    throw new Error('图生视频提示词为空。请自己填写，或主动点击“优化提示词 / 按分镜重铺”；系统不会自动回填。')
  }
  const aspectRatio = shotNodeAspect(project.current, shot.id, 'shotVideo')
  const videoSize = aspectToSize(aspectRatio)
  if (
    project.current.pipelineMode === 'smart-speech' &&
    project.current.speechWorkflow?.mode === 'digital-human'
  ) {
    return regenerateDigitalHumanShot(shot, onProgress, signal)
  }
  const videoModel = canvasVideoModelForShot(shot)
  const chainFl2va =
    videoModel !== 'wan-prime' &&
    (project.current.settings.h3ShotChainMode || 'auto') === 'fl2va'
  const perShotFl2va = shotUsesFl2va(shot, videoModel)
  // 链模式凑不齐首尾帧时降级出片，但首帧（上一镜末帧）仍然要带进常规流程，
  // 否则「首尾帧链」一降级就断成互不相干的镜头。
  let chainFirstBlob: Blob | undefined
  if (perShotFl2va || chainFl2va) {
    const ordered = [...project.current.shots].sort((a, b) => a.index - b.index)
    // 按真实位置找前后镜与首尾，别拿 index 硬算：删过镜头后 index 可能不连续。
    const pos = ordered.findIndex((item) => item.id === shot.id)
    const prevShot = pos > 0 ? ordered[pos - 1] : undefined
    const nextShot = pos >= 0 && pos + 1 < ordered.length ? ordered[pos + 1] : undefined
    const isFirstShot = pos === 0
    // 首帧优先级：手动选的首帧 > 上一镜视频末帧（链模式，保证镜头连续） > 本镜配图
    // 读图一律用软读取：图丢了只当没有这张图，不能让「资源缺失」变成整条链路的阻断。
    let firstBlob: Blob | undefined
    if (shot.firstFrameAssetId) {
      firstBlob = await tryLoadRefImageBlob(shot.firstFrameAssetId)
    }
    if (!firstBlob && chainFl2va && !isFirstShot) {
      const prevVideoId = prevShot?.videoAssetId
      const prevVideoBlob = prevVideoId ? await assets.getBlob(prevVideoId) : undefined
      if (prevVideoBlob) {
        onProgress?.('截取上一镜视频末帧作为本镜首帧…')
        firstBlob = await extractVideoLastFrame(prevVideoBlob).catch(() => undefined)
      } else {
        onProgress?.('上一镜还没有视频，先落回本镜配图作为首帧。')
      }
    }
    if (!firstBlob && shot.imageAssetId) {
      firstBlob = await tryLoadRefImageBlob(shot.imageAssetId)
    }
    if (!firstBlob) {
      // 手动模式是用户在这一镜上明说的意图，缺首帧必须拦住并说清怎么解决。
      // 项目级「首尾帧链」只是出片增强：缺帧就安静退回常规出片，
      // 绝不能因为没有首帧就把整个项目锁成「一个视频都出不了」。
      if (perShotFl2va) {
        throw new Error(
          '这一镜手动开了首尾帧模式，还缺首帧。请在节点上选一张首帧图，或把生成模式改回「参考图」。'
        )
      }
      onProgress?.(
        isFirstShot
          ? '第 1 镜没有首帧也没有配图：首尾帧链在这一镜起不了头，先用常规方式出片。'
          : '本镜没有可用首帧（上一镜还没出视频、本镜也没配图）：先用常规方式出片。'
      )
    }
    // 尾帧优先级：手动选的尾帧 > 下一镜配图（链模式，给下一镜留衔接落点）
    let lastBlob: Blob | undefined
    if (shot.lastFrameAssetId) {
      lastBlob = await tryLoadRefImageBlob(shot.lastFrameAssetId)
    }
    if (!lastBlob && chainFl2va) {
      // 下一镜的配图、或下一镜已经被链固化过的首帧，都能当作本镜尾帧的落点
      const tailId = nextShot?.imageAssetId || nextShot?.firstFrameAssetId
      if (tailId) lastBlob = await tryLoadRefImageBlob(tailId)
    }
    if (!lastBlob) {
      if (perShotFl2va) {
        throw new Error(
          '这一镜手动开了首尾帧模式，还缺尾帧。请在节点上选一张尾帧图，或把生成模式改回「参考图」。'
        )
      }
      if (firstBlob) onProgress?.('没有可用尾帧（下一镜还没配图）：本镜用首帧按常规方式出片。')
    }
    if (firstBlob && lastBlob) {
      onProgress?.('读取首帧和尾帧…')
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
          speakerVoice: resolveShotSpeakerVoice(shot, project.current),
          speakerName: visibleSpeaker,
          onScreenNames,
          sceneName: place.name,
          sceneLighting: place.lighting,
          shotTitle: shot.title,
          duration: clampVideoDuration(shot.duration, videoModel),
          width: videoSize.width,
          height: videoSize.height,
          aspectRatio,
          cameraMovement: shot.cameraMovement,
          promptStyle,
          videoModel: 'h3',
          videoProfileId: shot.videoProfileId,
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
      if (chainFl2va) await chainLastFrameToNextShot(shot, asset.id, onProgress)
      return asset
    }
    // 链模式这里没走成首尾帧：把已经拿到的首帧留给常规流程，别让衔接断掉
    if (chainFl2va && firstBlob) chainFirstBlob = firstBlob
  }
  shot = await ensureShotVideoRefs(shot, onProgress, signal)

  const stillMode = stillModeForShot(shot, project.current)
  const allEntries = collectShotVideoEntries(shot, project.current)
  let packed = packVideoRefEntries(allEntries)
  if (chainFirstBlob) {
    // 把上一镜末帧固化成一张参考图并排在最前，常规出片也从它起手
    try {
      const chained = await assets.add(chainFirstBlob, 'image', 'ai-generated', {
        filename: `shot${shot.index + 1}_chainstart_${Date.now().toString(36)}`,
        projectId: project.current.id,
        shotId: shot.id
      })
      packed = [
        {
          id: chained.id,
          kind: 'extra',
          name: '上一镜末帧',
          label: 'starting frame of [Shot 1]; the exact image this shot must begin from'
        },
        ...packed.filter((entry) => entry.id !== chained.id)
      ]
      onProgress?.('已把上一镜末帧作为首位参考图，保持镜头衔接。')
    } catch {
      // 固化失败就算了，常规流程照常出片
    }
  }
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
      speakerVoice: resolveShotSpeakerVoice(shot, project.current),
      speakerName: visibleSpeaker,
      onScreenNames,
      sceneName: place.name,
      sceneLighting: place.lighting,
      shotTitle: shot.title,
      imageAssignments,
      imageSlots,
      duration: clampVideoDuration(shot.duration, videoModel),
      width: videoSize.width,
      height: videoSize.height,
      aspectRatio,
      cameraMovement: shot.cameraMovement,
      promptStyle,
      videoModel,
      videoProfileId: shot.videoProfileId,
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
    prompt: result.prompt,
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
  const aspectRatio = shotNodeAspect(p, shot.id, 'shotVideo')
  const videoSize = aspectToSize(aspectRatio)
  const packed = packVideoRefEntries(collectShotVideoEntries(shot, p))
  const imageSlots = buildH3ImageSlots(packed)
  const cast = subjectsForShot(shot, p)
  const scene = sceneForShot(shot, p)
  const place = resolveShotPlace(shot, scene)
  const onScreenNames = cast.map((item) => item.name)
  const nodeText = (shot.compiledVideoPrompt || '').trim()
  const usableNodeText = nodeText && !compiledH3PromptNeedsRebuild(nodeText) ? nodeText : ''
  const performance = (shot.videoPrompt || '').trim()
  const brief = shotDirectorBrief(shot, p)
  const source = [
    performance ? `【本镜场记，剧情与动作以此为准，不是台词】\n${performance}` : '',
    brief ? `【分镜字段与可见画面，补足具体道具、空间和动作】\n${brief}` : '',
    usableNodeText ? `【用户保留的已有成片稿，只吸收其中独有的有效细节】\n${usableNodeText}` : '',
    shot.voiceover?.trim() ? `【口播栏，只有这里和引号里的原词才是台词】\n${shot.voiceover.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  // 台词只从口播栏 + 场记里的引号/「台词：」抠；绝不从旧编译稿的 <d> 或场记正文回收
  const speechSource = [
    shot.voiceover || '',
    performance.replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, ''),
    // 旧稿里的引号对白可以保留，但去掉整段场记式中文
    usableNodeText
      .replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '')
      .replace(/Reference pictures[\s\S]*?(?=\[Shot\s*\d+\]|Camera language|$)/i, '')
  ]
    .filter(Boolean)
    .join('\n')
  const cueLines = [...extractSpokenFromNotes(speechSource), ...spokenCueLines(shot.voiceover || '')].filter(
    (line, i, all) => line && all.indexOf(line) === i
  )
  const hasSpeech = cueLines.length > 0
  const silent = !hasSpeech
  const resolvedVoice = resolveH3VoiceMode(shot, onScreenNames)
  const voiceMode = silent ? 'none' : resolvedVoice === 'voiceover' ? 'voiceover' : 'dialogue'
  const visibleSpeaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  const castNotes = cast
    .map((item, i) => {
      const look = [item.role, item.description].filter(Boolean).join('。')
      return `S${i + 1} ${item.name}${look ? `：${look}` : ''}`
    })
    .join('\n')
  const compiled = ensurePictureIdentity(
    await compileH3OfficialPrompt({
    prompt: [source, castNotes ? `人物（必须写清图1图2图3分别是谁；正文用这些人名。场记不是台词，只有引号/对白栏里的原词才进 <d>）：\n${castNotes}` : '']
      .filter(Boolean)
      .join('\n\n'),
    aesthetic: p.script?.h3Aesthetic || p.script?.aesthetic,
    audioDescription: shot.audioDescription,
    voiceover: cueLines.length ? cueLines.join('\n') : '',
    voiceMode,
    speakerHint: shot.speakerHint,
    speakerVoice: resolveShotSpeakerVoice(shot, project.current),
    voiceRoster: shotVoiceBlock(shot, project.current),
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
    width: videoSize.width,
    height: videoSize.height,
    aspectRatio,
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
  }),
    { prompt: '', imageSlots, duration: shot.duration }
  )
  project.setShotVideoPrompt(shot.id, compiled)
  await project.save()
  return compiled
}

/**
 * 本镜说话角色的音色描述。人物卡上的 voicePrompt 优先（用户改了音色立刻生效），
 * 卡上没有时退回拆分镜时绑定的 shot.speakerVoice。生成视频一定带上它。
 */
function resolveShotSpeakerVoice(shot: Shot, p: Project): string | undefined {
  const fromCard = speakerSubject(shot, p)?.voicePrompt?.trim()
  if (fromCard) return fromCard
  return shot.speakerVoice?.trim() || undefined
}

/** 口播「名字：台词」里的说话人 → 匹配角色卡（有语音设置的角色） */
function speakerSubject(shot: Shot, p: Project): Subject | undefined {
  const speaker = (shot.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
  if (!speaker) return undefined
  const subjects = p.subjects ?? []
  const exact = subjects.find((s) => s.name.trim() === speaker)
  if (exact) return exact
  return subjects.find((s) => {
    const name = s.name.trim()
    return name && (speaker.includes(name) || name.includes(speaker))
  })
}

export async function generateShotAudio(shot: Shot, onProgress?: (msg: string) => void, signal?: AbortSignal) {
  ensureNotCancelled(signal)
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  if (!needsExternalTts(shot, project.current)) throw new Error('该分镜未选择后期 TTS，不需要生成独立配音')
  const text = spokenTextOnly(shot.voiceover || '')
  if (!text) throw new Error('该分镜没有口播文案')
  const p = project.current
  const speaker = speakerSubject(shot, p)
  let blob: Blob
  if (speaker?.voiceRefAssetId || speaker?.clonedVoiceId) {
    // 角色卡带了参考音频：走声音复刻（百炼 Qwen3-TTS-VC），首次自动复刻并回填音色 ID
    let voiceId = speaker.clonedVoiceId
    let voiceModel = speaker.clonedVoiceModel || 'qwen3-tts-vc-2026-01-22'
    if (!voiceId) {
      onProgress?.(`复刻「${speaker.name}」的音色...`)
      const sampleBlob = await assets.getBlob(speaker.voiceRefAssetId!)
      if (!sampleBlob) throw new Error(`「${speaker.name}」的参考音频读取失败，请在角色卡上重新上传`)
      const cloned = await cloneVoiceFromSample(
        sampleBlob,
        `subj${speaker.id.replace(/[^a-z0-9]/gi, '').slice(-10) || 'voice'}`,
        signal
      )
      voiceId = cloned.voiceId
      voiceModel = cloned.model
      project.updateSubject(speaker.id, { clonedVoiceId: voiceId, clonedVoiceModel: voiceModel })
      await project.save()
    }
    onProgress?.(`用「${speaker.name}」的音色合成口播...`)
    blob = await synthesizeClonedSpeech(text, voiceId, voiceModel, signal)
  } else {
    onProgress?.('合成口播...')
    const instruction = [
      speaker?.voicePrompt?.trim(),
      `自然、克制的中文短视频旁白；语速按 ${shot.duration} 秒内说完；标点处真实停顿，不要播音腔，不要夸张情绪。`
    ]
      .filter(Boolean)
      .join('；')
    const result = await generateSpeech({
      text,
      voice: p.settings.ttsVoice,
      language: 'Chinese',
      instruction,
      signal
    })
    blob = result.blob
  }
  const quality = await reviewSpeechQuality(blob, text, shot.duration)
  if (!quality.passed) throw new Error(`配音文件或时长校验未通过：${quality.issues.join('；')}。${quality.retryHint || ''}`)
  const asset = await assets.add(blob, 'audio', 'ai-generated', {
    filename: `voice_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt: text,
    projectId: p.id,
    shotId: shot.id
  })
  project.assignShotAudio(shot.id, asset.id)
  await project.save()
  return asset
}

/**
 * 把刚写好的剧本存成一份本地 Markdown，并登记进资源库的「剧本」。
 * 归档失败不能影响生成流程，所以这里只提示不抛错。
 */
export async function archivePlayToScriptLibrary(
  project: Project,
  options: {
    mode?: 'write' | 'continue'
    prompt?: string
    onLog?: (msg: string) => void
  } = {}
): Promise<void> {
  try {
    const scripts = useScriptsStore()
    await scripts.saveFromProject(project, {
      mode: options.mode ?? 'write',
      prompt: options.prompt
    })
    options.onLog?.('剧本已存入剧本库（本地 Markdown）')
  } catch (e: any) {
    console.warn('[script-library] 归档剧本失败', e)
    options.onLog?.(`剧本没能写入剧本库：${e?.message ?? String(e)}`)
  }
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
  // brief 只是本次生成输入。模型失败前绝不能先把已有完整剧本覆盖成一句聊天消息。
  const requestTopic =
    brief && !continueMode
      ? topicFromBrief(brief) || project.current?.script?.topic || project.current?.name || ''
      : project.current?.script?.topic || project.current?.name || ''
  const requestContent = brief && !continueMode ? brief : project.current?.script?.content || ''
  const requestStyle =
    (brief && !continueMode ? inferVisualStyleFromText(brief) : undefined) ||
    project.current?.script?.style ||
    'cinematic'
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
  const look = lookFromTexts(
    requestStyle,
    requestTopic,
    requestContent,
    project.current.script.keywords
  )
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
      topic: requestTopic,
      content: requestContent,
      style: look.style,
      shotDuration: project.current.script.shotDuration,
      maxShotDuration: videoMaxSeconds(storyboardVideoModel()),
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords,
      targetDurationSec: resolveTargetDurationSec(project.current.script, requestTopic, requestContent),
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
  // 存住时长预算：后面拆分镜要用它算镜数，不能只靠当时那一句话。
  const playTargetSec = resolveTargetDurationSec(project.current.script, requestTopic, requestContent)
  project.setScript({
    ...project.current.script,
    topic: run.result.topic || requestTopic || project.current.script.topic,
    content: run.result.playMarkdown,
    playReady: true,
    ...(playTargetSec ? { targetDurationSec: playTargetSec } : {}),
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
  await archivePlayToScriptLibrary(project.current, {
    mode: continueMode ? 'continue' : 'write',
    prompt: brief || opts?.hint,
    onLog: onProgress
  })
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

/**
 * 成片目标时长：优先用项目里显式设的值，其次从用户原话里认（「约 40 秒」这类）。
 * 它是剧本规模和分镜数量的硬预算，拿不到就返回 undefined 让流程按内容自然走。
 */
function resolveTargetDurationSec(
  script: { targetDurationSec?: number; topic?: string; content?: string } | undefined,
  ...extraTexts: Array<string | undefined>
): number | undefined {
  const explicit = Number(script?.targetDurationSec) || 0
  if (explicit >= 10) return explicit
  const parsed = extractTargetDurationSec(script?.topic, script?.content, ...extraTexts)
  return parsed || undefined
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
    // 模型这次没真给音色（拿到的是兜底句）时，保留用户之前手填的那条，别覆盖掉。
    voicePrompt:
      fresh.voicePrompt && fresh.voicePrompt !== FALLBACK_VOICE_PROMPT
        ? fresh.voicePrompt
        : old.voicePrompt || fresh.voicePrompt,
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
  // 断点续跑：同一份剧本重跑拆分镜时，复用上次已完成的小组结果，不重复消费 token。
  const playKey = scriptPlayKey(project.current.script.content || '')
  const savedBatches = project.current.script.shotBatches
  const resumeBatches: Array<Record<string, unknown>[] | undefined> | undefined =
    savedBatches?.playKey === playKey
      ? Array.from({ length: 64 }, (_, i) => {
          const rows = savedBatches.batches[String(i)]
          return Array.isArray(rows)
            ? (rows.filter((row) => row && typeof row === 'object') as unknown as Record<string, unknown>[])
            : undefined
        })
      : undefined
  const resumeCount = resumeBatches
    ? Object.values(resumeBatches).filter((rows) => Array.isArray(rows) && rows.length).length
    : 0
  onProgress?.(
    extractStartAt === 'subjects'
      ? `${stage ? '重新提取人物' : '先拆人物'}；已有场景和分镜会保留…`
      : extractStartAt === 'scenes'
        ? `${stage ? '重新提取场景描点' : '人物已保存；继续拆场景'}；已有人物和分镜会保留…`
        : resumeCount
          ? `${stage ? '重新提取分镜' : '继续拆分镜'}；发现 ${resumeCount} 个已完成的工作包，将直接续用…`
          : `${stage ? '重新提取分镜' : '人物和场景已保存；继续拆分镜'}；已生成的看板/配图/视频按镜号保留…`
  )
  let finalStagePersisted = false
  const persistStage = async (
    done: ExtractStage,
    partial: import('@/services/ai/storyboard').StoryboardResult,
    meta?: { partial?: boolean; completed?: number; total?: number }
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
      finalStagePersisted = !meta?.partial
      const stageShots = storyboardToShots(partial)
      if (project.current.pipelineMode === 'remake') {
        for (const shot of stageShots) shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
      }
      // 用项目里真实的人物卡再绑一次音色：只重提分镜时，模型侧拿不到完整人物表。
      const voiceBound = bindShotVoiceHints(stageShots, project.current.subjects ?? [])
      if (voiceBound) {
        onProgress?.(`✓ 已把 ${voiceBound} 个镜头的说话音色绑到人物卡`)
      }
      project.setShots(mergeShotAssets(stageShots, project.current.shots))
      rebindShotScenes()
    }
    project.setCanvas(rebuildCanvasGraph(project.current, true))
    const landed =
      done === 'subjects'
        ? `✓ 人物已上画布（${project.current.subjects?.length || 0} 个），本步完成`
        : done === 'scenes'
          ? `✓ 场景已上画布（${project.current.scenes?.length || 0} 个），本步完成`
          : meta?.partial
            ? `✓ 分镜小组 ${meta.completed || 0}/${meta.total || 0} 已上画布（累计 ${project.current.shots.length} 镜）`
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
      maxShotDuration: videoMaxSeconds(storyboardVideoModel()),
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords,
      targetDurationSec: resolveTargetDurationSec(project.current.script),
      mode: 'extract',
      model: resolveLlmModel(model),
      extractStartAt,
      extractStopAfter: extractStartAt,
      existingSubjects,
      existingScenes,
      workflowMode: project.current.script.workflowMode,
      resumeBatchShots: resumeBatches,
      onBatchDone: (index, rows) => {
        if (!project.current?.script) return
        const script = { ...project.current.script }
        script.shotBatches = {
          playKey,
          batches: {
            ...(script.shotBatches?.playKey === playKey ? script.shotBatches.batches : {}),
            [index]: rows
          }
        }
        project.setScript(script)
      },
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
  }
  if (project.current.script) {
    project.setScript({
      ...project.current.script,
      playReady: true,
      // 全部小组都已落库，断点标记完成使命，清掉避免旧标记污染下次改稿。
      shotBatches: undefined,
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

const GROUP_GEN_TYPES = new Set([
  'subject',
  'scene',
  'shotBoard',
  'shotImage',
  'shotFrames',
  'sceneProps',
  'shotVideo'
])
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
    groupId !== 'group-frames' &&
    groupId !== 'group-videos'
  ) {
    throw new Error('这个分组不能一键生成')
  }
  const project = useProjectStore()
  const p = project.current
  if (!p?.canvas) throw new Error('画布为空')
  // 人物和场景资产可以在分镜失败前先生成；验收只拦截镜头/视频下游。
  if (
    (groupId === 'group-shots' || groupId === 'group-frames' || groupId === 'group-videos') &&
    !isPlayApproved(p)
  ) {
    throw new Error(PLAY_GATE_MSG)
  }
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
            : groupId === 'group-frames'
              ? '首尾帧'
              : '分镜关键帧'
    const activity = trackActivity(groupId, `一键生成${noun}`, source, (msg) => onProgress?.(groupId, msg))
    try {
      // 点「分镜视频」一键生成时，首尾帧模式先把帧补齐：视频吃的就是这两张图，
      // 不补就变成跳过首尾帧列直接出片。
      if (groupId === 'group-videos') {
        await ensureShotFrames((msg) => onProgress?.(groupId, msg), signal)
      }
      // 必须串行的两种情况：
      // 1) 视频首尾帧链：下一镜首帧取自上一镜末帧；
      // 2) 画首尾帧：这一镜的起始帧要参考上一镜的结束帧，并发会把衔接丢掉。
      const chain =
        groupId === 'group-frames' || (groupId === 'group-videos' && isFl2vaChainActive(p))
      const ordered = chain ? sortNodeIdsByShotIndex(p, pending) : pending
      activity.progress(
        groupId === 'group-frames'
          ? `按镜号串行画 ${ordered.length} 镜的首尾帧（这一镜起始帧接着上一镜结束帧）…`
          : chain
            ? `首尾帧链模式：按镜号串行生成 ${ordered.length} 镜（下一镜首帧取自上一镜末帧）…`
            : `同时生成 ${ordered.length} 个节点…`
      )
      await mapPool(
        ordered,
        chain ? 1 : groupId === 'group-videos' ? VIDEO_GEN_CONCURRENCY : IMAGE_GEN_CONCURRENCY,
        (id) => runCanvasNode(id, (nid, msg) => onProgress?.(nid, msg), signal)
      )
      activity.done(chain ? `${noun}已按镜号顺序全部生成` : `${noun}已全部提交`)
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
  const prompt = node.data.prompt ?? ''
  if (!prompt.trim()) throw new Error('请先写提示词')
  onProgress?.('准备参考图...')
  const library = useLibraryStore()
  const blobs: Blob[] = []
  for (const id of resolvedCanvasReferenceAssetIds(p, node)) {
    const b = (await assets.getBlob(id)) || (await library.getBlob(id))
    if (b) blobs.push(b)
  }
  const look = lookFromScript(p.script)
  const aspectRatio = canvasNodeAspect(node, p.settings.aspectRatio)
  const size = imageGenSize('shot', aspectRatio)
  onProgress?.('正在出图...')
  const result = await generateImage({
    prompt,
    style: look.style,
    width: size.width,
    height: size.height,
    aspectRatio,
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
  const prompt = node.data.prompt ?? ''
  if (!prompt.trim()) throw new Error('请先写提示词')
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
  const aspectRatio = canvasNodeAspect(node, p.settings.aspectRatio)
  const videoSize = aspectToSize(aspectRatio)
  const slotEntries = canvasReferenceSlotEntries(p, node)
  const imageSlots = buildH3ImageSlots(
    slotEntries.length
      ? slotEntries
      : blobs.map((_, i) => ({ kind: 'extra' as const, name: `reference ${i + 1}` }))
  )
  onProgress?.(`正在出视频（${blobs.length} 张参考图）...`)
  // 自由图生视频节点以输入框为唯一真源。生成按钮不得优化、清洗或回写提示词。
  const sendPrompt = prompt
  const result = await generateVideo(
    {
      prompt: sendPrompt,
      promptAsIs: true,
      imageBlob: blobs[0],
      referenceImages: useFl2va ? [] : blobs.slice(1, videoMaxRefImages(videoModel)),
      lastFrameBlob: useFl2va ? blobs[1] : undefined,
      imageSlots,
      duration,
      width: videoSize.width,
      height: videoSize.height,
      aspectRatio,
      voiceMode: 'none',
      promptStyle: 'scene-narrative',
      videoModel,
      videoProfileId: node.data.videoProfileId,
      videoResolution: node.data.videoResolution,
      h3GenMode: useFl2va ? 'fl2va' : 'reference',
      mode: 'R2VA',
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
    prompt: result.prompt,
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
  const aspectRatio = canvasNodeAspect(node, p.settings.aspectRatio)
  const videoSize = aspectToSize(aspectRatio)
  const slotEntries = canvasReferenceSlotEntries(p, node)
  const imageSlots = buildH3ImageSlots(
    slotEntries.length
      ? slotEntries
      : [{ kind: 'extra' as const, name: 'reference 1' }]
  )
  const cueLines = extractSpokenFromNotes(
    source.replace(/<d>\s*\[[^\]]*\]\s*[\s\S]*?<\/d>/gi, '')
  ).filter((line, i, all) => line && all.indexOf(line) === i)
  const hasSpeech = cueLines.length > 0
  const compiled = ensurePictureIdentity(
    await compileH3OfficialPrompt({
    prompt: `【节点当前提示词。场记、时长、画风、图1图2身份都是画面，不是台词。只有引号或「台词/对白」里的原词才进 <d>。必须写清图1是谁、图2是谁、图3是谁。】\n${source}`,
    aesthetic: p.script?.h3Aesthetic || p.script?.aesthetic,
    voiceover: cueLines.join('\n'),
    voiceMode: hasSpeech ? 'dialogue' : 'none',
    imageAssignments: imageSlots.map((slot) => slot.job),
    imageSlots,
    duration: clampVideoDuration(node.data.duration, videoModel, 8),
    width: videoSize.width,
    height: videoSize.height,
    aspectRatio,
    cameraMovement: 'static',
    promptStyle: getVideoPromptStyle(),
    mode: 'R2VA',
    forceIntegrated: true,
    signal
  }),
    { prompt: '', imageSlots, duration: clampVideoDuration(node.data.duration, videoModel, 8) }
  )
  project.setCanvasNodePrompt(nodeId, compiled)
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
      node.type !== 'subject' &&
      node.type !== 'scene' &&
      node.type !== 'sceneProps' &&
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
      } else if (node.type === 'shotFrames' && node.data.shotId) {
        const shot = project.current?.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('找不到分镜')
        await generateShotFramePair(shot, report, signal)
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

/**
 * 首尾帧模式下出片前的补帧：视频吃的就是这两张帧，缺了必须先按镜号画出来，
 * 否则整列首尾帧会被跳过，这个模式等于白开。画不成的镜头只记一笔、照常出片，绝不拦流程。
 */
export async function ensureShotFrames(
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<number> {
  const p = useProjectStore().current
  if (!p || !needsShotFrames(p)) return 0
  // 只给真正走首尾帧的镜头补帧，混合模式下普通镜头不浪费出图额度
  const missing = [...(p.shots ?? [])]
    .filter((s) => shotUsesFrames(s, p) && (!s.firstFrameAssetId || !s.lastFrameAssetId))
    .sort((a, b) => a.index - b.index)
  if (!missing.length) return 0
  onProgress?.(`首尾帧模式：先按镜号画 ${missing.length} 镜的起始帧和结束帧…`)
  let done = 0
  for (const shot of missing) {
    ensureNotCancelled(signal)
    try {
      await generateShotFramePair(shot, (msg) => onProgress?.(msg), signal)
      done += 1
    } catch (e: any) {
      onProgress?.(`第 ${shot.index + 1} 镜首尾帧没画成（${e?.message || '未知原因'}），这一镜照常出片。`)
    }
  }
  return done
}

export async function generateMissingVideos(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  await ensureShotFrames(onProgress, signal)
  const ids = p.shots
    .filter((s) => !s.videoAssetId)
    .map((s) => `shotVideo:${s.id}`)
  // 首尾帧链：下一镜首帧取自上一镜末帧，并发会把衔接丢掉，必须按镜号串行。
  const chain = isFl2vaChainActive(p)
  const ordered = chain ? sortNodeIdsByShotIndex(p, ids) : ids
  await mapPool(ordered, chain ? 1 : VIDEO_GEN_CONCURRENCY, (id) =>
    runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal)
  )
}

export async function generateMissingAudio(onProgress?: (msg: string) => void, signal?: AbortSignal) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots.filter((s) => needsExternalTts(s, p) && !s.audioAssetId).map((s) => `audio:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg), signal))
}
