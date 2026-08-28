/**
 * 分镜生成服务
 *
 * 输入：文案 + 主题 + 风格 + 镜头时长
 * 输出：StoryboardResult（含导演式策划字段）
 *
 * 走真实 LLM，以现场短视频编导身份拆能拍的镜头；
 * 失败/未配置则走演示数据
 */

import { callLLM, getAIMode, type LLMMessage, type LLMContentPart } from './client'
import { PLAY_LLM_TIMEOUT_MS, isAbortError, isTimeoutAbort } from './abort'
import { mockStoryboardFromPrompt } from './mock'
import type { Scene, Script, Shot, ShotAudioMode, Subject, VisualStyle } from '@/types'
import { getSkillBody } from '@/skills'
import { getLlmConfig, getVideoPromptStyle } from './runtime'
import {
  buildStyleBriefForLLM,
  extractUserMediumPhrase,
  lookFromTexts,
  promptMentionsStyle,
  resolveVisualStyle,
  styleLabel,
  VISUAL_STYLE_GUIDE
} from '@/utils/visualStyle'
import { synthesizeVideoPerformance, videoPerformanceIssue, videoPerformanceSpec, videoPromptJsonHint } from '@/utils/shotPrompt'
import { extractJsonText, parseJsonRobust } from '@/utils/jsonRepair'
import { boundSubjectIds, inferSubjectsFromText, shotCastText, subjectMatchKeys } from '@/utils/consistency'
import { mergeContinuedPlay } from '@/utils/playContinue'

export interface StoryboardInput {
  topic: string
  content: string
  style: VisualStyle
  shotDuration: number
  aspectRatio: string
  /** 文案关键词（若有） */
  keywords?: string[]
  /** 产品/主题参考图（data URL 或公网 URL），最多 5 张，电商带货时以产品为准 */
  productImages?: string[]
  /**
   * extract：content 已是完整剧本，只提炼人物/场景/分镜节点
   * full：兼容旧的一步到位（尽量少用）
   */
  mode?: 'extract' | 'full'
  /** write：从草稿写完整剧本；continue：保留已有场次往后加 */
  playMode?: 'write' | 'continue'
  /** 续写方向，例如「再写两场，写父亲回家之后」 */
  continueHint?: string
  /** 覆盖设置页当前主 LLM，须是设置里已保存的模型名 */
  model?: string
  signal?: AbortSignal
  /** 提炼模式分阶段交付；每完成一步立即持久化，后续失败不回滚。 */
  onExtractStage?: (
    stage: 'subjects' | 'scenes' | 'shots',
    partial: StoryboardResult
  ) => void | Promise<void>
  /** 失败重试时从未完成的阶段继续，避免重复提炼已落库内容。 */
  extractStartAt?: 'subjects' | 'scenes' | 'shots'
  /** 一次用户操作只完成一个阶段。 */
  extractStopAfter?: 'subjects' | 'scenes' | 'shots'
  existingSubjects?: Subject[]
  existingScenes?: Scene[]
}

export interface StoryboardShot {
  /** 简短标题（3-8 字） */
  title: string
  /**
   * 详细视觉描述（中文，5-8 句）
   * 必须含：场景主锚与光线、角色站位朝向、动作、景别运镜、道具焦点、气氛
   */
  visualPrompt: string
  /** 视频内容表现：谁做什么、说什么、镜头怎么走（中文，禁止复用 visualPrompt） */
  videoPrompt?: string
  /** 音效描述（中文短句） */
  audioDescription: string
  /** 口播文案（中文） */
  voiceover: string
  audioMode?: ShotAudioMode
  speakerHint?: string
  /** 时长（秒，5-10） */
  duration: number
  /** 镜头运动 */
  cameraMovement: Shot['cameraMovement']
  /** 本镜出场主体 id（对应 subjects[].id） */
  subjectIds?: string[]
  /** 本镜场景 id（对应 scenes[].id） */
  sceneId?: string
  purpose?: string
  shotSize?: string
  blocking?: string
  eyeline?: string
  continuity?: string
  propFocus?: string
}

export interface StoryboardResult {
  /** 项目级整体氛围（中文，1-2 段） */
  aesthetic?: string
  h3Aesthetic?: string
  styleBrief?: string
  colorPalette?: string
  lightingNote?: string
  /** 整片锁定的主体（人物/动物），后续先出人设图 */
  subjects?: Subject[]
  /** 整片锁定的场景底板 */
  scenes?: Scene[]
  shots: StoryboardShot[]
}

export type StoryboardSource = 'real' | 'mock' | 'mock-fallback'

export interface StoryboardRunResult {
  result: StoryboardResult
  source: StoryboardSource
  error?: string
  model?: string
}

const log = (msg: string) =>
  console.log('%c[storyboard]', 'color:#7c3aed;font-weight:600', msg)

/**
 * 从主题 + 文案中抽出用户自己写的画风/美学指令（最高优先级）
 * 主题整段一律视为画风圣经；文案开头与含画风词的句子一并保留。
 */
export function extractUserStyleAuthority(
  topic: string,
  content: string,
  keywords?: string[]
): string {
  const parts: string[] = []
  const t = topic.trim()
  // 主题整段保留：用户常在主题里写清画风/美学
  if (t) parts.push(t)

  const styleCue =
    /风格|画风|美学|视觉|调色|氛围|质感|电影|动画|动漫|二次元|写实|摄影|渲染|油画|水彩|像素|水墨|赛博|蒸汽|复古|胶片|手绘|插画|国风|武侠|奇幻|暗黑|明亮|赛璐璐|厚涂|扁平|3d|C4D|Blender|真人|纪实|灯笼|汉服|商业|广告|grain|cinematic|anime|wuxia|hanfu|aesthetic|lighting|mist|commercial/i

  const contentLines = content
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)

  // 文案前 2 行常含画风/设定，优先纳入
  for (const line of contentLines.slice(0, 2)) {
    if (!parts.includes(line)) parts.push(line)
  }

  const sentences = content
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && styleCue.test(s))
  for (const s of sentences.slice(0, 10)) {
    if (!parts.includes(s)) parts.push(s)
  }

  const kws = (keywords ?? []).map((k) => k.trim()).filter(Boolean)
  if (kws.length) parts.push(`关键词：${kws.join('、')}`)

  return parts.join('\n')
}

function buildStylePriorityBlock(input: StoryboardInput): string {
  const userAuth = extractUserStyleAuthority(input.topic, input.content, input.keywords)
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const fallback = buildStyleBriefForLLM(look.style)
  const mediumPhrase = extractUserMediumPhrase(input.topic, input.content, ...(input.keywords ?? []))

  if (mediumPhrase) {
    return `【画风听用户的 · 硬性】
用户点名了画风。画风写进画面实物里，不要单独开一段技法说明书。

用户点名的画风原词（文中点一次即可）：「${mediumPhrase}」

用户主题/画风原文：
"""
${userAuth}
"""

每一镜 visualPrompt 必须是镜头语言：
1. 写画面里能看见的一切：地面/建筑/水/植物/天空/道具，近到远。
2. 写动态：水波、风、衣摆、烟尘；不动也要写明静止。
3. 写光从哪来、影子落在哪。
4. 人：衣服、手脚、朝向、手里的具体物件、这一秒在做什么。
5. 「${mediumPhrase}」在文中自然出现一次；技法只写在实物上。禁止开头「${mediumPhrase}。」然后空讲站位，禁止结尾抄画风套话。
${
  look.matched
    ? `6. 该媒介画在实物上时注意：${VISUAL_STYLE_GUIDE[look.matched].mustInclude}。${VISUAL_STYLE_GUIDE[look.matched].avoid}`
    : `6. 按「${mediumPhrase}」这个媒介本身的材料与质感来写实物，不要套页面下拉风格。`
}`
  }

  if (userAuth) {
    return `【画风听用户的】
用户主题原文（保留味道，但主题没点名具体媒介）：
"""
${userAuth}
"""

画面媒介以下拉风格为准（当前：${styleLabel(input.style)} / ${input.style}）：
${fallback}`
  }

  return `【画风指令】主题未写画风时，以下拉风格为准：
${fallback}`
}

export { repairJsonLocally } from '@/utils/jsonRepair'

function robustParseJson(content: string): any {
  return parseJsonRobust(content)
}

function resolvePlayModel(input: Pick<StoryboardInput, 'model'>): string | undefined {
  const model = input.model?.trim()
  return model || undefined
}

/** 本地无法修复时，让主模型只修 JSON 语法，再进入业务质量验收。 */
async function parseJsonWithModelRepair(
  content: string,
  input: Pick<StoryboardInput, 'signal' | 'model'>,
  label: string
): Promise<any> {
  try {
    return robustParseJson(content)
  } catch (parseError) {
    log(`⚠ ${label} JSON 语法异常，调用结构修复：${(parseError as Error).message.split('\n')[0]}`)
    const jsonCandidate = (() => {
      try {
        return extractJsonText(content)
      } catch {
        return content.trim()
      }
    })()
    if (!jsonCandidate) {
      throw new Error(`${label} JSON 自动修复失败：没有可修复的内容\n首次错误：${(parseError as Error).message}`)
    }
    let repairedContent = ''
    try {
      const repaired = await callLLM({
        messages: [
          {
            role: 'system',
            content: `你是 JSON 语法修复器。只修复逗号、引号、转义符、括号和被截断的容器结构；保留已有字段名、字段值、数组顺序和中文原文，不润色、不翻译、不总结、不新增事实。若末尾截断，只保留已经完整的数组元素并闭合 JSON。只输出一个合法 JSON 对象。`
          },
          { role: 'user', content: jsonCandidate }
        ],
        model: resolvePlayModel(input),
        temperature: 0,
        jsonMode: true,
        maxTokens: 24576,
        signal: input.signal,
        timeoutMs: PLAY_LLM_TIMEOUT_MS
      })
      repairedContent = repaired.content || ''
    } catch (llmError) {
      log(`⚠ ${label} 模型修复调用失败：${(llmError as Error).message}`)
    }
    if (repairedContent.trim()) {
      try {
        return robustParseJson(repairedContent)
      } catch (repairError) {
        log(`⚠ ${label} 模型修复结果仍无法解析：${(repairError as Error).message.split('\n')[0]}`)
      }
    }
    throw new Error(
      `${label} JSON 自动修复失败：${(parseError as Error).message}`
    )
  }
}

