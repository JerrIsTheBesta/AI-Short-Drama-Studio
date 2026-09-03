import type { Scene, Shot, Subject } from '@/types'
import { callLLM, getAIMode } from './client'
import { getVideoPromptStyle } from './runtime'
import {
  composeVideoPerformance,
  isVideoPerformanceTemplate,
  isVideoPerformanceThin,
  lacksEnsembleBlocking,
  stripFrameLead,
  thisShotAction,
  videoPerformanceSpec
} from '@/utils/shotPrompt'

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function shotLine(shot?: Shot): string {
  if (!shot) return '（无）'
  const action = thisShotAction(shot.continuity) || shot.title || ''
  return `${shot.title || '未标题'}。${action}`
}

/**
 * 出视频前的内容表现：你亲手写过、且不像套话的原文原样用。
 * 空着、过短、缺少时间轴、或旧套话稿，按本镜剧情重写。
 */
export async function enrichVideoPerformance(opts: {
  shot: Shot
  prevShot?: Shot
  nextShot?: Shot
  subjects?: Array<Pick<Subject, 'name' | 'description' | 'role'>>
  scene?: Pick<Scene, 'name' | 'description' | 'lighting' | 'mainAnchor'>
  chapterNotes?: string
  sceneExcerpt?: string
  force?: boolean
  signal?: AbortSignal
}): Promise<string> {
  const own = stripFrameLead((opts.shot.videoPrompt || '').trim())
  const names = (opts.subjects || []).map((s) => s.name).filter(Boolean)
  if (
    !opts.force &&
    own &&
    !isVideoPerformanceThin(own) &&
    !isVideoPerformanceTemplate(own) &&
    !lacksEnsembleBlocking(own, names)
  ) {
    return own
  }

  const current = composeVideoPerformance(opts.shot, {
    ignoreStored: opts.force || isVideoPerformanceTemplate(own) || lacksEnsembleBlocking(own, names)
  })
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
          content: `你给图生视频写「视频内容表现」。${videoPerformanceSpec(getVideoPromptStyle())}
只输出 JSON：{"videoPrompt":"..."}
像给演员说戏，不要像填表。只写本镜这 ${opts.shot.duration} 秒里发生的事。
从0秒到${opts.shot.duration}秒按实际剧情拍点分成2–5段，不机械等分。每段明确当前行动者、动作和表情、说话人和原词、其他人物占位与视线、一个有动机的运镜及落点。时间轴是导演调度，不是四行摘要；每段都要有可见的画面进展。
画面里每一个出场的人都必须写：近处还是后面、身体朝哪（侧对/四分之三，禁止正面朝镜头）、眼睛看谁或看什么。说话者可以在后面；前面的人回头或侧头看他，或看他指的东西。人设图是正面照，成片不要抄成合影。
坏例子：「林遥指着田垄说话。老农和差役在场。人物看向场景里的人或物，不要看镜头。」
好例子：「近处：老农和差役侧对镜头站在石板路上。林遥在他们身后稍远，从跪姿撑起半身，泥手指向田垄。老农回头眯眼打量林遥，差役视线跟着那只手看向田垄。三个人都不看镜头。」
配图静帧词只当布景。continuity 若带箭头，只演中间这一截，不要把上一镜和下一镜也演了。
剧本里的改编原则、不拍清单、年代天气必须遵守。成年旁白是画外音，画面里的人闭嘴。善意写成普通人做的小事，不要写成救世主登场。`
        },
        {
          role: 'user',
          content: `人物：
${roster || '（按画面里已有的人）'}

场景：
${scene || '（按参考画面）'}

上一镜（不要演进来，只作承接）：${shotLine(opts.prevShot)}
下一镜（不要演进来）：${shotLine(opts.nextShot)}

本镜标题：${opts.shot.title}
时长：${opts.shot.duration} 秒
运镜：${opts.shot.cameraMovement}
站位：${opts.shot.blocking || ''}
视线：${opts.shot.eyeline || '每个人写清看谁，禁止看镜头'}
本镜出场人物（每个人都要写站位和视线）：${names.join('、') || '（按画面里已有的人）'}
本镜动作（只拍这一段）：${thisShotAction(opts.shot.continuity) || opts.shot.blocking || opts.shot.title || ''}
道具：${opts.shot.propFocus || '无'}
原词台词：${opts.shot.voiceover || '（无）'}
现有草稿（若是套话请丢掉重写）：
${own || current}

本章约束（必须遵守）：
${opts.chapterNotes || '（无）'}

本场剧本原文（从这里演，不要另编情节）：
${opts.sceneExcerpt || '（无，按本镜场记演）'}

参考静帧（只当布景，不要复述）：
${(opts.shot.visualPrompt || '').slice(0, 400)}`
        }
      ],
      jsonMode: true,
      temperature: 0.7,
      maxTokens: 1600,
      signal: opts.signal
    })
    const parsed = JSON.parse(stripJsonFence(resp.content)) as { videoPrompt?: string }
    const rich = stripFrameLead(String(parsed.videoPrompt || ''))
    if (!rich || rich === (opts.shot.visualPrompt || '').trim()) return current
    if (isVideoPerformanceTemplate(rich)) return current
    return rich
  } catch {
    return current
  }
}
