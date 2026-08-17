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
import type { Scene, Script, Shot, Subject, VisualStyle } from '@/types'
import { composeShotVisualPrompt } from '@/utils/shotPrompt'
import { getSkillBody } from '@/skills'
import { getLlmConfig } from './runtime'
import {
  buildStyleBriefForLLM,
  extractUserMediumPhrase,
  lookFromTexts,
  mediumLockText,
  promptHasTechnique,
  promptMentionsStyle,
  resolveVisualStyle,
  styleLabel,
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
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const fallback = buildStyleBriefForLLM(look.style)
  const mediumPhrase = extractUserMediumPhrase(input.topic, input.content, ...(input.keywords ?? []))

  if (mediumPhrase) {
    const technique = look.matched
      ? `2. 按该媒介的专业技法写：${VISUAL_STYLE_GUIDE[look.matched].mustInclude}
3. ${VISUAL_STYLE_GUIDE[look.matched].avoid}
4. 结尾锁一句：「${VISUAL_STYLE_GUIDE[look.matched].sampleTail}」`
      : `2. 按「${mediumPhrase}」这个媒介本身的专业做法写（材料、技法、光影、质感），写到画师能直接画。
3. 禁止改写成用户没点名的其他画风，也不要用页面下拉的默认风格覆盖。`

    return `【画风听用户的 · 硬性】
用户点名了画风。这是全片最高优先级。
禁止翻译成别的画风套话，除非用户要的就是那个。
禁止只写剧情不写媒介。

用户点名的画风原词（必须出现在每一镜 visualPrompt 的第一句）：「${mediumPhrase}」

用户主题/画风原文：
"""
${userAuth}
"""

每一镜 visualPrompt 必须：
1. 第一句写出画风，用用户原词「${mediumPhrase}」，不要改成英文标签。
${technique}

${look.matched ? `已对上已知画种：${styleLabel(look.matched)}\n${fallback}` : '这是用户自定义画风，不要套页面下拉风格。'}`
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
- 图里有人/动物/吉祥物，列为 subjects，外貌按图里真实样子写，fromReference=true，别另造一张脸
- 图里是产品，列为 kind=other，按真实产品写
- 后面每一镜的人都要和 subjects 同一套衣服、发型、年龄
- 产品/主角每镜都要让人看清`
      : `
【没有参考图】
先从文案里列出会反复出现的人/动物（subjects）和地点（scenes）。
同一人全片同一套外貌：名字、年龄、发型、衣服、配饰不要变着写。`

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

  const userText = `按编剧手册把这段文案拆成能拍的分镜。口播要能念，画面用中文白话写给摄像，别写英文提示词沙拉。

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

顺序：先锁人物和地点，再拆镜头。每镜写清干什么、口播、时长、镜头怎么动、画面里发生什么。
${
  hasUserStyle
    ? `画风硬性：每一镜 visualPrompt 第一句必须出现用户原词「${mediumPhrase}」。按这个媒介自己的专业技法写，禁止偷换成用户没点名的其他画风。`
    : `主题没提画风时，画面里带上「${styleCn} / ${styleGuide.medium}」。`
}
直接输出 JSON，不要解释。`

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
      content: `${directorPlaybook}

${productNote}

${stylePriority}

【字段全用简体中文】aesthetic、visualPrompt 也是中文白话，像跟摄像说戏。禁止 cinematic / aesthetic / film grain / premium 这类英文标签堆砌。

【输出 JSON】
{
  "aesthetic": "<一两句人话，说出全片味道，用用户主题里的词>",
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
      "description": "<人还没进来时这个地方什么样，80字以上>",
      "mainAnchor": "<摄像能对着的实在东西>",
      "lighting": "<时辰和光源>"
    }
  ],
  "shots": [
    {
      "title": "场记板上能写的 3-8 字",
      "purpose": "钩子/说明/反应/揭示/收口",
      "shotSize": "<远近 + 为什么>",
      "blocking": "<相对主锚站哪、脸朝哪>",
      "eyeline": "<看谁/看哪>",
      "continuity": "<开始什么样 → 这几秒变了啥 → 结束定在哪>",
      "propFocus": "<这镜要看清的物件，没有写无>",
      "visualPrompt": "<第一句必须写出用户点名的画风原词。接着白话说戏：在哪、什么光、谁、穿什么、正在干什么。必须含该媒介技法，禁止只写剧情不写画风>",
      "audioDescription": "<现场能听到的，逗号分隔>",
      "voiceover": "<这一镜要念的；没有就空字符串>",
      "duration": <5-10>,
      "cameraMovement": "push|pull|pan|tilt|static|orbit",
      "subjectIds": ["sub_1"],
      "sceneId": "scn_1"
    }
  ]
}

