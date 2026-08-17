/**
 * 素材 store
 *
 * 维护：素材元数据 + 运行时 blob URL 缓存
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  saveAsset,
  loadAssetBlob,
  listAssets,
  deleteAsset,
  loadThumbBlob,
  saveThumb,
  assetAbsPath
} from '@/services/storage'
import { isDesktop, assetFileUrl } from '@/services/desktop'
import {
  probeMedia,
  extractVideoThumbnail,
  playableMediaBlob,
  isMostlyDarkImage
} from '@/services/ffmpeg'
import type { Asset, ID } from '@/types'

export const useAssetsStore = defineStore('assets', () => {
  const all = ref<Asset[]>([])
  const urlCache = new Map<ID, string>()
  const thumbCache = new Map<ID, string>()

  const images = computed(() => all.value.filter((a) => a.kind === 'image'))
  const videos = computed(() => all.value.filter((a) => a.kind === 'video'))

  /** 刷新列表 */
  async function refresh() {
    all.value = await listAssets()
  }

  /** 添加素材（AI 生成或上传） */
  async function add(
    blob: Blob,
    kind: Asset['kind'],
    source: Asset['source'],
    options: {
      filename?: string
      prompt?: string
      projectId?: string
      shotId?: string
    } = {}
  ): Promise<Asset> {
    const typed = playableMediaBlob(blob, kind)
    const info = await probeMedia(typed)
    const id = `${kind}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`
    const base = {
      id,
      kind,
      mimeType: typed.type || guessMime(kind),
      filename: options.filename ?? `${kind}_${id}`,
      size: typed.size,
      createdAt: Date.now(),
      source,
      prompt: options.prompt,
      projectId: options.projectId,
      shotId: options.shotId
    }
    let asset: Asset
    let thumbBlob: Blob | undefined
    if (kind === 'image') {
      asset = { ...base, kind: 'image', width: info.width, height: info.height }
    } else if (kind === 'video') {
      thumbBlob = await extractVideoThumbnail(typed).catch(() => undefined)
      asset = {
        ...base,
        kind: 'video',
        width: info.width,
        height: info.height,
        duration: info.duration ?? 0,
        fps: 30,
        hasAudio: info.hasAudio ?? false
      }
    } else {
      asset = { ...base, kind: 'audio', duration: info.duration ?? 0 }
    }
    await saveAsset(asset, typed, thumbBlob)
    await refresh()
    return asset
  }

  function guessMime(kind: Asset['kind']): string {
    return kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg'
  }

  /** 获取播放 URL。视频/音频走完整 blob，避免自定义协议不支持 Range 时只播前半段。 */
  async function getUrl(id: ID): Promise<string | undefined> {
    const meta = all.value.find((a) => a.id === id)
    const asBlob =
      meta?.kind === 'video' ||
      meta?.kind === 'audio' ||
      id.startsWith('video_') ||
      id.startsWith('audio_')
    const cached = urlCache.get(id)
    if (cached && !(asBlob && cached.startsWith('aicuts:'))) return cached
    if (cached) urlCache.delete(id)
    if (isDesktop() && !asBlob) {
      const abs = await assetAbsPath(id)
      if (abs) {
        const url = assetFileUrl(abs)
        urlCache.set(id, url)
        return url
      }
    }
    const blob = await loadAssetBlob(id)
    if (!blob) return undefined
    const typed = playableMediaBlob(blob, meta?.kind, meta?.mimeType)
    const url = URL.createObjectURL(typed)
    urlCache.set(id, url)
    return url
  }

  /** 获取缩略图 URL */
  async function getThumbUrl(id: ID): Promise<string | undefined> {
    if (thumbCache.has(id)) return thumbCache.get(id)
    const blob = await loadThumbBlob(id)
    if (!blob) return undefined
    const url = URL.createObjectURL(blob)
    thumbCache.set(id, url)
    return url
  }

  /** 没有封面、或封面是黑场，就现场截一帧存起来 */
  async function ensureThumb(id: ID): Promise<string | undefined> {
    const stored = await loadThumbBlob(id)
    if (stored && stored.size >= 80) {
      const dark = await isMostlyDarkImage(stored).catch(() => false)
      if (!dark) {
        if (thumbCache.has(id)) return thumbCache.get(id)
        const url = URL.createObjectURL(stored)
        thumbCache.set(id, url)
        return url
      }
      if (thumbCache.has(id)) {
        URL.revokeObjectURL(thumbCache.get(id)!)
        thumbCache.delete(id)
      }
    }
    const blob = await loadAssetBlob(id)
    if (!blob) return undefined
    const thumb = await extractVideoThumbnail(blob).catch(() => undefined)
    if (!thumb || thumb.size < 80) return undefined
    await saveThumb(id, thumb)
    if (thumbCache.has(id)) URL.revokeObjectURL(thumbCache.get(id)!)
    const url = URL.createObjectURL(thumb)
    thumbCache.set(id, url)
    return url
  }

  /** 直接拿 blob（用于 FFmpeg 处理） */
  async function getBlob(id: ID): Promise<Blob | undefined> {
    return loadAssetBlob(id)
  }

  /** 同步获取元数据（已加载的列表里） */
  function getMeta(id: ID): Asset | undefined {
    return all.value.find((a) => a.id === id)
  }

  async function remove(id: ID) {
    await deleteAsset(id)
    if (urlCache.has(id) && urlCache.get(id)!.startsWith('blob:')) {
      URL.revokeObjectURL(urlCache.get(id)!)
    }
    urlCache.delete(id)
    if (thumbCache.has(id) && thumbCache.get(id)!.startsWith('blob:')) {
      URL.revokeObjectURL(thumbCache.get(id)!)
    }
    thumbCache.delete(id)
    await refresh()
  }

  /** 释放所有 URL */
  function cleanup() {
    for (const url of urlCache.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    }
    for (const url of thumbCache.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url)
    }
    urlCache.clear()
    thumbCache.clear()
  }

  return {
    all,
    images,
    videos,
    refresh,
    add,
    getUrl,
    getThumbUrl,
    ensureThumb,
    getBlob,
    getMeta,
    remove,
    cleanup
  }
})
