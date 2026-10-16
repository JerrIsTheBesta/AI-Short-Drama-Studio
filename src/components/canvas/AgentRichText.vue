<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    content: string
    /** 小字号模式：用在执行轨迹的说明里 */
    compact?: boolean
  }>(),
  { compact: false }
)

/** ── 行内：代码 → 加粗 → 斜体 → 删除线 → 链接 ── */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inline(src: string): string {
  let s = escapeHtml(src)
  const codes: string[] = []
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(c)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  )
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => {
    return `<code class="ic">${codes[Number(i)]}</code>`
  })
  return s
}

interface Block {
  html: string
  /** 代码块原文，供复制使用 */
  raw?: string
  lang?: string
  lines?: number
}

const blocks = computed<Block[]>(() => {
  const src = (props.content || '').replace(/\r\n/g, '\n')
  const lines = src.split('\n')
  const out: Block[] = []
  let i = 0
  const blank = (l: string) => !l.trim()

  while (i < lines.length) {
    const line = lines[i]

    if (blank(line)) {
      i += 1
      continue
    }

    // 代码块 / 提示词块
    const fence = line.match(/^\s*```([\w+#.-]*)\s*$/)
    if (fence) {
      const lang = fence[1] || ''
      const buf: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i += 1
      }
      i += 1
      const raw = buf.join('\n').replace(/\s+$/, '')
      out.push({
        html: raw ? escapeHtml(raw) : '',
        raw,
        lang,
        lines: buf.length
      })
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push({ html: '<hr />' })
      i += 1
      continue
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      const lv = Math.min(4, h[1].length)
      out.push({ html: `<h${lv}>${inline(h[2].trim())}</h${lv}>` })
      i += 1
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push({ html: `<blockquote>${inline(buf.join(' '))}</blockquote>` })
      continue
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const split = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim())
      const head = split(line)
      i += 2
      const body: string[][] = []
      while (i < lines.length && lines[i].includes('|') && !blank(lines[i])) {
        body.push(split(lines[i]))
        i += 1
      }
      out.push({
        html:
          `<div class="tb-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></div>`
      })
      continue
    }

    // 无序列表
    if (/^\s*[-*•·]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*•·]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•·]\s+/, ''))
        i += 1
      }
      out.push({
        html: `<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`
      })
      continue
    }

    // 有序列表
    if (/^\s*\d+[.、)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.、)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.、)]\s+/, ''))
        i += 1
      }
      out.push({
        html: `<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`
      })
      continue
    }

    // 普通段落：连续非空行合并，用 <br> 保留换行
    const buf: string[] = []
    while (
      i < lines.length &&
      !blank(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,4}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*•·]\s+/.test(lines[i]) &&
      !/^\s*\d+[.、)]\s+/.test(lines[i])
    ) {
      buf.push(lines[i])
      i += 1
    }
    if (buf.length) {
      out.push({ html: `<p>${buf.map((l) => inline(l)).join('<br />')}</p>` })
    }
  }
  return out
})

const copiedIdx = ref(-1)
const expanded = ref<number[]>([])
let copyTimer: ReturnType<typeof setTimeout> | undefined

const html = computed(() =>
  blocks.value
    .map((b, idx) => {
      if (b.raw === undefined) return b.html
      const isPrompt = !b.lang && (b.raw || '').length > 40
      const foldable = (b.lines || 0) > 12
      const open = !foldable || expanded.value.includes(idx)
      const title = b.lang || (isPrompt ? '提示词' : '内容')
      return `<div class="code-card${open ? '' : ' fold'}">
  <div class="code-head">
    <span class="code-lang">${escapeHtml(title)}</span>
    <span class="code-lines">${b.lines || 0} 行</span>
    <button type="button" class="code-act" data-copy="${idx}">${copiedIdx.value === idx ? '已复制' : '复制'}</button>
    ${foldable ? `<button type="button" class="code-act" data-fold="${idx}">${open ? '收起' : '展开'}</button>` : ''}
  </div>
  <pre class="code-body"><code>${b.html}</code></pre>
</div>`
    })
    .join('')
)

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}

async function onClick(ev: MouseEvent) {
  const el = ev.target as HTMLElement | null
  if (!el) return
  const copyIdx = el.getAttribute?.('data-copy')
  if (copyIdx !== null && copyIdx !== undefined) {
    const idx = Number(copyIdx)
    const ok = await copyText(blocks.value[idx]?.raw || '')
    if (!ok) return
    copiedIdx.value = idx
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copiedIdx.value = -1), 1600)
    return
  }
  const foldIdx = el.getAttribute?.('data-fold')
  if (foldIdx !== null && foldIdx !== undefined) {
    const idx = Number(foldIdx)
    expanded.value = expanded.value.includes(idx)
      ? expanded.value.filter((n) => n !== idx)
      : [...expanded.value, idx]
  }
}
</script>

