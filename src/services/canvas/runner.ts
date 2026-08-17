import { useProjectStore, useAssetsStore } from '@/stores'
import {
  generateImage,
  generateVideo,
  generateSpeech,
  generateStoryboard,
  storyboardToShots,
  characterSheetPrompt,
  scenePlatePrompt,
  composeVideoPrompt
} from '@/services/ai'
import { blobToChatImageUrl } from '@/services/ai/client'
import {
  collectShotRefIds,
  composeShotImagePrompt
} from '@/utils/consistency'
import { effectiveImagePrompt, effectiveVideoPrompt, pushHistory } from '@/utils/shot'
import { rebuildCanvasGraph } from './layout'
import { lookFromScript, styleLabel } from '@/utils/visualStyle'
import { mapPool, withNodeJob } from './jobs'
import { isPlayApproved, PLAY_GATE_MSG } from './playGate'
import type { CanvasNode, Scene, Shot, Subject } from '@/types'

export type RunProgress = (nodeId: string, msg: string) => void

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

export async function generateSubjectSheet(sub: Subject, onProgress?: (msg: string) => void) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const look = lookFromScript(project.current.script)
  const style = look.style
  const refs = await productRefBlobs()
  const useRefs = refs.length > 0 && (Boolean(sub.fromReference) || sub.kind === 'other')
  const prompt = characterSheetPrompt(sub, style, useRefs, look)
  onProgress?.('生成人设图...')
  const result = await generateImage(
    {
      prompt,
      style,
      width: 1792,
      height: 1024,
      aspectRatio: '16:9',
      referenceImages: useRefs ? refs : undefined,
      referenceLabels: useRefs
        ? refs.map(() => `角色「${sub.name}」参考照片，外貌必须一致`)
        : undefined
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `character_${sub.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
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

export async function generateScenePlate(scn: Scene, onProgress?: (msg: string) => void) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const look = lookFromScript(project.current.script)
  const style = look.style
  const prompt = scenePlatePrompt(scn, style, look)
  onProgress?.('生成场景底板...')
  const result = await generateImage(
    {
      prompt,
      style,
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `scene_${scn.name}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id
  })
  project.updateScene(scn.id, {
    plateAssetId: asset.id,
    plateHistoryIds: pushHistory(scn.plateAssetId, asset.id, scn.plateHistoryIds)
  })
  await project.save()
  return asset
}

