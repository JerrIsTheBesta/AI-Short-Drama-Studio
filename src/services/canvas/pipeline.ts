import type { Project } from '@/types'
import { isPlayApproved, needsPlayReview } from './playGate'
import { needsExternalTts } from '@/utils/shot'
import { frameStagePending, shotsMissingKeyframe, shotsMissingStoryboard } from '@/utils/videoStill'

export interface PipelineStep {
  id: 'play' | 'board' | 'review' | 'cast' | 'panels' | 'images' | 'frames' | 'videos' | 'audio'
  label: string
  tools: { tool: string }[]
  focusNodeId?: string
}

export type ExtractStage = 'subjects' | 'scenes' | 'shots'

export function nextExtractStage(p: Project | null | undefined): ExtractStage | null {
  if (!(p?.subjects ?? []).length) return 'subjects'
  if (!(p?.scenes ?? []).length) return 'scenes'
  if (!p?.shots.length) return 'shots'
  return null
}

export function extractStageNoun(stage: ExtractStage): string {
  if (stage === 'subjects') return '人物'
  if (stage === 'scenes') return '场景描点'
  return '分镜'
}

export function extractStageFromText(text: string): ExtractStage | undefined {
  const t = String(text || '').trim()
  if (/人物/.test(t) && !/场景|分镜/.test(t)) return 'subjects'
  if (/(场景描点|场景锚点|场景)/.test(t) && !/分镜/.test(t)) return 'scenes'
  if (/分镜|提炼节点|重新提炼/.test(t)) return 'shots'
  return undefined
}

export function extractStageLabel(p: Project | null | undefined): string {
  const stage = nextExtractStage(p)
  if (stage === 'subjects') return '第 1 步：提炼人物'
  if (stage === 'scenes') return '第 2 步：提炼场景'
  if (stage === 'shots') return '第 3 步：拆分镜'
  return '重新提取请点对应分组'
}

export function nextPipelineStep(p: Project | null | undefined): PipelineStep | null {
  if (!p) return { id: 'play', label: '写剧本', tools: [{ tool: 'generate_play' }], focusNodeId: 'script' }
  const playReady = Boolean(p.script?.playReady && p.script.content?.trim())
  if (!playReady) {
    return {
      id: 'play',
      label: '写剧本',
      tools: [{ tool: 'generate_play' }],
      focusNodeId: 'script'
    }
  }
  if (!p.shots.length) {
    return {
      id: 'board',
      label: extractStageLabel(p),
      tools: [{ tool: 'extract_cast' }],
      focusNodeId: 'script'
    }
  }
  if (!isPlayApproved(p)) {
    return {
      id: 'review',
      label: '验收剧本',
      tools: [{ tool: 'approve_play' }],
      focusNodeId: 'script'
    }
  }
  const missingFour = (p.subjects ?? []).some((s) => !s.designSheetAssetId)
  if (missingFour) {
    return {
      id: 'cast',
      label: '角色四视图',
      tools: [{ tool: 'generate_all_sheets' }],
      focusNodeId: 'group-subjects'
    }
  }
  const missingPlates = (p.scenes ?? []).some((s) => !s.plateAssetId)
  if (missingPlates) {
    return {
      id: 'cast',
      label: '场景锚点图',
      tools: [{ tool: 'generate_all_scenes' }],
      focusNodeId: 'group-scenes'
    }
  }
  const missingBoards = shotsMissingStoryboard(p)
  if (missingBoards.length) {
    return {
      id: 'panels',
      label: '故事看板图',
      tools: [{ tool: 'generate_all_boards' }],
      focusNodeId: 'group-shots'
    }
  }
  const missingKeyframes = shotsMissingKeyframe(p)
  if (missingKeyframes.length) {
    return {
      id: 'images',
      label: '分镜关键帧',
      tools: [{ tool: 'generate_all_images' }],
      focusNodeId: 'group-shots'
    }
  }
  // 首尾帧模式：视频用的就是这两张帧，必须先画，否则这一列会被整条流水线跳过。
  if (frameStagePending(p)) {
    return {
      id: 'frames',
      label: '首尾帧',
      tools: [{ tool: 'generate_all_frames' }],
      focusNodeId: 'group-frames'
    }
  }
  if (p.shots.some((s) => !s.videoAssetId)) {
    return {
      id: 'videos',
      label: '分镜视频',
      tools: [{ tool: 'generate_all_videos' }],
      focusNodeId: 'group-videos'
    }
  }
  if (p.shots.some((s) => needsExternalTts(s, p) && !s.audioAssetId)) {
    return {
      id: 'audio',
      label: '口播',
      tools: [{ tool: 'generate_all_audio' }],
      focusNodeId: 'group-shots'
    }
  }
  return null
}

export function isContinueRequest(text: string) {
  const t = text.trim()
  if (/确认剧本|验收通过|确认通过|剧本没问题|通过验收/.test(t) && !/继续/.test(t)) {
    return false
  }
  return (
    /^(继续|下一步|接着做|往下|往下做|可以往下|可以|好的|好|要|嗯|行|开始|开始做|帮我做|做一下)([，,。!！ ]*)$/.test(
      t
    ) || /^(继续往下|继续做|继续吧|接着做|接着往下|下一步|往下做)([，,。!！ ]*)$/.test(t)
  )
}

