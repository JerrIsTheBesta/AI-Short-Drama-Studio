import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/utils/shotPrompt.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
const { directorTimelineIssue, h3DirectorBodyIssue, preservesScreenText } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

const weak = '0-4秒：特写阿默痉挛的手足，甲壳上的划痕清晰可见。5-9秒：镜头拉远，展现其身处腐叶尸坑的惨状。10-15秒：系统蓝框弹出，阿默挣扎爬出尸堆。'
assert.match(directorTimelineIssue(weak, 15), /跳秒/)
assert.match(directorTimelineIssue(weak.replace('5-9秒', '4-9秒').replace('10-15秒', '9-15秒'), 15), /摘要/)

const detailed = `图1=阿默；图2=场景图。
镜头 1（0–4s）：贴地微距侧拍，从阿默前足的足尖起幅。足节猛然蜷起，又沿地面无力地张开；触角从焦外颤入画面。固定机位，冷侧光掠过甲壳划痕，浅景深只让暗褐色腐叶留下虚化轮廓，落在还在抽动的足节。
镜头 2（4–9s）：沿原轴连续匀速拉远至中全景，低处的落叶逐渐从画面两侧展开，露出潮湿坑底与堆在阿默身侧的碎壳。阿默带着湿叶翻过半个身位，前足扒拉两次才撑住，叶片细碎擦响，镜头落在坑沿与蜷缩的身躯同框。
镜头 3（9–15s）：硬切至低机位中景，沿坑沿轻缓跟拍。阿默复眼颤动，抬头望向坑口，前足扣住落叶、后足逐次发力，将甲壳缓缓抬离尸堆，末幅停在坑沿。左侧弹出圆角蓝色半透明系统面板，显示【倒计时：59分32秒】，保留到结尾，不遮挡复眼与前足。
出场：阿默。`
assert.equal(directorTimelineIssue(detailed, 15), null)
assert.match(directorTimelineIssue(detailed, 12), /不一致/)
assert.match(directorTimelineIssue(detailed.replace('4–9s', '3–9s'), 15), /重叠/)
assert.equal(preservesScreenText('【身份：零阶灰甲工蚁（残损）】【倒计时：59分32秒】', '显示【身份：零阶灰甲工蚁（残损）】后显示【倒计时：59分32秒】'), true)
assert.equal(preservesScreenText('【倒计时：59分32秒】', detailed.replace('59分32秒', '59:32')), false)
assert.equal(preservesScreenText('【第一条】【第二条】', '【第二条】【第一条】'), false)
assert.equal(preservesScreenText('【16:9｜3D 卡通动画风格】', '新的分镜正文'), true)
assert.match(h3DirectorBodyIssue('[Shot 1] Macro close-up. The camera pulls back and the ant climbs out.', 15), /过短/)
assert.equal(h3DirectorBodyIssue(`[Shot 1] A ground-level macro close-up catches the ant's foreleg folding toward its shell and scraping back across the wet leaf. The camera holds level for the first movement, then pulls straight back without cutting, keeping focus on the trembling foot while the crushed edge of the leaf and the pit gradually emerge. The ant digs its front legs into a crease and draws the shell forward. At the rim the frame stops widening. The rear legs settle into the mulch and a loose leaf slips back into the pit with a quiet scrape. A translucent panel appears at screen left and holds clear of the ant's head.`, 15), null)
console.log('通过：动态分镜细节、时间覆盖与屏显原文回归测试')