<template>
  <div class="rich" :class="{ compact }" @click="onClick" v-html="html" />
</template>

<style scoped>
.rich {
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-text-2);
  overflow-wrap: anywhere;
  word-break: break-word;
  min-width: 0;
}
.rich.compact {
  font-size: 11.5px;
  line-height: 1.6;
}
.rich :deep(> *:first-child) {
  margin-top: 0;
}
.rich :deep(> *:last-child) {
  margin-bottom: 0;
}
.rich :deep(p) {
  margin: 0 0 8px;
}
.rich :deep(strong) {
  color: var(--color-text-1);
  font-weight: 650;
}
.rich :deep(em) {
  color: var(--color-text-2);
  font-style: italic;
}
.rich :deep(del) {
  color: var(--color-text-4);
}
.rich :deep(a) {
  color: var(--color-accent);
  text-decoration: none;
  border-bottom: 1px dashed rgba(126, 180, 255, 0.45);
}
.rich :deep(h1),
.rich :deep(h2),
.rich :deep(h3),
.rich :deep(h4) {
  margin: 14px 0 6px;
  color: var(--color-text-1);
  font-weight: 650;
  line-height: 1.35;
}
.rich :deep(h1) {
  font-size: 16px;
}
.rich :deep(h2) {
  font-size: 15px;
}
.rich :deep(h3) {
  font-size: 13.5px;
}
.rich :deep(h4) {
  font-size: 13px;
  color: var(--color-text-2);
}
.rich.compact :deep(h1),
.rich.compact :deep(h2),
.rich.compact :deep(h3),
.rich.compact :deep(h4) {
  margin: 6px 0 4px;
  font-size: 12px;
}
.rich :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid var(--color-border);
}
.rich :deep(blockquote) {
  margin: 8px 0;
  padding: 6px 10px;
  border-left: 2px solid rgba(126, 180, 255, 0.5);
  border-radius: 0 6px 6px 0;
  background: rgba(126, 180, 255, 0.07);
  color: var(--color-text-3);
  font-size: 12.5px;
}
.rich :deep(ul),
.rich :deep(ol) {
  margin: 6px 0 10px;
  padding-left: 18px;
}
.rich :deep(li) {
  margin: 3px 0;
}
.rich :deep(ul) {
  list-style: none;
  padding-left: 4px;
}
.rich :deep(ul > li) {
  position: relative;
  padding-left: 14px;
}
.rich :deep(ul > li)::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 8px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(126, 180, 255, 0.75);
}
.rich :deep(ol) {
  padding-left: 20px;
}
.rich :deep(ol > li) {
  padding-left: 2px;
}
.rich :deep(ol > li)::marker {
  color: var(--color-text-4);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.rich :deep(.ic) {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid var(--color-border);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
  color: #cbd5ff;
}

/* ── 表格 ── */
.rich :deep(.tb-wrap) {
  margin: 8px 0 10px;
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: 9px;
}
.rich :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.rich :deep(th),
.rich :deep(td) {
  padding: 6px 9px;
  text-align: left;
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}
.rich :deep(th) {
  color: var(--color-text-3);
  font-weight: 600;
  background: rgba(255, 255, 255, 0.03);
}
.rich :deep(tbody tr:last-child td) {
  border-bottom: none;
}

/* ── 代码块 / 提示词卡片 ── */
.rich :deep(.code-card) {
  margin: 8px 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-0);
  overflow: hidden;
}
.rich :deep(.code-head) {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px 5px 10px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(255, 255, 255, 0.028);
}
.rich :deep(.code-lang) {
  font-size: 10.5px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: #a5b8ff;
  text-transform: none;
}
.rich :deep(.code-lines) {
  font-size: 10px;
  color: var(--color-text-4);
  font-variant-numeric: tabular-nums;
}
.rich :deep(.code-act) {
  margin: 0 0 0 auto;
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 10.5px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
}
.rich :deep(.code-act + .code-act) {
  margin-left: 4px;
}
.rich :deep(.code-act:hover) {
  border-color: rgba(126, 180, 255, 0.5);
  background: rgba(126, 180, 255, 0.1);
  color: var(--color-text-1);
}
.rich :deep(.code-body) {
  margin: 0;
  padding: 9px 11px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.65;
  color: #d6ddf0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rich :deep(.code-card.fold .code-body) {
  max-height: 148px;
  overflow: hidden;
  position: relative;
  mask-image: linear-gradient(180deg, #000 68%, transparent 100%);
}
</style>
