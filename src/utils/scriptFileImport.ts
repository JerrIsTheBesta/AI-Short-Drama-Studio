/**
 * 把外部剧本读成 Markdown。
 * 支持 Markdown、TXT、README，以及 Word（.docx / .doc）和 RTF。
 */

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'text', 'readme'])
const MARKDOWN_EXT = new Set(['md', 'markdown'])
const MAX_BYTES = 30 * 1024 * 1024

const EPISODE_LINE =
  /^(?:第\s*[0-9０-９一二三四五六七八九十百千两]+\s*[集章回幕话]|chapter\s+\d+|ep(?:isode)?\s*\d+)$/i

export const SCRIPT_PICK_FILTERS: { name: string; extensions: string[] }[] = [
  { name: '剧本', extensions: ['md', 'markdown', 'txt', 'text', 'docx', 'doc', 'rtf'] },
  { name: '所有文件', extensions: ['*'] }
]

export const SCRIPT_PICK_ACCEPT =
  '.md,.markdown,.txt,.text,.doc,.docx,.rtf,text/plain,text/markdown,application/msword,application/rtf,application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export async function scriptTextFromBytes(filename: string, bytes: Uint8Array): Promise<string> {
  if (!bytes.byteLength) throw new Error('剧本文件是空的')
  if (bytes.byteLength > MAX_BYTES) throw new Error('文件太大，请先把剧本另存成文本再导入')
  const kind = detectKind(filename, bytes)
  try {
    if (kind === 'docx') return plainToScript(await docxToText(bytes))
    if (kind === 'doc') return plainToScript(docToText(bytes))
    if (kind === 'rtf') return plainToScript(rtfToText(decodeBytes(bytes)))
    if (kind === 'markdown') return decodeBytes(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
    if (kind === 'text') return plainToScript(decodeBytes(bytes))
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/剧本|Word|文件|密码|格式/.test(message)) throw error
    throw new Error('这份文件读不出来，请另存成 .docx 或 .txt 再导入')
  }
  throw new Error('不支持的剧本格式。可以导入 Markdown、TXT、README 或 Word（.doc / .docx）')
}

function detectKind(filename: string, bytes: Uint8Array): 'docx' | 'doc' | 'rtf' | 'markdown' | 'text' | '' {
  const ext = extensionOf(filename)
  if (isZip(bytes) && (ext === 'docx' || zipHasDocumentXml(bytes))) return 'docx'
  if (isOle(bytes)) return 'doc'
  const head = latin1Head(bytes)
  if (head.startsWith('{\\rtf') || ext === 'rtf') return 'rtf'
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (TEXT_EXT.has(ext) || isReadmeName(filename)) return 'text'
  if (!ext && looksLikeText(bytes)) return 'text'
  return ''
}

function extensionOf(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() || filename).trim().toLowerCase()
  if (!base || base === 'readme') return 'readme'
  if (base.startsWith('readme.')) return base.slice('readme.'.length)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1)
}

function isReadmeName(filename: string): boolean {
  const base = (filename.split(/[\\/]/).pop() || '').trim().toLowerCase()
  return base === 'readme' || base.startsWith('readme.')
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  let nul = 0
  for (const b of sample) if (b === 0) nul++
  return sample.length > 0 && nul / sample.length < 0.02
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

function isOle(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
}

function latin1Head(bytes: Uint8Array): string {
  let out = ''
  const n = Math.min(bytes.length, 16)
  for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i])
  return out.trimStart().toLowerCase()
}

function decodeBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  if (!hasBadUtf8(bytes)) return new TextDecoder('utf-8').decode(bytes)
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function hasBadUtf8(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b < 0x80) continue
    let need = 0
    if (b >= 0xc2 && b <= 0xdf) need = 1
    else if (b >= 0xe0 && b <= 0xef) need = 2
    else if (b >= 0xf0 && b <= 0xf4) need = 3
    else return true
    if (i + need >= bytes.length) return true
    for (let j = 1; j <= need; j++) {
      if ((bytes[i + j] & 0xc0) !== 0x80) return true
    }
    i += need
  }
  return false
}