const QUALITY_REPAIR_ROUNDS = 3

const NARRATIVE_CONTINUITY_RULES = `
【叙事连续性硬规则】
1. 先从用户要求中锁定“本次视频/本集”的起点、终点、时长和明确要展示的事件。只写这个边界内的内容，禁止为了显得完整而续写下一集、提前揭晓后果、补讲世界观或替用户推进剧情。
2. 允许在用户指定的任何节点结束，包括异变刚启动、穿越途中、刚落地、看到陌生人或其他悬念点。开放式结尾和悬念不是断层；结尾只需把当前状态落稳，不得擅自接着解释。
3. 在本次边界内，每个镜头/场次必须由上一段的可见结果触发，并给下一段留下明确的可见状态；禁止只靠观众脑补人物怎么到场、怎么认识、为什么突然开始解释。
4. 地点、时代、身份、关系、目标或身体状态发生重大变化时，只展开到本次视频终点为止的因果链。可用的拍点包括：触发征兆 → 变化过程 → 冲击结果 → 即时反应 → 观察确认 → 首次接触。根据用户要求与时长选取必要拍点，可以停在链条中间，但不能在实际展示的两个拍点之间无过渡跳跃。
5. 穿越、事故、变身、发现秘密、重逢、背叛、战斗爆发等若是本集核心卖点，应获得与本集重要性相称的画面和时长；若用户只把它作为背景或明确要求略过，则服从用户，不强行扩写。
6. 解释性台词要有当前剧情中的触发条件；但用户明确要求从讲解、复盘或既定关系开场时，服从该形式，不擅自补前情。
7. 相邻段落逐对核对人物位置、姿势、朝向、手中物、伤势、情绪、已知信息和环境时间。后一段开头必须接住前一段末态；若跳时空，必须用用户允许的可见转场完成。
8. 不用旁白代替本集本应看见的关键过程，也不为了补过程虚构用户未要求的新事实。`

const SPEAKER_STAGING_RULES = `
【出镜对白与镜头归属】
1. 默认在角色开口前，让镜头和构图先明确落到该角色身上；说话者必须是当前唯一、无歧义的主视觉，脸和嘴清楚可见，其他人闭嘴倾听或反应。
2. 不等于所有对白都用大特写。可根据动作与关系选中近景、近景、过肩、以说话者为主体的双人构图，或先用摇移/推进把视觉重心交给说话者；多人同框时仍要明确谁是主体。
3. 若需要先交代环境或多人关系，优先拆成“无对白建立镜头 + 说话者镜头”，或在开口前完成有动机的构图转移，不能让台词开始时镜头还停在别人身上。
4. 一个 H3 分镜只允许一个说话者。两人轮流说话必须按说话轮次拆镜；同一说话者连续 2–4 个短句可以保留在同一镜。
5. voiceover 保留“人物名：台词”；shotSize、blocking、visualPrompt、videoPrompt 都要能看出镜头如何选择这个人物。`

async function auditStoryboardNarrative(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string
): Promise<string[]> {
  try {
    const compact = parsed.shots.map((shot, index) => ({
      index: index + 1,
      title: shot.title,
      purpose: shot.purpose,
      sceneId: shot.sceneId,
      blocking: shot.blocking,
      continuity: shot.continuity,
      videoPrompt: shot.videoPrompt,
      voiceover: shot.voiceover,
      duration: shot.duration
    }))
    const response = await callLLM({
      messages: [
        {
          role: 'system',
          content: `你是影视连续性编审，只找会让普通观众觉得“怎么突然就到这里了”的实质断层，不挑措辞和审美细节。${NARRATIVE_CONTINUITY_RULES}
先依据用户原始要求判断本次视频的叙事边界，再逐对检查边界内的镜头。用户只要求第一集、片段、预告或悬念结尾时，不得把“没有继续讲后续”判为问题；只检查已经展示的相邻拍点之间是否跳步。只输出 JSON：{"issues":["第 1→2 镜：上一镜末态……，下一镜却……；在本集边界内应补……"]}。没有实质问题就输出 {"issues":[]}。最多 6 条，每条必须指出具体相邻镜头或边界内缺失的过渡。`
        },
        {
          role: 'user',
          content: `用户原始要求：\n${input.topic}\n${input.content}\n\n待审分镜：\n${JSON.stringify(compact)}`
        }
      ],
      model,
      temperature: 0.1,
      jsonMode: true,
      maxTokens: 2400,
      signal: input.signal,
      timeoutMs: 30_000
    })
    const raw = parseJsonRobust(response.content)
    return (Array.isArray(raw?.issues) ? raw.issues : [])
      .map((issue: unknown) => String(issue || '').trim())
      .filter(Boolean)
      .slice(0, 6)
  } catch (error) {
    log(`⚠ 叙事连续性审查不可用，保留结构质检结果：${(error as Error).message}`)
    return []
  }
}

async function ensureNarrativeContinuity(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  onProgress?: (msg: string) => void
): Promise<StoryboardResult> {
  let current = parsed
  for (let round = 0; round < 2; round++) {
    const issues = await auditStoryboardNarrative(current, input, model)
    if (!issues.length) return current
    onProgress?.(`发现叙事断层，正在局部重排相关镜头（${round + 1}/2）…`)
    log(`⚠ 叙事连续性未通过 ${round + 1}/2：${issues.join('；')}`)
    current = await repairStoryboardOnce(
      current,
      input,
      model,
      issues.map((issue) => `严重：叙事断层：${issue}`)
    )
    current = await ensureStoryboardQuality(current, input, model, onProgress)
  }
  const remaining = await auditStoryboardNarrative(current, input, model)
  if (remaining.length) {
    throw new Error(`叙事连续性验收未通过（已自动局部重写 2 次）：${remaining.join('；')}`)
  }
  return current
}

/**
 * Creative extraction must deliver an editable draft quickly. Run one lightweight audit and
 * at most one consolidated repair; subjective quality findings never block a structurally
 * usable storyboard from reaching the canvas.
 */
async function polishStoryboardOnce(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  onProgress?: (msg: string) => void
): Promise<StoryboardResult> {
  const structural = storyboardQualityIssues(parsed, input)
  onProgress?.('快速检查镜头承接与说话者归属…')
  const narrative = await auditStoryboardNarrative(parsed, input, model)
  const issues = [...structural, ...narrative.map((issue) => `叙事承接：${issue}`)].slice(0, 16)
  if (!issues.length) return parsed

  onProgress?.('发现可改进处，合并修订一次后立即交稿…')
  try {
    const repaired = await repairStoryboardOnce(parsed, input, model, issues)
    const remaining = storyboardQualityIssues(repaired, input)
    if (remaining.length) {
      log(`⚠ 修订后仍有非阻断问题，交付可编辑稿：${remaining.join('；')}`)
      onProgress?.(`已生成可编辑分镜；仍有 ${remaining.length} 项建议可在画布继续调整`)
    }
    return repaired.shots.length ? repaired : parsed
  } catch (error) {
    log(`⚠ 合并修订失败，交付首稿：${(error as Error).message}`)
    onProgress?.('自动修订未完成，已保留并交付可编辑首稿')
    return parsed
  }
}

async function repairStoryboardOnce(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  issues: string[]
): Promise<StoryboardResult> {
  const extractHint =
    input.mode === 'extract'
      ? '输入已是完整剧本，只修提炼结果：不要改口播原意，不要另起故事。遗漏人物必须补进 subjects——若只是对已有角色的称呼（如哥哥），把这个词写进该人物的 name/role/description；若人物表里确实有这个角色，必须单独建档。每个已建档人物必须出现在至少一镜：subjectIds 挂上，visualPrompt / videoPrompt 写名字。禁止只做人物卡、分镜里却换成路人或「一个男人」。'
      : '每个出场人物都在 subjects 单独建档，不能合并成一个“主角”。'
  const repair = await callLLM({
    messages: [
      {
        role: 'system',
          content: `你是短视频总编审。上一稿验收未通过，现在把 JSON 打回来重新提炼，必须消掉下列问题后再交稿。不新增用户没说的产品、人物、数字或事实；只补用户本次内容边界内已经出现或明确蕴含的事件过程，禁止续写边界之外的后果。\n${extractHint}\n${NARRATIVE_CONTINUITY_RULES}\n${SPEAKER_STAGING_RULES}\n如果问题指出重大事件被压扁或相邻镜头断层，可以拆分、插入或重排断层附近的镜头，补足本集边界内的可见过程与反应；只局部修相关段落，其他合格镜头保持原意。若用户指定停在悬念点，就停在那里，不得为了闭环继续讲下一步。每个新增镜头也必须写全 continuity，格式为“承接上一镜的明确末态 → 本镜可见变化 → 留给下一镜的明确末态”。\n每镜 title 使用不同的 3-8 字内容标题，禁止统一写“镜头”。把用户原文按语义段落分配进 voiceover，默认 audioMode=h3-dialogue；只有原文明说旁白时才用 h3-voiceover。不要机械地一镜只放一句：同一人物、同一表达意图的连续 2-4 个短句优先合在一个 7-10 秒镜头里，短促反应或转场才保留一句；总字数仍不得超过 duration*4。voiceover 保留“人物名：台词”便于识别说话人，真正送入 H3 时会自动去掉人物名前缀。\n说话镜头先判断动作、空间关系、环境信息和情绪节奏，再选景别。表情是叙事重点且不需交代环境时可以收近；需要保留递物、争执、问答、人物距离、环境压力或集体反应时，应使用合适的中景、双人或多人同框。特写只是可选倾向，禁止把每个说话镜头机械切成特写；但要写清谁在说、其他人如何反应，不能所有人同时张嘴。\nvisualPrompt 用中文描述可见静帧（场景、人物衣着、光源），这是给配图用的。\n${videoPerformanceSpec(getVideoPromptStyle())}\n禁止把 visualPrompt 翻译成英文，禁止两段写成一样。h3Aesthetic 用英文写全片材质、灯光、色彩和摄影质感。不得堆标签。\n只输出完整合法 JSON。`
      },
      {
        role: 'user',
        content: `用户原文 / 剧本：\n${input.content}\n\n主题：${input.topic || '（未填）'}\n\n验收未通过（必须全部修掉）：\n- ${issues.join('\n- ')}\n\n待修 JSON：\n${JSON.stringify(parsed)}`
      }
    ],
    model,
    temperature: 0.2,
    jsonMode: true,
    maxTokens: 14000,
    signal: input.signal,
    timeoutMs: 75_000
  })
  return normalizeStoryboard(await parseJsonWithModelRepair(repair.content, input, '质量修订稿'), {
    style: input.style,
    topic: input.topic,
    content: input.content,
    keywords: input.keywords
  })
}

