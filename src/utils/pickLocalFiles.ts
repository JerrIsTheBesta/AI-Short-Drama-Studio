import { desktop, isDesktop } from '@/services/desktop'

export type LocalFileKind = 'image' | 'audio' | 'video' | 'media'

const ACCEPT: Record<LocalFileKind, string> = {
  image: 'image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp',
  audio: 'audio/*,.mp3,.wav,.m4a,.aac',
  video: 'video/*,.mp4,.mov,.webm,.mkv',
  media: 'image/*,video/*,audio/*,.png,.jpg,.jpeg,.webp,.mp4,.mp3,.wav'
}

function mimeFromName(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mkv') return 'video/x-matroska'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'm4a' || ext === 'aac') return 'audio/mp4'
  return 'application/octet-stream'
}

function htmlPick(kind: LocalFileKind, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = ACCEPT[kind]
    input.multiple = multiple
    input.hidden = true
    const done = (files: File[]) => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => done(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => done([]))
    document.body.appendChild(input)
    input.click()
    window.addEventListener(
      'focus',
      () => {
        window.setTimeout(() => {
          if (document.body.contains(input) && !input.files?.length) done([])
        }, 400)
      },
      { once: true }
    )
  })
}

/** 桌面端走系统文件框 + 主进程复制，避免杀毒拦截 Chromium 的 <input type=file>。 */
export async function pickLocalFiles(opts: {
  kind?: LocalFileKind
  multiple?: boolean
} = {}): Promise<File[]> {
  const kind = opts.kind ?? 'image'
  const multiple = opts.multiple !== false
  if (!isDesktop()) return htmlPick(kind, multiple)
  const items = await desktop().importLocalFiles({ kind, multiple })
  return items.map(
    (item) => new File([item.data], item.name, { type: item.mime || mimeFromName(item.name) })
  )
}
