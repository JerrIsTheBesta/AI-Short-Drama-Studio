/**
 * AI 图片生成（OpenAI 兼容 Images API）
 *
 * 统一：
 *   POST /images/generations
 *   - 文生图：不传 image
 *   - 单图/多图编辑：传 image[]（URL 或 data:image/...;base64,...）+ sequential_image_generation:"disabled"
 *
 * 响应优先 b64_json（纯 base64，无 data: 前缀），兼容 url
 */

import { getAIMode } from './client'
import { getImageConfig } from './runtime'
import { generateMockImage } from './mock'
import {
  httpCustomImageGenerate,
  comfyPromptGenerate,
  resolveImageAdapter
} from './adapters'
import { apimartGenerateImage, isRelayImageEndpoint } from './apimart'
import { autodlRequest } from './video'
import {
  normalizeZealmanBaseUrl,
  zealmanImageWorkflowById,
  ZEALMAN_IMAGE_WORKFLOWS
} from './zealman'
import type { VisualStyle, AspectRatio } from '@/types'
import { abortableDelay, throwIfAborted } from './abort'

export interface ImageGenInput {
  prompt: string
  style: VisualStyle
  width: number
  height: number
  /** 比例标签（'16:9' / '9:16' 等），写到 prompt 最前面 */
  aspectRatio?: AspectRatio
  n?: number
  /** 参考图（图生图/多图融合），最多 10 张；本项目通常 1–3 张人设/场景 */
  referenceImages?: Blob[]
  /** 每张参考图的语义（会写进 prompt，告诉模型第几张是什么） */
  referenceLabels?: string[]
  /** 覆盖设置页作图模型，例如视频复刻用 gpt-image-1 */
  model?: string
  signal?: AbortSignal
}

export interface ImageGenOutput {
  blob: Blob
  mimeType: string
  prompt: string
}

const log = (msg: string) =>
  console.log('%c[image]', 'color:#f59e0b;font-weight:600', msg)

function imageConfig(modelOverride?: string) {
  const cfg = getImageConfig()
  return {
    ...cfg,
    model: modelOverride?.trim() || cfg.model
  }
}

async function realCustomOrComfy(input: ImageGenInput): Promise<ImageGenOutput> {
  const cfg = imageConfig(input.model)
  const adapterType = resolveImageAdapter(cfg)
  const prompt = withGptImageQuality(buildPrompt(input, Boolean(input.referenceImages?.length)), cfg.model)
  if (adapterType === 'http-custom') {
    log(`→ 自定义 HTTP 生图 · ${cfg.model}`)
    const imageUrls: string[] = []
    for (const blob of input.referenceImages || []) {
      imageUrls.push(await blobToDataUri(blob))
    }
    const { blob, mimeType } = await httpCustomImageGenerate({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      prompt,
      adapter: cfg.adapter,
      extraBody: {
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        n: 1
      },
      signal: input.signal
    })
    return { blob, mimeType, prompt: input.prompt }
  }
  if (adapterType === 'comfyui-prompt' || adapterType === 'comfyui-workflow') {
    log(`→ ComfyUI 生图 · ${adapterType}`)
    let imageDataUrl: string | undefined
    if (input.referenceImages?.[0]) {
      imageDataUrl = await blobToDataUri(input.referenceImages[0])
    }
    const { blob, mimeType } = await comfyPromptGenerate({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      prompt,
      imageDataUrl,
      adapter: cfg.adapter,
      signal: input.signal,
      kind: 'image'
    })
    return { blob, mimeType, prompt: input.prompt }
  }
  throw new Error(`[image] 未知适配器 ${adapterType}`)
}

function isSeedreamModel(model: string): boolean {
  return /^seedream-/i.test(model)
}

function isGptImageModel(model: string): boolean {
  return /gpt[-_]?image|dall-e|dalle/i.test(model)
}

const GPT_IMAGE_QUALITY_SUFFIX = '去除燥波燥点，去除涂抹感，色彩平滑，画面严格执行干净质感。'

function withGptImageQuality(prompt: string, model: string): string {
  const base = String(prompt || '').trim()
  if (!isGptImageModel(model)) return base
  if (!base) return GPT_IMAGE_QUALITY_SUFFIX
  if (base.includes(GPT_IMAGE_QUALITY_SUFFIX)) return base
  return `${base} ${GPT_IMAGE_QUALITY_SUFFIX}`
}

