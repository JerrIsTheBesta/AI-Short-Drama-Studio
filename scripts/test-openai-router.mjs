import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}

const { finalAnswerText } = await load('../src/services/ai/finalAnswer.ts')
assert.equal(finalAnswerText('<think>{"actions":["wrong"]}</think>正式答案'), '正式答案')
assert.equal(finalAnswerText('<analysis>内部 JSON {"actions":["wrong"]}'), '')
assert.equal(finalAnswerText([{ type: 'reasoning', text: '草稿' }, { type: 'text', text: '正文' }]), '正文')
assert.equal(finalAnswerText(null), '')
assert.equal(finalAnswerText('{"shots":[]}'), '{"shots":[]}')

const { normalizeRouterBaseUrl } = await load('../src/services/ai/openAiRouter.ts')
assert.equal(normalizeRouterBaseUrl('https://api.example.com/'), 'https://api.example.com/v1')
assert.equal(normalizeRouterBaseUrl('https://api.example.com/openai/v1/chat/completions/'), 'https://api.example.com/openai/v1')
assert.equal(normalizeRouterBaseUrl('http://127.0.0.1:8181/custom'), 'http://127.0.0.1:8181/custom')
assert.throws(() => normalizeRouterBaseUrl('http://api.example.com/v1'), /HTTPS/)
assert.throws(() => normalizeRouterBaseUrl('https://api.example.com/v1?key=example'), /查询参数/)

console.log('通过：OpenAI 兼容网关地址与思考正文分离')