/** 验收不通过就打回重提炼，不直接停流水线。 */
async function ensureStoryboardQuality(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  onProgress?: (msg: string) => void
): Promise<StoryboardResult> {
  let current = parsed
  for (let round = 0; round <= QUALITY_REPAIR_ROUNDS; round++) {
    const issues = storyboardQualityIssues(current, input)
    if (!issues.length) return current
    const severe = issues.filter((issue) => issue.startsWith('严重'))
    if (round > 0 && !severe.length) {
      log(`⚠ 仍有非阻断问题，继续使用：${issues.join('；')}`)
      return current
    }
    if (round === QUALITY_REPAIR_ROUNDS) {
      throw new Error(
        `脚本质量验收未通过（已打回重提炼 ${QUALITY_REPAIR_ROUNDS} 次）：${issues.join('；')}`
      )
    }
    const n = round + 1
    log(`⚠ 质量未通过，打回重提炼 ${n}/${QUALITY_REPAIR_ROUNDS}：${issues.join('；')}`)
    onProgress?.(`验收未通过，打回重新提炼（${n}/${QUALITY_REPAIR_ROUNDS}）…`)
    current = await repairStoryboardOnce(current, input, model, issues)
  }
  return current
}

/** 真实 LLM 调用 */
async function realStoryboard(
  input: StoryboardInput,
  onProgress?: (msg: string) => void
): Promise<{
  result: StoryboardResult
  model: string
}> {
  let productNote =
    input.productImages && input.productImages.length > 0
      ? `
【参考图（已附带 ${input.productImages.length} 张）】
先看图再写分镜：
- 图里有人/动物/吉祥物，列为 subjects，外貌按图里真实样子写，fromReference=true，别另造一张脸
- 图里是产品，列为 kind=other，按真实产品写
- 后面每一镜的人都要和 subjects 同一套衣服、发型、年龄
- 产品/主角每镜都要让人看清`
      : `
【没有参考图】
先从文案里列出所有会在画面中出现的人/动物（subjects）和地点（scenes）。每个有名字、有台词或有动作的人都必须单独列一个 subject，不能把配角合并成一个“主角”。
同一人全片同一套外貌：名字、年龄、发型、衣服、配饰不要变着写。`

  if (input.productImages?.length) {
    log(`→ 调用视觉工具分析 ${input.productImages.length} 张参考图`)
    onProgress?.(`先识别 ${input.productImages.length} 张参考图；看完再按人物 → 场景 → 分镜分步提炼…`)
    const visualContent: LLMContentPart[] = [
      ...input.productImages.slice(0, 5).map((url) => ({
        type: 'image_url' as const,
        image_url: { url }
      })),
      {
        type: 'text',
        text: `你只负责看图，不负责写剧本。逐张识别并用简体中文给出：
1. 人物/动物/吉祥物的数量、年龄段、脸型、发型、服装、配饰；
2. 产品的品类、外观、颜色、可见文字（看不清就写“不可辨认”，严禁猜测）；
3. 场景、构图与光线；
4. 跨镜头必须保持不变的视觉锚点。
只陈述画面里可见的事实，不补品牌、参数、价格、功效或人物关系。`
      }
    ]
    const visual = await callLLM({
      provider: 'vision',
      messages: [{ role: 'user', content: visualContent }],
      temperature: 0.1,
      maxTokens: 1800,
      signal: input.signal,
      timeoutMs: 60_000
    })
    productNote += `\n\n【视觉工具识别结果（只作事实依据）】\n${visual.content.slice(0, 8_000)}`
  }

  const stylePriority = buildStylePriorityBlock(input)
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const styleCn = styleLabel(look.style)
  const styleGuide = VISUAL_STYLE_GUIDE[look.style]
  const mediumPhrase = extractUserMediumPhrase(
    input.topic,
    input.content,
    ...(input.keywords ?? [])
  )
  const hasUserStyle = Boolean(mediumPhrase)
  const directorPlaybook = getSkillBody('storyboard-director')
  const extractMode = input.mode === 'extract'

  if (extractMode) {
    const { model: configuredModel } = getLlmConfig()
    const parallelModel = resolvePlayModel(input) || configuredModel
    const play = input.content?.trim() || ''
    const common = `主题：${input.topic || '（未填）'}\n比例：${input.aspectRatio}\n单镜时长参考：${input.shotDuration} 秒\n\n完整剧本：\n${play}`
    const startAt = input.extractStartAt || 'subjects'
    const stopAfter = input.extractStopAfter || startAt
    const stageOrder = { subjects: 0, scenes: 1, shots: 2 } as const
    onProgress?.(
      `按步骤提炼：先人物，再场景，再分镜。本轮只做${startAt === 'subjects' ? '人物' : startAt === 'scenes' ? '场景' : '分镜'}。`
    )

    const runPart = async (
      label: string,
      system: string,
      maxTokens: number,
      timeoutMs: number
    ): Promise<{ raw: any; model?: string }> => {
      const ask = async (extraUser?: string) =>
        callLLM({
          messages: [
            { role: 'system', content: `${system}\n禁止输出思考过程或自然语言。第一个字符必须是 {，最后一个字符必须是 }。` },
            { role: 'user', content: extraUser ? `${common}\n\n${extraUser}` : common }
          ],
          model: parallelModel,
          temperature: extraUser ? 0 : 0.25,
          jsonMode: true,
          maxTokens,
          signal: input.signal,
          timeoutMs
        })
      try {
        const response = await ask()
        let raw: any
        try {
          raw = parseJsonRobust(response.content)
        } catch {
          onProgress?.(`${label}未收到 JSON，正在补要一次…`)
          const salvage = await ask(
            '上一轮只写了思考、没有 JSON。现在立刻只输出 JSON 对象，不要任何解释。'
          )
          raw = parseJsonRobust(salvage.content)
          onProgress?.(`✓ ${label}提炼完成`)
          return { raw, model: salvage.model }
        }
        onProgress?.(`✓ ${label}提炼完成`)
        return { raw, model: response.model }
      } catch (error) {
        if (isAbortError(error) && !isTimeoutAbort(error)) throw error
        const message = (error as Error).message
        log(`⚠ ${label}提炼失败：${message}`)
        throw new Error(`提炼${label}失败；已保留此前完成的节点，可直接重试本阶段：${message}`)
      }
    }

    const subjectSystem = `你是人物设定提炼子智能体。只从完整剧本提炼会实际出现在画面中的人物、动物、产品或关键主体，不写场景，不拆分镜。忠实保留剧本称呼；有名字又有身份称呼时，name 用最常在对白和场记里出现的短名，role 写全身份和别称，便于另一智能体用名字或身份绑定。人物外貌必须具体到年龄、脸型、发型、体型、服装、鞋、配饰和稳定辨识点，不允许只写“主角”。${productNote}\n只输出 JSON：{"subjects":[{"name":"短名","kind":"person|animal|other","description":"具体外貌锁定","role":"身份、剧情作用和别称","stateVariants":"本集内状态变化，没有写单一状态","props":"随身物与服装资产，没有写无","fromReference":false}]}。输出前自行检查：每个有台词、有动作或被镜头看见的人都单独建档。`

    const sceneSystem = `你是场景与视觉设定提炼子智能体。只从完整剧本提炼本集实际出现的地点，并给出项目级视觉设定；不写人物，不拆分镜。场景按地点和明确时段区分，不因景别不同重复建场景。scene.name 必须原样采用剧本“## 场景”下的地点标题或分场里反复使用的地点短名，禁止另起同义名。${productNote}\n${stylePriority}\n只输出 JSON：{"aesthetic":"全片中文氛围","h3Aesthetic":"English production aesthetic with concrete lighting, material, color and camera qualities","styleBrief":"本集冲突和视觉抓点","colorPalette":"可见颜色","lightingNote":"时辰与光源","scenes":[{"name":"剧本地点原名","description":"无人时的空间、地面、建筑、天气、动态和光线，至少80字","mainAnchor":"主视觉实物","anchors":"全景；主锚；地面站位区；光源或次锚","lighting":"时辰和光源"}]}。输出前自行检查地点没有遗漏，四宫格锚点都是同一地点。`

    const shotSystem = `你是分镜导演子智能体。只把完整剧本忠实拆成本集可拍的 shots，不输出 subjects、scenes、项目美学或长篇 videoPrompt。subjectNames 直接使用剧本人物短名；sceneName 必须原样复制剧本“## 场景”下的地点标题或该分场使用的地点短名，禁止另起同义名。汇总器会在本地绑定并根据导演字段合成视频表演草稿。\n${NARRATIVE_CONTINUITY_RULES}\n${SPEAKER_STAGING_RULES}\n每镜 5-10 秒。相邻镜头必须接住位置、姿势、朝向、道具、情绪和已知信息。一个 H3 镜头只能有一个说话者；轮流对话按轮次拆镜。同一人连续短句可留在一镜。visualPrompt 是中文单帧可画内容。blocking 和 continuity 必须写具体动作，不能用空话。\n只输出 JSON：{"shots":[{"title":"3-8字内容标题","purpose":"钩子/说明/反应/揭示/转场/收口","shotSize":"景别与理由","blocking":"具体站位、动作和说话者视觉归属","eyeline":"视线","continuity":"上一镜具体末态 → 本镜可见变化 → 下一镜具体末态","propFocus":"道具状态或无","visualPrompt":"中文静帧画面","audioDescription":"现场声音","voiceover":"人物名：实际台词；无则空","audioMode":"h3-dialogue|h3-voiceover|tts|none","speakerHint":"说话人声线与情绪","duration":7,"cameraMovement":"push|pull|pan|tilt|static|orbit","subjectNames":["剧本人物短名"],"sceneName":"剧本地点原名"}]}。输出前自行逐对检查 continuity、台词原文和说话者构图。`

    let subjectPart: { raw: any; model?: string } = {
      raw: { subjects: input.existingSubjects || [] }
    }
    let scenePart: { raw: any; model?: string } = {
      raw: { scenes: input.existingScenes || [] }
    }
    let shotPart: { raw: any; model?: string } = { raw: { shots: [] } }

    if (stageOrder[startAt] <= stageOrder.subjects) {
      onProgress?.('第 1/3 步：只提炼人物角色…')
      subjectPart = await runPart('人物', subjectSystem, 4000, PLAY_LLM_TIMEOUT_MS)
      const rows = Array.isArray(subjectPart.raw?.subjects) ? subjectPart.raw.subjects : []
      if (!rows.length) throw new Error('提炼人物失败：模型返回的 subjects 为空')
      const normalized = normalizeStoryboard(
        { subjects: rows, scenes: [], shots: [] },
        { style: input.style, topic: input.topic, content: input.content, keywords: input.keywords }
      )
      await input.onExtractStage?.('subjects', { subjects: normalized.subjects, scenes: [], shots: [] })
      onProgress?.(`✓ 已保存 ${normalized.subjects?.length || 0} 个角色`)
      if (stopAfter === 'subjects') {
        onProgress?.('人物阶段完成。下一步由你确认后再提炼场景。')
        return {
          result: { subjects: normalized.subjects, scenes: [], shots: [] },
          model: subjectPart.model || parallelModel
        }
      }
    } else {
      onProgress?.(`✓ 已有 ${input.existingSubjects?.length || 0} 个角色，从已保存结果继续`)
    }

    if (stageOrder[startAt] <= stageOrder.scenes) {
      onProgress?.('第 2/3 步：只提炼场景锚点…')
      scenePart = await runPart('场景', sceneSystem, 4000, PLAY_LLM_TIMEOUT_MS)
      const rows = Array.isArray(scenePart.raw?.scenes) ? scenePart.raw.scenes : []
      if (!rows.length) throw new Error('提炼场景失败：模型返回的 scenes 为空；人物节点已经保留')
      const normalized = normalizeStoryboard(
        { ...scenePart.raw, subjects: subjectPart.raw.subjects || [], scenes: rows, shots: [] },
        { style: input.style, topic: input.topic, content: input.content, keywords: input.keywords }
      )
      await input.onExtractStage?.('scenes', { ...normalized, shots: [] })
      onProgress?.(`✓ 已保存 ${normalized.scenes?.length || 0} 个场景`)
      if (stopAfter === 'scenes') {
        onProgress?.('场景阶段完成。下一步由你确认后再拆分镜。')
        return {
          result: { ...normalized, shots: [] },
          model: scenePart.model || subjectPart.model || parallelModel
        }
      }
    } else {
      onProgress?.(`✓ 已有 ${input.existingScenes?.length || 0} 个场景，从已保存结果继续`)
    }

    onProgress?.('第 3/3 步：按已保存的人物和场景拆分镜…')
    shotPart = await runPart('分镜', shotSystem, 9000, PLAY_LLM_TIMEOUT_MS)

    const rawShots = Array.isArray(shotPart.raw?.shots) ? shotPart.raw.shots : []
    if (!rawShots.length) {
      throw new Error('提炼分镜失败：模型没有返回可用镜头；人物和场景节点已经保留，可直接重试分镜')
    }
    const subjectRows = Array.isArray(subjectPart.raw?.subjects) ? subjectPart.raw.subjects : []
    if (!subjectRows.length) {
      const names = new Set<string>()
      for (const shot of rawShots) {
        for (const name of Array.isArray(shot?.subjectNames) ? shot.subjectNames : []) {
          if (String(name || '').trim()) names.add(String(name).trim())
        }
        const speaker = String(shot?.voiceover || '').match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
        if (speaker) names.add(speaker)
      }
      subjectRows.push(
        ...[...names].slice(0, 8).map((name) => ({
          name,
          kind: 'person',
          description: `${name}，外貌与服装细节待在画布补充`,
          role: '由分镜对白和动作识别出的出场人物',
          stateVariants: '单一状态',
          props: '无'
        }))
      )
    }
    const sceneRows = Array.isArray(scenePart.raw?.scenes) ? scenePart.raw.scenes : []
    if (!sceneRows.length) {
      const names = [...new Set(rawShots.map((shot: any) => String(shot?.sceneName || '').trim()).filter(Boolean))]
      sceneRows.push(
        ...names.slice(0, 8).map((name) => ({
          name,
          description: `${name}，空间结构、地面材质、主锚与光线细节待在画布补充`,
          mainAnchor: '场景中心视觉焦点',
          anchors: '全景；主锚；地面站位区；光源',
          lighting: '与本场剧情匹配的主光源'
        }))
      )
    }
    const merged = {
      ...scenePart.raw,
      subjects: subjectRows,
      scenes: sceneRows,
      shots: rawShots
    }
    const parsed = normalizeStoryboard(merged, {
      style: input.style,
      topic: input.topic,
      content: input.content,
      keywords: input.keywords
    })
    const warnings = storyboardQualityIssues(parsed, input)
    if (warnings.length) {
      log(`⚠ 并行提炼完成，保留可编辑稿并提示 ${warnings.length} 项：${warnings.join('；')}`)
      onProgress?.(`分阶段提炼完成；有 ${warnings.length} 项可在画布继续调整`)
    } else {
      onProgress?.('人物、场景、分镜均已完成并绑定…')
    }
    await input.onExtractStage?.('shots', parsed)
    const usedModel = shotPart.model || subjectPart.model || scenePart.model || parallelModel
    return { result: parsed, model: usedModel }
  }

  const userText = extractMode
    ? `下面是已经写好的完整剧本。请**忠实提炼**成画布节点 JSON（subjects / scenes / shots），不要重写故事、不要另起炉灶。

完整剧本：
"""
${input.content?.trim() || '（空）'}
"""

主题：${input.topic || '（未填）'}
${input.keywords?.length ? `关键词：${input.keywords.join('、')}` : ''}
视频比例：${input.aspectRatio}
时长参考：大约每镜 ${input.shotDuration} 秒（跟剧本里的场次走，别强行统一）

${stylePriority}
${productNote}

要求：人物/场景/分场与剧本一一对应；口播原文保留；同一人物同一意图的连续 2-4 个短句尽量合在一镜，不要机械拆成“一镜一句”；visualPrompt 按剧本「画面」写成静帧可画描述；videoPrompt 必须写细：每个角色的表情神态、动作、环境反应、原词台词、运镜。说话时是否收近服从画面感、动作、空间关系与情绪节奏：需要强调表情时可用近景/特写，需要保留关系或环境时继续用中景、双人或多人同框；不要把每个说话镜头机械切成特写。禁止抄 visualPrompt。直接输出 JSON。`
    : `按编剧手册把这段文案拆成能拍的分镜。口播要能念，画面用中文白话写给摄像，别写英文提示词沙拉。

事实保真：不得新增原文没有的价格、参数、功效、人物关系、品牌承诺或剧情结论。原文含数字、专有名词时必须原样保留。信息不够就用画面承接，不要编事实填空。

文案主题：
"""
${input.topic || '（未填）'}
"""

文案内容：
"""
${input.content?.trim() || '（没写正文。有参考图就按图编口播和镜头。）'}
"""
${input.keywords?.length ? `关键词：${input.keywords.join('、')}` : ''}

视频比例：${input.aspectRatio}
时长参考：大约每镜 ${input.shotDuration} 秒（只是节奏，别所有镜头同一秒数）

${stylePriority}
${productNote}

顺序：先锁人物和地点，再拆镜头。每镜 visualPrompt 用镜头语言写静帧里能看见的东西；videoPrompt 写这一镜演什么，不要写成配图词。
${
  hasUserStyle
    ? `画风「${mediumPhrase}」在画面描述里点一次，写进桥、水、衣这些实物上。禁止第一句只写画风、结尾再抄一段技法套话。禁止只写「两人相对拱手」这种站位摘要。`
    : `主题没提画风时，画面里带上「${styleCn}」，同样要写清环境实物与动态。`
}
直接输出 JSON，不要解释。`

  const extractSystemExtra = extractMode
    ? `\n【本轮任务】输入已是完整剧本。只做提炼与落库字段补全，禁止改口播原意，禁止合并剧本里已分开的人物。每个 subject 必须在至少一镜的 subjectIds 和 visualPrompt 里出场点名，不能只建档不入镜。`
    : ''

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `${directorPlaybook}

${NARRATIVE_CONTINUITY_RULES}
${SPEAKER_STAGING_RULES}

${productNote}

${stylePriority}
${extractSystemExtra}

【字段语言】h3Aesthetic 用英文。visualPrompt 用中文写静帧可画内容。videoPrompt 用中文写这一镜的视频内容表现。
${videoPerformanceSpec(getVideoPromptStyle())}

【输出 JSON】
{
  "aesthetic": "<一两句人话，说出全片味道，用用户主题里的词>",
  "h3Aesthetic": "<English production aesthetic, concrete lighting/material/camera qualities>",
  "styleBrief": "<这片图啥、冲突在哪、凭什么不划走>",
  "colorPalette": "<几处能看见的颜色，别写色板编号>",
  "lightingNote": "<几点钟、灯从哪来>",
  "subjects": [
    {
      "id": "sub_1",
      "name": "街上能喊出来的短名",
      "kind": "person|animal|other",
      "description": "<外貌锁定，写成能去夜市买同款：年龄、发型、衣服、鞋、疤或习惯动作>",
      "role": "<这人在片里干什么>",
      "stateVariants": "<会不会换衣服；不会就写单一状态>",
      "props": "<身上穿戴和随身物：包、证件、平板、鞋、帽子等，没有写无>",
      "fromReference": false
    }
  ],
  "scenes": [
    {
      "id": "scn_1",
      "name": "地点短名",
      "description": "<人还没进来时这个地方：地面、水、植物、建筑、风是否在动、光从哪来，80字以上>",
      "mainAnchor": "<摄像能对着的实在东西>",
      "anchors": "<四宫格锚点，分号分隔：全景；主锚；地面站位；光源或次锚>",
      "lighting": "<时辰和光源>"
    }
  ],
  "shots": [
    {
      "title": "场记板上能写的 3-8 字",
      "purpose": "钩子/说明/反应/揭示/收口",
      "shotSize": "<远近 + 为什么>",
      "blocking": "<人踩在什么上、相对哪件实物站哪、脸朝哪，写得出地面和身边物件>",
      "eyeline": "<看谁/看哪件实物>",
      "continuity": "<承接上一镜的具体末态（首镜写开场初态） → 本镜发生的可见变化 → 留给下一镜的具体末态；写清位置、姿势、朝向、手中物、情绪和已知信息>",
      "propFocus": "<这镜要看清的物件及它现在的状态，没有写无>",
      "visualPrompt": "<镜头语言：近到远写清画面里所有实物；水/风/衣摆动或不动；光从哪来；人穿什么、踩哪、手拿什么。这是静帧配图词。画风词点一次。禁止画风套话段，禁止只写站位>",
      "videoPrompt": "${videoPromptJsonHint(getVideoPromptStyle())}",
      "audioDescription": "<现场能听到的，逗号分隔>",
      "voiceover": "<人物名：这一镜连续要说的 1-4 个短句；优先 2-4 句，没有就空字符串>",
      "audioMode": "h3-dialogue|h3-voiceover|tts|none",
      "speakerHint": "<说话人声音特征 / 情绪 / 表达方式；没有口播则空字符串>",
      "duration": <5-10>,
      "cameraMovement": "push|pull|pan|tilt|static|orbit",
      "subjectIds": ["sub_1"],
      "sceneId": "scn_1"
    }
  ]
}

画风：用户原词写进画面实物，不要单独成段。主题完全没提才用下拉「${styleCn}」。
visualPrompt 若只有站位没有环境实物、或开头结尾是画风套话，视为不合格。
videoPrompt 若短于 180 字、没写表情神态、没写每个人的动作、或没写环境变化，视为不合格。
${hasUserStyle && !look.matched ? '这是自定义画风，不要套页面下拉风格。' : `${styleGuide.avoid}。`}
默认每镜使用 H3 出镜对白：把原文按语义段落分配到 voiceover，并设置 audioMode=h3-dialogue。不要机械地一镜一句；同一人物、同一表达意图的连续 2-4 个短句优先合成一个 7-10 秒镜头，短促反应或转场才只说一句，口播总量约每秒 4 个字。voiceover 写“人物名：台词”，speakerHint 同时写说话人和声线。说话镜头的景别服从画面感、动作、空间关系和情绪节奏：表情是重点且不需交代环境时可以收近；需要看清递物、争执、问答、人物距离、环境压力或集体反应时，保留中景、双人或多人同框。禁止按“只要说话就特写”的模板拆镜，但要写清当前谁说话、其余人如何反应，避免所有人同时张嘴。只有原文明说是旁白/画外音时才用 h3-voiceover，明确要求后期配音时才用 tts，明确无口播的空镜才用 none。每个出场人物都必须在 subjects 中单独建档；每镜 title 必须是不同的 3-8 字内容标题，禁止统一写“镜头”。逐对核对 continuity，后一镜开头必须接住前一镜结尾；重大状态变化按上面的叙事连续性硬规则展开，禁止从结果直接跳到讲解。
只输出合法 JSON。`
    },
    {
      role: 'user',
      content: userText
    }
  ]

  const { baseUrl, model: cfgModel } = getLlmConfig()
  const model = resolvePlayModel(input) || cfgModel
  log(
    `→ 调用主 LLM: ${baseUrl}/chat/completions (model: ${model})`
  )

  const resp = await callLLM({
    messages,
    model,
    temperature: 0.45,
    jsonMode: true,
    maxTokens: 24576,
    signal: input.signal,
    timeoutMs: PLAY_LLM_TIMEOUT_MS
  })

  log(`← 收到响应 (${resp.content.length} 字符)`)
  if (resp.content.includes('<think>') || resp.content.includes('<reasoning>')) {
    log('⚠ 响应包含思考标签，使用鲁棒解析剥除')
  }

  let parsed = normalizeStoryboard(await parseJsonWithModelRepair(resp.content, input, '脚本首稿'), {
    style: input.style,
    topic: input.topic,
    content: input.content,
    keywords: input.keywords
  })

  if (!parsed?.shots || !Array.isArray(parsed.shots)) {
    throw new Error(
      `LLM 响应结构不对，没有 shots 数组：${JSON.stringify(parsed).slice(0, 200)}`
    )
  }

  parsed = await polishStoryboardOnce(parsed, input, model, onProgress)

  log(
    `✓ 解析成功，${parsed.subjects?.length ?? 0} 个主体 / ${parsed.scenes?.length ?? 0} 个场景 / ${parsed.shots.length} 个分镜`
  )
  const durSummary = parsed.shots.map((s) => s.duration).join('+')
  const totalDur = parsed.shots.reduce((sum, s) => sum + s.duration, 0)
  log(`⏱ 镜头秒数：${durSummary} = ${totalDur}s`)
  return { result: parsed, model: resp.model ?? model }
}

