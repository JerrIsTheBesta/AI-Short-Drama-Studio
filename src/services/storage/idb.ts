/**
 * IndexedDB 存储 —— 项目和素材都放这里
 *
 * 三个 store：
 * - projects : 项目元数据（不含大文件）
 * - assets   : 素材二进制（按 ID 存 blob）
 * - thumbs   : 缩略图
 */

import { toRaw } from 'vue'
import type { Asset, Project } from '@/types'

/** IndexedDB structured clone 不能稳定处理 Vue Proxy，入库前先打成纯对象 */
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value)))
}

const DB_NAME = 'ai-cut-db'
const DB_VERSION = 1

export type StoreName = 'projects' | 'assets' | 'thumbs'

let _db: IDBDatabase | null = null

export function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('thumbs')) {
        db.createObjectStore('thumbs', { keyPath: 'id' })
      }
    }
    req.onsuccess = () => {
      _db = req.result
      resolve(_db)
    }
    req.onerror = () => reject(req.error)
  })
}

export async function put<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value as any)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function get<T>(store: StoreName, id: string): Promise<T | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(id)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function del(store: StoreName, id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function list<T>(store: StoreName): Promise<T[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

// ============== 高层封装 ==============

export async function saveProject(project: Project): Promise<void> {
  await put('projects', toPlain(project))
}

export async function loadProject(id: string): Promise<Project | undefined> {
  return get<Project>('projects', id)
}

export async function listProjects(): Promise<Project[]> {
  const all = await list<Project>('projects')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteProject(id: string): Promise<void> {
  await del('projects', id)
}

/** 存素材 */
export async function saveAsset(
  asset: Asset,
  blob: Blob,
  thumbBlob?: Blob
): Promise<void> {
  await put('assets', { ...toPlain(asset), blob })
  if (thumbBlob) {
    await put('thumbs', { id: asset.id, blob: thumbBlob })
  }
}

export async function loadAssetBlob(id: string): Promise<Blob | undefined> {
  const data = await get<{ blob: Blob }>('assets', id)
  return data?.blob
}

export async function loadAsset(id: string): Promise<Asset | undefined> {
  return get<Asset>('assets', id)
}

export async function loadThumbBlob(id: string): Promise<Blob | undefined> {
  const data = await get<{ blob: Blob }>('thumbs', id)
  return data?.blob
}

export async function saveThumb(id: string, blob: Blob): Promise<void> {
  await put('thumbs', { id, blob })
}

export async function deleteAsset(id: string): Promise<void> {
  await del('assets', id)
  await del('thumbs', id)
}

export async function listAssets(): Promise<Asset[]> {
  const all = await list<Asset>('assets')
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

/** 估算存储用量 */
export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate()
    return {
      usage: e.usage ?? 0,
      quota: e.quota ?? 0
    }
  }
  return { usage: 0, quota: 0 }
}
