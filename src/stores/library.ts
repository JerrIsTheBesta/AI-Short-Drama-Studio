import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  listLibraryAssets,
  saveLibraryAsset,
  loadLibraryAssetBlob,
  deleteLibraryAsset,
  loadAssetBlob
} from '@/services/storage'
import { isDesktop, assetFileUrl } from '@/services/desktop'
import { libraryAssetAbsPath } from '@/services/storage'
import { probeMedia, ensurePlayableBlob } from '@/services/ffmpeg'
import type { Asset, ID } from '@/types'

export const useLibraryStore = defineStore('library', () => {
  const all = ref<Asset[]>([])
  const urlCache = new Map<ID, string>()

  async function refresh() {
    all.value = await listLibraryAssets()
  }

  async function add(
    blob: Blob,
    source: Asset['source'],
    options: { filename?: string; prompt?: string } = {}
  ): Promise<Asset> {
    const typed = await ensurePlayableBlob(blob, 'image')
    const info = await probeMedia(typed)
    const id = `image_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const asset: Asset = {
      id,
      kind: 'image',
      mimeType: typed.type || 'image/png',
      filename: options.filename ?? `library_${id}`,
      size: typed.size,
      createdAt: Date.now(),
      source,
      prompt: options.prompt,
      library: true,
      width: info.width,
      height: info.height
    }
    await saveLibraryAsset(asset, typed)
    await refresh()
    return asset
  }

  async function publishFrom(
    assetId: ID,
    meta?: { filename?: string; prompt?: string }
  ): Promise<Asset> {
    const blob = await loadAssetBlob(assetId)
    if (!blob) throw new Error('读不到这张图')
    return add(blob, 'ai-generated', {
      filename: meta?.filename,
      prompt: meta?.prompt
    })
  }

  async function getUrl(id: ID): Promise<string | undefined> {
    const cached = urlCache.get(id)
    if (cached) return cached
    if (isDesktop()) {
      const abs = await libraryAssetAbsPath(id)
      if (abs) {
        const url = assetFileUrl(abs)
        urlCache.set(id, url)
        return url
      }
    }
    const blob = await loadLibraryAssetBlob(id)
    if (!blob) return undefined
    const url = URL.createObjectURL(blob)
    urlCache.set(id, url)
    return url
  }

  async function getBlob(id: ID): Promise<Blob | undefined> {
    return loadLibraryAssetBlob(id)
  }

  function getMeta(id: ID): Asset | undefined {
    return all.value.find((a) => a.id === id)
  }

  async function remove(id: ID) {
    await deleteLibraryAsset(id)
    const url = urlCache.get(id)
    if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    urlCache.delete(id)
    await refresh()
  }

  return { all, refresh, add, publishFrom, getUrl, getBlob, getMeta, remove }
})
