const fs = require('fs')
const p = 'src/services/canvas/agent.ts'
let s = fs.readFileSync(p, 'utf8')

const startMark = '  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜|拆剧本/.test(t)'
const endMark = "    actions.push({ tool: 'generate_storyboard' })"
const start = s.indexOf(startMark)
if (start < 0) {
  console.error('start not found')
  process.exit(1)
}
// Only the one inside heuristicPlan (second occurrence of askedBoard may differ)
const start2 = s.indexOf(startMark, start)
const end = s.indexOf(endMark, start2)
if (end < 0) {
  console.error('end not found', start2)
  process.exit(1)
}
const endClose = s.indexOf('}', end)
const before = s.slice(0, start2)
const after = s.slice(endClose + 1)
const mid = `  const askedBoard = /拆分镜|拆镜|故事板|出分镜|生成分镜|拆剧本|写剧本|提炼节点/.test(t)
  const askedSheet = /人设|角色图/.test(t)
  const askedScene = /场景图|底板|出场景|生成场景/.test(t)
  const askedImage = /配图|出图|单帧|把图画上|缺的图/.test(t)
  const askedVideo = /图生视频|生成视频|出视频/.test(t) || /第.+镜.*视频/.test(t)
  const askedAudio = /口播|配音|语音/.test(t)
  const playReady = Boolean(p.script?.playReady && p.script.content?.trim())
  const looksLikeBrief =
    t.length >= 16 && !askedSheet && !askedImage && !askedVideo && !askedScene && !playReady

  if (!p.script?.content?.trim() && (askedBoard || looksLikeBrief || all)) {
    actions.push({ tool: 'seed_script', text: t })
  }
  if (askedBoard || looksLikeBrief || (all && !p.shots.length)) {
    if (!playReady) actions.push({ tool: 'generate_play' })
    else if (!p.shots.length) actions.push({ tool: 'extract_cast' })
    else if (/重写剧本|重新写剧本/.test(t)) actions.push({ tool: 'generate_play' })
    else if (/重新提炼|重拆|重新拆/.test(t)) actions.push({ tool: 'extract_cast' })
    else actions.push({ tool: 'generate_play' })
  }`
const nl = s.includes('\r\n') ? '\r\n' : '\n'
s = before + mid.replace(/\n/g, nl) + after

s = s.replaceAll(
  "const hasBoard = out.some((a) => a.tool === 'generate_storyboard' || a.tool === 'extract_cast')",
  "const hasBoard = out.some((a) => a.tool === 'generate_storyboard' || a.tool === 'extract_cast' || a.tool === 'generate_play')"
)
s = s.replaceAll(
  "const idx = out.findIndex((a) => a.tool === 'generate_storyboard' || a.tool === 'extract_cast')",
  "const idx = out.findIndex((a) => a.tool === 'generate_storyboard' || a.tool === 'extract_cast' || a.tool === 'generate_play')"
)

fs.writeFileSync(p, s)
console.log('patched', start2, 'playReady', (s.match(/playReady/g) || []).length)
