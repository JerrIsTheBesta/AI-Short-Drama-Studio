/**
 * ComfyUI 工作流：校验 API Format、从本机 userdata 尝试列举、导入文件/URL。
 */

import { buildAuthHeader, providerHttp, type AdapterConfig } from '@/services/ai/adapters'
import { guessInputMap, type ComfyInputBinding } from '@/services/ai/comfyInputMap'

export type ComfyWorkflowFormat = 'api' | 'ui' | 'unknown'

export interface DiscoveredWorkflow {
  id: string
  name: string
  /** userdata 相对路径，如 workflows/foo.json 或 foo.json（取决于服务返回） */
  path: string
  size?: number
  modified?: number
  source: 'userdata' | 'api-workflows' | 'url' | 'file'
  /**
   * 列举成功的目录前缀（如 workflows）。列表接口常返回相对该目录的路径，
   * 读取文件时必须把这个前缀拼回去，否则 404。
   */
  root?: string
  /** 列举成功的接口（如 /userdata、/api/v2/userdata），读取时优先复用 */
  endpoint?: string
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
  /** 调试用：实际请求过的完整 URL 与返回状态 */
  tried?: string[]
  /** 解析后的节点图，供助手分析输入映射 */
  payload?: any
  /** 规则初判的输入节点（助手分析前 / 助手不可用时的兜底） */
  bindings?: ComfyInputBinding[]
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
  // 不再往 JSON 里写死占位符：节点怎么接输入由助手读完结构后给出映射，
  // 保存时会一并把映射写进接入配置。
  const bindings = guessInputMap(payload).bindings
  return {
    ok: true,
    format: 'api',
    template: JSON.stringify(payload, null, 2),
    payload,
    detail: '已识别为 API Format。请点「用助手分析工作流」，由助手确认提示词 / 参考图该接到哪个节点。',
    bindings
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

function normalizeListedFiles(
  data: unknown,
  dirHint: string,
  endpoint?: string
): DiscoveredWorkflow[] {
  const out: DiscoveredWorkflow[] = []
  const root = String(dirHint || '').replace(/^\/+|\/+$/g, '')
  const push = (pathRaw: string, size?: number, modified?: number) => {
    let rel = String(pathRaw || '').replace(/^\/+/, '')
    if (!rel) return
    if (/\.json$/i.test(rel)) {
      const name = rel.split('/').pop() || rel
      out.push({
        id: rel,
        name,
        path: rel,
        size,
        modified,
        source: 'userdata',
        root: root || undefined,
        endpoint
      })
    }
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
      const found = normalizeListedFiles(res.data, dir.replace(/\/$/, ''), listPath)
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

function uniqStrings(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))]
}

/**
 * 拉取 userdata 中的单个工作流文件。
 * 关键：列表接口通常返回「相对目录」的路径（如 C图像-Zimage/xx.json），
 * 读取时必须把列举时用的目录前缀（workflows 等）拼回去，否则必然 404。
 */
export async function fetchComfyUserdataWorkflow(opts: {
  baseUrl: string
  path: string
  apiKey?: string
  adapter?: AdapterConfig
  /** 列举时成功的目录前缀（来自 DiscoveredWorkflow.root） */
  root?: string
  /** 列举时成功的接口（来自 DiscoveredWorkflow.endpoint） */
  endpoint?: string
  source?: DiscoveredWorkflow['source']
}): Promise<WorkflowParseResult> {
  const base = trimSlash(opts.baseUrl || '')
  const rel = String(opts.path || '').replace(/^\/+/, '')
  if (!base || !rel) return { ok: false, format: 'unknown', detail: '缺少地址或路径' }
  const headers = authHeaders(opts.apiKey, opts.adapter)

  const roots = uniqStrings([opts.root || '', 'workflows', 'user/default/workflows', 'default/workflows', ''])
  const endpoints = uniqStrings([
    opts.endpoint || '',
    '/userdata',
    '/api/userdata',
    '/v2/userdata',
    '/api/v2/userdata'
  ])
  const relSeg = rel.split('/').map(encodeURIComponent).join('/')
  const relFlat = encodeURIComponent(rel)
  const fullSeg = (root: string) => (root ? `${root}/${rel}` : rel)

  const build = (ep: string, root: string) => {
    const prefix = root ? `${ep}/${root.split('/').map(encodeURIComponent).join('/')}` : ep
    return [`${prefix}/${relSeg}`, `${prefix}/${relFlat}`]
  }
  const knownRoot = opts.root || ''
  const knownEp = opts.endpoint || ''
  const otherRoots = roots.filter((r) => r !== knownRoot)
  const otherEps = endpoints.filter((e) => e !== knownEp)
  const candidates: string[] = []
  // 1) 列举成功时的接口 + 目录（最可能命中），两种编码都试
  if (knownEp) candidates.push(...build(knownEp, knownRoot))
  // 2) 同一接口换目录前缀（列表返回相对路径的情况）
  if (knownEp) for (const r of otherRoots) candidates.push(...build(knownEp, r).slice(0, 1))
  // 3) 换接口、仍用已知目录
  for (const e of otherEps) candidates.push(...build(e, knownRoot).slice(0, 1))
  // 4) 最常见兜底：/userdata/workflows/... 与 /api/userdata/workflows/...
  candidates.push(...build('/userdata', 'workflows').slice(0, 1), ...build('/api/userdata', 'workflows').slice(0, 1))
  // 5) 查询串形式（部分网关 / 云 API 用 ?file= 而不是路径参数）
  for (const ep of endpoints) {
    for (const root of roots) {
      candidates.push(`${ep}?file=${encodeURIComponent(fullSeg(root))}`)
    }
  }
  // 6) 部分扩展把工作流当资源暴露（/api/workflows/xx）
  if (opts.source === 'api-workflows' || !opts.source) {
    const id = encodeURIComponent(rel)
    candidates.push(`/api/workflows/${id}`, `/workflows/${id}`)
  }
  const tried: string[] = []
  let last = ''
  for (const path of uniqStrings(candidates)) {
    const url = joinUrl(base, path)
    const res = await tryGetJson(url, headers)
    tried.push(`${res.status || 'ERR'} ${url}`)
    if (!res.ok || res.data == null) {
      last = `${res.status || '无响应'} ${(res.text || '').slice(0, 80)}`.trim()
      continue
    }
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    return parseComfyWorkflowJson(text)
  }
  return {
    ok: false,
    format: 'unknown',
    tried,
    detail: `无法读取工作流文件「${rel}」。已试 ${tried.length} 种路径${last ? `，最后返回：${last}` : ''}。请点「查看尝试过的地址」把结果发我，或改用「粘贴 API Format JSON」/「从文件导入」。`
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
