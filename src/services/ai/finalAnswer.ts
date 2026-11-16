/** Internal reasoning is not a deliverable, even if it contains valid JSON or tool names. */
export function finalAnswerText(content: unknown): string {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.flatMap(part => {
        if (typeof part === 'string') return [part]
        if (part && (!part.type || part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string') return [part.text]
        return []
      }).join('\n')
    : ''
  return text.replace(/<(think|thinking|reasoning|analysis)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '').trim()
}
