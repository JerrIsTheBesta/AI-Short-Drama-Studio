/**
 * 存储门面：桌面端走本地文件夹，浏览器走 IndexedDB
 */

import { assetFileUrl, isDesktop } from '@/services/desktop'
import type { Asset, Project } from '@/types'
import * as idb from './idb'
import * as fsStore from './fs'
import * as library from './library'

export { setActiveProjectDir, getActiveProjectDir, loadProjectFromDir } from './fs'
export {
  listLibraryAssets,
  saveLibraryAsset,
  loadLibraryAssetBlob,
  loadLibraryThumbBlob,
  deleteLibraryAsset,
  libraryAssetAbsPath,
  listLibraryFolders,
  saveLibraryFolders,
  updateLibraryAssetMeta
} from './library'

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
  if (useFs()) {
    const blob = await fsStore.loadAssetBlob(id)
    if (blob) return blob
    return library.loadLibraryAssetBlob(id)
  }
  return idb.loadAssetBlob(id)
}

export async function loadAsset(id: string): Promise<Asset | undefined> {
  if (useFs()) {
    const hit = await fsStore.loadAsset(id)
    if (hit) return hit
    return (await library.listLibraryAssets()).find((a) => a.id === id)
  }
  return idb.loadAsset(id)
}

export async function loadThumbBlob(id: string): Promise<Blob | undefined> {
  if (useFs()) {
    const blob = await fsStore.loadThumbBlob(id)
    if (blob) return blob
    return library.loadLibraryThumbBlob(id)
  }
  return idb.loadThumbBlob(id)
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

export async function assetAbsPath(id: string): Promise<string | undefined> {
  if (!useFs()) return undefined
  const fromProject = await fsStore.assetAbsPath(id)
  if (fromProject) return fromProject
  return library.libraryAssetAbsPath(id)
}

/** 封面：一图生视频用节点出图；否则场景底板 → 人设 → 分镜配图 */
export function pickCoverAssetId(p: Project): string | undefined {
  if (p.pipelineMode === 'img2video') {
    return (p.canvas?.nodes ?? []).find((n) => n.data.outputAssetId)?.data.outputAssetId
  }
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
