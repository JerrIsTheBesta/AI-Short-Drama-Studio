/**
 * ComfyUI 工作流：校验 API Format、从本机 userdata 尝试列举、导入文件/URL。
 */

import { buildAuthHeader, providerHttp, type AdapterConfig } from '@/services/ai/adapters'

export type ComfyWorkflowFormat = 'api' | 'ui' | 'unknown'

export interface DiscoveredWorkflow {
  id: string
  name: string
  /** userdata 相对路径，如 workflows/foo.json */
  path: string
  size?: number
  modified?: number
  source: 'userdata' | 'api-workflows' | 'url' | 'file'
}

export interface DiscoverResult {
  ok: boolean
  reachable: boolean
  workflows: DiscoveredWorkflow[]
  /** 向用户说明探测结果（含「官方无统一列表」等诚实提示） */
  message: string
  tried: string[]
}

export interface WorkflowParseResult {
  ok: boolean
  format: ComfyWorkflowFormat
  /** 可写入 adapter.workflowTemplate 的字符串（API 提交体） */
  template?: string
  detail: string
}

function trimSlash(url: string) {
  return (url || '').replace(/\/+$/, '')
}

function joinUrl(base: string, path: string) {
  const b = trimSlash(base)
  if (/^https?:\/\//i.test(path)) return path
  return `${b}/${String(path).replace(/^\//, '')}`
}

export function detectWorkflowFormat(raw: unknown): ComfyWorkflowFormat {
  if (!raw || typeof raw !== 'object') return 'unknown'
  const o = raw as Record<string, unknown>
  if (o.prompt && typeof o.prompt === 'object') {
    const nodes = o.prompt as Record<string, unknown>
    const first = Object.values(nodes)[0]
    if (first && typeof first === 'object' && 'class_type' in (first as object)) return 'api'
  }
  const values = Object.values(o)
  if (
    values.some(
      (v) => v && typeof v === 'object' && 'class_type' in (v as object) && 'inputs' in (v as object)
    )
  ) {
    return 'api'
  }
  if (Array.isArray(o.nodes) && (Array.isArray(o.links) || o.last_node_id != null)) return 'ui'
  return 'unknown'
}

/** 把粘贴/导入的 JSON 规范成可提交的 workflowTemplate */
export function parseComfyWorkflowJson(text: string): WorkflowParseResult {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { ok: false, format: 'unknown', detail: '内容为空' }
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch (e: any) {
    return { ok: false, format: 'unknown', detail: `JSON 无效：${e?.message || e}` }
  }
  const format = detectWorkflowFormat(obj)
  if (format === 'ui') {
    return {
      ok: false,
      format,
      detail:
        '这是 Comfy「界面格式」工作流（含 nodes/links），不能直接 POST /prompt。请在 Comfy 菜单选择 Save (API Format) 再粘贴。'
    }
  }
  if (format === 'unknown') {
    return {
      ok: false,
      format,
      detail: '无法识别为 Comfy API 工作流（需要带 class_type 的节点图，或 { "prompt": { ... } }）。'
    }
  }
  const o = obj as Record<string, unknown>
  let payload: Record<string, unknown>
  if (o.prompt && typeof o.prompt === 'object') {
    payload = { ...o }
  } else {
    payload = { prompt: o }
  }
  if (!payload.client_id) payload.client_id = 'ai-cut'
  return {
    ok: true,
    format: 'api',
    template: JSON.stringify(payload, null, 2),
    detail: '已识别为 API Format，可保存到当前接入。'
  }
}

function authHeaders(apiKey?: string, adapter?: AdapterConfig): Record<string, string> {
  return {
    Accept: 'application/json',
    ...buildAuthHeader(apiKey || '', {
      ...adapter,
      authPrefix: adapter?.authPrefix ?? ''
    })
  }
}

async function tryGetJson(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; data?: any; text?: string }> {
  try {
    const res = await providerHttp(url, { method: 'GET', headers, timeoutMs: 12_000 })
    const text = await res.text()
    if (!res.ok) return { ok: false, status: res.status, text: text.slice(0, 200) }
    try {
      return { ok: true, status: res.status, data: JSON.parse(text || 'null') }
    } catch {
      return { ok: false, status: res.status, text: text.slice(0, 200) }
    }
  } catch (e: any) {
    return { ok: false, status: 0, text: e?.message || String(e) }
  }
}

function normalizeListedFiles(data: unknown, dirHint: string): DiscoveredWorkflow[] {
  const out: DiscoveredWorkflow[] = []
  const push = (pathRaw: string, size?: number, modified?: number) => {
    let rel = String(pathRaw || '').replace(/^\/+/, '')
    if (!rel) return
    if (!rel.includes('/') && dirHint) rel = `${dirHint.replace(/\/$/, '')}/${rel}`
    if (!/\.json$/i.test(rel)) return
    const name = rel.split('/').pop() || rel
    out.push({
      id: rel,
      name,
      path: rel,
      size,
      modified,
      source: 'userdata'
    })
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        const path = String(o.path || o.name || o.file || '')
        push(path, typeof o.size === 'number' ? o.size : undefined, typeof o.modified === 'number' ? o.modified : undefined)
      }
    }
  }
  return out
}

/**
 * 探测本机 Comfy 是否可达，并尝试列举已保存工作流。
 * 官方桌面端通过 GET /userdata?dir=workflows 列举；无此目录时诚实说明。
 */
