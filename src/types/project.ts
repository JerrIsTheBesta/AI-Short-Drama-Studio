/**
 * 项目核心数据类型
 *
 * 一个 AI 混剪项目的完整数据模型。
 * - script       : 原始文案
 * - shots        : 分镜列表（每个分镜对应一个画面/视频片段/字幕）
 * - assets       : 素材库（图片、视频、音频）
 * - timeline     : 时间线（剪辑后的最终顺序）
 * - settings     : 项目级设置（分辨率、帧率、转场、字幕样式等）
 */

import type { CanvasGraph } from './canvas'

export type ID = string

export type AgentAutonomy = 'assist' | 'gated' | 'autopilot'

export interface AgentChatMessage {
  id: ID
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export interface AgentTaskRecord {
  id: ID
  request: string
  status: 'planned' | 'running' | 'success' | 'failed' | 'cancelled'
  currentStep?: string
  completedTools: string[]
  /** 自动补依赖或失败重规划的累计次数，随项目持久化。 */
  repairCount?: number
  /** 最近一次自动恢复的诊断，供恢复任务和界面解释。 */
  lastRecovery?: string
  failedTool?: string
  error?: string
  estimatedCalls?: number
  estimatedSeconds?: number
  startedAt: number
  finishedAt?: number
}

export interface AgentWorkspaceState {
  autonomy: AgentAutonomy
  messages: AgentChatMessage[]
  tasks: AgentTaskRecord[]
  /** 单次自动任务最多允许的外部生成调用数，0 表示不额外限制 */
  callBudget: number
}

/** 画面风格 */
export type VisualStyle =
  | 'cinematic'
  | 'anime'
  | 'oil-painting'
  | '3d-render'
  | 'photorealistic'
  | 'watercolor'
  | 'pixel-art'
  | 'ink-wash'

/** 视频宽高比 */
export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '21:9'

/** 单个分镜 */
export interface Shot {
  id: ID
  index: number
  /** 分镜标题（3-8 字） */
  title: string
  /**
   * 详细视觉描述（中文，5-8 句）
   * 喂给后续配图/视频生成，必须包含：
   * 场景/环境、主体（人物+衣着/状态）、动作、镜头/景别、灯光+色彩+气氛
   */
  visualPrompt: string
  /** 整体氛围/美学描述（项目级，所有分镜共享，中文） */
  aesthetic?: string
  /** 音效描述（中文短句，如"雨声、木船摇晃声、灯火燃烧声"） */
  audioDescription: string
  /** 口播文案 / 字幕文本（中文） */
  voiceover: string
  /** H3 内生对白/画外音、后期 TTS，或完全无口播 */
  audioMode?: ShotAudioMode
  /** H3 说话人音色与表达方式，例如“年轻女声 / 温柔自然” */
  speakerHint?: string
  /** 时长（秒，5-10 之间） */
  duration: number
  /** 镜头运动：推/拉/摇/移/固定/环绕 */
  cameraMovement: 'push' | 'pull' | 'pan' | 'tilt' | 'static' | 'orbit'
  /** 本镜戏剧功能：建立 / 对峙 / 反应 / 揭示 / 转场… */
  purpose?: string
  /** 景别：大远景 / 全景 / 中景 / 近景 / 特写 */
  shotSize?: string
  /** 相对场景主锚的站位与朝向（禁屏幕左右量化坐标） */
  blocking?: string
  /** 视线 / 面向关系 */
  eyeline?: string
  /** 跨镜承接：起始快照 → 本镜可见变化 → 末态 */
  continuity?: string
  /** 本镜道具焦点与状态 */
  propFocus?: string
  /**
   * 故事看板图：同一镜头的六格黑白动作草图，用来锁起始状态、动作过程、
   * 反应与结束状态。配图时锁构图，视频时作为动作时间线参考。
   */
  boardAssetId?: ID
  boardHistoryIds?: ID[]
  /** 看板专用提示词。为空时用 visualPrompt */
  boardPrompt?: string
  /** 关联的素材 */
  imageAssetId?: ID
  videoAssetId?: ID
  /** 口播 TTS 音频 */
  audioAssetId?: ID
  /** 该分镜历史生成过的图片（不含当前），保留在资源库可回看/回用 */
  imageHistoryIds?: ID[]
  /** 该分镜历史生成过的视频（不含当前） */
  videoHistoryIds?: ID[]
  /** 该分镜历史生成过的口播 */
  audioHistoryIds?: ID[]
  /**
   * 配图专用提示词。为空时回退 visualPrompt。
   * 在「AI 配图」页可独立修改，不影响分镜原文。
   */
  imagePrompt?: string
  /**
   * 视频内容表现：这一镜里谁做什么、说什么、镜头怎么走。
   * 不能复用 visualPrompt（那是静帧配图词）。为空时按场记动作/台词重写。
   */
  videoPrompt?: string
  /** 分镜级参考图（图生图/图像编辑用，0-N 张素材 ID） */
  referenceAssetIds?: ID[]
  /** 本镜出场的主体（人物/动物），对应 Project.subjects */
  subjectIds?: ID[]
  /** 本镜所在场景，对应 Project.scenes */
  sceneId?: ID
  /** 字幕样式覆盖 */
  captionOverride?: Partial<CaptionStyle>
  /** 状态 */
  status: 'draft' | 'image-generated' | 'video-generated' | 'ready'
  /** 备注 */
  notes?: string
}

export type ShotAudioMode = 'h3-dialogue' | 'h3-voiceover' | 'tts' | 'none'

/** 项目文案 */
export interface Script {
  id: ID
  /** 文案主题 / 标题 */
  topic: string
  /** 完整文案 */
  content: string
  /** 关键词 */
  keywords: string[]
  /** 画面风格 */
  style: VisualStyle
  /** 视频比例 */
  aspectRatio: AspectRatio
  /** 每个分镜目标时长 */
  shotDuration: number
  /**
   * 项目级整体氛围（中文，1-2 段）
   * 例如：「武侠电影感，典雅东方气质，暖黄灯笼光切开冷雨薄雾……」
   * 生成视频时和每个分镜的 videoPrompt（内容表现）一起组装
   */
  aesthetic?: string
  /** H3 专用英文美学行，直接写入 Aesthetic 段 */
  h3Aesthetic?: string
  /** 风格简报（题材、冲突感、爽点等） */
  styleBrief?: string
  /** 色彩锚点 */
  colorPalette?: string
  /** 整体光线 / 时辰说明 */
  lightingNote?: string
  /** 项目级参考图（主题页产品图 / 全局风格参考，所有分镜都会用到，最多建议 5 张） */
  referenceAssetIds?: ID[]
  /**
   * 是否已写成「完整剧本」（相对用户一句话 brief）。
   * false/缺省：content 还是草稿；true：可再提炼人物/场景/分镜节点。
   */
  playReady?: boolean
  /** 创建时间 */
  createdAt: number
}

/** 字幕样式 */
export interface CaptionStyle {
  /** 字体 */
  fontFamily: string
  /** 字号（视频高度的比例，如 0.03 = 3%） */
  fontSizeRatio: number
  /** 颜色 */
  color: string
  /** 描边 */
  strokeColor: string
  strokeWidth: number
  /** 背景 */
  bgColor: string
  bgOpacity: number
  /** 位置：bottom / center / top */
  position: 'top' | 'center' | 'bottom'
  /** 是否加粗 */
  bold: boolean
}

/** 项目设置 */
export interface ProjectSettings {
  aspectRatio: AspectRatio
  width: number
  height: number
  fps: number
  defaultShotDuration: number
  captionStyle: CaptionStyle
  /** 默认转场 */
  defaultTransition: TransitionType
  /** 背景音乐音量 */
  bgmVolume: number
  /** 原声音量（分镜环境音） */
  originalVolume: number
  /** 是否保留 TTS/无口播镜头的环境音；H3 自带对白或口播始终保留 */
  keepAmbientAudio?: boolean
  /** 是否给字幕加底色 */
  captionBg: boolean
  /** 导出时是否把字幕烧进画面 */
  burnCaptions: boolean
  /** 口播音色（百炼 qwen-audio-3.0-tts-flash / SpeechSynthesizer） */
  ttsVoice?: string
}

/** 转场类型 */
export type TransitionType =
  | 'none'
  | 'fade'
  | 'fade-black'
  | 'slide-left'
  | 'slide-right'
  | 'zoom-in'
  | 'zoom-out'

/** 时间线片段 */
export interface TimelineClip {
  id: ID
  shotId: ID
  /** 在时间线上的起始时间（秒） */
  startTime: number
  /** 时长（秒） */
  duration: number
  /** 入点偏移（从素材哪里开始裁） */
  sourceIn: number
  /** 转场（进入） */
  transitionIn: TransitionType
  /** 转场时长 */
  transitionDuration: number
  /** 速度倍率（1 = 正常，2 = 2x 快进） */
  speed: number
  /** 音量 0-1 */
  volume: number
  enabled: boolean
}

/** 整片锁定的主体（人物 / 动物 / 关键物体），先出多角度人设图再配分镜 */
export interface Subject {
  id: ID
  name: string
  kind: 'person' | 'animal' | 'other'
  /** 外貌锁定（中文），所有分镜必须沿用同一套描述 */
  description: string
  /** 戏剧功能：主角 / 反派 / 旁观见证… */
  role?: string
  /** 本片状态变体，如「外卖外套 / 西装揭示」 */
  stateVariants?: string
  /** 四视图：头像特写 + 全身正/侧/背，锁脸和体型 */
  designSheetAssetId?: ID
  /** 历史四视图（不含当前） */
  designSheetHistoryIds?: ID[]
  /** 身上穿戴/随身物件清单，供资产图使用 */
  props?: string
  /** 资产图：这个角色身上有哪些东西（包、证件、平板、鞋等） */
  propSheetAssetId?: ID
  propSheetHistoryIds?: ID[]
  /** 是否从用户参考图里识别出来 */
  fromReference?: boolean
  /** 四视图额外参考图 */
  referenceAssetIds?: ID[]
  /** 资产图额外参考图 */
  propReferenceAssetIds?: ID[]
}

/** 整片锁定的场景锚点图（四宫格：全景 / 主锚 / 地面 / 光线） */
export interface Scene {
  id: ID
  name: string
  /** 环境锁定（中文）：地点、时间、天气、光线、材质 */
  description: string
  /** 场景主锚（前台接待台 / 电梯门…），站位相对它描述 */
  mainAnchor?: string
  /** 四宫格锚点清单，分号分隔，如「大厅全景；电梯门；大理石地面；天窗」 */
  anchors?: string
  /** 时辰与光源 */
  lighting?: string
  /** 场景四宫格锚点图 */
  plateAssetId?: ID
  /** 历史锚点图（不含当前） */
  plateHistoryIds?: ID[]
  /** 场景锚点图额外参考图 */
  referenceAssetIds?: ID[]
}

/** 完整项目 */
export interface Project {
  id: ID
  name: string
  script: Script | null
  shots: Shot[]
  /** 整片主体（人设），配图/视频前先生成多角度设计图 */
  subjects?: Subject[]
  /** 整片场景底板 */
  scenes?: Scene[]
  timeline: TimelineClip[]
  settings: ProjectSettings
  /** 字幕页编辑过的 SRT，导出时优先用这份 */
  captionSrt?: string
  /** 整片背景音乐（资源库音频 ID） */
  bgmAssetId?: ID
  /** 生成 BGM 用的提示词 */
  bgmPrompt?: string
  /** 画布/导出合成的最终视频 */
  finalVideoAssetId?: ID
  /** 桌面端项目文件夹绝对路径 */
  folderPath?: string
  /** 无限画布图（节点 / 连线 / 分组） */
  canvas?: CanvasGraph
  /**
   * 剧本是否已验收。拆分镜后为 false，确认通过后才做人设/配图/视频。
   * 用户明确要求全流程时会自动视为通过。
   */
  playApproved?: boolean
  /** 智能体会话、运行记录与用户自主度偏好，随项目持久化 */
  agentState?: AgentWorkspaceState
  /**
   * standard：主题/文案创作
   * remake：上传参考视频复刻镜头，产品必须换成用户图
   * img2video：一图生视频，自由画布（图片节点 + 视频节点）
   */
  pipelineMode?: 'standard' | 'remake' | 'img2video'
  /** 视频复刻的参考视频 */
  sourceVideoAssetId?: ID
  createdAt: number
  updatedAt: number
}
