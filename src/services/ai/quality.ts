import { throwIfAborted } from './abort'

export interface QualityReport {
  passed: boolean
  score: number
  issues: string[]
  retryHint?: string
}

/**
 * 图片生成后只做文件级校验。
 *
 * 人物身份、动作、构图和画风等主观判断交给用户，不再调用视觉模型，
 * 也不会因为 AI 质检意见自动中止流水线或触发重试。
 */
export async function reviewImageQuality(
  blob: Blob,
  _expected: string,
  signal?: AbortSignal
): Promise<QualityReport> {
  throwIfAborted(signal)
  if (blob.size < 8_000 || !(blob.type || '').startsWith('image/')) {
    return { passed: false, score: 0, issues: ['返回文件不是有效图片或文件过小'] }
  }
  return { passed: true, score: 100, issues: [] }
}

/** 视频同样只校验输出文件，不再抽帧并交给视觉模型评价。 */
export async function reviewVideoQuality(
  blob: Blob,
  _expected: string,
  signal?: AbortSignal
): Promise<QualityReport> {
  throwIfAborted(signal)
  if (blob.size < 24_000 || !(blob.type || '').startsWith('video/')) {
    return { passed: false, score: 0, issues: ['返回文件不是有效视频或文件过小'] }
  }
  return { passed: true, score: 100, issues: [] }
}

export async function reviewSpeechQuality(
  blob: Blob,
  text: string,
  targetDuration: number
): Promise<QualityReport> {
  if (blob.size < 1_000 || !(blob.type || '').startsWith('audio/')) {
    return { passed: false, score: 0, issues: ['TTS 返回的不是有效音频'] }
  }
  const spokenChars = text.replace(/[\s，。！？、,.!?；;]/g, '').length
  const estimated = spokenChars / 4
  if (estimated > targetDuration + 1.5) {
    return {
      passed: false,
      score: 45,
      issues: [`${spokenChars} 字口播预计需要 ${estimated.toFixed(1)} 秒，超过镜头 ${targetDuration} 秒`],
      retryHint: '缩短口播或延长镜头，不要强行加快语速'
    }
  }
  return { passed: true, score: 80, issues: [] }
}
