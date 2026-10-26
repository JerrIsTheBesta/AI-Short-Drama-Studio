/**
 * APIMart 内置协议。用户只填接口地址和 API Key。
 * 默认地址 https://api.aishuch.com
 * 图片：POST /v1/images/generations
 * 视频：POST /v1/videos/generations（Grok Imagine 1.5 字段）
 * 查询：GET /v1/tasks/{task_id}?language=zh
 */

import { isApimartHost, isLocalComfyHost, providerHttp } from './adapters'

export const APIMART_DEFAULT_BASE = 'https://api.aishuch.com'
export const APIMART_IMAGE_MODEL = 'gpt-image-2'
export const APIMART_VIDEO_MODEL = 'grok-imagine-1.5-video-ext'

const VIDEO_SIZES = new Set(['16:9', '9:16', '1:1', '3:2', '2:3'])
const RELAY_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'] as const

/** 上游不接受 aspect_ratio=auto，只接受固定比例。 */
export function concreteAspectRatio(raw?: string, width?: number, height?: number): string {
  const ratio = String(raw || '').trim()
  if ((RELAY_RATIOS as readonly string[]).includes(ratio)) return ratio
  if (width && height && width > 0 && height > 0) {
    const value = width / height
    let best: string = '16:9'
    let bestDiff = Number.POSITIVE_INFINITY
    for (const name of RELAY_RATIOS) {
      const [w, h] = name.split(':').map(Number)
      const diff = Math.abs(value - w / h)
      if (diff < bestDiff) {
        best = name
        bestDiff = diff
      }
    }
    return best
  }
  return '16:9'
}

export function isApimartEndpoint(baseUrl?: string, provider?: string): boolean {
  if (provider === 'apimart') return true
  return isApimartHost(baseUrl || '')
}

/** APIMart 和其他中转站的生图格式相同：提交 /v1/images/generations，再查任务。官方生图和本机 ComfyUI 除外。 */
export function isRelayImageEndpoint(baseUrl?: string, provider?: string): boolean {
  if (isApimartEndpoint(baseUrl, provider)) return true
  if (provider && provider !== 'custom') return false
  const url = baseUrl || ''
  if (!/^https?:\/\//i.test(url)) return false
  if (isLocalComfyHost(url) || /comfyui/i.test(url)) return false
  if (/openai\.com|volces\.com|dashscope\.aliyuncs\.com|aliyuncs\.com|bigmodel\.cn|minimaxi\.com|minimax\.chat|autodl\.art|seetacloud\.com/i.test(url)) {
    return false
  }
  return true
}

function imageResolution(raw?: string): '1k' | '2k' | '4k' {
  const value = String(raw || '').toLowerCase().replace(/\s/g, '')
  if (value === '4k' || value === '4') return '4k'
  if (value === '1k' || value === '1') return '1k'
  if (value === '2k' || value === '2') return '2k'
  return '2k'
}

export function apimartRoot(baseUrl?: string): string {
  let root = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!root) root = APIMART_DEFAULT_BASE
  root = root.replace(/\/v1$/i, '')
  return root
}

function bearer(apiKey: string): string {
  let key = String(apiKey || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  key = key.replace(/^bearer\s+/i, '').trim()
  if (!key) throw new Error('APIMart 需要填写 API Key')
  return `Bearer ${key}`
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('参考图读取失败'))
    reader.readAsDataURL(blob)
  })
}

async function referenceDataUrl(blob: Blob): Promise<string> {
  try {
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return blobToDataUrl(blob)
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', 0.88)
  } catch {
    return blobToDataUrl(blob)
  }
}

function pickModel(raw: string | undefined, fallback: string): string {
  const name = String(raw || '').trim()
  if (!name || /lightx2v|comfyui/i.test(name)) return fallback
  return name
}

function videoSize(aspectRatio?: string, width?: number, height?: number): string {
  const ratio = concreteAspectRatio(aspectRatio, width, height)
  if (VIDEO_SIZES.has(ratio)) return ratio
  if (ratio === '4:3' || ratio === '21:9' || ratio === '5:2') return '16:9'
  if (ratio === '3:4') return '2:3'
  return height && width && height > width ? '9:16' : '16:9'
}

function videoSeconds(model: string, raw?: number): number {
  const seconds = Math.round(Number(raw) || 0)
  if (/grok-imagine-1\.5/i.test(model)) return Math.min(15, Math.max(6, seconds || 6))
  return Math.min(15, Math.max(1, seconds || 6))
}

function videoQuality(raw?: string): '480p' | '720p' {
  return /480/.test(String(raw || '')) ? '480p' : '720p'
}

function errorMessage(json: any, status: number): string {
  const message =
    json?.error?.message ||
    json?.data?.error?.message ||
    json?.message ||
    ''
  const text = String(message || '').trim()
  return text || `HTTP ${status}`
}

async function readJson(resp: { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }) {
  const raw = await resp.text()
  let json: any = {}
  try {
    json = raw ? JSON.parse(raw) : {}
  } catch {
    json = { message: raw.slice(0, 240) }
  }
  if (!resp.ok || json?.error) {
    throw new Error(errorMessage(json, resp.status))
  }
  if (json?.code != null && Number(json.code) >= 400) {
    throw new Error(errorMessage(json, Number(json.code)))
  }
  return json
}