画风：用户原词 > 主题原文 > 下拉「${styleCn}」（仅主题完全没提时）。
每一镜 visualPrompt 若缺少画风句，视为不合格。
${hasUserStyle && !look.matched ? '这是自定义画风，不要套页面下拉风格。' : `${styleGuide.avoid}。`}
口播大约每秒 4 个字；前后镜人的位置和手里的东西要接上。
只输出合法 JSON。`
    },
    {
      role: 'user',
      content: userContent
    }
  ]

  const { baseUrl, model } = getLlmConfig()
  log(
    `→ 调用 LLM: ${baseUrl}/chat/completions (model: ${model}, images: ${input.productImages?.length ?? 0})`
  )

  const resp = await callLLM({
    messages,
    temperature: 0.72,
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
      look: lookFromTexts(style, options.topic, options.content, options.keywords),
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

  const look = lookFromTexts(style, options.topic, options.content, options.keywords)
  const styleCn = styleLabel(look.matched ?? style)
  const guide = look.matched ? VISUAL_STYLE_GUIDE[look.matched] : VISUAL_STYLE_GUIDE[style]
  let aesthetic = optStr(raw?.aesthetic)
  if (look.userNamed) {
    if (!aesthetic) {
      aesthetic = `【画风锁定】${look.medium}\n${mediumLockText(look)}`
    } else if (!aesthetic.includes(look.medium)) {
      aesthetic = `【画风锁定】${look.medium}\n${aesthetic}`
    }
    if (look.matched && !promptHasTechnique(aesthetic, look.matched)) {
      aesthetic = `${aesthetic}\n${guide.sampleTail}。${guide.avoid}`
    } else if (!look.matched && !aesthetic.includes('必须按用户原词')) {
      aesthetic = `${aesthetic}\n${mediumLockText(look)}`
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
        : `${styleCn}短片，先让人看下去，再把事讲清楚`),
    colorPalette: optStr(raw?.colorPalette),
    lightingNote: optStr(raw?.lightingNote),
    subjects,
    scenes,
    shots
  }
}

/** 只认画风词，剧名命中不算已经写了画风。自定义画风不套下拉技法。 */
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
  const lock = mediumLockText(look)
  const header = `【画风锁定】${look.medium}。${lock}`
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

  const hasMedium = look.userNamed
    ? body.includes(look.medium) ||
      (look.matched != null && promptMentionsStyle(body, look.matched))
    : promptMentionsStyle(body, look.style)

  if (!hasMedium) {
    body = `${header}\n${body}`
  } else if (look.matched && !promptHasTechnique(body, look.matched)) {
    const g = VISUAL_STYLE_GUIDE[look.matched]
    body = `${body.trim()}\n${g.sampleTail} 必须体现：${g.mustInclude}。${g.avoid}`
  } else if (look.userNamed && !look.matched && !body.includes('必须按用户原词')) {
    body = `${body.trim()}\n${lock}`
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
  const look = lookFromTexts(input.style, input.topic, input.content, input.keywords)
  const resolved: StoryboardInput = { ...input, style: look.style }
  if (look.matched && look.matched !== input.style) {
    log(`画风已从用户原话对上已知画种：${input.style} → ${look.matched}（${look.medium}）`)
  } else if (look.userNamed && !look.matched) {
    log(`画风按用户原词锁定：${look.medium}（不套下拉枚举）`)
  }
  log(`当前 AI 模式：${mode}`)

  if (mode === 'real') {
      onProgress?.(`正在按「${look.medium}」拆能拍的镜头...`)
    try {
      const { result, model } = await realStoryboard(resolved)
      onProgress?.(`✓ 模型返回 ${result.shots.length} 个分镜`)
      return { result, source: 'real', model }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      log(`✗ 真实 LLM 调用失败：${msg}`)
      console.warn('[storyboard] 回退到 mock：', e)
      onProgress?.(`⚠ 大模型失败：${msg.slice(0, 100)}，回退演示`)
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
      return { result, source: 'mock-fallback', error: msg }
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
