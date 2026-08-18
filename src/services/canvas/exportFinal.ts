/**
 * 画布内合成最终成片（不跳转经典导出页）
 */

import { exportVideo, parseSRT, buildCuesFromClips } from '@/services/ffmpeg'
import { useAssetsStore, useProjectStore } from '@/stores'
import { canBuildExport, ensureTimelineFromShots } from '@/utils/timeline'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'

export async function generateFinalCut(onProgress?: (msg: string) => void) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) throw new Error('没有打开的项目')
  if (!canBuildExport(p)) {
    throw new Error('还没有可导出的视频或图片，请先生成分镜成片')
  }

  const { built, clips } = ensureTimelineFromShots(p)
  if (built) {
    project.setTimeline(clips)
  }
  const timeline = project.current!.timeline.filter((c) => c.enabled)
  if (!timeline.length) {
    throw new Error('时间线为空，无法合成')
  }

  onProgress?.('准备素材...')
  const voiceoverMap = new Map<string, string>()
  for (const clip of timeline) {
    const shot = p.shots.find((s) => s.id === clip.shotId)
    voiceoverMap.set(clip.shotId, shot?.voiceover ?? '')
  }

  const captionCues = (() => {
    const srt = p.captionSrt?.trim()
    if (srt) return parseSRT(srt).filter((c) => c.text.trim())
    return buildCuesFromClips(
      timeline.map((c) => {
        const shot = p.shots.find((s) => s.id === c.shotId)
        return {
          startTime: c.startTime,
          duration: c.duration,
          text: shot?.voiceover ?? ''
        }
      })
    ).filter((c) => c.text.trim())
  })()

  const mediaMap = new Map<string, { blob: Blob; kind: 'video' | 'image' }>()
  for (const clip of timeline) {
    if (mediaMap.has(clip.shotId)) continue
    const shot = p.shots.find((s) => s.id === clip.shotId)
    if (!shot) continue
    const assetId = shot.videoAssetId || shot.imageAssetId
    if (!assetId) continue
    const blob = await assets.getBlob(assetId)
    if (!blob) continue
    mediaMap.set(clip.shotId, {
      blob,
      kind: shot.videoAssetId ? 'video' : 'image'
    })
  }
  if (mediaMap.size === 0) throw new Error('没有可用的分镜素材')

  let bgmBlob: Blob | undefined
  if (p.bgmAssetId) {
    bgmBlob = await assets.getBlob(p.bgmAssetId)
  }

  const voiceoverAudioMap = new Map<string, Blob>()
  const sourceAudioMap = new Map<string, boolean>()
  for (const clip of timeline) {
    if (voiceoverAudioMap.has(clip.shotId)) continue
    const shot = p.shots.find((s) => s.id === clip.shotId)
    if (!shot) continue
    const audioMode = effectiveShotAudioMode(shot)
    sourceAudioMap.set(
      clip.shotId,
      audioMode === 'h3-dialogue' || audioMode === 'h3-voiceover'
        ? true
        : p.settings.keepAmbientAudio !== false
    )
    if (!needsExternalTts(shot) || !shot.audioAssetId) continue
    const blob = await assets.getBlob(shot.audioAssetId)
    if (blob) voiceoverAudioMap.set(clip.shotId, blob)
  }

  const keepAmbient = p.settings.keepAmbientAudio !== false
  const blob = await exportVideo({
    timeline,
    mediaMap,
    voiceoverMap,
    width: p.settings.width,
    height: p.settings.height,
    fps: p.settings.fps,
    captionStyle: p.settings.captionStyle,
    burnCaptions: p.settings.burnCaptions !== false,
    captionCues,
    captionBg: p.settings.captionBg,
    bgm: bgmBlob,
    bgmVolume: p.settings.bgmVolume,
    originalVolume: p.settings.originalVolume ?? 0.55,
    keepAmbientAudio: keepAmbient,
    sourceAudioMap,
    voiceoverAudioMap,
    format: 'mp4',
    onProgress
  })

  onProgress?.('写入成片...')
  const asset = await assets.add(blob, 'video', 'ai-generated', {
    filename: `final_${p.name || 'cut'}_${Date.now().toString(36)}.mp4`,
    prompt: `成片 · ${p.script?.topic || p.name || ''}`,
    projectId: p.id
  })
  project.setFinalVideo(asset.id)

  // 刷新画布节点状态
  if (project.current?.canvas) {
    const nodes = project.current.canvas.nodes.map((n) => {
      if (n.id === 'export' || n.id === 'final' || n.type === 'final') {
        return { ...n, status: 'success' as const, error: undefined }
      }
      return n
    })
    project.setCanvas({ ...project.current.canvas, nodes })
  }
  await project.save()
  return asset
}