export async function generateShotImage(shot: Shot, onProgress?: (msg: string) => void) {
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
  const result = await generateImage(
    {
      prompt,
      style,
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio,
      referenceImages: blobs.length ? blobs : undefined,
      referenceLabels: labels.length ? labels : undefined
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'image', 'ai-generated', {
    filename: `shot_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt,
    projectId: project.current.id,
    shotId: shot.id
  })
  project.assignShotImage(shot.id, asset.id)
  await project.save()
  return asset
}

export async function generateShotVideo(shot: Shot, onProgress?: (msg: string) => void) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  if (!shot.imageAssetId) throw new Error('请先生成该分镜的配图')
  const main = await assets.getBlob(shot.imageAssetId)
  if (!main) throw new Error('配图读取失败')
  const bundle = collectShotRefIds(shot, project.current)
  const extras: Blob[] = []
  for (const id of bundle.ids) {
    if (id === shot.imageAssetId) continue
    const b = await assets.getBlob(id)
    if (b) extras.push(b)
    if (extras.length >= 2) break
  }
  const prompt = effectiveVideoPrompt(shot) || shot.title
  onProgress?.('生成视频...')
  const result = await generateVideo(
    {
      imageBlob: main,
      referenceImages: extras,
      prompt,
      aesthetic: project.current.script?.aesthetic,
      audioDescription: shot.audioDescription,
      duration: shot.duration,
      width: project.current.settings.width,
      height: project.current.settings.height,
      aspectRatio: project.current.settings.aspectRatio,
      cameraMovement: shot.cameraMovement
    },
    onProgress
  )
  const asset = await assets.add(result.blob, 'video', 'ai-generated', {
    filename: `video_${shot.index + 1}_${Date.now().toString(36)}`,
    prompt: composeVideoPrompt({
      prompt,
      aesthetic: project.current.script?.aesthetic,
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

export async function generateShotAudio(shot: Shot, onProgress?: (msg: string) => void) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  if (!project.current) throw new Error('没有打开的项目')
  const text = (shot.voiceover || '').trim()
  if (!text) throw new Error('该分镜没有口播文案')
  onProgress?.('合成口播...')
  const result = await generateSpeech({
    text,
    voice: project.current.settings.ttsVoice
  })
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

export async function runStoryboard(onProgress?: (msg: string) => void) {
  const project = useProjectStore()
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
  onProgress?.('拆解分镜...')
  const run = await generateStoryboard(
    {
      topic: project.current.script.topic,
      content: project.current.script.content,
      style: look.style,
      shotDuration: project.current.script.shotDuration,
      aspectRatio: project.current.settings.aspectRatio,
      productImages,
      keywords: project.current.script.keywords
    },
    onProgress
  )
  const shots = storyboardToShots(run.result)
  project.setShots(shots)
  project.setSubjects(run.result.subjects ?? [])
  project.setScenes(run.result.scenes ?? [])
  if (project.current.script) {
    project.setScript({
      ...project.current.script,
      ...(look.matched ? { style: look.matched } : {}),
      ...(run.result.aesthetic ? { aesthetic: run.result.aesthetic } : {})
    })
  }
  project.setCanvas(rebuildCanvasGraph(project.current, false))
  project.setPlayApproved(false)
  await project.save()
  return run
}

export async function runCanvasNode(nodeId: string, onProgress?: RunProgress) {
  return withNodeJob(nodeId, async () => {
    const project = useProjectStore()
    const p = project.current
    if (!p?.canvas) throw new Error('画布为空')
    const node = p.canvas.nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error('找不到节点')
    const report = (msg: string) => onProgress?.(nodeId, msg)
    if (node.type !== 'script' && node.type !== 'export' && !isPlayApproved(p)) {
      throw new Error(PLAY_GATE_MSG)
    }
    patchNode(project, nodeId, 'running')
    try {
      if (node.type === 'script') {
        await runStoryboard(report)
      } else if (node.type === 'subject' && node.data.subjectId) {
        const sub = (p.subjects ?? []).find((s) => s.id === node.data.subjectId)
        if (!sub) throw new Error('找不到主体')
        await generateSubjectSheet(sub, report)
      } else if (node.type === 'scene' && node.data.sceneId) {
        const scn = (p.scenes ?? []).find((s) => s.id === node.data.sceneId)
        if (!scn) throw new Error('找不到场景')
        await generateScenePlate(scn, report)
      } else if (node.type === 'shotImage' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('找不到分镜')
        await generateShotImage(shot, report)
      } else if (node.type === 'shotVideo' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('找不到分镜')
        await generateShotVideo(shot, report)
      } else if (node.type === 'audio' && node.data.shotId) {
        const shot = p.shots.find((s) => s.id === node.data.shotId)
        if (!shot) throw new Error('找不到分镜')
        await generateShotAudio(shot, report)
      } else if (node.type === 'export') {
        throw new Error('请在右侧面板打开导出')
      }
      patchNode(project, nodeId, 'success')
    } catch (e: any) {
      patchNode(project, nodeId, 'failed', e?.message ?? String(e))
      throw e
    }
  })
}

export async function generateMissingSheets(onProgress?: (msg: string) => void) {
  const p = useProjectStore().current
  if (!p) return
  const ids = (p.subjects ?? [])
    .filter((s) => !s.designSheetAssetId)
    .map((s) => `subject:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg)))
}

export async function generateMissingPlates(onProgress?: (msg: string) => void) {
  const p = useProjectStore().current
  if (!p) return
  const ids = (p.scenes ?? []).filter((s) => !s.plateAssetId).map((s) => `scene:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg)))
}

export async function generateMissingImages(onProgress?: (msg: string) => void) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots.filter((s) => !s.imageAssetId).map((s) => `shotImage:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg)))
}

export async function generateMissingVideos(onProgress?: (msg: string) => void) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots
    .filter((s) => s.imageAssetId && !s.videoAssetId)
    .map((s) => `shotVideo:${s.id}`)
  await mapPool(ids, 2, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg)))
}

export async function generateMissingAudio(onProgress?: (msg: string) => void) {
  const p = useProjectStore().current
  if (!p) return
  const ids = p.shots.filter((s) => s.voiceover && !s.audioAssetId).map((s) => `audio:${s.id}`)
  await mapPool(ids, 3, (id) => runCanvasNode(id, (_nid, msg) => onProgress?.(msg)))
}
