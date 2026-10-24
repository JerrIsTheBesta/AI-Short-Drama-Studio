import { useProjectStore, useSettingsStore } from '@/stores'
import type { Project, Shot } from '@/types'
import { getAgentState } from './taskStore'
import { effectiveShotAudioMode, needsExternalTts } from '@/utils/shot'
import { shotsMissingKeyframe } from '@/utils/videoStill'

/** 明细段最多带几段：上下文是给模型规划用的摘要，不是全量转储 */
export const MAX_DETAIL_SECTIONS = 5

type SectionKey = 'script' | 'subjects' | 'scenes' | 'shots' | 'canvas'

const SECTION_RULES: { key: SectionKey; test: RegExp }[] = [
  { key: 'script', test: /剧本|故事|大纲|剧情|续写|题材|梗概|番外|主题|写一|改写|结尾|开头/ },
  { key: 'subjects', test: /角色|人物|人设|主角|配角|四视图|谁演|性格|名字/ },
  { key: 'scenes', test: /场景|地点|背景|底板|环境|在哪儿|哪里/ },
  {
    key: 'shots',
    test: /分镜|镜|镜头|关键帧|画面|出图|配图|图生视频|视频|配音|口播|台词|旁白|运镜|景别/
  },
  { key: 'canvas', test: /节点|画布|连线|参考图|选中|整理|删除|布局|生成节点|跑一下/ }
]

/** 明确要看全貌的话，放宽到带所有有数据的段（仍封顶 MAX 段） */
const BROAD_ASK = /全流程|全部|整体|所有|检查|体检|什么问题|怎么样|状态|梳理|盘点/

function selectSections(userText: string, p: Project): SectionKey[] {
  const t = userText
  const hits = SECTION_RULES.filter((r) => r.test.test(t)).map((r) => r.key)
  if (BROAD_ASK.test(t)) {
    const all: SectionKey[] = ['script', 'subjects', 'scenes', 'shots', 'canvas']
    return all.filter((k) => hasSectionData(p, k)).slice(0, MAX_DETAIL_SECTIONS)
  }
  return hits.filter((k) => hasSectionData(p, k)).slice(0, MAX_DETAIL_SECTIONS)
}

function hasSectionData(p: Project, key: SectionKey): boolean {
  switch (key) {
    case 'script':
      return Boolean(p.script?.content?.trim() || p.script?.topic?.trim())
    case 'subjects':
      return (p.subjects ?? []).length > 0
    case 'scenes':
      return (p.scenes ?? []).length > 0
    case 'shots':
      return (p.shots ?? []).length > 0
    case 'canvas':
      return (p.canvas?.nodes ?? []).length > 0
  }
}

function truncate(text: string | undefined, limit: number): string | null {
  if (!text) return null
  return text.length > limit ? `${text.slice(0, limit)}…(已截断，全文在项目里，工具执行时会读实时数据)` : text
}

function shotContext(shot: Shot) {
  return {
    id: shot.id,
    index: shot.index + 1,
    title: shot.title,
    purpose: shot.purpose,
    imagePrompt: shot.imagePrompt,
    videoPrompt: shot.videoPrompt,
    voiceover: shot.voiceover,
    audioMode: effectiveShotAudioMode(shot),
    duration: shot.duration,
    cameraMovement: shot.cameraMovement,
    shotSize: shot.shotSize,
    subjectIds: shot.subjectIds ?? [],
    sceneId: shot.sceneId,
    assets: {
      board: shot.boardAssetId ?? null,
      image: shot.imageAssetId ?? null,
      video: shot.videoAssetId ?? null,
      audio: shot.audioAssetId ?? null
    }
  }
}

function relevantShots(p: Project, userText: string): Shot[] {
  const indexes = new Set<number>()
  for (const match of userText.matchAll(/第\s*(\d+)\s*镜/g)) indexes.add(Number(match[1]) - 1)
  const named = p.shots.filter(
    (shot) => userText.includes(shot.title) || indexes.has(shot.index)
  )
  if (named.length) return named
  return p.shots.slice(0, 10)
}

