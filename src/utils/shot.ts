import type { Shot } from '@/types'
import { composeShotVisualPrompt } from '@/utils/shotPrompt'

/** 配图实际使用的提示词：独立覆盖优先，否则用分镜画面描述 + 导演备注 */
export function effectiveImagePrompt(shot: Shot): string {
  return composeShotVisualPrompt(shot, 'image')
}

/** 视频实际使用的提示词：独立覆盖优先，否则用分镜画面描述 + 导演备注 */
export function effectiveVideoPrompt(shot: Shot): string {
  return composeShotVisualPrompt(shot, 'video')
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
