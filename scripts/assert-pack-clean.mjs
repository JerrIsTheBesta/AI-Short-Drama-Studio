/**
 * Fail the pack if this machine's .env keys or API tokens landed in dist.
 * localStorage is not packaged; Vite inlining .env is the leak to catch.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scanRoots = [path.join(root, 'dist'), path.join(root, 'dist-electron')]
const envFiles = ['.env', '.env.local', '.env.production', '.env.production.local']
const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.map', '.html', '.css', '.json', '.txt'])

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return []
  const rows = []
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    let value = t.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    rows.push({ key: t.slice(0, i).trim(), value })
  }
  return rows
}

function isPlaceholder(value) {
  const v = value.trim()
  if (!v) return true
  return /^(true|false|0|1)$/i.test(v)
    || /your[_-]?|changeme|placeholder|example\.com|sk-your-|<\w+>|\{.+\}/i.test(v)
}

function isSecretKey(name) {
  return /API_KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY/i.test(name)
}

function looksLikeToken(value) {
  const v = value.trim()
  if (v.length < 12) return false
  if (/^https?:\/\//i.test(v)) return false
  return /^(sk-|rk-|ak-|Bearer\s)/i.test(v)
}

function collectSecrets() {
  const found = []
  const seen = new Set()
  for (const name of envFiles) {
    for (const { key, value } of parseEnvFile(path.join(root, name))) {
      if (!key.startsWith('VITE_') || isPlaceholder(value)) continue
      if (!isSecretKey(key) && !looksLikeToken(value)) continue
      const mark = `${key}=${value}`
      if (seen.has(mark)) continue
      seen.add(mark)
      found.push({ key, value, from: name })
    }
  }
  return found
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (SCAN_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full)
  }
  return out
}

const secrets = collectSecrets()
const files = scanRoots.flatMap((dir) => walk(dir))
const leaks = []

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  for (const secret of secrets) {
    if (text.includes(secret.value)) {
      leaks.push({ key: secret.key, from: secret.from, file: path.relative(root, file) })
    }
  }
  const extra = text.match(/\bsk-[A-Za-z0-9_\-]{16,}\b/g) || []
  for (const token of extra) {
    if (isPlaceholder(token)) continue
    if (secrets.some((s) => s.value === token)) continue
    leaks.push({ key: 'sk-*', from: 'bundle', file: path.relative(root, file) })
  }
}

if (leaks.length) {
  const lines = [...new Map(leaks.map((l) => [`${l.key} ${l.file}`, `  ${l.key}（来自 ${l.from}）出现在 ${l.file}`])).values()]
  console.error('[assert-pack-clean] 安装包里出现了本机密钥，已中止打包：\n' + lines.join('\n'))
  process.exit(1)
}

console.log('[assert-pack-clean] dist 未发现本机 .env 密钥')
