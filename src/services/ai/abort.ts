export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
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
