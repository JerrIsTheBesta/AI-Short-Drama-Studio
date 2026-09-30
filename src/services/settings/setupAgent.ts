/**
 * 设置页接入助手：依赖已配置的 LLM，帮用户写入视觉 / 生图 / 配音 / 视频。
 */

import { callLLM } from '@/services/ai/client'
import { getLlmConfig } from '@/services/ai/runtime'
import {
  IMAGE_PROVIDERS,
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  VIDEO_PROVIDERS,
  VISION_PROVIDERS,
  applyProviderPreset,
  findProvider,
  matchProviderId,
  type ProviderPreset
} from '@/services/ai/providers'
import { parseJsonRobust } from '@/utils/jsonRepair'
import {
  endpointReady,
  uniqueProfileName,
  useSettingsStore,
  type SetupKind
} from '@/stores/settings'
import { stillModeForVideoModel } from '@/types/canvas'
import settingsSkillRaw from '@/skills/settings-setup.md?raw'
import {
  normalizeAdapterInput,
  testEndpointConnection,
  type AdapterConfig
} from '@/services/ai/adapters'

export interface SetupMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SetupEvent {
  kind?: 'think' | 'step' | 'log'
  label: string
  step?: string
  status?: 'running' | 'done' | 'fail'
}

export interface SetupTurnResult {
  reply: string
  chips: { label: string; text: string }[]
  opened?: SetupKind
}

function catalog(presets: ProviderPreset[]) {
  return presets
    .filter((p) => p.id !== 'custom')
    .map((p) => `${p.id}｜${p.name}｜${p.baseUrl}｜默认 ${p.defaultModel}｜${p.models.join(', ')}`)
    .join('\n')
}

function maskKey(key: string) {
  const k = key.trim()
  if (!k) return '未填'
  if (k.length <= 6) return '已填写'
  return `${k.slice(0, 3)}…${k.slice(-4)}`
}

function snapshot() {
  const cfg = useSettingsStore().config
  const named = (kind: string, list: { id: string; name: string; baseUrl: string; apiKey: string; model: string; models?: string[]; adapter?: AdapterConfig }[]) =>
    list
      .map(
        (p) =>
          `- [${kind}] ${p.name} (${p.id}) url=${p.baseUrl || '空'} key=${maskKey(p.apiKey)} model=${p.model || '空'} adapter=${p.adapter?.type || '默认'} models=${(p.models || []).join(', ') || '无'}`
      )
      .join('\n')
  const videos = cfg.videos
    .map(
      (p) =>
        `- [video] ${p.name} (${p.id}) url=${p.baseUrl || '空'} key=${maskKey(p.apiKey)} workflow=${p.workflowId || '空'} adapter=${p.adapter?.type || '默认'} style=${p.promptStyle} still=${p.stillMode || 'identity'}`
    )
    .join('\n')
  return `当前本机配置（Key 已脱敏）：
LLM 是否可用：${endpointReady(cfg.llm) ? '是' : '否'}
${named('llm', cfg.llms)}
${named('vision', cfg.visions)}
${named('image', cfg.images)}
${named('tts', cfg.ttsProfiles)}
${videos}`
}