function asKind(v: unknown): Subject['kind'] {
  return v === 'animal' || v === 'other' || v === 'person' ? v : 'person'
}

function spokenSentenceCount(text: string): number {
  const body = (text || '').replace(/^[^：:\n]{1,12}[：:]\s*/, '').trim()
  if (!body) return 0
  const parts = body.split(/[。！？!?；;]+/).map((part) => part.trim()).filter(Boolean)
  return Math.max(1, parts.length)
}

function voiceoverSpeakerLabels(text: string): string[] {
  const labels: string[] = []
  const source = (text || '').trim()
  const pattern = /(?:^|[\n。！？!?])\s*([^：:\n。！？!?]{1,12})[：:]\s*/g
  for (const match of source.matchAll(pattern)) {
    const label = match[1].trim()
    if (label && !labels.includes(label)) labels.push(label)
  }
  return labels
}

export function storyboardQualityIssues(
  result: StoryboardResult,
  input: Pick<StoryboardInput, 'content' | 'topic'>
): string[] {
  const issues: string[] = []
  if (!result.shots.length) issues.push('严重：没有生成任何分镜')
  if (result.shots.length > 12) issues.push('分镜超过 12 个，短视频节奏失控')
  if (
    result.subjects?.length === 1 &&
    result.subjects[0]?.name === '主角' &&
    (input.content || '').trim()
  ) {
    issues.push('严重：没有从用户原文中提取完整人物，只生成了兜底“主角”')
  }
  const sourceText = `${input.topic || ''}\n${input.content || ''}`
  const castText = (result.subjects ?? [])
    .map((subject) => `${subject.name} ${subject.description} ${subject.role || ''}`)
    .join('\n')
  const visibleRoles = [
    '大哥', '哥哥', '兄长', '弟弟', '妹妹', '父亲', '母亲', '爸爸', '妈妈',
    '爷爷', '奶奶', '祖父', '祖母', '老人', '老者', '老师', '同学', '店员',
    '顾客', '主持人', '女孩', '男孩', '女人', '男人'
  ].filter((role) => sourceText.includes(role) && !castText.includes(role))
  if (visibleRoles.length) {
    issues.push(`严重：subjects 遗漏原文人物：${visibleRoles.join('、')}`)
  }
  const normalizedTitles = result.shots.map((shot) => shot.title.trim())
  if (
    normalizedTitles.some((title) => /^镜头\s*\d*$/.test(title)) ||
    new Set(normalizedTitles).size !== normalizedTitles.length
  ) {
    issues.push('严重：分镜标题缺失或重复；每镜必须使用不同的内容标题，不能统一写“镜头”')
  }
  const targetMatch = `${input.topic}\n${input.content}`.match(/(?:约|大约|控制在)?\s*(\d{1,3})\s*秒/)
  const targetDuration = targetMatch ? Number(targetMatch[1]) : 0
  const totalDuration = result.shots.reduce((sum, shot) => sum + shot.duration, 0)
  if (targetDuration >= 10 && Math.abs(totalDuration - targetDuration) > Math.max(5, targetDuration * 0.25)) {
    issues.push(`总时长 ${totalDuration} 秒，与用户目标 ${targetDuration} 秒偏差过大`)
  }
  if (!result.h3Aesthetic || result.h3Aesthetic.length < 35) {
    issues.push('缺少可直接传给 H3 的英文 Aesthetic')
  }
  const people = (result.subjects ?? []).filter((s) => s.kind !== 'other')
  const voicedShots = result.shots.filter((shot) => (shot.voiceover || '').trim())
  if (
    totalDuration >= 25 &&
    voicedShots.length >= 3 &&
    voicedShots.every((shot) => spokenSentenceCount(shot.voiceover) <= 1)
  ) {
    issues.push('口播被机械拆成了“一镜一句”；同一人物、同一表达意图的连续 2-4 个短句应合进一个 7-10 秒镜头，只给短促反应保留单句')
  }
  result.shots.forEach((shot, index) => {
    const label = `第 ${index + 1} 镜`
    const spokenChars = (shot.voiceover || '').replace(/[\s，。！？、,.!?：:；;]/g, '').length
    if (spokenChars > shot.duration * 4.5) {
      issues.push(`${label} 口播 ${spokenChars} 字，${shot.duration} 秒念不完`)
    }
    const speakers = voiceoverSpeakerLabels(shot.voiceover || '')
    if (shot.audioMode === 'h3-dialogue' && speakers.length > 1) {
      issues.push(`严重：${label} 同一 H3 镜头包含多个说话者（${speakers.join('、')}），必须按说话轮次拆镜`)
    }
    const speaker = speakers[0]
    if (shot.audioMode === 'h3-dialogue' && speaker) {
      const staging = [shot.shotSize, shot.blocking, shot.visualPrompt, shot.videoPrompt]
        .filter(Boolean)
        .join('\n')
      const focusCue = /主视觉|视觉中心|构图主体|说话主体|镜头.{0,16}(?:落到|切到|对准|跟随|推向|移向|转向)|(?:中近景|近景|特写|过肩).{0,16}(?:主体|说话|开口|嘴|脸)/
      if (!staging.includes(speaker) || !focusCue.test(staging)) {
        issues.push(`严重：${label} 出镜对白没有在开口前把镜头明确落到说话者「${speaker}」身上，容易把口型分配给别人`)
      }
    }
    if ((shot.visualPrompt || '').trim().length < 50) {
      issues.push(`${label} 画面描述过短，无法稳定生成`)
    }
    const performance = (shot.videoPrompt || '').trim()
    const still = (shot.visualPrompt || '').trim()
    if (!performance || performance === still) {
      issues.push(`${label} 缺少视频内容表现（谁做什么、说什么、镜头怎么走），不能复用配图描述`)
    } else {
      const perfIssue = videoPerformanceIssue(performance)
      if (perfIssue) issues.push(`${label} ${perfIssue}`)
    }
    if (!shot.sceneId) issues.push(`${label} 没有关联场景`)
    if (!shot.cameraMovement) issues.push(`${label} 缺少运镜方式`)
    const continuity = (shot.continuity || '').trim()
    const continuitySteps = (continuity.match(/→/g) || []).length
    if (continuity.length < 28 || continuitySteps < 2) {
      issues.push(`严重：${label} continuity 没写清“承接上一镜末态 → 本镜变化 → 下一镜末态”，无法保证跨段连续`)
    }
    const emptyPlate =
      !shot.voiceover.trim() && /空镜|空景|无人/.test(`${shot.title}${shot.visualPrompt}`)
    if (people.length && !(shot.subjectIds ?? []).length && !emptyPlate) {
      issues.push(`严重：${label} 没有关联人物，人设图不会进这镜配图`)
    }
  })
  const source = (input.content || '').trim()
  if (source.length > 0 && result.shots.every((shot) => !shot.voiceover.trim())) {
    issues.push('严重：用户有完整文案，但所有镜头口播均为空')
  }
  for (const sub of people) {
    const used = result.shots.some(
      (shot) =>
        (shot.subjectIds ?? []).includes(sub.id) ||
        inferSubjectsFromText(shotCastText(shot as Shot), [sub]).length > 0
    )
    if (!used) issues.push(`严重：人物「${sub.name}」已建档，但所有分镜都没用上`)
  }
  return issues.slice(0, 16)
}