function taskRecord(json: any): any {
  if (Array.isArray(json?.data)) return json.data[0] || {}
  if (json?.data && typeof json.data === 'object') return json.data
  return json || {}
}

function taskIdOf(json: any): string {
  const row = taskRecord(json)
  return String(row?.task_id || row?.id || json?.task_id || '').trim()
}

function collectUrls(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^https?:\/\//i.test(text) || text.startsWith('data:')) out.push(text)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if ('url' in record) collectUrls(record.url, out)
    if ('video_url' in record) collectUrls(record.video_url, out)
    if ('image_url' in record) collectUrls(record.image_url, out)
  }
  return out
}

function resultUrls(json: any, kind: 'image' | 'video'): string[] {
  const data = taskRecord(json)
  const result = data?.result || json?.result || {}
  const bucket = kind === 'video' ? result.videos : result.images
  const urls = collectUrls(bucket)
  if (urls.length) return urls
  return collectUrls(result)
}

async function downloadMedia(
  url: string,
  authorization: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; mimeType: string }> {
  // 结果文件在图床上。带上生图用的 Bearer，或 Accept: application/json，图床会回 400。
  const load = (auth?: string) =>
    providerHttp(url, {
      method: 'GET',
      headers: {
        Accept: '*/*',
        ...(auth ? { Authorization: auth } : {})
      },
      signal,
      timeoutMs: 120_000
    })
  let resp = await load()
  if (!resp.ok && authorization && (resp.status === 400 || resp.status === 401 || resp.status === 403)) {
    resp = await load(authorization)
  }
  if (!resp.ok) {
    const detail = (await resp.text()).replace(/\s+/g, ' ').trim().slice(0, 180)
    throw new Error(detail ? `结果下载失败 HTTP ${resp.status} ${detail}` : `结果下载失败 HTTP ${resp.status}`)
  }
  const blob = await resp.blob()
  const mimeType = blob.type || (url.includes('.mp4') ? 'video/mp4' : 'image/png')
  return { blob, mimeType }
}

async function pollTask(opts: {
  root: string
  taskId: string
  authorization: string
  kind: 'image' | 'video'
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}): Promise<{ blob: Blob; mimeType: string }> {
  const deadline = Date.now() + (opts.kind === 'video' ? 20 * 60_000 : 8 * 60_000)
  const url = `${opts.root}/v1/tasks/${encodeURIComponent(opts.taskId)}?language=zh`
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('已取消')
    const resp = await providerHttp(url, {
      method: 'GET',
      headers: { Authorization: opts.authorization, Accept: 'application/json' },
      signal: opts.signal,
      timeoutMs: 30_000
    })
    const json = await readJson(resp)
    const data = taskRecord(json)
    const status = String(data.status || '').toLowerCase()
    const progress = Number(data.progress)
    if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
      throw new Error(errorMessage(data.error ? { error: data.error } : data, 500))
    }
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const media = resultUrls(json, opts.kind)[0]
      if (!media) throw new Error('任务已完成，但没有返回图片或视频地址')
      opts.onProgress?.('正在下载结果...')
      return downloadMedia(media, opts.authorization, opts.signal)
    }
    const label = Number.isFinite(progress) ? `${Math.round(progress)}%` : status || '处理中'
    opts.onProgress?.(`生成中 ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  throw new Error('等待生成结果超时')
}

async function postJson(root: string, path: string, authorization: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const resp = await providerHttp(`${root}${path}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal,
    timeoutMs: 60_000
  })
  return readJson(resp)
}

function dataUriToBlob(uri: string): { blob: Blob; mimeType: string } {
  const match = uri.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!match) throw new Error('图片数据无法解析')
  const mimeType = match[1] || 'image/png'
  const payload = match[3] || ''
  if (match[2]) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { blob: new Blob([bytes], { type: mimeType }), mimeType }
  }
  return { blob: new Blob([decodeURIComponent(payload)], { type: mimeType }), mimeType }
}