const SYSTEM = `${settingsSkillRaw}

只输出 JSON：{ "say": "给用户看的话", "actions": [ ... ] }
一次最多 8 个 actions。没有把握就 actions 为空，先问。文档已经够写的时候不要空 actions。

可用工具：
{ "tool": "add_profile", "kind": "vision|image|tts|video|llm", "name": "显示名", "provider": "预设id，可选", "baseUrl": "", "apiKey": "", "model": "", "models": ["可选"], "voice": "tts可选", "workflowId": "video可选", "promptStyle": "scene-narrative|formatted", "stillMode": "identity|keyframe|storyboard，video可选。H3用人设+场景填 identity，其它模型要关键帧填 keyframe", "adapter": { "type": "openai-compatible|openai-images|http-custom|comfyui-workflow|comfyui-prompt", "path": "可选", "pollPath": "可选含{id}", "resultJsonPath": "可选", "authHeader": "可选", "authPrefix": "可选，Bearer 或空", "workflowTemplate": "ComfyUI /prompt JSON，可用{{prompt}}{{image}}" } }
{ "tool": "update_profile", "kind": "…", "id": "profile_id", "name": "可选", "baseUrl": "可选", "apiKey": "可选", "model": "可选", "models": ["可选"], "voice": "可选", "workflowId": "可选", "promptStyle": "可选", "adapter": "可选，同上" }
{ "tool": "select_profile", "kind": "…", "id": "…", "model": "可选，设为当前模型" }
{ "tool": "add_model", "kind": "llm|vision|image|tts", "id": "profile_id，可省略表示当前套", "model": "模型名" }
{ "tool": "test_connection", "kind": "llm|vision|image|tts|video", "id": "可选，默认当前套" }

预设目录（id｜名称｜地址｜默认模型｜常用模型）：
LLM
${catalog(LLM_PROVIDERS)}
视觉
${catalog(VISION_PROVIDERS)}
生图
${catalog(IMAGE_PROVIDERS)}
配音
${catalog(TTS_PROVIDERS)}
视频
${catalog(VIDEO_PROVIDERS)}

注意：
- 用户贴 API 文档或中转地址时：provider 必须是 custom，按文档原文抽 Base URL 和模型名，立刻 add_profile。禁止拒绝。
- 文档同时含聊天 / 看图 / 生图时，每种 kind 各写一条，可共用同一套 Key 和地址。
- Base URL 写到 /v1 这一层即可，不要带 /chat/completions 或 /images/generations。
- 只有用户没给任何文档、只说「帮我配」时，才从上面的大厂预设里选。
- 视频的 model 若没单独给 workflowId，就当作 workflowId。
- 配音默认音色 longanhuan_v3.6，用户没提音色就用这个。
- provider 对得上大厂预设、且用户没另给第三方地址时，用预设补全；用户给的 URL 与预设域名不一致时一律当 custom，不要改写成官方地址。
- 自建 ComfyUI（如 http://127.0.0.1:8188）：kind=video 或 image，provider=custom，adapter.type=comfyui-prompt；有工作流 JSON 就放进 adapter.workflowTemplate。不要编造 AutoDL 实例生命周期。
- OpenAI 兼容中转：LLM/视觉用默认；生图若不是 /images/generations，设 adapter.type=http-custom 并填 path、resultJsonPath。
- 写完接入后，若用户要求「测一下」，调用 test_connection。`

function providersFor(kind: SetupKind): ProviderPreset[] {
  if (kind === 'llm') return LLM_PROVIDERS
  if (kind === 'vision') return VISION_PROVIDERS
  if (kind === 'image') return IMAGE_PROVIDERS
  if (kind === 'tts') return TTS_PROVIDERS
  return VIDEO_PROVIDERS
}

function parseKind(raw: unknown): SetupKind | null {
  const k = String(raw || '')
  if (k === 'llm' || k === 'vision' || k === 'image' || k === 'tts' || k === 'video') {
    return k
  }
  return null
}

function normalizeBaseUrl(url: string) {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/completions$/i, '')
    .replace(/\/images\/(generations|edits)$/i, '')
    .replace(/\/audio\/speech$/i, '')
    .replace(/\/+$/, '')
}

function mergePreset(kind: SetupKind, action: Record<string, unknown>) {
  const providerId = String(action.provider || '').trim()
  const presets = providersFor(kind)
  const preset = providerId ? findProvider(providerId, presets) : undefined
  const current = {
    baseUrl: normalizeBaseUrl(String(action.baseUrl || '')),
    model: String(action.model || action.workflowId || ''),
    models: Array.isArray(action.models) ? action.models.map(String) : []
  }
  if (!preset || preset.id === 'custom') {
    return {
      provider: 'custom',
      baseUrl: current.baseUrl,
      model: current.model,
      models: current.models
    }
  }
  if (current.baseUrl && matchProviderId(current.baseUrl, presets) === 'custom') {
    return {
      provider: 'custom',
      baseUrl: current.baseUrl,
      model: current.model || preset.defaultModel,
      models: current.models.length ? current.models : preset.models
    }
  }
  return applyProviderPreset(current, preset)
}

function nextName(kind: SetupKind, wanted: string) {
  const settings = useSettingsStore()
  const names =
    kind === 'llm'
      ? settings.config.llms.map((p) => p.name)
      : kind === 'vision'
        ? settings.config.visions.map((p) => p.name)
        : kind === 'image'
          ? settings.config.images.map((p) => p.name)
          : kind === 'tts'
            ? settings.config.ttsProfiles.map((p) => p.name)
            : kind === 'video'
              ? settings.config.videos.map((p) => p.name)
              : settings.config.ttsProfiles.map((p) => p.name)
  return uniqueProfileName(names, wanted || kind)
}

