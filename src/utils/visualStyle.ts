/**
 * 画面风格词库：给 LLM 分镜 / 配图 / 人设共用
 * 避免只传英文枚举（cinematic）导致模型写成空泛提示。
 */

import type { VisualStyle } from '@/types'

export const VISUAL_STYLE_LABEL: Record<VisualStyle, string> = {
  cinematic: '电影感',
  anime: '日系动画',
  photorealistic: '写实摄影',
  '3d-render': '三维渲染',
  'oil-painting': '古典油画',
  watercolor: '水彩画',
  'pixel-art': '复古像素',
  'ink-wash': '中国水墨'
}

/** 用户口语别名。更长短语在前，便于从原文抽出「水墨风」而不是只命中「墨」 */
export const STYLE_ALIASES: Record<VisualStyle, string[]> = {
  'ink-wash': [
    '中国水墨画',
    '中国水墨',
    '水墨写意',
    '水墨风格',
    '水墨风',
    '水墨画',
    '写意画',
    'ink-wash',
    'ink wash',
    'inkwash',
    '水墨',
    '国画',
    '写意',
    '工笔',
    '宣纸'
  ],
  watercolor: ['水彩画风', '水彩画', '水彩风', 'watercolor', '水彩'],
  'oil-painting': ['古典油画', '油画风', 'oil painting', 'oil-painting', '厚涂', '油画'],
  'pixel-art': ['像素风格', '像素风', 'pixel-art', 'pixel art', '像素画', '像素'],
  '3d-render': ['三维渲染', '3d渲染', '3d-render', 'blender', 'octane', 'c4d'],
  anime: ['日系动画', '二次元', '赛璐璐', '动漫风', '动画风', 'anime', '动漫', '动画'],
  photorealistic: ['写实摄影', '超写实', 'photorealistic', '纪实摄影', '真人实拍'],
  cinematic: ['电影剧照', '院线电影', '胶片摄影', '电影感', 'cinematic', '胶片颗粒']
}

const INFER_ORDER: VisualStyle[] = [
  'ink-wash',
  'watercolor',
  'oil-painting',
  'pixel-art',
  '3d-render',
  'anime',
  'photorealistic',
  'cinematic'
]

const TECHNIQUE_HINT: Record<VisualStyle, RegExp> = {
  'ink-wash': /宣纸|墨色|墨分|焦浓|浓淡|留白|飞白|晕染|笔锋/,
  watercolor: /晕染|水渍|纸纹|渗化|透明叠色/,
  'oil-painting': /厚涂|笔触|布面|伦勃朗/,
  'pixel-art': /像素格|色板|抖动/,
  '3d-render': /pbr|全局光|octane|blender/i,
  anime: /赛璐璐|线稿|分阶|眼睛高光/,
  photorealistic: /毛孔|浅景深|纪实|织物纹理/,
  cinematic: /胶片|剧照|景深|焦段|光比|颗粒/
}

/** 每种风格必须写进 visualPrompt 的媒介/技法锚点 */
export const VISUAL_STYLE_GUIDE: Record<
  VisualStyle,
  {
    medium: string
    mustInclude: string
    avoid: string
    sampleTail: string
  }