/** 把图片 API 响应统一转成 Blob（优先 b64_json） */
async function imageResponseToBlob(
  data: any,
  apiKey?: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; mimeType: string }> {
  const item = data.data?.[0]
  if (!item) {
    throw new Error('图片 API 响应无 data[0]')
  }

  // 情况 1：b64_json（Seedream / 兼容接口常用）
  if (item.b64_json) {
    const raw = String(item.b64_json).replace(/\s/g, '')
    const bytes = atob(raw)
    const arr = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    // 4.5/4.0 仅 jpeg；5.0 可能 png。按魔数判断更稳
    const mime =
      arr[0] === 0x89 && arr[1] === 0x50
        ? 'image/png'
        : arr[0] === 0xff && arr[1] === 0xd8
          ? 'image/jpeg'
          : 'image/jpeg'
    return { blob: new Blob([arr], { type: mime }), mimeType: mime }
  }

  // 情况 2：url
  if (item.url) {
    const r = await fetch(item.url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal
    })
    if (!r.ok) throw new Error(`下载图片失败：${r.status}`)
    const blob = await r.blob()
    return { blob, mimeType: blob.type || 'image/jpeg' }
  }

  // 情况 3：外层 b64_json
  if (data.b64_json) {
    const bytes = atob(String(data.b64_json).replace(/\s/g, ''))
    const arr = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    return { blob: new Blob([arr], { type: 'image/jpeg' }), mimeType: 'image/jpeg' }
  }

  throw new Error(
    `无法解析图片响应（既无 b64_json 也无 url）\n原始响应：${JSON.stringify(data).slice(0, 200)}`
  )
}

/**
 * Seedream size：预设档位或精确 WxH
 * seedream-4.5 实测精确像素下限约 3686400（≈1920²），低于此会 400。
 * 总像素还需 ≤ 4096×4096，宽高比 ∈ [1/16, 16]
 */
const SEEDREAM_MIN_PIXELS = 3_686_400
const SEEDREAM_MAX_PIXELS = 4096 * 4096

function even(n: number): number {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v + 1
}

function scaleToPixelBudget(
  w: number,
  h: number,
  minPixels: number,
  maxPixels: number
): { width: number; height: number } {
  let width = even(w)
  let height = even(h)
  let pixels = width * height
  if (pixels < minPixels) {
    const scale = Math.sqrt(minPixels / pixels)
    width = even(width * scale)
    height = even(height * scale)
    pixels = width * height
  }
  if (pixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / pixels)
    width = even(width * scale)
    height = even(height * scale)
  }
  return { width, height }
}

function pickSeedreamSize(ar?: AspectRatio, w?: number, h?: number): string {
  // 有项目宽高：按比例抬到 Seedream 下限像素
  if (w && h && w > 0 && h > 0) {
    const { width, height } = scaleToPixelBudget(
      w,
      h,
      SEEDREAM_MIN_PIXELS,
      SEEDREAM_MAX_PIXELS
    )
    const ratio = width / height
    if (ratio >= 1 / 16 && ratio <= 16) return `${width}x${height}`
  }

  // 按比例给一组已满足下限的常用尺寸
  switch (ar) {
    case '16:9':
      return '2560x1440'
    case '9:16':
      return '1440x2560'
    case '1:1':
      return '2048x2048'
    case '4:3':
      return '2304x1728'
    case '21:9':
      return '3360x1440'
    default:
      return '2560x1440'
  }
}

/** 旧 OpenAI / gpt-image size（兜底） */
function pickLegacySize(ar?: AspectRatio, w?: number, h?: number): string {
  if (ar === '16:9') return '1792x1024'
  if (ar === '9:16') return '1024x1792'
  if (ar === '1:1') return '1024x1024'
  if (ar === '4:3') return '1536x1024'
  if (ar === '21:9') return '1792x768'
  if (w && h) {
    if (h > w) return '1024x1792'
    if (Math.abs(w - h) < 100) return '1024x1024'
    return '1792x1024'
  }
  return '1024x1024'
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('参考图转 base64 失败'))
    reader.readAsDataURL(blob)
  })
}