function optStr(v: unknown): string | undefined {
  const s = String(v ?? '').trim()
  return s || undefined
}

function shotTitle(raw: any, index: number): string {
  const explicit = String(raw?.title ?? raw?.shotTitle ?? raw?.name ?? '').trim()
  if (explicit && !/^镜头\s*\d*$/.test(explicit)) return explicit.slice(0, 12)

  const source = String(raw?.purpose ?? raw?.visualPrompt ?? raw?.videoPrompt ?? '')
    .replace(/^(特写|近景|中景|全景|远景|镜头|画面)[：:，,、\s-]*/i, '')
    .replace(/[【】()[\]<>"'“”‘’]/g, '')
    .trim()
  const phrase = source.split(/[，。！？；,:.!?;\n]/)[0]?.replace(/\s+/g, '') || ''
  return phrase ? `${phrase.slice(0, 6)}${index + 1}` : `分镜${index + 1}`
}

function resolveIds(
  raw: unknown,
  idMap: Map<string, string>,
  fallback: string[]
): string[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: string[] = []
  for (const item of list) {
    const key = String(item ?? '').trim()
    if (!key) continue
    let id = idMap.get(key) || idMap.get(key.toLowerCase())
    if (!id && key.length >= 2) {
      const lower = key.toLowerCase()
      const fuzzyIds = new Set(
        [...idMap.entries()]
          .filter(([candidate]) => {
            const normalized = candidate.toLowerCase()
            return normalized.length >= 2 && (normalized.includes(lower) || lower.includes(normalized))
          })
          .map(([, candidateId]) => candidateId)
      )
      if (fuzzyIds.size === 1) id = [...fuzzyIds][0]
    }
    if (id && !out.includes(id)) out.push(id)
  }
  return out.length ? out : fallback
}

function stampCastNames(prompt: string, chars: Subject[]): string {
  const body = (prompt || '').trim()
  if (!chars.length) return body
  const line = `出场：${chars.map((c) => c.name).join('、')}。必须是人设里这些人，脸、发型、衣服跟设计图一致，禁止另造路人。`
  if (body.includes('出场：') && chars.every((c) => body.includes(c.name))) return body
  return body ? `${body}\n${line}` : line
}

function bindCastIntoShots(shots: StoryboardShot[], subjects: Subject[]): StoryboardShot[] {
  if (!subjects.length) return shots
  return shots.map((shot) => {
    const ids = boundSubjectIds(shot as Shot, subjects)
    const chars = ids
      .map((id) => subjects.find((s) => s.id === id))
      .filter((s): s is Subject => Boolean(s))
    return {
      ...shot,
      subjectIds: ids,
      visualPrompt: stampCastNames(shot.visualPrompt, chars),
      videoPrompt: stampCastNames(shot.videoPrompt || '', chars)
    }
  })
}

/** 把 LLM 的 subjects/scenes/shot 绑定规范成稳定 id；按用户主题画风补强过短提示 */
export function normalizeStoryboard(
  raw: any,
  opts: {
    style?: VisualStyle
    topic?: string
    content?: string
    keywords?: string[]
  } | VisualStyle = 'cinematic'
): StoryboardResult {
  const options =
    typeof opts === 'string'
      ? { style: opts as VisualStyle }
      : opts
  const style = resolveVisualStyle(
    options.style ?? 'cinematic',
    options.topic,
    options.content,
    options.keywords
  )
  const userStyleAuth = extractUserStyleAuthority(
    options.topic ?? '',
    options.content ?? '',
    options.keywords
  )
  const styleLockFromUser = userStyleAuth
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('；')
    .slice(0, 160)
  const shotsIn = Array.isArray(raw?.shots)
    ? raw.shots
    : Array.isArray(raw?.storyboard)
      ? raw.storyboard
      : []
  const rawSubjects = Array.isArray(raw?.subjects)
    ? raw.subjects
    : Array.isArray(raw?.characters)
      ? raw.characters
      : Array.isArray(raw?.cast)
        ? raw.cast
        : []
  const rawScenes = Array.isArray(raw?.scenes) ? raw.scenes : []

  const subjects: Subject[] = rawSubjects.slice(0, 8).map((s: any, i: number) => ({
    id: `sub_${i + 1}`,
    name: String(s?.name || `角色${i + 1}`).trim() || `角色${i + 1}`,
    kind: asKind(s?.kind),
    description: String(s?.description || '').trim(),
    role: optStr(s?.role),
    stateVariants: optStr(s?.stateVariants),
    props: optStr(s?.props),
    fromReference: Boolean(s?.fromReference)
  }))

  const scenes: Scene[] = rawScenes.slice(0, 8).map((s: any, i: number) => ({
    id: `scn_${i + 1}`,
    name: String(s?.name || `场景${i + 1}`).trim() || `场景${i + 1}`,
    description: String(s?.description || '').trim(),
    mainAnchor: optStr(s?.mainAnchor),
    anchors: optStr(s?.anchors),
    lighting: optStr(s?.lighting)
  }))

  if (subjects.length === 0) {
    subjects.push({
      id: 'sub_1',
      name: '主角',
      kind: 'person',
      description: '全片同一位主角，面部、发型、服装与配色保持完全一致',
      role: '主角',
      stateVariants: '单一状态'
    })
  }
  if (scenes.length === 0) {
    scenes.push({
      id: 'scn_1',
      name: '主场景',
      description: '全片同一主场景，光线与建筑材质保持一致',
      mainAnchor: '场景中心视觉焦点',
      lighting: '与文案情绪匹配的主光源'
    })
  }

  const subMap = new Map<string, string>()
  rawSubjects.forEach((s: any, i: number) => {
    const id = subjects[i]?.id
    if (!id) return
    if (s?.id) subMap.set(String(s.id), id)
    if (s?.name) {
      subMap.set(String(s.name), id)
      subMap.set(String(s.name).toLowerCase(), id)
    }
    if (s?.role) {
      const role = String(s.role).trim()
      if (role.length >= 2) subMap.set(role, id)
    }
    subMap.set(id, id)
  })
  subjects.forEach((s) => {
    subMap.set(s.id, s.id)
    subMap.set(s.name, s.id)
    subMap.set(s.name.toLowerCase(), s.id)
    for (const key of subjectMatchKeys(s)) subMap.set(key, s.id)
  })

  const scnMap = new Map<string, string>()
  rawScenes.forEach((s: any, i: number) => {
    const id = scenes[i]?.id
    if (!id) return
    if (s?.id) scnMap.set(String(s.id), id)
    if (s?.name) {
      scnMap.set(String(s.name), id)
      scnMap.set(String(s.name).toLowerCase(), id)
    }
    scnMap.set(id, id)
  })
  scenes.forEach((s) => {
    scnMap.set(s.id, s.id)
    scnMap.set(s.name, s.id)
    scnMap.set(s.name.toLowerCase(), s.id)
  })

  const defaultScn = scenes[0].id

  const shots: StoryboardShot[] = shotsIn.map((s: any, i: number) => {
    const subjectIds = resolveIds(
      s?.subjectIds ?? s?.subjectNames ?? s?.characters,
      subMap,
      []
    ).slice(0, 3)
    const sceneIds = resolveIds(s?.sceneId ?? s?.sceneName ?? s?.location, scnMap, [
      defaultScn
    ])
    const voiceover = String(
      s?.voiceover ?? s?.dialogue ?? s?.narration ?? s?.spokenText ?? s?.caption ?? ''
    ).trim()
    const requestedAudioMode = String(s?.audioMode || '')
    const audioMode: ShotAudioMode = !voiceover.trim()
      ? 'none'
      : requestedAudioMode === 'h3-dialogue' ||
          requestedAudioMode === 'h3-voiceover' ||
          requestedAudioMode === 'tts'
        ? requestedAudioMode
        : 'h3-dialogue'
    const purpose = optStr(s?.purpose)
    const shotSize = optStr(s?.shotSize)
    const blocking = optStr(s?.blocking)
    const eyeline = optStr(s?.eyeline)
    const continuity = optStr(s?.continuity)
    const propFocus = optStr(s?.propFocus)
    let visualPrompt = String(s?.visualPrompt || '').trim()

    // 只补极短/缺画风词的镜头；不把技法套话和导演表单拼进画面描述
    visualPrompt = enrichVisualPrompt(visualPrompt, {
      style,
      userStyleLock: styleLockFromUser,
      look: lookFromTexts(style, options.topic, options.content, options.keywords),
      shotSize,
      blocking,
      propFocus,
      purpose,
      sceneName: scenes.find((sc) => sc.id === (sceneIds[0] || defaultScn))?.name,
      sceneLighting: scenes.find((sc) => sc.id === (sceneIds[0] || defaultScn))?.lighting,
      sceneAnchor: scenes.find((sc) => sc.id === (sceneIds[0] || defaultScn))?.mainAnchor
    })

    const draftShot = {
      title: shotTitle(s, i),
      visualPrompt,
      audioDescription: String(s?.audioDescription || ''),
      voiceover,
      speakerHint: optStr(s?.speakerHint),
      duration: clampShotDuration(s?.duration, voiceover, i),
      cameraMovement: (s?.cameraMovement || 'static') as Shot['cameraMovement'],
      purpose,
      blocking,
      continuity: optStr(s?.continuity)
    }
    const ownVideo = optStr(s?.videoPrompt)
    const videoPrompt =
      ownVideo && ownVideo !== visualPrompt
        ? ownVideo
        : synthesizeVideoPerformance(draftShot as Shot)

    return {
      title: draftShot.title,
      visualPrompt,
      videoPrompt,
      audioDescription: String(s?.audioDescription || ''),
      voiceover,
      audioMode,
      speakerHint: optStr(s?.speakerHint),
      duration: clampShotDuration(s?.duration, voiceover, i),
      cameraMovement: s?.cameraMovement || 'static',
      subjectIds,
      sceneId: sceneIds[0] || defaultScn,
      purpose,
      shotSize,
      blocking,
      eyeline,
      continuity,
      propFocus
    }
  })

  const boundShots = bindCastIntoShots(shots, subjects)

  const look = lookFromTexts(style, options.topic, options.content, options.keywords)
  const styleCn = styleLabel(look.matched ?? style)
  let aesthetic = optStr(raw?.aesthetic)
  if (look.userNamed) {
    if (!aesthetic) {
      aesthetic = look.medium
    } else if (!aesthetic.includes(look.medium)) {
      aesthetic = `${look.medium}。${aesthetic}`
    }
  } else if (aesthetic && !promptMentionsStyle(aesthetic, style)) {
    aesthetic = `${styleCn}。${aesthetic}`
  } else if (!aesthetic) {
    aesthetic = styleCn
  }

  return {
    aesthetic,
    h3Aesthetic: optStr(raw?.h3Aesthetic),
    styleBrief:
      optStr(raw?.styleBrief) ??
      (styleLockFromUser
        ? `画风严格遵循用户主题：${styleLockFromUser.split('\n')[0]}`
        : `${styleCn}短片，先让人看下去，再把事讲清楚`),
    colorPalette: optStr(raw?.colorPalette),
    lightingNote: optStr(raw?.lightingNote),
    subjects,
    scenes,
    shots: boundShots
  }
}

/** 画面描述缺画风词时点一下名字；禁止往镜头语言前面堆技法说明书。 */
function enrichVisualPrompt(
  prompt: string,
  ctx: {
    style: VisualStyle
    userStyleLock?: string
    look?: ReturnType<typeof lookFromTexts>
    shotSize?: string
    blocking?: string
    propFocus?: string
    purpose?: string
    sceneName?: string
    sceneLighting?: string
    sceneAnchor?: string
  }
): string {
  const look = ctx.look ?? lookFromTexts(ctx.style, ctx.userStyleLock)
  let body = prompt.trim()

  if (!body) {
    body = [
      ctx.sceneName ? `${ctx.sceneName}` : '',
      ctx.sceneAnchor ? `看得见${ctx.sceneAnchor}` : '',
      ctx.sceneLighting ? `光线：${ctx.sceneLighting}` : '',
      ctx.blocking ? ctx.blocking : '',
      ctx.shotSize ? ctx.shotSize : '',
      ctx.propFocus && ctx.propFocus !== '无' ? `手里/近处：${ctx.propFocus}` : '',
      '写清地面、水或风是否在动、光从哪来。'
    ]
      .filter(Boolean)
      .join('。')
  }

  const hasMedium = look.userNamed
    ? body.includes(look.medium) ||
      (look.matched != null && promptMentionsStyle(body, look.matched))
    : promptMentionsStyle(body, look.style)

  if (!hasMedium && look.medium) {
    body = `${body.trim()}（${look.medium}）`
  }

  return body
}

/** 视频管线限制 5-10 秒；缺省时按口播字数估算，并避免整片同一秒数 */
function clampShotDuration(
  raw: unknown,
  voiceover: string,
  index: number
): number {
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) {
    return Math.min(10, Math.max(5, Math.round(n)))
  }
  const chars = voiceover.replace(/\s+/g, '').length
  let est = chars > 0 ? Math.ceil(chars / 4) + 1 : 6
  est += index % 3
  return Math.min(10, Math.max(5, est))
}

export async function generateStoryboard(
  input: StoryboardInput,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<StoryboardRunResult> {
  const mode = getAIMode()
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const resolved: StoryboardInput = { ...input, style: look.style, signal }
  if (look.matched && look.matched !== input.style) {
    log(`画风已从用户原话对上已知画种：${input.style} → ${look.matched}（${look.medium}）`)
  } else if (look.userNamed && !look.matched) {
    log(`画风按用户原词锁定：${look.medium}（不套下拉枚举）`)
  }
  log(`当前 AI 模式：${mode}`)

  if (mode === 'real') {
      onProgress?.(
        input.mode === 'extract'
          ? (input.extractStopAfter || input.extractStartAt) === 'scenes'
            ? '第 2 步：只提炼场景锚点…'
            : (input.extractStopAfter || input.extractStartAt) === 'shots'
              ? '第 3 步：按已保存的人物和场景拆分镜…'
              : '第 1 步：只提炼人物角色…'
          : `正在按「${look.medium}」拆能拍的镜头...`
      )
    try {
      const { result, model } = await realStoryboard(resolved, onProgress)
      onProgress?.(
        input.mode === 'extract' && !result.shots.length
          ? '✓ 当前提炼阶段已完成并保存'
          : `✓ 已交付 ${result.shots.length} 个可编辑分镜`
      )
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 真实 LLM 调用失败：${msg}`)
      if (isAbortError(e) && !isTimeoutAbort(e)) throw e
      throw new Error(msg.startsWith('脚本') || msg.startsWith('提炼') || msg.startsWith('模型超过') ? msg : `脚本生成失败：${msg}`)
    }
  }

  onProgress?.('🎭 演示模式（未配置 VITE_AI_REAL_MODE=true）')
  const result = normalizeStoryboard(
    mockStoryboardFromPrompt(
      `style: ${resolved.style} duration: ${resolved.shotDuration} """${resolved.content}"""`
    ),
    {
      style: resolved.style,
      topic: resolved.topic,
      content: resolved.content,
      keywords: resolved.keywords
    }
  )
  return { result, source: 'mock' }
}

/** 把分镜结果转成项目里的 Shot[] */
export function storyboardToShots(
  result: StoryboardResult,
  prefix: string = 'shot'
): Shot[] {
  return result.shots.map((s, i) => ({
    id: `${prefix}_${Date.now()}_${i}`,
    index: i,
    title: s.title,
    visualPrompt: s.visualPrompt,
    videoPrompt: s.videoPrompt,
    audioDescription: s.audioDescription ?? '',
    voiceover: s.voiceover,
    audioMode: s.audioMode,
    speakerHint: s.speakerHint,
    duration: s.duration,
    cameraMovement: s.cameraMovement,
    subjectIds: s.subjectIds,
    sceneId: s.sceneId,
    purpose: s.purpose,
    shotSize: s.shotSize,
    blocking: s.blocking,
    eyeline: s.eyeline,
    continuity: s.continuity,
    propFocus: s.propFocus,
    status: 'draft'
  }))
}

/** 把项目级导演字段应用到 Script */
export function applyAestheticToScript(
  script: Pick<Script, 'aesthetic' | 'h3Aesthetic' | 'styleBrief' | 'colorPalette' | 'lightingNote'>,
  result: StoryboardResult
) {
  if (result.aesthetic) script.aesthetic = result.aesthetic
  if (result.h3Aesthetic) script.h3Aesthetic = result.h3Aesthetic
  if (result.styleBrief) script.styleBrief = result.styleBrief
  if (result.colorPalette) script.colorPalette = result.colorPalette
  if (result.lightingNote) script.lightingNote = result.lightingNote
}

export interface PlayDraftResult {
  topic: string
  playMarkdown: string
  aesthetic?: string
  styleBrief?: string
  colorPalette?: string
  lightingNote?: string
}

export interface PlayRunResult {
  result: PlayDraftResult
  source: StoryboardSource
  model?: string
}

function mockPlayFromBrief(input: StoryboardInput): PlayDraftResult {
  const topic = input.topic?.trim() || '短视频剧本'
  const brief = input.content?.trim() || topic
  if (input.playMode === 'continue' && brief.length > 80) {
    const next = mergeContinuedPlay(
      brief,
      [
        '### 第 续 场　往后',
        '',
        `**口播**　${(input.continueHint || '故事接着往下。').slice(0, 40)}`,
        '',
        '**画面**　从上一场结尾接着演，把这件事做完。',
        '',
        '**声音**　现场环境声',
        '',
        '**时长**　约 8 秒',
        ''
      ].join('\n')
    )
    return {
      topic,
      playMarkdown: next,
      aesthetic: `围绕「${topic}」的短视频叙事`,
      styleBrief: '演示模式续写'
    }
  }
  const playMarkdown = [
    `# ${topic}`,
    '',
    '## 故事梗概',
    '',
    brief,
    '',
    '## 人物',
    '',
    '### 主角',
    '',
    '片中主要出镜人物，外貌与穿戴保持统一。',
    '',
    '## 场景',
    '',
    '### 主场景',
    '',
    '围绕文案发生的主要地点。',
    '',
    '## 分场',
    '',
    '### 第 1 场　开场',
    '',
    `**口播**　${brief.slice(0, 40)}`,
    '',
    '**画面**　从主场景切入，完成开场信息。',
    '',
    '### 第 2 场　收口',
    '',
    '**口播**　把结论说清楚。',
    '',
    '**画面**　收近主体或产品，结束本片。',
    ''
  ].join('\n')
  return {
    topic,
    playMarkdown,
    aesthetic: `围绕「${topic}」的短视频叙事`,
    styleBrief: '演示模式生成的完整剧本草稿'
  }
}

async function ensurePlayNarrativeContinuity(
  draft: PlayDraftResult,
  input: StoryboardInput,
  model: string
): Promise<PlayDraftResult> {
  try {
    const audit = await callLLM({
      messages: [
        {
          role: 'system',
          content: `你是影视剧本连续性编审。${NARRATIVE_CONTINUITY_RULES}\n先判断用户这次只要求讲到哪里。只检查该边界内会导致情节突兀的实质问题，不把悬念结尾、未讲下一集或刻意留白判为缺失，不改风格，不挑遣词。只输出 JSON：{"issues":["具体问题及边界内应补的过渡拍点"]}；没有问题输出 {"issues":[]}。最多 6 条。`
        },
        {
          role: 'user',
          content: `用户要求：\n${input.topic}\n${input.content}\n\n完整剧本：\n${draft.playMarkdown}`
        }
      ],
      model,
      temperature: 0.1,
      jsonMode: true,
      maxTokens: 2400,
      signal: input.signal,
      timeoutMs: 30_000
    })
    const audited = parseJsonRobust(audit.content)
    const issues = (Array.isArray(audited?.issues) ? audited.issues : [])
      .map((issue: unknown) => String(issue || '').trim())
      .filter(Boolean)
      .slice(0, 6)
    if (!issues.length) return draft

    log(`⚠ 完整剧本发现叙事断层，自动局部重写：${issues.join('；')}`)
    const repair = await callLLM({
      messages: [
        {
          role: 'system',
          content: `你是短视频编剧。只修复指出的叙事断层，保留用户事实、人物关系、重要台词、画风和已经成立的段落。${NARRATIVE_CONTINUITY_RULES}\n可以在断层附近新增、拆分或重排场次，使核心事件获得足够画面与时长；不要用旁白一句带过关键过程。仍按原 Markdown 结构写完整剧本。只输出 JSON：{"playMarkdown":"..."}。`
        },
        {
          role: 'user',
          content: `用户要求：\n${input.topic}\n${input.content}\n\n必须修复：\n- ${issues.join('\n- ')}\n\n待修完整剧本：\n${draft.playMarkdown}`
        }
      ],
      model,
      temperature: 0.25,
      jsonMode: true,
      maxTokens: 16384,
      signal: input.signal,
      timeoutMs: PLAY_LLM_TIMEOUT_MS
    })
    const repaired = await parseJsonWithModelRepair(repair.content, input, '完整剧本连续性修订')
    const playMarkdown = String(repaired?.playMarkdown || '').trim()
    if (playMarkdown.length < 80) return draft
    return { ...draft, playMarkdown }
  } catch (error) {
    log(`⚠ 完整剧本连续性自检不可用，保留首稿：${(error as Error).message}`)
    return draft
  }
}

async function realGeneratePlay(input: StoryboardInput): Promise<{ result: PlayDraftResult; model?: string }> {
  const directorPlaybook = getSkillBody('storyboard-director')
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const styleCn = styleLabel(look.style)
  const mediumPhrase = extractUserMediumPhrase(
    input.topic,
    input.content,
    ...(input.keywords ?? [])
  )
  const continueMode = input.playMode === 'continue'
  const existingPlay = continueMode ? (input.content || '').trim() : ''
  const hint = (input.continueHint || '').trim()

  const messages: LLMMessage[] = continueMode
    ? [
        {
          role: 'system',
          content: `${directorPlaybook}

${NARRATIVE_CONTINUITY_RULES}
${SPEAKER_STAGING_RULES}

你这一步是**续写剧本**，不是重写。
- 必须保留已有标题、人物、场景、每一场的口播/画面/声音/时长原文，禁止删场、合并场、改写已演过的对白。
- 可以给已有人物补一句状态，新出场的人加进「## 人物」，新地点加进「## 场景」。
- 「## 故事梗概」可改成覆盖到新结局的一两段，但前面已经发生的事不能改口。
- 从已有最后一场之后接着编号写新场（第 N+1 场起）。每场仍用：口播 / 画面 / 声音 / 时长。
- 默认再写 2–3 场；用户指定场数或情节点时按用户的来。
- 不要把口播切成“一场一句”。同一人物同一意图的 2–4 个短句写在同一场，约 7–10 秒；短促反应场才只有一句。
- 说话镜头先看动作、空间关系、环境信息和情绪节奏，再决定景别。表情是重点时可以收近；关系、动作或环境更重要时保留中景、双人或多人同框。禁止把所有说话镜头模板化为特写，并明确谁在说、其他人怎么反应。
- 不要输出 subjects/scenes/shots JSON。

【输出 JSON】
{
  "topic": "<沿用或微调短标题>",
  "playMarkdown": "<完整 Markdown 剧本：旧内容 + 新场，结构不变>",
  "aesthetic": "<一两句人话，全片味道>",
  "styleBrief": "<这片图啥、凭什么不划走>",
  "colorPalette": "<能看见的颜色>",
  "lightingNote": "<时辰和光从哪来>"
}

画风「${mediumPhrase || styleCn}」融进新场画面。只输出合法 JSON。`
        },
        {
          role: 'user',
          content: `在下面这份已经写好的剧本后面续写。保留原文，只往后加。

主题：
"""
${input.topic || '（未填）'}
"""

续写方向：
"""
${hint || '顺着已经发生的事再写 2–3 场，把故事往下推，不要重讲已经演过的。'}
"""

当前完整剧本：
"""
${existingPlay || '（空）'}
"""
比例：${input.aspectRatio}；单场节奏参考约 ${input.shotDuration} 秒。`
        }
      ]
    : [
        {
          role: 'system',
          content: `${directorPlaybook}

${NARRATIVE_CONTINUITY_RULES}
${SPEAKER_STAGING_RULES}

你这一步**只写完整剧本**，不要输出 subjects/scenes/shots JSON，也不要写英文 videoPrompt。
目标：一份能直接给人读的 Markdown 剧本，方便用户改字；下一轮才会从剧本提炼画布节点。

【输出 JSON】
{
  "topic": "<短标题>",
  "playMarkdown": "<完整 Markdown 剧本，见下方结构>",
  "aesthetic": "<一两句人话，全片味道>",
  "styleBrief": "<这片图啥、凭什么不划走>",
  "colorPalette": "<能看见的颜色>",
  "lightingNote": "<时辰和光从哪来>"
}

playMarkdown 必须用简体中文，结构如下（可增减场次，一般 4–8 场）：
# 标题
## 故事梗概
## 人物
### 名字
（外貌、穿戴、在片里干什么）
## 场景
### 地点名
（人还没进来时的地方：地面、光、风、主锚物件）
## 分场
### 第 N 场　场记标题
**口播**　这一场要念的（没有就写无）
**画面**　这一场看见什么、谁在干什么（白话，别写提示词沙拉）
**声音**　现场能听到什么
**时长**　约 N 秒

台词节奏：不要机械地“一场一句”。同一人物、同一表达意图的连续 2–4 个短句优先放在同一场，约 7–10 秒；短促反应、动作转折或空镜才可以只有一句或无口播。口播写清“人物名：台词”。
说话构图：按画面感、动作、空间关系和情绪节奏选择景别。需要强调细微表情时可以中近景、近景或特写；需要保留人物关系、动作路径或环境信息时应继续使用中景、双人或多人同框。不要因为人物开口就机械切特写，但要明确当前谁说话、其他人如何反应，不能所有人一起张嘴。
事实保真：不新增原文没有的价格、功效、人物关系。口播像微信语音。画风「${mediumPhrase || styleCn}」融进画面描述，不要单独堆技法套话。
只输出合法 JSON。`
        },
        {
          role: 'user',
          content: `把下面的主题/草稿写成完整剧本（只要 Markdown 剧本，不要拆画布节点）。

主题：
"""
${input.topic || '（未填）'}
"""

草稿：
"""
${input.content?.trim() || '（没写正文）'}
"""
${input.keywords?.length ? `关键词：${input.keywords.join('、')}` : ''}
比例：${input.aspectRatio}；单场节奏参考约 ${input.shotDuration} 秒。`
        }
      ]

  const { model: cfgModel } = getLlmConfig()
  const model = resolvePlayModel(input) || cfgModel
  log(`→ ${continueMode ? '续写剧本' : '写剧本'} LLM: ${model}`)
  const resp = await callLLM({
    messages,
    model,
    temperature: continueMode ? 0.5 : 0.45,
    jsonMode: true,
    maxTokens: 16384,
    signal: input.signal,
    timeoutMs: PLAY_LLM_TIMEOUT_MS
  })

  const raw = await parseJsonWithModelRepair(resp.content, input, continueMode ? '续写剧本' : '剧本草稿')
  let playMarkdown = String(raw?.playMarkdown || raw?.play || raw?.markdown || '').trim()
  if (continueMode) {
    playMarkdown = mergeContinuedPlay(existingPlay, playMarkdown)
  }
  if (playMarkdown.length < 80) {
    throw new Error('剧本过短或未返回 playMarkdown，请重试')
  }
  const result: PlayDraftResult = {
    topic: String(raw?.topic || input.topic || '短视频剧本').trim() || '短视频剧本',
    playMarkdown,
    aesthetic: raw?.aesthetic ? String(raw.aesthetic) : undefined,
    styleBrief: raw?.styleBrief ? String(raw.styleBrief) : undefined,
    colorPalette: raw?.colorPalette ? String(raw.colorPalette) : undefined,
    lightingNote: raw?.lightingNote ? String(raw.lightingNote) : undefined
  }
  return { result, model: resp.model ?? model }
}

/** 第一步：只生成完整剧本 Markdown，不拆节点 */
export async function generatePlay(
  input: StoryboardInput,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal
): Promise<PlayRunResult> {
  const mode = getAIMode()
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const resolved: StoryboardInput = { ...input, style: look.style, signal }
  log(`${input.playMode === 'continue' ? '续写剧本' : '写剧本'} · AI 模式：${mode}`)

  if (mode === 'real') {
    onProgress?.(input.playMode === 'continue' ? '正在续写剧本…' : '正在写完整剧本…')
    try {
      const { result, model } = await realGeneratePlay(resolved)
      onProgress?.(
        input.playMode === 'continue'
          ? '✓ 已续写（保留原场次）'
          : '✓ 完整剧本已写好（尚未提炼节点）'
      )
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 写剧本失败：${msg}`)
      if (isAbortError(e) && !isTimeoutAbort(e)) throw e
      throw new Error(msg.startsWith('写剧本') || msg.startsWith('模型超过') ? msg : `写剧本失败：${msg}`)
    }
  }

  onProgress?.('🎭 演示模式写剧本')
  return { result: mockPlayFromBrief(resolved), source: 'mock' }
}

/** 是否已有可提炼的完整剧本 */
export function isPlayReady(script: Script | null | undefined): boolean {
  return Boolean(script?.playReady && script.content?.trim())
}
