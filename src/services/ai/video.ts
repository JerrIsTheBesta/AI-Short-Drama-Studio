/**
 * AI 视频生成（AutoDL.art ComfyUI 工作流 API）
 *
 *   POST {base}/api/v1/comfyui/comfyui_workflow/{workflow_id}
 *   GET  {base}/api/v1/comfyui/comfyui_workflow/result/{task_id}
 *
 * 参考图：prompt、duration、resolution、ref_image_0..8
 * 数字人音画同步：只传 audio_duration、ref_audio_0、ref_image_0、resolution
 * 工作流：minimax_h3_lightx2v_v5_15s / minimax_h3_lightx2v_v5 / minimax_h3_image_audio_to_video / minimax_h3_b99_002
 */

import { getAIMode } from './client'
import { comfyPromptGenerate, httpCustomMediaGenerate, isApimartHost, resolveVideoAdapter } from './adapters'
import { apimartGenerateVideo, isApimartEndpoint } from './apimart'
import { autodlVideoProfileId, getVideoConfig, getVideoPromptStyle, getTtsConfig } from './runtime'
import { generateMockVideo } from './mock'
import { composeH3VideoPrompt, ensureFl2vaLead, isRef2VA, type H3ImageSlot } from './h3Prompt'
import {
  VIDEO_AUTODL_ROOT,
  VIDEO_DEFAULT_WORKFLOW_ID,
  VIDEO_DIGITAL_HUMAN_WORKFLOW_ID,
  VIDEO_FL2VA_WORKFLOW_ID,
  VIDEO_H3_V5_10S_WORKFLOW_ID,
  migrateVideoBaseUrl,
  migrateVideoWorkflowId
} from './env'
import type { AspectRatio, H3VideoGenMode, Shot, VideoGenModel, VideoResolution } from '@/types'
import { normalizeVideoResolution, videoMaxSeconds } from '@/types'
import { abortableDelay, controlledSignal, isTimeoutAbort, throwIfAborted } from './abort'
import type { VideoPromptStyle } from '@/utils/shotPrompt'
import { blobFromPath, desktop, isDesktop } from '@/services/desktop'
import { isLandscapeAspect } from '@/utils/aspect'
import { toDigitalHumanWav } from '@/services/ffmpeg'
import { normalizeZealmanBaseUrl, zealmanWorkflowById } from './zealman'

export interface VideoGenInput {
  /** 第一张参考图：角色设计图 / 场景图 / 故事看板之一，不是人物+场景配图 */
  imageBlob?: Blob
  /** 其余参考图，按角色设计图 → 场景图 → 故事看板的顺序 */
  referenceImages?: Blob[]
  /**
   * 发给出视频接口的提示词。promptAsIs 为真时不再编译/拼接。
   */
  prompt: string
  /** 框里的全文原样发送，不再套 H3 模板 */
  promptAsIs?: boolean
  /**
   * 项目级整体氛围（中文，1-2 段）
   * 会拼到 visualPrompt 前面
   */
  aesthetic?: string
  /**
   * 音效描述（中文短句，比如"雨声、灯火燃烧声"）
   * 写入 H3【声音设计】
   */
  audioDescription?: string
  /**
   * 口播/台词原文。人物名前缀会被剥离，只有正文进入 <d>[语言] 原词</d>。
   */
  voiceover?: string
  /** dialogue=H3 对口型；voiceover=H3 画外口播；none=不让 H3 生成人声 */
  voiceMode?: 'dialogue' | 'voiceover' | 'none'
  /** 说话人音色/身份提示（不含台词） */
  speakerHint?: string
  /** H3 官方多图提示词中的实际人物、场景与图片职责。 */
  speakerName?: string
  sceneName?: string
  sceneDescription?: string
  sceneLighting?: string
  sceneAnchor?: string
  shotTitle?: string
  imageAssignments?: string[]
  imageSlots?: H3ImageSlot[]
  onScreenNames?: string[]
  duration: number
  width: number
  height: number
  /** 比例标签（写到 prompt 最前面 [16:9] 这种） */
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  /** 0-1，仅 mock 使用 */
  strength?: number
  signal?: AbortSignal
  promptStyle?: VideoPromptStyle
  /** 图生视频节点模型。默认 H3 15s；h3-v5 为 10 秒 1080p */
  videoModel?: VideoGenModel
  /** 锁定设置中的视频接入，生成时不能回落到另一个供应商。 */
  videoProfileId?: string
  /** h3-v5 可选 1080p */
  videoResolution?: VideoResolution
  /** H3：参考图生成或首尾帧。默认参考图。 */
  h3GenMode?: H3VideoGenMode
  /** 首尾帧模式的尾帧图 */
  lastFrameBlob?: Blob
  /** 数字人口播：与画面同步的口播音频 */
  audioBlob?: Blob
  /** 走 MiniMax H3 图+音频同步工作流 */
  audioSync?: boolean
  /** H3 任务类型。多图人设/场景/看板用 R2VA；单张首帧用 I2VA。 */
  mode?: 'I2VA' | 'T2VA' | 'R2VA'
  /** 已提交的 AutoDL 工作流 task_id；传入后跳过提交，直接恢复轮询。 */
  resumeTaskId?: string
  /** 新任务提交成功后立即回传 task_id，调用方应持久化用于断点恢复。 */
  onTaskSubmitted?: (taskId: string) => void | Promise<void>
}

export interface VideoGenOutput {
  blob: Blob
  mimeType: string
  prompt: string
  duration: number
}