async function runAction(action: Record<string, unknown>): Promise<{ ok: boolean; detail: string; kind?: SetupKind }> {
  const settings = useSettingsStore()
  const tool = String(action.tool || '')
  const kind = parseKind(action.kind)
  if (!kind) return { ok: false, detail: '缺少有效的 kind' }

  if (tool === 'test_connection') {
    const id = String(action.id || '').trim()
    let ep: { baseUrl?: string; apiKey?: string; model?: string; workflowId?: string; adapter?: AdapterConfig; provider?: string } | undefined
    if (kind === 'llm') ep = id ? settings.config.llms.find((p) => p.id === id) : settings.config.llm
    else if (kind === 'vision') ep = id ? settings.config.visions.find((p) => p.id === id) : settings.config.vision
    else if (kind === 'image') ep = id ? settings.config.images.find((p) => p.id === id) : settings.config.image
    else if (kind === 'tts') ep = id ? settings.config.ttsProfiles.find((p) => p.id === id) : settings.config.tts
    else if (kind === 'video') ep = id ? settings.config.videos.find((p) => p.id === id) : settings.config.video
    if (!ep) return { ok: false, detail: '找不到要测试的接入', kind }
    if (id) {
      if (kind === 'llm') settings.selectLlm(id)
      else if (kind === 'vision') settings.selectVision(id)
      else if (kind === 'image') settings.selectImage(id)
      else if (kind === 'tts') settings.selectTts(id)
      else if (kind === 'video') settings.selectVideo(id)
    }
    const result = await testEndpointConnection(kind, ep)
    return { ok: result.ok, detail: result.ok ? `连通测试通过：${result.detail}` : `连通测试失败：${result.detail}`, kind }
  }

  if (tool === 'add_profile') {
    const merged = mergePreset(kind, action)
    const name = nextName(kind, String(action.name || merged.provider || kind))
    const apiKey = String(action.apiKey || '').trim()
    const baseUrl = normalizeBaseUrl(String(action.baseUrl || merged.baseUrl))
    const models = Array.isArray(action.models) && action.models.length
      ? action.models.map(String)
      : merged.models
    const model = String(action.model || merged.model || models[0] || '').trim()
    if (!baseUrl) return { ok: false, detail: `${name} 还缺接口地址`, kind }
    let adapter = normalizeAdapterInput(action.adapter)
    const pastedWf = String(
      action.workflowTemplate ||
        (action.adapter && typeof action.adapter === 'object'
          ? (action.adapter as Record<string, unknown>).workflowTemplate
          : '') ||
        ''
    ).trim()
    if (pastedWf && (!adapter || !adapter.workflowTemplate)) {
      adapter = { ...(adapter || {}), type: adapter?.type || 'comfyui-prompt', workflowTemplate: pastedWf }
    }
    if (kind === 'video') {
      let workflowId = String(action.workflowId || model || merged.model).trim()
      const isComfyPrompt =
        adapter?.type === 'comfyui-prompt' ||
        /localhost|127\.0\.0\.1/i.test(baseUrl)
      if (!workflowId && isComfyPrompt) workflowId = 'comfyui-local'
      if (!workflowId) return { ok: false, detail: `${name} 还缺工作流 ID`, kind }
      const stillRaw = String(action.stillMode || '').trim()
      const stillMode =
        stillRaw === 'keyframe' || stillRaw === 'storyboard' || stillRaw === 'identity'
          ? stillRaw
          : stillModeForVideoModel('h3', { workflowId, provider: merged.provider, stillMode: stillRaw })
      const resolvedAdapter =
        adapter ||
        (isComfyPrompt ? { type: 'comfyui-prompt' as const } : undefined)
      const id = settings.addVideo({
        name,
        baseUrl,
        apiKey,
        workflowId,
        promptStyle: action.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative',
        provider: merged.provider,
        stillMode,
        adapter: resolvedAdapter
      })
      return { ok: true, detail: `已保存视频接入「${name}」(${id})`, kind }
    }
    if (!model && adapter?.type !== 'comfyui-prompt') return { ok: false, detail: `${name} 还缺模型名`, kind }
    const seed = {
      name,
      baseUrl,
      apiKey,
      model: model || (adapter?.type === 'comfyui-prompt' ? 'comfyui' : ''),
      models: models.length ? models : model ? [model] : ['comfyui'],
      provider: merged.provider,
      adapter:
        adapter ||
        (kind === 'image' && /localhost|127\.0\.0\.1/i.test(baseUrl)
          ? { type: 'comfyui-prompt' as const }
          : undefined)
    }
    if (kind === 'llm') settings.addLlm(seed)
    else if (kind === 'vision') settings.addVision(seed)
    else if (kind === 'image') settings.addImage(seed)
    else if (kind === 'tts') {
      settings.addTts({ ...seed, voice: String(action.voice || 'longanhuan_v3.6') })
    }
    return { ok: true, detail: `已保存${labelOf(kind)}「${name}」`, kind }
  }

  if (tool === 'update_profile') {
    const id = String(action.id || '').trim()
    if (!id) return { ok: false, detail: '更新需要 id', kind }
    const patch: Record<string, unknown> = {}
    if (action.name) patch.name = String(action.name).trim()
    if (action.baseUrl) patch.baseUrl = normalizeBaseUrl(String(action.baseUrl))
    if (action.apiKey) patch.apiKey = String(action.apiKey).trim()
    if (action.model) patch.model = String(action.model).trim()
    if (action.provider) patch.provider = String(action.provider).trim()
    if (Array.isArray(action.models)) patch.models = action.models.map(String)
    if (action.adapter) {
      const adapter = normalizeAdapterInput(action.adapter)
      if (adapter) patch.adapter = adapter
    }
    if (kind === 'tts' && action.voice) patch.voice = String(action.voice)
    if (kind === 'video') {
      if (action.workflowId || action.model) patch.workflowId = String(action.workflowId || action.model).trim()
      if (action.promptStyle) patch.promptStyle = action.promptStyle === 'formatted' ? 'formatted' : 'scene-narrative'
      if (action.stillMode === 'identity' || action.stillMode === 'keyframe' || action.stillMode === 'storyboard') {
        patch.stillMode = action.stillMode
      }
      const cur = settings.config.videos.find((p) => p.id === id)
      if (!cur) return { ok: false, detail: '找不到这套视频接入', kind }
      settings.selectVideo(id)
      settings.patchVideo(patch)
      return { ok: true, detail: `已更新视频接入「${cur.name}」`, kind }
    }
    const list =
      kind === 'llm'
        ? settings.config.llms
        : kind === 'vision'
          ? settings.config.visions
          : kind === 'image'
            ? settings.config.images
            : settings.config.ttsProfiles
    const cur = list.find((p) => p.id === id)
    if (!cur) return { ok: false, detail: '找不到这套接入', kind }
    if (kind === 'llm') {
      settings.selectLlm(id)
      settings.patchLlm(patch)
    } else if (kind === 'vision') {
      settings.selectVision(id)
      settings.patchVision(patch)
    } else if (kind === 'image') {
      settings.selectImage(id)
      settings.patchImage(patch)
    } else {
      settings.selectTts(id)
      settings.patchTts(patch)
    }
    return { ok: true, detail: `已更新${labelOf(kind)}「${cur.name}」`, kind }
  }

  if (tool === 'select_profile') {
    const id = String(action.id || '').trim()
    const model = String(action.model || '').trim()
    if (!id) return { ok: false, detail: '选择需要 id', kind }
    if (kind === 'llm') {
      if (model) settings.selectLlmModel(id, model)
      else settings.selectLlm(id)
    } else if (kind === 'vision') {
      if (model) settings.selectVisionModel(id, model)
      else settings.selectVision(id)
    } else if (kind === 'image') {
      if (model) settings.selectImageModel(id, model)
      else settings.selectImage(id)
    } else if (kind === 'tts') {
      if (model) settings.selectTtsModel(id, model)
      else settings.selectTts(id)
    } else if (kind === 'video') settings.selectVideo(id)
    return { ok: true, detail: `已切换到这套${labelOf(kind)}`, kind }
  }

  if (tool === 'add_model') {
    const model = String(action.model || '').trim()
    if (!model) return { ok: false, detail: '还缺模型名', kind }
    if (kind === 'video' || kind === 'music') return { ok: false, detail: '视频请改工作流 ID', kind }
    const id = String(action.id || '').trim()
    if (id) {
      if (kind === 'llm') settings.selectLlm(id)
      else if (kind === 'vision') settings.selectVision(id)
      else if (kind === 'image') settings.selectImage(id)
      else if (kind === 'tts') settings.selectTts(id)
    }
    settings.addModel(kind, model)
    return { ok: true, detail: `已加入模型 ${model}`, kind }
  }

  return { ok: false, detail: `未知工具 ${tool}` }
}