export function buildProjectContext(userText: string) {
  const p = useProjectStore().current
  if (!p) return { project: null }
  const state = getAgentState()
  const settings = useSettingsStore()
  const imageProfile =
    (settings.config.images ?? []).find((x) => x.id === settings.config.activeImageId) ||
    (settings.config.images ?? [])[0]
  const videoProfile =
    (settings.config.videos ?? []).find((x) => x.id === settings.config.activeVideoId) ||
    (settings.config.videos ?? [])[0]

  const sections = selectSections(userText, p)

  return {
    project: {
      id: p.id,
      name: p.name,
      /** 当前生成配置：用户在智能体底栏选的比例与模型，生成时直接照此执行 */
      genConfig: {
        aspectRatio: p.settings.aspectRatio,
        imageModel: imageProfile ? `${imageProfile.name} · ${imageProfile.model}` : null,
        videoModel: videoProfile ? videoProfile.name : null
      },
      playApproved: p.playApproved ?? false,
      totals: {
        subjects: (p.subjects ?? []).length,
        scenes: (p.scenes ?? []).length,
        shots: p.shots.length,
        timelineClips: p.timeline.length,
        canvasNodes: (p.canvas?.nodes ?? []).length,
        missingBoards: p.shots.filter((s) => !s.boardAssetId).length,
        missingImages: shotsMissingKeyframe(p).length,
        missingVideos: p.shots.filter((s) => !s.videoAssetId).length,
        missingAudio: p.shots.filter((s) => needsExternalTts(s, p) && !s.audioAssetId).length
      },
      ...(sections.includes('script') && p.script
        ? {
            script: {
              topic: p.script.topic,
              content: truncate(p.script.content, 1600),
              keywords: p.script.keywords,
              style: p.script.style,
              aspectRatio: p.script.aspectRatio,
              origin: p.script.origin || ''
            }
          }
        : {}),
      ...(sections.includes('subjects')
        ? {
            subjects: (p.subjects ?? []).map((s) => ({
              id: s.id,
              name: s.name,
              kind: s.kind,
              role: s.role,
              description: truncate(s.description, 120),
              hasFourView: Boolean(s.designSheetAssetId)
            }))
          }
        : {}),
      ...(sections.includes('scenes')
        ? {
            scenes: (p.scenes ?? []).map((s) => ({
              id: s.id,
              name: s.name,
              description: truncate(s.description, 120),
              hasAnchorSheet: Boolean(s.plateAssetId)
            }))
          }
        : {}),
      ...(sections.includes('shots')
        ? { shots: relevantShots(p, userText).map(shotContext) }
        : {}),
      ...(sections.includes('canvas')
        ? {
            canvas: {
              nodes: (p.canvas?.nodes ?? []).map((node) => ({
                id: node.id,
                type: node.type,
                label: node.data.label,
                prompt: truncate(node.data.prompt, 160),
                duration: node.data.duration,
                status: node.status ?? 'idle',
                hasOutput: Boolean(node.data.outputAssetId),
                error: node.error
              })),
              /** 连线关系，智能体据此判断谁接在谁后面、哪些节点还没下游 */
              edges: (p.canvas?.edges ?? []).map((edge) => ({
                source: edge.source,
                target: edge.target
              }))
            }
          }
        : {}),
      /** 本轮带了哪些明细段；没带的段说明模型不需要，需要时以工具实时数据为准 */
      contextSections: sections
    },
    agent: {
      autonomy: state.autonomy,
      callBudget: state.callBudget,
      recentFailures: state.tasks
        .filter((t) => t.status === 'failed')
        .slice(-3)
        .map((t) => ({ tool: t.failedTool, error: t.error }))
    }
  }
}

export function projectContextPrompt(userText: string): string {
  return JSON.stringify(buildProjectContext(userText), null, 2)
}
