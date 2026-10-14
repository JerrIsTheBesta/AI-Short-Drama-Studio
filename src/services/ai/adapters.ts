/**
 * 自定义接入适配器：OpenAI 兼容 / 自定义 HTTP / ComfyUI（AutoDL 风格 + 原生 /prompt）
 * 配置写在 settings 的 adapter 字段，运行时按 type 分流。
 */

import { desktop, isDesktop } from '@/services/desktop'
import { zealmanWorkflowById } from './zealman'

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController()
  setTimeout(() => c.abort(), ms)
  return c.signal
}


export type AdapterType =
  | 'openai-compatible'
  | 'openai-images'
  | 'http-custom'
  | 'comfyui-workflow'
  | 'zealman-workflow'
  | 'comfyui-prompt'

export interface AdapterConfig {
  /** 适配器类型；缺省时按 provider / URL 推断 */
  type?: AdapterType
  /** 相对 baseUrl 的请求路径，如 /images/generations 或 /prompt */
  path?: string
  /** 轮询路径模板，可用 {id}，如 /history/{id} */
  pollPath?: string
  /** pollPath 别名（设置页 / 文档常用） */
  pollUrl?: string
  /** 从提交响应取任务 id 的路径，如 data.id */
  taskIdJsonPath?: string
  /** 轮询响应里取状态或中间结果的路径 */
  pollJsonPath?: string
  /** 从 JSON 取结果 URL 的点分路径，如 data.0.url */
  resultJsonPath?: string
  /** 鉴权头名，默认 Authorization */
  authHeader?: string
  /** 鉴权前缀，默认 Bearer （Comfy/AutoDL 可设为空串表示原样） */
  authPrefix?: string
  /** ComfyUI 工作流 JSON 字符串，占位 {{prompt}} / {{image}} / {{negative}} */
  workflowTemplate?: string
  /** 额外请求头 */
  headers?: Record<string, string>
}

export type EndpointLike = {
  baseUrl?: string
  apiKey?: string
  model?: string
  workflowId?: string
  provider?: string
  adapter?: AdapterConfig
}

function trimSlash(url: string) {
  return (url || '').replace(/\/+$/, '')
}

export function isAutodlHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'autodl.art' || host.endsWith('.autodl.art')
  } catch {
    return /autodl\.art/i.test(url)
  }
}

export function isApimartHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'apimart.ai' ||
      host.endsWith('.apimart.ai') ||
      host === 'aiuxu.com' ||
      host.endsWith('.aiuxu.com') ||
      host === 'aishuch.com' ||
      host.endsWith('.aishuch.com')
    )
  } catch {
    return /apimart\.ai|aiuxu\.com|aishuch\.com/i.test(url)
  }
}

/** 官方域名，以及配了 /v1/tasks/{id} 的白标网关，都走同一套异步生图/视频协议。 */
export function usesApimartProtocol(baseUrl: string, adapter?: AdapterConfig): boolean {
  if (isApimartHost(baseUrl)) return true
  const poll = `${adapter?.pollPath || ''} ${adapter?.pollUrl || ''}`
  const path = adapter?.path || ''
  return /\/tasks\/\{id\}/i.test(poll) && /generations/i.test(path)
}

export function isLocalComfyHost(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return /localhost|127\.0\.0\.1/i.test(url)
  }
}

/** 推断图像适配器 */
export function resolveImageAdapter(ep: EndpointLike): AdapterType {
  if (isApimartHost(ep.baseUrl || '') || ep.provider === 'apimart') return 'http-custom'
  const t = ep.adapter?.type
  if (t === 'http-custom' || t === 'comfyui-prompt' || t === 'openai-images' || t === 'comfyui-workflow') {
    return t
  }
  if (t === 'openai-compatible') return 'openai-images'
  if (isAutodlHost(ep.baseUrl || '')) return 'comfyui-workflow'
  return 'openai-images'
}

/**
 * 读档时不能把当前 Zealman 接入的 adapter/provider 套到另一条 AutoDL 上。
 * 地址仍是 autodl.art、工作流也不是 U01/U02 时，残留的 zealman-workflow 一律拆掉。
 */
export function normalizeStoredVideoEndpoint<T extends EndpointLike>(ep: T): T {
  const zealmanWorkflow = Boolean(zealmanWorkflowById(ep.workflowId || ''))
  const autodlHost = isAutodlHost(ep.baseUrl || '')
  const leakedZealmanAdapter = ep.adapter?.type === 'zealman-workflow' && !zealmanWorkflow
  if ((autodlHost || ep.provider === 'autodl') && !zealmanWorkflow && (leakedZealmanAdapter || ep.provider === 'zealman')) {
    return {
      ...ep,
      provider: 'autodl',
      adapter: leakedZealmanAdapter ? undefined : ep.adapter
    }
  }
  return ep
}

