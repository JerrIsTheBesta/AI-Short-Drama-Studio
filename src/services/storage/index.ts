/**
 * 存储门面：桌面端走本地文件夹，浏览器走 IndexedDB
 */

import { assetFileUrl, isDesktop } from '@/services/desktop'
import type { Asset, Project } from '@/types'
import * as idb from './idb'
import * as fsStore from './fs'

export { setActiveProjectDir, getActiveProjectDir, loadProjectFromDir, assetAbsPath } from './fs'

function useFs() {
  return isDesktop()
}

export async function saveProject(project: Project): Promise<void> {
  return useFs() ? fsStore.saveProject(project) : idb.saveProject(project)
}

export async function loadProject(id: string): Promise<Project | undefined> {
  return useFs() ? fsStore.loadProject(id) : idb.loadProject(id)
}

export async function listProjects(): Promise<Project[]> {
  return useFs() ? fsStore.listProjects() : idb.listProjects()
}

export async function deleteProject(id: string): Promise<void> {
  return useFs() ? fsStore.deleteProject(id) : idb.deleteProject(id)
}

export async function saveAsset(
  asset: Asset,
  blob: Blob,
  thumbBlob?: Blob
): Promise<void> {
  return useFs()
    ? fsStore.saveAsset(asset, blob, thumbBlob)
    : idb.saveAsset(asset, blob, thumbBlob)
}

export async function loadAssetBlob(id: string): Promise<Blob | undefined> {
  return useFs() ? fsStore.loadAssetBlob(id) : idb.loadAssetBlob(id)
}

export async function loadAsset(id: string): Promise<Asset | undefined> {
  return useFs() ? fsStore.loadAsset(id) : idb.loadAsset(id)
}

export async function loadThumbBlob(id: string): Promise<Blob | undefined> {
  return useFs() ? fsStore.loadThumbBlob(id) : idb.loadThumbBlob(id)
}

export async function saveThumb(id: string, blob: Blob): Promise<void> {
  return useFs() ? fsStore.saveThumb(id, blob) : idb.saveThumb(id, blob)
}

export async function deleteAsset(id: string): Promise<void> {
  return useFs() ? fsStore.deleteAsset(id) : idb.deleteAsset(id)
}

export async function listAssets(): Promise<Asset[]> {
  return useFs() ? fsStore.listAssets() : idb.listAssets()
}

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  return useFs() ? fsStore.estimateStorage() : idb.estimateStorage()
}

/** 封面：第一张场景底板 → 第一张人设图 → 第一张分镜配图 */
export function pickCoverAssetId(p: Project): string | undefined {
  const plate = (p.scenes ?? []).find((s) => s.plateAssetId)?.plateAssetId
  if (plate) return plate
  const sheet = (p.subjects ?? []).find((s) => s.designSheetAssetId)?.designSheetAssetId
  if (sheet) return sheet
  return p.shots.find((s) => s.imageAssetId)?.imageAssetId
}

export async function projectCoverUrl(p: Project): Promise<string | undefined> {
  const id = pickCoverAssetId(p)
  if (!id) return undefined
  if (useFs() && p.folderPath) {
    const abs = await fsStore.assetAbsPathInDir(p.folderPath, id)
    return abs ? assetFileUrl(abs) : undefined
  }
  const blob = await idb.loadAssetBlob(id)
  if (!blob) return undefined
  return URL.createObjectURL(blob)
}
