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

/** 中文人名不能都塌成 the character，否则图一图二无法区分。 */
export function h3UniqueName(
  name: string | undefined,
  index: number,
  role: 'person' | 'place' = 'person'
): string {
  const mapped = h3RefName(name, '')
  if (mapped) return mapped
  return role === 'place' ? `Place ${index}` : `Person ${index}`
}

/** 按出场顺序给每个人一个不重复的英文称呼。 */
export function h3NameMap(names: Array<string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  const used = new Set<string>()
  let person = 0
  for (const raw of names) {
    const key = String(raw || '').trim()
    if (!key || out[key]) continue
    let label = h3RefName(key, '')
    if (!label) {
      person += 1
      label = `Person ${person}`
    }
    let final = label
    let n = 2
    while (used.has(final.toLowerCase())) {
      final = `${label} ${n++}`
    }
    used.add(final.toLowerCase())
    out[key] = final
  }
  return out
}

export function englishOrOmit(text?: string): string {
  const value = String(text || '').trim()
  if (!value || hasCjk(value)) return ''
  return value
}
