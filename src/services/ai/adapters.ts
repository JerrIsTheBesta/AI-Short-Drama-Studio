/**
 * 自定义接入适配器：OpenAI 兼容 / 自定义 HTTP / ComfyUI（AutoDL 风格 + 原生 /prompt）
 * 配置写在 settings 的 adapter 字段，运行时按 type 分流。
 */

import { desktop, isDesktop } from '@/services/desktop'

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
  | 'comfyui-prompt'

export interface AdapterConfig {
  /** 适配器类型；缺省时按 provider / URL 推断 */
  type?: AdapterType
  /** 相对 baseUrl 的请求路径，如 /images/generations 或 /prompt */
  path?: string
  /** 轮询路径模板，可用 {id}，如 /history/{id} */
  pollPath?: string
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
  const t = ep.adapter?.type
  if (t === 'http-custom' || t === 'comfyui-prompt' || t === 'openai-images' || t === 'comfyui-workflow') {
    return t
  }
  if (t === 'openai-compatible') return 'openai-images'
  if (isAutodlHost(ep.baseUrl || '')) return 'comfyui-workflow'
  return 'openai-images'
}

/** 推断视频适配器 */
export function resolveVideoAdapter(ep: EndpointLike): AdapterType {
  const t = ep.adapter?.type
  if (t === 'http-custom' || t === 'comfyui-prompt' || t === 'comfyui-workflow') return t
  const url = ep.baseUrl || ''
  if (isAutodlHost(url) || ep.provider === 'autodl') return 'comfyui-workflow'
  if (ep.provider === 'custom' || isLocalComfyHost(url) || /comfy/i.test(url)) return 'comfyui-prompt'
  // 默认仍走 AutoDL 风格工作流 API（兼容旧配置）
  return 'comfyui-workflow'
}

export function buildAuthHeader(
  apiKey: string,
  adapter?: AdapterConfig
): Record<string, string> {
  const token = (apiKey || '').trim()
  if (!token) return {}
  const name = (adapter?.authHeader || 'Authorization').trim() || 'Authorization'
  const prefix =
    adapter?.authPrefix === undefined || adapter?.authPrefix === null
      ? name.toLowerCase() === 'authorization'
        ? 'Bearer '
        : ''
      : String(adapter.authPrefix)
  return { [name]: `${prefix}${token}` }
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
  const preferProxy =
    isDesktop() && (isAutodlHost(url) || isLocalComfyHost(url) || /\/api\/v1\/comfyui\//i.test(url))

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
      body: init.body,
      timeoutMs
    })
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.text,
      json: async () => JSON.parse(res.text || '{}')
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
    const text = await resp.text()
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
      }
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

