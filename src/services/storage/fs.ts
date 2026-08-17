/**
 * 桌面端本地文件夹存储
 *
 * Documents/AI-Cut/<project>/
 *   project.json
 *   assets/manifest.json
 *   assets/images|videos|audio/<id>.<ext>
 *   thumbs/<id>.jpg
 */

import { toRaw } from 'vue'
import type { Asset, Project } from '@/types'
import { desktop, isDesktop, blobFromPath, bufferFromBlob } from '@/services/desktop'

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value)))
}

function extOf(asset: Pick<Asset, 'kind' | 'mimeType' | 'filename'>): string {
  const fromName = asset.filename?.split('.').pop()?.toLowerCase()
  if (fromName && fromName.length <= 5) return fromName
  if (asset.mimeType.includes('png')) return 'png'
  if (asset.mimeType.includes('webp')) return 'webp'
  if (asset.mimeType.includes('jpeg') || asset.mimeType.includes('jpg')) return 'jpg'
  if (asset.mimeType.includes('webm')) return 'webm'
  if (asset.mimeType.includes('mp4')) return 'mp4'
  if (asset.mimeType.includes('wav')) return 'wav'
  if (asset.mimeType.includes('mpeg') || asset.mimeType.includes('mp3')) return 'mp3'
  return asset.kind === 'image' ? 'png' : asset.kind === 'video' ? 'mp4' : 'mp3'
}

function kindFolder(kind: Asset['kind']): string {
  return kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audio'
}

let activeDir: string | null = null
let assetCache: Asset[] = []

export function setActiveProjectDir(dir: string | null) {
  activeDir = dir
}

export function getActiveProjectDir(): string | null {
  return activeDir
}

async function manifestPath(dir: string) {
  return desktop().join(dir, 'assets', 'manifest.json')
}

