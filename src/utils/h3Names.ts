const NAME_EN: Record<string, string> = {
  阿诚: 'Ah Cheng',
  奶奶: 'Grandmother',
  爷爷: 'Grandfather',
  外婆: 'Grandmother',
  祖母: 'Grandmother',
  祖父: 'Grandfather',
  父亲: 'Father',
  母亲: 'Mother',
  爸爸: 'Father',
  妈妈: 'Mother',
  儿子: 'the son',
  女儿: 'the daughter'
}

function hasCjk(text: string): boolean {
  return /[㐀-鿿]/.test(text)
}

/** H3 提示词里的人名/地名：能译就译，中文原词不要进英文正文。 */
export function h3RefName(name?: string, fallback = 'the character'): string {
  const value = String(name || '').trim()
  if (!value) return fallback
  if (NAME_EN[value]) return NAME_EN[value]
  if (hasCjk(value)) return fallback
  return value
}

export function englishOrOmit(text?: string): string {
  const value = String(text || '').trim()
  if (!value || hasCjk(value)) return ''
  return value
}