/** 推断视频适配器。第三方 HTTP（如 APIMart）不能因为 provider=custom 就被当成自建 ComfyUI。 */
export function resolveVideoAdapter(ep: EndpointLike): AdapterType {
  const normalized = normalizeStoredVideoEndpoint(ep)
  const url = normalized.baseUrl || ''
  if (isApimartHost(url) || normalized.provider === 'apimart') return 'http-custom'
  const t = normalized.adapter?.type
  const zealmanWorkflow = Boolean(zealmanWorkflowById(normalized.workflowId || ''))
  if (normalized.provider === 'zealman' && t === 'zealman-workflow' && zealmanWorkflow) return 'zealman-workflow'
  if (t === 'http-custom' || t === 'comfyui-prompt' || t === 'comfyui-workflow') return t
  if (t === 'zealman-workflow' && normalized.provider === 'zealman') return 'zealman-workflow'
  if (isAutodlHost(url) || normalized.provider === 'autodl') return 'comfyui-workflow'
  if (isLocalComfyHost(url) || /comfyui/i.test(url)) return 'comfyui-prompt'
  if (normalized.provider === 'custom' && /^https?:\/\//i.test(url)) return 'http-custom'
  // 默认仍走 AutoDL 风格工作流 API（兼容旧配置）
  return 'comfyui-workflow'
}

function withAuthSeparator(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed) return ''
  if (/^bearer$/i.test(trimmed)) return 'Bearer '
  if (/^(token|basic)$/i.test(trimmed)) return `${trimmed} `
  return /\s$/.test(prefix) ? prefix : prefix
}

