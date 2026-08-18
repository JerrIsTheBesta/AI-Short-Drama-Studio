import { useProjectStore } from '@/stores'
import type { Project, Shot } from '@/types'
import { getAgentState } from './taskStore'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'

function shotContext(shot: Shot) {
  return {
    id: shot.id,
    index: shot.index + 1,
    title: shot.title,
    purpose: shot.purpose,
    visualPrompt: shot.visualPrompt,
    imagePrompt: shot.imagePrompt,
    videoPrompt: shot.videoPrompt,
    voiceover: shot.voiceover,
    audioMode: effectiveShotAudioMode(shot),
    speakerHint: shot.speakerHint,
    audioDescription: shot.audioDescription,
    duration: shot.duration,
    cameraMovement: shot.cameraMovement,
    shotSize: shot.shotSize,
    blocking: shot.blocking,
    eyeline: shot.eyeline,
    continuity: shot.continuity,
    propFocus: shot.propFocus,
    subjectIds: shot.subjectIds ?? [],
    sceneId: shot.sceneId,
    assets: {
      image: shot.imageAssetId ?? null,
      video: shot.videoAssetId ?? null,
      audio: shot.audioAssetId ?? null
    },
    notes: shot.notes
  }
}

function relevantShots(p: Project, userText: string): Shot[] {
  const indexes = new Set<number>()
  for (const match of userText.matchAll(/第\s*(\d+)\s*镜/g)) indexes.add(Number(match[1]) - 1)
  const named = p.shots.filter(
    (shot) => userText.includes(shot.title) || indexes.has(shot.index)
  )
  if (named.length) return named
  return p.shots.slice(0, 24)
}

export function buildProjectContext(userText: string) {
  const p = useProjectStore().current
  if (!p) return { project: null }
  const state = getAgentState()
  return {
    project: {
      id: p.id,
      name: p.name,
      script: p.script
        ? {
            topic: p.script.topic,
            content: p.script.content,
            keywords: p.script.keywords,
            style: p.script.style,
            aesthetic: p.script.aesthetic,
            styleBrief: p.script.styleBrief,
            colorPalette: p.script.colorPalette,
            lightingNote: p.script.lightingNote,
            aspectRatio: p.script.aspectRatio,
            shotDuration: p.script.shotDuration
          }
        : null,
      settings: {
        aspectRatio: p.settings.aspectRatio,
        resolution: `${p.settings.width}x${p.settings.height}`,
        fps: p.settings.fps,
        ttsVoice: p.settings.ttsVoice,
        keepAmbientAudio: p.settings.keepAmbientAudio
      },
      playApproved: p.playApproved ?? false,
      subjects: (p.subjects ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        description: s.description,
        role: s.role,
        stateVariants: s.stateVariants,
        hasDesignSheet: Boolean(s.designSheetAssetId)
      })),
      scenes: (p.scenes ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        mainAnchor: s.mainAnchor,
        lighting: s.lighting,
        hasPlate: Boolean(s.plateAssetId)
      })),
      shots: relevantShots(p, userText).map(shotContext),
      totals: {
        shots: p.shots.length,
        timelineClips: p.timeline.length,
        missingImages: p.shots.filter((s) => !s.imageAssetId).length,
        missingVideos: p.shots.filter((s) => !s.videoAssetId).length,
        missingAudio: p.shots.filter((s) => needsExternalTts(s) && !s.audioAssetId).length
      }
    },
    agent: {
      autonomy: state.autonomy,
      callBudget: state.callBudget,
      recentFailures: state.tasks
        .filter((t) => t.status === 'failed')
        .slice(-5)
        .map((t) => ({ tool: t.failedTool, error: t.error, request: t.request }))
    }
  }
}

export function projectContextPrompt(userText: string): string {
  return JSON.stringify(buildProjectContext(userText), null, 2)
}
