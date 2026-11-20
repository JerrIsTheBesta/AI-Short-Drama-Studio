import { callLLM } from '@/services/ai/client'
import { isDirectNodeShortcut } from '@/services/canvas/selectedText'
import { isCaptureApproval } from './model'

export type CaptureIntent = 'chat' | 'question' | 'status' | 'plan' | 'revise' | 'approve' | 'node'

const LABEL: Record<CaptureIntent, string> = {
  chat: '闲聊',
  question: '问答',
  status: '查看进度',
  plan: '制定连续拍计划',
  revise: '修改制作计划',
  approve: '继续执行',
  node: '改当前节点'
}

export function captureIntentLabel(kind: CaptureIntent): string {
  return LABEL[kind]
}

/** 选中视频后要求把最后一帧存成图。这不是开拍，也不能当成「继续」。 */
export function isLastFrameGrab(text: string): boolean {
  const t = text.trim()
  if (!t || /继续拍|接着拍|往下拍|开拍|重新规划/.test(t)) return false
  return /最后一帧|尾帧|末帧/.test(t) && /截|提|取|导|存|做成|出一张|来一张|帮我|要一张/.test(t)
}

function ruleIntent(text: string, hasPlan: boolean, hasScriptPaste: boolean): CaptureIntent | null {
  const t = text.trim()
  if (!t) return 'chat'
  if (isDirectNodeShortcut(t)) return 'node'
  if (t === '确认重新提交' || isCaptureApproval(t)) return 'approve'
  if (/^重新规划/.test(t)) return 'revise'
  if (/从头开始拍|从头拍|指定开始拍|指定开拍/.test(t)) return hasPlan ? 'approve' : 'plan'
  if (/^(?:你好|您好|嗨|hi|hello|hey|在吗|在不在|谢谢|谢了|辛苦了?|哈哈+|嗯+|哦+|你是谁|你能干什么|你能做什么)[\s!！。.~～?？]*$/i.test(t)) return 'chat'
  if (/不要继续|不要开始|先别|等一下|等会儿|暂停|不用了|先别拍/.test(t)) return 'chat'
  if (/进度|做到哪|还差|缺什么|现在什么情况|什么进度/.test(t)) return 'status'
  if (/多久|几分钟|多少秒|多少个镜头|多少场|要什么资产|需要什么|要拍什么/.test(t)) return hasPlan ? 'status' : 'question'
  if (/[吗呢？?]$/.test(t) && !/生成|开始|继续|规划|开拍/.test(t)) return 'question'
  if (hasPlan && /改计划|改场次|重排整场|重拆剧本|重做计划/.test(t)) return 'revise'
  if (!hasPlan && (hasScriptPaste || /分析|规划|制定|连续拍/.test(t) || t === '开始')) return 'plan'
  if (hasPlan && /分析剧本|看下计划|当前计划/.test(t)) return 'status'
  return null
}

export async function detectCaptureIntent(text: string, hasPlan: boolean, hasScriptPaste: boolean, signal?: AbortSignal, hasSelection = false): Promise<CaptureIntent> {
  const ruled = ruleIntent(text, hasPlan, hasScriptPaste)
  if (ruled) return ruled === 'node' && !hasSelection ? 'question' : ruled
  try {
    const resp = await callLLM({
      signal,
      temperature: 0,
      disableThinking: true,
      jsonMode: true,
      maxTokens: 40,
      timeoutMs: 20_000,
      messages: [
        { role: 'system', content: '你是连续拍模式的意图分类器。只判断，不执行，不写计划。只输出 JSON：{"kind":"chat|question|status|plan|revise|approve|node"}。看用户想做什么，不要靠某一个固定词。chat：打招呼、道谢、让你等一下或先别拍。question：问规则或原因。status：问进度、还缺什么、能拍多久。plan：还没有制作计划时，用户是要分析剧本、排这场戏或开始进入连续拍。revise：已经有计划时，明确要改整场计划、场次、全片对白或重排。approve：已经有计划时，用户是要开始拍、接着拍或继续当前这一步，包括从头开始拍、指定开始拍。node：已经选中某个节点，这句话是在改这个节点的内容、对齐这一镜、写清动作表情，或从这一镜末帧继续。句子里出现「改」或「剧本」不等于重拆整场。提问、截尾帧、改当前节点都不是 approve，也不是 revise。拿不准就 question。没有选中节点时不要返回 node。' },
        { role: 'user', content: `当前${hasPlan ? '已有' : '还没有'}连续拍计划。${hasSelection ? '用户选中了一个画布节点。' : '用户没有选中节点。'}\n用户消息：\n${text}` }
      ]
    })
    const matched = String(resp.content || '').match(/"kind"\s*:\s*"(chat|question|status|plan|revise|approve|node)"/)
    if (matched) {
      const kind = matched[1] as CaptureIntent
      return kind === 'node' && !hasSelection ? 'question' : kind
    }
  } catch (error) {
    if (signal?.aborted) throw error
  }
  return 'question'
}
