/**
 * 人设 / 场景底板提示词
 *
 * 媒介跟用户原话走：点了什么画风就按什么材料画。
 * 对得上已知画种时补该画种技法；对不上也锁用户原词，不拿水墨或电影感顶替。
 */

import type { Scene, Shot, Subject, VisualStyle } from '@/types'
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
    ? `【16:9】「${subject.name}」角色四视图。画风必须是「${medium}」。
干净浅色棚拍背景（无风景、无路人），从左到右正好四格、不要第五格：
1. 面部特写  2. 全身正面  3. 全身侧面  4. 全身背面。`
    : `【16:9】「${subject.name}」角色四视图。绘制媒介必须是「${medium}」。
从左到右正好四格：面部特写、全身正面、全身侧面、全身背面。身份特征锁死。
材料、笔触、质感必须符合「${medium}」。禁止用真人摄影棚或其他画风冒充。`

  return `${layout}
${refHint}${subject.description}

${kindHint}。四格必须是同一角色、同一服装、同一配色。不要拼贴无关人物，不要画道具拆解图。
${mediumLockText(resolved)}`
}

/** 这个角色身上有哪些东西：包、证件、平板、鞋、配饰，单独一张资产图 */
export function characterPropSheetPrompt(
  subject: Subject,
  style: VisualStyle,
  look?: VisualLook
): string {
  const resolved = look ?? lookFromTexts(style)
  const medium = resolved.medium
  const inventory =
    subject.props?.trim() ||
    '从角色描述里抽出穿戴和随身物：包、证件、平板、鞋、帽子、配饰、手里常拿的东西。没有明显物件就画服装关键细节（扣、领、鞋、口袋）。'

  return `【16:9】「${subject.name}」角色资产图 / 随身物件设定。画风必须是「${medium}」。
浅色干净背景，像道具说明书：把这个角色身上会出现的东西各自摆清楚，能看清形状、材质、颜色、logo。
清单：${inventory}
角色描述（用来对上款式，不要再画全身人）：${subject.description}

只画物件，不要再画完整人物四视图。每件东西单独完整，便于后面分镜当参考。
${mediumLockText(resolved)}`
}