async function mediaFromJson(
  json: any,
  kind: 'image' | 'video',
  authorization: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; mimeType: string } | null> {
  const row = Array.isArray(json?.data) ? json.data[0] : json?.data
  if (row?.task_id || row?.status === 'submitted') return null
  const b64 = typeof row?.b64_json === 'string' ? row.b64_json : ''
  if (b64) return dataUriToBlob(`data:image/png;base64,${b64}`)
  const url = resultUrls(json, kind)[0] || (typeof row?.url === 'string' ? row.url : '')
  if (!url) return null
  if (url.startsWith('data:')) return dataUriToBlob(url)
  return downloadMedia(url, authorization, signal)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function multipartFile(bytes: Uint8Array, filename: string, mime: string) {
  const boundary = `----AiCut${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
  )
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(head.length + bytes.length + tail.length)
  body.set(head, 0)
  body.set(bytes, head.length)
  body.set(tail, head.length + bytes.length)
  return {
    bodyBase64: bytesToBase64(body),
    contentType: `multipart/form-data; boundary=${boundary}`
  }
}

async function uploadReferenceImage(
  root: string,
  authorization: string,
  blob: Blob,
  signal?: AbortSignal
): Promise<string> {
  const file = dataUriToBlob(await referenceDataUrl(blob))
  const bytes = new Uint8Array(await file.blob.arrayBuffer())
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('参考图超过 20MB，无法上传')
  const part = multipartFile(bytes, 'reference.jpg', file.mimeType || 'image/jpeg')
  const resp = await providerHttp(`${root}/v1/uploads/images`, {
    method: 'POST',
    headers: { Authorization: authorization, Accept: 'application/json' },
    bodyBase64: part.bodyBase64,
    contentType: part.contentType,
    signal,
    timeoutMs: 120_000
  })
  const json = await readJson(resp)
  const url = String(json?.url || json?.data?.url || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('上传参考图没有返回可用地址')
  return url
}

async function uploadReferenceImages(
  root: string,
  authorization: string,
  blobs: Blob[],
  limit: number,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void
): Promise<string[]> {
  const list = blobs.slice(0, limit)
  const urls: string[] = []
  for (let i = 0; i < list.length; i++) {
    onProgress?.(`上传参考图 ${i + 1}/${list.length}...`)
    urls.push(await uploadReferenceImage(root, authorization, list[i], signal))
  }
  return urls
}

export async function apimartGenerateImage(opts: {
  baseUrl?: string
  apiKey: string
  model?: string
  prompt: string
  aspectRatio?: string
  resolution?: string
  n?: number
  referenceImages?: Blob[]
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}): Promise<{ blob: Blob; mimeType: string }> {
  const root = apimartRoot(opts.baseUrl)
  const authorization = bearer(opts.apiKey)
  const model = pickModel(opts.model, APIMART_IMAGE_MODEL)
  const imageUrls = await uploadReferenceImages(
    root,
    authorization,
    opts.referenceImages || [],
    15,
    opts.signal,
    opts.onProgress
  )
  const count = Math.max(1, Math.round(Number(opts.n) || 1))
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    n: count,
    size: !opts.aspectRatio || opts.aspectRatio === 'auto' ? '1:1' : concreteAspectRatio(opts.aspectRatio),
    resolution: imageResolution(opts.resolution)
  }
  if (imageUrls.length) body.image_urls = imageUrls
  opts.onProgress?.(imageUrls.length ? '提交图生图任务...' : '提交文生图任务...')
  const json = await postJson(root, '/v1/images/generations', authorization, body, opts.signal)
  const ready = await mediaFromJson(json, 'image', authorization, opts.signal)
  if (ready) return ready
  const taskId = taskIdOf(json)
  if (!taskId) throw new Error('提交成功但没有返回 task_id')
  opts.onProgress?.('已提交，正在查询...')
  return pollTask({
    root,
    taskId,
    authorization,
    kind: 'image',
    signal: opts.signal,
    onProgress: opts.onProgress
  })
}

export async function apimartGenerateVideo(opts: {
  baseUrl?: string
  apiKey: string
  model?: string
  prompt: string
  aspectRatio?: string
  width?: number
  height?: number
  duration?: number
  resolution?: string
  generateAudio?: boolean
  audioField?: string
  images?: Blob[]
  signal?: AbortSignal
  onProgress?: (msg: string) => void
  onTaskSubmitted?: (taskId: string) => void | Promise<void>
  resumeTaskId?: string
}): Promise<{ blob: Blob; mimeType: string; duration: number }> {
  const root = apimartRoot(opts.baseUrl)
  const authorization = bearer(opts.apiKey)
  const model = pickModel(opts.model, APIMART_VIDEO_MODEL)
  const duration = videoSeconds(model, opts.duration)
  let taskId = String(opts.resumeTaskId || '').trim()
  if (!taskId) {
    const imageUrls = await uploadReferenceImages(
      root,
      authorization,
      opts.images || [],
      7,
      opts.signal,
      opts.onProgress
    )
    const ratio = concreteAspectRatio(opts.aspectRatio, opts.width, opts.height)
    const body: Record<string, unknown> = {
      model,
      prompt: opts.prompt,
      size: videoSize(ratio, opts.width, opts.height),
      aspect_ratio: ratio,
      duration,
      resolution: videoQuality(opts.resolution)
    }
    if (typeof opts.generateAudio === 'boolean') {
      const field = String(opts.audioField || 'audio').trim()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) && /audio/i.test(field)) body[field] = opts.generateAudio
    }
    if (imageUrls.length) body.image_urls = imageUrls
    opts.onProgress?.('提交视频任务...')
    const submitted = await postJson(root, '/v1/videos/generations', authorization, body, opts.signal)
    taskId = taskIdOf(submitted)
    if (!taskId) throw new Error('提交成功但没有返回 task_id')
    await opts.onTaskSubmitted?.(taskId)
  }
  opts.onProgress?.('已提交，正在查询...')
  const media = await pollTask({
    root,
    taskId,
    authorization,
    kind: 'video',
    signal: opts.signal,
    onProgress: opts.onProgress
  })
  return { ...media, duration }
}