> = {
  cinematic: {
    medium: '电影剧照 / 胶片摄影',
    mustInclude:
      '电影级调色、浅景深或景深层次、戏剧光比、镜头焦段感（如 35mm/50mm/85mm）、胶片颗粒或电影感对比、构图留白与引导线',
    avoid: '禁止写成扁平插画、禁止二次元大眼睛、禁止卡通描边',
    sampleTail:
      '整体如院线电影剧照：青橙或暖冷对比调色，柔和胶片颗粒，高光克制，阴影通透，电影感构图。'
  },
  anime: {
    medium: '日系动画赛璐璐 / 剧场版动画帧',
    mustInclude:
      '清晰线稿或干净色块、赛璐璐上色、动画光影分阶、发丝与眼睛高光、二次元比例与表情、背景可略简化但空间清楚',
    avoid: '禁止写成实拍照片、禁止真实皮肤毛孔、禁止油画笔触',
    sampleTail:
      '日系动画剧场版画风：干净线稿、赛璐璐上色、眼睛高光鲜明，背景有空气透视，整体明亮有动画感。'
  },
  photorealistic: {
    medium: '商业摄影 / 纪实摄影',
    mustInclude:
      '真实材质与微细节（皮肤毛孔/织物纹理）、自然物理光、相机感（光圈景深、轻微镜头畸变可选）、可信的环境反射',
    avoid: '禁止动漫脸、禁止明显笔触、禁止卡通描边',
    sampleTail:
      '超写实摄影质感：自然光与真实材质细节，浅景深，商业摄影级清晰度，无插画笔触。'
  },
  '3d-render': {
    medium: '三维渲染 / C4D·Blender·Octane',
    mustInclude:
      'PBR 材质、全局光照、柔和区域光或 HDRI、干净建模边缘、次表面散射（人物皮肤）、产品级高光反射',
    avoid: '禁止手绘笔触、禁止像素块、禁止水墨晕染',
    sampleTail:
      '高质量三维渲染：PBR 材质、全局光照与柔和反射，建模干净，如 Octane/Blender 出品。'
  },
  'oil-painting': {
    medium: '古典油画',
    mustInclude:
      '可见笔触与厚涂、油画布纹理、古典光影（如伦勃朗光）、颜料层叠与色块混合、博物馆级构图',
    avoid: '禁止数码锐利照片感、禁止赛璐璐平涂、禁止像素风',
    sampleTail:
      '古典油画质感：厚涂笔触、布面纹理、戏剧明暗，色彩沉稳如博物馆藏画。'
  },
  watercolor: {
    medium: '水彩画',
    mustInclude:
      '水彩晕染与水渍、纸纹透出、透明叠色、边缘偶尔渗化、留白呼吸感',
    avoid: '禁止厚重油画堆砌、禁止超写实照片、禁止硬边缘矢量风',
    sampleTail:
      '水彩画风：透明叠色与自然晕染，纸纹隐现，边缘柔和渗化，清透抒情。'
  },
  'pixel-art': {
    medium: '复古像素艺术',
    mustInclude:
      '明确像素格子、有限色板、无抗锯齿或受控抖动、16-bit/32-bit 游戏风、可读轮廓',
    avoid: '禁止高清照片、禁止平滑矢量渐变、禁止写实毛孔',
    sampleTail:
      '复古像素画风：清晰像素格、有限色板、轻微抖动，如经典主机游戏画面。'
  },
  'ink-wash': {
    medium: '中国水墨 / 宣纸写意',
    mustInclude:
      '墨分五色（焦浓重淡清）、干湿飞白、中锋侧锋提按、大面积留白、宣纸纤维与水渍、写意人物衣纹或淡远山水',
    avoid:
      '禁止真人照片与皮肤毛孔、禁止摄影棚灰底三视图、禁止塑料三维、禁止赛璐璐平涂、禁止西方油画厚涂、禁止电影胶片调色套话',
    sampleTail:
      '中国水墨写意：宣纸上的笔墨，焦浓重淡清层次分明，飞白与留白得当，衣纹中锋勾勒，远景淡墨晕开，纸纹隐现。'
  }
}

export function styleLabel(style: VisualStyle): string {
  return VISUAL_STYLE_LABEL[style] || style
}

function joinedText(...texts: Array<string | undefined>): string {
  return texts.filter(Boolean).join('\n')
}

function flattenTexts(...texts: Array<string | string[] | undefined>): string[] {
  return texts.flatMap((t) => (Array.isArray(t) ? t : t ? [t] : []))
}

/** 不是画风的「X风」 */
const MEDIUM_STOP = new Set([
  '台风',
  '作风',
  '学风',
  '校风',
  '门风',
  '家风',
  '文风',
  '民风',
  '通风',
  '漏风',
  '吹风',
  '刮风',
  '整风',
  '党风',
  '口风',
  '耳风',
  '上风',
  '下风',
  '中风',
  '逆风',
  '顺风',
  '威风',
  '风风',
  '风光',
  '风险',
  '风波',
  '风声',
  '风头',
  '风凉'
])

const OPEN_MEDIUM_CUE =
  /风格|画风|质感|电影感|动画|动漫|二次元|写实|摄影|渲染|油画|水彩|像素|水墨|赛博|蒸汽朋克|复古|胶片|手绘|插画|国风|赛璐璐|厚涂|扁平|3d|黏土|粘土|剪纸|皮影|浮世绘|波普|定格|卡通|q版|cel-shad/

/** 卡通渲染 / Q 版 / Cel-shading：词库里没有独立枚举，不能落到「像素」或写实 PBR 3D */
const CEL_SHADE_PHRASE =
  /卡通渲染(?:（Cel-shading）)?(?:\s*3D)?(?:\s*[+＋]\s*)?(?:Q\s*版(?:人物)?)?|Cel-shading(?:\s*3D)?|Q\s*版人物|卡通\s*3D|3D\s*卡通/i