function labelOf(kind: SetupKind) {
  return {
    llm: '语言模型',
    vision: '视觉',
    image: '生图',
    tts: '配音',
    video: '视频',
    music: '配乐'
  }[kind]
}

function looksLikePlaceholderKey(key: string) {
  return /^(sk-)?(xxx+|your[_-]?api[_-]?key|changeme|placeholder|<.+>|\{.+\})$/i.test(key.trim())
}

function extractComfyWorkflowTemplate(text: string): string {
  const trimmed = text.trim()
  // 整段就是 JSON
  if (trimmed.startsWith('{') && trimmed.includes('class_type')) {
    try {
      const obj = JSON.parse(trimmed)
      return JSON.stringify(obj, null, 2)
    } catch { /* fall through */ }
  }
  // 从 markdown/代码块里抠
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1] && /class_type|"prompt"\s*:/.test(fence[1])) {
    try {
      const obj = JSON.parse(fence[1].trim())
      return JSON.stringify(obj, null, 2)
    } catch { /* ignore */ }
  }
  // 贪婪找最外层大括号
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start && /class_type/.test(text.slice(start, end + 1))) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1))
      return JSON.stringify(obj, null, 2)
    } catch { /* ignore */ }
  }
  return ''
}

function extractApiKey(text: string) {
  const patterns = [
    /\b(sk-[A-Za-z0-9_-]{12,})\b/,
    /(?:api[_-]?key|secret[_-]?key|Authorization)[：:=\s]+(?:Bearer\s+)?([A-Za-z0-9._-]{12,})/i
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m?.[1] && !looksLikePlaceholderKey(m[1])) return m[1]
  }
  return ''
}

