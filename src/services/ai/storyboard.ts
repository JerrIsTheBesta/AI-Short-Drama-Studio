/**
 * 分镜生成服务
 *
 * 输入：文案 + 主题 + 风格 + 镜头时长
 * 输出：StoryboardResult（含导演式策划字段）
 *
 * 走 APIYI（qwen3.7-max）OpenAI 兼容协议，以「专业剧本编剧 + 镜头导演」身份生成；
 * 失败/未配置则走演示数据
 */

import { callLLM, getAIMode, type LLMMessage, type LLMContentPart } from './client'
import { mockStoryboardFromPrompt } from './mock'
import type { Scene, Script, Shot, Subject, VisualStyle } from '@/types'
import { composeShotVisualPrompt } from '@/utils/shotPrompt'
import {
  buildStyleBriefForLLM,
  promptMentionsStyle,
  styleLabel,
  styleLockSuffix,
  VISUAL_STYLE_GUIDE
} from '@/utils/visualStyle'

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
}

export interface StoryboardShot {
  /** 简短标题（3-8 字） */
  title: string
  /**
   * 详细视觉描述（中文，5-8 句）
   * 必须含：场景主锚与光线、角色站位朝向、动作、景别运镜、道具焦点、气氛
   */
  visualPrompt: string
  /** 音效描述（中文短句） */
  audioDescription: string
  /** 口播文案（中文） */
  voiceover: string
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
  const fallback = buildStyleBriefForLLM(input.style)
  const styleCn = styleLabel(input.style)

  if (userAuth) {
    return `【画风最高指令 · 用户主题描述 = 画风圣经 · 必须严格遵守】
用户在「视频主题」和文案开头已经写清想要的画风与美学。这是全片唯一最高优先级，远高于页面下拉「画面风格」。
你必须：
1. 精读主题原文，把其中的媒介、技法、色调、光影、时代感、品类气质提炼成一条高密度 Aesthetic（格式见下）
2. 每一镜 visualPrompt 开篇用用户主题里的画风原词做锁（尽量用原词，可压缩，不可篡改成别的风格）
3. 禁止用「电影感/日系动画/写实摄影」等下拉套话覆盖用户原意；只有主题完全没提画风时才用下拉
4. 若主题写的是武侠灯笼雨雾汉服商业广告气质，就锁这个，不要改成无关画风

用户主题/画风原文：
"""
${userAuth}
"""

Aesthetic 输出格式（对齐专业视频脚本，一条高密度风格锚，可中英混合但关键词必须来自用户）：
例：Cinematic wuxia atmosphere, elegant Chinese beauty commercial, warm oil-lantern glow cutting through cool rainy mist, rich red hanfu, delicate makeup, premium beauty advertisement, subtle film grain, realistic skin texture, cinematic lighting
（上例仅说明密度与结构；内容必须按用户主题重写，禁止照抄例句情节）

页面下拉风格仅作弱参考（当前：${styleCn} / ${input.style}），主题有画风时忽略它：
${fallback}`
  }

  return `【画风指令】主题未写画风时，以下拉风格为准：
${fallback}`
}

/** 鲁棒 JSON 解析 */
function robustParseJson(content: string): any {
  let s = content

  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '')
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  s = s.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')

  s = s.replace(/```json\s*/gi, '').replace(/```\s*/g, '')

  s = s.trim()

  if (!s) throw new Error('LLM 返回内容为空')

  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `LLM 响应中找不到 JSON 对象（{...}）\n原始内容（前 300 字符）：${content.slice(0, 300)}`
    )
  }
  const jsonStr = s.slice(start, end + 1)

  try {
    return JSON.parse(jsonStr)
  } catch (e) {
    throw new Error(
      `JSON.parse 失败：${(e as Error).message}\n尝试解析的内容（前 300 字符）：${jsonStr.slice(0, 300)}`
    )
  }
}