function extractCelShadePhrase(blob: string): string {
  const hit = blob.match(CEL_SHADE_PHRASE)
  if (!hit?.[0]) return ''
  return hit[0].replace(/\s+/g, ' ').trim()
}

/** 从用户原话抽出画风词：先抓「X风/X风格」，再匹配已知画种。剧名不算画风。 */
export function extractUserMediumPhrase(...texts: Array<string | undefined>): string {
  const blob = joinedText(...texts)
  if (!blob.trim()) return ''

  const cel = extractCelShadePhrase(blob)
  if (cel) return cel

  const open: string[] = []
  for (const m of blob.matchAll(/([\u4e00-\u9fffA-Za-z0-9]{1,12}(?:风格|画风))/g)) {
    if (m[1]) open.push(m[1])
  }
  for (const m of blob.matchAll(/([\u4e00-\u9fffA-Za-z]{2,8}风)/g)) {
    const w = m[1]
    if (w && !MEDIUM_STOP.has(w)) open.push(w)
  }
  open.sort((a, b) => b.length - a.length)
  if (open[0]) return open[0]

  const lower = blob.toLowerCase()
  const ranked = INFER_ORDER.flatMap((style) =>
    STYLE_ALIASES[style].map((alias) => ({ alias, style }))
  ).sort((a, b) => b.alias.length - a.alias.length)

  for (const { alias } of ranked) {
    if (alias.length < 2) continue
    const hit = /[a-z]/i.test(alias) ? lower.includes(alias.toLowerCase()) : blob.includes(alias)
    if (hit) return alias
  }

  const compact = blob.replace(/\s+/g, '')
  if (compact.length > 0 && compact.length <= 16 && OPEN_MEDIUM_CUE.test(compact)) {
    return blob.trim().slice(0, 24)
  }
  return ''
}

/** 主题/文案里点名了哪种画风。未点名返回 null，不要默认电影感。 */
export function inferVisualStyleFromText(...texts: Array<string | undefined>): VisualStyle | null {
  const blob = joinedText(...texts)
  if (!blob.trim()) return null
  // 点了卡通渲染 / Q 版就不要对成词库里的像素或写实三维
  if (extractCelShadePhrase(blob)) return null
  const lower = blob.toLowerCase()
  for (const style of INFER_ORDER) {
    const hit = STYLE_ALIASES[style].some((alias) => {
      if (alias.length < 2) return false
      return /[a-z]/i.test(alias) ? lower.includes(alias.toLowerCase()) : blob.includes(alias)
    })
    if (hit) return style
  }
  return null
}

export function resolveVisualStyle(
  fallback: VisualStyle,
  ...texts: Array<string | string[] | undefined>
): VisualStyle {
  const flat = flattenTexts(...texts)
  return inferVisualStyleFromText(...flat) ?? fallback
}

export interface VisualLook {
  /** 接口仍要枚举：仅当原文能对上已知画种时才改，否则保持下拉值 */
  style: VisualStyle
  /** 展示用：用户原词，或下拉风格中文名 */
  medium: string
  /** 原文对上的已知画种，对不上则为 null（黏土风、剪纸等） */
  matched: VisualStyle | null
  /** 用户原文里点名了画风（X风/X风格/已知画种），不是我们拿下拉名填的 */
  userNamed: boolean
}

export function lookFromTexts(
  fallback: VisualStyle,
  ...texts: Array<string | string[] | undefined>
): VisualLook {
  const flat = flattenTexts(...texts)
  const named = extractUserMediumPhrase(...flat)
  const matched = inferVisualStyleFromText(...flat)
  return {
    style: matched ?? fallback,
    medium: named || styleLabel(matched ?? fallback),
    matched,
    userNamed: Boolean(named)
  }
}

/** 只取正文里点名画风的行，避免把对白里的「电影」「风格」误当成全片画风。 */
export function styleLinesFromPlay(content?: string): string {
  return (content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /画风|视觉风格|画面风格|美术风格|绘制风格|风格要求|整体风格|画面质感/.test(line))
    .join('\n')
}

export function lookFromScript(
  script?: {
    style?: VisualStyle
    topic?: string
    content?: string
    keywords?: string[]
    aesthetic?: string
    styleBrief?: string
  } | null,
  ...extra: Array<string | undefined>
): VisualLook {
  const fallback = script?.style ?? 'cinematic'
  return lookFromTexts(
    fallback,
    script?.topic,
    script?.keywords,
    script?.aesthetic,
    script?.styleBrief,
    styleLinesFromPlay(script?.content),
    ...extra
  )
}

