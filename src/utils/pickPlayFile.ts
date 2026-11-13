import { desktop, isDesktop } from '@/services/desktop'
import { SCRIPT_PICK_ACCEPT, SCRIPT_PICK_FILTERS, scriptTextFromBytes } from '@/utils/scriptFileImport'

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

/** 导入剧本：Markdown、TXT、README、Word。取消选择时返回 null。 */
export async function pickScriptFile(): Promise<{ text: string; filename: string } | null> {
  if (isDesktop()) {
    const paths = await desktop().pickFiles(SCRIPT_PICK_FILTERS)
    const path = paths[0]
    if (!path) return null
    const filename = path.split(/[\\/]/).pop() || ''
    const bytes = new Uint8Array(await desktop().readBuffer(path))
    return { text: await scriptTextFromBytes(filename, bytes), filename }
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = SCRIPT_PICK_ACCEPT
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      try {
        resolve({
          text: await scriptTextFromBytes(file.name, new Uint8Array(await file.arrayBuffer())),
          filename: file.name
        })
      } catch (error) {
        reject(error)
      }
    }
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
