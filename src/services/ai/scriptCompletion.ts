/** 不把上游明确标记为截断的结果保存为完整剧本或已完成的大纲。 */
export function assertScriptCompletion(response: { finishReason?: string }): void {
  if (response.finishReason === 'length' || response.finishReason === 'max_tokens') {
    throw new Error('模型输出达到服务商或模型的长度上限，内容可能不完整。本次结果未覆盖原文；请检查服务商的输出额度，或减少单次生成的集数和内容后重试。')
  }
}
