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
    medium: '中国水墨画',
    mustInclude:
      '墨色浓淡干湿、飞白与留白、笔锋提按、山水或写意人物意趣、宣纸感',
    avoid: '禁止西方油画厚涂、禁止赛璐璐动漫、禁止超写实摄影',
    sampleTail:
      '中国水墨写意：墨色层层晕染，飞白与留白得当，笔锋有提按，宣纸质感。'
  }
}

export function styleLabel(style: VisualStyle): string {
  return VISUAL_STYLE_LABEL[style] || style
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

/** 判断画面描述是否已体现该风格关键词（粗检） */
export function promptMentionsStyle(prompt: string, style: VisualStyle): boolean {
  const p = prompt.toLowerCase()
  const label = styleLabel(style)
  const g = VISUAL_STYLE_GUIDE[style]
  const keys = [style, label, g?.medium, ...(g?.medium.split(/[\/·]/) ?? [])]
    .filter(Boolean)
    .map((k) => String(k).toLowerCase().trim())
  return keys.some((k) => k.length >= 2 && p.includes(k))
}
