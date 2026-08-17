/**
 * 分镜提示词拼装：导演字段摘要 + visualPrompt
 * 配图 / 视频优先用合成结果，保证站位与跨镜承接进模型。
 */

import type { Shot } from '@/types'

/** 把站位 / 承接 / 道具等导演备注压成短摘要 */
export function composeDirectingNotes(shot: Pick<
  Shot,
  'purpose' | 'shotSize' | 'blocking' | 'eyeline' | 'continuity' | 'propFocus' | 'cameraMovement'
>): string {
  const parts: string[] = []
  if (shot.purpose?.trim()) parts.push(`戏剧功能：${shot.purpose.trim()}`)
  if (shot.shotSize?.trim()) parts.push(`景别：${shot.shotSize.trim()}`)
  if (shot.blocking?.trim()) parts.push(`站位：${shot.blocking.trim()}`)
  if (shot.eyeline?.trim()) parts.push(`视线：${shot.eyeline.trim()}`)
  if (shot.continuity?.trim()) parts.push(`跨镜承接：${shot.continuity.trim()}`)
  if (shot.propFocus?.trim()) parts.push(`道具焦点：${shot.propFocus.trim()}`)
  return parts.join('\n')
}

/** 供配图/视频使用的最终画面提示（覆盖字段优先） */
export function composeShotVisualPrompt(
  shot: Shot,
  kind: 'image' | 'video' | 'base' = 'base'
): string {
  const override =
    kind === 'image'
      ? shot.imagePrompt
      : kind === 'video'
        ? shot.videoPrompt
        : undefined
  const base = (override ?? shot.visualPrompt ?? '').trim()
  const notes = composeDirectingNotes(shot)
  if (!notes) return base
  if (!base) return notes
  // 若画面描述已包含导演摘要，避免重复
  if (base.includes(notes) || notes.split('\n').every((line) => base.includes(line))) {
    return base
  }
  return `${base}\n\n【导演备注】\n${notes}`
}