/** 把较大参考图压成 JPEG data URI，减小请求体 */
async function blobToChatImageDataUri(
  blob: Blob,
  maxEdge = 1536,
  quality = 0.88
): Promise<string> {
  try {
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return blobToDataUri(blob)
    }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', quality)
  } catch {
    return blobToDataUri(blob)
  }
}

function buildPrompt(input: ImageGenInput, _withRefs: boolean): string {
  const model = imageConfig(input.model).model
  return withGptImageQuality(input.prompt, model)
}

/** Seedream：统一走 /images/generations，优先返回 b64_json */
async function realSeedream(input: ImageGenInput): Promise<ImageGenOutput> {
  const { baseUrl, apiKey, model } = imageConfig(input.model)
  if (!baseUrl || !apiKey) {
    throw new Error('[image] 未配置 VITE_IMAGE_BASE_URL / VITE_IMAGE_API_KEY')
  }

  const refs = (input.referenceImages ?? []).slice(0, 10)
  const withRefs = refs.length > 0
  const fullPrompt = buildPrompt(input, withRefs)
  const size = pickSeedreamSize(input.aspectRatio, input.width, input.height)

  const body: Record<string, unknown> = {
    model,
    prompt: fullPrompt,
    size,
    response_format: 'b64_json',
    watermark: false
  }

  if (withRefs) {
    const images: string[] = []
    for (const blob of refs) {
      images.push(await blobToChatImageDataUri(blob))
    }
    body.image = images
    body.sequential_image_generation = 'disabled'
    log(`→ Seedream 多图融合 ${images.length} 张参考 · ${model} · ${size}`)
  } else {
    log(`→ Seedream 文生图 · ${model} · ${size}`)
  }

  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: input.signal
  })

  if (!resp.ok) {
    throw new Error(`[image] 出图失败 ${resp.status} ${await resp.text()}`)
  }

  const data = await resp.json()
  const { blob, mimeType } = await imageResponseToBlob(data, apiKey, input.signal)
  log(`✓ ${(blob.size / 1024).toFixed(1)} KB (${mimeType})`)
  return { blob, mimeType, prompt: input.prompt }
}

/** 旧 gpt-image 等：文生图 */
async function realLegacyGenerate(input: ImageGenInput): Promise<ImageGenOutput> {
  const { baseUrl, apiKey, model } = imageConfig(input.model)
  if (!baseUrl || !apiKey) {
    throw new Error('[image] 未配置 VITE_IMAGE_BASE_URL / VITE_IMAGE_API_KEY')
  }

  const fullPrompt = buildPrompt(input, false)
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt: fullPrompt,
      n: input.n ?? 1,
      size: pickLegacySize(input.aspectRatio, input.width, input.height),
      response_format: 'b64_json'
    }),
    signal: input.signal
  })

  if (!resp.ok) {
    throw new Error(`[image] 文生图失败 ${resp.status} ${await resp.text()}`)
  }

  const data = await resp.json()
  const { blob, mimeType } = await imageResponseToBlob(data, apiKey, input.signal)
  return { blob, mimeType, prompt: input.prompt }
}

/** 旧 gpt-image：/images/edits multipart */
async function realLegacyEdit(input: ImageGenInput): Promise<ImageGenOutput> {
  const { baseUrl, apiKey, model } = imageConfig(input.model)
  if (!baseUrl || !apiKey) {
    throw new Error('[image] 未配置 VITE_IMAGE_BASE_URL / VITE_IMAGE_API_KEY')
  }
  if (!input.referenceImages?.length) {
    throw new Error('图编辑模式必须传 referenceImages')
  }

  const fullPrompt = buildPrompt(input, true)
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', fullPrompt)
  form.append('size', pickLegacySize(input.aspectRatio, input.width, input.height))
  form.append('response_format', 'b64_json')

  const refs = input.referenceImages.slice(0, 4)
  for (let i = 0; i < refs.length; i++) {
    const blob = refs[i]
    const ext = blob.type.includes('png')
      ? 'png'
      : blob.type.includes('webp')
        ? 'webp'
        : 'jpg'
    form.append('image[]', blob, `ref_${i}.${ext}`)
  }

  const resp = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: input.signal
  })

  if (!resp.ok) {
    throw new Error(`[image] 图编辑失败 ${resp.status} ${await resp.text()}`)
  }

  const data = await resp.json()
  const { blob, mimeType } = await imageResponseToBlob(data, apiKey, input.signal)
  return { blob, mimeType, prompt: input.prompt }
}

