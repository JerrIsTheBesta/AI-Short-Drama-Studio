import { blobToChatImageUrl, callLLM, getAIMode } from './client'
import { getVisionConfig } from './runtime'
import type { Subject } from '@/types'

function stripJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

function fallbackLock(): string {
  return '画面中已经出现的人物保持不变，不要增加路人，不要换脸、换发型、换衣服。'
}

/**
 * 用视觉模型认本镜配图里谁是谁，产出中文身份锁（给 H3 视频内容表现开头）。
 */
export async function h3IdentityLockFromFrame(opts: {
  imageBlob: Blob
  subjects?: Array<Pick<Subject, 'name' | 'description' | 'role'>>
  signal?: AbortSignal
}): Promise<string> {
  if (getAIMode() === 'mock') return fallbackLock()

  const roster = (opts.subjects || [])
    .map((s, i) => `${i + 1}. ${s.name}${s.role ? `（${s.role}）` : ''}：${(s.description || '').slice(0, 280)}`)
    .join('\n')

  const system = `你看这一张分镜配图，对照名单说出谁是谁。
只输出 JSON：
{"identityLock":"画面中：穿什么/站在哪的人是谁（用名单里的中文名）。接着写不要加路人、不要换脸换装。"}
规则：中文。按衣服、发型、站位点名。没人就说这是空景。`

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
      maxTokens: 500,
      signal: opts.signal
    })
    const lock = String(
      (JSON.parse(stripJsonFence(resp.content)) as { identityLock?: string }).identityLock || ''
    ).trim()
    return lock || fallbackLock()
  } catch {
    return fallbackLock()
  }
}