function extractBaseUrls(text: string) {
  const urls = [...text.matchAll(/https?:\/\/[^\s"'<>`]+/gi)].map((m) =>
    normalizeBaseUrl(m[0].replace(/[),.;]+$/g, ''))
  )
  const unique = [...new Set(urls)].filter((u) => {
    try {
      const host = new URL(u).hostname
      const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(host)
      return (host.includes('.') || local) && !/example\.com/i.test(host)
    } catch {
      return false
    }
  })
  unique.sort((a, b) => Number(/\/v\d+$/i.test(b)) - Number(/\/v\d+$/i.test(a)))
  return unique
}

function extractModels(text: string) {
  const found: string[] = []
  const push = (raw: string) => {
    const s = raw.trim()
    if (s.length < 2 || s.length > 80 || /\s/.test(s) || /^https?:/i.test(s)) return
    found.push(s)
  }
  for (const m of text.matchAll(/"models?"\s*:\s*"([^"]+)"/gi)) push(m[1])
  for (const m of text.matchAll(/"models?"\s*:\s*\[([^\]]+)\]/gi)) {
    for (const item of m[1].matchAll(/"([^"]+)"/g)) push(item[1])
  }
  for (const m of text.matchAll(/模型[名]?[：:\s]+`?([A-Za-z0-9._:-]+)`?/g)) push(m[1])
  for (const m of text.matchAll(/`([A-Za-z0-9._:-]{3,60})`/g)) {
    if (/gpt|qwen|deepseek|claude|gemini|glm|kimi|dall|seedream|flux|wan|hailuo|tts|vl-|minimax|doubao/i.test(m[1])) {
      push(m[1])
    }
  }
  return [...new Set(found)]
}

function inferKindsFromDocs(text: string, models: string[]): SetupKind[] {
  const t = `${text}\n${models.join('\n')}`.toLowerCase()
  const found = new Set<SetupKind>()
  if (/视觉|看图|多模态|qwen-vl|\bvl-|\bgpt-4o|claude|gemini/.test(t) || models.some((m) => /vl|vision|gpt-4o/i.test(m))) {
    found.add('vision')
  }
  if (/生图|文生图|images\/generations|dall-e|seedream|flux|qwen-image|imagen|kolors/.test(t) || models.some((m) => /dall-e|seedream|flux|image|imagen|kolors/i.test(m))) {
    found.add('image')
  }
  if (/配音|\btts\b|speech|音色|cosyvoice/.test(t) || models.some((m) => /tts|speech|cosy/i.test(m))) {
    found.add('tts')
  }
  if (/视频生成|文生视频|video\/generations|hailuo|wan2|kling|runway|comfyui|8188/.test(t) || models.some((m) => /hailuo|wan|kling|video/i.test(m))) {
    found.add('video')
  }
  if (/comfyui|system_stats|\/prompt\b/.test(t) && /生图|image|图生/.test(t)) {
    found.add('image')
  }
  if (/语言模型|对话模型|聊天补全|chat\/completions|\bllm\b/.test(t) || models.some((m) => /gpt|deepseek|qwen|claude|kimi|glm|minimax|doubao/i.test(m))) {
    found.add('llm')
  }
  if (!found.size) found.add('llm')
  return [...found]
}

