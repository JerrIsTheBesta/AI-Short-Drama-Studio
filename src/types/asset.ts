/**
 * 素材（图片 / 视频 / 音频）
 * - id         : 唯一 ID
 * - kind       : 类型
 * - mimeType   : MIME
 * - blob       : 二进制（IndexedDB 存）
 * - url        : 运行时 blob URL（从 blob 派生，不持久化）
 * - meta       : 宽高、时长、大小
 */

import type { ID } from './project'

export type AssetKind = 'image' | 'video' | 'audio'

export interface AssetBase {
  id: ID
  kind: AssetKind
  mimeType: string
  /** 文件名（用户原始） */
  filename: string
  /** 文件大小（字节） */
  size: number
  /** 创建时间 */
  createdAt: number
  /** 来源：ai-generated / uploaded / extracted */
  source: 'ai-generated' | 'uploaded' | 'extracted'
  /** 关联的 prompt（如果是 AI 生成的） */
  prompt?: string
  /** 所属项目（资源库筛选用） */
  projectId?: ID
  /** 生成时关联的分镜 */
  shotId?: ID
  /** 桌面端相对项目目录的路径，如 assets/images/xxx.png */
  fileRelPath?: string
  /** 公共资产库（跨项目可选用） */
  library?: boolean
  /** 用户自建分类文件夹；空则在公共资产（未分类） */
  folderId?: string
}

/** 公共资产库里的用户自建文件夹 */
export interface LibraryFolder {
  id: ID
  name: string
  createdAt: number
}

export interface ImageAsset extends AssetBase {
  kind: 'image'
  width: number
  height: number
}

export interface VideoAsset extends AssetBase {
  kind: 'video'
  width: number
  height: number
  duration: number
  fps: number
  /** 缩略图（视频的第一帧） */
  thumbnailId?: ID
  /** 是否有音轨 */
  hasAudio: boolean
}

export interface AudioAsset extends AssetBase {
  kind: 'audio'
  duration: number
}

export type Asset = ImageAsset | VideoAsset | AudioAsset

/** 素材 + 运行时 blob URL 的封装 */
export type AssetWithUrl = Asset & {
  url: string
  thumbnailUrl?: string
}
