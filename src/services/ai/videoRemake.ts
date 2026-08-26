/**
 * 视频复刻：抽帧 → Qwen3.8-Max 理解镜头 → 写成剧本/分镜
 * 配音一律后期 TTS；合成视频不让 H3 出人声。
 */

import { callLLM, blobToChatImageUrl, getAIMode, type LLMContentPart } from './client'
import { getRemakeVisionModel, getVisionConfig } from './runtime'
import { normalizeStoryboard, storyboardToShots } from './storyboard'
import type { StoryboardResult } from './storyboard'
import type { VisualStyle } from '@/types'

export interface RemakeAnalysisShot {
  title: string
  start?: number
  duration?: number
  shotSize?: string
  cameraMovement?: string
  action?: string
  visualPrompt?: string
  videoPrompt?: string
  voiceover?: string
  audioDescription?: string
  purpose?: string
}

export interface RemakeAnalysis {
  topic: string
  aesthetic?: string
  summary?: string
  subjects?: Array<{ name: string; kind?: string; description?: string; role?: string }>
  scenes?: Array<{ name: string; description?: string; lighting?: string; mainAnchor?: string }>
  shots: RemakeAnalysisShot[]
  playMarkdown: string
  result: StoryboardResult
}

function parseJsonLoose(text: string): any {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    const repaired = text
      .slice(start, end + 1)
      .replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(repaired)
  }
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  const t = Math.max(0, time)
  if (Math.abs(video.currentTime - t) < 0.05 && video.readyState >= 2) return
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      window.clearTimeout(timer)
      resolve()
    }
    const fail = () => {
      video.removeEventListener('seeked', done)
      video.removeEventListener('error', fail)
      window.clearTimeout(timer)
      reject(new Error('抽帧失败'))
    }
    const timer = window.setTimeout(done, 2500)
    video.addEventListener('seeked', done)
    video.addEventListener('error', fail)
    video.currentTime = t
  })
}

export async function extractVideoFrames(
  blob: Blob,
  count = 10
): Promise<{ frames: Blob[]; duration: number }> {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.style.cssText =
    'position:fixed;left:-9999px;width:4px;height:4px;opacity:0;pointer-events:none'
  document.body.appendChild(video)
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('无法读取上传的视频'))
    })
    video.src = url
    await loaded
    try {
      await video.play()
      video.pause()
    } catch {
      /* 有的浏览器不允许自动播放，seek 仍然可用 */
    }
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法抽帧')
    const frames: Blob[] = []
    const n = Math.max(4, Math.min(12, count))
    for (let i = 0; i < n; i++) {
      const t = Math.min(duration - 0.08, Math.max(0, ((i + 0.5) / n) * duration))
      await seekVideo(video, t)
      canvas.width = video.videoWidth || 720
      canvas.height = video.videoHeight || 1280
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const frame = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('抽帧转码失败'))),
          'image/jpeg',
          0.82
        )
      })
      frames.push(frame)
    }
    return { frames, duration }
  } finally {
    video.remove()
    URL.revokeObjectURL(url)
  }
}

function playMarkdownFromRaw(raw: any): string {
  const topic = String(raw?.topic || '视频复刻').trim()
  const lines = [`# ${topic}`, '', '## 故事梗概', '', String(raw?.summary || raw?.aesthetic || topic), '']
  const subjects = Array.isArray(raw?.subjects) ? raw.subjects : []
  if (subjects.length) {
    lines.push('## 人物', '')
    for (const s of subjects) {
      lines.push(`### ${s?.name || '角色'}`)
      lines.push('')
      lines.push(String(s?.description || '全片保持同一外貌与穿戴。'))
      lines.push('')
    }
  }
  const scenes = Array.isArray(raw?.scenes) ? raw.scenes : []
  if (scenes.length) {
    lines.push('## 场景', '')
    for (const s of scenes) {
      lines.push(`### ${s?.name || '场景'}`)
      lines.push('')
      lines.push(String(s?.description || ''))
      lines.push('')
    }
  }
  const shots = Array.isArray(raw?.shots) ? raw.shots : []
  lines.push('## 分场', '')
  shots.forEach((s: any, i: number) => {
    lines.push(`### 第 ${i + 1} 场　${s?.title || `镜头${i + 1}`}`)
    lines.push('')
    lines.push(`**口播**　${s?.voiceover?.trim() || '无'}`)
    lines.push('')
    lines.push(`**画面**　${s?.visualPrompt || s?.action || ''}`)
    lines.push('')
    lines.push(`**声音**　${s?.audioDescription || '环境音'}`)
    lines.push('')
    lines.push(`**时长**　约 ${Math.round(Number(s?.duration) || 5)} 秒`)
    lines.push('')
  })
  return lines.join('\n')
}

