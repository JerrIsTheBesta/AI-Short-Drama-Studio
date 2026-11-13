import type { VideoRefEntry } from './consistency'

/** 编号来自本次实际提交的图片数组，不从出场人物名单推测。 */
export function withVideoReferenceBlock(prompt: string, entries: VideoRefEntry[]): string {
  const body = prompt.replace(/【实际参考图对应】[\s\S]*?【参考图对应结束】\s*/g, '').trim()
  if (!entries.length) return body
  const labels: Record<string, string> = { character: '人物人设', scene: '场景图', prop: '道具图', keyframe: '关键帧图', board: '分镜看板', extra: '补充参考' }
  return ['【实际参考图对应】', ...entries.map((entry, index) => `图${index + 1}=${entry.name || labels[entry.kind]}（${labels[entry.kind]}）`), '人物台词只由对应人物说出，其他人不得代说；场景和道具图不是人物。', '【参考图对应结束】', body].join('\n')
}