/** 真实 LLM 调用 */
async function realStoryboard(input: StoryboardInput): Promise<{
  result: StoryboardResult
  model: string
}> {
  const productNote =
    input.productImages && input.productImages.length > 0
      ? `
【参考图（已附带 ${input.productImages.length} 张）】
先看图再写分镜：
- 图里如果有人物/动物/吉祥物，必须把他们列为 subjects，description 按图中真实外貌写，fromReference=true，不要另造一张脸
- 图里如果是产品，也列为 kind=other 的主体，外貌按真实产品写
- visualPrompt 里的人物必须和 subjects 描述完全一致（同一套衣服、发型、年龄）
- 每个镜头都要让产品/主角清晰可见`
      : `
【没有参考图】
先从文案里列出所有会反复出现的人物/动物（subjects）和地点（scenes）。
同一人物在所有分镜里必须用完全相同的外貌描述（名字、年龄、发型、衣服、配饰一字不差）。`

  const stylePriority = buildStylePriorityBlock(input)
  const styleCn = styleLabel(input.style)
  const styleGuide = VISUAL_STYLE_GUIDE[input.style]
  const userStyleAuth = extractUserStyleAuthority(
    input.topic,
    input.content,
    input.keywords
  )
  const hasUserStyle = Boolean(userStyleAuth.trim())

  const userText = `请以「专业剧本编剧 + 镜头导演 + 美术指导」的身份，按导演策划工作流撰写分镜。

文案主题（画风圣经，最高优先级）：
"""
${input.topic || '（未填）'}
"""

文案内容：
"""
${input.content?.trim() || '（未填写正文。请根据参考图撰写口播与分镜。）'}
"""
${input.keywords?.length ? `关键词：${input.keywords.join('、')}` : ''}

视频比例：${input.aspectRatio}
分镜时长参考基准：约 ${input.shotDuration} 秒（只作节奏参考，不要每个镜头都写成同一个秒数）

${stylePriority}
${productNote}

工作流（必须按顺序）：
1. 先精读「文案主题」，提炼画风，写出一条高密度 aesthetic（格式对齐专业视频脚本 Aesthetic），再写 styleBrief / colorPalette / lightingNote
2. 再锁 subjects（含 role、stateVariants）与 scenes（含 mainAnchor、lighting）
3. 再拆 shots：先定 purpose / shotSize / blocking / eyeline / continuity / propFocus / duration / voiceover / cameraMovement，再写超详细 visualPrompt（对齐参考脚本的 Visual Prompt 密度）

硬性要求：
1. voiceover、audioDescription、导演字段用简体中文；aesthetic 与 visualPrompt 用高密度可喂给视频/配图模型的写法（可中英混合），但画风关键词必须来自用户主题
2. 每个 visualPrompt 8–12 句或等长密度、画面信息完整，禁止一两句空话
3. ${
    hasUserStyle
      ? '每个 visualPrompt 与 aesthetic 必须锁住用户主题里的画风，禁止用下拉风格套话覆盖'
      : `每个 visualPrompt 必须明确写出「${styleCn} / ${styleGuide.medium}」`
  }
4. 每个 shot.duration 按本镜口播字数单独填写（整数秒，5-10）
5. 严格按 system JSON 模板输出，不要思考过程`

  const userContent: string | LLMContentPart[] =
    input.productImages && input.productImages.length > 0
      ? [
          ...input.productImages.slice(0, 5).map((url) => ({
            type: 'image_url' as const,
            image_url: { url }
          })),
          { type: 'text' as const, text: userText }
        ]
      : userText

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: `你是一位专业的剧本编剧、镜头导演与美术指导。你写的 aesthetic / visualPrompt 要能直接用于生成视频的脚本提示词。
最高原则：用户「视频主题」里写明的画风与美学 = 全片圣经。先锁主题画风，再拆镜，再写提示词。不要用页面下拉风格覆盖主题。

【字段语言】
- aesthetic、visualPrompt：高密度，可中英混合（对齐专业 I2V 脚本）；画风词必须来自用户主题
- title、voiceover、audioDescription、blocking、eyeline、continuity、propFocus、purpose、shotSize：简体中文
${productNote}

${stylePriority}

【画风优先级（死规则）】
1. 文案主题 = 最高指令
2. 文案正文里的画风句 = 次高
3. 下拉风格「${styleCn}」= 仅主题完全没提画风时才用
4. 禁止把主题画风擅自改成电影感/日系动画等通用套话

【输出 JSON 结构】
{
  "aesthetic": "<一条高密度 Aesthetic，对齐专业视频脚本；必须锁住用户主题画风>",
  "styleBrief": "<中文风格简报：题材冲突爽点 + 主题画风要点>",
  "colorPalette": "<色彩锚点，对齐主题>",
  "lightingNote": "<光线时辰，对齐主题>",
  "subjects": [
    {
      "id": "sub_1",
      "name": "中文短名",
      "kind": "person|animal|other",
      "description": "<中文外貌锁定，100-180字>",
      "role": "<戏剧功能>",
      "stateVariants": "<状态变体或「单一状态」>",
      "fromReference": false
    }
  ],
  "scenes": [
    {
      "id": "scn_1",
      "name": "中文地点名",
      "description": "<中文环境锁定，80字以上，空镜>",
      "mainAnchor": "<主锚>",
      "lighting": "<时辰光源>"
    }
  ],
  "shots": [
    {
      "title": "中文标题 3-8 字",
      "purpose": "<戏剧功能>",
      "shotSize": "<景别>",
      "blocking": "<相对主锚站位朝向>",
      "eyeline": "<视线>",
      "continuity": "<起始 → 变化 → 末态>",
      "propFocus": "<道具焦点>",
      "visualPrompt": "<超详细 Visual Prompt，密度对齐专业脚本，可直接喂视频/配图>",
      "audioDescription": "<音效短句，中文，逗号分隔>",
      "voiceover": "<中文口播；可含语气提示>",
      "duration": <5-10>,
      "cameraMovement": "push|pull|pan|tilt|static|orbit",
      "subjectIds": ["sub_1"],
      "sceneId": "scn_1"
    }
  ]
}

【Aesthetic 写法】（项目级，一条，不要写成散文水词）
从用户主题提炼，密度参考：
Cinematic wuxia atmosphere, elegant Chinese beauty commercial, warm oil-lantern glow cutting through cool rainy mist, rich red hanfu, delicate makeup, premium beauty advertisement, subtle film grain, realistic skin texture, cinematic lighting
必须替换成用户主题对应的关键词，禁止照抄例句情节。

【visualPrompt 铁律】（每镜）
密度与结构参考：
Starting from the reference frame. Inside a wooden canopy boat drifting slowly across a misty lake at night, the young woman in elegant red embroidered hanfu sits beside a small wooden vanity. ... Rain falls softly outside the boat, creating a dreamy cinematic atmosphere.
要求：
1. 开篇锁用户主题画风原词
2. 写清环境、主锚、光线、外貌、站位、连贯动作（覆盖本镜秒数）、道具、景别运镜、气氛
3. 8–12 句或同等信息密度；可直接作 I2V/配图提示
4. 同场景前后镜动作与道具连续
5. ${
    hasUserStyle
      ? '禁止用下拉风格覆盖主题画风'
      : `点名「${styleCn}」「${styleGuide.medium}」；${styleGuide.avoid}`
  }

【audioDescription / voiceover】
- audioDescription：环境音效，如「淅沥雨声、木船轻微摇晃声、灯火燃烧声」
- voiceover：中文口播；可前缀语气，如「[年轻女声/温柔自然] 姑娘们，…」

【站位承接 / duration】
- 末态=下一镜起始；道具连续；景别起伏；每镜 5–10 秒且有差异；口播匹配时长

【硬性要求】
- aesthetic 必须看得出用户主题画风
- 每个 visualPrompt 必须锁同一套主题画风
- 直接输出合法 JSON，无解释无 markdown 无思考标签`
    },
    {
      role: 'user',
      content: userContent
    }
  ]

  const baseUrl = import.meta.env.VITE_LLM_BASE_URL
  const model = import.meta.env.VITE_LLM_MODEL
  log(
    `→ 调用 LLM: ${baseUrl}/chat/completions (model: ${model}, images: ${input.productImages?.length ?? 0})`
  )

  const resp = await callLLM({
    messages,
    temperature: 0.65,
    jsonMode: !(input.productImages && input.productImages.length > 0),
    maxTokens: 12288
  })

  log(`← 收到响应 (${resp.content.length} 字符)`)
  if (resp.content.includes('<think>') || resp.content.includes('<reasoning>')) {
    log('⚠ 响应包含思考标签，使用鲁棒解析剥除')
  }

  const parsed = normalizeStoryboard(robustParseJson(resp.content), {
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

function optStr(v: unknown): string | undefined {
  const s = String(v ?? '').trim()
  return s || undefined
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
  const style = options.style ?? 'cinematic'
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
  const shotsIn = Array.isArray(raw?.shots) ? raw.shots : []
  const rawSubjects = Array.isArray(raw?.subjects) ? raw.subjects : []
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
    const voiceover = String(s?.voiceover || '')
    const purpose = optStr(s?.purpose)
    const shotSize = optStr(s?.shotSize)
    const blocking = optStr(s?.blocking)
    const eyeline = optStr(s?.eyeline)
    const continuity = optStr(s?.continuity)
    const propFocus = optStr(s?.propFocus)
    let visualPrompt = String(s?.visualPrompt || '').trim()

    // 画风缺失或过短：优先补用户主题画风，其次下拉风格
    visualPrompt = enrichVisualPrompt(visualPrompt, {
      style,
      userStyleLock: styleLockFromUser,
      shotSize,
      blocking,
      propFocus,
      purpose,
      sceneName: scenes.find((sc) => sc.id === (sceneIds[0] || defaultScn))?.name,
      sceneLighting: scenes.find((sc) => sc.id === (sceneIds[0] || defaultScn))?.lighting,
      sceneAnchor: scenes.find((sc) => sc.id === (sceneIds[0] || defaultScn))?.mainAnchor
    })

    // 若模型未把导演字段写进画面描述，自动拼装一层，保证下游配图/视频能吃到
    const draft: StoryboardShot = {
      title: String(s?.title || '镜头'),
      visualPrompt,
      audioDescription: String(s?.audioDescription || ''),
      voiceover,
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
    visualPrompt = composeShotVisualPrompt(
      {
        ...draft,
        id: `tmp_${i}`,
        index: i,
        status: 'draft'
      } as Shot,
      'base'
    )

    return { ...draft, visualPrompt }
  })

  const styleCn = styleLabel(style)
  const guide = VISUAL_STYLE_GUIDE[style]
  let aesthetic = optStr(raw?.aesthetic)
  if (styleLockFromUser) {
    // 主题画风优先：缺 aesthetic 时用主题浓缩；已有则不强制套下拉风格头
    if (!aesthetic) {
      aesthetic = styleLockFromUser
    } else {
      const tip = styleLockFromUser.split(/[；;\n]/)[0]?.trim().slice(0, 24)
      if (tip && !aesthetic.includes(tip) && tip.length >= 4) {
        aesthetic = `${styleLockFromUser}\n\n${aesthetic}`
      }
    }
  } else if (aesthetic && !promptMentionsStyle(aesthetic, style)) {
    aesthetic = `【${styleCn}·${guide.medium}】\n${aesthetic}`
  } else if (!aesthetic) {
    aesthetic = `【${styleCn}·${guide.medium}】\n${guide.sampleTail}`
  }

  return {
    aesthetic,
    styleBrief:
      optStr(raw?.styleBrief) ??
      (styleLockFromUser
        ? `画风严格遵循用户主题：${styleLockFromUser.split('\n')[0]}`
        : `${styleCn}短片，强调叙事节奏与视觉统一`),
    colorPalette: optStr(raw?.colorPalette),
    lightingNote: optStr(raw?.lightingNote),
    subjects,
    scenes,
    shots
  }
}

/** 补强过短或未点名画风的画面描述；有用户主题画风时绝不套下拉风格句 */
function enrichVisualPrompt(
  prompt: string,
  ctx: {
    style: VisualStyle
    userStyleLock?: string
    shotSize?: string
    blocking?: string
    propFocus?: string
    purpose?: string
    sceneName?: string
    sceneLighting?: string
    sceneAnchor?: string
  }
): string {
  const styleCn = styleLabel(ctx.style)
  const guide = VISUAL_STYLE_GUIDE[ctx.style]
  const userLock = ctx.userStyleLock?.trim()
  const header = userLock
    ? `【画风：${userLock.split('\n')[0].slice(0, 120)}】`
    : `【${styleCn}·${guide.medium}】`
  let body = prompt.trim()

  if (!body) {
    body = [
      ctx.sceneName ? `场景：${ctx.sceneName}` : '',
      ctx.sceneAnchor ? `主锚：${ctx.sceneAnchor}` : '',
      ctx.sceneLighting ? `光线：${ctx.sceneLighting}` : '',
      ctx.blocking ? `站位：${ctx.blocking}` : '',
      ctx.shotSize ? `景别：${ctx.shotSize}` : '',
      ctx.propFocus ? `道具：${ctx.propFocus}` : '',
      ctx.purpose ? `戏剧功能：${ctx.purpose}` : '',
      '画面需呈现完整环境材质、人物姿态表情与连贯动作，细节清晰可读。'
    ]
      .filter(Boolean)
      .join('。')
  }

  if (userLock) {
    const tokens = userLock
      .split(/[；;，,、\n\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
      .slice(0, 12)
    const hit = tokens.some((t) => body.includes(t))
    if (!hit && !body.startsWith('【画风')) {
      body = `${header}\n${body}`
    }
    // 结尾再用主题画风点一次，不用下拉 sampleTail
    const topicTip = userLock.split('\n')[0].slice(0, 80)
    if (topicTip && body.replace(/\s+/g, '').length < 200) {
      body = `${body.trim()}\n再次强调画风（来自用户主题）：${topicTip}`
    }
  } else {
    if (!promptMentionsStyle(body, ctx.style)) {
      body = `${header}${body}`
    }
    if (body.replace(/\s+/g, '').length < 160) {
      body = `${body.trim()}。${guide.sampleTail} 必须体现：${guide.mustInclude}。${guide.avoid}`
    } else if (!body.includes(guide.sampleTail.slice(0, 6))) {
      body = `${body.trim()}。${guide.sampleTail}`
    }
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
  onProgress?: (msg: string) => void
): Promise<StoryboardRunResult> {
  const mode = getAIMode()
  log(`当前 AI 模式：${mode}`)

  if (mode === 'real') {
    onProgress?.('🎯 正在调用 APIYI 大模型（专业编剧 + 镜头导演）...')
    try {
      const { result, model } = await realStoryboard(input)
      onProgress?.(`✓ 模型返回 ${result.shots.length} 个分镜`)
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 真实 LLM 调用失败：${msg}`)
      console.warn('[storyboard] 回退到 mock：', e)
      onProgress?.(`⚠ 大模型失败：${msg.slice(0, 100)}，回退演示`)
      const result = normalizeStoryboard(
        mockStoryboardFromPrompt(
          `style: ${input.style} duration: ${input.shotDuration} """${input.content}"""`
        ),
        {
          style: input.style,
          topic: input.topic,
          content: input.content,
          keywords: input.keywords
        }
      )
      return { result, source: 'mock-fallback', error: msg }
    }
  }

  onProgress?.('🎭 演示模式（未配置 VITE_AI_REAL_MODE=true）')
  const result = normalizeStoryboard(
    mockStoryboardFromPrompt(
      `style: ${input.style} duration: ${input.shotDuration} """${input.content}"""`
    ),
    {
      style: input.style,
      topic: input.topic,
      content: input.content,
      keywords: input.keywords
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
    audioDescription: s.audioDescription ?? '',
    voiceover: s.voiceover,
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
  script: Pick<Script, 'aesthetic' | 'styleBrief' | 'colorPalette' | 'lightingNote'>,
  result: StoryboardResult
) {
  if (result.aesthetic) script.aesthetic = result.aesthetic
  if (result.styleBrief) script.styleBrief = result.styleBrief
  if (result.colorPalette) script.colorPalette = result.colorPalette
  if (result.lightingNote) script.lightingNote = result.lightingNote
}
