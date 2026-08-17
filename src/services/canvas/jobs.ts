import { ref } from 'vue'

/** 正在生成的画布节点。各节点互不影响，可同时点。 */
export const runningNodeIds = ref<string[]>([])

export function isNodeRunning(id: string) {
  return runningNodeIds.value.includes(id)
}

export async function withNodeJob<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (runningNodeIds.value.includes(id)) {
    throw new Error('这个节点正在生成')
  }
  runningNodeIds.value = [...runningNodeIds.value, id]
  try {
    return await fn()
  } finally {
    runningNodeIds.value = runningNodeIds.value.filter((x) => x !== id)
  }
}

export async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (!items.length) return
  const queue = [...items]
  const n = Math.min(Math.max(1, limit), queue.length)
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        const item = queue.shift()
        if (item === undefined) break
        try {
          await fn(item)
        } catch {
          /* 单个失败不影响其它 */
        }
      }
    })
  )
}
