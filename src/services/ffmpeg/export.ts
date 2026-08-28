/**
 * 视频导出
 *
 * 把时间线上的所有片段 → 转场 → 字幕 → 一键合成
 *
 * 关键点：
 * - 全部重编码为 H.264/AAC（不 -c copy），兼容 webm/mp4/mov 各种输入
 * - 图片补静音音轨，避免 concat 因缺音频失败
 * - 每个阶段有详细 log 和明确错误信息
 */

import { getFFmpeg, writeFile, readFile, toBlob, clearFS } from './client'
import { renderCaptionPng, type SubtitleCue } from './subtitle'
import type { CaptionStyle, TimelineClip, TransitionType } from '@/types'

export interface ExportInput {
  timeline: TimelineClip[]
  mediaMap: Map<string, { blob: Blob; kind: 'video' | 'image' }>
  voiceoverMap: Map<string, string>
  width: number
  height: number
  fps: number
  captionStyle: CaptionStyle
  burnCaptions?: boolean
  captionCues?: SubtitleCue[]
  captionBg?: boolean
  captionHighlight?: boolean
  captionHighlightColor?: string
  captionHighlightScale?: number
  bgm?: Blob
  bgmVolume?: number
  /** 分镜原片环境音音量（0=静音，建议 0.35–0.7） */
  originalVolume?: number
  /** 分镜口播 TTS（shotId → 音频 blob），叠到对应片段上 */
  voiceoverAudioMap?: Map<string, Blob>
  voiceoverVolume?: number
  /** 是否保留各段视频自带的环境音效（默认 true） */
  keepAmbientAudio?: boolean
  /** 分镜级原声音轨决策；H3 自带对白/口播可强制保留，不受全局环境音开关影响 */
  sourceAudioMap?: Map<string, boolean>
  format?: 'mp4' | 'webm'
  onProgress?: (msg: string) => void
}

const log = (msg: string) =>
  console.log('%c[export]', 'color:#f59e0b;font-weight:600', msg)

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message)
  }
  return String(e)
}

function wrapError(e: unknown, extra = ''): Error {
  return new Error(errorMessage(e) + extra)
}

function even(n: number): number {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v - 1
}

