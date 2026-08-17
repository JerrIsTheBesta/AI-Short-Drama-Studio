/**
 * 人设 / 场景底板提示词
 *
 * 媒介跟用户原话走：点了什么画风就按什么材料画。
 * 对得上已知画种时补该画种技法；对不上也锁用户原词，不拿水墨或电影感顶替。
 */

import type { Scene, Subject, VisualStyle } from '@/types'
import {
  isPhotographicLook,
  lookFromTexts,
  mediumLockText,
  type VisualLook
} from '@/utils/visualStyle'

export function characterSheetPrompt(
  subject: Subject,
  style: VisualStyle,
  hasReferencePhotos: boolean,
  look?: VisualLook
): string {
  const resolved = look ?? lookFromTexts(style)
  const medium = resolved.medium
  const kindHint =
    subject.kind === 'animal'
      ? '同一只动物，品种、斑纹、毛发/羽毛完全一致'
      : subject.kind === 'other'
        ? '同一物体/吉祥物，材质、标志、颜色与轮廓完全一致'
        : '同一人物，脸型、年龄、发型、体型、服装与配饰完全一致'

  const refHint = hasReferencePhotos
    ? '附件参考图已展示该角色，必须严格按参考图复制身份特征，禁止另造一张脸或换装。'
    : ''

  const layout = isPhotographicLook(resolved)
    ? `【16:9】「${subject.name}」角色设定图 / 人设多角度。画风必须是「${medium}」。
干净浅色棚拍背景（无风景、无路人）：全身正面、四分之三侧面、侧面轮廓、背面、面部特写、1-2 个自然姿势。`
    : `【16:9】「${subject.name}」角色设定图。绘制媒介必须是「${medium}」，同一人多角度（全身、半身、侧脸），身份特征锁死。
材料、笔触、质感必须符合「${medium}」。禁止用真人摄影棚三视图或其他画风冒充。`

  return `${layout}
${refHint}${subject.description}

${kindHint}。所有分格必须是同一角色、同一服装、同一配色。不要拼贴无关人物。
${mediumLockText(resolved)}`
}

export function scenePlatePrompt(scene: Scene, style: VisualStyle, look?: VisualLook): string {
  const resolved = look ?? lookFromTexts(style)
  const medium = resolved.medium
  const lighting = scene.lighting ? `光线：${scene.lighting}。` : ''
  const anchor = scene.mainAnchor ? `场景主锚：${scene.mainAnchor}。` : ''
  const photo = isPhotographicLook(resolved)
  const lead = photo
    ? `「${scene.name}」空镜场景底板。画风必须是「${medium}」。宽画幅环境，仅有场景。禁止人物、面孔、动物、角色、文字。`
    : `「${scene.name}」空镜场景底板。绘制媒介必须是「${medium}」。无人、无动物、无文字。场景的材料与质感必须符合「${medium}」，禁止用实景照片或其他画风冒充。`

  return `${lead}
${scene.description}
${anchor}${lighting}

清晰呈现建筑、材质、时段与光线，便于后续镜头复用同一地点。
${mediumLockText(resolved)}`
}