function nameFromUrl(url: string, kind: SetupKind) {
  try {
    return `${new URL(url).host.replace(/^www\./, '')} ${labelOf(kind)}`
  } catch {
    return `自定义${labelOf(kind)}`
  }
}

function pickModelForKind(kind: SetupKind, models: string[]) {
  const hit = models.find((m) => {
    if (kind === 'image') return /dall-e|seedream|flux|image|imagen|kolors/i.test(m)
    if (kind === 'vision') return /vl|vision|gpt-4o/i.test(m)
    if (kind === 'tts') return /tts|speech|cosy/i.test(m)
    if (kind === 'video') return /hailuo|wan|kling|video/i.test(m)
    return /gpt|deepseek|qwen|claude|kimi|glm|minimax|doubao/i.test(m)
  })
  return hit || models[0] || ''
}

function actionsFromDocs(text: string): Record<string, unknown>[] {
  const urls = extractBaseUrls(text)
  if (!urls.length) return []
  const baseUrl = urls[0]
  const models = extractModels(text)
  const apiKey = extractApiKey(text)
  const kinds = inferKindsFromDocs(text, models)
  const actions: Record<string, unknown>[] = []
  for (const kind of kinds) {
    const model = pickModelForKind(kind, models)
    if (!model) continue
    const local = /localhost|127\.0\.0\.1/i.test(baseUrl) || /comfyui/i.test(text)
    const adapter =
      local && (kind === 'video' || kind === 'image')
        ? { type: 'comfyui-prompt' }
        : kind === 'image' && /images\/generations|openai/i.test(text)
          ? { type: 'openai-images' }
          : kind === 'llm' || kind === 'vision'
            ? { type: 'openai-compatible' }
            : undefined
    actions.push({
      tool: 'add_profile',
      kind,
      name: nameFromUrl(baseUrl, kind),
      provider: 'custom',
      baseUrl,
      apiKey,
      model: model || (local ? 'comfyui' : model),
      models: models.length ? models : local ? ['comfyui'] : models,
      workflowId: kind === 'video' ? model || (local ? 'comfyui-local' : undefined) : undefined,
      adapter
    })
  }
  return actions.slice(0, 8)
}

function parseAgentJson(text: string): { say: string; actions: Record<string, unknown>[] } {
  try {
    const obj = parseJsonRobust(text)
    return {
      say: String(obj.say || obj.reply || '好的'),
      actions: Array.isArray(obj.actions) ? obj.actions : []
    }
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return { say: text.slice(0, 400), actions: [] }
    try {
      const obj = JSON.parse(text.slice(start, end + 1))
      return {
        say: String(obj.say || '好的'),
        actions: Array.isArray(obj.actions) ? obj.actions : []
      }
    } catch {
      return { say: text.slice(0, 400), actions: [] }
    }
  }
}

export function llmSetupReady() {
  try {
    const cfg = getLlmConfig()
    return Boolean(cfg.baseUrl && cfg.apiKey)
  } catch {
    return false
  }
}