function mockRemakeRaw(topic: string): any {
  return {
    topic: topic || '产品短视频复刻',
    summary: '按参考视频的镜头节奏复刻一条带货短片，画面中的商品换成用户产品。',
    aesthetic: '干净商业短视频，产品特写清晰，光线均匀。',
    subjects: [
      {
        name: '出镜主角',
        kind: 'person',
        description: '全片同一人，服装与发型保持一致',
        role: '主角'
      }
    ],
    scenes: [
      {
        name: '主场景',
        description: '参考视频中的主要拍摄环境',
        lighting: '自然光或柔和顶光'
      }
    ],
    shots: [
      {
        title: '开场钩子',
        duration: 5,
        shotSize: '近景',
        cameraMovement: 'push',
        visualPrompt: '产品被拿到镜头前，包装与 logo 必须与用户产品图完全一致。',
        videoPrompt: '主角把用户产品拿到镜头前，包装和 logo 始终清晰，说完开场那句。',
        voiceover: '你还在用普通的吗？',
        audioDescription: '衣料摩擦、轻微环境底噪',
        purpose: '钩子'
      },
      {
        title: '功能展示',
        duration: 6,
        shotSize: '中景',
        cameraMovement: 'static',
        visualPrompt: '主角使用用户产品，动作清楚，背景简洁。',
        videoPrompt: '主角使用用户产品，动作清楚，把这一步做完并说完功能那句。',
        voiceover: '关键就在这一步。',
        audioDescription: '操作声、环境底噪',
        purpose: '说明'
      },
      {
        title: '收口特写',
        duration: 5,
        shotSize: '特写',
        cameraMovement: 'push',
        visualPrompt: '用户产品包装特写，logo 清晰。',
        videoPrompt: '镜头推到用户产品包装特写，logo 清楚，说完收口那句。',
        voiceover: '换它就对了。',
        audioDescription: '轻放桌面的声音',
        purpose: '收口'
      }
    ]
  }
}

