import { desktop, isDesktop } from '@/services/desktop'

/** 选一份剧本文件（.md / .markdown / .txt）。取消选择时返回 null。 */
export async function pickPlayMarkdownFile(): Promise<{ text: string; filename: string } | null> {
  if (isDesktop()) {
    const paths = await desktop().pickFiles([
      { name: 'Markdown 剧本', extensions: ['md', 'markdown', 'txt'] }
    ])
    const path = paths[0]
    if (!path) return null
    return { text: await desktop().readText(path), filename: path.split(/[\\/]/).pop() || '' }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      resolve({ text: await file.text(), filename: file.name })
    }
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
