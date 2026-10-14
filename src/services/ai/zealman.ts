export const ZEALMAN_WORKFLOWS = [
  {
    id: 'U01-minimax_h3_light2v多图参考生视频加速版',
    name: 'U01-minimax_h3_light2v多图参考生视频加速版',
    mode: 'reference' as const,
    stillMode: 'identity' as const,
    maxImages: 3,
    maxDuration: 15,
    imageKeys: ['137:image', '139:image', '141:image'],
    stepsKey: '124:steps',
    promptKey: '146:prompt',
    durationKey: '147:value',
    widthKey: '145:自定义宽',
    heightKey: '145:自定义高'
  },
  {
    id: 'U02-minimax_h3_light2v首尾帧图生视频加速版',
    name: 'U02-minimax_h3_light2v首尾帧图生视频加速版',
    mode: 'fl2va' as const,
    stillMode: 'keyframe' as const,
    maxImages: 2,
    maxDuration: 15,
    imageKeys: ['114:image', '128:image'],
    stepsKey: '105:9:steps',
    promptKey: '105:104:prompt',
    durationKey: '105:111:value',
    widthKey: '122:自定义宽',
    heightKey: '122:自定义高'
  },
  {
    id: 'U04-minimax_h3_light2v-5图参考生视频加速版',
    name: 'U04-minimax_h3_light2v-5图参考生视频加速版',
    mode: 'reference' as const,
    stillMode: 'identity' as const,
    maxImages: 5,
    maxDuration: 15,
    imageKeys: ['137:image', '139:image', '141:image', '148:image', '149:image'],
    stepsKey: '124:steps',
    promptKey: '146:prompt',
    durationKey: '147:value',
    widthKey: '145:自定义宽',
    heightKey: '145:自定义高'
  },
  {
    id: 'U06-minimax_h3_light2v多图参考生视频叠加加速插帧优化版',
    name: 'U06-minimax_h3_light2v多图参考生视频叠加加速插帧优化版',
    mode: 'reference' as const,
    stillMode: 'identity' as const,
    maxImages: 9,
    maxDuration: 15,
    imageKeys: ['137:image', '139:image', '144:image', '151:image', '653:image', '654:image', '655:image', '656:image', '657:image'],
    stepsKey: '124:steps',
    promptKey: '664:prompt',
    durationKey: '132:value',
    widthKey: '665:自定义宽',
    heightKey: '665:自定义高'
  }
] as const

export type ZealmanWorkflow = (typeof ZEALMAN_WORKFLOWS)[number]

export function normalizeZealmanBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    // 当前这个 Zealman 实例的 API 网关域名以 uu459546 开头；其余用户域名保持原样。
    if (url.hostname === 'u459546-78656cd2bf79.westd.seetacloud.com') {
      url.hostname = 'uu459546-78656cd2bf79.westd.seetacloud.com'
    }
    url.pathname = url.pathname.replace(/\/api(?:\/workflow(?:\/generate)?)?\/?$/i, '') || '/'
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function zealmanWorkflowById(id: string): ZealmanWorkflow | undefined {
  return ZEALMAN_WORKFLOWS.find((item) => item.id === id)
}
