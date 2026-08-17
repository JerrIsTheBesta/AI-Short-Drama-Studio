/**
 * 视频拼接（concat）
 *
 * 用法：先把每个片段转成统一规格（编码、分辨率、帧率），再 concat。
 */

import { getFFmpeg, writeFile, readFile, toBlob } from './client'

export interface ConcatSegment {
  /** 输入 blob */
  blob: Blob
  /** 从素材的哪个时间点开始裁（秒） */
  sourceIn: number
  /** 用多久（秒） */
  duration: number
  /** 速度倍率 */
  speed?: number
  /** 是否禁用 */
  enabled?: boolean
}

export interface ConcatOptions {
  width: number
  height: number
  fps: number
  /** 输出格式 */
  format?: 'mp4' | 'webm'
  /** 输出 mime */
  mimeType?: string
  onProgress?: (msg: string) => void
}

/**
 * 把多个片段拼成一个视频
 * - 每个片段单独裁剪、转码、统一规格
 * - 用 concat demuxer 拼
 */
export async function concatVideos(
  segments: ConcatSegment[],
  opts: ConcatOptions
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(opts.onProgress)
  const format = opts.format ?? 'mp4'
  const mimeType = opts.mimeType ?? `video/${format}`

  const active = segments.filter((s) => s.enabled !== false && s.duration > 0)
  if (active.length === 0) {
    throw new Error('没有可拼接的片段')
  }

  // 1) 每个片段转成统一规格
  const listPath = 'list.txt'
  const lines: string[] = []
  for (let i = 0; i < active.length; i++) {
    const seg = active[i]
    const inName = `in_${i}.${guessExt(seg.blob.type)}`
    const outName = `seg_${i}.mp4`
    await writeFile(ffmpeg, inName, seg.blob)

    const speed = seg.speed ?? 1
    const speedFilter = speed === 1 ? '' : `setpts=${(1 / speed).toFixed(4)}*PTS,`
    const audioFilter =
      speed === 1
        ? 'anull'
        : `asetpts=${(1 / speed).toFixed(4)}*PTS,atempo=${speed}`

    const args = [
      '-ss',
      String(seg.sourceIn),
      '-i',
      inName,
      '-t',
      String(seg.duration),
      '-vf',
      `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:black,fps=${opts.fps},format=yuv420p,${speedFilter}`.replace(
        /,$/,
        ''
      ),
      '-af',
      audioFilter,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '44100',
      '-movflags',
      '+faststart',
      '-y',
      outName
    ]
    await ffmpeg.exec(args)
    lines.push(`file '${outName}'`)
  }

  await ffmpeg.writeFile(listPath, lines.join('\n'))

  // 2) 拼接
  const outName = `out.${format}`
  await ffmpeg.exec([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-y',
    outName
  ])

  const data = await readFile(ffmpeg, outName)
  return toBlob(data as Uint8Array, mimeType)
}

function guessExt(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('quicktime')) return 'mov'
  return 'mp4'
}