export async function exportVideo(input: ExportInput): Promise<Blob> {
  const ffmpeg = await getFFmpeg(input.onProgress)
  const format = input.format ?? 'mp4'
  const mimeType = `video/${format}`
  const width = even(input.width)
  const height = even(input.height)

  const recentLog: string[] = []
  const logHandler = ({ message }: { message: string }) => {
    recentLog.push(message)
    if (recentLog.length > 40) recentLog.shift()
  }
  ffmpeg.on('log', logHandler)

  try {
    await clearFS(ffmpeg)
    log(`开始导出: ${format.toUpperCase()} ${width}×${height}@${input.fps}fps`)
    input.onProgress?.('准备素材...')

    const enabled = input.timeline.filter((c) => c.enabled)
    const totalDur = enabled.reduce((s, c) => s + Math.max(0.1, c.duration), 0)
    await writeFile(ffmpeg, 'silence.wav', makeSilentWav(Math.max(totalDur, 8) + 2))

    let cursor = 0
    const concatLines: string[] = []
    const cues: SubtitleCue[] = []

    for (let i = 0; i < enabled.length; i++) {
      const clip = enabled[i]
      const media = input.mediaMap.get(clip.shotId)
      if (!media) {
        console.warn(`[export] clip ${clip.id} 没有媒体，跳过`)
        continue
      }

      const inExt = guessExt(media.blob.type, media.kind)
      const inName = `clip_${i}_in.${inExt}`
      let outName = `clip_${i}.mp4`
      await writeFile(ffmpeg, inName, media.blob)
      log(
        `[${i}] 写入 ${inName} (${(media.blob.size / 1024 / 1024).toFixed(2)} MB, ${media.blob.type || media.kind})`
      )

      const duration = Math.max(0.1, clip.duration)
      const sourceIn = Math.max(0, clip.sourceIn || 0)
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1
      const keepAmbient =
        (input.sourceAudioMap?.get(clip.shotId) ?? input.keepAmbientAudio !== false) &&
        media.kind === 'video'
      const ambientVol = keepAmbient
        ? Math.max(0, Math.min(2, clip.volume ?? input.originalVolume ?? 0.55))
        : 0
      const videoFilter = buildVideoFilter(width, height, input.fps, speed)

      input.onProgress?.(
        keepAmbient
          ? `[${i + 1}/${enabled.length}] 转换片段（保留环境音）...`
          : `[${i + 1}/${enabled.length}] 转换片段（去掉原片配乐）...`
      )
      await transcodeClip(ffmpeg, {
        kind: media.kind,
        inName,
        outName,
        duration,
        sourceIn,
        fps: input.fps,
        videoFilter,
        speed,
        volume: ambientVol,
        keepAmbient
      })
      log(`[${i}] ✓ 转码完成 → ${outName}${keepAmbient ? '（含环境音）' : ''}`)

      try {
        await ffmpeg.deleteFile(inName)
      } catch {
        /* ignore */
      }

      const voBlob = input.voiceoverAudioMap?.get(clip.shotId)
      if (voBlob && voBlob.size > 200) {
        input.onProgress?.(`[${i + 1}/${enabled.length}] 叠口播人声...`)
        const mixedName = `clip_${i}_vo.mp4`
        try {
          await mixVoiceover(
            ffmpeg,
            outName,
            mixedName,
            voBlob,
            duration,
            // 环境音已在转码阶段调过音量，这里按 1 原样保留再与口播混合
            keepAmbient ? 1 : 0,
            input.voiceoverVolume ?? 1
          )
          try {
            await ffmpeg.deleteFile(outName)
          } catch {
            /* ignore */
          }
          outName = mixedName
          log(`[${i}] ✓ 已叠口播${keepAmbient ? '（保留环境音）' : ''}`)
        } catch (e) {
          log(`[${i}] 叠口播失败，保留原片段音频：${errorMessage(e)}`)
        }
      }

      let concatName = outName
      if (clip.transitionIn !== 'none' && clip.transitionDuration > 0) {
        const fadeName = `clip_${i}_fade.mp4`
        await applyTransition(
          ffmpeg,
          outName,
          fadeName,
          clip.transitionIn,
          clip.transitionDuration,
          duration
        )
        concatName = fadeName
      }
      concatLines.push(`file '${concatName}'`)

      if (input.burnCaptions) {
        const text = (input.voiceoverMap.get(clip.shotId) ?? '').trim()
        if (text) {
          cues.push({
            id: i + 1,
            start: cursor,
            end: cursor + duration,
            text
          })
        }
      }

      cursor += duration
    }

    if (concatLines.length === 0) {
      throw new Error('时间线上没有可导出的素材')
    }

    log(`✓ 准备 concat list:\n${concatLines.join('\n')}`)
    await writeFile(ffmpeg, 'list.txt', concatLines.join('\n'))

    const concatName = 'concated.mp4'
    input.onProgress?.('拼接片段...')
    await safeExec(
      ffmpeg,
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'list.txt',
        ...encodeArgs(concatName, true)
      ],
      '拼接'
    )
    log(`✓ concat 完成 → ${concatName}`)

    let finalName = concatName
    const captionCues = (
      input.captionCues && input.captionCues.length > 0
        ? input.captionCues
        : cues
    ).filter((c) => c.text.trim())
    if (input.burnCaptions && captionCues.length > 0) {
      input.onProgress?.(`烧录 ${captionCues.length} 条字幕...`)
      finalName = await burnCaptionsOverlay(
        ffmpeg,
        concatName,
        captionCues,
        input.captionStyle,
        width,
        height,
        !!input.captionBg,
        {
          enabled: !!input.captionHighlight,
          color: input.captionHighlightColor,
          scale: input.captionHighlightScale
        },
        input.onProgress
      )
      log(`✓ 字幕烧录完成（${captionCues.length} 条）`)
    } else if (input.burnCaptions) {
      log('已勾选烧录字幕，但没有任何字幕文本（分镜口播/SRT 为空）')
      input.onProgress?.('没有字幕文本，已跳过烧录')
    }

    if (input.bgm) {
      const bgmName = 'bgm.' + guessExt(input.bgm.type, 'audio')
      await writeFile(ffmpeg, bgmName, input.bgm)
      const withBGM = 'with_bgm.mp4'
      input.onProgress?.('铺整片背景音乐...')
      const speechVol = 1
      const bgmVol = input.bgmVolume ?? 0.22
      const fadeOut = Math.max(0, totalDur - 1.2)
      await safeExec(
        ffmpeg,
        [
          '-i',
          finalName,
          '-stream_loop',
          '-1',
          '-i',
          bgmName,
          '-filter_complex',
          `[0:a]volume=${speechVol}[a0];[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bgmVol},afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOut.toFixed(2)}:d=1.2[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[a]`,
          '-map',
          '0:v:0',
          '-map',
          '[a]',
          '-t',
          String(totalDur),
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '44100',
          '-ac',
          '2',
          '-y',
          withBGM
        ],
        '混合 BGM'
      )
      finalName = withBGM
    }

    const outName = `final.${format}`
    if (finalName !== outName) {
      input.onProgress?.(`转最终格式 ${format}...`)
      if (format === 'webm') {
        try {
          await safeExec(
            ffmpeg,
            [
              '-i',
              finalName,
              '-c:v',
              'libvpx-vp9',
              '-b:v',
              '1M',
              '-c:a',
              'libopus',
              '-y',
              outName
            ],
            `转 ${format}`
          )
        } catch {
          log('WebM/VP9 不可用，改为 MP4 并保留音轨')
          await safeExec(
            ffmpeg,
            ['-i', finalName, '-c', 'copy', '-y', 'final.mp4'],
            '转 MP4'
          )
          const data = await readFile(ffmpeg, 'final.mp4')
          return toBlob(data, 'video/mp4')
        }
      } else {
        await safeExec(ffmpeg, ['-i', finalName, '-c', 'copy', '-y', outName], '封装视频')
      }
    }

    const data = await readFile(ffmpeg, outName)
    const blob = toBlob(data, mimeType)
    log(`✓ 导出完成: ${(blob.size / 1024 / 1024).toFixed(2)} MB`)
    return blob
  } catch (e) {
    const ctx = `\n\n[最近 FFmpeg 日志]\n${recentLog.slice(-20).join('\n') || '(无)'}`
    throw wrapError(e, ctx)
  } finally {
    ffmpeg.off('log', logHandler)
    try {
      await clearFS(ffmpeg)
    } catch {
      /* ignore */
    }
  }
}