export function buildAuthHeader(
  apiKey: string,
  adapter?: AdapterConfig
): Record<string, string> {
  let token = (apiKey || '').trim().replace(/^\uFEFF/, '').replace(/^['"]+|['"]+$/g, '')
  token = token.replace(/^bearer\s+/i, '').trim()
  if (!token) return {}
  const name = (adapter?.authHeader || 'Authorization').trim() || 'Authorization'
  const prefix = withAuthSeparator(
    adapter?.authPrefix === undefined || adapter?.authPrefix === null
      ? name.toLowerCase() === 'authorization'
        ? 'Bearer '
        : ''
      : String(adapter.authPrefix)
  )
  const prefixText = prefix && !token.toLowerCase().startsWith(prefix.trim().toLowerCase()) ? prefix : ''
  return { [name]: `${prefixText}${token}` }
}

export function getByJsonPath(data: unknown, path?: string): unknown {
  if (!path || !path.trim()) return undefined
  const parts = path
    .trim()
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let cur: any = data
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

/** 深度搜索第一个像媒体 URL 的字符串 */
export function findFirstMediaUrl(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null
  if (typeof value === 'string') {
    const s = value.trim()
    if (/^https?:\/\//i.test(s) || s.startsWith('data:')) return s
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findFirstMediaUrl(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['url', 'video_url', 'image_url', 'file_url', 'output', 'result']) {
      if (key in obj) {
        const hit = findFirstMediaUrl(obj[key], depth + 1)
        if (hit) return hit
      }
    }
    for (const v of Object.values(obj)) {
      const hit = findFirstMediaUrl(v, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

export type ProxyHttpResult = {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<any>
  blob: () => Promise<Blob>
}

/**
 * 桌面端：AutoDL / 本机 ComfyUI 走主进程；其它 HTTPS 尽量直接 fetch。
 * 浏览器：一律 fetch。
 */
export async function providerHttp(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
    timeoutMs?: number
  } = {}
): Promise<ProxyHttpResult> {
  const method = (init.method || 'GET').toUpperCase()
  const timeoutMs = init.timeoutMs ?? 60_000
  // 桌面端统一走主进程，既绕过云端 ComfyUI 的 CORS，也让 /view 二进制输出可用。
  const preferProxy = isDesktop()

  if (preferProxy) {
    const api = desktop()
    if (typeof api.autodlFetch !== 'function') {
      throw new Error('请完全退出并重启剧流 Studio（桌面端需要更新后的请求通道）')
    }
    const headers = init.headers || {}
    const auth =
      headers.Authorization ||
      headers.authorization ||
      Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ||
      ''
    const res = await api.autodlFetch({
      url,
      method,
      authorization: String(auth || ''),
      extraHeaders: Object.fromEntries(
        Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')
      ),
      body: init.body,
      timeoutMs
    })
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.text,
      json: async () => JSON.parse(res.text || '{}'),
      blob: async () => {
        if (!res.dataBase64) return new Blob([res.text || ''], { type: res.contentType || 'application/octet-stream' })
        const binary = atob(res.dataBase64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return new Blob([bytes], { type: res.contentType || 'application/octet-stream' })
      }
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort)
  try {
    const resp = await fetch(url, {
      method,
      headers: init.headers,
      body: init.body,
      signal: controller.signal
    })
    const bytes = await resp.arrayBuffer()
    const text = new TextDecoder().decode(bytes)
    return {
      ok: resp.ok,
      status: resp.status,
      text: async () => text,
      json: async () => {
        try {
          return JSON.parse(text || '{}')
        } catch {
          throw new Error(`响应不是 JSON：${text.slice(0, 120)}`)
        }
      },
      blob: async () => new Blob([bytes], { type: resp.headers.get('content-type') || 'application/octet-stream' })
    }
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
  }
}

function joinUrl(baseUrl: string, path?: string) {
  const base = trimSlash(baseUrl)
  if (!path) return base
  if (/^https?:\/\//i.test(path)) return path
  return `${base}/${String(path).replace(/^\//, '')}`
}

function resolvePollTemplate(adapter?: AdapterConfig) {
  return (adapter?.pollUrl || adapter?.pollPath || '').trim()
}

function extractTaskId(data: any, adapter?: AdapterConfig): string {
  const fromPath = adapter?.taskIdJsonPath
    ? getByJsonPath(data, adapter.taskIdJsonPath)
    : undefined
  const first = Array.isArray(data?.data) ? data.data[0] : undefined
  const raw =
    fromPath ??
    data?.id ??
    data?.task_id ??
    data?.taskId ??
    data?.request_id ??
    first?.task_id ??
    first?.id ??
    getByJsonPath(data, 'data.0.task_id') ??
    getByJsonPath(data, 'data.id') ??
    getByJsonPath(data, 'data.task_id') ??
    getByJsonPath(data, 'output.task_id')
  return String(raw || '').trim()
}

async function mediaFromValue(
  picked: unknown,
  signal?: AbortSignal,
  fallbackMime = 'application/octet-stream'
): Promise<{ blob: Blob; mimeType: string } | null> {
  if (typeof picked !== 'string' || !picked.trim()) return null
  const value = picked.trim()
  if (value.startsWith('data:')) {
    const m = value.match(/^data:([^;]+);base64,(.+)$/i)
    if (!m) throw new Error('data URI 无法解析')
    const bin = atob(m[2].replace(/\s/g, ''))
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return { blob: new Blob([arr], { type: m[1] }), mimeType: m[1] }
  }
  if (/^https?:\/\//i.test(value)) {
    const r = await fetch(value, { signal })
    if (!r.ok) throw new Error(`下载结果失败 ${r.status}`)
    const blob = await r.blob()
    return { blob, mimeType: blob.type || fallbackMime }
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 256) {
    const raw = value.replace(/\s/g, '')
    const bin = atob(raw)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const mime =
      arr[0] === 0x89 && arr[1] === 0x50
        ? 'image/png'
        : arr[0] === 0xff && arr[1] === 0xd8
          ? 'image/jpeg'
          : arr[4] === 0x66 && arr[5] === 0x74 && arr[6] === 0x79 && arr[7] === 0x70
            ? 'video/mp4'
            : fallbackMime
    return { blob: new Blob([arr], { type: mime }), mimeType: mime }
  }
  return null
}

async function mediaFromUnknown(
  picked: unknown,
  signal?: AbortSignal,
  fallbackMime = 'application/octet-stream'
): Promise<{ blob: Blob; mimeType: string } | null> {
  const direct = await mediaFromValue(picked, signal, fallbackMime)
  if (direct) return direct
  const url = findFirstMediaUrl(picked)
  if (!url || url === picked) return null
  return mediaFromValue(url, signal, fallbackMime)
}

function apimartSubmitPath(baseUrl: string, kind: 'image' | 'video'): string {
  const rooted = /\/v1$/i.test(trimSlash(baseUrl))
  const leaf = kind === 'video' ? 'videos/generations' : 'images/generations'
  return rooted ? `/${leaf}` : `/v1/${leaf}`
}

function apimartPollPath(baseUrl: string): string {
  return /\/v1$/i.test(trimSlash(baseUrl)) ? '/tasks/{id}?language=zh' : '/v1/tasks/{id}?language=zh'
}

function isGenericMediaPath(path: string | undefined, kind: 'image' | 'video'): boolean {
  const value = String(path || '').trim().replace(/^\//, '').toLowerCase()
  if (!value) return true
  if (kind === 'image') return value === 'images/generations' || value === 'v1/images/generations'
  return value === 'videos/generations' || value === 'v1/videos/generations'
}

/** APIMart 是异步任务：POST /v1/.../generations，再 GET /v1/tasks/{id}。 */
function apimartAdapterDefaults(
  baseUrl: string,
  adapter: AdapterConfig | undefined,
  kind: 'image' | 'video'
): AdapterConfig {
  const current = adapter || {}
  if (!usesApimartProtocol(baseUrl, current)) return current
  return {
    ...current,
    type: 'http-custom',
    path: isGenericMediaPath(current.path, kind) ? apimartSubmitPath(baseUrl, kind) : current.path,
    pollPath: current.pollPath || current.pollUrl || apimartPollPath(baseUrl),
    taskIdJsonPath: current.taskIdJsonPath || 'data.0.task_id',
    pollJsonPath: current.pollJsonPath || 'data.status',
    resultJsonPath: current.resultJsonPath || (kind === 'video' ? 'data.result.videos' : 'data.result.images'),
    authHeader: current.authHeader || 'Authorization',
    authPrefix: current.authPrefix ?? 'Bearer '
  }
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
}

function requestBodyForProvider(
  baseUrl: string,
  adapter: AdapterConfig | undefined,
  kind: 'image' | 'video',
  model: string,
  prompt: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  if (!usesApimartProtocol(baseUrl, adapter)) {
    return { model, prompt, ...(extra || {}) }
  }
  const source = extra || {}
  const listed = [...stringList(source.image_urls), ...stringList(source.images)]
  const images = listed.length ? listed : stringList(source.image)
  const body: Record<string, unknown> = { model, prompt }
  if (source.duration != null) body.duration = source.duration
  const ratio = source.aspect_ratio || source.aspectRatio
  if (kind === 'video') {
    body.size = ratio || source.size || '16:9'
    const seconds = Math.round(Number(source.duration) || 6)
    body.duration = /grok-imagine-1\.5/i.test(model) ? Math.min(15, Math.max(6, seconds || 6)) : seconds
    const quality = String(source.resolution || '')
    body.resolution = /480/.test(quality) ? '480p' : '720p'
    if (images.length) body.image_urls = images.slice(0, 7)
    return body
  }
  body.n = Math.max(1, Math.round(Number(source.n) || 1))
  body.size = ratio || source.size || '1:1'
  const tier = String(source.resolution || '2k').toLowerCase()
  body.resolution = tier.includes('4k') ? '4k' : tier === '1k' ? '1k' : '2k'
  if (images.length) body.image_urls = images.slice(0, 15)
  return body
}

/** 自定义 HTTP：POST JSON；可选 pollUrl/{id} 轮询；从 resultJsonPath 取媒体 */
export async function httpCustomMediaGenerate(opts: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  adapter?: AdapterConfig
  extraBody?: Record<string, unknown>
  signal?: AbortSignal
  kind?: 'image' | 'video'
  onProgress?: (msg: string) => void
}): Promise<{ blob: Blob; mimeType: string }> {
  const kind = opts.kind || 'image'
  const adapter = apimartAdapterDefaults(opts.baseUrl, opts.adapter, kind)
  const fallbackMime = kind === 'video' ? 'video/mp4' : 'image/png'
  const path = adapter.path || (kind === 'video' ? '/v1/videos/generations' : '/images/generations')
  const url = joinUrl(opts.baseUrl, path)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...buildAuthHeader(opts.apiKey, adapter),
    ...(adapter.headers || {})
  }
  const body = requestBodyForProvider(opts.baseUrl, adapter, kind, opts.model, opts.prompt, opts.extraBody)
  opts.onProgress?.('提交自定义接口…')
  const res = await providerHttp(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
    timeoutMs: kind === 'video' ? 180_000 : 180_000
  })
  if (!res.ok) {
    const text = await res.text()
    const hint = res.status === 401 && usesApimartProtocol(url, adapter)
      ? '\n鉴权头必须是 “Bearer ” 加密钥，中间要有空格。请确认这条接入的前缀是 Bearer，而不是和密钥粘在一起。'
      : ''
    throw new Error(`[${kind}] 自定义接口失败 ${res.status}\n请求地址：${url}\n${text.slice(0, 500)}${hint}`)
  }
  let data = await res.json()

  const pollTpl = resolvePollTemplate(adapter)
  if (pollTpl) {
    const taskId = extractTaskId(data, adapter)
    if (!taskId) {
      throw new Error(
        `[${kind}] 已配置轮询但提交响应里没有任务 ID。请设置 adapter.taskIdJsonPath。片段：${JSON.stringify(data).slice(0, 240)}`
      )
    }
    const started = Date.now()
    const timeoutMs = kind === 'video' ? 15 * 60_000 : 6 * 60_000
    while (Date.now() - started < timeoutMs) {
      if (opts.signal?.aborted) throw new Error('已取消')
      await new Promise((r) => setTimeout(r, 1500))
      const pollUrl = /^https?:\/\//i.test(pollTpl)
        ? pollTpl.replace(/\{id\}/g, encodeURIComponent(taskId))
        : joinUrl(opts.baseUrl, pollTpl.replace(/\{id\}/g, encodeURIComponent(taskId)))
      opts.onProgress?.('轮询任务状态…')
      const poll = await providerHttp(pollUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...buildAuthHeader(opts.apiKey, adapter),
          ...(adapter.headers || {})
        },
        signal: opts.signal,
        timeoutMs: 60_000
      })
      if (!poll.ok) {
        if (poll.status === 401 || poll.status === 403) {
          throw new Error(`[${kind}] 查询任务被拒绝 ${poll.status}\n请求地址：${pollUrl}\n${(await poll.text()).slice(0, 400)}`)
        }
        continue
      }
      data = await poll.json()
      const statusRaw = adapter.pollJsonPath
        ? getByJsonPath(data, adapter.pollJsonPath)
        : data?.status || data?.state || getByJsonPath(data, 'data.status')
      const status = String(statusRaw || '').toLowerCase()
      if (/fail|error|cancel/.test(status)) {
        const message =
          getByJsonPath(data, 'data.error.message') ||
          data?.error?.message ||
          data?.message ||
          statusRaw
        throw new Error(`[${kind}] 任务失败：${String(message).slice(0, 300)}`)
      }
      const waiting = /^(pending|processing|submitted|queued|running|in_progress)$/.test(status)
      if (waiting) continue
      const picked =
        (adapter.resultJsonPath ? getByJsonPath(data, adapter.resultJsonPath) : undefined) ??
        findFirstMediaUrl(data)
      const media = await mediaFromUnknown(picked, opts.signal, fallbackMime)
      if (media) return media
      if (/^(completed|success|succeeded|succeed)$/.test(status)) {
        throw new Error(`[${kind}] 任务已完成，但响应里没有媒体地址。片段：${JSON.stringify(data).slice(0, 240)}`)
      }
    }
    throw new Error(`[${kind}] 自定义接口轮询超时`)
  }

  const picked =
    (adapter.resultJsonPath ? getByJsonPath(data, adapter.resultJsonPath) : undefined) ??
    getByJsonPath(data, 'data.0.b64_json') ??
    getByJsonPath(data, 'data.0.url') ??
    findFirstMediaUrl(data)
  const media = await mediaFromUnknown(picked, opts.signal, fallbackMime)
  if (media) return media
  throw new Error(
    `[${kind}] 自定义接口未解析到媒体。请设置 adapter.resultJsonPath。片段：${JSON.stringify(data).slice(0, 240)}`
  )
}

export async function httpCustomImageGenerate(opts: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  adapter?: AdapterConfig
  extraBody?: Record<string, unknown>
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}): Promise<{ blob: Blob; mimeType: string }> {
  return httpCustomMediaGenerate({ ...opts, kind: 'image' })
}


function fillWorkflowTemplate(
  template: string,
  vars: Record<string, string>
): any {
  let raw = template
  for (const [k, v] of Object.entries(vars)) {
    raw = raw.split(`{{${k}}}`).join(v.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
  }
  return JSON.parse(raw)
}

/** 原生 ComfyUI：POST /prompt，轮询 /history/{id}，取 /view */
export async function comfyPromptGenerate(opts: {
  baseUrl: string
  apiKey?: string
  prompt: string
  negative?: string
  imageDataUrl?: string
  adapter?: AdapterConfig
  signal?: AbortSignal
  kind?: 'image' | 'video'
  onProgress?: (msg: string) => void
}): Promise<{ blob: Blob; mimeType: string }> {
  const base = trimSlash(opts.baseUrl)
  const adapter = opts.adapter || {}
  const submitPath = adapter.path || '/prompt'
  const pollPath = adapter.pollPath || '/history/{id}'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...buildAuthHeader(opts.apiKey || '', {
      ...adapter,
      // Comfy 本机常见无 Bearer
      authPrefix: adapter.authPrefix ?? (opts.apiKey ? 'Bearer ' : '')
    }),
    ...(adapter.headers || {})
  }

  if (!adapter.workflowTemplate?.trim()) {
    throw new Error(
      '[comfyui] 缺少 adapter.workflowTemplate。请在设置页「适配器」粘贴 Comfy API 格式工作流 JSON（可用 {{prompt}} / {{image}} 占位）。应用不会提供假装可用的默认工作流。'
    )
  }
  let payload: any = fillWorkflowTemplate(adapter.workflowTemplate, {
    prompt: opts.prompt,
    negative: opts.negative || '',
    image: opts.imageDataUrl || ''
  })
  if (!payload.prompt && !payload.client_id) {
    // 若模板本身就是 nodes map
    payload = { prompt: payload }
  }
  if (!payload.client_id) {
    payload.client_id = `ai-cut-${Date.now().toString(36)}`
  }

  opts.onProgress?.('提交 ComfyUI 队列…')
  const submitUrl = joinUrl(base, submitPath)
  const submit = await providerHttp(submitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: opts.signal,
    timeoutMs: 120_000
  })
  if (!submit.ok) {
    throw new Error(
      `[comfyui] 提交失败 ${submit.status} ${await submit.text()}\n若是自建 ComfyUI，请在接入里填写 adapter.workflowTemplate（完整 /prompt JSON）。`
    )
  }
  const submitJson = await submit.json()
  const promptId =
    String(submitJson.prompt_id || submitJson.promptId || submitJson.task_id || getByJsonPath(submitJson, 'data.prompt_id') || '').trim()
  if (!promptId) {
    throw new Error(`[comfyui] 提交成功但没有 prompt_id：${JSON.stringify(submitJson).slice(0, 200)}`)
  }

  const started = Date.now()
  const timeoutMs = opts.kind === 'video' ? 15 * 60_000 : 6 * 60_000
  while (Date.now() - started < timeoutMs) {
    if (opts.signal?.aborted) throw new Error('已取消')
    await new Promise((r) => setTimeout(r, 1500))
    const pollUrl = joinUrl(base, pollPath.replace(/\{id\}/g, encodeURIComponent(promptId)))
    const poll = await providerHttp(pollUrl, {
      method: 'GET',
      headers,
      signal: opts.signal,
      timeoutMs: 60_000
    })
    if (!poll.ok) continue
    const hist = await poll.json()
    const entry = hist?.[promptId] || hist?.data || hist
    if (!entry || (typeof entry === 'object' && !entry.outputs && !entry.status)) continue

    const statusStr = String(entry?.status?.status_str || entry?.status || '').toLowerCase()
    if (/error|fail/.test(statusStr)) {
      throw new Error(`[comfyui] 任务失败：${JSON.stringify(entry.status || entry).slice(0, 240)}`)
    }

    const outputs = entry.outputs || entry
    const foundOutputs: Array<{ filename: string; subfolder?: string; type?: string }> = []
    const visit = (node: any) => {
      if (!node || foundOutputs.length) return
      if (Array.isArray(node)) {
        node.forEach(visit)
        return
      }
      if (typeof node !== 'object') return
      if (node.filename && (node.type === 'output' || !node.type || node.subfolder != null)) {
        foundOutputs.push({
          filename: String(node.filename),
          subfolder: node.subfolder ? String(node.subfolder) : '',
          type: node.type ? String(node.type) : 'output'
        })
        return
      }
      for (const v of Object.values(node)) visit(v)
    }
    visit(outputs)
    const fileMeta = foundOutputs[0] || null

    const direct =
      (adapter.resultJsonPath ? getByJsonPath(entry, adapter.resultJsonPath) : null) ||
      findFirstMediaUrl(entry)
    if (typeof direct === 'string' && /^https?:\/\//i.test(direct)) {
      const r = await providerHttp(direct, {
        method: 'GET',
        headers: buildAuthHeader(opts.apiKey || '', adapter),
        signal: opts.signal,
        timeoutMs: 180_000
      })
      if (!r.ok) throw new Error(`[comfyui] 下载失败 ${r.status}`)
      const blob = await r.blob()
      return {
        blob,
        mimeType: blob.type || (opts.kind === 'video' ? 'video/mp4' : 'image/png')
      }
    }

    if (fileMeta) {
      const q = new URLSearchParams({
        filename: fileMeta.filename,
        subfolder: fileMeta.subfolder || '',
        type: fileMeta.type || 'output'
      })
      const viewUrl = `${base}/view?${q.toString()}`
      opts.onProgress?.('下载 ComfyUI 输出…')
      const view = await providerHttp(viewUrl, {
        method: 'GET',
        headers: buildAuthHeader(opts.apiKey || '', adapter),
        signal: opts.signal,
        timeoutMs: 180_000
      })
      if (!view.ok) {
        throw new Error(`[comfyui] /view 失败 ${view.status}`)
      }
      const blob = await view.blob()
      const name = fileMeta.filename.toLowerCase()
      const mime =
        blob.type ||
        (name.endsWith('.mp4')
          ? 'video/mp4'
          : name.endsWith('.webm')
            ? 'video/webm'
            : name.endsWith('.jpg') || name.endsWith('.jpeg')
              ? 'image/jpeg'
              : 'image/png')
      return { blob, mimeType: mime }
    }
    opts.onProgress?.('ComfyUI 生成中…')
  }
  throw new Error('[comfyui] 等待结果超时')
}

export interface ConnectionTestResult {
  ok: boolean
  detail: string
}

/** 廉价连通性探测 */
export async function testEndpointConnection(
  kind: 'llm' | 'vision' | 'image' | 'tts' | 'video' | 'music',
  ep: EndpointLike
): Promise<ConnectionTestResult> {
  const base = trimSlash(ep.baseUrl || '')
  if (!base) return { ok: false, detail: '缺少接口地址' }

  try {
    if (kind === 'llm' || kind === 'vision') {
      const auth = buildAuthHeader(ep.apiKey || '', ep.adapter)
      const authValue = Object.values(auth)[0] || ''
      const modelsUrl = `${base}/models`
      // 1) 先试 /models（浏览器或本机无 CORS 时）
      try {
        const r = await fetch(modelsUrl, {
          headers: { Accept: 'application/json', ...auth },
          signal: timeoutSignal(12_000)
        })
        if (r.ok) return { ok: true, detail: `连通正常（GET ${modelsUrl} → ${r.status}）` }
        if (r.status === 401 || r.status === 403) {
          return { ok: false, detail: `地址可达但鉴权失败（${r.status}）` }
        }
      } catch {
        /* CORS / 网络：桌面端改走 llmFetch */
      }
      // 2) 桌面端：主进程 llmFetch 先 GET /models，失败再极小 chat/completions
      if (isDesktop()) {
        const api = desktop()
        if (typeof api.llmFetch !== 'function') {
          return { ok: false, detail: '桌面端缺少 llmFetch，请重启应用' }
        }
        try {
          const modelsRes = await api.llmFetch({
            url: modelsUrl,
            authorization: String(authValue || ''),
            body: '',
            timeoutMs: 15_000
          })
          if (modelsRes.ok) {
            return { ok: true, detail: `连通正常（GET /models → ${modelsRes.status}，经桌面通道探测 /models）` }
          }
        } catch {
          /* 旧主进程可能仍只允许 chat/completions，继续下面探测 */
        }
        const chatUrl = `${base}/chat/completions`
        try {
          const res = await api.llmFetch({
            url: chatUrl,
            authorization: String(authValue || ''),
            body: JSON.stringify({
              model: ep.model || 'gpt-4o-mini',
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              temperature: 0
            }),
            timeoutMs: 25_000
          })
          if (res.ok) return { ok: true, detail: `连通正常（POST chat/completions → ${res.status}，经桌面通道）` }
          return {
            ok: false,
            detail: `chat/completions 返回 ${res.status} ${String(res.text || '').slice(0, 160)}`
          }
        } catch (e: any) {
          return { ok: false, detail: `桌面通道探测失败：${e?.message || e}` }
        }
      }
      return { ok: false, detail: `无法访问 ${modelsUrl}（可能被 CORS 拦截）。桌面端请用安装版以走主进程通道。` }
    }

    if (kind === 'image') {
      const adapterType = resolveImageAdapter(ep)
      if (adapterType === 'comfyui-prompt' || adapterType === 'comfyui-workflow') {
        const statsUrl = isAutodlHost(base)
          ? `${base.replace(/\/+$/, '')}/api/v1/comfyui/system_stats`.replace(
              /\/api\/v1\/comfyui\/api\/v1\/comfyui/,
              '/api/v1/comfyui'
            )
          : `${base}/system_stats`
        // autodl may not have system_stats — try and fall back
        const tryUrls = isAutodlHost(base)
          ? [`${trimSlash(base)}/api/v1/comfyui/system_stats`, `${trimSlash(base)}/`]
          : [`${base}/system_stats`, `${base}/object_info`, `${base}/`]
        for (const u of tryUrls) {
          try {
            const res = await providerHttp(u, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                ...buildAuthHeader(ep.apiKey || '', {
                  ...ep.adapter,
                  authPrefix: ep.adapter?.authPrefix ?? (isAutodlHost(base) ? '' : 'Bearer ')
                })
              },
              timeoutMs: 15_000
            })
            if (res.ok || res.status === 401 || res.status === 403) {
              return {
                ok: res.ok || res.status === 401 || res.status === 403,
                detail: res.ok
                  ? `连通正常（GET ${u} → ${res.status}）`
                  : `地址可达但鉴权失败（${res.status}），请检查 Token`
              }
            }
          } catch {
            /* try next */
          }
        }
        return { ok: false, detail: 'ComfyUI 探测失败：无法访问 system_stats / 根路径' }
      }
      const url = `${base}/models`
      try {
        const r = await fetch(url, {
          headers: {
            Accept: 'application/json',
            ...buildAuthHeader(ep.apiKey || '', ep.adapter)
          },
          signal: timeoutSignal(15_000)
        })
        if (r.ok) return { ok: true, detail: `连通正常（GET ${url} → ${r.status}）` }
        if (r.status === 401 || r.status === 403) {
          return { ok: false, detail: `地址可达但鉴权失败（${r.status}）` }
        }
        // 有的中转没有 /models，再试 OPTIONS/HEAD generations 不划算；当作「可能可用」
        return {
          ok: r.status < 500,
          detail: `/models 返回 ${r.status}，若接口无模型列表可忽略，直接试出图`
        }
      } catch (e: any) {
        return { ok: false, detail: `探测失败：${e?.message || e}` }
      }
    }

    if (kind === 'video') {
      const adapterType = resolveVideoAdapter(ep)
      if (adapterType === 'comfyui-prompt' || isLocalComfyHost(base)) {
        const res = await providerHttp(`${base}/system_stats`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...buildAuthHeader(ep.apiKey || '', ep.adapter)
          },
          timeoutMs: 15_000
        })
        if (res.ok) return { ok: true, detail: `连通正常（GET /system_stats → ${res.status}）` }
        return { ok: false, detail: `/system_stats 返回 ${res.status} ${await res.text().then((t) => t.slice(0, 120))}` }
      }
      // AutoDL 风格：用带鉴权的轻量请求；无公开 health 时验证 URL + Token 非空
      if (!ep.apiKey?.trim()) return { ok: false, detail: '缺少 AutoDL Token / API Key' }
      if (!ep.workflowId?.trim() && adapterType === 'comfyui-workflow') {
        return { ok: false, detail: '缺少工作流 ID（workflowId）' }
      }
      const root = isAutodlHost(base)
        ? `${trimSlash(base.replace(/\/api\/v1$/i, ''))}/api/v1/comfyui`
        : `${trimSlash(base)}/api/v1/comfyui`
      try {
        const res = await providerHttp(`${root}/system_stats`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...buildAuthHeader(ep.apiKey || '', {
              ...ep.adapter,
              authPrefix: ep.adapter?.authPrefix ?? ''
            })
          },
          timeoutMs: 15_000
        })
        if (res.ok) return { ok: true, detail: `连通正常（${res.status}）` }
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          return {
            ok: true,
            detail: `地址与鉴权通道可达（${res.status}）。AutoDL 若无 system_stats 属正常，配置已足够发起工作流。`
          }
        }
        return { ok: false, detail: `探测返回 ${res.status}` }
      } catch (e: any) {
        return {
          ok: Boolean(ep.apiKey && base),
          detail: `无法完成 HTTP 探测（${e?.message || e}）。已检查到地址与 Token 字段齐全。`
        }
      }
    }

    if (kind === 'tts' || kind === 'music') {
      if (!ep.apiKey?.trim()) return { ok: false, detail: '缺少 API Key' }
      return { ok: true, detail: '已检查地址与 Key 字段（该类型无统一廉价探测端点）' }
    }

    return { ok: false, detail: `不支持的类型 ${kind}` }
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) }
  }
}

