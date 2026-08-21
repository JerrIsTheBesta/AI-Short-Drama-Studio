import type { Shot, ShotAudioMode } from '@/types'
import { composeShotVisualPrompt } from '@/utils/shotPrompt'

export {
  composeVideoPerformance,
  synthesizeVideoPerformance,
  isVideoPerformanceThin,
  VIDEO_PERFORMANCE_SPEC,
  assembleShotVideoPrompt,
  videoPerformanceSpec,
  videoPromptJsonHint,
  editableVideoPrompt
} from '@/utils/shotPrompt'
export type { VideoPromptStyle } from '@/utils/shotPrompt'

/** 配图实际使用的提示词：独立覆盖优先，否则用分镜画面描述 */
export function effectiveImagePrompt(shot: Shot): string {
  return composeShotVisualPrompt(shot, 'image')
}

/** 视频内容表现：谁做什么、说什么、镜头怎么走。绝不回退成配图静帧词 */
export function effectiveVideoPrompt(shot: Shot): string {
  return composeShotVisualPrompt(shot, 'video')
}

/** 默认使用 H3 出镜对白；已有独立音频的旧项目继续按 TTS 处理。 */
export function effectiveShotAudioMode(shot: Shot): ShotAudioMode {
  return shot.audioMode ?? (shot.audioAssetId ? 'tts' : 'h3-dialogue')
}

export function h3VoiceMode(shot: Shot): 'dialogue' | 'voiceover' | 'none' {
  const mode = effectiveShotAudioMode(shot)
  if (mode === 'h3-dialogue') return 'dialogue'
  if (mode === 'h3-voiceover') return 'voiceover'
  return 'none'
}

export function needsExternalTts(shot: Shot): boolean {
  return effectiveShotAudioMode(shot) === 'tts' && Boolean(shot.voiceover.trim())
}

/** 把旧素材推进历史，当前换成新的（去重、最多留 12 条） */
export function pushHistory(
  currentId: string | undefined,
  nextId: string,
  history: string[] | undefined
): string[] {
  const list = [...(history ?? [])]
  if (currentId && currentId !== nextId && !list.includes(currentId)) {
    list.unshift(currentId)
  }
  return list.filter((id) => id !== nextId).slice(0, 12)
}
