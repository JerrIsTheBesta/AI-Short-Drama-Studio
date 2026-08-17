export type DesktopAPI = {
  isDesktop: true
  getRoot: () => Promise<string>
  ensureProjectDir: (name: string, id: string) => Promise<string>
  listProjectDirs: () => Promise<string[]>
  readText: (filePath: string) => Promise<string>
  writeText: (filePath: string, text: string) => Promise<void>
  readBuffer: (filePath: string) => Promise<ArrayBuffer>
  writeBuffer: (filePath: string, data: ArrayBuffer) => Promise<void>
  exists: (filePath: string) => Promise<boolean>
  remove: (filePath: string) => Promise<void>
  join: (...parts: string[]) => Promise<string>
  pickFiles: (filters?: { name: string; extensions: string[] }[]) => Promise<string[]>
  pickDirectory: () => Promise<string | null>
  openPath: (filePath: string) => Promise<string>
}

declare global {
  interface Window {
    desktop?: DesktopAPI
  }
}

export function isDesktop(): boolean {
  return Boolean(window.desktop?.isDesktop)
}

export function desktop(): DesktopAPI {
  if (!window.desktop) throw new Error('当前不是桌面端')
  return window.desktop
}

export function assetFileUrl(absPath: string): string {
  return `aicuts://local/?path=${encodeURIComponent(absPath)}`
}

export async function blobFromPath(absPath: string): Promise<Blob> {
  if (isDesktop()) {
    const buf = await desktop().readBuffer(absPath)
    const ext = absPath.split('.').pop()?.toLowerCase()
    const mime =
      ext === 'png'
        ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'webp'
            ? 'image/webp'
            : ext === 'mp4'
              ? 'video/mp4'
              : ext === 'webm'
                ? 'video/webm'
                : ext === 'mp3'
                  ? 'audio/mpeg'
                  : ext === 'wav'
                    ? 'audio/wav'
                    : 'application/octet-stream'
    return new Blob([buf], { type: mime })
  }
  const res = await fetch(assetFileUrl(absPath))
  return res.blob()
}

export async function bufferFromBlob(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer()
}
