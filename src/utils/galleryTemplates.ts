const titles = [["跪坐合手","单腿重心","奔跑跨步","盘腿坐姿","深蹲支肘","踮脚上探","单膝弓步","后仰抱臂","举臂腾跃","俯身探手"],["相面对话","并肩指向","前坐后立","对角远近","背靠背","前行跟随","伸手搀扶","错身回望","隔空伸手","前蹲后立"]]

titles.push(['腾空伸腿','后翻腾空','双掌前探','拳部近大远小','低位落地','正侧面撑地侧伸','背侧面单手低蹲','背面撑地横伸'])
titles.push(['山地驿站信使 · 多视角定妆'])
export const galleryAlbums = ['单人姿势', '双人站位', '动态动作', '角色定妆'] as const
const characterPrompt = "制作一张 16:9 横版电影写实角色定妆设定板。主角是原创成年男性山地驿站信使，三十岁左右，方下颌、浓眉、短胡茬，左眉有浅疤。短发束成低髻，用深蓝布带固定。深靛蓝交领短袍，赭红肩披，烟棕旧皮护腕与斜挎帆布信袋，炭灰绑腿和旧皮靴。左侧并列展示正面和背面全身，鞋履完整入画；中间是略带风霜感的正脸近景；右侧两列三行依次展示左右四分之三侧脸、信袋搭扣、皮靴与绑腿、后脑发髻、领口与护腕细节。每格是同一人物，同一套妆发、服装和配饰。暖灰无缝摄影棚，柔和侧光，自然肤质，细白分隔线。只输出一张完整定妆板，无字、无水印、无标志；不要白金礼服、发冠、长披发、珠宝或女性角色。"
export const galleryTemplates = titles.flatMap((album, group) => album.map((title, index) => ({
  id: `template:${group}-${index}`,
  title,
  album: group,
  prompt: group === 3 ? characterPrompt : undefined,
  url: `${import.meta.env.BASE_URL}gallery-templates/${group}-${index}.jpg`
})))