/** 单镜故事看板：六格黑白草图，锁定同一镜头内的动作时间线。 */
export function shotBoardPrompt(
  shot: Pick<
    Shot,
    | 'title'
    | 'duration'
    | 'cameraMovement'
    | 'shotSize'
    | 'blocking'
    | 'continuity'
    | 'visualPrompt'
    | 'videoPrompt'
    | 'boardPrompt'
    | 'propFocus'
    | 'voiceover'
    | 'audioMode'
  >,
  _style: VisualStyle,
  _look?: VisualLook
): string {
  const body = (shot.boardPrompt || shot.visualPrompt || shot.title).trim()
  const size = shot.shotSize ? `景别：${shot.shotSize}。` : ''
  const blocking = shot.blocking ? `站位：${shot.blocking}。` : ''
  const prop = shot.propFocus && shot.propFocus !== '无' ? `关键道具：${shot.propFocus}。` : ''
  const continuity = shot.continuity ? `动作承接：${shot.continuity}。` : ''
  const performance = shot.videoPrompt?.trim()
    ? `动态表演：${shot.videoPrompt.trim()}。`
    : ''
  const voiceMode = shot.audioMode ?? 'h3-dialogue'
  const dialogue = shot.voiceover?.trim()
    ? voiceMode === 'h3-voiceover' || voiceMode === 'tts' || voiceMode === 'none'
      ? `这是画外音镜头，不是对白镜头。六格里所有出镜人物都必须闭嘴，禁止张嘴念词或对口型。被叫到名字的人只做听见、停步、回头、寻找等反应。口播原文只用来理解情绪，禁止画字幕、编号或气泡：${shot.voiceover.trim()}。`
      : (() => {
          const speaker = shot.voiceover.trim().match(/^([^：:\n]{1,12})[：:]/)?.[1]?.trim()
          return `这是${speaker ? `「${speaker}」` : '当前说话者'}的对白镜头：开口前构图必须先明确落到${speaker || '当前说话者'}身上，使其成为唯一主视觉，脸和嘴清楚可见；其他人物可以同框但必须闭嘴，只做视线和表情反应。对白发生在动作中段或反应段：${shot.voiceover.trim()}。画面里禁止出现对白文字或气泡。`
        })()
    : ''
  const camera =
    shot.cameraMovement === 'push'
      ? '六格中人物和关键物逐格自然变大，表现同一次缓慢推进。'
      : shot.cameraMovement === 'pull'
        ? '六格中画面逐格自然变宽，表现同一次缓慢拉远。'
        : shot.cameraMovement === 'pan'
          ? '六格保持人物比例，背景与构图逐格横向移动，表现同一次平摇。'
          : shot.cameraMovement === 'tilt'
            ? '六格保持人物比例，构图逐格纵向移动，表现同一次俯仰。'
            : shot.cameraMovement === 'orbit'
              ? '六格中观察角度逐格小幅变化，保持同一人物、同一空间关系。'
              : '六格机位和景别完全相同，只让人物动作、表情与道具状态连续变化。'

  return `【16:9 单镜动作故事看板】「${shot.title}」，总时长 ${shot.duration} 秒。
生成一张 3 列 × 2 行、正好六格的导演分镜草图，阅读顺序为左上到右下。六格是同一个连续镜头在六个时间点的采样，不是六个不同场景，也不是六个独立镜头。

画面风格：白底、黑色或浅灰铅笔线稿，线条简洁，少量灰面辅助空间关系；人物用清楚的简笔轮廓表达动作。禁止精致上色、禁止电影海报、禁止写实渲染。
版式要求：六格大小整齐，细线分隔。画面内不出现标题、编号、时间码、字幕、对白气泡、说明文字、水印或任何可读文字。

六格动作节奏：
第一格建立 0 秒的起始构图和人物初始状态；第二格做动作准备；第三格动作开始；第四格完成核心动作；第五格表现对白/反应和道具状态变化；第六格锁定本镜结束状态，供下一镜或视频末帧承接。
${camera}

连续性硬约束：六格必须是同一地点、同一时段、同一批人物、同一张脸、同一发型服装、同一道具；人物不能凭空增加、消失、换装或换边，道具状态只能沿时间顺序变化。保持屏幕方向、站位关系、光源方向和场景主锚一致。
${size}${blocking}${prop}${continuity}${performance}${dialogue}
${body}

参考图必须用上：人物轮廓、脸、服装跟角色设计图；地点、光、地面跟场景图。禁止另造人物或地点。最终只输出这一张六格黑白故事看板。`
}

export function scenePlatePrompt(scene: Scene, style: VisualStyle, look?: VisualLook): string {
  const resolved = look ?? lookFromTexts(style)
  const medium = resolved.medium
  const lighting = scene.lighting?.trim() || '与文案匹配的主光源'
  const main = scene.mainAnchor?.trim() || '这个地点里最能对焦的实物'
  const extra = scene.anchors?.trim()
  const grid = extra
    ? `四格按这个清单来：${extra}。不够四项就用全景、主锚「${main}」、地面站位区、光源「${lighting}」补齐。`
    : `从左到右、从上到下正好四格：
1. 全景空镜（能认出这是「${scene.name}」）
2. 主锚特写（${main}）
3. 地面 / 站位区（人之后会踩在这里）
4. 光源或次锚（${lighting}）`

  const photo = isPhotographicLook(resolved)
  const lead = photo
    ? `【16:9】「${scene.name}」场景锚点图 / 四宫格。画风必须是「${medium}」。干净、像场景设定表。`
    : `【16:9】「${scene.name}」场景锚点图 / 四宫格。绘制媒介必须是「${medium}」。材料与质感必须符合「${medium}」，禁止用实景照片或其他画风冒充。`

  return `${lead}
${scene.description}
${grid}

这是锚点图，不是成片：四格必须是同一地点、同一时段、同一套材质。
画面里绝对不能有：人物、人脸、手脚、剪影、模特、假人、路人、人群、镜子或玻璃里的人影、人形雕像。
只画建筑、家具、地面、门窗、主锚物件和光。一个活物都没有。
禁止把四格合成一张宽画幅风景。
${mediumLockText(resolved)}`
}