/** Zealman 镜像文生图：POST {base}/api/workflow/generate，轮询 /api/workflow/result。地址完全以用户配置为准。 */
async function realZealmanImage(
  input: ImageGenInput,
  onProgress?: (msg: string) => void
): Promise<ImageGenOutput> {
  const cfg = imageConfig(input.model)
  const root = normalizeZealmanBaseUrl(String(cfg.baseUrl || '').trim())
  if (!root) throw new Error('[image] Zealman 生图需要先填写镜像 Base URL（设置 → Zealman 镜像）')
  const workflow = zealmanImageWorkflowById(cfg.model) || ZEALMAN_IMAGE_WORKFLOWS[0]
  const prompt = buildPrompt(input, Boolean(input.referenceImages?.length)).slice(0, 10000)
  const width = Math.max(256, Math.round(input.width) || workflow.defaultWidth)
  const height = Math.max(256, Math.round(input.height) || workflow.defaultHeight)
  const inputValues: Record<string, string | number> = {
    [workflow.promptKey]: prompt,
    [workflow.negativeKey]: workflow.defaultNegative,
    [workflow.seedKey]: Math.floor(Math.random() * 2_147_483_647),
    [workflow.widthKey]: width,
    [workflow.heightKey]: height
  }
  onProgress?.(`提交 Zealman 生图任务（${workflow.name}）…`)
  const submitUrl = `${root}/api/workflow/generate`
  const submitBody = JSON.stringify({ workflow_id: workflow.id, input_values: inputValues })
  const postSubmit = (url: string) =>
    autodlRequest(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: submitBody,
        signal: input.signal
      },
      180_000
    )
  let response = await postSubmit(submitUrl)
  let text = await response.text()
  // 部分 Zealman/Nginx 部署对结尾斜杠采用严格路由；405 时换一种形式重试一次。
  if (response.status === 405) {
    response = await postSubmit(`${submitUrl}/`)
    text = await response.text()
  }
  if (!response.ok) {
    throw new Error(`[image] Zealman 提交失败 HTTP ${response.status}\n${text.slice(0, 800)}`)
  }
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('[image] Zealman 提交成功但响应不是 JSON')
  }
  if (data?.success === false) throw new Error(`[image] Zealman 提交失败：${data?.error || text.slice(0, 800)}`)
  const promptId = String(data?.prompt_id || '').trim()
  if (!promptId) throw new Error('[image] Zealman 响应中没有 prompt_id')

  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    throwIfAborted(input.signal)
    onProgress?.('Zealman 正在生图…')
    const poll = await autodlRequest(
      `${root}/api/workflow/result?prompt_id=${encodeURIComponent(promptId)}`,
      { method: 'GET', signal: input.signal },
      60_000
    )
    const pollText = await poll.text()
    let pollData: any
    try {
      pollData = JSON.parse(pollText)
    } catch {
      pollData = null
    }
    if (!poll.ok || pollData?.success === false) {
      throw new Error(`[image] Zealman 查询失败：${pollData?.error || pollText.slice(0, 800)}`)
    }
    if (pollData?.pending === false) {
      const result = Array.isArray(pollData.results)
        ? pollData.results.find((item: any) => item?.type === 'image' && item?.url)
        : null
      if (!result?.url) throw new Error('[image] Zealman 任务已结束，但没有返回图片')
      const imageUrl = new URL(String(result.url), `${root}/`).toString()
      onProgress?.('下载 Zealman 生成的图片…')
      const dl = await fetch(imageUrl, { signal: input.signal })
      if (!dl.ok) throw new Error(`[image] Zealman 图片下载失败 HTTP ${dl.status}`)
      const blob = await dl.blob()
      return { blob, mimeType: blob.type || 'image/png', prompt }
    }
    await abortableDelay(1500, input.signal)
  }
  throw new Error('[image] Zealman 生图超过 15 分钟，已停止轮询')
}

