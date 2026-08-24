/**
 * AI 视频生成服务（图生视频 / 文生视频）
 *
 * 真实接口（ComfyUI workflow 包装）：
 *   POST {baseUrl}/api/workflow/generate
 *     body: { workflow_id, input_values: {...} }
 *     resp: { prompt_id }
 *   GET  {baseUrl}/api/workflow/result?prompt_id={id}   轮询
 *   GET  {baseUrl}/api/comfy/proxy/history?prompt_id={id}  兼容旧
 *
 * input_values 字段（按 workflow_id 变）：
 *   U09-API-9图版：137/139/146/147/148/149/150/151/170:image，最多 9 张
 *   旧 3 槽：137/139/141:image
 */

import { getAIMode } from './client'
import { getVideoConfig, getVideoPromptStyle } from './runtime'
import { generateMockVideo } from './mock'
import { assertValidH3Prompt, composeH3VideoPrompt } from './h3Prompt'
import type { Shot, AspectRatio } from '@/types'
import { abortableDelay, throwIfAborted } from './abort'
import type { VideoPromptStyle } from '@/utils/shotPrompt'

export interface VideoGenInput {
  /** 第一张参考图：角色设计图 / 场景图 / 故事看板之一，不是人物+场景配图 */
  imageBlob?: Blob
  /** 其余参考图，按角色设计图 → 场景图 → 故事看板的顺序 */
  referenceImages?: Blob[]
  /**
   * 分镜视觉描述（中文，详细场景）
   */
  prompt: string
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
  onScreenNames?: string[]
  duration: number
  width: number
  height: number
  /** 比例标签（写到 prompt 最前面 [16:9] 这种） */
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  /** 0-1，154:strength_model */
  strength?: number
  signal?: AbortSignal
  promptStyle?: VideoPromptStyle
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

const NINE_SLOT_IMAGE_KEYS = [
  '137:image',
  '139:image',
  '146:image',
  '147:image',
  '148:image',
  '149:image',
  '150:image',
  '151:image',
  '170:image'
]

function isNineSlotWorkflow(workflowId: string): boolean {
  return /9图|U09-API|U06-API/i.test(workflowId)
}

function resolveWorkflowId(workflowId: string): string {
  if (!workflowId || workflowId === 'minimax_h3_light2v-1' || workflowId === 'minimax_h3_light2v') {
    return 'U09-API-9图版'
  }
  return workflowId
}

function workflowBindings(workflowId: string) {
  if (isNineSlotWorkflow(workflowId)) {
    return {
      imageKeys: NINE_SLOT_IMAGE_KEYS,
      promptKey: '138:value',
      durationKey: '132:value',
      extras: (width: number, height: number, prefix: string, strength: number) => ({
        '168:filename_prefix': prefix,
        '168:format': 'video/h264-mp4',
        '205:strength_model': strength,
        '300:预设分辨率': '自定义',
        '300:自定义宽': width,
        '300:自定义高': height,
        '301:预设分辨率': '自定义',
        '301:自定义宽': width,
        '301:自定义高': height
      })
    }
  }
  return {
    imageKeys: ['137:image', '139:image', '141:image'],
    promptKey: '146:prompt',
    durationKey: '147:value',
    extras: (width: number, height: number, prefix: string, strength: number) => ({
      '92:filename_prefix': prefix,
      '92:format': 'auto',
      '92:codec': 'auto',
      '145:预设分辨率': '自定义',
      '145:批量大小': 1,
      '145:自定义宽': width,
      '145:自定义高': height,
      '154:strength_model': strength
    })
  }
}

function resultUrl(r: any): string {
  return String(r?.url ?? r?.video_url ?? r?.videoUrl ?? r?.filename ?? '').trim()
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
      if (/video/.test(type)) score += 40
      if (type === 'image' && !VIDEO_EXT_RE.test(url)) score -= 30
      if (/mp4|webm|mov|video/.test(blobText) && VIDEO_EXT_RE.test(url)) score += 10
      return { url, type, score }
    })
    .filter(Boolean) as { url: string; type?: string; score: number }[]

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  if (!best || best.score < 50) return null
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

