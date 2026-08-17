/**
 * 人设 / 场景底板提示词
 *
 * 配图工作流吃 3 张图：角色设计图 ×2 + 场景底板。
 * 人设图必须是「一张图里多种角度/形态」，用来锁身份。
 */

import type { Scene, Subject, VisualStyle } from '@/types'
import { styleLockSuffix } from '@/utils/visualStyle'

export function characterSheetPrompt(
  subject: Subject,
  style: VisualStyle,
  hasReferencePhotos: boolean
): string {
  const kindHint =
    subject.kind === 'animal'
      ? '同一只动物，品种、斑纹、毛发/羽毛完全一致'
      : subject.kind === 'other'
        ? '同一物体/吉祥物，材质、标志、颜色与轮廓完全一致'
        : '同一人物，脸型、年龄、发型、体型、服装与配饰完全一致'

  const refHint = hasReferencePhotos
    ? '附件参考图已展示该角色，必须严格按参考图复制身份特征，禁止另造一张脸或换装。'
    : ''

  return `【16:9】「${subject.name}」角色设定图 / 人设三视图。
${refHint}${subject.description}

单张图完成，${kindHint}。
布局为专业概念设定：干净浅色棚拍背景（无风景、无路人）：
- 全身正面
- 四分之三侧面
- 侧面轮廓
- 背面
- 面部/头部特写
- 1-2 个额外姿势（站立与自然手势）

所有分格必须是同一角色、同一服装、同一配色。${styleLockSuffix(style)} 不要环境，不要拼贴无关人物。`
}

export function scenePlatePrompt(scene: Scene, style: VisualStyle): string {
  const lighting = scene.lighting ? `光线：${scene.lighting}。` : ''
  const anchor = scene.mainAnchor ? `场景主锚：${scene.mainAnchor}。` : ''
  return `「${scene.name}」空镜场景底板 / 建立镜头。
${scene.description}
${anchor}${lighting}

宽画幅环境，仅有场景。禁止人物、面孔、动物、角色、文字。
清晰呈现建筑、材质、时段、天气与光线，便于后续镜头复用同一地点。
${styleLockSuffix(style)}`
}