/** 纯文本收成剧本：单独成行的「第 N 集」变成集标题。 */
function plainToScript(raw: string): string {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) throw new Error('剧本文件是空的')
  const lines = text.split('\n').map((line) => {
    const trimmed = line.trim()
    if (trimmed.length <= 40 && EPISODE_LINE.test(trimmed)) return `## ${trimmed}`
    return line.trimEnd()
  })
  if (!lines.some((line) => /^#\s+/.test(line.trim()))) {
    const first = lines.findIndex((line) => line.trim())
    if (first >= 0) {
      const title = lines[first].trim()
      const rest = lines.slice(first + 1)
      const followedByBlank = rest[0] != null && rest[0].trim() === ''
      if (
        title.length <= 40 &&
        !/^#{1,6}\s/.test(title) &&
        followedByBlank &&
        rest.some((line) => line.trim())
      ) {
        lines[first] = `# ${title.replace(/^#+\s*/, '')}`
      }
    }
  }
  return lines.join('\n').trim()
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => safeChar(Number(num)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeChar(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

async function docxToText(bytes: Uint8Array): Promise<string> {
  const xml = await readZipText(bytes, 'word/document.xml')
  if (!xml) throw new Error('这份 Word 里没有正文')
  const lines: string[] = []
  for (const part of xml.split(/<\/w:p>/)) {
    const start = part.lastIndexOf('<w:p')
    const chunk = start >= 0 ? part.slice(start) : part
    if (!/<w:t\b|<w:tab\b|<w:br\b|<w:cr\b/.test(chunk)) continue
    const style = /<w:pStyle\b[^>]*\bw:val="([^"]+)"/.exec(chunk)?.[1] || ''
    const outline = /<w:outlineLvl\b[^>]*\bw:val="(\d+)"/.exec(chunk)?.[1]
    const mark = headingPrefix(style, outline)
    let text = ''
    const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g
    let match: RegExpExecArray | null
    while ((match = re.exec(chunk))) {
      if (match[1] != null) text += decodeXml(match[1])
      else if (match[0].startsWith('<w:tab')) text += '\t'
      else text += '\n'
    }
    const line = `${mark}${text.replace(/[ \t]+\n/g, '\n').trim()}`.trim()
    if (line) lines.push(line)
  }
  return lines.join('\n\n')
}

function headingPrefix(style: string, outline?: string): string {
  if (outline != null && outline !== '') {
    const level = Number(outline)
    if (level === 0) return '# '
    if (level === 1) return '## '
    if (level === 2) return '### '
  }
  const name = style.toLowerCase().replace(/\s+/g, '')
  if (/^(heading1|title|标题1|1)$/.test(name)) return '# '
  if (/^(heading2|标题2|2)$/.test(name)) return '## '
  if (/^(heading3|标题3|3)$/.test(name)) return '### '
  return ''
}

function zipHasDocumentXml(bytes: Uint8Array): boolean {
  try {
    return zipNames(bytes).some((name) => name.toLowerCase() === 'word/document.xml')
  } catch {
    return false
  }
}

function zipNames(bytes: Uint8Array): string[] {
  const view = dataView(bytes)
  const eocd = findEocd(bytes)
  if (eocd < 0) return []
  const count = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  const names: string[] = []
  for (let i = 0; i < count && cursor + 46 <= bytes.length; i++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break
    const nameLen = view.getUint16(cursor + 28, true)
    const extraLen = view.getUint16(cursor + 30, true)
    const commentLen = view.getUint16(cursor + 32, true)
    names.push(new TextDecoder('utf-8').decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen)))
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return names
}

async function readZipText(bytes: Uint8Array, wanted: string): Promise<string | null> {
  const file = (await unzip(bytes)).get(wanted.toLowerCase())
  if (!file) return null
  return new TextDecoder('utf-8').decode(file)
}

async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  const view = dataView(bytes)
  const eocd = findEocd(bytes)
  if (eocd < 0) throw new Error('这份 Word 文件已损坏')
  const count = view.getUint16(eocd + 10, true)
  let cursor = view.getUint32(eocd + 16, true)
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) break
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const compSize = view.getUint32(cursor + 20, true)
    const nameLen = view.getUint16(cursor + 28, true)
    const extraLen = view.getUint16(cursor + 30, true)
    const commentLen = view.getUint16(cursor + 32, true)
    const localOff = view.getUint32(cursor + 42, true)
    const name = new TextDecoder('utf-8').decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen))
    cursor += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error('这份 Word 有密码，先去掉密码再导入')
    if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== 0x04034b50) continue
    const localName = view.getUint16(localOff + 26, true)
    const localExtra = view.getUint16(localOff + 28, true)
    const start = localOff + 30 + localName + localExtra
    const compressed = bytes.subarray(start, start + compSize)
    files.set(name.replace(/\\/g, '/').toLowerCase(), await inflateZip(method, compressed))
  }
  return files
}

