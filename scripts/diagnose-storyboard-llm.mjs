/**
 * 独立验证“剧本 -> 单个分镜”是否能通过当前 AI-Cut LLM 接口完成。
 *
 * 用法：
 *   node scripts/diagnose-storyboard-llm.mjs [project.json]
 *
 * 读取 Documents/AI-Cut/app.db 中当前启用的 LLM。不会输出或保存 API Key。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.join(os.homedir(), 'Documents', 'AI-Cut')
const defaultProject = path.join(root, '333_p_mtivvuw3', 'project.json')
const projectPath = path.resolve(process.argv[2] || defaultProject)
const dbPath = path.join(root, 'app.db')

if (!existsSync(projectPath)) throw new Error(`项目不存在：${projectPath}`)
if (!existsSync(dbPath)) throw new Error(`配置数据库不存在：${dbPath}`)

const db = new DatabaseSync(dbPath, { readOnly: true })
const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('settings')
db.close()
if (!row?.value) throw new Error('app.db 中没有 settings')

const settings = JSON.parse(row.value)
const profiles = Array.isArray(settings.llms) ? settings.llms : []
const active = profiles.find((item) => item.id === settings.activeLlmId) || settings.llm || profiles[0]
if (!active?.baseUrl || !active?.apiKey || !active?.model) {
  throw new Error('当前 LLM 的地址、密钥或模型名不完整')
}

const project = JSON.parse(await readFile(projectPath, 'utf8'))
const script = String(project?.script?.content || '').trim()
if (!script) throw new Error('项目没有剧本正文')
const looksLikeBrief =
  script.length < 300 &&
  /(?:类型|主题|主角|要求|时长|画幅)[：:]/.test(script) &&
  !/(?:^|\n)#{1,4}\s+|(?:内景|外景)[｜|]/m.test(script)

// 故意只要一个镜头，验证模型和接口的最低能力，不经过 Vue、Pinia、画布或业务解析器。
const messages = [
  {
    role: 'system',
    content:
      '你是电影分镜导演。根据给出的剧本片段，只设计一个可拍摄、会动的镜头。画面必须包含起幅、事件触发、人物连续动作与反应、运镜和落幅。不要解释，不要套用固定镜头模板。'
  },
  {
    role: 'user',
    content: `请把下面内容拆成第一个镜头。直接用中文自然语言返回，包含：镜头标题、景别与运镜、画面动作、声音/台词、建议时长。\n\n${script.slice(0, 5000)}`
  }
]

const body = {
  model: active.model,
  messages,
  temperature: 0.35,
  max_tokens: 1200
}
const url = `${String(active.baseUrl).replace(/\/+$/, '')}/chat/completions`
const started = performance.now()
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 120_000)
let response
try {
  response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${active.apiKey}`
    },
    body: JSON.stringify(body),
    signal: controller.signal
  })
} finally {
  clearTimeout(timer)
}
const elapsedMs = Math.round(performance.now() - started)
const responseText = await response.text()
if (!response.ok) {
  throw new Error(`LLM HTTP ${response.status}，${elapsedMs}ms：${responseText.slice(0, 500)}`)
}

const data = JSON.parse(responseText)
const message = data?.choices?.[0]?.message || {}
const content = String(message.content || message.reasoning_content || '').trim()
if (!content) throw new Error(`LLM ${elapsedMs}ms 返回成功，但正文为空`)

const reportDir = path.join(process.cwd(), 'diagnostics')
await mkdir(reportDir, { recursive: true })
const reportPath = path.join(reportDir, 'storyboard-llm-result.txt')
const report = [
  `project=${projectPath}`,
  `model=${data.model || active.model}`,
  `elapsedMs=${elapsedMs}`,
  `scriptChars=${script.length}`,
  `responseChars=${content.length}`,
  '',
  content
].join('\n')
await writeFile(reportPath, report, 'utf8')

console.log(`成功：${data.model || active.model} 在 ${elapsedMs}ms 返回 ${content.length} 字。`)
if (looksLikeBrief) {
  console.log('警告：输入只有创作简报，不是完整剧本；能拆镜，但模型只能补写/猜测缺失剧情。')
}
console.log(`原始结果：${reportPath}`)
console.log('---')
console.log(content)