const log = (msg: string) =>
  console.log('%c[video]', 'color:#ec4899;font-weight:600', msg)

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|avi|mkv)(?:$|[?#])/i
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i
const MAX_REF_IMAGES = 9

function resultUrl(r: any): string {
  const candidates = [
    r?.url,
    r?.video_url,
    r?.videoUrl,
    r?.file_url,
    r?.fileUrl,
    r?.download_url,
    r?.downloadUrl,
    r?.oss_url,
    r?.signed_url,
    r?.output_url,
    r?.src,
    r?.path,
    r?.filename
  ]
  for (const c of candidates) {
    const s = String(c ?? '').trim()
    if (/^https?:\/\//i.test(s)) return s
  }
  return ''
}

/** 从 workflow results 里挑真正的视频，绝不回落到预览图 */
function pickWorkflowVideoResult(
  results: any[]
): { url: string; type?: string } | null {
  const scored = results
    .map((r) => {
      const url = resultUrl(r)
      if (!url) return null
      const type = String(r?.type ?? r?.raw?.type ?? '').toLowerCase()
      const blobText = JSON.stringify(r).toLowerCase()
      let score = 0
      if (VIDEO_EXT_RE.test(url)) score += 100
      if (IMAGE_EXT_RE.test(url)) score -= 100
      if (/video/.test(type)) score += 60
      if (type === 'image' && !VIDEO_EXT_RE.test(url)) score -= 30
      if (/mp4|webm|mov|video/.test(blobText) && !IMAGE_EXT_RE.test(url)) score += 20
      // OSS 签名链经常没有 .mp4 后缀
      if (!IMAGE_EXT_RE.test(url) && !VIDEO_EXT_RE.test(url) && /^https?:\/\//i.test(url)) {
        score += /video/.test(type) ? 20 : 10
      }
      return { url, type, score }
    })
    .filter(Boolean) as { url: string; type?: string; score: number }[]

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < 40 || !/^https?:\/\//i.test(best.url)) return null
  if (IMAGE_EXT_RE.test(best.url) && best.score < 50) return null
  return { url: best.url, type: best.type }
}

function guessVideoMimeFromUrl(url: string): string | undefined {
  if (/\.webm(?:$|[?#])/i.test(url)) return 'video/webm'
  if (/\.mov(?:$|[?#])/i.test(url)) return 'video/quicktime'
  if (/\.(mp4|m4v)(?:$|[?#])/i.test(url)) return 'video/mp4'
  return undefined
}

function isImageMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true
  // PNG
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return true
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true
  // WEBP (RIFF....WEBP)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return true
  return false
}

function isVideoMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const ascii = (n: number, m: number) =>
    String.fromCharCode(...bytes.subarray(n, m))
  // ISO BMFF / MP4 / MOV
  if (ascii(4, 8) === 'ftyp') return true
  // WebM / Matroska
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return true
  // RIFF AVI
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return true
  return false
}

/** 确认下载内容是视频容器，避免把预览 PNG/JPEG 存成「视频」 */
async function assertVideoBlob(blob: Blob, mimeHint?: string): Promise<Blob> {
  if (blob.size < 1024) {
    throw new Error(`[video] 下载文件过小（${blob.size} 字节），不像有效视频`)
  }
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
  if (isImageMagic(head)) {
    throw new Error(
      '[video] 下载到的是图片（PNG/JPEG/WebP），不是视频。请检查 ComfyUI 工作流是否输出了 mp4。'
    )
  }
  const hint = (mimeHint || blob.type || '').toLowerCase()
  if (hint.startsWith('image/')) {
    throw new Error(`[video] 服务端 Content-Type 是图片（${hint}），不是视频`)
  }
  let mime = hint && hint.startsWith('video/') ? hint : ''
  if (isVideoMagic(head)) {
    if (!mime) {
      mime =
        head[0] === 0x1a ? 'video/webm' : asciiHintMp4(head) ? 'video/mp4' : 'video/mp4'
    }
    return blob.type === mime ? blob : blob.slice(0, blob.size, mime)
  }
  // 魔数不明时，若 hint 是 video/* 仍放行（少数代理剥掉头）
  if (mime.startsWith('video/')) {
    return blob.type === mime ? blob : blob.slice(0, blob.size, mime)
  }
  throw new Error(
    `[video] 无法识别为视频文件（type=${blob.type || mimeHint || 'unknown'}，size=${blob.size}）。可能拿到了预览帧。`
  )
}

function asciiHintMp4(bytes: Uint8Array): boolean {
  return String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp'
}

/** Blob → data:base64 字符串 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

async function blobToTypedDataUrl(blob: Blob, mime: string): Promise<string> {
  const url = await blobToDataUrl(blob)
  const comma = url.indexOf(',')
  const b64 = comma >= 0 ? url.slice(comma + 1) : url
  return `data:${mime};base64,${b64}`
}

/** Keep a three-reference JSON request below common proxy body limits. */
async function blobToVideoImageDataUrl(blob: Blob): Promise<string> {
  try {
    const bitmap = await createImageBitmap(blob)
    const maxEdge = 1600
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas context unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const compressed = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    return await blobToDataUrl(compressed || blob)
  } catch {
    return await blobToDataUrl(blob)
  }
}

function workflowApiRoot(baseUrl: string): string {
  const raw = migrateVideoBaseUrl(baseUrl).replace(/\/+$/, '')
  if (/\/api\/v1\/comfyui$/i.test(raw)) return raw
  const origin = raw.replace(/\/api\/v1$/i, '')
  return `${origin}/api/v1/comfyui`
}

function authHeaders(apiKey: string, jsonBody = true): Record<string, string> {
  const token = apiKey.trim()
  const headers: Record<string, string> = {}
  if (jsonBody) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = token
  return headers
}

type AutodlHttpResult = {
  ok: boolean
  status: number
  text: () => Promise<string>
}

/** 桌面端走主进程 net.fetch，绕开渲染进程 CORS；浏览器仍用 fetch */
async function autodlRequest(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
  timeoutMs = 120_000
): Promise<AutodlHttpResult> {
  throwIfAborted(init.signal)
  if (isDesktop()) {
    const api = desktop()
    if (typeof api.autodlFetch !== 'function') {
      throw new Error('请完全退出并重启剧流 Studio（桌面端需要新的 AutoDL 通道）')
    }
    const headers = init.headers || {}
    const res = await api.autodlFetch({
      url,
      method: init.method || 'GET',
      authorization: headers.Authorization || '',
      extraHeaders: headers,
      body: init.body,
      timeoutMs
    })
    throwIfAborted(init.signal)
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.text
    }
  }
  const resp = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal
  })
  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text()
  }
}

const WAN_PRIME_MODEL = 'wan3.0-video-prime'

function dashscopeApiRoot(baseUrl: string): string {
  let u = (baseUrl || '').replace(/\/+$/, '')
  u = u.replace(/\/compatible-mode\/v1$/i, '/api/v1')
  if (/\/api\/v1$/i.test(u)) return u
  if (/^https?:\/\//i.test(u) && !/\/api\//i.test(u)) return `${u}/api/v1`
  return u || 'https://dashscope.aliyuncs.com/api/v1'
}

function wanRatio(ar?: AspectRatio): string {
  if (ar === '16:9' || ar === '9:16' || ar === '1:1' || ar === '4:3') return ar
  return 'adaptive'
}

async function dashscopeRequest(
  url: string,
  init: {
    method?: string
    extraHeaders?: Record<string, string>
    body?: string
    signal?: AbortSignal
    authorization: string
  },
  timeoutMs = 120_000
): Promise<AutodlHttpResult> {
  throwIfAborted(init.signal)
  if (isDesktop()) {
    const api = desktop()
    if (typeof api.dashscopeFetch !== 'function') {
      throw new Error('请完全退出并重启剧流 Studio（桌面端需要新的百炼通道）')
    }
    const res = await api.dashscopeFetch({
      url,
      method: init.method || 'GET',
      authorization: init.authorization,
      extraHeaders: init.extraHeaders,
      body: init.body,
      timeoutMs
    })
    throwIfAborted(init.signal)
    return {
      ok: res.ok,
      status: res.status,
      text: async () => res.text
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: init.authorization,
    ...(init.extraHeaders || {})
  }
  if ((init.method || 'GET').toUpperCase() === 'POST') headers['Content-Type'] = 'application/json'
  const resp = await fetch(url, {
    method: init.method,
    headers,
    body: init.body,
    signal: init.signal
  })
  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text()
  }
}

function autodlResolution(input: VideoGenInput): string {
  const quality =
    input.videoModel === 'h3-v5' &&
    input.h3GenMode !== 'fl2va' &&
    normalizeVideoResolution(input.videoResolution, 'h3-v5') === '1080p'
      ? '1080p'
      : '768p'
  const ratio = String(input.aspectRatio || '')
  if (ratio === '9:16') return `${quality}竖`
  if (isLandscapeAspect(ratio) || ratio === '1:1') return `${quality}横`
  const landscape = (input.width || 0) >= (input.height || 0)
  return landscape ? `${quality}横` : `${quality}竖`
}

function unwrapTaskPayload(json: any): any {
  // data 有时直接就是 results 数组；数组也是 object，不能当任务对象拆。
  if (json?.data && typeof json.data === 'object' && !Array.isArray(json.data)) return json.data
  return json
}

function taskIdOf(json: any): string {
  const data = unwrapTaskPayload(json)
  return String(data?.task_id ?? data?.taskId ?? json?.task_id ?? '').trim()
}

function taskStatusOf(json: any): string {
  const data = unwrapTaskPayload(json)
  return String(data?.status ?? data?.state ?? json?.status ?? json?.state ?? '').trim().toUpperCase()
}

function taskErrorOf(json: any): string {
  const data = unwrapTaskPayload(json)
  return String(data?.message ?? data?.error ?? json?.msg ?? json?.message ?? '').trim()
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || (text[0] !== '{' && text[0] !== '[')) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function harvestMediaItems(value: unknown, out: any[] = [], depth = 0): any[] {
  if (value == null || depth > 8) return out
  const parsed = parseMaybeJson(value)
  if (typeof parsed === 'string') {
    const url = parsed.trim()
    if (/^https?:\/\//i.test(url)) out.push({ url })
    return out
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) harvestMediaItems(item, out, depth + 1)
    return out
  }
  if (typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>
    if (rec.url || rec.video_url || rec.videoUrl || rec.filename || rec.file_url || rec.download_url || rec.oss_url) {
      out.push(rec)
    }
    for (const nested of Object.values(rec)) harvestMediaItems(nested, out, depth + 1)
  }
  return out
}

function collectWorkflowResults(json: any): any[] {
  const data = unwrapTaskPayload(json)
  const buckets = [data?.results, json?.results, json?.data, data, json]
  const seen = new Set<string>()
  const out: any[] = []
  for (const bucket of buckets) {
    for (const item of harvestMediaItems(bucket)) {
      const url = resultUrl(item)
      const key = url || JSON.stringify(item)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

function classifyTaskStatus(raw: string): 'queued' | 'running' | 'success' | 'failed' | 'unknown' {
  const s = String(raw || '').trim().toUpperCase()
  if (/^(QUEUED|PENDING|WAITING|QUEUE|WAIT)$/.test(s)) return 'queued'
  if (/^(RUNNING|PROCESSING|IN_PROGRESS|STARTED|EXECUTING)$/.test(s)) return 'running'
  if (/^(SUCCESS|COMPLETED|SUCCEEDED|DONE|FINISH|FINISHED|OK)$/.test(s)) return 'success'
  if (/^(FAILED|ERROR|CANCELLED|CANCELED|FAIL)$/.test(s)) return 'failed'
  return 'unknown'
}

async function fetchVideoBytes(
  videoUrl: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; mime: string }> {
  const fallbackMime = guessVideoMimeFromUrl(videoUrl) || 'video/mp4'
  throwIfAborted(signal)

  if (isDesktop() && typeof desktop().downloadToTemp === 'function') {
    const dest = await desktop().downloadToTemp(videoUrl)
    try {
      const blob = await blobFromPath(dest)
      return { blob, mime: blob.type || fallbackMime }
    } finally {
      try {
        await desktop().remove(dest)
      } catch {
        /* ignore */
      }
    }
  }

  const vResp = await fetch(videoUrl, { signal })
  if (!vResp.ok) throw new Error(`下载视频失败 ${vResp.status} ${videoUrl}`)
  return {
    blob: await vResp.blob(),
    mime: vResp.headers.get('content-type') || fallbackMime
  }
}

async function downloadGeneratedVideo(
  videoUrl: string,
  signal: AbortSignal | undefined,
  prompt: string,
  duration: number,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  log(`→ 下载视频: ${videoUrl}`)
  onProgress?.('下载视频...')
  const dl = controlledSignal(signal, 120_000)
  try {
    const { blob: rawBlob, mime: mimeHint } = await fetchVideoBytes(videoUrl, dl.signal)
    onProgress?.('校验视频文件...')
    const blob = await assertVideoBlob(rawBlob, mimeHint)
    log(`✓ 视频下载完成 (${(blob.size / 1024 / 1024).toFixed(2)} MB, ${blob.type})`)
    return {
      blob,
      mimeType: blob.type || 'video/mp4',
      prompt,
      duration
    }
  } catch (error: any) {
    if (isTimeoutAbort(error, dl.signal)) {
      throw new Error(`[video] 下载超时：${videoUrl}`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    dl.cleanup()
  }
}

/** 提交到 AutoDL.art ComfyUI 工作流并轮询结果 */
async function realWorkflowVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  const baseUrl = migrateVideoBaseUrl(cfg.baseUrl || VIDEO_AUTODL_ROOT)
  const apiKey = cfg.apiKey
  const isFl2va = input.h3GenMode === 'fl2va'
  const isAudioSync = input.audioSync === true
  const workflowId = isFl2va
    ? VIDEO_FL2VA_WORKFLOW_ID
    : isAudioSync
      ? VIDEO_DIGITAL_HUMAN_WORKFLOW_ID
      : input.videoModel === 'h3-v5'
        ? VIDEO_H3_V5_10S_WORKFLOW_ID
        : migrateVideoWorkflowId(cfg.workflowId || VIDEO_DEFAULT_WORKFLOW_ID)
  const root = workflowApiRoot(baseUrl)
  throwIfAborted(input.signal)

  if (!apiKey) {
    throw new Error('[video] 没配 AutoDL Token，请到设置页填写图生视频令牌')
  }

  const allBlobs = isFl2va
    ? [input.imageBlob, input.lastFrameBlob].filter((b): b is Blob => !!b)
    : isAudioSync
      ? [input.imageBlob].filter((b): b is Blob => !!b)
      : [input.imageBlob, ...(input.referenceImages ?? [])].filter((b): b is Blob => !!b).slice(0, MAX_REF_IMAGES)

  if (isFl2va && allBlobs.length < 2) {
    throw new Error('[video] 首尾帧模式需要首帧和尾帧各一张图')
  }
  if (isAudioSync && !input.audioBlob) {
    throw new Error('[video] 数字人口播需要上传与台词对应的音频')
  }
  if (allBlobs.length === 0) {
    throw new Error('[video] 没有可用图片')
  }

  onProgress?.('准备参考图...')
  const dataUrls: string[] = []
  for (const blob of allBlobs) {
    dataUrls.push(await blobToVideoImageDataUrl(blob))
  }
  const referencePayloadMb = dataUrls.reduce((sum, value) => sum + value.length, 0) / 1024 / 1024
  onProgress?.(`参考图已准备：${dataUrls.length} 张 / 约 ${referencePayloadMb.toFixed(1)} MB`)

  const MIN_DUR = 1
  const MAX_DUR = isAudioSync ? 15 : videoMaxSeconds(input.videoModel || 'h3')
  const targetDuration = Math.max(MIN_DUR, Math.min(MAX_DUR, Math.round(input.duration) || 5))
  if (targetDuration !== input.duration) {
    onProgress?.(`视频时长 clamp 到 ${targetDuration} 秒（接口限制 ${MIN_DUR}-${MAX_DUR}s）`)
  }

  let finalPrompt = isAudioSync ? (input.prompt || input.voiceover || '数字人口播').trim() : buildPrompt(input)
  if (finalPrompt.length > 10000) {
    finalPrompt = finalPrompt.slice(0, 10000)
    onProgress?.('提示词超过 10000 字，已截断')
  }

  const resolution = autodlResolution(input)
  let audioDuration = Math.max(5, Math.min(15, targetDuration))
  let body: Record<string, string | number>
  if (isAudioSync && input.audioBlob) {
    onProgress?.('准备口播音频...')
    const prepared = await toDigitalHumanWav(input.audioBlob, onProgress)
    const audioUrl = await blobToTypedDataUrl(prepared.blob, 'audio/wav')
    audioDuration = Math.max(5, Math.min(15, prepared.duration || targetDuration))
    // 该工作流只认这 4 个字段；时长必须 5–15，音频必须是 WAV/MP3
    body = {
      audio_duration: audioDuration,
      ref_audio_0: audioUrl,
      ref_image_0: dataUrls[0],
      resolution
    }
    onProgress?.(`口播音频已准备：${audioDuration}s WAV，约 ${(audioUrl.length / 1024 / 1024).toFixed(1)} MB`)
  } else {
    body = {
      prompt: finalPrompt,
      duration: targetDuration,
      resolution
    }
    if (isFl2va) {
      body.first_frame = dataUrls[0]
      body.last_frame = dataUrls[1]
      body.ref_image_0 = dataUrls[0]
      body.ref_image_1 = dataUrls[1]
    } else {
      dataUrls.forEach((url, index) => {
        body[`ref_image_${index}`] = url
      })
    }
  }
  let taskId = String(input.resumeTaskId || '').trim()
  if (taskId) {
    onProgress?.(`恢复已有任务 (${taskId})，不会重复提交…`)
    log(`↻ 恢复任务: ${taskId}`)
  } else {
    onProgress?.(
      isAudioSync
        ? `提交数字人口播任务（${resolution}，${audioDuration}s）...`
        : isFl2va
          ? `提交首尾帧任务（${input.aspectRatio || resolution}）...`
          : `提交生成任务（${input.aspectRatio || resolution}，${dataUrls.length} 张参考图）...`
    )
    const submitCtl = controlledSignal(input.signal, 120_000)
    let submitResp: AutodlHttpResult
    try {
      submitResp = await autodlRequest(
        `${root}/comfyui_workflow/${encodeURIComponent(workflowId)}`,
        {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify(body),
          signal: submitCtl.signal
        },
        120_000
      )
    } catch (error: any) {
      if (isTimeoutAbort(error, submitCtl.signal)) {
        throw new Error(
          `[video] 提交超时（120 秒），参考图约 ${referencePayloadMb.toFixed(1)} MB。请检查网络或减小参考图。`
        )
      }
      throw new Error(
        `[video] 无法连接 AutoDL：${error?.message || String(error)}（参考图约 ${referencePayloadMb.toFixed(1)} MB）`
      )
    } finally {
      submitCtl.cleanup()
    }

    const submitText = await submitResp.text()
    let submitData: any = null
    try {
      submitData = submitText ? JSON.parse(submitText) : null
    } catch {
      submitData = null
    }
    if (!submitResp.ok) {
      const hint = submitResp.status === 413 ? '；请求体过大，请降低参考图尺寸' : ''
      throw new Error(`[video] 任务提交失败 ${submitResp.status}${hint}：${submitText.slice(0, 1200)}`)
    }
    const submitCode = String(submitData?.code ?? '')
    taskId = taskIdOf(submitData)
    if (submitCode && !/^success$/i.test(submitCode) && !taskId) {
      throw new Error(`[video] 任务提交失败：${submitData?.msg || submitCode}\n${submitText.slice(0, 400)}`)
    }
    if (!taskId) {
      throw new Error(`[video] 提交响应无 task_id\n原始：${submitText.slice(0, 400)}`)
    }
    await input.onTaskSubmitted?.(taskId)
    onProgress?.(`任务已提交 (${taskId})`)
    log(`✓ 任务已提交: ${taskId}`)
  }

  const start = Date.now()
  // 旺时任务可能在队列中超过 15 分钟。保留到 30 分钟，并允许调用方随时 abort；
  // 智能口播会逐段落库，因此取消或超时后可以从已完成段继续。
  const deadline = start + 30 * 60 * 1000
  /** AutoDL 常先标 SUCCESS 再把 mp4 写进 results（ComfyUI 落盘有竞态）。 */
  const EMPTY_SUCCESS_GRACE_MS = 120_000
  let successEmptySince = 0
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    await abortableDelay(1000, input.signal)
    throwIfAborted(input.signal)
    const elapsed = Math.round((Date.now() - start) / 1000)
    onProgress?.(`排队/生成中 ${elapsed}s`)

    let pollResp: AutodlHttpResult
    try {
      pollResp = await autodlRequest(
        `${root}/comfyui_workflow/result/${encodeURIComponent(taskId)}`,
        {
          method: 'GET',
          headers: authHeaders(apiKey, false),
          signal: input.signal
        },
        30_000
      )
    } catch (error: any) {
      onProgress?.(`查询中断，重试中… ${elapsed}s`)
      log(`轮询网络错误 #${attempt}: ${error?.message || error}`)
      continue
    }
    if (pollResp.status === 401 || pollResp.status === 403) {
      throw new Error(`[video] 轮询被拒绝 ${pollResp.status}，请到设置页检查 AutoDL Token`)
    }
    const pollText = await pollResp.text()
    let pollData: any = null
    try {
      pollData = pollText ? JSON.parse(pollText) : null
    } catch {
      onProgress?.(`生成中… ${elapsed}s（响应还不是 JSON）`)
      continue
    }
    if (!pollData) {
      onProgress?.(`生成中… ${elapsed}s`)
      continue
    }
    const status = taskStatusOf(pollData)
    const phase = classifyTaskStatus(status)
    const data = unwrapTaskPayload(pollData)
    const durationSec = Number(data?.duration) || elapsed
    const results = collectWorkflowResults(pollData)
    const picked = pickWorkflowVideoResult(results)
    if (attempt === 1 || attempt % 5 === 0 || (phase === 'success' && !picked)) {
      log(`轮询 #${attempt} (${elapsed}s) status=${status || '-'} results=${results.length}: ${pollText.slice(0, 280)}`)
    }
    if (picked) {
      log(`✓ 已拿到视频地址 (${phase || 'no-status'}): ${picked.url}`)
      onProgress?.('下载视频...')
      return await downloadGeneratedVideo(picked.url, input.signal, finalPrompt, targetDuration, onProgress)
    }
    if (phase === 'queued') {
      successEmptySince = 0
      onProgress?.(`排队中… ${elapsed}s`)
      continue
    }
    if (phase === 'running') {
      successEmptySince = 0
      onProgress?.(`生成中… ${durationSec}s`)
      continue
    }
    if (phase === 'failed') {
      throw new Error(`[video] 生成失败：${taskErrorOf(pollData) || status}`)
    }
    if (phase === 'success') {
      if (!successEmptySince) successEmptySince = Date.now()
      const waited = Date.now() - successEmptySince
      if (waited < EMPTY_SUCCESS_GRACE_MS) {
        onProgress?.(`任务已完成，正在等视频地址… ${Math.ceil((EMPTY_SUCCESS_GRACE_MS - waited) / 1000)}s`)
        continue
      }
      throw new Error(
        `[video] AutoDL 已标记完成，但 results 仍是空的，没有视频下载地址。task_id=${taskId}\n` +
          `工作流跑了 ${durationSec || elapsed} 秒。常见原因是结果文件还没写进查询接口，或工作流没有输出 mp4。\n` +
          `请再点一次生成（会接着查这个任务）。若仍失败，用这个 task_id 到 AutoDL 控制台核对是否真的出了视频。\n` +
          pollText.slice(0, 500)
      )
    }
    onProgress?.(`生成中… ${elapsed}s${status ? `（${status}）` : ''}`)
  }

  throw new Error(`[video] 生成超时（30 分钟未完成），task_id=${taskId}`)
}

/** 百炼 wan3.0-video-prime：单张首帧，多张走全能参考（reference_image），固定 720P */
async function realWanVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const tts = getTtsConfig()
  const apiRoot = dashscopeApiRoot(tts.baseUrl)
  const apiKey = tts.apiKey.trim()
  throwIfAborted(input.signal)
  if (!apiKey) {
    throw new Error('[video] 没配百炼 Token，请到设置页填写口播 TTS 的 DashScope Key')
  }

  const allBlobs = [input.imageBlob, ...(input.referenceImages ?? [])]
    .filter((b): b is Blob => !!b)
    .slice(0, 10)
  if (!allBlobs.length) {
    throw new Error('[video] 没有可用图片')
  }

  onProgress?.('准备参考图...')
  const urls: string[] = []
  for (const blob of allBlobs) {
    urls.push(await blobToVideoImageDataUrl(blob))
  }
  // 单张：严格首帧生视频。两张及以上：全能参考（不能和 first_frame/last_frame 混用）
  const media =
    urls.length === 1
      ? [{ type: 'first_frame', url: urls[0] }]
      : urls.map((url) => ({ type: 'reference_image', url }))

  const targetDuration = Math.max(2, Math.min(30, Math.round(input.duration) || 5))
  let prompt = String(input.prompt || '').trim()
  if (!prompt) throw new Error('[video] 请先写提示词')
  if (prompt.length > 20000) prompt = prompt.slice(0, 20000)

  const body = {
    model: WAN_PRIME_MODEL,
    input: { prompt, media },
    parameters: {
      resolution: '720P',
      ratio: wanRatio(input.aspectRatio),
      duration: targetDuration,
      prompt_extend: true,
      watermark: false,
      audio: true
    }
  }

  const modeLabel = media[0]?.type === 'first_frame' ? '首帧' : `全能参考 ${media.length} 张`
  onProgress?.(`提交万相任务（720P，${modeLabel}，${targetDuration}s）...`)
  const auth = `Bearer ${apiKey}`
  const submitCtl = controlledSignal(input.signal, 120_000)
  let submitResp: AutodlHttpResult
  try {
    submitResp = await dashscopeRequest(
      `${apiRoot}/services/aigc/video-generation/video-synthesis`,
      {
        method: 'POST',
        authorization: auth,
        extraHeaders: { 'X-DashScope-Async': 'enable' },
        body: JSON.stringify(body),
        signal: submitCtl.signal
      },
      120_000
    )
  } catch (error: any) {
    if (isTimeoutAbort(error, submitCtl.signal)) {
      throw new Error('[video] 万相提交超时（120 秒），请检查网络或减小参考图')
    }
    throw new Error(`[video] 无法连接百炼：${error?.message || String(error)}`)
  } finally {
    submitCtl.cleanup()
  }

  const submitText = await submitResp.text()
  let submitData: any = null
  try {
    submitData = submitText ? JSON.parse(submitText) : null
  } catch {
    submitData = null
  }
  if (!submitResp.ok || submitData?.code) {
    throw new Error(
      `[video] 万相提交失败 ${submitData?.code || submitResp.status}：${
        submitData?.message || submitText.slice(0, 800)
      }`
    )
  }
  const taskId = String(submitData?.output?.task_id || submitData?.task_id || '').trim()
  if (!taskId) {
    throw new Error(`[video] 万相提交无 task_id\n${submitText.slice(0, 400)}`)
  }
  onProgress?.(`任务已提交 (${taskId})`)
  log(`✓ 万相任务已提交: ${taskId}`)

  const start = Date.now()
  const deadline = start + 15 * 60 * 1000
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    await abortableDelay(3000, input.signal)
    throwIfAborted(input.signal)
    const elapsed = Math.round((Date.now() - start) / 1000)
    onProgress?.(`万相生成中 ${elapsed}s`)

    let pollResp: AutodlHttpResult
    try {
      pollResp = await dashscopeRequest(
        `${apiRoot}/tasks/${encodeURIComponent(taskId)}`,
        { method: 'GET', authorization: auth, signal: input.signal },
        30_000
      )
    } catch (error: any) {
      onProgress?.(`查询中断，重试中… ${elapsed}s`)
      log(`万相轮询网络错误 #${attempt}: ${error?.message || error}`)
      continue
    }
    const pollText = await pollResp.text()
    let pollData: any = null
    try {
      pollData = pollText ? JSON.parse(pollText) : null
    } catch {
      continue
    }
    const status = String(pollData?.output?.task_status || pollData?.task_status || '').toUpperCase()
    const videoUrl = String(pollData?.output?.video_url || pollData?.video_url || '').trim()
    if (attempt === 1 || attempt % 5 === 0) {
      log(`万相轮询 #${attempt} (${elapsed}s) status=${status || '-'} ${pollText.slice(0, 240)}`)
    }
    if (videoUrl) {
      log(`✓ 万相已拿到视频: ${videoUrl}`)
      return await downloadGeneratedVideo(videoUrl, input.signal, prompt, targetDuration, onProgress)
    }
    if (status === 'PENDING') {
      onProgress?.(`排队中… ${elapsed}s`)
      continue
    }
    if (status === 'RUNNING') {
      onProgress?.(`生成中… ${elapsed}s`)
      continue
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(
        `[video] 万相失败：${pollData?.output?.message || pollData?.message || status}`
      )
    }
    if (status === 'UNKNOWN') {
      throw new Error('[video] 万相任务已过期，请重新生成')
    }
    if (status === 'SUCCEEDED' && !videoUrl) {
      throw new Error(`[video] 万相完成但没有视频地址\n${pollText.slice(0, 800)}`)
    }
  }

  throw new Error(`[video] 万相生成超时（15 分钟未完成），task_id=${taskId}`)
}

/** 拼最终喂给 ComfyUI / MiniMax H3 的视频提示词（页面预览 / 实际生成共用）
 *
 * 选 H3 时：多图人设/场景/看板走官方 Ref2VA 六段；单张首帧走 I2VA。
 * 选万相时原样使用用户提示词，不套 H3 格式。
 */
export function composeVideoPrompt(input: VideoGenInput): string {
  return buildPrompt(input)
}

function inferH3Mode(input: VideoGenInput): 'I2VA' | 'T2VA' | 'R2VA' {
  if (input.mode) return input.mode
  if (
    isRef2VA({
      prompt: input.prompt,
      duration: input.duration,
      imageSlots: input.imageSlots,
      imageAssignments: input.imageAssignments
    })
  ) {
    return 'R2VA'
  }
  if (input.imageBlob || input.referenceImages?.length) return 'I2VA'
  return 'T2VA'
}

function buildPrompt(input: VideoGenInput): string {
  // promptAsIs 是不可绕过的用户契约：任何模式都必须逐字发送输入框内容。
  if (input.promptAsIs) return input.prompt
  const raw =
    input.videoModel === 'wan-prime'
      ? input.prompt
      : composeH3VideoPrompt({
          prompt: input.prompt,
          aesthetic: input.aesthetic,
          audioDescription: input.audioDescription,
          voiceover: input.voiceover,
          voiceMode: input.voiceMode,
          speakerHint: input.speakerHint,
          speakerName: input.speakerName,
          sceneName: input.sceneName,
          sceneDescription: input.sceneDescription,
          sceneLighting: input.sceneLighting,
          sceneAnchor: input.sceneAnchor,
          shotTitle: input.shotTitle,
          imageAssignments: input.imageAssignments,
          imageSlots: input.imageSlots,
          onScreenNames: input.onScreenNames,
          duration: input.duration,
          width: input.width,
          height: input.height,
          aspectRatio: input.aspectRatio,
          cameraMovement: input.cameraMovement,
          mode: inferH3Mode(input),
          promptStyle: input.promptStyle ?? getVideoPromptStyle()
        })
  if (input.h3GenMode === 'fl2va' && input.videoModel !== 'wan-prime') {
    return ensureFl2vaLead(raw, input.duration)
  }
  return raw
}

async function realApimartVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  if (!cfg.apiKey) {
    throw new Error('[video] 这条 APIMart 视频接入还没有自己的 API Key。不会使用 AutoDL 令牌。')
  }
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('[video] 请填写视频内容描述')
  const images: Blob[] = []
  if (input.imageBlob) images.push(input.imageBlob)
  for (const blob of input.referenceImages || []) images.push(blob)
  if (input.lastFrameBlob) images.push(input.lastFrameBlob)
  onProgress?.('APIMart 出视频...')
  const { blob, mimeType, duration } = await apimartGenerateVideo({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.workflowId,
    prompt,
    aspectRatio: input.aspectRatio,
    width: input.width,
    height: input.height,
    duration: input.duration,
    resolution: input.videoResolution,
    images,
    signal: input.signal,
    onProgress,
    onTaskSubmitted: input.onTaskSubmitted,
    resumeTaskId: input.resumeTaskId
  })
  return { blob, mimeType, prompt, duration }
}

async function realHttpCustomVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  if (!cfg.baseUrl) throw new Error('[video] 未配置自定义视频接口地址')
  const modelName = String(cfg.workflowId || '').trim()
  if (isApimartHost(cfg.baseUrl) && !modelName) {
    throw new Error('[video] APIMart 需要在这条视频接入的工作流 ID 里填写模型名，例如 MiniMax-H3。')
  }
  const prompt = buildPrompt(input)
  onProgress?.('自定义 HTTP 出视频…')
  const images: string[] = []
  if (input.imageBlob) images.push(await blobToDataUrl(input.imageBlob))
  for (const blob of input.referenceImages || []) {
    images.push(await blobToDataUrl(blob))
  }
  const lastFrame = input.lastFrameBlob ? await blobToDataUrl(input.lastFrameBlob) : undefined
  const { blob, mimeType } = await httpCustomMediaGenerate({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: modelName || 'video',
    prompt,
    adapter: cfg.adapter,
    extraBody: {
      ...(images[0] ? { image: images[0] } : {}),
      ...(images.length ? { images } : {}),
      ...(lastFrame ? { last_frame: lastFrame } : {}),
      duration: input.duration,
      aspect_ratio: input.aspectRatio,
      width: input.width,
      height: input.height
    },
    signal: input.signal,
    kind: 'video',
    onProgress
  })
  return { blob, mimeType, prompt, duration: input.duration }
}

async function realZealmanVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  const configuredRoot = String(cfg.zealmanBaseUrl || cfg.baseUrl || '').trim()
  const root = normalizeZealmanBaseUrl(configuredRoot) || configuredRoot.replace(/\/+$/, '')
  const workflow = zealmanWorkflowById(cfg.workflowId || '')
  if (!root) throw new Error('[video] 请先在设置 → Zealman 镜像中填写 Base URL')
  if (/^https?:\/\/([^/]+\.)?autodl\.art(?::\d+)?$/i.test(root)) {
    throw new Error('[video] Zealman 镜像地址仍是 AutoDL。请到设置 → Zealman 镜像重新填写 SeetaCloud Base URL 并点击“应用配置”。')
  }
  if (!workflow) throw new Error(`[video] 未识别的 Zealman 工作流：${cfg.workflowId || '空'}`)

  const blobs = workflow.mode === 'fl2va'
    ? [input.imageBlob, input.lastFrameBlob].filter((item): item is Blob => Boolean(item))
    : [input.imageBlob, ...(input.referenceImages || [])]
        .filter((item): item is Blob => Boolean(item))
        .slice(0, workflow.maxImages)
  if (workflow.mode === 'fl2va' && blobs.length < 2) throw new Error('[video] Zealman 首尾帧工作流需要首帧和尾帧各一张')
  if (!blobs.length) throw new Error('[video] Zealman 工作流没有可用的参考图')

  onProgress?.(`准备 Zealman ${workflow.mode === 'fl2va' ? '首尾帧' : '多图参考'}工作流…`)
  const images: string[] = []
  for (const blob of blobs) images.push(await blobToVideoImageDataUrl(blob))
  const prompt = buildPrompt(input).slice(0, 10000)
  const duration = Math.max(1, Math.min(workflow.maxDuration, Math.round(input.duration) || 5))
  const width = Math.max(256, Math.round(input.width) || 864)
  const height = Math.max(256, Math.round(input.height) || 480)
  const inputValues: Record<string, string | number> = {
    [workflow.stepsKey]: 12,
    [workflow.promptKey]: prompt,
    [workflow.durationKey]: duration,
    [workflow.widthKey]: width,
    [workflow.heightKey]: height
  }
  workflow.imageKeys.forEach((key, index) => {
    if (images[index]) inputValues[key] = images[index]
  })

  let promptId = String(input.resumeTaskId || '').trim()
  if (!promptId) {
    onProgress?.('提交 Zealman 生成任务…')
    const submitUrl = `${root}/api/workflow/generate`
    const submitBody = JSON.stringify({ workflow_id: workflow.id, input_values: inputValues })
    const postSubmit = (url: string) => autodlRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: submitBody,
        signal: input.signal
      }, 180_000)
    let finalSubmitUrl = submitUrl
    let response = await postSubmit(finalSubmitUrl)
    let text = await response.text()
    // 部分 Zealman/Nginx 部署对结尾斜杠采用严格路由；405 时换一种形式重试一次。
    if (response.status === 405) {
      finalSubmitUrl = `${submitUrl}/`
      onProgress?.('镜像接口拒绝了无斜杠路径，正在改用兼容路径重试…')
      response = await postSubmit(finalSubmitUrl)
      text = await response.text()
    }
    if (!response.ok) {
      throw new Error(
        `[video] Zealman 提交失败 HTTP ${response.status}\n请求地址：${finalSubmitUrl}\n${text.slice(0, 800)}`
      )
    }
    let data: any
    try { data = JSON.parse(text) } catch { throw new Error(`[video] Zealman 提交成功但响应不是 JSON\n请求地址：${finalSubmitUrl}\n${text.slice(0, 500)}`) }
    if (data?.success === false) throw new Error(`[video] Zealman 提交失败：${data?.error || text.slice(0, 800)}`)
    promptId = String(data?.prompt_id || '').trim()
    if (!promptId) throw new Error('[video] Zealman 响应中没有 prompt_id')
    await input.onTaskSubmitted?.(promptId)
  }

  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    throwIfAborted(input.signal)
    onProgress?.(`Zealman 正在生成… (${promptId.slice(0, 8)})`)
    const response = await autodlRequest(
      `${root}/api/workflow/result?prompt_id=${encodeURIComponent(promptId)}`,
      { method: 'GET', signal: input.signal },
      60_000
    )
    const text = await response.text()
    let data: any
    try { data = JSON.parse(text) } catch { data = null }
    if (!response.ok || data?.success === false) throw new Error(`[video] Zealman 查询失败：${data?.error || text.slice(0, 800)}`)
    if (data?.pending === false) {
      const result = Array.isArray(data.results)
        ? data.results.find((item: any) => item?.type === 'video' && item?.url)
        : null
      if (!result?.url) throw new Error('[video] Zealman 任务已结束，但没有返回视频文件')
      const videoUrl = new URL(String(result.url), `${root}/`).toString()
      onProgress?.('下载 Zealman 生成的视频…')
      const { blob: rawBlob, mime: mimeHint } = await fetchVideoBytes(videoUrl, input.signal)
      const blob = await assertVideoBlob(rawBlob, mimeHint)
      return { blob, mimeType: blob.type || 'video/mp4', prompt, duration }
    }
    await abortableDelay(1500, input.signal)
  }
  throw new Error('[video] Zealman 生成超过 30 分钟，已停止轮询')
}

async function realComfyNativeVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const cfg = getVideoConfig(input.videoProfileId)
  if (!cfg.baseUrl) throw new Error('[video] 未配置自建 ComfyUI 地址')
  onProgress?.('自建 ComfyUI 出视频…')
  const prompt = buildPrompt(input)
  let imageDataUrl: string | undefined
  if (input.imageBlob) imageDataUrl = await blobToDataUrl(input.imageBlob)
  if (!cfg.adapter?.workflowTemplate?.trim()) {
    throw new Error(
      '[video] 自建 ComfyUI 需要在接入的 adapter.workflowTemplate 里提供完整 /prompt JSON（可用 {{prompt}} / {{image}} 占位）。AutoDL 云端请用 comfyui-workflow 适配器。'
    )
  }
  const { blob, mimeType } = await comfyPromptGenerate({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    prompt,
    imageDataUrl,
    adapter: cfg.adapter,
    signal: input.signal,
    kind: 'video',
    onProgress
  })
  return { blob, mimeType, prompt, duration: input.duration }
}

export async function generateVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const mode = getAIMode()
  if (mode === 'real') {
    if (input.audioSync) {
      if (!input.imageBlob || !input.audioBlob) {
        throw new Error('[video] 数字人口播需要人物参考图和对应音频')
      }
    } else if (input.h3GenMode === 'fl2va') {
      if (!input.imageBlob || !input.lastFrameBlob) {
        throw new Error('[video] 首尾帧模式需要首帧和尾帧各一张图')
      }
    } else if (!input.imageBlob) {
      const peekId = input.videoModel === 'h3-v5' ? autodlVideoProfileId() || input.videoProfileId : input.videoProfileId
      const peek = getVideoConfig(peekId)
      if (!isApimartEndpoint(peek.baseUrl, peek.provider)) {
        throw new Error('[video] 真实模式需要至少一张参考图')
      }
    }
    // 真实模式失败不再静默回退 mock，避免把「假动画/静态图」当成成品视频
    if (input.videoModel === 'wan-prime') {
      return await realWanVideo(input, onProgress)
    }
    const request = input.videoModel === 'h3-v5'
      ? { ...input, videoProfileId: autodlVideoProfileId() || input.videoProfileId }
      : input
    const vcfg = getVideoConfig(request.videoProfileId)
    if (isApimartEndpoint(vcfg.baseUrl, vcfg.provider)) {
      return await realApimartVideo(request, onProgress)
    }
    const adapterType = resolveVideoAdapter(vcfg)
    // 三条都要成立才走镜像：接入声明是 Zealman、适配器是 zealman-workflow、工作流 id 是内置 U 系列。
    // 10 秒 H3 固定是 AutoDL 工作流，不能因为当前激活项是 Zealman 就改道。
    if (
      request.videoModel !== 'h3-v5' &&
      vcfg.provider === 'zealman' &&
      adapterType === 'zealman-workflow' &&
      zealmanWorkflowById(vcfg.workflowId || '')
    ) {
      return await realZealmanVideo(request, onProgress)
    }
    if (request.videoModel === 'h3-v5' && vcfg.provider === 'zealman') {
      throw new Error('[video] 10 秒 H3 走 AutoDL 工作流。当前没有可用的 AutoDL 接入，请到设置里保存 AutoDL 算力，不要用 Zealman 镜像。')
    }
    if (adapterType === 'comfyui-prompt') {
      return await realComfyNativeVideo(request, onProgress)
    }
    if (adapterType === 'http-custom') {
      return await realHttpCustomVideo(request, onProgress)
    }
    return await realWorkflowVideo(request, onProgress)
  }

  // mock：只需要一张图（多张也只用第一张）
  onProgress?.('程序化生成视频中...')
  let imageBlob = input.imageBlob
  if (!imageBlob) {
    const { generateMockImage } = await import('./mock')
    imageBlob = await generateMockImage(
      input.prompt,
      input.width,
      input.height,
      'cinematic'
    )
  }
  const blob = await generateMockVideo(
    imageBlob,
    input.prompt,
    input.duration,
    input.width,
    input.height,
    input.cameraMovement
  )
  return { blob, mimeType: 'video/webm', prompt: buildPrompt(input), duration: input.duration }
}
