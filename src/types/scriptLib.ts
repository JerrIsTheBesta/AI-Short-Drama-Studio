/**
 * 剧本库
 *
 * 每一份生成 / 导入的剧本都会：
 * 1. 落成一份本地 Markdown 文件（桌面端在保存目录/_scripts/<id>.md）
 * 2. 在 index.json 里登记元数据，供「剧本管理」和资源库读取
 *
 * 剧本正文以 Markdown 为唯一事实来源；「集数」由正文里的二级标题切分而来。
 */

import type { ID } from './project'

export type ScriptSource = 'ai-generated' | 'imported' | 'manual'

/** 从剧本正文切出来的一个「集」/「章节」 */
export interface ScriptEpisode {
  id: ID
  /** 从 0 开始的序号 */
  index: number
  title: string
  /** 该集正文（不含标题行） */
  content: string
  /** 正文字数（不含空白） */
  wordCount: number
}

/** 剧本库里的一份完整剧本 */
export interface ScriptDoc {
  id: ID
  title: string
  /** Markdown 文件名，如「长安夜雨.md」 */
  filename: string
  /** 来源：AI 生成 / 外部导入 / 手动新建 */
  source: ScriptSource
  /** 归属项目（可能为空：导入或手动创建的剧本不属于任何项目） */
  projectId?: ID
  /** 关联的项目剧本 ID，用于回写 */
  scriptId?: ID
  /** 生成时的原始需求描述 */
  prompt?: string
  /** 集数（正文中二级标题的数量，至少 1） */
  episodeCount: number
  totalWords: number
  /** 桌面端相对 _scripts 目录的文件名；Web 端不用 */
  fileRelPath?: string
  /** 用户自建分类文件夹 */
  folderId?: string
  createdAt: number
  updatedAt: number
}

export const EMPTY_EPISODE_TEMPLATE = `场景：
人物：
剧情：
`
