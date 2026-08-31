/**
 * 按音量找出有效人声区间，切掉句首句尾气口和静音。
 * 数字人口播每段视频常在句末留一截没声音，不切的话拼起来会一顿一顿。
 */

import { getFFmpeg, writeFile, readFile, clearFS } from './client'
import type { TimelineClip } from '@/types'

export interface SpeechWindow {
  sourceIn: number
  duration: number
  mediaDuration: number
}

const LEAD_KEEP = 0.04
const TAIL_KEEP = 0.12
const MIN_KEEP = 0.7
const FRAME_SEC = 0.02

let ffmpegLock: Promise<unknown> = Promise.resolve()

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = ffmpegLock.then(fn, fn)
  ffmpegLock = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

export async function detectSpeechWindow(blob: Blob): Promise<SpeechWindow> {
  const pcm = await decodeMonoPcm(blob)
  return findAudibleWindow(pcm.samples, pcm.sampleRate)
}

export async function trimTimelineBySpeech(
  clips: TimelineClip[],
  getBlob: (shotId: string) => Promise<Blob | undefined>,
  cache = new Map<string, SpeechWindow>()
): Promise<TimelineClip[]> {
  let cursor = 0
  const next: TimelineClip[] = []
  for (const clip of clips) {
    if (!clip.enabled) {
      next.push(clip)
      continue
    }
    let win = cache.get(clip.shotId)
    if (!win) {
      const blob = await getBlob(clip.shotId)
      if (blob) {
        try {
          win = await detectSpeechWindow(blob)
          cache.set(clip.shotId, win)
        } catch {
          win = undefined
        }
      }
    }
    const duration = Math.max(MIN_KEEP, win?.duration ?? clip.duration)
    const sourceIn = win?.sourceIn ?? clip.sourceIn ?? 0
    next.push({
      ...clip,
      startTime: cursor,
      sourceIn,
      duration,
      transitionIn: 'none',
      transitionDuration: 0
    })
    cursor += duration
  }
  return next
}

async function decodeMonoPcm(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  try {
    const ctx = new AudioContext()
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
    const samples = mixToMono(buffer)
    const sampleRate = buffer.sampleRate
    await ctx.close().catch(() => undefined)
    if (samples.length > 80) return { samples, sampleRate }
  } catch {
    /* 有的 mp4 浏览器解不了，改走 FFmpeg */
  }
  return extractPcmWithFfmpeg(blob)
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels
  const length = buffer.length
  const out = new Float32Array(length)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) out[i] += data[i]
  }
  if (channels > 1) {
    for (let i = 0; i < length; i++) out[i] /= channels
  }
  return out
}

async function extractPcmWithFfmpeg(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  return runExclusive(async () => {
    const ffmpeg = await getFFmpeg()
    await clearFS(ffmpeg)
    const ext = (blob.type || '').includes('wav') ? 'wav' : (blob.type || '').includes('mp3') ? 'mp3' : 'mp4'
    await writeFile(ffmpeg, `speech_in.${ext}`, blob)
    const code = await ffmpeg.exec([
      '-i',
      `speech_in.${ext}`,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'f32le',
      '-y',
      'speech.pcm'
    ])
    if (typeof code === 'number' && code !== 0) {
      throw new Error('读取音轨失败，无法自动切气口')
    }
    const raw = await readFile(ffmpeg, 'speech.pcm')
    const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    return { samples, sampleRate: 16000 }
  })
}

function findAudibleWindow(samples: Float32Array, sampleRate: number): SpeechWindow {
  const mediaDuration = samples.length / sampleRate
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SEC))
  const energies: number[] = []
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0
    const end = Math.min(samples.length, i + frame)
    for (let j = i; j < end; j++) sum += samples[j] * samples[j]
    energies.push(Math.sqrt(sum / Math.max(1, end - i)))
  }
  if (!energies.length) {
    return { sourceIn: 0, duration: Math.max(MIN_KEEP, mediaDuration), mediaDuration }
  }

  const sorted = [...energies].sort((a, b) => a - b)
  const noise = sorted[Math.floor(sorted.length * 0.2)] || 0
  const peak = sorted[Math.floor(sorted.length * 0.92)] || sorted[sorted.length - 1] || 0
  const threshold = Math.max(peak * 0.1, noise * 3.2, 0.012)

  let first = -1
  let last = -1
  for (let i = 0; i < energies.length; i++) {
    if (energies[i] >= threshold) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0 || last < first) {
    return { sourceIn: 0, duration: Math.max(MIN_KEEP, mediaDuration), mediaDuration }
  }

  const sourceIn = Math.max(0, first * FRAME_SEC - LEAD_KEEP)
  const rawEnd = Math.min(mediaDuration, (last + 1) * FRAME_SEC + TAIL_KEEP)
  const duration = Math.max(MIN_KEEP, rawEnd - sourceIn)
  const clipped = Math.min(duration, Math.max(MIN_KEEP, mediaDuration - sourceIn))
  return {
    sourceIn: Number(sourceIn.toFixed(3)),
    duration: Number(clipped.toFixed(3)),
    mediaDuration
  }
}