async function loadManifest(dir: string): Promise<Asset[]> {
  const p = await manifestPath(dir)
  if (!(await desktop().exists(p))) return []
  try {
    const text = await desktop().readText(p)
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function saveManifest(dir: string, list: Asset[]) {
  const p = await manifestPath(dir)
  await desktop().writeText(p, JSON.stringify(toPlain(list), null, 2))
}

export async function saveProject(project: Project): Promise<void> {
  if (!isDesktop()) throw new Error('fs backend 仅桌面端')
  const dir = project.folderPath || activeDir
  if (!dir) throw new Error('项目没有文件夹路径')
  const jsonPath = await desktop().join(dir, 'project.json')
  const plain = toPlain(project)
  await desktop().writeText(jsonPath, JSON.stringify(plain, null, 2))
  activeDir = dir
}

export async function loadProject(id: string): Promise<Project | undefined> {
  const all = await listProjects()
  const hit = all.find((p) => p.id === id)
  if (!hit?.folderPath) return hit
  activeDir = hit.folderPath
  assetCache = await loadManifest(hit.folderPath)
  return hit
}

export async function loadProjectFromDir(dir: string): Promise<Project | undefined> {
  const jsonPath = await desktop().join(dir, 'project.json')
  if (!(await desktop().exists(jsonPath))) return undefined
  const text = await desktop().readText(jsonPath)
  const p = JSON.parse(text) as Project
  p.folderPath = dir
  activeDir = dir
  assetCache = await loadManifest(dir)
  return p
}

export async function listProjects(): Promise<Project[]> {
  if (!isDesktop()) return []
  const dirs = await desktop().listProjectDirs()
  const out: Project[] = []
  for (const dir of dirs) {
    try {
      const jsonPath = await desktop().join(dir, 'project.json')
      const text = await desktop().readText(jsonPath)
      const p = JSON.parse(text) as Project
      p.folderPath = dir
      out.push(p)
    } catch {
      /* skip broken */
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export async function deleteProject(id: string): Promise<void> {
  const all = await listProjects()
  const hit = all.find((p) => p.id === id)
  if (hit?.folderPath) await desktop().remove(hit.folderPath)
  if (activeDir === hit?.folderPath) {
    activeDir = null
    assetCache = []
  }
}

export async function saveAsset(asset: Asset, blob: Blob, thumbBlob?: Blob): Promise<void> {
  const dir = activeDir
  if (!dir) throw new Error('没有打开的项目目录，无法存素材')
  const ext = extOf(asset)
  const rel = `assets/${kindFolder(asset.kind)}/${asset.id}.${ext}`
  const abs = await desktop().join(dir, rel)
  await desktop().writeBuffer(abs, await bufferFromBlob(blob))
  const stored: Asset = { ...toPlain(asset), fileRelPath: rel }
  if (thumbBlob) {
    const tRel = `thumbs/${asset.id}.jpg`
    const tAbs = await desktop().join(dir, tRel)
    await desktop().writeBuffer(tAbs, await bufferFromBlob(thumbBlob))
  }
  const list = await loadManifest(dir)
  const idx = list.findIndex((a) => a.id === asset.id)
  if (idx >= 0) list[idx] = stored
  else list.unshift(stored)
  await saveManifest(dir, list)
  assetCache = list
}

export async function loadAssetBlob(id: string): Promise<Blob | undefined> {
  const dir = activeDir
  if (!dir) return undefined
  const list = assetCache.length ? assetCache : await loadManifest(dir)
  const meta = list.find((a) => a.id === id)
  if (!meta?.fileRelPath) return undefined
  const abs = await desktop().join(dir, meta.fileRelPath)
  if (!(await desktop().exists(abs))) return undefined
  return blobFromPath(abs)
}

export async function loadAsset(id: string): Promise<Asset | undefined> {
  const list = await listAssets()
  return list.find((a) => a.id === id)
}

export async function loadThumbBlob(id: string): Promise<Blob | undefined> {
  const dir = activeDir
  if (!dir) return undefined
  const abs = await desktop().join(dir, 'thumbs', `${id}.jpg`)
  if (!(await desktop().exists(abs))) return undefined
  return blobFromPath(abs)
}

export async function saveThumb(id: string, blob: Blob): Promise<void> {
  const dir = activeDir
  if (!dir) return
  const abs = await desktop().join(dir, 'thumbs', `${id}.jpg`)
  await desktop().writeBuffer(abs, await bufferFromBlob(blob))
}

export async function deleteAsset(id: string): Promise<void> {
  const dir = activeDir
  if (!dir) return
  const list = await loadManifest(dir)
  const meta = list.find((a) => a.id === id)
  if (meta?.fileRelPath) {
    const abs = await desktop().join(dir, meta.fileRelPath)
    await desktop().remove(abs)
  }
  const thumb = await desktop().join(dir, 'thumbs', `${id}.jpg`)
  await desktop().remove(thumb)
  const next = list.filter((a) => a.id !== id)
  await saveManifest(dir, next)
  assetCache = next
}

export async function listAssets(): Promise<Asset[]> {
  if (!activeDir) return []
  assetCache = await loadManifest(activeDir)
  return [...assetCache].sort((a, b) => b.createdAt - a.createdAt)
}

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  return { usage: 0, quota: 0 }
}

export async function assetAbsPath(id: string): Promise<string | undefined> {
  const dir = activeDir
  if (!dir) return undefined
  return assetAbsPathInDir(dir, id)
}

/** 不切换当前项目目录，按指定文件夹解析素材路径（首页封面用） */
export async function assetAbsPathInDir(
  dir: string,
  id: string
): Promise<string | undefined> {
  const list = await loadManifest(dir)
  const meta = list.find((a) => a.id === id)
  if (!meta?.fileRelPath) return undefined
  const abs = await desktop().join(dir, meta.fileRelPath)
  if (!(await desktop().exists(abs))) return undefined
  return abs
}