export async function discoverComfyWorkflows(opts: {
  baseUrl: string
  apiKey?: string
  adapter?: AdapterConfig
}): Promise<DiscoverResult> {
  const base = trimSlash(opts.baseUrl || '')
  const tried: string[] = []
  if (!base) {
    return {
      ok: false,
      reachable: false,
      workflows: [],
      message: '缺少 ComfyUI 地址',
      tried
    }
  }
  const headers = authHeaders(opts.apiKey, opts.adapter)

  // 1) 连通性：/system_stats 或 /object_info
  let reachable = false
  for (const path of ['/system_stats', '/api/system_stats', '/object_info', '/api/object_info']) {
    const url = joinUrl(base, path)
    tried.push(`GET ${path}`)
    const res = await tryGetJson(url, headers)
    if (res.ok) {
      reachable = true
      break
    }
  }
  if (!reachable) {
    return {
      ok: false,
      reachable: false,
      workflows: [],
      message: '无法连接 ComfyUI（已试 system_stats / object_info）。请确认服务已启动且地址正确。',
      tried
    }
  }

  // 2) userdata 列表（本地 Comfy 常见）
  const dirs = ['workflows', 'workflows/', 'user/default/workflows', 'default/workflows']
  const listPaths = ['/userdata', '/api/userdata', '/v2/userdata', '/api/v2/userdata']
  let workflows: DiscoveredWorkflow[] = []
  for (const listPath of listPaths) {
    for (const dir of dirs) {
      const q =
        listPath.includes('v2')
          ? `path=${encodeURIComponent(dir)}`
          : `dir=${encodeURIComponent(dir)}&recurse=true&full_info=true`
      const url = `${joinUrl(base, listPath)}?${q}`
      tried.push(`GET ${listPath}?dir=${dir}`)
      const res = await tryGetJson(url, headers)
      if (!res.ok) continue
      const found = normalizeListedFiles(res.data, dir.replace(/\/$/, ''))
      if (found.length) {
        workflows = found
        break
      }
    }
    if (workflows.length) break
  }

  // 3) 部分扩展：/api/workflows（非官方标配）
  if (!workflows.length) {
    for (const path of ['/api/workflows', '/workflows']) {
      tried.push(`GET ${path}`)
      const res = await tryGetJson(joinUrl(base, path), headers)
      if (!res.ok) continue
      const list = res.data?.workflows || res.data?.data || res.data
      if (Array.isArray(list)) {
        workflows = list.map((item: any, i: number) => ({
          id: String(item.id || item.name || i),
          name: String(item.name || item.id || `workflow-${i}`),
          path: String(item.path || item.name || item.id || ''),
          source: 'api-workflows' as const
        }))
        if (workflows.length) break
      }
    }
  }

  if (workflows.length) {
    return {
      ok: true,
      reachable: true,
      workflows,
      message: `已从 ComfyUI 列举到 ${workflows.length} 个工作流文件。选中后会拉取内容；请确认是 API Format。`,
      tried
    }
  }

  return {
    ok: true,
    reachable: true,
    workflows: [],
    message:
      'ComfyUI 已连通，但未能列举已保存工作流（本机 userdata/workflows 为空，或当前版本未开放列表）。请使用「粘贴 API Format JSON」「从文件导入」或填写工作流 URL。',
    tried
  }
}

/** 拉取 userdata 中的单个工作流文件 */
export async function fetchComfyUserdataWorkflow(opts: {
  baseUrl: string
  path: string
  apiKey?: string
  adapter?: AdapterConfig
}): Promise<WorkflowParseResult> {
  const base = trimSlash(opts.baseUrl || '')
  const rel = String(opts.path || '').replace(/^\/+/, '')
  if (!base || !rel) return { ok: false, format: 'unknown', detail: '缺少地址或路径' }
  const headers = authHeaders(opts.apiKey, opts.adapter)
  const candidates = [
    `/userdata/${rel.split('/').map(encodeURIComponent).join('/')}`,
    `/userdata/${encodeURIComponent(rel)}`,
    `/api/userdata/${rel.split('/').map(encodeURIComponent).join('/')}`,
    `/api/userdata/${encodeURIComponent(rel)}`
  ]
  for (const path of candidates) {
    const res = await tryGetJson(joinUrl(base, path), headers)
    if (!res.ok || res.data == null) continue
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    return parseComfyWorkflowJson(text)
  }
  return {
    ok: false,
    format: 'unknown',
    detail: `无法读取工作流文件「${rel}」。若路径含多级目录，部分旧版 Comfy 可能不支持，请改用粘贴或文件导入。`
  }
}

export async function fetchWorkflowFromUrl(url: string, apiKey?: string, adapter?: AdapterConfig): Promise<WorkflowParseResult> {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) return { ok: false, format: 'unknown', detail: '请填写 http(s) 工作流 URL' }
  const res = await tryGetJson(u, authHeaders(apiKey, adapter))
  if (!res.ok) return { ok: false, format: 'unknown', detail: `下载失败 ${res.status} ${res.text || ''}` }
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  return parseComfyWorkflowJson(text)
}

export function readWorkflowFile(file: File): Promise<WorkflowParseResult> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(parseComfyWorkflowJson(String(reader.result || '')))
    reader.onerror = () => resolve({ ok: false, format: 'unknown', detail: '读取文件失败' })
    reader.readAsText(file)
  })
}
