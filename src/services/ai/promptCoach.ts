/**
 * 图生视频画布：按用户原文扩写节点提示词，补画面层次，不另起故事。
 */
import { callLLM, getAIMode } from './client'
import { parseJsonRobust, stripModelWrappers } from '@/utils/jsonRepair'

export type PromptCoachKind = 'image' | 'video'

export interface OptimizeNodePromptInput {
  kind: PromptCoachKind
  nodeLabel: string
  currentPrompt: string
  userHint?: string
  script?: string
  duration?: number
  signal?: AbortSignal
}

export interface OptimizeNodePromptResult {
  prompt: string
  note: string
}

function mockExpand(input: OptimizeNodePromptInput): OptimizeNodePromptResult {
  const base = input.currentPrompt.trim()
  const extra = input.kind === 'video'
    ? '侧光勾出轮廓；表情从停顿转到反应；手和衣料跟着动，镜头稳住不切。'
    : '侧光勾出轮廓与材质；前景有一层空气感，主体不居中死板，细节读得清。'
  return {
    prompt: base ? `${base}\n${extra}` : extra,
    note: '演示模式：补了光影和层次，没有改你的意图。'
  }
}

export async function optimizeNodePrompt(
  input: OptimizeNodePromptInput,
  onProgress?: (msg: string) => void
): Promise<OptimizeNodePromptResult> {
  const current = input.currentPrompt.trim()
  const hint = input.userHint?.trim() || ''
  const script = input.script?.trim() || ''
  if (!current && !hint && !script) {
    throw new Error('先在节点里写一句要生成什么，或贴一段剧情参考。')
  }
  if (getAIMode() === 'mock') return mockExpand(input)

  const kindLabel = input.kind === 'video' ? '图生视频' : '文生图 / 图生图'
  const duration = input.kind === 'video' ? Math.max(1, Math.round(input.duration || 8)) : 0
  onProgress?.('正在按当前节点扩写提示词…')

  const resp = await callLLM({
    jsonMode: true,
    temperature: 0.55,
    maxTokens: 4000,
    signal: input.signal,
    messages: [
      {
        role: 'system',
        content: `你是分镜提示词扩写助手。用户已经有一句或一段提示词，你把它写得更有画面、更好生成，不要另起故事。
任务类型：${kindLabel}。
只输出 JSON：{"prompt":"扩写后的全文","note":"改了什么，一两句"}
规则：
- 保留用户原意、人名、地点、动作和已写明的风格。用户没写的剧情不要编。
- 补看得见的东西：构图、景别、站位朝向、光从哪来、材质、空气、表情（眉眼嘴的具体变化）、手和衣服怎么动。
- 禁止套话：不要写「禁止呆脸空眼」「衣摆和空气跟着动」这种空指令；写成这一镜里具体发生什么。
- 不要写成填空模板，不要按秒切段，不要加宫格/四视图/字幕/水印。
- 有剧本时只拿来对齐这一镜的人物、空间和情绪，不要把整章剧情塞进一镜。
- 用户原文若已是 MiniMax H3 六段格式，只加厚 detailed_description 和声音，不要拆掉分段标题。
- 用户原文是中文就继续写中文。${
          input.kind === 'video'
            ? `\n- 这是连续 ${duration} 秒的一条镜头：写开幅、动作怎么起、怎么收，不要切镜。`
            : '\n- 这是静帧：写这一张里已经发生、已经能看清的画面，不要写时间流逝。'
        }`
      },
      {
        role: 'user',
        content: `节点：${input.nodeLabel}

当前提示词：
${current || '（空）'}

用户补充：
${hint || '（没有额外要求，按更有画面感来扩）'}

剧情参考：
${script ? script.slice(0, 6000) : '（无）'}`
      }
    ]
  })

  try {
    const parsed = parseJsonRobust(resp.content) as {
      prompt?: string
      optimizedPrompt?: string
      note?: string
    }
    const prompt = String(parsed.prompt || parsed.optimizedPrompt || '').trim()
    if (prompt.length >= 8) {
      return { prompt, note: String(parsed.note || '已按你的原文补了画面层次。').trim() }
    }
  } catch {
    /* 回退原文清洗 */
  }
  const fallback = stripModelWrappers(resp.content).trim()
  if (fallback.length >= 8) {
    return { prompt: fallback, note: '模型没按 JSON 返回，已尽量保留扩写正文。' }
  }
  throw new Error('扩写没有得到可用提示词，请再试一次。')
}
