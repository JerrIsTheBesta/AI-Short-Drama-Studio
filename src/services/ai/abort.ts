/** 写完整剧本 / 提炼节点：长 JSON 很容易超过 2 分钟 */
export const PLAY_LLM_TIMEOUT_MS = 480_000

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function errName(e: unknown) {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name?: string }).name || '') : ''
}

function errMessage(e: unknown) {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return String(e ?? '')
}

/** fetch 被 abort 时，Chrome 一律报 The user aborted a request，需靠 signal.reason 区分超时/取消 */
export function isAbortError(e: unknown): boolean {
  const name = errName(e)
  if (name === 'AbortError' || name === 'TimeoutError') return true
  return /aborted a request|operation was aborted|任务已取消|The user aborted/i.test(errMessage(e))
}

export function isTimeoutAbort(e: unknown, signal?: AbortSignal): boolean {
  const reason = signal?.reason
  if (errName(reason) === 'TimeoutError' || /请求超过/.test(errMessage(reason))) return true
  if (errName(e) === 'TimeoutError') return true
  return /请求超过|模型超过 \d+ 秒/.test(errMessage(e))
}

export function llmAbortError(e: unknown, signal?: AbortSignal, timeoutMs = 120_000): Error {
  if (isTimeoutAbort(e, signal)) {
    const sec = Math.max(1, Math.round(timeoutMs / 1000))
    return new Error(`模型超过 ${sec} 秒还没写完。长剧本很常见，请再点一次生成。`)
  }
  if (signal?.aborted || isAbortError(e)) {
    return new DOMException('任务已取消', 'AbortError')
  }
  return e instanceof Error ? e : new Error(errMessage(e))
}

export function friendlyAiError(e: unknown): string {
  if (isAbortError(e) && !isTimeoutAbort(e)) return '已取消'
  return errMessage(e) || '生成失败'
}

export function shouldToastAiError(e: unknown): boolean {
  return !(isAbortError(e) && !isTimeoutAbort(e))
}

export function controlledSignal(parent?: AbortSignal, timeoutMs = 120_000) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason ?? new DOMException('任务已取消', 'AbortError'))
  parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException(`请求超过 ${Math.round(timeoutMs / 1000)} 秒`, 'TimeoutError')),
    timeoutMs
  )
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    }
  }
}

export function abortableDelay(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal)
  let abortHandler: (() => void) | undefined
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    abortHandler = () => {
      clearTimeout(timer)
      reject(new DOMException('任务已取消', 'AbortError'))
    }
    signal?.addEventListener('abort', abortHandler, { once: true })
  }).finally(() => {
    if (abortHandler) signal?.removeEventListener('abort', abortHandler)
  })
}