async function burnCaptionsOverlay(
  ffmpeg: Parameters<typeof writeFile>[0],
  videoName: string,
  cues: SubtitleCue[],
  style: CaptionStyle,
  width: number,
  height: number,
  captionBg: boolean,
  highlight: {
    enabled: boolean
    color?: string
    scale?: number
  },
  onProgress?: (msg: string) => void
): Promise<string> {
  const outName = 'with_caption.mp4'
  const layers: { file: string; start: number; end: number }[] = []

  for (let i = 0; i < cues.length; i++) {
    const text = cues[i].text.trim()
    if (!text) continue
    onProgress?.(`绘制字幕 ${layers.length + 1}/${cues.length}...`)
    const png = await renderCaptionPng(text, style, width, height, captionBg, highlight)
    if (!png.size) continue
    const file = `cap_${i}.png`
    await writeFile(ffmpeg, file, png)
    layers.push({ file, start: cues[i].start, end: cues[i].end })
  }

  if (layers.length === 0) {
    log('字幕 PNG 为空，跳过 overlay')
    return videoName
  }

  const filters: string[] = []
  let last = '0:v'
  layers.forEach((layer, i) => {
    const next = i === layers.length - 1 ? 'vcap' : `vc${i}`
    filters.push(
      `[${last}][${i + 1}:v]overlay=0:0:enable='between(t,${layer.start.toFixed(3)},${layer.end.toFixed(3)})'[${next}]`
    )
    last = next
  })
  filters.push(`[vcap]format=yuv420p[vout]`)

  onProgress?.('把字幕叠到视频上...')
  const overlayBase = [
    '-i',
    videoName,
    ...layers.flatMap((l) => ['-i', l.file]),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '0:a',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p'
  ]
  const copied = await execCode(ffmpeg, [...overlayBase, '-c:a', 'copy', '-y', outName])
  if (copied !== 0) {
    await safeExec(
      ffmpeg,
      [...overlayBase, '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-y', outName],
      '烧录字幕'
    )
  }
  return outName
}