/** 提交到 ComfyUI workflow 服务并轮询结果 */
async function realWorkflowVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const { baseUrl, apiKey, workflowId: rawWorkflowId } = getVideoConfig()
  const workflowId = resolveWorkflowId(rawWorkflowId)
  const bindings = workflowBindings(workflowId)
  throwIfAborted(input.signal)

  if (!baseUrl) {
    throw new Error('[video] 没配图生视频地址，请到设置页填写 ComfyUI 地址')
  }

  const allBlobs = [input.imageBlob, ...(input.referenceImages ?? [])]
    .filter((b): b is Blob => !!b)
    .slice(0, bindings.imageKeys.length)

  if (allBlobs.length === 0) {
    throw new Error('[video] 没有可用图片')
  }

  onProgress?.(`准备参考图...`)
  const dataUrls: string[] = []
  for (const blob of allBlobs) {
    dataUrls.push(await blobToVideoImageDataUrl(blob))
  }
  const referencePayloadMb = dataUrls.reduce((sum, value) => sum + value.length, 0) / 1024 / 1024
  onProgress?.(`参考图已准备：${dataUrls.length} 张 / 约 ${referencePayloadMb.toFixed(1)} MB`)
  const imageValues: Record<string, string | null> = {}
  bindings.imageKeys.forEach((key, index) => {
    imageValues[key] = dataUrls[index] ?? null
  })

  // 3) 尺寸 clamp：宽高都不能超过 2048（workflow 限制）
  const MAX_DIM = 2048
  let width = input.width
  let height = input.height
  if (width > MAX_DIM || height > MAX_DIM) {
    const ratio = Math.min(MAX_DIM / width, MAX_DIM / height)
    width = Math.floor(width * ratio)
    height = Math.floor(height * ratio)
    // 保证偶数（FFmpeg/H.264 要求）
    if (width % 2 !== 0) width--
    if (height % 2 !== 0) height--
    onProgress?.(`尺寸超过 2048，已缩放到 ${width}×${height}`)
  }

  // 4) 时长 clamp：ComfyUI workflow 只支持 5-10 秒
  const MIN_DUR = 5
  const MAX_DUR = 10
  const targetDuration = Math.max(MIN_DUR, Math.min(MAX_DUR, Math.round(input.duration)))
  if (targetDuration !== input.duration) {
    onProgress?.(
      `视频时长 clamp 到 ${targetDuration} 秒（workflow 限制 ${MIN_DUR}-${MAX_DUR}s）`
    )
  }

  // 付费请求前做确定性检查：制作说明不得混入中文引号，只有清洗后的原词可被朗读。
  const finalPrompt = buildPrompt(input)
  const expectedDialogue = input.voiceMode === 'none' ? '' : input.voiceover
  assertValidH3Prompt(finalPrompt, expectedDialogue)
  onProgress?.('H3 提示词自检通过')

  // 2) 提交任务
  onProgress?.('提交生成任务...')
  let submitResp: Response
  try {
    submitResp = await fetch(`${baseUrl}/api/workflow/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        workflow_id: workflowId,
        input_values: {
          ...imageValues,
          [bindings.promptKey]: finalPrompt,
          [bindings.durationKey]: targetDuration,
          ...bindings.extras(width, height, 'ai-cut', input.strength ?? 0.75)
        }
      }),
      signal: input.signal
    })
  } catch (error: any) {
    throw new Error(`[video] 无法连接生成服务：${error?.message || String(error)}（参考图约 ${referencePayloadMb.toFixed(1)} MB）`)
  }

  if (!submitResp.ok) {
    const body = await submitResp.text()
    const hint = submitResp.status === 413 ? '；请求体过大，请降低参考图尺寸或检查代理上传限制' : ''
    throw new Error(
      `[video] 任务提交失败 ${submitResp.status}${hint}：${body.slice(0, 1200)}`
    )
  }
  const submitData = await submitResp.json()
  const promptId = submitData.prompt_id ?? submitData.id
  if (!promptId) {
    throw new Error(
      `[video] 提交响应无 prompt_id\n原始：${JSON.stringify(submitData).slice(0, 200)}`
    )
  }
  onProgress?.(`任务已提交 (${promptId})`)
  log(`✓ 任务已提交: ${promptId}`)

  // 3) 轮询结果
  const start = Date.now()
  const deadline = start + 15 * 60 * 1000 // 15 分钟超时
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    await abortableDelay(5000, input.signal)
    throwIfAborted(input.signal)
    const elapsed = Math.round((Date.now() - start) / 1000)
    onProgress?.(`生成中... ${elapsed}s (第 ${attempt} 次查询)`)

    // 优先用新接口
    const pollUrl = `${baseUrl}/api/workflow/result?prompt_id=${promptId}`
    let pollResp = await fetch(pollUrl, { signal: input.signal })
    let pollData: any = null
    if (pollResp.ok) {
      pollData = await pollResp.json()
    } else {
      // fallback 旧接口
      const fallback = await fetch(
        `${baseUrl}/api/comfy/proxy/history?prompt_id=${promptId}`,
        { signal: input.signal }
      )
      if (fallback.ok) pollData = await fallback.json()
    }

    if (attempt === 1 || attempt % 4 === 0) {
      log(`轮询 #${attempt} (${elapsed}s): ${JSON.stringify(pollData).slice(0, 200)}`)
    }

    if (!pollData) continue

    // === 真实结果格式 ===
    // 成功（pending: false）：
    //   { "success": true, "pending": false, "prompt_id": "...", "results": [
    //       { "type": "image", "url": "/output/ai-cut_00002_.mp4", "raw": {...} }
    //   ]}
    // 进行中（pending: true）：
    //   { "success": true, "pending": true, "prompt_id": "..." }
    // 失败：
    //   { "success": false, "error": "..." }

    // 1) 失败
    if (pollData.success === false) {
      throw new Error(
        `[video] 任务失败: ${pollData.error ?? pollData.message ?? 'unknown'}`
      )
    }

    // 2) 还在进行中
    if (pollData.pending === true) {
      // 继续轮询
      onProgress?.(`生成中... ${elapsed}s`)
      continue
    }

    // 3) 完成（pending === false 且有 results）
    if (
      pollData.pending === false &&
      Array.isArray(pollData.results) &&
      pollData.results.length > 0
    ) {
      const picked = pickWorkflowVideoResult(pollData.results)
      if (!picked) {
        const sample = JSON.stringify(pollData.results).slice(0, 500)
        throw new Error(
          `[video] 任务完成但结果里没有视频文件（可能只返回了预览图）\n${sample}`
        )
      }

      let videoUrl: string = picked.url
      // url 是相对路径（/output/xxx.mp4），拼成完整 URL
      if (videoUrl.startsWith('/')) {
        videoUrl = `${baseUrl}${videoUrl}`
      } else if (!/^https?:\/\//i.test(videoUrl)) {
        videoUrl = `${baseUrl}/${videoUrl}`
      }

      log(`→ 下载视频: ${videoUrl}（候选 type=${picked.type || '?'}）`)
      onProgress?.('下载视频...')
      const vResp = await fetch(videoUrl, { signal: input.signal })
      if (!vResp.ok) {
        throw new Error(`下载视频失败 ${vResp.status} ${videoUrl}`)
      }
      const rawBlob = await vResp.blob()
      const mimeHint =
        vResp.headers.get('content-type') ||
        guessVideoMimeFromUrl(videoUrl) ||
        rawBlob.type
      const blob = await assertVideoBlob(rawBlob, mimeHint)
      log(`✓ 视频下载完成 (${(blob.size / 1024 / 1024).toFixed(2)} MB, ${blob.type})`)
      return {
        blob,
        mimeType: blob.type || 'video/mp4',
        prompt: finalPrompt,
        duration: input.duration
      }
    }

    // 4) 老格式兼容（如果将来服务端又换协议）
    const status = String(
      pollData.status ??
        pollData.state ??
        pollData?.outputs?.[promptId]?.status ??
        ''
    ).toLowerCase()

    if (status === 'success' || status === 'completed' || status === 'succeeded' || status === 'done') {
      const videoUrl =
        pollData.video_url ??
        pollData.url ??
        pollData.videoUrl ??
        pollData?.outputs?.[promptId]?.video_url ??
        pollData?.outputs?.[promptId]?.url ??
        pollData?.outputs?.[0]?.url ??
        pollData?.outputs?.[0]?.video_url ??
        pollData?.data?.video_url

      if (!videoUrl) {
        throw new Error(
          `[video] 任务完成但找不到视频 URL（老格式）\n原始：${JSON.stringify(pollData).slice(0, 300)}`
        )
      }
      onProgress?.('下载视频...')
      const vResp = await fetch(videoUrl, { signal: input.signal })
      if (!vResp.ok) throw new Error(`下载视频失败 ${vResp.status}`)
      const rawBlob = await vResp.blob()
      const mimeHint =
        vResp.headers.get('content-type') ||
        guessVideoMimeFromUrl(String(videoUrl)) ||
        rawBlob.type
      const blob = await assertVideoBlob(rawBlob, mimeHint)
      return {
        blob,
        mimeType: blob.type || 'video/mp4',
        prompt: finalPrompt,
        duration: input.duration
      }
    }

    if (
      status === 'failed' ||
      status === 'error' ||
      status === 'cancelled' ||
      status === 'canceled'
    ) {
      throw new Error(
        `[video] 生成失败: ${pollData.error ?? pollData.message ?? status}`
      )
    }

    // 否则继续轮询（status 是 pending / running / queued 等）
  }

  throw new Error(`[video] 生成超时（15 分钟未完成），prompt_id=${promptId}`)
}

/** 拼最终喂给 ComfyUI / MiniMax H3 的视频提示词（页面预览 / 实际生成共用）
 *
 * 按 H3 官方 I2VA 编译：首帧对齐句 + integrated_multimodal_description +
 * overall_soundscape + non_diegetic_music。
 */
export function composeVideoPrompt(input: VideoGenInput): string {
  return buildPrompt(input)
}

function buildPrompt(input: VideoGenInput): string {
  return composeH3VideoPrompt({
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
    onScreenNames: input.onScreenNames,
    duration: input.duration,
    width: input.width,
    height: input.height,
    aspectRatio: input.aspectRatio,
    cameraMovement: input.cameraMovement,
    mode: input.imageBlob || input.referenceImages?.length ? 'I2VA' : 'T2VA',
    promptStyle: input.promptStyle ?? getVideoPromptStyle()
  })
}

export async function generateVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const mode = getAIMode()
  if (mode === 'real') {
    if (!input.imageBlob) {
      throw new Error('[video] 真实模式需要角色设计图、场景图和故事看板作为参考输入')
    }
    // 真实模式失败不再静默回退 mock，避免把「假动画/静态图」当成成品视频
    return await realWorkflowVideo(input, onProgress)
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
