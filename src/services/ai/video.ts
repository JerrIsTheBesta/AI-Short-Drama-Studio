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
 * input_values 字段（按 workflow_id 变，这里是 minimax_h3_light2v-1）：
 *   137:image / 139:image / 141:image    3 张图（URL 或 data:base64）
 *   92:filename_prefix / format / codec  输出
 *   145:预设分辨率 / 批量大小 / 自定义宽/高
 *   146:prompt                            文本
 *   147:value                             帧数/时长
 *   154:strength_model                    模型强度
 */

import { getAIMode } from './client'
import { getVideoConfig } from './runtime'
import { generateMockVideo } from './mock'
import type { Shot, AspectRatio } from '@/types'

export interface VideoGenInput {
  /** 主输入图（分镜自己的图） */
  imageBlob?: Blob
  /** 参考图（0-3 张，和 imageBlob 合并） */
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
   * 当前 ComfyUI prompt 字段不直接吃，但保留在 shot 上以备字幕/后期用
   */
  audioDescription?: string
  duration: number
  width: number
  height: number
  /** 比例标签（写到 prompt 最前面 [16:9] 这种） */
  aspectRatio?: AspectRatio
  cameraMovement?: Shot['cameraMovement']
  /** 0-1，154:strength_model */
  strength?: number
}

export interface VideoGenOutput {
  blob: Blob
  mimeType: string
  prompt: string
  duration: number
}

const log = (msg: string) =>
  console.log('%c[video]', 'color:#ec4899;font-weight:600', msg)

