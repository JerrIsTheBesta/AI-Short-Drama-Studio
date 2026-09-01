import fs from 'node:fs'
import path from 'node:path'

/** Pack PNG files into a Vista-style ICO (PNG payloads). */
const pngs = process.argv.slice(2)
if (!pngs.length) {
  console.error('usage: node scripts/make-ico.mjs <16.png> <32.png> ... <out.ico>')
  process.exit(1)
}
const out = pngs.pop()
const images = pngs.map((file) => {
  const data = fs.readFileSync(file)
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  return { data, width, height }
})

const headerSize = 6 + images.length * 16
let offset = headerSize
const buf = Buffer.alloc(headerSize + images.reduce((n, img) => n + img.data.length, 0))
buf.writeUInt16LE(0, 0)
buf.writeUInt16LE(1, 2)
buf.writeUInt16LE(images.length, 4)
images.forEach((img, i) => {
  const entry = 6 + i * 16
  buf.writeUInt8(img.width >= 256 ? 0 : img.width, entry)
  buf.writeUInt8(img.height >= 256 ? 0 : img.height, entry + 1)
  buf.writeUInt8(0, entry + 2)
  buf.writeUInt8(0, entry + 3)
  buf.writeUInt16LE(1, entry + 4)
  buf.writeUInt16LE(32, entry + 6)
  buf.writeUInt32LE(img.data.length, entry + 8)
  buf.writeUInt32LE(offset, entry + 12)
  img.data.copy(buf, offset)
  offset += img.data.length
})
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
fs.writeFileSync(out, buf)
console.log(`wrote ${path.basename(out)} (${buf.length} bytes, ${images.length} sizes)`)
