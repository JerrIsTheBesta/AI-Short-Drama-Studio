import type { Project, Shot } from '@/types'

const CAM: Record<Shot['cameraMovement'], string> = {
  push: '推',
  pull: '拉',
  pan: '摇',
  tilt: '移',
  static: '固定',
  orbit: '环绕'
}

/** 把当前项目拼成一份完整剧本 Markdown（大标题 / 小标题分段）。 */
export function composeProjectPlayMarkdown(p: Project): string {
  const script = p.script
  const parts: string[] = []
  parts.push(`# ${script?.topic || p.name || '剧本'}`)
  parts.push('')

  const raw = (script?.content || '').trim()
  if (raw) {
    if (/^#{1,6}\s/m.test(raw)) {
      parts.push(raw)
    } else {
      parts.push('## 文案')
      parts.push('')
      parts.push(raw)
    }
    parts.push('')
  } else {
    parts.push('## 文案')
    parts.push('')
    parts.push('*还没有正文。在右侧填写，或点下方拆分镜。*')
    parts.push('')
  }

  if (script?.aesthetic?.trim()) {
    parts.push('## 整体氛围')
    parts.push('')
    parts.push(script.aesthetic.trim())
    parts.push('')
  }

  const subjects = p.subjects ?? []
  if (subjects.length) {
    parts.push('## 人物')
    parts.push('')
    for (const s of subjects) {
      parts.push(`### ${s.name}`)
      parts.push('')
      if (s.role) parts.push(`- **角色**　${s.role}`)
      if (s.kind) parts.push(`- **类型**　${s.kind === 'person' ? '人物' : s.kind === 'animal' ? '动物' : '其他'}`)
      if (s.description?.trim()) parts.push(s.description.trim())
      parts.push('')
    }
  }

  const scenes = p.scenes ?? []
  if (scenes.length) {
    parts.push('## 场景')
    parts.push('')
    for (const s of scenes) {
      parts.push(`### ${s.name}`)
      parts.push('')
      if (s.lighting?.trim()) parts.push(`- **光线**　${s.lighting.trim()}`)
      if (s.mainAnchor?.trim()) parts.push(`- **主锚**　${s.mainAnchor.trim()}`)
      if (s.description?.trim()) parts.push(s.description.trim())
      parts.push('')
    }
  }

  if (p.shots.length) {
    parts.push('## 分镜')
    parts.push('')
    for (const shot of p.shots) {
      parts.push(`### 第 ${shot.index + 1} 镜　${shot.title}`)
      parts.push('')
      const meta: string[] = []
      if (shot.shotSize) meta.push(`景别：${shot.shotSize}`)
      meta.push(`运镜：${CAM[shot.cameraMovement] || shot.cameraMovement}`)
      meta.push(`${shot.duration} 秒`)
      parts.push(`- ${meta.join('　')}`)
      if (shot.purpose?.trim()) parts.push(`- **戏剧功能**　${shot.purpose.trim()}`)
      if (shot.voiceover?.trim()) {
        parts.push('')
        parts.push(`**口播**　${shot.voiceover.trim()}`)
      }
      if (shot.visualPrompt?.trim()) {
        parts.push('')
        parts.push(shot.visualPrompt.trim())
      }
      parts.push('')
      parts.push('---')
      parts.push('')
    }
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