function encodeArgs(outName: string, withAudio: boolean): string[] {
  const video = [
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p'
  ]
  if (!withAudio) return [...video, '-an', '-y', outName]
  return [
    ...video,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-ac',
    '2',
    '-y',
    outName
  ]
}

function atempoChain(speed: number): string {
  const parts: string[] = []
  let s = speed
  while (s > 2.0001) {
    parts.push('atempo=2.0')
    s /= 2
  }
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  parts.push(`atempo=${Math.max(0.5, Math.min(2, s)).toFixed(4)}`)
  return parts.join(',')
}

function audioFilter(_speed: number, _volume: number): string {
  return 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo'
}

/** 16-bit stereo PCM 静音 WAV，给没音轨的图片/视频补齐，concat 才不会丢声 */
function makeSilentWav(durationSec: number, sampleRate = 44100): Uint8Array {
  const numSamples = Math.max(1, Math.ceil(durationSec * sampleRate))
  const channels = 2
  const bytesPerSample = 2
  const dataSize = numSamples * channels * bytesPerSample
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  return new Uint8Array(buf)
}

async function execCode(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  args: string[]
): Promise<number> {
  try {
    const code = await ffmpeg.exec(args)
    return typeof code === 'number' ? code : 0
  } catch {
    return 1
  }
}

async function transcodeClip(
  ffmpeg: Parameters<typeof writeFile>[0],
  opts: {
    kind: 'video' | 'image'
    inName: string
    outName: string
    duration: number
    sourceIn: number
    fps: number
    videoFilter: string
    speed: number
    volume: number
    keepAmbient?: boolean
  }
) {
  const { kind, inName, outName, duration, sourceIn, fps, videoFilter, volume, keepAmbient } =
    opts

  if (kind === 'image') {
    await safeExec(
      ffmpeg,
      [
        '-loop',
        '1',
        '-framerate',
        String(fps),
        '-i',
        inName,
        '-i',
        'silence.wav',
        '-t',
        String(duration),
        '-shortest',
        '-vf',
        videoFilter,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        ...encodeArgs(outName, true)
      ],
      '图片转视频'
    )
    return
  }

  // 优先保留原片音轨中的环境音效（牛喝水、雨声等）；失败或不存在则静音
  if (keepAmbient && volume > 0.01) {
    log(`  尝试保留原片环境音（音量 ${volume.toFixed(2)}）`)
    const ambientName = outName.replace(/\.mp4$/, '') + '_amb.wav'
    let hasAmbient = false
    try {
      await safeExec(
        ffmpeg,
        [
          '-ss',
          String(sourceIn),
          '-i',
          inName,
          '-t',
          String(duration),
          '-vn',
          '-af',
          `volume=${volume},aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo`,
          '-ar',
          '44100',
          '-ac',
          '2',
          '-y',
          ambientName
        ],
        '提取环境音'
      )
      hasAmbient = true
    } catch (e) {
      log(`  原片无可用音轨，使用静音：${errorMessage(e)}`)
    }

    await safeExec(
      ffmpeg,
      [
        '-ss',
        String(sourceIn),
        '-i',
        inName,
        '-i',
        hasAmbient ? ambientName : 'silence.wav',
        '-t',
        String(duration),
        '-shortest',
        '-vf',
        videoFilter,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        ...encodeArgs(outName, true)
      ],
      hasAmbient ? '视频转码（保留环境音）' : '视频转码（静音）'
    )
    if (hasAmbient) {
      try {
        await ffmpeg.deleteFile(ambientName)
      } catch {
        /* ignore */
      }
    }
    return
  }

  log(`  使用静音轨（已关闭保留环境音）`)
  await safeExec(
    ffmpeg,
    [
      '-ss',
      String(sourceIn),
      '-i',
      inName,
      '-i',
      'silence.wav',
      '-t',
      String(duration),
      '-shortest',
      '-vf',
      videoFilter,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      ...encodeArgs(outName, true)
    ],
    '视频转码（静音）'
  )
}

function buildVideoFilter(
  width: number,
  height: number,
  fps: number,
  speed: number
): string {
  const speedFilter = speed === 1 ? '' : `setpts=${(1 / speed).toFixed(4)}*PTS,`
  return `${speedFilter}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},format=yuv420p`
}

