/**
 * 画布智能体可选的分镜技能。
 * 通用手册仍是 storyboard-director；这里是额外套上的风格或短剧类型。
 */

export type StorySkillGroup = 'style' | 'genre'

export interface StorySkill {
  id: string
  name: string
  group: StorySkillGroup
  summary: string
  body: string
}

export const GENERAL_STORY_SKILL_ID = 'storyboard-director'
export const CUSTOM_STORY_SKILL_ID = 'custom'

export const STORY_SKILLS: StorySkill[] = [
  {
    id: 'style-fast-cut',
    name: '快切竖屏',
    group: 'style',
    summary: '钩子开场，一镜一件事，适合短视频信息流。',
    body: `# 快切竖屏

- 第一镜必须是钩子：冲突、反差，或一句没说完的话。禁止从风景空镜或人物介绍开场。
- 单镜 4–7 秒，只承载一个信息点。景别用跳切，少用缓慢横摇和环绕。
- 大约每三镜给一个小反转：身份、物件或台词态度变了。
- 说话镜头优先中近景，嘴要可读；反应镜可以比说话更短。
- 结尾停在下一秒必须回答的问题上，不要把结局讲完。
- videoPrompt 按秒写清切点，不要写成一段长调度。`
  },
  {
    id: 'style-long-take',
    name: '一镜一场',
    group: 'style',
    summary: '一场尽量一个镜头走完，靠走位和焦点。',
    body: `# 一镜一场

- 一场戏默认一个镜头。人物进出、递物、对峙都留在同一空间里完成。
- 时长用到模型允许的上限。靠走位、停步、转身和焦点转移叙事，不要切成反应碎片。
- 对白往来留在这一镜里。谁开口、谁侧身、谁挡住门口，都写进 blocking。
- 只有地点真正换了，或时间跳了，才新开一镜。
- visualPrompt 要能画出这一镜的起始构图；videoPrompt 从 0 秒写到落幅，中间不要假装切了镜头。`
  },
  {
    id: 'style-emotion',
    name: '情绪特写',
    group: 'style',
    summary: '脸、手和停顿比情节交代更重要。',
    body: `# 情绪特写

- 先写脸、手、呼吸和停顿，再补环境。环境只留能压住情绪的那一件东西。
- 反应镜可以长于动作镜。对白短，留白要写进 duration，不要用旁白把情绪解释完。
- 禁止每镜都是正脸居中。侧脸、低头、手挡住半张脸，按关系来。
- 目光看向对方、信、门或手里的物件。禁止无故看镜头。
- 一场里至少有一镜是手或物件的特写，用来托住没说出口的话。`
  },
  {
    id: 'style-montage',
    name: '蒙太奇',
    group: 'style',
    summary: '用并列画面压缩时间，少对白。',
    body: `# 蒙太奇

- 用一串看得见的动作压缩时间：准备、赶路、重复劳动、季节或关系变化。每条都是具体画面，禁止写「时间流逝」。
- 单条 3–6 秒，对白很少。声音写环境：脚步、门、雨、器械。
- 并列的几条要有同一物件或同一动作在变，观众能看出进程。
- 最后一条必须落回一个人物的脸或决定，不能停在空镜。
- 蒙太奇前后各留一镜交代从哪开始、落到哪。`
  },
  {
    id: 'genre-sweet',
    name: '甜宠短剧',
    group: 'genre',
    summary: '靠近、对视和小动作，误会要在画面里解开。',
    body: `# 甜宠短剧

- 关系推进靠靠近、对视、躲闪、递东西、改口。禁止用旁白宣布「他们喜欢上了」。
- 误会必须看见起因和解开的动作，本集内要有一次态度变化。
- 笑点来自反应和错位，不来自解释笑话。
- 景别偏中近景。两人同框时写清谁先看谁、谁先移开。
- 结尾留一个还没说完的亲近动作，或一句没接上的话。`
  },
  {
    id: 'genre-revenge',
    name: '逆袭打脸',
    group: 'genre',
    summary: '先给被轻视的证据，再当众反转。',
    body: `# 逆袭打脸

- 先拍被轻视的可见证据：座位、账单、原话、当众的眼神。至少两镜，不能一句旁白带过。
- 反转必须当众发生，并拿出物件、文件或对方说过的原话。禁止只靠旁白宣布胜利。
- 主角的反击是一个具体动作：放下、打开、念出、转身离开。围观者要有反应镜。
- 节奏前慢后快。铺垫镜可以停，打脸镜要短、硬。
- 结尾停在对方的表情或下一道门槛，不要把以后的人生讲完。`
  },
  {
    id: 'genre-suspense',
    name: '悬疑反转',
    group: 'genre',
    summary: '一镜一条线索，收在新问题上。',
    body: `# 悬疑反转

- 每镜只释放一条线索：物件、口误、时间对不上、谁不在场。不要一镜讲完真相。
- purpose 写清观众知道而角色不知道的，或角色知道而观众还不知道的。
- 线索用特写落地。说话的人可以在撒谎，画面上的物件不撒谎。
- 反转镜要回看前面出现过的物件或原话，禁止凭空扔出一个新人解释一切。
- 本集收口停在一个更大的问题上。已经展示的两个拍点之间不能跳过因果。`
  },
  {
    id: 'genre-family',
    name: '家庭伦理',
    group: 'genre',
    summary: '家里的桌、门和家常话，冲突不演讲。',
    body: `# 家庭伦理

- 空间是家：餐桌、门口、厨房、旧相册。人物关系写进谁坐哪、谁先夹菜、谁站着不进门。
- 冲突用家常话，不发表道理。一句顶一句，中间有停顿和家务动作。
- 代际必须入镜：长辈的手、晚辈的回避、同辈的圆场。至少一方在听。
- 景别偏中景，保留桌子和门。特写留给没说出口的那一下。
- 结尾落在一个还没收拾的物件或一句没回应的称呼。`
  },
  {
    id: 'genre-rebirth',
    name: '穿越重生',
    group: 'genre',
    summary: '先看见身份错位，规则用行动演示。',
    body: `# 穿越重生

- 开场先看见身份错位：称呼、旧伤、日期、不该在的衣服或手机。禁止先用独白解释设定。
- 今昔对照靠同一物件的两种状态，不要旁白复述前世年表。
- 世界规则用行动演示：什么不能做、做了会怎样。说明书对白最多一句，而且要有人当场拦住。
- 主角知道未来，其他人不知道。信息差要写进谁先动手。
- 本集只兑现一个前世后悔的具体场面，不要把整段人生重活一遍。`
  },
  {
    id: 'genre-ceo',
    name: '霸总都市',
    group: 'genre',
    summary: '用距离、座位和谁先开口写权力。',
    body: `# 霸总都市

- 权力用空间写：谁坐、谁站、桌子有多宽、谁先开口、谁的车先停。禁止用旁白介绍身家。
- 场景优先办公室、电梯、宴会、车内。服装和配饰是身份，不是空泛的「很贵」。
- 对白短。一句定调，下一镜给对方的反应。不要互相反复解释动机。
- 靠近必须有理由：递文件、挡门、改座位。禁止无故贴脸。
- 结尾留一个身份或合同上的新缺口。`
  },
  {
    id: 'genre-commerce',
    name: '口播带货',
    group: 'genre',
    summary: '主持人、产品和上手演示都要入镜。',
    body: `# 口播带货

- 主持人写入人物，产品写入道具，拍摄场地写入场景。口播原词进 voiceover，不要改成广告口号。
- 至少一镜是产品特写，一镜是上手使用的过程。使用动作要看得见结果。
- 开口时嘴可读，产品在手边或画面前景。禁止只出脸不带产品。
- 卖点一句一个镜头。对比、痛点、使用、结果按这个顺序，不要堆在同一镜。
- 结尾是一句能直接念的行动号召，并给出产品还在画面里。`
  }
]

const BY_ID = new Map(STORY_SKILLS.map((skill) => [skill.id, skill]))

export function storySkillById(id: string): StorySkill | undefined {
  return BY_ID.get(id)
}

export function normalizeStorySkillId(id: unknown, hasCustom: boolean): string {
  if (id === CUSTOM_STORY_SKILL_ID && hasCustom) return CUSTOM_STORY_SKILL_ID
  if (id === GENERAL_STORY_SKILL_ID) return GENERAL_STORY_SKILL_ID
  if (typeof id === 'string' && BY_ID.has(id)) return id
  return GENERAL_STORY_SKILL_ID
}
