import type { Project } from '@/types'
import { isPlayApproved, needsPlayReview } from './playGate'

export interface PipelineStep {
  id: 'storyboard' | 'review' | 'cast' | 'images' | 'videos' | 'audio'
  label: string
  tools: { tool: string }[]
  focusNodeId?: string
}

export function nextPipelineStep(p: Project | null | undefined): PipelineStep | null {
  if (!p) return { id: 'storyboard', label: '拆剧本', tools: [{ tool: 'generate_storyboard' }], focusNodeId: 'script' }
  if (!p.shots.length) {
    return {
      id: 'storyboard',
      label: '拆剧本',
      tools: [{ tool: 'generate_storyboard' }],
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
  const missingSheets = (p.subjects ?? []).some((s) => !s.designSheetAssetId)
  const missingPlates = (p.scenes ?? []).some((s) => !s.plateAssetId)
  if (missingSheets || missingPlates) {
    const tools: { tool: string }[] = []
    if (missingSheets) tools.push({ tool: 'generate_all_sheets' })
    if (missingPlates) tools.push({ tool: 'generate_all_scenes' })
    return {
      id: 'cast',
      label: '人设和场景图',
      tools,
      focusNodeId: missingSheets ? 'group-subjects' : 'group-scenes'
    }
  }
  if (p.shots.some((s) => !s.imageAssetId)) {
    return {
      id: 'images',
      label: '分镜配图',
      tools: [{ tool: 'generate_all_images' }],
      focusNodeId: 'group-shots'
    }
  }
  if (p.shots.some((s) => s.imageAssetId && !s.videoAssetId)) {
    return {
      id: 'videos',
      label: '分镜视频',
      tools: [{ tool: 'generate_all_videos' }],
      focusNodeId: 'group-shots'
    }
  }
  if (p.shots.some((s) => s.voiceover && !s.audioAssetId)) {
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
    ) || /继续(往下|做|吧)|接着(做|往下)|下一步|往下做/.test(t)
  )
}

export function isVagueRequest(text: string, p: Project | null | undefined) {
  const t = text.trim()
  if (!t) return true
  if (
    /拆分镜|拆镜|故事板|出分镜|生成分镜|剧本|人设|角色图|场景图|底板|配图|出图|视频|口播|第.+镜|全流程|全部做完|确认通过|验收|继续|下一步/.test(
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
    lines.push('3. 只要剧本，还是人设配图一起做？全自动可以说「全流程」。')
    return lines.join('\n')
  }
  if (!p.shots.length) {
    return '文案已经有了。按这份拆剧本吗？回「拆剧本」或「继续」我就写到画布上。'
  }
  if (needsPlayReview(p)) {
    return '剧本已在画布左侧。看完回「确认通过」或「继续」，我再做人设和场景。'
  }
  const n = nextPipelineStep(p)
  if (n) {
    return `下一步是「${n.label}」。回「继续」只做这一步；说「全流程」会一次做完。`
  }
  return '人设、配图、视频目前都齐了。要改某一镜可以说「重新生成第1镜配图」。'
}

export function continueQuestion(next: PipelineStep | null, justDid: string) {
  if (!next) return `${justDid}目前这条流水线齐了。要改某一镜直接点节点重新生成。`
  return `${justDid}要继续做「${next.label}」吗？回「继续」只走下一步；说「全流程」会自动跑完。`
}

export const TOOL_LABEL: Record<string, string> = {
  generate_storyboard: '拆解剧本，写到画布',
  extract_cast: '拆解剧本，写到画布',
  approve_play: '记下剧本已验收',
  generate_sheet: '生成人设图',
  generate_all_sheets: '补齐人设图',
  generate_scene: '生成场景图',
  generate_all_scenes: '补齐场景底板',
  generate_shot_image: '生成分镜配图',
  generate_all_images: '补齐分镜配图',
  generate_video: '生成分镜视频',
  generate_all_videos: '补齐分镜视频',
  generate_audio: '生成口播',
  generate_all_audio: '补齐口播',
  sync_canvas: '同步画布',
  run_node: '生成节点',
  focus_node: '定位画布节点'
}