/** 自定义 HTTP 生图：POST JSON，从 resultJsonPath 或启发式取 URL/b64 */
export async function httpCustomImageGenerate(opts: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  adapter?: AdapterConfig
  extraBody?: Record<string, unknown>
  signal?: AbortSignal
}): Promise<{ blob: Blob; mimeType: string }> {
  const adapter = opts.adapter || {}
  const path = adapter.path || '/images/generations'
  const url = joinUrl(opts.baseUrl, path)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...buildAuthHeader(opts.apiKey, adapter),
    ...(adapter.headers || {})
  }
  const body = {
    model: opts.model,
    prompt: opts.prompt,
    ...(opts.extraBody || {})
  }
  const res = await providerHttp(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
    timeoutMs: 180_000
  })
  if (!res.ok) {
    throw new Error(`[image] 自定义接口失败 ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  const picked =
    (adapter.resultJsonPath ? getByJsonPath(data, adapter.resultJsonPath) : undefined) ??
    getByJsonPath(data, 'data.0.b64_json') ??
    getByJsonPath(data, 'data.0.url') ??
    findFirstMediaUrl(data)

  if (typeof picked === 'string' && picked.startsWith('data:')) {
    const m = picked.match(/^data:([^;]+);base64,(.+)$/i)
    if (!m) throw new Error('[image] data URI 无法解析')
    const bin = atob(m[2].replace(/\s/g, ''))
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return { blob: new Blob([arr], { type: m[1] }), mimeType: m[1] }
  }
  if (typeof picked === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(picked) && picked.length > 256 && !/^https?:/i.test(picked)) {
    const raw = picked.replace(/\s/g, '')
    const bin = atob(raw)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const mime =
      arr[0] === 0x89 && arr[1] === 0x50
        ? 'image/png'
        : arr[0] === 0xff && arr[1] === 0xd8
          ? 'image/jpeg'
          : 'image/png'
    return { blob: new Blob([arr], { type: mime }), mimeType: mime }
  }
  if (typeof picked === 'string' && /^https?:\/\//i.test(picked)) {
    const r = await fetch(picked, { signal: opts.signal })
    if (!r.ok) throw new Error(`[image] 下载结果失败 ${r.status}`)
    const blob = await r.blob()
    return { blob, mimeType: blob.type || 'image/png' }
  }
  throw new Error(
    `[image] 自定义接口未解析到图片。可在 adapter.resultJsonPath 指定路径。片段：${JSON.stringify(data).slice(0, 240)}`
  )
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

function defaultComfyImageWorkflow(prompt: string, imageDataUrl?: string) {
  // 极简占位：用户应在 adapter.workflowTemplate 提供真实工作流
  const nodes: Record<string, unknown> = {
    '1': {
      class_type: 'CLIPTextEncode',
      inputs: { text: prompt, clip: ['4', 1] }
    },
    '4': {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'model.safetensors' }
    }
  }
  if (imageDataUrl) {
    nodes['10'] = {
      class_type: 'LoadImage',
      inputs: { image: imageDataUrl }
    }
  }
  return { prompt: nodes }
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

  let payload: any
  if (adapter.workflowTemplate?.trim()) {
    payload = fillWorkflowTemplate(adapter.workflowTemplate, {
      prompt: opts.prompt,
      negative: opts.negative || '',
      image: opts.imageDataUrl || ''
    })
    if (!payload.prompt && !payload.client_id) {
      // 若模板本身就是 nodes map
      payload = { prompt: payload }
    }
  } else {
    payload = defaultComfyImageWorkflow(opts.prompt, opts.imageDataUrl)
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
      const r = await fetch(direct, { signal: opts.signal })
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
      // providerHttp returns text — for binary we need raw fetch for /view
      const binResp = await fetch(viewUrl, {
        headers: buildAuthHeader(opts.apiKey || '', adapter),
        signal: opts.signal
      })
      if (!binResp.ok) {
        throw new Error(`[comfyui] /view 失败 ${binResp.status}（poll=${view.status}）`)
      }
      const blob = await binResp.blob()
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
      const url = `${base}/models`
      const headers = {
        Accept: 'application/json',
        ...buildAuthHeader(ep.apiKey || '', ep.adapter)
      }
      let res: ProxyHttpResult
      if (isDesktop()) {
        // llmFetch 限制必须是 chat/completions；models 用普通 fetch / autodl 通道不适用
        try {
          const r = await fetch(url, { headers, signal: timeoutSignal(15_000) })
          res = {
            ok: r.ok,
            status: r.status,
            text: () => r.text(),
            json: () => r.json()
          }
        } catch (e: any) {
          // 桌面端 CORS 时退化为 chat/completions 空探测不可行；报网络错误
          return { ok: false, detail: `探测 /models 失败：${e?.message || e}` }
        }
      } else {
        const r = await fetch(url, { headers, signal: timeoutSignal(15_000) })
        res = {
          ok: r.ok,
          status: r.status,
          text: () => r.text(),
          json: () => r.json()
        }
      }
      if (!res.ok) return { ok: false, detail: `/models 返回 ${res.status} ${await res.text().then((t) => t.slice(0, 160))}` }
      return { ok: true, detail: `连通正常（GET ${url} → ${res.status}）` }
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