/** 打招呼 / 闲聊，不应当成「需求含糊」去套澄清模板 */
export function isGreetingOrChitchat(text: string) {
  const t = text.trim()
  if (!t) return false
  if (
    /^(你好|您好|嗨|哈喽|哈囉|在吗|在嘛|在不在|早上好|中午好|下午好|晚上好|你好啊|你好呀|hey|hi|hello|yo)([！!。.～~吗？? ]*)$/i.test(
      t
    )
  ) {
    return true
  }
  if (/^(你好|您好|嗨|哈喽|hey|hi|hello)[，,！!。. ]*(在吗|请问|帮个忙)?$/i.test(t) && t.length <= 12) {
    return true
  }
  return false
}

export function greetingReply(p: Project | null | undefined): string {
  const next = nextPipelineStep(p)
  if (!p?.script?.content?.trim()) {
    return [
      '你好，我是画布里的制作助手。',
      '把主题或口播文案发我，我先写成带背景、人物和环境的完整剧本；之后一次只拆一步：先人物，再场景，再分镜。',
      '也可以直接说「全流程」。'
    ].join('\n')
  }
  if (!p.script?.playReady) {
    return '你好。草稿已经有了，回「写剧本」或「继续」我先写成完整剧本。'
  }
  if (!p.shots.length) {
    return `你好。完整剧本在左侧，回「继续」我先${extractStageLabel(p)}，不会一次拆完。`
  }
  if (needsPlayReview(p)) {
    return '你好。分镜节点已铺上画布，看完回「确认通过」或「继续」，我再往下做人设和场景。'
  }
  if (next) {
    return `你好。当前下一步是「${next.label}」。回「继续」只做这一步；说「全流程」会一次做完。`
  }
  return '你好。素材基本齐了，可以点「合成视频」出结果；要改某一镜直接点节点重新生成就行。'
}

export function isVagueRequest(text: string, p: Project | null | undefined) {
  const t = text.trim()
  if (!t) return true
  if (isGreetingOrChitchat(t)) return false
  if (
    /拆分镜|拆镜|故事板|故事看板|看板图|出分镜|生成分镜|剧本|续写|接着写|人设|四视图|资产图|角色图|场景图|底板|配图|出图|视频|口播|第.+镜|全流程|全部做完|确认通过|验收|继续|下一步/.test(
      t
    )
  ) {
    return false
  }
  if (isContinueRequest(t)) return false
  if (t.length >= 20 && (p?.script?.content || /视频|短片|口播|带货|教程/.test(t))) {
    return false
  }
  if (t.length < 12) return true
  return /帮我|做一下|弄一下|搞一个|来一个|好看|开始吧/.test(t) && t.length < 18
}

export function clarifyMessage(p: Project | null | undefined): string {
  const lines = ['你这句还不够具体，我先问清楚再动手：']
  if (!p?.script?.content?.trim()) {
    lines.push('1. 这条片子讲什么？把主题或口播文案发我就行。')
    lines.push('2. 大概多长？15 秒、30 秒还是 1 分钟。')
    lines.push('3. 只要剧本，还是人设、场景宫格和故事看板一起做？全自动可以说「全流程」。')
    return lines.join('\n')
  }
  if (!p.script?.playReady) {
    return '草稿已经有了。回「写剧本」或「继续」，我先写成完整剧本（还不拆节点）。'
  }
  if (!p.shots.length) {
    return `完整剧本已经在左侧。回「继续」我先${extractStageLabel(p)}，拆完再停下来给你看。`
  }
  if (needsPlayReview(p)) {
    return '分镜节点已经铺上画布。看完回「确认通过」或「继续」，我再做人设和场景。'
  }
  const n = nextPipelineStep(p)
  if (n) {
    return `下一步是「${n.label}」。回「继续」只做这一步；说「全流程」会一次做完。`
  }
  return '人设、场景和视频目前都齐了。可以点「合成视频」出结果。'
}

export function continueQuestion(next: PipelineStep | null, justDid: string) {
  if (!next) return `${justDid}目前这条流水线齐了。要改某一镜直接点节点重新生成。`
  return `${justDid}要继续做「${next.label}」吗？回「继续」只走下一步；说「全流程」会自动跑完。`
}

export const TOOL_LABEL: Record<string, string> = {
  generate_play: '写完整剧本',
  continue_play: '续写剧本',
  generate_storyboard: '写完整剧本',
  extract_cast: '提炼人物 / 场景 / 分镜（可指定一组重提）',
  approve_play: '记下剧本已验收',
  revise_shot: '局部修改分镜',
  generate_sheet: '生成四视图',
  generate_all_sheets: '补齐四视图',
  generate_prop_sheet: '生成场景关键道具图',
  generate_all_prop_sheets: '补齐场景关键道具图',
  generate_scene: '生成场景锚点图',
  generate_all_scenes: '补齐场景锚点图',
  generate_shot_board: '生成故事看板',
  generate_all_boards: '补齐故事看板',
  generate_shot_image: '生成关键帧',
  generate_all_images: '补齐关键帧',
  generate_shot_frames: '生成首尾帧',
  generate_all_frames: '补齐首尾帧',
  generate_video: '生成分镜视频',
  generate_all_videos: '补齐分镜视频',
  generate_audio: '生成口播',
  generate_all_audio: '补齐口播',
  sync_canvas: '同步画布',
  create_image_node: '创建图片节点',
  create_video_node: '创建视频节点',
  connect_nodes: '连接画布节点',
  delete_node: '删除画布节点',
  arrange_canvas: '整理画布排布',
  check_project: '项目体检',
  update_node: '修改生成节点',
  run_node: '生成节点',
  optimize_node_prompt: '优化节点提示词',
  remember: '记住偏好',
  forget: '删除记忆',
  focus_node: '定位画布节点'
}