async function safeExec(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  args: string[],
  stage: string
): Promise<void> {
  let code: unknown
  try {
    code = await ffmpeg.exec(args)
  } catch (e) {
    const cmd = ['ffmpeg', ...args].join(' ').slice(0, 400)
    throw new Error(`[${stage}] 失败：${errorMessage(e)}\n命令: ${cmd}`)
  }
  if (typeof code === 'number' && code !== 0) {
    const cmd = ['ffmpeg', ...args].join(' ').slice(0, 400)
    throw new Error(`[${stage}] FFmpeg 退出码 ${code}\n命令: ${cmd}`)
  }
}

async function applyTransition(
  ffmpeg: { exec: (args: string[]) => Promise<unknown> },
  input: string,
  output: string,
  type: TransitionType,
  duration: number,
  clipDuration: number
) {
  const fadeDur = Math.min(duration, Math.max(0.05, clipDuration / 3))
  const fadeOutStart = Math.max(0, clipDuration - fadeDur)
  if (type === 'fade' || type === 'fade-black' || type === 'slide-left' || type === 'slide-right') {
    const color = type === 'fade' ? 'black' : 'black'
    await safeExec(
      ffmpeg,
      [
        '-i',
        input,
        '-vf',
        `fade=t=in:st=0:d=${fadeDur}:color=${color},fade=t=out:st=${fadeOutStart}:d=${fadeDur}:color=${color}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-y',
        output
      ],
      '转场'
    )
  } else {
    await safeExec(ffmpeg, ['-i', input, '-c', 'copy', '-y', output], '转场')
  }
}

async function mixVoiceover(
  ffmpeg: Parameters<typeof writeFile>[0],
  videoName: string,
  outName: string,
  voBlob: Blob,
  duration: number,
  originalVolume: number,
  voiceVolume: number
) {
  const voExt = guessExt(voBlob.type, 'audio')
  const voName = videoName.replace(/\.[^.]+$/, '') + `_speech.${voExt}`
  await writeFile(ffmpeg, voName, voBlob)

  const speechDur = await blobDuration(voBlob)
  const voParts = [
    'aresample=44100',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    `volume=${voiceVolume}`
  ]
  if (speechDur && speechDur > duration * 1.06) {
    const tempo = Math.min(1.35, speechDur / duration)
    voParts.push(atempoChain(tempo))
  }
  voParts.push(`atrim=0:${duration.toFixed(3)}`, `apad=whole_dur=${duration.toFixed(3)}`)

  const filter =
    originalVolume < 0.01
      ? `[1:a]${voParts.join(',')}[a]`
      : `[0:a]volume=${originalVolume}[a0];[1:a]${voParts.join(',')}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[a]`

  await safeExec(
    ffmpeg,
    [
      '-i',
      videoName,
      '-i',
      voName,
      '-filter_complex',
      filter,
      '-map',
      '0:v:0',
      '-map',
      '[a]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-shortest',
      '-y',
      outName
    ],
    '叠口播'
  )
}

async function blobDuration(blob: Blob): Promise<number | null> {
  const url = URL.createObjectURL(blob)
  try {
    const el = document.createElement('audio')
    el.preload = 'metadata'
    el.src = url
    await new Promise<void>((resolve, reject) => {
      el.onloadedmetadata = () => resolve()
      el.onerror = () => reject(new Error('audio metadata'))
      setTimeout(() => reject(new Error('audio metadata timeout')), 8000)
    })
    return Number.isFinite(el.duration) ? el.duration : null
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

function guessExt(mime: string, kind?: 'video' | 'image' | 'audio'): string {
  const t = (mime || '').toLowerCase()
  if (t.includes('png')) return 'png'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('webp')) return 'webp'
  if (t.includes('gif')) return 'gif'
  if (t.includes('webm')) return 'webm'
  if (t.includes('mp4')) return 'mp4'
  if (t.includes('quicktime') || t.includes('mov')) return 'mov'
  if (t.includes('audio/mpeg') || t.includes('mp3')) return 'mp3'
  if (t.includes('wav')) return 'wav'
  if (kind === 'image') return 'png'
  if (kind === 'audio') return 'mp3'
  return 'mp4'
}
