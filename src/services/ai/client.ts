/**
 * AI 服务通用 client
 */

export type { AIMode } from '@/stores/settings'
export { getAIMode } from './runtime'

import { mockLLM } from './mock'
import { getAIMode, getLlmConfig, getVisionConfig } from './runtime'

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | LLMContentPart[]
}

export interface LLMRequest {
  messages: LLMMessage[]
  provider?: 'llm' | 'vision'
  /** 覆盖设置页模型，例如视频复刻用 qwen3.8-max */
  model?: string
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

export interface LLMResponse {
  content: string
  model: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export function messageText(content: LLMMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function flattenText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === 'string' ? part : flattenText((part as any)?.text ?? (part as any)?.content)
      )
      .filter(Boolean)
      .join('\n')
  }
  if (typeof value === 'object') {
    return flattenText((value as any).text ?? (value as any).content)
  }
  return String(value)
}

/** 推理模型常把正文放进 reasoning_content，content 会是空字符串。 */
function pickMessageContent(message: any): string {
  const candidates = [
    message?.content,
    message?.reasoning_content,
    message?.reasoning,
    message?.reasoningContent
  ]
  for (const item of candidates) {
    const text = flattenText(item).trim()
    if (text) return flattenText(item)
  }
  return ''
}

function hasImageParts(messages: LLMMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  )
}

/** 把图片压成 JPEG data URL，避免多模态请求过大（最多约 1280 边） */
export async function blobToChatImageUrl(
  blob: Blob,
  maxEdge = 1280,
  quality = 0.82
): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法压缩产品图')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', quality)
}

/** LLM 通用调用（APIYI OpenAI 兼容 /chat/completions） */
export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  if (getAIMode() === 'mock') {
    return mockLLM(req)
  }

  const { controlledSignal, isAbortError, llmAbortError } = await import('./abort')
  const timeoutMs = req.timeoutMs ?? 120_000
  const control = controlledSignal(req.signal, timeoutMs)
  const { baseUrl, apiKey, model: cfgModel } =
    req.provider === 'vision' ? getVisionConfig() : getLlmConfig()
  const model = req.model?.trim() || cfgModel

  if (!baseUrl || !apiKey) {
    const label = req.provider === 'vision' ? '视觉模型' : 'LLM'
    throw new Error(`[AI] 真实模式但没配 ${label} 地址或密钥，请到设置页配置`)
  }

  const withImages = hasImageParts(req.messages)
  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? (withImages ? 8192 : 4000)
  }
  if (req.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  const post = async (payload: Record<string, unknown>) => {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: control.signal
    })
    const errText = resp.ok ? '' : await resp.text()
    return { resp, errText }
  }

  try {
    let { resp, errText } = await post(body)
    if (
      !resp.ok &&
      body.response_format &&
      (/response_format|json_object/i.test(errText) ||
        (req.provider === 'vision' && withImages && resp.status === 400))
    ) {
      delete body.response_format
      ;({ resp, errText } = await post(body))
    }
    if (
      !resp.ok &&
      req.provider === 'vision' &&
      withImages &&
      /Unexpected item type in content|does not support.*image|image.*not supported/i.test(errText)
    ) {
      throw new Error(
        `[视觉模型] 当前模型 ${model} 不支持图片输入。请在设置页把“视觉理解”切换为 qwen3-vl-plus。`
      )
    }
    if (!resp.ok) throw new Error(`[LLM] ${resp.status} ${errText}`)
    let data = await resp.json()
    let content = pickMessageContent(data.choices?.[0]?.message)
    if (!content.trim() && body.response_format) {
      delete body.response_format
      ;({ resp, errText } = await post(body))
      if (!resp.ok) throw new Error(`[LLM] ${resp.status} ${errText}`)
      data = await resp.json()
      content = pickMessageContent(data.choices?.[0]?.message)
    }
    return {
      content,
      model: data.model ?? model,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens
          }
        : undefined
    }
  } catch (e) {
    if (control.signal.aborted || isAbortError(e)) {
      throw llmAbortError(e, control.signal, timeoutMs)
    }
    throw e
  } finally {
    control.cleanup()
  }
}
