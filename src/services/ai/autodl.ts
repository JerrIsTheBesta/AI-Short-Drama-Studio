import {
  VIDEO_AUTODL_ROOT,
  VIDEO_DEFAULT_WORKFLOW_ID,
  VIDEO_DIGITAL_HUMAN_WORKFLOW_ID,
  VIDEO_FL2VA_WORKFLOW_ID,
  VIDEO_H3_V5_10S_WORKFLOW_ID
} from './env'

/** AutoDL 固定网关地址，用户只填 Token，不需要碰地址。 */
export const AUTODL_BASE_URL = VIDEO_AUTODL_ROOT

export interface AutodlWorkflow {
  id: string
  name: string
  mode: 'standard' | 'fl2va' | 'audio-sync'
  maxDuration: number
  note: string
}

/**
 * AutoDL 内置 H3 系列工作流。全部对应 autodl.art 上的现成工作流，
 * 用户只需要在设置里填一次 AutoDL Token。
 */
export const AUTODL_WORKFLOWS: AutodlWorkflow[] = [
  {
    id: VIDEO_DEFAULT_WORKFLOW_ID,
    name: 'H3 图生视频 · 15 秒',
    mode: 'standard',
    maxDuration: 15,
    note: '默认出视频工作流，人设 + 场景参考图直接生成'
  },
  {
    id: VIDEO_H3_V5_10S_WORKFLOW_ID,
    name: 'H3 v5 · 10 秒（可选 1080p）',
    mode: 'standard',
    maxDuration: 10,
    note: '画质升级版，支持 1080p 分辨率'
  },
  {
    id: VIDEO_FL2VA_WORKFLOW_ID,
    name: 'H3 首尾帧',
    mode: 'fl2va',
    maxDuration: 10,
    note: '首帧 + 尾帧两张图中间补运动，镜头衔接用'
  },
  {
    id: VIDEO_DIGITAL_HUMAN_WORKFLOW_ID,
    name: '数字人口播 · 图 + 音频',
    mode: 'audio-sync',
    maxDuration: 15,
    note: '人物图 + 配音音频同步驱动，口播镜头用'
  }
]

export function autodlWorkflowById(id: string): AutodlWorkflow | undefined {
  return AUTODL_WORKFLOWS.find((workflow) => workflow.id === id)
}
