/** Fail when a tracked source file appears to contain a hard-coded credential. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binaryExt = /\.(png|jpe?g|gif|webp|ico|wasm|mp[34]|wav|zip|exe|dll|asar)$/i
const directPatterns = [
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['credential in URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/g],
  ['credential in query', /[?&](?:api_?key|token|access_?key)=[A-Za-z0-9._-]{12,}/gi]
]
const assignment = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password)\s*[:=]\s*["']([^"']{8,})["']/gi

function isPlaceholder(value) {
  return /your-|example|placeholder|dummy|mock|test|change-me|xxx/i.test(value)
}

function isCodeExpression(value) {
  return /^(?:settings|config|cfg|env|input|opts?|props|process|import|active|current|profile|endpoint|data|parsed|saved)\b/i.test(value)
    || /^VITE_[A-Z0-9_]+$/.test(value)
    || value.includes('${')
}

function localSecrets() {
  const values = []
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    for (const row of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const at = row.indexOf('=')
      if (at < 1) continue
      const key = row.slice(0, at).trim()
      const value = row.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
      if (!/(KEY|TOKEN|SECRET|PASSWORD|ACCESS)/i.test(key) || value.length < 8 || isPlaceholder(value)) continue
      values.push({ key, value })
    }
  }
  return values
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean)
const machineSecrets = localSecrets()
const findings = []

for (const relative of tracked) {
  if (relative === 'package-lock.json' || binaryExt.test(relative)) continue
  const file = path.join(root, relative)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const [label, pattern] of directPatterns) {
      pattern.lastIndex = 0
      for (const match of line.matchAll(pattern)) {
        if (!isPlaceholder(match[0])) findings.push(`${relative}:${index + 1} [${label}]`)
      }
    }
    assignment.lastIndex = 0
    for (const match of line.matchAll(assignment)) {
      const value = match[1]
      if (!isPlaceholder(value) && !isCodeExpression(value)) findings.push(`${relative}:${index + 1} [literal credential assignment]`)
    }
  })
  for (const secret of machineSecrets) {
    if (text.includes(secret.value)) findings.push(`${relative} [matches local ${secret.key}]`)
  }
}

const unique = [...new Set(findings)]
if (unique.length) {
  console.error('[assert-source-clean] 疑似硬编码凭据，已中止：\n  ' + unique.join('\n  '))
  process.exit(1)
}

console.log(`[assert-source-clean] 已检查 ${tracked.length} 个 Git 跟踪文件，未发现硬编码凭据`)