/** Blob → data:base64 字符串 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(blob)
  })
}

/** 提交到 ComfyUI workflow 服务并轮询结果 */
async function realWorkflowVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  const { baseUrl, apiKey, workflowId } = getVideoConfig()

  if (!baseUrl) {
    throw new Error('[video] 没配图生视频地址，打开右侧「模型」面板填 ComfyUI 地址')
  }

  // 1) 收集图：imageBlob + referenceImages，最多 3 张
  const allBlobs = [input.imageBlob, ...(input.referenceImages ?? [])]
    .filter((b): b is Blob => !!b)
    .slice(0, 3)

  if (allBlobs.length === 0) {
    throw new Error('[video] 没有可用图片')
  }

  onProgress?.(`准备 ${allBlobs.length} 张参考图...`)
  // 2) 转 data:base64（最稳，不用管公网 URL）
  const dataUrls: string[] = []
  for (const blob of allBlobs) {
    dataUrls.push(await blobToDataUrl(blob))
  }
  // 3 张图填充：图生视频以本镜成图为主；缺槽复用同一张，避免混入人设棚拍图拉亮光照
  const [img1, img2, img3] = [
    dataUrls[0],
    dataUrls[1] ?? dataUrls[0],
    dataUrls[2] ?? dataUrls[0]
  ]

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

  // 2) 提交任务
  onProgress?.('提交生成任务...')
  const submitResp = await fetch(`${baseUrl}/api/workflow/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      workflow_id: workflowId,
      input_values: {
        '137:image': img1,
        '139:image': img2,
        '141:image': img3,
        '92:filename_prefix': 'ai-cut',
        '92:format': 'auto',
        '92:codec': 'auto',
        '145:预设分辨率': '自定义',
        '145:批量大小': 1,
        '145:自定义宽': width,
        '145:自定义高': height,
        '146:prompt': buildPrompt(input),
        '147:value': targetDuration,
        '154:strength_model': input.strength ?? 0.75
      }
    })
  })

  if (!submitResp.ok) {
    throw new Error(
      `[video] 任务提交失败 ${submitResp.status} ${await submitResp.text()}`
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
    await new Promise((r) => setTimeout(r, 5000))
    const elapsed = Math.round((Date.now() - start) / 1000)
    onProgress?.(`生成中... ${elapsed}s (第 ${attempt} 次查询)`)

    // 优先用新接口
    const pollUrl = `${baseUrl}/api/workflow/result?prompt_id=${promptId}`
    let pollResp = await fetch(pollUrl)
    let pollData: any = null
    if (pollResp.ok) {
      pollData = await pollResp.json()
    } else {
      // fallback 旧接口
      const fallback = await fetch(
        `${baseUrl}/api/comfy/proxy/history?prompt_id=${promptId}`
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
      // 找视频/图片结果（type 可能是 'image' 或其他，但 url 后缀是关键）
      const result =
        pollData.results.find(
          (r: any) =>
            r.url && /\.(mp4|webm|mov|m4v|avi)$/i.test(String(r.url))
        ) || pollData.results[0]

      let videoUrl: string =
        result.url ?? result.video_url ?? result.videoUrl ?? ''
      if (!videoUrl) {
        throw new Error(
          `[video] 任务完成但 results[0] 没有 url 字段\n原始：${JSON.stringify(pollData).slice(0, 400)}`
        )
      }

      // url 是相对路径（/output/xxx.mp4），拼成完整 URL
      if (videoUrl.startsWith('/')) {
        videoUrl = `${baseUrl}${videoUrl}`
      }
      // 如果没有协议前缀，视为相对路径
      else if (!/^https?:\/\//i.test(videoUrl)) {
        videoUrl = `${baseUrl}/${videoUrl}`
      }

      log(`→ 下载视频: ${videoUrl}`)
      onProgress?.('下载视频...')
      const vResp = await fetch(videoUrl)
      if (!vResp.ok) {
        throw new Error(`下载视频失败 ${vResp.status} ${videoUrl}`)
      }
      const blob = await vResp.blob()
      log(`✓ 视频下载完成 (${(blob.size / 1024 / 1024).toFixed(2)} MB, ${blob.type})`)
      return {
        blob,
        mimeType: blob.type || 'video/mp4',
        prompt: input.prompt,
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
      const vResp = await fetch(videoUrl)
      if (!vResp.ok) throw new Error(`下载视频失败 ${vResp.status}`)
      const blob = await vResp.blob()
      return {
        blob,
        mimeType: blob.type || 'video/mp4',
        prompt: input.prompt,
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

/** 拼最终喂给模型的视频提示词（页面预览 / 实际生成共用）
 *
 * 拼接顺序：
 *  1. aesthetic（项目级整体氛围）
 *  2. visualPrompt（分镜详细场景描述）
 *  3. 运镜提示
 *  4. 比例标签 [W:H] 放最后
 */
export function composeVideoPrompt(input: VideoGenInput): string {
  return buildPrompt(input)
}

function buildPrompt(input: VideoGenInput): string {
  const parts: string[] = []

  // 1) Aesthetic（项目级画风锚，优先用户主题提炼结果）
  if (input.aesthetic?.trim()) {
    parts.push(`Aesthetic\n${input.aesthetic.trim()}`)
  }

  // 2) 分镜详细视觉描述
  if (input.prompt?.trim()) {
    parts.push(`Visual Prompt\n${input.prompt.trim()}`)
  }

  // 3) 运镜提示
  const cameraHints: Record<string, string> = {
    push: 'Subtle handheld push-in',
    pull: 'Very slow handheld pull-back',
    pan: 'Gentle handheld pan',
    tilt: 'Gentle tilt',
    static: 'Static handheld medium shot, subtle natural frame tremor',
    orbit: 'Slow orbit around subject'
  }
  if (input.cameraMovement) {
    parts.push(`Camera Motion\n${cameraHints[input.cameraMovement] || input.cameraMovement}`)
  }

  // 4) 环境音效（写入提示，尽量让成片视频自带这些声音）
  if (input.audioDescription?.trim()) {
    parts.push(
      `Audio / Sound Effects\n${input.audioDescription.trim()}\nGenerate synchronized diegetic ambient sound matching the scene (no music bed, no voiceover).`
    )
  }

  // 5) 光照锁定：防止 I2V 模型随运动把夜晚漂成白天
  parts.push(
    'Keep the exact same time of day, weather and lighting as the first frame. If the first frame is night, stay night throughout; never brighten into day or shift color temperature.'
  )

  // 6) 比例标签
  if (input.aspectRatio) {
    parts.push(`[${input.aspectRatio}]`)
  }

  return parts.filter(Boolean).join('\n\n')
}

export async function generateVideo(
  input: VideoGenInput,
  onProgress?: (msg: string) => void
): Promise<VideoGenOutput> {
  if (getAIMode() === 'real' && input.imageBlob) {
    try {
      return await realWorkflowVideo(input, onProgress)
    } catch (e) {
      console.warn('[video] real 模式失败，回退 mock:', e)
    }
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
  return { blob, mimeType: 'video/webm', prompt: input.prompt, duration: input.duration }
}