async function inflateZip(method: number, compressed: Uint8Array): Promise<Uint8Array> {
  if (method === 0) return compressed.slice()
  if (method !== 8) throw new Error('这份 Word 的压缩方式暂不支持')
  const stream = new Blob([compressed.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 22 - 0xffff)
  for (let i = bytes.length - 22; i >= min; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i
  }
  return -1
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

const ENDOFCHAIN = 0xfffffffe
const SKIP_SECTOR = 0xfffffffa

function docToText(bytes: Uint8Array): string {
  const cfb = readCfb(bytes)
  const word = cfb.get('worddocument')
  if (!word || word.length < 0x20) throw new Error('这份 Word 里没有正文')
  const view = dataView(word)
  if (view.getUint16(0, true) !== 0xa5ec) throw new Error('这份 Word 版本太旧，请另存为 .docx 再导入')
  const flags = view.getUint16(0x0a, true)
  if (flags & 0x0100) throw new Error('这份 Word 有密码，先去掉密码再导入')
  if (flags & 0x8000) throw new Error('这份 Word 被混淆了，请另存为 .docx 再导入')
  const whichTable = (flags & 0x0200) !== 0
  const table = cfb.get(whichTable ? '1table' : '0table')
  const ccpText = word.length >= 0x50 ? view.getUint32(0x4c, true) : 0
  if (!ccpText) throw new Error('剧本文件是空的')
  if (!table || word.length < 0x1aa) return cleanupDocText(scanUtf16(word))
  const fcClx = view.getUint32(0x1a2, true)
  const lcbClx = view.getUint32(0x1a6, true)
  if (!lcbClx || fcClx + lcbClx > table.length) return cleanupDocText(scanUtf16(word))
  const text = readPieceText(word, table.subarray(fcClx, fcClx + lcbClx), ccpText)
  const cleaned = cleanupDocText(text)
  if (cleaned.trim()) return cleaned
  const scanned = cleanupDocText(scanUtf16(word))
  if (scanned.trim()) return scanned
  throw new Error('这份 Word 里没有可读的正文')
}

function cleanupDocText(text: string): string {
  let out = ''
  let field = 0
  let inResult = false
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x13) {
      field++
      inResult = false
      continue
    }
    if (code === 0x14 && field) {
      inResult = true
      continue
    }
    if (code === 0x15 && field) {
      field--
      inResult = false
      continue
    }
    if (field && !inResult) continue
    if (code === 0x0d || code === 0x0b || code === 0x0c || code === 0x07) {
      out += '\n'
      continue
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) continue
    out += ch
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function readPieceText(word: Uint8Array, clx: Uint8Array, ccpText: number): string {
  const view = dataView(clx)
  let pos = 0
  while (pos < clx.length && clx[pos] === 1) {
    if (pos + 3 > clx.length) return ''
    const size = view.getUint16(pos + 1, true)
    pos += 3 + size
  }
  if (pos >= clx.length || clx[pos] !== 2 || pos + 5 > clx.length) return ''
  const lcb = view.getUint32(pos + 1, true)
  pos += 5
  if (lcb < 16 || pos + lcb > clx.length) return ''
  const n = Math.floor((lcb - 4) / 12)
  let text = ''
  for (let i = 0; i < n && text.length < ccpText; i++) {
    const cpStart = view.getUint32(pos + i * 4, true)
    const cpEnd = view.getUint32(pos + (i + 1) * 4, true)
    const pcd = pos + (n + 1) * 4 + i * 8
    if (pcd + 6 > pos + lcb) break
    const fc = view.getUint32(pcd + 2, true)
    const count = Math.max(0, cpEnd - cpStart)
    const take = Math.min(count, ccpText - text.length)
    if (!take) continue
    if (fc & 0x40000000) {
      const offset = (fc & 0x3fffffff) >>> 1
      text += decodeDocBytes(word.subarray(offset, Math.min(word.length, offset + take)))
    } else {
      const offset = fc
      const end = Math.min(word.length, offset + take * 2)
      if (offset >= 0 && offset < word.length) text += new TextDecoder('utf-16le').decode(word.subarray(offset, end))
    }
  }
  return text.slice(0, ccpText)
}

function decodeDocBytes(bytes: Uint8Array): string {
  if (!bytes.length) return ''
  if (hasBadUtf8(bytes)) {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      /* 单字节 */
    }
  }
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

function scanUtf16(bytes: Uint8Array): string {
  let best = ''
  let current = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8)
    const ok =
      code === 0x0d ||
      code === 0x0a ||
      code === 0x09 ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xff00 && code <= 0xffef)
    if (ok) {
      current += String.fromCharCode(code === 0x0d ? 0x0a : code)
    } else if (current.length > best.length) {
      best = current
      current = ''
    } else {
      current = ''
    }
  }
  if (current.length > best.length) best = current
  return best.length >= 8 ? best : ''
}