export function normalizeAdapterInput(raw: unknown): AdapterConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const type = String(o.type || '').trim() as AdapterType
  const allowed: AdapterType[] = [
    'openai-compatible',
    'openai-images',
    'http-custom',
    'comfyui-workflow',
    'comfyui-prompt'
  ]
  const adapter: AdapterConfig = {}
  if (allowed.includes(type)) adapter.type = type
  if (o.path != null) adapter.path = String(o.path)
  if (o.pollPath != null) adapter.pollPath = String(o.pollPath)
  if (o.pollUrl != null) adapter.pollUrl = String(o.pollUrl)
  if (o.taskIdJsonPath != null) adapter.taskIdJsonPath = String(o.taskIdJsonPath)
  if (o.pollJsonPath != null) adapter.pollJsonPath = String(o.pollJsonPath)
  if (o.resultJsonPath != null) adapter.resultJsonPath = String(o.resultJsonPath)
  if (o.authHeader != null) adapter.authHeader = String(o.authHeader)
  if (o.authPrefix != null) adapter.authPrefix = String(o.authPrefix)
  if (o.workflowTemplate != null) adapter.workflowTemplate = String(o.workflowTemplate)
  if (o.headers && typeof o.headers === 'object') {
    adapter.headers = Object.fromEntries(
      Object.entries(o.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])
    )
  }
  return Object.keys(adapter).length ? adapter : undefined
}
