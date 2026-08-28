import type { AspectRatio } from '@/types'

export const ASPECT_PRESETS: { value: AspectRatio; label: string; hint: string }[] = [
  { value: '16:9', label: '16:9', hint: '横版' },
  { value: '9:16', label: '9:16', hint: '竖版' },
  { value: '1:1', label: '1:1', hint: '方形' },
  { value: '4:3', label: '4:3', hint: '传统' },
  { value: '21:9', label: '21:9', hint: '影院' }
]

export function aspectToSize(ar: AspectRatio): { width: number; height: number } {
  switch (ar) {
    case '16:9':
      return { width: 1280, height: 720 }
    case '9:16':
      return { width: 720, height: 1280 }
    case '1:1':
      return { width: 1080, height: 1080 }
    case '4:3':
      return { width: 960, height: 720 }
    case '21:9':
      return { width: 1680, height: 720 }
  }
}

export function aspectFrameHint(ar?: string): string {
  if (ar === '9:16') return '竖版 9:16 手机全屏，宽小于高，禁止输出横图'
  if (ar === '1:1') return '方形 1:1，宽高相等'
  if (ar === '4:3') return '横版 4:3'
  if (ar === '21:9') return '超宽影院 21:9'
  return '横版 16:9 宽屏，宽大于高，禁止输出竖图'
}

export function isLandscapeAspect(ar?: string): boolean {
  return ar === '16:9' || ar === '4:3' || ar === '21:9'
}