interface CfbFile {
  get(name: string): Uint8Array | undefined
}

function readCfb(bytes: Uint8Array): CfbFile {
  const view = dataView(bytes)
  if (!isOle(bytes) || bytes.length < 512) throw new Error('这份 Word 文件已损坏')
  const sectorShift = view.getUint16(0x1e, true)
  const miniShift = view.getUint16(0x20, true)
  const sectorSize = 1 << sectorShift
  const miniSize = 1 << miniShift
  const fatCount = view.getUint32(0x2c, true)
  const dirStart = view.getUint32(0x30, true)
  const miniCutoff = view.getUint32(0x38, true)
  const miniFatStart = view.getUint32(0x3c, true)
  const fat = readFat(bytes, view, sectorSize, fatCount)
  const dirBytes = readSectors(bytes, fat, dirStart, sectorSize, 1024 * 128)
  const entries = parseDir(dirBytes)
  const root = entries.find((entry) => entry.type === 5)
  const miniFat = readMiniFat(bytes, fat, miniFatStart, sectorSize)
  const miniStream = root ? readSectors(bytes, fat, root.start, sectorSize, root.size) : new Uint8Array()
  const streams = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (entry.type !== 2 || !entry.name) continue
    const data =
      entry.size < miniCutoff
        ? readMiniSectors(miniStream, miniFat, entry.start, miniSize, entry.size)
        : readSectors(bytes, fat, entry.start, sectorSize, entry.size)
    streams.set(entry.name, data.subarray(0, entry.size))
  }
  return { get: (name) => streams.get(name) }
}

function readFat(bytes: Uint8Array, view: DataView, sectorSize: number, fatCount: number): Uint32Array {
  const sectorIds: number[] = []
  for (let i = 0; i < 109 && sectorIds.length < fatCount; i++) {
    const id = view.getUint32(0x4c + i * 4, true)
    if (id >= SKIP_SECTOR) break
    sectorIds.push(id)
  }
  let difat = view.getUint32(0x44, true)
  let guard = 0
  while (difat < SKIP_SECTOR && sectorIds.length < fatCount && guard++ < 10000) {
    const off = (difat + 1) * sectorSize
    const per = sectorSize / 4 - 1
    for (let i = 0; i < per && sectorIds.length < fatCount; i++) sectorIds.push(view.getUint32(off + i * 4, true))
    difat = view.getUint32(off + per * 4, true)
  }
  const fat = new Uint32Array(sectorIds.length * (sectorSize / 4))
  sectorIds.forEach((id, index) => {
    const off = (id + 1) * sectorSize
    for (let j = 0; j < sectorSize / 4; j++) fat[index * (sectorSize / 4) + j] = view.getUint32(off + j * 4, true)
  })
  return fat
}

function readMiniFat(bytes: Uint8Array, fat: Uint32Array, start: number, sectorSize: number): Uint32Array {
  if (start >= SKIP_SECTOR) return new Uint32Array()
  const data = readSectors(bytes, fat, start, sectorSize, sectorSize * 64)
  const out = new Uint32Array(Math.floor(data.length / 4))
  const view = dataView(data)
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true)
  return out
}

function readSectors(bytes: Uint8Array, fat: Uint32Array, start: number, sectorSize: number, size: number): Uint8Array {
  if (!size || start >= SKIP_SECTOR) return new Uint8Array()
  const out = new Uint8Array(size)
  let sector = start
  let written = 0
  const seen = new Set<number>()
  while (sector < SKIP_SECTOR && written < size) {
    if (seen.has(sector)) break
    seen.add(sector)
    const off = (sector + 1) * sectorSize
    const take = Math.min(sectorSize, size - written)
    if (off < 0 || off >= bytes.length) break
    out.set(bytes.subarray(off, Math.min(bytes.length, off + take)), written)
    written += take
    sector = fat[sector] ?? ENDOFCHAIN
  }
  return out
}

