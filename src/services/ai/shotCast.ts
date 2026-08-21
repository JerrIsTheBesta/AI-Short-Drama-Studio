import { blobToChatImageUrl, callLLM, getAIMode } from './client'
import { getVisionConfig } from './runtime'
import type { Subject } from '@/types'
import type { VideoPromptStyle } from '@/utils/shotPrompt'

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function fallbackLock(style: VideoPromptStyle): string {
  if (style === 'formatted') {
    return '画面中已经出现的人物保持不变，不要增加路人，不要换脸、换发型、换衣服。'
  }
  return '画面中：保持参考图里已经出现的人物、站位和外貌，不要增加路人。'
}

/**
 * 用视觉模型认本镜配图里谁是谁，产出中文身份锁（给 H3 视频内容表现开头）。
 */
export async function h3IdentityLockFromFrame(opts: {
  imageBlob: Blob
  subjects?: Array<Pick<Subject, 'name' | 'description' | 'role'>>
  signal?: AbortSignal
  promptStyle?: VideoPromptStyle
}): Promise<string> {
  const style = opts.promptStyle ?? 'scene-narrative'
  if (getAIMode() === 'mock') return fallbackLock(style)

  const roster = (opts.subjects || [])
    .map((s, i) => `${i + 1}. ${s.name}${s.role ? `（${s.role}）` : ''}：${(s.description || '').slice(0, 280)}`)
    .join('\n')

  const system =
    style === 'formatted'
      ? `你看这一张分镜配图，对照名单说出谁是谁。
只输出 JSON：
{"identityLock":"画面中：穿什么/站在哪的人是谁（用名单里的中文名）。接着写不要加路人、不要换脸换装。"}
规则：中文。按衣服、发型、站位点名。没人就说这是空景。`
      : `你看这一张分镜配图，对照名单说出谁是谁。
只输出 JSON：
{"identityLock":"画面中：站位、发型、衣服、手脚正在做什么、年龄的人是名单里的中文名；下一个人……"}
规则：
- 只写中文，写成一句连续的「画面中：…」，用分号隔开每一个人。
- 每个人必须带：站在画面哪、发型、衣服、手脚正在做什么、大约年龄，最后「是【名字】」。
- 例：画面中：蹲在前景、头顶两个小揪用灰布条缠着、穿灰布短衣赤脚、手捧梨看向前方的四岁男童是孔融；右侧蹲坐、发髻木簪固定、穿洗旧青色直裾袖口挽起、手有茧的三十出头男性是父亲。
- 不要写「从第一帧接着演」，不要写「不要换脸」这类禁令，不要列条目。
- 没人就写：画面中没有人物，这是空景。`

  const user = `项目人物名单（用来对上号）：
${roster || '（没有具名角色）'}

根据这张分镜图写出身份锁。`

  try {
    const url = await blobToChatImageUrl(opts.imageBlob)
    const resp = await callLLM({
      provider: 'vision',
      model: getVisionConfig().model,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: user },
            { type: 'image_url', image_url: { url } }
          ]
        }
      ],
      jsonMode: true,
      temperature: 0.1,
      maxTokens: style === 'scene-narrative' ? 900 : 500,
      signal: opts.signal
    })
    const lock = String(
      (JSON.parse(stripJsonFence(resp.content)) as { identityLock?: string }).identityLock || ''
    ).trim()
    return lock || fallbackLock(style)
  } catch {
    return fallbackLock(style)
  }
}