export async function runSetupAgentTurn(
  history: SetupMessage[],
  userText: string,
  onProgress?: (ev: SetupEvent) => void,
  signal?: AbortSignal
): Promise<SetupTurnResult> {
  if (!llmSetupReady()) {
    return {
      reply: '先在左侧「语言模型」填好接口地址和 API Key。配好之后我就能帮你加视觉、生图、配音和视频。',
      chips: [{ label: '去配语言模型', text: '__open_llm__' }]
    }
  }

  onProgress?.({ kind: 'think', label: '在想怎么接入…', status: 'running' })
  const recent = history.slice(-12).map((m) => ({
    role: m.role,
    content: m.content
  }))
  const comfyTpl = extractComfyWorkflowTemplate(userText)
  const looksLikeDocs =
    userText.length > 400 || /https?:\/\//i.test(userText) || Boolean(comfyTpl)
  const userPayload = looksLikeDocs
    ? `以下是用户贴的接口说明、API 文档或 ComfyUI 工作流 JSON（可能来自中转站、自定义网关或本机 Comfy）。必须解析并写成 provider=custom 的接入，禁止拒绝，禁止改写成大厂官方地址。若含 Comfy API 格式 JSON（含 class_type），写入 adapter.type=comfyui-prompt 与 adapter.workflowTemplate。不要编造可运行的默认工作流。文档里有几种能力就写几条 add_profile。\n\n${userText}`
    : userText
  const res = await callLLM({
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${snapshot()}` },
      ...recent,
      { role: 'user', content: userPayload }
    ],
    jsonMode: true,
    temperature: 0.2,
    maxTokens: looksLikeDocs ? 4000 : 1800,
    timeoutMs: looksLikeDocs ? 180_000 : 120_000,
    signal
  })

  const parsed = parseAgentJson(res.content)
  if (!parsed.actions.length && looksLikeDocs) {
    const fallback = actionsFromDocs(userText)
    if (fallback.length) {
      parsed.actions = fallback
      if (/无法|不能|不支持|拒绝|配不了/.test(parsed.say)) {
        parsed.say = '已按你贴的文档写成自定义接入。密钥只留在这台电脑。'
      }
    }
  }
  if (comfyTpl) {
    for (const raw of parsed.actions) {
      if (!raw || typeof raw !== 'object') continue
      const a = raw as Record<string, unknown>
      if (a.kind !== 'video' && a.kind !== 'image') continue
      const ad = (a.adapter && typeof a.adapter === 'object' ? a.adapter : {}) as Record<string, unknown>
      if (!ad.workflowTemplate) {
        a.adapter = { ...ad, type: ad.type || 'comfyui-prompt', workflowTemplate: comfyTpl }
        a.provider = a.provider || 'custom'
      }
    }
    if (!parsed.actions.some((a) => a && typeof a === 'object' && ((a as any).kind === 'video' || (a as any).kind === 'image'))) {
      parsed.actions.push({
        tool: 'add_profile',
        kind: 'video',
        name: '自建 ComfyUI',
        provider: 'custom',
        baseUrl: extractBaseUrls(userText)[0] || 'http://127.0.0.1:8188',
        apiKey: extractApiKey(userText),
        model: 'comfyui',
        workflowId: 'comfyui-local',
        adapter: { type: 'comfyui-prompt', workflowTemplate: comfyTpl }
      })
      if (!parsed.say || /无法|不能|拒绝/.test(parsed.say)) {
        parsed.say = '已把你粘贴的 Comfy 工作流写入 adapter.workflowTemplate。请确认本机 ComfyUI 已加载对应模型后再出片。'
      }
    }
  }
  const notes: string[] = []
  let opened: SetupKind | undefined
  for (const [i, raw] of parsed.actions.slice(0, 8).entries()) {
    const action = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const label = String(action.tool || '写入')
    onProgress?.({
      kind: 'step',
      step: `act-${i}`,
      label,
      status: 'running'
    })
    const result = await runAction(action)
    notes.push(result.ok ? result.detail : `失败：${result.detail}`)
    if (result.ok && result.kind) opened = result.kind
    onProgress?.({
      kind: 'step',
      step: `act-${i}`,
      label,
      status: result.ok ? 'done' : 'fail'
    })
  }

  const extra = notes.length ? `\n\n${notes.join('\n')}` : ''
  const chips =
    opened && opened !== 'llm'
      ? [
          { label: `去看${labelOf(opened)}`, text: `__open_${opened}__` },
          { label: '再配一套生图', text: '帮我再加一套生图接入' },
          { label: '配视频', text: '帮我配视频生成' }
        ]
      : [
          { label: '配视觉', text: '帮我配视觉理解' },
          { label: '配生图', text: '帮我配图像生成' },
          { label: '配配音', text: '帮我配 TTS 配音' },
          { label: '配视频', text: '帮我配视频生成' },
          { label: '测连通', text: '帮我测试当前接入的连通性' },
          { label: '从文档接入', text: '下面是我的 API 文档，请按文档写成自定义接入（可以是中转站）：\n' }
        ]

  return {
    reply: `${parsed.say}${extra}`.trim(),
    chips,
    opened
  }
}
