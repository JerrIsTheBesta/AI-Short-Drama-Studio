import type { Scene, Shot, Subject } from '@/types'
import { callLLM, getAIMode } from './client'
import {
  composeVideoPerformance,
  isVideoPerformanceThin,
  VIDEO_PERFORMANCE_SPEC
} from '@/utils/shotPrompt'

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

/**
 * 出视频前把内容表现写细：每个角色的表情神态、动作，以及环境反应。
 * 已经够细就原样返回。
 */
export async function enrichVideoPerformance(opts: {
  shot: Shot
  subjects?: Array<Pick<Subject, 'name' | 'description' | 'role'>>
  scene?: Pick<Scene, 'name' | 'description' | 'lighting' | 'mainAnchor'>
  signal?: AbortSignal
}): Promise<string> {
  const current = composeVideoPerformance(opts.shot)
  if (!isVideoPerformanceThin(current)) return current
  if (getAIMode() === 'mock') return current

  const roster = (opts.subjects || [])
    .map((s) => `${s.name}${s.role ? `（${s.role}）` : ''}：${(s.description || '').slice(0, 180)}`)
    .join('\n')
  const scene = opts.scene
    ? `${opts.scene.name}。${opts.scene.description || ''} 光：${opts.scene.lighting || ''} 主锚：${opts.scene.mainAnchor || ''}`
    : ''

  try {
    const resp = await callLLM({
      messages: [
        {
          role: 'system',
          content: `你给图生视频写「视频内容表现」。${VIDEO_PERFORMANCE_SPEC}
只输出 JSON：{"videoPrompt":"..."}
配图静帧词只当布景参考，不要抄成视频词。台词必须用下面给的原词。`
        },
        {
          role: 'user',
          content: `人物：
${roster || '（按画面里已有的人）'}

场景：
${scene || '（按参考画面）'}

本镜标题：${opts.shot.title}
时长：${opts.shot.duration} 秒
运镜：${opts.shot.cameraMovement}
站位：${opts.shot.blocking || ''}
视线：${opts.shot.eyeline || ''}
动作承接：${opts.shot.continuity || ''}
道具：${opts.shot.propFocus || ''}
原词台词：${opts.shot.voiceover || '（无）'}
现有草稿：
${current}

参考静帧（只当布景，不要复述）：
${(opts.shot.visualPrompt || '').slice(0, 400)}`
        }
      ],
      jsonMode: true,
      temperature: 0.4,
      maxTokens: 1200,
      signal: opts.signal
    })
    const parsed = JSON.parse(stripJsonFence(resp.content)) as { videoPrompt?: string }
    const rich = String(parsed.videoPrompt || '').trim()
    if (!rich || rich === (opts.shot.visualPrompt || '').trim()) return current
    return rich
  } catch {
    return current
  }
}
