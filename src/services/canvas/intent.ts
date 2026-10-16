/**
 * 意图识别：在任务规划之前先判断用户这句话想干什么。
 * 规则优先（确定性、零成本），拿不准的落到 task 交给 LLM 规划。
 */
import type { Project } from '@/types'
import {
  isApprovePlayRequest,
  isFullPipelineRequest
} from './playGate'
import { isContinueRequest } from './pipeline'
import { isNewStoryBrief } from '@/utils/storyBrief'
import { parseForgetRequest, parseRememberRequest } from '@/services/memory/memoryStore'

export type AgentIntentKind =
  | 'remember' // 要求记住偏好 / 事实
  | 'forget' // 要求忘掉某条记忆
  | 'question' // 问答咨询，不动画布
  | 'status' // 查询项目进度 / 检查缺漏
  | 'prompt_polish' // 加厚 / 改写提示词
  | 'create_asset' // 新建自由图片 / 视频节点
  | 'edit_canvas' // 修改现有节点或分镜
  | 'pipeline' // 剧本流水线推进
  | 'chitchat'
  | 'task' // 其他需要工具的任务

export interface AgentIntent {
  kind: AgentIntentKind
  /** 展示在界面上的短标签 */
  label: string
  /** 是否需要进入任务规划 / 工具循环 */
  needsTools: boolean
  confidence: 'high' | 'low'
}

export interface IntentContext {
  /** 项目里是否已有剧本 / 人物 / 场景 / 分镜（不再区分画布模式） */
  hasPipeline: boolean
  project: Project | null
  hasSelectedGenNode: boolean
}

const INTENT_LABEL: Record<AgentIntentKind, string> = {
  remember: '记住这个',
  forget: '删除记忆',
  question: '问答咨询',
  status: '查看进度',
  prompt_polish: '优化提示词',
  create_asset: '创建生成节点',
  edit_canvas: '修改画布',
  pipeline: '推进制作',
  chitchat: '闲聊',
  task: '执行任务'
}

function intent(kind: AgentIntentKind, confidence: 'high' | 'low' = 'high'): AgentIntent {
  const needsTools =
    kind === 'prompt_polish' ||
    kind === 'create_asset' ||
    kind === 'edit_canvas' ||
    kind === 'pipeline' ||
    kind === 'task'
  return { kind, label: INTENT_LABEL[kind], needsTools, confidence }
}

/** 工具类关键词：命中即说明用户想动画布，不是纯问答 */
const ACTION_HINT =
  /写|续写|改编|拆|提炼|提取|生成|出图|配图|出视频|做|改|换|重跑|重新|创建|新建|加一|补|跑|优化|扩写|加厚|删除|去掉|全流程|确认通过|继续|开始/

export function detectIntent(text: string, ctx: IntentContext): AgentIntent {
  const t = text.trim()
  if (!t) return intent('chitchat')

  // 1. 记忆指令优先
  if (parseRememberRequest(t)) return intent('remember')
  if (parseForgetRequest(t)) return intent('forget')

  // 2. 进度查询 / 质检
  if (/进度|状态|还差|缺什么|缺了|齐了没|检查一遍|质检|验收清单|现在.*(?:情况|进展)|做到哪/.test(t)) {
    return intent('status')
  }

  // 3. 显式流水线指令
  if (isFullPipelineRequest(t) || isContinueRequest(t) || isApprovePlayRequest(t)) {
    return intent('pipeline')
  }
  if (isNewStoryBrief(t, ctx.project)) return intent('pipeline')
  if (
    /剧本|短剧|剧集|微剧|故事|写剧|完整剧本|续写|接着写|拆分镜|拆镜|故事板|出分镜|拆剧本|提炼|提取节点|人设|四视图|场景图|底板|故事看板|口播|配音/.test(t)
  ) {
    // 明确的流水线指令：不管画布现在有没有东西，都按流水线走
    return intent('pipeline')
  }

  // 4. 提示词优化
  if (/优化|扩写|加厚|润色|改写|重写/.test(t) && /提示词|prompt|画面|运镜|文案|这段|这句|节点/i.test(t)) {
    return intent('prompt_polish')
  }
  if (ctx.hasSelectedGenNode && /更有画面感|写清|动作|表情|暗一点|亮一点|按剧情|更具体|再细/.test(t)) {
    return intent('prompt_polish')
  }

  // 5. 新建自由节点
  if (/新建|创建|加一?个|来一个|帮我做一?[个张条]/.test(t) && /图片|图像|视频|节点|画面/.test(t)) {
    return intent('create_asset')
  }

  // 6. 修改画布现有内容
  if (/第\s*[\d一二两三四五六七八九十]+\s*镜/.test(t) && ACTION_HINT.test(t)) {
    return intent('edit_canvas')
  }
  if (/把|将|改/.test(t) && /节点|提示词|分镜|时长|比例|运镜/.test(t) && ACTION_HINT.test(t)) {
    return intent('edit_canvas')
  }

  // 7. 纯问答：带疑问词且不含动作词
  const looksQuestion =
    /[吗呢吧？?]$/.test(t) ||
    /^(?:什么是|怎么|为什么|为啥|能不能|可不可以|你会|你认识|介绍一下|解释一下|讲讲|告诉我)/.test(t) ||
    /你能做什么|你会什么|你是谁|有什么功能|怎么用/.test(t)
  if (looksQuestion && !ACTION_HINT.test(t)) {
    return intent('question')
  }

  // 8. 兜底：含动作词交给任务规划，否则当闲聊/咨询交给 LLM 自由回答
  if (ACTION_HINT.test(t)) return intent('task', 'low')
  if (t.length >= 12) return intent('question', 'low')
  return intent('chitchat')
}