function readMiniSectors(mini: Uint8Array, fat: Uint32Array, start: number, miniSize: number, size: number): Uint8Array {
  if (!size || start >= SKIP_SECTOR) return new Uint8Array()
  const out = new Uint8Array(size)
  let sector = start
  let written = 0
  const seen = new Set<number>()
  while (sector < SKIP_SECTOR && written < size) {
    if (seen.has(sector)) break
    seen.add(sector)
    const off = sector * miniSize
    const take = Math.min(miniSize, size - written)
    if (off < 0 || off >= mini.length) break
    out.set(mini.subarray(off, Math.min(mini.length, off + take)), written)
    written += take
    sector = fat[sector] ?? ENDOFCHAIN
  }
  return out
}

function parseDir(bytes: Uint8Array): Array<{ name: string; type: number; start: number; size: number }> {
  const view = dataView(bytes)
  const entries = []
  for (let off = 0; off + 128 <= bytes.length; off += 128) {
    const type = bytes[off + 0x42]
    if (!type) continue
    const nameBytes = view.getUint16(off + 0x40, true)
    const chars = Math.max(0, Math.min(64, nameBytes) - 2)
    const name = new TextDecoder('utf-16le').decode(bytes.subarray(off, off + chars)).replace(/\0/g, '').toLowerCase()
    entries.push({
      name,
      type,
      start: view.getUint32(off + 0x74, true),
      size: view.getUint32(off + 0x78, true)
    })
  }
  return entries
}

function rtfToText(src: string): string {
  let i = 0
  let out = ''
  const skipDest = new Set([
    'fonttbl',
    'colortbl',
    'stylesheet',
    'info',
    'pict',
    'object',
    'datastore',
    'themedata',
    'xmlnstbl',
    'listtable',
    'listoverridetable',
    'revtbl',
    'rsidtbl',
    'generator',
    'mmathpr'
  ])
  const skipStack: boolean[] = []
  let skipping = false
  const hexBytes: number[] = []
  const flushHex = () => {
    if (!hexBytes.length) return
    const bytes = Uint8Array.from(hexBytes)
    hexBytes.length = 0
    out += decodeDocBytes(bytes)
  }
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') {
      flushHex()
      skipStack.push(skipping)
      const ahead = src.slice(i + 1, i + 48)
      const dest = /^\s*\\\*\\([A-Za-z]+)/.exec(ahead) || /^\s*\\([A-Za-z]+)/.exec(ahead)
      if (dest && (ahead.includes('\\*\\') || skipDest.has(dest[1].toLowerCase()))) skipping = true
      i++
      continue
    }
    if (ch === '}') {
      flushHex()
      skipping = skipStack.pop() ?? false
      i++
      continue
    }
    if (skipping) {
      i++
      continue
    }
    if (ch === '\\') {
      if (src[i + 1] === '\\' || src[i + 1] === '{' || src[i + 1] === '}') {
        flushHex()
        out += src[i + 1]
        i += 2
        continue
      }
      if (src[i + 1] === "'") {
        const hex = src.slice(i + 2, i + 4)
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          hexBytes.push(parseInt(hex, 16))
          i += 4
          continue
        }
      }
      flushHex()
      if (src[i + 1] === 'u' && /[-\d]/.test(src[i + 2] || '')) {
        const match = /^\\u(-?\d+) ?/.exec(src.slice(i))
        if (match) {
          const code = Number(match[1])
          out += safeChar(code < 0 ? code + 65536 : code)
          i += match[0].length
          if (src[i] === '\\' && src[i + 1] === "'") i += 4
          else if (src[i]) i++
          continue
        }
      }
      const word = /^\\([A-Za-z]+)(-?\d+)? ?/.exec(src.slice(i))
      if (word) {
        const name = word[1].toLowerCase()
        if (name === 'par' || name === 'line' || name === 'page') out += '\n'
        else if (name === 'tab') out += '\t'
        else if (name === 'outlinelevel') {
          const level = Number(word[2] || 0)
          if (level === 0) out += '\n# '
          else if (level === 1) out += '\n## '
          else if (level === 2) out += '\n### '
        }
        i += word[0].length
        continue
      }
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      i++
      continue
    }
    flushHex()
    out += ch
    i++
  }
  flushHex()
  return out
}