/** 用户点了非实拍媒介时，人设不要走摄影棚三视图 */
export function isPhotographicLook(look: VisualLook): boolean {
  if (look.matched) {
    return look.matched === 'cinematic' || look.matched === 'photorealistic'
  }
  if (look.userNamed) {
    return /电影|摄影|写实|实拍|纪实|胶片|剧照|真人/.test(look.medium)
  }
  return look.style === 'cinematic' || look.style === 'photorealistic'
}

/** 分镜/人设/配图共用的画风锁。有用户原词就锁原词；对得上词库才补该画种技法。 */
export function mediumLockText(look: VisualLook): string {
  if (look.userNamed && look.matched) {
    const userBit =
      look.medium !== styleLabel(look.matched)
        ? `必须按用户原词「${look.medium}」绘制。`
        : `必须按「${styleLabel(look.matched)}」绘制。`
    return `${userBit}${styleLockSuffix(look.matched)} ${professionalQualityLock(look.matched)}`
  }
  if (look.userNamed) {
    return `必须按用户原词「${look.medium}」绘制，用该媒介自己的材料、技法和质感做到专业完成度。禁止改成用户没写的其他画风。`
  }
  return `${styleLockSuffix(look.style)} ${professionalQualityLock(look.style)}`
}

export function promptHasTechnique(prompt: string, style: VisualStyle): boolean {
  return TECHNIQUE_HINT[style]?.test(prompt) ?? false
}

/** 该媒介的专业完成度句子，配图时强制追加 */
export function professionalQualityLock(style: VisualStyle): string {
  const locks: Record<VisualStyle, string> = {
    'ink-wash':
      '专业完成度：墨分五色（焦、浓、重、淡、清），笔锋有提按与飞白，宣纸纤维与水渍可见，构图大面积留白；禁止真人写真、禁止现代摄影棚、禁止光滑CG、禁止彩色厚涂油画。',
    watercolor:
      '专业完成度：透明叠色、纸纹与水渍自然，边缘渗化可控；禁止超写实照片，禁止厚重油画堆砌。',
    'oil-painting':
      '专业完成度：可见厚涂笔触与布面纹理，古典明暗；禁止数码锐利照片感。',
    'pixel-art':
      '专业完成度：清晰像素格、有限色板、轮廓可读；禁止高清照片平滑。',
    '3d-render':
      '专业完成度：PBR 材质、全局光照、干净建模；禁止手绘涂抹。',
    anime:
      '专业完成度：干净线稿与赛璐璐分阶，眼睛高光明确；禁止真人皮肤毛孔。',
    photorealistic:
      '专业完成度：真实材质与自然光，摄影级清晰；禁止插画笔触。',
    cinematic:
      '专业完成度：电影调色与光比，景深层次清楚；禁止扁平插画。'
  }
  return locks[style]
}

/** 写进 LLM system/user 的完整风格说明块 */
export function buildStyleBriefForLLM(style: VisualStyle): string {
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  if (!g) {
    return `用户选定画面风格：${style}。每镜 visualPrompt 必须明确写出该风格的媒介与技法。`
  }
  return `用户选定画面风格（必须严格遵守，不可换成别的画风）：
- 枚举值：${style}
- 中文名：${label}
- 媒介：${g.medium}
- 每镜 visualPrompt 必须写入：${g.mustInclude}
- ${g.avoid}
- 每镜结尾建议用类似句子锁风格：「${g.sampleTail}」
- aesthetic / colorPalette / lightingNote 也必须服务该风格，不要写成通用「电影感」套话（除非用户选的就是 cinematic）`
}

/** 配图 API 追加的短风格锁（中文，不用英文枚举） */
export function styleLockSuffix(style: VisualStyle): string {
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  if (!g) return `${label}风格，高清细节`
  return `${label}风格（${g.medium}），${g.sampleTail}`
}

/** 判断画面描述是否已体现该风格关键词（含口语别名，如「水墨风」） */
export function promptMentionsStyle(prompt: string, style: VisualStyle): boolean {
  const p = prompt.toLowerCase()
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  const keys = [
    style,
    label,
    g?.medium,
    ...(g?.medium.split(/[\/·]/) ?? []),
    ...STYLE_ALIASES[style]
  ]
    .filter(Boolean)
    .map((k) => String(k).toLowerCase().trim())
  return keys.some((k) => k.length >= 2 && p.includes(k))
}