export async function generateImage(
  input: ImageGenInput,
  onProgress?: (msg: string) => void
): Promise<ImageGenOutput> {
  onProgress?.('准备生成图片...')
  const model = imageConfig(input.model).model

  if (getAIMode() === 'real') {
    const cfg = imageConfig(input.model)
    const adapterType = resolveImageAdapter(cfg)
    if (adapterType === 'zealman-workflow') {
      onProgress?.('Zealman 出图...')
      return await realZealmanImage(input, onProgress)
    }
    if (
      adapterType !== 'comfyui-prompt' &&
      adapterType !== 'comfyui-workflow' &&
      (isRelayImageEndpoint(cfg.baseUrl, cfg.provider) || adapterType === 'http-custom')
    ) {
      const prompt = withGptImageQuality(buildPrompt(input, Boolean(input.referenceImages?.length)), cfg.model)
      onProgress?.(input.referenceImages?.length ? '中转站图生图...' : '中转站文生图...')
      const { blob, mimeType } = await apimartGenerateImage({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        prompt,
        aspectRatio: input.aspectRatio,
        n: input.n,
        referenceImages: input.referenceImages,
        signal: input.signal,
        onProgress
      })
      return { blob, mimeType, prompt }
    }
    if (adapterType === 'comfyui-prompt' || adapterType === 'comfyui-workflow') {
      onProgress?.('ComfyUI 出图...')
      return await realCustomOrComfy(input)
    }
    if (isSeedreamModel(model)) {
      onProgress?.(
        input.referenceImages?.length
          ? `多图融合（${input.referenceImages.length} 张参考）...`
          : '文生图...'
      )
      return await realSeedream(input)
    }
    if (input.referenceImages && input.referenceImages.length > 0) {
      onProgress?.(`图生图（${input.referenceImages.length} 张参考）...`)
      return await realLegacyEdit(input)
    }
    onProgress?.('文生图...')
    return await realLegacyGenerate(input)
  }

  if (input.referenceImages && input.referenceImages.length > 0) {
    onProgress?.('(演示) 混合参考图...')
    await abortableDelay(600, input.signal)
    return await generateMockWithReferences(input)
  }

  await abortableDelay(600, input.signal)
  const blob = await generateMockImage(
    input.prompt,
    input.width,
    input.height,
    input.style
  )
  return { blob, mimeType: 'image/png', prompt: input.prompt }
}

/** mock 模式：把参考图拼到一起 + 加滤镜 */
async function generateMockWithReferences(
  input: ImageGenInput
): Promise<ImageGenOutput> {
  const canvas = document.createElement('canvas')
  canvas.width = input.width
  canvas.height = input.height
  const ctx = canvas.getContext('2d')!

  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, input.width, input.height)

  const refs = input.referenceImages!
  const thumbSize =
    Math.min(input.width, input.height) / Math.max(2, Math.sqrt(refs.length))
  for (let i = 0; i < refs.length; i++) {
    try {
      const bitmap = await createImageBitmap(refs[i])
      const col = i % Math.ceil(Math.sqrt(refs.length))
      const row = Math.floor(i / Math.ceil(Math.sqrt(refs.length)))
      const x = col * thumbSize + thumbSize / 2 - thumbSize / 4
      const y = row * thumbSize + thumbSize / 2 - thumbSize / 4
      ctx.globalAlpha = 0.6
      ctx.drawImage(bitmap, x, y, thumbSize / 2, thumbSize / 2)
      ctx.globalAlpha = 1
    } catch {
      /* ignore */
    }
  }

  const { styleToFilter } = await import('./mock')
  ctx.filter = styleToFilter(input.style)
  ctx.drawImage(canvas, 0, 0)
  ctx.filter = 'none'

  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.font = `bold ${Math.round(input.width * 0.025)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(
    `[演示] ${refs.length} 张参考 + ${input.prompt.slice(0, 30)}`,
    input.width / 2,
    input.height - 40
  )

  return await new Promise<ImageGenOutput>((resolve) =>
    canvas.toBlob((b) =>
      resolve({ blob: b!, mimeType: 'image/png', prompt: input.prompt })
    )
  )
}
