/**
 * 自建 ComfyUI 一键接入：只填 baseUrl，写入生图 / 视频 profile（comfyui-prompt）。
 * 真正出图/出视频仍需用户在适配器里粘贴 workflowTemplate。
 */

import {
  testEndpointConnection,
  type AdapterConfig
} from '@/services/ai/adapters'
import { uniqueProfileName, useSettingsStore } from '@/stores/settings'

export type ComfyQuickKind = 'image' | 'video'

export interface ComfyQuickAddInput {
  baseUrl: string
  apiKey?: string
  /** 默认同时加生图 + 视频 */
  kinds?: ComfyQuickKind[]
  /** 添加后设为当前选中，默认 true */
  select?: boolean
  /** 可选连通探测 */
  test?: boolean
}

export interface ComfyQuickAddResult {
  ok: boolean
  baseUrl: string
  imageId?: string
  videoId?: string
  notes: string[]
  test?: { ok: boolean; detail: string }
}

export function normalizeComfyBaseUrl(raw: string): string {
  let u = String(raw || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  u = u.replace(/\/+$/, '')
  // 去掉误粘的 Comfy 路径
  u = u
    .replace(/\/prompt$/i, '')
    .replace(/\/system_stats$/i, '')
    .replace(/\/history(\/.*)?$/i, '')
    .replace(/\/view(\?.*)?$/i, '')
    .replace(/\/+$/, '')
  return u
}

export function looksLikeComfyUrl(url: string): boolean {
  const u = normalizeComfyBaseUrl(url)
  if (!u) return false
  try {
    const host = new URL(u).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
    if (/comfy/i.test(u)) return true
    const port = new URL(u).port
    if (port === '8188' || port === '8189') return true
  } catch {
    return false
  }
  return /comfyui|8188/i.test(u)
}

function defaultAdapter(): AdapterConfig {
  return {
    type: 'comfyui-prompt',
    path: '/prompt',
    pollPath: '/history/{id}',
    authPrefix: ''
  }
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** 写入本机设置：生图 / 视频 ComfyUI profile */
export async function addComfyUiProfiles(input: ComfyQuickAddInput): Promise<ComfyQuickAddResult> {
  const settings = useSettingsStore()
  const baseUrl = normalizeComfyBaseUrl(input.baseUrl)
  const notes: string[] = []
  if (!baseUrl) {
    return { ok: false, baseUrl: '', notes: ['请填写 ComfyUI 地址，例如 http://127.0.0.1:8188'] }
  }

  const kinds = input.kinds?.length ? input.kinds : (['image', 'video'] as ComfyQuickKind[])
  const apiKey = String(input.apiKey || '').trim()
  const select = input.select !== false
  const adapter = defaultAdapter()
  const label = hostLabel(baseUrl)
  let imageId: string | undefined
  let videoId: string | undefined

  if (kinds.includes('image')) {
    const name = uniqueProfileName(
      settings.config.images.map((p) => p.name),
      `ComfyUI 生图 (${label})`
    )
    imageId = settings.addImage({
      name,
      baseUrl,
      apiKey,
      model: 'comfyui',
      models: ['comfyui'],
      provider: 'custom',
      adapter
    })
    if (select) settings.selectImage(imageId)
    notes.push(`已添加生图接入「${name}」`)
  }

  if (kinds.includes('video')) {
    const name = uniqueProfileName(
      settings.config.videos.map((p) => p.name),
      `ComfyUI 视频 (${label})`
    )
    videoId = settings.addVideo({
      name,
      baseUrl,
      apiKey,
      workflowId: 'comfyui-local',
      promptStyle: 'scene-narrative',
      provider: 'custom',
      stillMode: 'keyframe',
      adapter
    })
    if (select) settings.selectVideo(videoId)
    notes.push(`已添加视频接入「${name}」`)
  }

  notes.push(
    '出图/出视频前请在「适配器 → workflowTemplate」粘贴 Comfy「Save (API Format)」导出的 JSON，然后让助手分析出输入映射（提示词 / 参考图写到哪个节点）。'
  )

  let test: ComfyQuickAddResult['test']
  if (input.test) {
    const probeKind = kinds.includes('video') ? 'video' : 'image'
    const ep = {
      baseUrl,
      apiKey,
      model: 'comfyui',
      workflowId: 'comfyui-local',
      provider: 'custom',
      adapter
    }
    const result = await testEndpointConnection(probeKind, ep)
    test = result
    notes.push(result.ok ? `连通测试通过：${result.detail}` : `连通测试失败：${result.detail}`)
  }

  return {
    ok: Boolean(imageId || videoId),
    baseUrl,
    imageId,
    videoId,
    notes,
    test
  }
}

/** 从用户一句话里抽 Comfy 地址 */
export function extractComfyMention(text: string): { baseUrl: string; apiKey: string } | null {
  const t = String(text || '')
  const urlMatch =
    t.match(/https?:\/\/[^\s"'<>`]+/i) ||
    t.match(/(?:^|[\s：:是在])((?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s]*)?)/i) ||
    t.match(/(?:^|[\s：:是在])((?:\d{1,3}\.){3}\d{1,3}:\d{2,5})/)
  if (!urlMatch) return null
  let raw = (urlMatch[1] || urlMatch[0] || '').replace(/[),.;]+$/g, '')
  const baseUrl = normalizeComfyBaseUrl(raw)
  if (!baseUrl) return null

  const mentionsComfy =
    /comfy\s*ui|comfyui|自建\s*comfy|本地\s*comfy|我的\s*comfy|图生视频.*本机|本机.*出图/i.test(t) ||
    (/在\s*.+/.test(t) && /8188|localhost|127\.0\.0\.1/i.test(t))
  const bareShort = t.trim().length < 160 && /^(https?:\/\/)?[\w.:\[\]\/]+$/i.test(t.trim())
  // 明确提到 Comfy，或地址像本机/8188，或用户只丢了一个短地址
  if (!mentionsComfy && !looksLikeComfyUrl(baseUrl) && !bareShort) return null
  // 短地址但完全不像本地/Comfy（例如官方 https://api.openai.com）则跳过
  if (!mentionsComfy && !looksLikeComfyUrl(baseUrl) && bareShort) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase()
      if (host.includes('openai.com') || host.includes('aliyuncs.com') || host.includes('deepseek')) {
        return null
      }
    } catch { /* keep */ }
  }

  const key =
    t.match(/(?:api[_-]?key|token|令牌|密钥)[：:=\s]+([A-Za-z0-9._-]{8,})/i)?.[1] || ''
  return { baseUrl, apiKey: key }
}
