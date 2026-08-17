/**
 * AI 服务通用 client
 *
 * 支持两种模式：
 * - mock 模式（默认）：本地生成演示数据，无需任何 API key
 * - real 模式：通过 VITE_AI_REAL_MODE=true 启用，调用真实 endpoint
 *
 * 真实模式下，LLM 走 APIYI OpenAI 兼容协议：
 *   POST {VITE_LLM_BASE_URL}/chat/completions
 *   Authorization: Bearer {VITE_LLM_API_KEY}
 * 默认模型：qwen3.7-max。支持多模态：user content 可带图片。
 */

export type AIMode = 'mock' | 'real'

import { mockLLM } from './mock'

export function getAIMode(): AIMode {
  const flag = (import.meta.env.VITE_AI_REAL_MODE ?? 'false').toLowerCase()
  return flag === 'true' || flag === '1' ? 'real' : 'mock'
}

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | LLMContentPart[]
}

export interface LLMRequest {
  messages: LLMMessage[]
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
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

  const baseUrl = String(import.meta.env.VITE_LLM_BASE_URL ?? '').replace(/\/+$/, '')
  const apiKey = import.meta.env.VITE_LLM_API_KEY
  const model = import.meta.env.VITE_LLM_MODEL || 'qwen3.7-max'

  if (!baseUrl || !apiKey) {
    throw new Error(
      '[AI] real 模式但未配置 VITE_LLM_BASE_URL / VITE_LLM_API_KEY'
    )
  }

  const withImages = hasImageParts(req.messages)
  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? (withImages ? 8192 : 4000)
  }
  if (req.jsonMode && !withImages) {
    body.response_format = { type: 'json_object' }
  }

  const post = async (payload: Record<string, unknown>) => {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    })
    const errText = resp.ok ? '' : await resp.text()
    return { resp, errText }
  }

  let { resp, errText } = await post(body)
  if (
    !resp.ok &&
    body.response_format &&
    /response_format|json_object/i.test(errText)
  ) {
    delete body.response_format
    ;({ resp, errText } = await post(body))
  }

  if (!resp.ok) {
    throw new Error(`[LLM] ${resp.status} ${errText}`)
  }

  const data = await resp.json()
  const content =
    data.choices?.[0]?.message?.content ??
    data.choices?.[0]?.message?.reasoning_content ??
    ''
  return {
    content: typeof content === 'string' ? content : JSON.stringify(content),
    model: data.model ?? model,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens
        }
      : undefined
  }
}