export async function analyzeRemakeVideo(
  input: {
    videoBlob: Blob
    topic?: string
    aspectRatio: string
    style: VisualStyle
    productCount: number
    signal?: AbortSignal
    onProgress?: (msg: string) => void
  }
): Promise<RemakeAnalysis> {
  const topic = input.topic?.trim() || '视频复刻'
  input.onProgress?.('抽取参考视频关键帧…')
  const { frames, duration } = await extractVideoFrames(input.videoBlob, 10)

  let raw: any
  if (getAIMode() !== 'real') {
    input.onProgress?.('演示模式：按参考视频节奏生成脚本')
    raw = mockRemakeRaw(topic)
  } else {
    input.onProgress?.(`理解视频镜头（${frames.length} 帧）…`)
    const parts: LLMContentPart[] = [
      {
        type: 'text',
        text: `你是短视频分镜导演。下面按时间顺序给出参考视频的关键帧（全片约 ${duration.toFixed(1)} 秒，画面比例 ${input.aspectRatio}）。
请理解：内容讲什么、每镜景别/运镜/动作、听到的口播、现场环境音、出场人物与场景。
然后写成可复刻的分镜脚本。商品外观不要抄原视频品牌，只写「用户产品」，因为后续会换成用户上传的 ${input.productCount} 张产品图。

只输出 JSON：
{
  "topic": "<短标题>",
  "summary": "<一两段梗概>",
  "aesthetic": "<全片画面味道，中文>",
  "subjects": [{ "name": "", "kind": "person|animal|other", "description": "", "role": "" }],
  "scenes": [{ "name": "", "description": "", "lighting": "", "mainAnchor": "" }],
  "shots": [{
    "title": "<3-8字>",
    "duration": 5,
    "shotSize": "",
    "cameraMovement": "push|pull|pan|tilt|static|orbit",
    "purpose": "钩子|说明|反应|揭示|收口",
    "visualPrompt": "<中文可拍描述，产品写作用户产品>",
    "videoPrompt": "<中文视频内容表现，写细：每个角色表情神态、动作、环境反应、原词台词、运镜；不要抄 visualPrompt>",
    "voiceover": "<这一镜听到的口播原文；没有就空>",
    "audioDescription": "<环境音，中文短句>",
    "audioMode": "tts"
  }]
}
口播按镜头切开，不要发明原片没有的功效承诺。每镜 duration 5-10 秒整数。配音全部后期合成，audioMode 一律 tts，无口播用 none。生成视频时不要人声。`
      }
    ]
    for (let i = 0; i < frames.length; i++) {
      parts.push({
        type: 'image_url',
        image_url: { url: await blobToChatImageUrl(frames[i], 960, 0.78) }
      })
    }
    const primary = getRemakeVisionModel()
    const fallback = getVisionConfig().model
    const models = fallback && fallback !== primary ? [primary, fallback] : [primary]
    let lastErr: unknown
    let respContent = ''
    for (const model of models) {
      try {
        input.onProgress?.('理解镜头…')
        const resp = await callLLM({
          provider: 'vision',
          model,
          messages: [
            {
              role: 'system',
              content: '你只输出合法 JSON。理解视频镜头语言，写成可复刻分镜。配音全部后期 TTS。'
            },
            { role: 'user', content: parts }
          ],
          jsonMode: true,
          temperature: 0.2,
          maxTokens: 8192,
          timeoutMs: 180_000,
          signal: input.signal
        })
        respContent = resp.content
        lastErr = null
        break
      } catch (e: any) {
        lastErr = e
        const msg = String(e?.message || e)
        const canFallback =
          model !== models[models.length - 1] &&
          /does not support.*image|image.*not supported|Unexpected item type in content|不支持图片/i.test(
            msg
          )
        if (!canFallback) throw e
        input.onProgress?.('当前模型不能看图，换一套继续…')
      }
    }
    if (lastErr) throw lastErr
    raw = parseJsonLoose(respContent)
  }

  if (!Array.isArray(raw?.shots) || !raw.shots.length) {
    throw new Error('视频分析结果没有分镜')
  }
  raw.topic = String(raw.topic || topic).trim() || topic
  for (const s of raw.shots) {
    s.audioMode = String(s?.voiceover || '').trim() ? 'tts' : 'none'
  }
  const result = normalizeStoryboard(raw, {
    style: input.style,
    topic: raw.topic,
    content: String(raw.summary || '')
  })
  for (const shot of result.shots) {
    shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
  }
  const playMarkdown = playMarkdownFromRaw(raw)
  return {
    topic: raw.topic,
    aesthetic: raw.aesthetic,
    summary: raw.summary,
    subjects: raw.subjects,
    scenes: raw.scenes,
    shots: raw.shots,
    playMarkdown,
    result
  }
}

export function remakeShotsFromAnalysis(analysis: RemakeAnalysis) {
  const shots = storyboardToShots(analysis.result)
  for (const shot of shots) {
    shot.audioMode = shot.voiceover?.trim() ? 'tts' : 'none'
  }
  return shots
}
