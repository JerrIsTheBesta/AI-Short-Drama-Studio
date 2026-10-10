/**
 * 公共资产库：跨项目共享图片
 * 桌面端：用户所选保存目录/_library/
 * 浏览器：IndexedDB assets（library: true）
 */

import { toRaw } from 'vue'
import type { Asset, LibraryFolder } from '@/types'
import { desktop, isDesktop, blobFromPath, bufferFromBlob } from '@/services/desktop'
import * as idb from './idb'

const LIBRARY_FOLDER = '_library'
const FOLDERS_FILE = 'folders.json'
const FOLDERS_LS_KEY = 'ai-cut:library-folders'

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value)))
}

function extOf(asset: Pick<Asset, 'kind' | 'mimeType' | 'filename'>): string {
  const fromName = asset.filename?.split('.').pop()?.toLowerCase()
  if (fromName && fromName.length <= 5) return fromName
  if (asset.mimeType.includes('png')) return 'png'
  if (asset.mimeType.includes('webp')) return 'webp'
  if (asset.mimeType.includes('jpeg') || asset.mimeType.includes('jpg')) return 'jpg'
  return 'png'
}

async function libraryDir(): Promise<string> {
  const root = await desktop().getRoot()
  return desktop().join(root, LIBRARY_FOLDER)
}

async function ensureLibraryDirs(dir: string) {
  await desktop().writeText(await desktop().join(dir, 'assets', 'images', '.keep'), '')
  await desktop().writeText(await desktop().join(dir, 'thumbs', '.keep'), '')
}

async function manifestPath(dir: string) {
  return desktop().join(dir, 'assets', 'manifest.json')
}

async function loadManifest(dir: string): Promise<Asset[]> {
  const p = await manifestPath(dir)
  if (!(await desktop().exists(p))) return []
  try {
    const parsed = JSON.parse(await desktop().readText(p))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function saveManifest(dir: string, list: Asset[]) {
  await desktop().writeText(await manifestPath(dir), JSON.stringify(toPlain(list), null, 2))
}

export async function listLibraryAssets(): Promise<Asset[]> {
  if (!isDesktop()) return idb.listLibraryAssets()
  const dir = await libraryDir()
  const list = await loadManifest(dir)
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveLibraryAsset(asset: Asset, blob: Blob, thumbBlob?: Blob): Promise<void> {
  const stored: Asset = { ...toPlain(asset), library: true }
  if (!isDesktop()) {
    await idb.saveAsset(stored, blob, thumbBlob)
    return
  }
  const dir = await libraryDir()
  await ensureLibraryDirs(dir)
  const ext = extOf(stored)
  const rel = `assets/images/${stored.id}.${ext}`
  const abs = await desktop().join(dir, rel)
  await desktop().writeBuffer(abs, await bufferFromBlob(blob))
  stored.fileRelPath = rel
  if (thumbBlob) {
    const tAbs = await desktop().join(dir, 'thumbs', `${stored.id}.jpg`)
    await desktop().writeBuffer(tAbs, await bufferFromBlob(thumbBlob))
  }
  const list = await loadManifest(dir)
  const idx = list.findIndex((a) => a.id === stored.id)
  if (idx >= 0) list[idx] = stored
  else list.unshift(stored)
  await saveManifest(dir, list)
}

export async function loadLibraryAssetBlob(id: string): Promise<Blob | undefined> {
  if (!isDesktop()) return idb.loadAssetBlob(id)
  const dir = await libraryDir()
  const meta = (await loadManifest(dir)).find((a) => a.id === id)
  if (!meta?.fileRelPath) return undefined
  const abs = await desktop().join(dir, meta.fileRelPath)
  if (!(await desktop().exists(abs))) return undefined
  return blobFromPath(abs)
}

export async function loadLibraryThumbBlob(id: string): Promise<Blob | undefined> {
  if (!isDesktop()) return idb.loadThumbBlob(id)
  const dir = await libraryDir()
  const abs = await desktop().join(dir, 'thumbs', `${id}.jpg`)
  if (!(await desktop().exists(abs))) return undefined
  return blobFromPath(abs)
}

export async function libraryAssetAbsPath(id: string): Promise<string | undefined> {
  if (!isDesktop()) return undefined
  const dir = await libraryDir()
  const meta = (await loadManifest(dir)).find((a) => a.id === id)
  if (!meta?.fileRelPath) return undefined
  const abs = await desktop().join(dir, meta.fileRelPath)
  if (!(await desktop().exists(abs))) return undefined
  return abs
}

export async function deleteLibraryAsset(id: string): Promise<void> {
  if (!isDesktop()) {
    await idb.deleteAsset(id)
    return
  }
  const dir = await libraryDir()
  const list = await loadManifest(dir)
  const meta = list.find((a) => a.id === id)
  if (meta?.fileRelPath) {
    await desktop().remove(await desktop().join(dir, meta.fileRelPath))
  }
  await desktop().remove(await desktop().join(dir, 'thumbs', `${id}.jpg`))
  await saveManifest(
    dir,
    list.filter((a) => a.id !== id)
  )
}

export async function listLibraryFolders(): Promise<LibraryFolder[]> {
  if (!isDesktop()) {
    try {
      const raw = localStorage.getItem(FOLDERS_LS_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const dir = await libraryDir()
  const p = await desktop().join(dir, FOLDERS_FILE)
  if (!(await desktop().exists(p))) return []
  try {
    const parsed = JSON.parse(await desktop().readText(p))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveLibraryFolders(folders: LibraryFolder[]): Promise<void> {
  const plain = toPlain(folders)
  if (!isDesktop()) {
    localStorage.setItem(FOLDERS_LS_KEY, JSON.stringify(plain))
    return
  }
  const dir = await libraryDir()
  await ensureLibraryDirs(dir)
  await desktop().writeText(await desktop().join(dir, FOLDERS_FILE), JSON.stringify(plain, null, 2))
}

/** 更新公共库素材元数据（分类文件夹等），不改二进制文件 */
export async function updateLibraryAssetMeta(
  id: string,
  patch: { folderId?: string | null; filename?: string }
): Promise<Asset | undefined> {
  const folderId =
    patch.folderId === null || patch.folderId === '' ? undefined : patch.folderId

  if (!isDesktop()) {
    const data = await idb.get<Asset & { blob?: Blob }>('assets', id)
    if (!data) return undefined
    const { blob, ...meta } = data
    const next = { ...(meta as Asset) }
    if (patch.filename) next.filename = patch.filename
    if ('folderId' in patch) {
      if (folderId === undefined) delete next.folderId
      else next.folderId = folderId
    }
    await idb.put('assets', blob ? { ...toPlain(next), blob } : toPlain(next))
    return next
  }

  const dir = await libraryDir()
  const list = await loadManifest(dir)
  const idx = list.findIndex((a) => a.id === id)
  if (idx < 0) return undefined
  const next = { ...list[idx] }
  if (patch.filename) next.filename = patch.filename
  if ('folderId' in patch) {
    if (folderId === undefined) delete next.folderId
    else next.folderId = folderId
  }
  list[idx] = next
  await saveManifest(dir, list)
  return next
}
