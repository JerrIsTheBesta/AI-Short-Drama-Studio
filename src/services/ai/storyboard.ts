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
import { mockStoryboardFromPrompt } from './mock'
import type { Scene, Script, Shot, ShotAudioMode, Subject, VisualStyle } from '@/types'
import { getSkillBody } from '@/skills'
import { getLlmConfig } from './runtime'
import {
  buildStyleBriefForLLM,
  extractUserMediumPhrase,
  lookFromTexts,
  promptMentionsStyle,
  resolveVisualStyle,
  styleLabel,
  VISUAL_STYLE_GUIDE
} from '@/utils/visualStyle'
import { synthesizeVideoPerformance, VIDEO_PERFORMANCE_SPEC, videoPerformanceIssue } from '@/utils/shotPrompt'
import { extractJsonText, parseJsonRobust } from '@/utils/jsonRepair'

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
  /** 覆盖设置页当前主 LLM，须是设置里已保存的模型名 */
  model?: string
  signal?: AbortSignal
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
        timeoutMs: 180_000
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

async function repairStoryboardOnce(
  parsed: StoryboardResult,
  input: StoryboardInput,
  model: string,
  issues: string[]
): Promise<StoryboardResult> {
  const extractHint =
    input.mode === 'extract'
      ? '输入已是完整剧本，只修提炼结果：不要改口播原意，不要另起故事。遗漏人物必须补进 subjects——若只是对已有角色的称呼（如哥哥），把这个词写进该人物的 name/role/description；若人物表里确实有这个角色，必须单独建档。相关 shots 的 subjectIds 要挂上。'
      : '每个出场人物都在 subjects 单独建档，不能合并成一个“主角”。'
  const repair = await callLLM({
    messages: [
      {
        role: 'system',
        content: `你是短视频总编审。上一稿验收未通过，现在把 JSON 打回来重新提炼，必须消掉下列问题后再交稿。不新增用户没说的产品、人物、数字或事实；但用户原文中已经出现的人物、台词和事件必须补全。\n${extractHint}\n每镜 title 使用不同的 3-8 字内容标题，禁止统一写“镜头”。把用户原文按镜头分配进 voiceover，默认 audioMode=h3-dialogue；只有原文明说旁白时才用 h3-voiceover。口播必须像真人说话，一句一个意思；每镜口播字数不超过 duration*4。\nvisualPrompt 用中文描述可见静帧（场景、人物衣着、光源），这是给配图用的。\n${VIDEO_PERFORMANCE_SPEC}\n禁止把 visualPrompt 翻译成英文，禁止两段写成一样。h3Aesthetic 用英文写全片材质、灯光、色彩和摄影质感。不得堆标签。\n只输出完整合法 JSON。`
      },
      {
        role: 'user',
        content: `用户原文 / 剧本：\n${input.content}\n\n主题：${input.topic || '（未填）'}\n\n验收未通过（必须全部修掉）：\n- ${issues.join('\n- ')}\n\n待修 JSON：\n${JSON.stringify(parsed)}`
      }
    ],
    model,
    temperature: 0.2,
    jsonMode: true,
    maxTokens: 24576,
    signal: input.signal,
    timeoutMs: 180_000
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
      maxTokens: 2400,
      signal: input.signal,
      timeoutMs: 120_000
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

要求：人物/场景/分场与剧本一一对应；口播原文保留；visualPrompt 按剧本「画面」写成静帧可画描述；videoPrompt 必须写细：每个角色的表情神态、动作、环境反应、原词台词、运镜，禁止抄 visualPrompt。直接输出 JSON。`
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
    ? `\n【本轮任务】输入已是完整剧本。只做提炼与落库字段补全，禁止改口播原意，禁止合并剧本里已分开的人物。`
    : ''

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `${directorPlaybook}

${productNote}

${stylePriority}
${extractSystemExtra}

【字段语言】h3Aesthetic 用英文。visualPrompt 用中文写静帧可画内容。videoPrompt 用中文写这一镜的视频内容表现。
${VIDEO_PERFORMANCE_SPEC}

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
      "fromReference": false
    }
  ],
  "scenes": [
    {
      "id": "scn_1",
      "name": "地点短名",
      "description": "<人还没进来时这个地方：地面、水、植物、建筑、风是否在动、光从哪来，80字以上>",
      "mainAnchor": "<摄像能对着的实在东西>",
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
      "continuity": "<开始什么样 → 这几秒环境或人变了啥（风、水、脚步）→ 结束定在哪>",
      "propFocus": "<这镜要看清的物件及它现在的状态，没有写无>",
      "visualPrompt": "<镜头语言：近到远写清画面里所有实物；水/风/衣摆动或不动；光从哪来；人穿什么、踩哪、手拿什么。这是静帧配图词。画风词点一次。禁止画风套话段，禁止只写站位>",
      "videoPrompt": "<视频内容表现，中文，180-450字。先点名谁是谁。每个出场的人都要写表情神态（眉眼嘴角眼神）和手脚动作。环境要动（门、桌、光、风、衣摆、桌上的东西）。台词用原词并写说话神态。最后写镜头怎么走、怎么收。不要写成静帧配图词>",
      "audioDescription": "<现场能听到的，逗号分隔>",
      "voiceover": "<这一镜要念的；没有就空字符串>",
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
默认每镜使用 H3 出镜对白：把原文按镜头分配到 voiceover，并设置 audioMode=h3-dialogue。只有原文明说是旁白/画外音时才用 h3-voiceover，明确要求后期配音时才用 tts，明确无口播的空镜才用 none。口播大约每秒 4 个字。每个出场人物都必须在 subjects 中单独建档；每镜 title 必须是不同的 3-8 字内容标题，禁止统一写“镜头”。前后镜人的位置和手里的东西要接上。
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
    timeoutMs: 180_000
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

  parsed = await ensureStoryboardQuality(parsed, input, model, onProgress)

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
  result.shots.forEach((shot, index) => {
    const label = `第 ${index + 1} 镜`
    const spokenChars = (shot.voiceover || '').replace(/[\s，。！？、,.!?：:；;]/g, '').length
    if (spokenChars > shot.duration * 4.5) {
      issues.push(`${label} 口播 ${spokenChars} 字，${shot.duration} 秒念不完`)
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
  })
  const source = (input.content || '').trim()
  if (source.length > 0 && result.shots.every((shot) => !shot.voiceover.trim())) {
    issues.push('严重：用户有完整文案，但所有镜头口播均为空')
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
    const id = idMap.get(key) || idMap.get(key.toLowerCase())
    if (id && !out.includes(id)) out.push(id)
  }
  return out.length ? out : fallback
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
    fromReference: Boolean(s?.fromReference)
  }))

  const scenes: Scene[] = rawScenes.slice(0, 8).map((s: any, i: number) => ({
    id: `scn_${i + 1}`,
    name: String(s?.name || `场景${i + 1}`).trim() || `场景${i + 1}`,
    description: String(s?.description || '').trim(),
    mainAnchor: optStr(s?.mainAnchor),
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
    subMap.set(id, id)
  })
  subjects.forEach((s) => {
    subMap.set(s.id, s.id)
    subMap.set(s.name, s.id)
    subMap.set(s.name.toLowerCase(), s.id)
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

  const defaultSub = subjects.slice(0, 2).map((s) => s.id)
  const defaultScn = scenes[0].id

  const shots: StoryboardShot[] = shotsIn.map((s: any, i: number) => {
    const subjectIds = resolveIds(
      s?.subjectIds ?? s?.subjectNames ?? s?.characters,
      subMap,
      defaultSub
    ).slice(0, 2)
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
    shots
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
        ? `正在从剧本提炼人物 / 场景 / 分镜…`
        : `正在按「${look.medium}」拆能拍的镜头...`
    )
    try {
      const { result, model } = await realStoryboard(resolved, onProgress)
      onProgress?.(`✓ 模型返回 ${result.shots.length} 个分镜并通过质量检查`)
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 真实 LLM 调用失败：${msg}`)
      throw new Error(msg.startsWith('脚本') ? msg : `脚本生成失败：${msg}`)
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

async function realGeneratePlay(input: StoryboardInput): Promise<{ result: PlayDraftResult; model?: string }> {
  const directorPlaybook = getSkillBody('storyboard-director')
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const styleCn = styleLabel(look.style)
  const mediumPhrase = extractUserMediumPhrase(
    input.topic,
    input.content,
    ...(input.keywords ?? [])
  )

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `${directorPlaybook}

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
  log(`→ 写剧本 LLM: ${model}`)
  const resp = await callLLM({
    messages,
    model,
    temperature: 0.45,
    jsonMode: true,
    maxTokens: 16384,
    signal: input.signal,
    timeoutMs: 120_000
  })

  const raw = await parseJsonWithModelRepair(resp.content, input, '剧本草稿')
  const playMarkdown = String(raw?.playMarkdown || raw?.play || raw?.markdown || '').trim()
  if (playMarkdown.length < 80) {
    throw new Error('剧本过短或未返回 playMarkdown，请重试')
  }
  return {
    result: {
      topic: String(raw?.topic || input.topic || '短视频剧本').trim() || '短视频剧本',
      playMarkdown,
      aesthetic: raw?.aesthetic ? String(raw.aesthetic) : undefined,
      styleBrief: raw?.styleBrief ? String(raw.styleBrief) : undefined,
      colorPalette: raw?.colorPalette ? String(raw.colorPalette) : undefined,
      lightingNote: raw?.lightingNote ? String(raw.lightingNote) : undefined
    },
    model: resp.model ?? model
  }
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
  log(`写剧本 · AI 模式：${mode}`)

  if (mode === 'real') {
    onProgress?.('正在写完整剧本…')
    try {
      const { result, model } = await realGeneratePlay(resolved)
      onProgress?.('✓ 完整剧本已写好（尚未提炼节点）')
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 写剧本失败：${msg}`)
      throw new Error(`写剧本失败：${msg}`)
    }
  }

  onProgress?.('🎭 演示模式写剧本')
  return { result: mockPlayFromBrief(resolved), source: 'mock' }
}

/** 是否已有可提炼的完整剧本 */
export function isPlayReady(script: Script | null | undefined): boolean {
  return Boolean(script?.playReady && script.content?.trim())
}
