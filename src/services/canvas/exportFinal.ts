/**
 * 画布内合成最终视频（不跳转经典导出页）
 */

import { exportVideo, parseSRT, buildCuesFromClips, probeMedia, trimTimelineBySpeech } from '@/services/ffmpeg'
import { useAssetsStore, useProjectStore } from '@/stores'
import { canBuildExport, ensureTimelineFromShots } from '@/utils/timeline'
import { effectiveShotAudioMode, isDigitalHumanSpeechProject, needsExternalTts } from '@/utils/shot'

export async function generateFinalCut(onProgress?: (msg: string) => void) {
  const project = useProjectStore()
  const assets = useAssetsStore()
  const p = project.current
  if (!p) throw new Error('没有打开的项目')
  if (!canBuildExport(p)) {
    throw new Error('还没有可导出的视频或图片，请先生成分镜视频')
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
  const digitalHuman = isDigitalHumanSpeechProject(p)
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

  let working = timeline
  if (digitalHuman && p.speechWorkflow?.options.removePauses !== false) {
    onProgress?.('正在切掉句首句尾气口...')
    working = await trimTimelineBySpeech(working, async (shotId) => mediaMap.get(shotId)?.blob)
    project.setTimeline(working)
  }

  const voiceoverMap = new Map<string, string>()
  for (const clip of working) {
    const shot = p.shots.find((s) => s.id === clip.shotId)
    voiceoverMap.set(clip.shotId, shot?.voiceover ?? '')
  }

  const captionCues = (() => {
    if (digitalHuman) {
      return buildCuesFromClips(
        working.map((c) => {
          const shot = p.shots.find((s) => s.id === c.shotId)
          return {
            startTime: c.startTime,
            duration: c.duration,
            text: shot?.voiceover ?? ''
          }
        })
      ).filter((c) => c.text.trim())
    }
    const srt = p.captionSrt?.trim()
    if (srt) return parseSRT(srt).filter((c) => c.text.trim())
    return buildCuesFromClips(
      working.map((c) => {
        const shot = p.shots.find((s) => s.id === c.shotId)
        return {
          startTime: c.startTime,
          duration: c.duration,
          text: shot?.voiceover ?? ''
        }
      })
    ).filter((c) => c.text.trim())
  })()

  let bgmBlob: Blob | undefined
  if (p.pipelineMode !== 'smart-speech' && p.bgmAssetId) {
    bgmBlob = await assets.getBlob(p.bgmAssetId)
  }

  const isSpeech = p.pipelineMode === 'smart-speech'
  const voiceoverAudioMap = new Map<string, Blob>()
  const sourceAudioMap = new Map<string, boolean>()
  for (const clip of working) {
    if (voiceoverAudioMap.has(clip.shotId)) continue
    const shot = p.shots.find((s) => s.id === clip.shotId)
    if (!shot) continue
    const audioMode = effectiveShotAudioMode(shot)
    sourceAudioMap.set(
      clip.shotId,
      isSpeech ||
        audioMode === 'h3-dialogue' ||
        audioMode === 'h3-voiceover' ||
        p.settings.keepAmbientAudio !== false
    )
    if (digitalHuman || !needsExternalTts(shot, p) || !shot.audioAssetId) continue
    const blob = await assets.getBlob(shot.audioAssetId)
    if (blob) voiceoverAudioMap.set(clip.shotId, blob)
  }

  let width = p.settings.width
  let height = p.settings.height
  if (isSpeech) {
    for (const media of mediaMap.values()) {
      if (media.kind !== 'video') continue
      const info = await probeMedia(media.blob).catch(() => ({ width: 0, height: 0 }))
      if ((info.width || 0) >= 16 && (info.height || 0) >= 16) {
        width = info.width % 2 === 0 ? info.width : info.width - 1
        height = info.height % 2 === 0 ? info.height : info.height - 1
        break
      }
    }
  }
  const exportTimeline = isSpeech
    ? working.map((clip) => ({ ...clip, transitionIn: 'none' as const, transitionDuration: 0 }))
    : working

  const keepAmbient = isSpeech ? true : p.settings.keepAmbientAudio !== false
  const blob = await exportVideo({
    timeline: exportTimeline,
    mediaMap,
    voiceoverMap,
    width,
    height,
    fps: p.settings.fps,
    captionStyle: p.settings.captionStyle,
    burnCaptions: p.settings.burnCaptions !== false,
    captionCues,
    captionBg: p.settings.captionBg,
    captionHighlight: p.settings.captionHighlight,
    captionHighlightColor: p.settings.captionHighlightColor,
    captionHighlightScale: p.settings.captionHighlightScale,
    bgm: bgmBlob,
    bgmVolume: p.settings.bgmVolume,
    originalVolume: isSpeech ? 1 : p.settings.originalVolume ?? 0.55,
    keepAmbientAudio: keepAmbient,
    sourceAudioMap,
    voiceoverAudioMap,
    format: 'mp4',
    onProgress
  })

  onProgress?.('写入视频...')
  const asset = await assets.add(blob, 'video', 'ai-generated', {
    filename: `final_${p.name || 'cut'}_${Date.now().toString(36)}.mp4`,
    prompt: `视频 · ${p.script?.topic || p.name || ''}`,
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
