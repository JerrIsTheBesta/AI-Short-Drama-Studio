<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore, useAssetsStore } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import { openLightbox } from '@/composables/useLightbox'
import { desktop, isDesktop } from '@/services/desktop'
import { pickLocalFiles } from '@/utils/pickLocalFiles'
import {
  buildScriptMarkdown,
  inferMarkdownTitle,
  normalizeImportedMarkdown,
  scriptExportFilename
} from '@/utils/scriptMarkdown'
import type { Script, ScriptChapter, VisualStyle, AspectRatio } from '@/types'

const MAX_PRODUCT_IMAGES = 5

const router = useRouter()
const project = useProjectStore()
const toast = useToastStore()
const assets = useAssetsStore()

const topic = ref('')
const content = ref('')
const style = ref<VisualStyle>('cinematic')
const aspectRatio = ref<AspectRatio>('16:9')
const shotDuration = ref(5)
/** 目标成片总时长（秒）。0 = 不限。决定剧本规模和后面拆多少镜。 */
const targetDurationSec = ref(0)
const durationOptions = [30, 40, 60, 90, 120, 180]
const durationShots = (sec: number) => Math.max(1, Math.ceil(sec / 8))
const durationScenes = (sec: number) => Math.max(2, Math.min(6, Math.round(sec / 15)))
const keywords = ref('')
const productIds = ref<string[]>([])
const productUrls = ref<Record<string, string>>({})
const workflowMode = ref<Script['workflowMode']>()
const chapters = ref<ScriptChapter[]>([])
const activeChapterId = ref('')
const selectedChapterIds = ref<Set<string>>(new Set())
const dramaLoaded = ref(false)
let dramaSaveTimer: ReturnType<typeof setTimeout> | null = null

const isDrama = computed(() => project.current?.pipelineMode === 'drama')
const activeChapter = computed(() =>
  chapters.value.find((chapter) => chapter.id === activeChapterId.value) ?? chapters.value[0]
)
const dramaWordCount = computed(() =>
  chapters.value.reduce((sum, chapter) => sum + chapter.content.replace(/\s/g, '').length, 0)
)
const selectedReadyChapters = computed(() =>
  chapters.value.filter(
    (chapter) => selectedChapterIds.value.has(chapter.id) && chapter.content.trim()
  )
)

const presets = [
  {
    name: '夏日旅行 vlog',
    topic: '厦门三日游',
    content: `清晨的鼓浪屿，海风轻拂，远处传来悠扬的钢琴声。
午后骑行在环岛路，一边是椰林，一边是蔚蓝大海。
傍晚曾厝垵的小巷里，灯笼亮起，空气中飘着沙茶面的香气。
夜晚的海滩，篝火闪烁，星空格外清澈。`
  },
  {
    name: '产品发布',
    topic: '智能耳机新品上市',
    content: `开场：极简线条勾勒耳机轮廓，金属质感彰显品质。
核心：降噪技术演示，嘈杂街头瞬间安静。
体验：佩戴轻盈，长时间无负担。
续航：30 小时超长续航，告别频繁充电。
结尾：自由掌控，静享每一刻。`
  },
  {
    name: '知识科普',
    topic: '一分钟了解黑洞',
    content: `黑洞是一个引力极强的天体，连光都无法逃脱。
它由大质量恒星坍缩形成，密度无限大。
事件视界是黑洞的边界，越过就无法返回。
霍金辐射告诉我们，黑洞也会缓慢蒸发。
人类对黑洞的探索从未停止。`
  }
]

const styleOptions: { value: VisualStyle; label: string; desc: string }[] = [
  { value: 'cinematic', label: '🎬 电影', desc: '电影感调色' },
  { value: 'anime', label: '🌸 动漫', desc: '日系动画' },
  { value: 'photorealistic', label: '📸 写实', desc: '真实摄影' },
  { value: '3d-render', label: '💎 3D 渲染', desc: 'C4D/Blender' },
  { value: 'oil-painting', label: '🎨 油画', desc: '古典油画' },
  { value: 'watercolor', label: '🖌 水彩', desc: '水彩画' },
  { value: 'pixel-art', label: '👾 像素', desc: '复古像素' },
  { value: 'ink-wash', label: '🖋 水墨', desc: '中国水墨' }
]

const aspectOptions: { value: AspectRatio; label: string }[] = [
  { value: '16:9', label: '横屏 16:9' },
  { value: '9:16', label: '竖屏 9:16' },
  { value: '1:1', label: '方形 1:1' },
  { value: '4:3', label: '传统 4:3' },
  { value: '21:9', label: '影院 21:9' }
]

onMounted(async () => {
  if (project.current?.script) {
    const s = project.current.script
    topic.value = s.topic
    content.value = s.content
    style.value = s.style
    aspectRatio.value = s.aspectRatio
    shotDuration.value = s.shotDuration
    targetDurationSec.value = Number(s.targetDurationSec) || 0
    keywords.value = Array.isArray(s.keywords) ? s.keywords.join(', ') : ''
    workflowMode.value = s.workflowMode
    productIds.value = [...(s.referenceAssetIds ?? [])].slice(0, MAX_PRODUCT_IMAGES)
    for (const id of productIds.value) {
      const url = await assets.getUrl(id)
      if (url) productUrls.value[id] = url
    }
  } else if (!topic.value && !content.value) {
    const p = presets[0]
    topic.value = p.topic
    content.value = p.content
  }

  if (isDrama.value && project.current) {
    const existing = [...(project.current.chapters ?? [])].sort((a, b) => a.order - b.order)
    if (existing.length) {
      chapters.value = existing
    } else {
      const now = Date.now()
      chapters.value = [{
        id: 'ch_' + now.toString(36),
        title: '第 1 章',
        content: project.current.script?.content ?? '',
        order: 0,
        status: project.current.script?.content?.trim() ? 'ready' : 'draft',
        createdAt: now,
        updatedAt: now
      }]
    }
    activeChapterId.value = chapters.value[0].id
    const savedSelection = project.current.selectedChapterIds ?? []
    selectedChapterIds.value = new Set(
      savedSelection.length ? savedSelection : [chapters.value[0].id]
    )
    dramaLoaded.value = true
    await persistDrama(false)
  }
})

watch(
  chapters,
  () => {
    if (!dramaLoaded.value || !isDrama.value) return
    if (dramaSaveTimer) clearTimeout(dramaSaveTimer)
    dramaSaveTimer = setTimeout(() => persistDrama(false), 700)
  },
  { deep: true }
)

onBeforeUnmount(() => {
  if (dramaSaveTimer) clearTimeout(dramaSaveTimer)
  if (dramaLoaded.value && isDrama.value) persistDrama(false)
})

function updateActiveChapter(patch: Partial<Pick<ScriptChapter, 'title' | 'content'>>) {
  const index = chapters.value.findIndex((chapter) => chapter.id === activeChapterId.value)
  if (index < 0) return
  const current = chapters.value[index]
  const next = { ...current, ...patch, updatedAt: Date.now() }
  next.status = next.content.trim() ? 'ready' : 'draft'
  chapters.value[index] = next
}

function addChapter() {
  const now = Date.now()
  const chapter: ScriptChapter = {
    id: `ch_${now.toString(36)}_${chapters.value.length + 1}`,
    title: `第 ${chapters.value.length + 1} 章`,
    content: '',
    order: chapters.value.length,
    status: 'draft',
    createdAt: now,
    updatedAt: now
  }
  chapters.value = [...chapters.value, chapter]
  activeChapterId.value = chapter.id
  selectedChapterIds.value = new Set([...selectedChapterIds.value, chapter.id])
  persistDrama(false)
}

function removeChapter(id: string) {
  if (chapters.value.length <= 1) {
    toast.warn('至少保留一个章节')
    return
  }
  const target = chapters.value.find((chapter) => chapter.id === id)
  if (!target || !confirm(`确定删除「${target.title}」吗？`)) return
  chapters.value = chapters.value.filter((chapter) => chapter.id !== id)
  const nextSelected = new Set(selectedChapterIds.value)
  nextSelected.delete(id)
  selectedChapterIds.value = nextSelected
  if (activeChapterId.value === id) activeChapterId.value = chapters.value[0].id
  persistDrama(false)
}

function moveChapter(id: string, offset: -1 | 1) {
  const index = chapters.value.findIndex((chapter) => chapter.id === id)
  const target = index + offset
  if (index < 0 || target < 0 || target >= chapters.value.length) return
  const next = [...chapters.value]
  ;[next[index], next[target]] = [next[target], next[index]]
  chapters.value = next.map((chapter, order) => ({ ...chapter, order }))
}

function toggleChapterSelection(id: string) {
  const next = new Set(selectedChapterIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedChapterIds.value = next
  persistDrama(false)
}

function selectAllReady() {
  selectedChapterIds.value = new Set(
    chapters.value.filter((chapter) => chapter.content.trim()).map((chapter) => chapter.id)
  )
  persistDrama(false)
}

async function persistDrama(showToast = false) {
  if (!project.current || !isDrama.value) return
  project.setChapters(chapters.value)
  project.setSelectedChapterIds([...selectedChapterIds.value])
  await project.save()
  if (showToast) toast.success(`已保存 ${chapters.value.length} 个章节`)
}

async function produceSelectedChapters() {
  if (!project.current) return
  if (!selectedReadyChapters.value.length) {
    toast.warn('请至少勾选一个有内容的章节')
    return
  }
  await persistDrama(false)
  const prev = project.current.script
  const selected = selectedReadyChapters.value
  const assembled = selected
    .map((chapter, index) => `## 第 ${index + 1} 章｜${chapter.title}\n\n${chapter.content.trim()}`)
    .join('\n\n---\n\n')
  project.setScript({
    id: prev?.id ?? 's_' + Date.now().toString(36),
    topic: selected.length === 1 ? selected[0].title : `${project.current.name}（${selected.length} 章）`,
    content: assembled,
    keywords: prev?.keywords ?? [],
    style: style.value,
    aspectRatio: aspectRatio.value,
    shotDuration: shotDuration.value,
    targetDurationSec: targetDurationSec.value || undefined,
    workflowMode: 'film-chapter',
    aesthetic: prev?.aesthetic,
    h3Aesthetic: prev?.h3Aesthetic,
    styleBrief: prev?.styleBrief,
    colorPalette: prev?.colorPalette,
    lightingNote: prev?.lightingNote,
    playReady: true,
    referenceAssetIds: prev?.referenceAssetIds ?? [],
    createdAt: prev?.createdAt ?? Date.now()
  })
  project.setProductionChapterIds(selected.map((chapter) => chapter.id))
  project.setPlayApproved(false)
  project.setAspectRatio(aspectRatio.value)
  await project.save()
  toast.success(`已将 ${selected.length} 个章节送入分镜设计`)
  router.push('/storyboard')
}

const wordCount = computed(() => content.value.replace(/\s/g, '').length)
const estimatedShots = computed(() => {
  const sentences = content.value.split(/[。！？!?\n]+/).filter((s) => s.trim().length > 4)
  return Math.max(1, Math.min(12, sentences.length))
})
const estimatedDuration = computed(() => estimatedShots.value * shotDuration.value)

function applyPreset(p: typeof presets[0]) {
  topic.value = p.topic
  content.value = p.content
  toast.info(`已套用：${p.name}`)
}

async function saveAndNext() {
  if (!content.value.trim() && productIds.value.length === 0) {
    toast.warn('请填写文案，或上传产品图（电商带货可只传图）')
    return
  }
  if (!project.current) {
    project.create(topic.value || '未命名项目')
  }

  const prev = project.current?.script
  const script: Script = {
    id: prev?.id ?? 's_' + Date.now().toString(36),
    topic: topic.value,
    content: content.value,
    keywords: keywords.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    style: style.value,
    aspectRatio: aspectRatio.value,
    shotDuration: shotDuration.value,
    targetDurationSec: targetDurationSec.value || undefined,
    workflowMode: workflowMode.value,
    aesthetic: prev?.aesthetic,
    h3Aesthetic: prev?.h3Aesthetic,
    styleBrief: prev?.styleBrief,
    colorPalette: prev?.colorPalette,
    lightingNote: prev?.lightingNote,
    playReady: workflowMode.value === 'film-chapter' ? true : prev?.playReady,
    referenceAssetIds: productIds.value,
    createdAt: prev?.createdAt ?? Date.now()
  }

  project.setScript(script)
  project.setAspectRatio(aspectRatio.value)
  await project.save()
  toast.success('文案已保存')
  router.push('/storyboard')
}

function applyImportedMarkdown(text: string, filename: string) {
  const normalized = normalizeImportedMarkdown(text)
  if (!normalized) {
    toast.warn('剧本文件是空的')
    return
  }
  content.value = normalized
  topic.value = inferMarkdownTitle(normalized, filename)
  workflowMode.value = 'film-chapter'
  style.value = 'cinematic'
  aspectRatio.value = '16:9'
  toast.success('已导入 Markdown 剧本，并启用原创电影章节流程')
}

async function importMarkdown() {
  if (project.current?.pipelineMode === 'remake') {
    toast.warn('视频复刻项目不导入原创电影剧本，请新建普通项目')
    return
  }
  if (isDesktop()) {
    const paths = await desktop().pickFiles([
      { name: '剧本', extensions: ['md', 'markdown', 'txt'] }
    ])
    const path = paths[0]
    if (!path) return
    applyImportedMarkdown(await desktop().readText(path), path.split(/[\\/]/).pop() || '')
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.md,.markdown,.txt,text/markdown,text/plain'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    applyImportedMarkdown(await file.text(), file.name)
  }
  input.click()
}

async function exportMarkdown() {
  const markdown = buildScriptMarkdown(topic.value, content.value)
  const filename = scriptExportFilename(topic.value)
  if (isDesktop()) {
    const path = await desktop().saveTextFile({
      defaultName: filename,
      text: markdown,
      filters: [{ name: 'Markdown 剧本', extensions: ['md'] }]
    })
    if (path) toast.success(`剧本已导出：${path}`)
    return
  }
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  toast.success('剧本已导出')
}

async function generateAndNext() {
  if (!content.value.trim() && productIds.value.length === 0) {
    toast.warn('请填写文案，或上传产品图')
    return
  }
  await saveAndNext()
}

async function pickProductImages() {
  const room = MAX_PRODUCT_IMAGES - productIds.value.length
  if (room <= 0) {
    toast.warn(`最多 ${MAX_PRODUCT_IMAGES} 张产品图`)
    return
  }
  let files: File[]
  try {
    files = (await pickLocalFiles({ kind: 'image', multiple: true })).filter((f) =>
      f.type.startsWith('image/')
    )
  } catch (err: any) {
    toast.error(err?.message || '读取产品图失败')
    return
  }
  if (!files.length) return
  let added = 0
  for (const file of files.slice(0, room)) {
    const asset = await assets.add(file, 'image', 'uploaded', {
      filename: file.name,
      projectId: project.current?.id
    })
    productIds.value = [...productIds.value, asset.id]
    const url = await assets.getUrl(asset.id)
    if (url) productUrls.value[asset.id] = url
    added++
  }
  await persistProductIds()
  toast.success(`已添加 ${added} 张产品图`)
}

async function persistProductIds() {
  if (!project.current?.script) return
  project.setScript({
    ...project.current.script,
    referenceAssetIds: productIds.value
  })
  await project.save()
}

async function removeProductImage(id: string) {
  productIds.value = productIds.value.filter((x) => x !== id)
  await persistProductIds()
}
</script>

<template>
  <div class="page">
    <header v-if="isDrama" class="page-head drama-head">
      <div>
        <div class="drama-eyebrow">AI 短剧 · 剧本模式</div>
        <h1>先把故事写好，再选择章节制作</h1>
        <p>章节会独立保存。只有点击“用已选章节设计分镜”才会进入视频生产流程。</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/')">← 项目列表</GradientButton>
        <GradientButton type="ghost" @click="persistDrama(true)">仅保存剧本</GradientButton>
        <GradientButton
          icon="🎬"
          :disabled="selectedReadyChapters.length === 0"
          @click="produceSelectedChapters"
        >
          用已选 {{ selectedReadyChapters.length }} 章设计分镜
        </GradientButton>
      </div>
    </header>

    <header v-else class="page-head">
      <div>
        <span class="kicker">步骤 1 · 文案准备</span>
        <h1>文案准备</h1>
        <p>输入主题和文案。电商带货可上传产品图（最多 5 张），分镜会按真实产品来写。</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/')">← 返回</GradientButton>
        <GradientButton
          v-if="project.current?.pipelineMode !== 'remake'"
          type="ghost"
          @click="importMarkdown"
        >导入 Markdown</GradientButton>
        <GradientButton type="ghost" @click="exportMarkdown">导出剧本</GradientButton>
        <GradientButton icon="✨" @click="generateAndNext">保存并生成分镜</GradientButton>
      </div>
    </header>

    <div v-if="isDrama" class="drama-layout">
      <aside class="chapter-panel">
        <div class="chapter-panel-head">
          <div>
            <b>章节</b>
            <span>{{ chapters.length }} 章 · {{ dramaWordCount }} 字</span>
          </div>
          <button type="button" class="chapter-add" @click="addChapter">＋ 新建</button>
        </div>

        <div class="chapter-select-bar">
          <span>已选 {{ selectedChapterIds.size }} 章</span>
          <button type="button" @click="selectAllReady">选择全部已写章节</button>
        </div>

        <div class="chapter-list">
          <article
            v-for="(chapter, index) in chapters"
            :key="chapter.id"
            class="chapter-item"
            :class="{ active: chapter.id === activeChapterId, selected: selectedChapterIds.has(chapter.id) }"
            @click="activeChapterId = chapter.id"
          >
            <label class="chapter-check" title="选择这个章节进入分镜制作" @click.stop>
              <input
                type="checkbox"
                :checked="selectedChapterIds.has(chapter.id)"
                @change="toggleChapterSelection(chapter.id)"
              />
            </label>
            <div class="chapter-item-main">
              <b>{{ chapter.title || `第 ${index + 1} 章` }}</b>
              <span>{{ chapter.content.replace(/\s/g, '').length }} 字 · {{ chapter.status === 'ready' ? '已写' : '草稿' }}</span>
              <p>{{ chapter.content.trim().slice(0, 46) || '还没有内容，点击开始写作' }}</p>
            </div>
            <div class="chapter-actions" @click.stop>
              <button type="button" title="上移" :disabled="index === 0" @click="moveChapter(chapter.id, -1)">↑</button>
              <button type="button" title="下移" :disabled="index === chapters.length - 1" @click="moveChapter(chapter.id, 1)">↓</button>
              <button type="button" class="danger" title="删除章节" @click="removeChapter(chapter.id)">×</button>
            </div>
          </article>
        </div>
      </aside>

      <main v-if="activeChapter" class="chapter-editor">
        <div class="chapter-editor-top">
          <div class="chapter-order">章节 {{ activeChapter.order + 1 }}</div>
          <div class="save-state">自动保存 · {{ activeChapter.status === 'ready' ? '可投入制作' : '草稿' }}</div>
        </div>
        <input
          class="chapter-title-input"
          :value="activeChapter.title"
          maxlength="80"
          placeholder="章节标题"
          @input="updateActiveChapter({ title: ($event.target as HTMLInputElement).value })"
        />
        <textarea
          class="chapter-content-input"
          :value="activeChapter.content"
          placeholder="开始写这一章的剧本。可以写场次、动作、人物和对白……"
          @input="updateActiveChapter({ content: ($event.target as HTMLTextAreaElement).value })"
        />
        <footer class="chapter-editor-foot">
          <span>本章 {{ activeChapter.content.replace(/\s/g, '').length }} 字</span>
          <label>
            <input
              type="checkbox"
              :checked="selectedChapterIds.has(activeChapter.id)"
              @change="toggleChapterSelection(activeChapter.id)"
            />
            完成后将本章加入分镜制作
          </label>
        </footer>
      </main>

      <aside class="production-panel">
        <h3>本次制作范围</h3>
        <p>顺序以左侧章节顺序为准。未勾选的章节只保存剧本，不会生成分镜、图片或视频。</p>
        <ol v-if="selectedReadyChapters.length">
          <li v-for="chapter in selectedReadyChapters" :key="chapter.id">
            <span>{{ chapter.title }}</span>
            <em>{{ chapter.content.replace(/\s/g, '').length }} 字</em>
          </li>
        </ol>
        <div v-else class="production-empty">勾选至少一个已经写好内容的章节</div>
        <div class="production-settings">
          <label>
            <span>画面风格</span>
            <select v-model="style">
              <option v-for="item in styleOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label>
            <span>视频比例</span>
            <select v-model="aspectRatio">
              <option v-for="item in aspectOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label>
            <span>单镜参考时长 {{ shotDuration }}s</span>
            <input v-model.number="shotDuration" type="range" min="5" max="10" step="1" />
          </label>
        </div>
        <GradientButton
          icon="🎬"
          :disabled="selectedReadyChapters.length === 0"
          @click="produceSelectedChapters"
        >
          进入分镜设计
        </GradientButton>
      </aside>
    </div>

    <div v-else class="layout">
      <div class="main">
        <GlassCard padding="lg">
          <label class="field">
            <span class="label">视频主题</span>
            <input v-model="topic" class="input" placeholder="例如：厦门三日游 / 某品牌口红带货" />
          </label>

          <div class="field">
            <div class="label">
              <span>产品图（可选，最多 {{ MAX_PRODUCT_IMAGES }} 张）</span>
              <span class="counter">{{ productIds.length }}/{{ MAX_PRODUCT_IMAGES }} · 多模态模型会看图写脚本</span>
            </div>
            <p class="hint" style="margin-bottom: 8px;">
              电商带货请上传产品实拍/白底图。没有文案也可以，AI 会按产品图撰写口播和分镜。
            </p>
            <div class="product-row">
              <div v-for="id in productIds" :key="id" class="product-thumb">
                <img
                  v-if="productUrls[id]"
                  class="zoomable"
                  :src="productUrls[id]"
                  alt="产品图"
                  title="点击查看大图"
                  @click="openLightbox(productUrls[id])"
                />
                <button class="product-del" title="移除" @click="removeProductImage(id)">×</button>
              </div>
              <button
                v-if="productIds.length < MAX_PRODUCT_IMAGES"
                class="product-add"
                @click="pickProductImages"
              >
                ＋ 上传产品图
              </button>
            </div>
          </div>

          <label class="field">
            <span class="label">
              文案内容
              <span class="counter">{{ wordCount }} 字 · 预计 {{ estimatedShots }} 个分镜 · 总时长 {{ estimatedDuration }}s</span>
              <span class="counter-hint" style="margin-left: 8px; color: var(--color-text-4); font-size: 10px;">
                （每段视频 5-10s，最终被自动 clamp）
              </span>
            </span>
            <textarea
              v-model="content"
              class="textarea"
              rows="12"
              placeholder="把视频要讲的内容写在这里。可以分段落，每一段会对应一个或多个分镜..."
            />
          </label>

          <label
            v-if="project.current?.pipelineMode !== 'remake'"
            class="workflow-option"
          >
            <input
              v-model="workflowMode"
              type="checkbox"
              true-value="film-chapter"
              :false-value="undefined"
            />
            <span>
              <b>原创电影章节流程</b>
              <small>角色定妆 → 场景锚点 → 彩色四/八宫格故事板 → H3 分镜提示词 → 视频质检</small>
            </span>
          </label>

          <label class="field">
            <span class="label">关键词（可选，用逗号分隔）</span>
            <input v-model="keywords" class="input" placeholder="例如：日落, 沙滩, 美食" />
          </label>
        </GlassCard>

        <GlassCard padding="md" class="presets">
          <div class="presets-head">
            <span>📋 一键套用示例</span>
          </div>
          <div class="preset-grid">
            <button
              v-for="p in presets"
              :key="p.name"
              class="preset"
              @click="applyPreset(p)"
            >
              <div class="preset-name">{{ p.name }}</div>
              <div class="preset-topic">{{ p.topic }}</div>
            </button>
          </div>
        </GlassCard>
      </div>

      <aside class="side">
        <GlassCard padding="md">
          <h3>画面风格</h3>
          <div class="style-grid">
            <button
              v-for="s in styleOptions"
              :key="s.value"
              class="style"
              :class="{ active: style === s.value }"
              @click="style = s.value"
            >
              <div class="style-label">{{ s.label }}</div>
              <div class="style-desc">{{ s.desc }}</div>
            </button>
          </div>
        </GlassCard>

        <GlassCard padding="md">
          <h3>视频比例</h3>
          <div class="aspect-list">
            <button
              v-for="a in aspectOptions"
              :key="a.value"
              class="aspect"
              :class="{ active: aspectRatio === a.value }"
              @click="aspectRatio = a.value"
            >
              <div class="aspect-visual" :data-ar="a.value">
                <div class="aspect-box" />
              </div>
              <div class="aspect-label">{{ a.label }}</div>
            </button>
          </div>
        </GlassCard>

        <GlassCard padding="md">
          <h3>🎯 目标成片时长</h3>
          <select v-model.number="targetDurationSec" class="target-select">
            <option :value="0">不限（按内容自然长度）</option>
            <option v-for="s in durationOptions" :key="s" :value="s">{{ s }} 秒</option>
          </select>
          <p class="hint">
            {{
              targetDurationSec
                ? `按 ${targetDurationSec} 秒硬控：约 ${durationScenes(targetDurationSec)} 场、${durationShots(targetDurationSec)} 个分镜。写剧本和拆分镜都会照这个预算收着写。`
                : '不限时长时，剧本会写满完整结构（背景+人物+多场），分镜通常十几到二十几个。要 40 秒这种短片请务必指定。'
            }}
          </p>
        </GlassCard>

        <GlassCard padding="md">
          <h3>分镜时长参考</h3>
          <div class="slider-row">
            <input
              v-model.number="shotDuration"
              type="range"
              min="5"
              max="10"
              step="1"
              class="slider"
            />
            <div class="slider-value gradient-text">{{ shotDuration }}s</div>
          </div>
          <p class="hint">整体节奏参考。AI 会按每镜口播与画面单独策划 5–10 秒，不会所有镜头同一秒数。</p>
        </GlassCard>

        <GlassCard padding="md" class="summary">
          <h3>📊 概览</h3>
          <div class="kv">
            <span>总字数</span><b>{{ wordCount }}</b>
          </div>
          <div class="kv">
            <span>预计分镜数</span><b>{{ estimatedShots }}</b>
          </div>
          <div class="kv">
            <span>预计总时长</span><b>{{ estimatedDuration }}s</b>
          </div>
          <div v-if="targetDurationSec" class="kv">
            <span>时长预算</span>
            <b :class="{ over: estimatedDuration > targetDurationSec * 1.25 }">
              {{ targetDurationSec }}s / {{ durationShots(targetDurationSec) }} 镜
            </b>
          </div>
        </GlassCard>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  max-width: 1400px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-6);
  gap: var(--space-4);
}
.page-head h1 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.02em;
  margin: 0 0 6px;
}
.page-head p {
  font-size: 12.5px;
  color: var(--color-text-3);
  margin: 0;
  line-height: 1.6;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}
.kicker {
  display: inline-block;
  margin-bottom: 7px;
  padding: 2px 9px;
  border: 1px solid rgba(126, 180, 255, 0.3);
  border-radius: 99px;
  background: rgba(126, 180, 255, 0.1);
  color: #a8c0ff;
  font-size: 10.5px;
  font-weight: 650;
  letter-spacing: 0.06em;
}
.drama-eyebrow {
  margin-bottom: 6px;
  color: var(--color-accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.drama-layout {
  display: grid;
  grid-template-columns: 280px minmax(420px, 1fr) 280px;
  min-height: calc(100vh - 170px);
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-1);
}
.chapter-panel,
.production-panel {
  min-width: 0;
  background: color-mix(in srgb, var(--color-bg-2) 82%, transparent);
}
.chapter-panel {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
}
.chapter-panel-head,
.chapter-select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid var(--color-border);
}
.chapter-panel-head > div {
  display: grid;
  gap: 2px;
}
.chapter-panel-head b {
  font-size: 15px;
}
.chapter-panel-head span,
.chapter-select-bar span {
  color: var(--color-text-3);
  font-size: 11px;
}
.chapter-add,
.chapter-select-bar button {
  color: var(--color-accent);
  font-size: 12px;
}
.chapter-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.chapter-item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
  margin-bottom: 6px;
  padding: 11px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--duration-fast);
}
.chapter-item:hover {
  background: var(--color-fill);
}
.chapter-item.active {
  border-color: var(--color-accent);
  background: var(--grad-primary-soft);
}
.chapter-item.selected:not(.active) {
  border-color: color-mix(in srgb, var(--color-accent) 34%, transparent);
}
.chapter-check {
  padding-top: 2px;
}
.chapter-item-main {
  min-width: 0;
}
.chapter-item-main b,
.chapter-item-main span,
.chapter-item-main p {
  display: block;
}
.chapter-item-main b {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chapter-item-main span {
  margin-top: 3px;
  color: var(--color-text-3);
  font-size: 10px;
}
.chapter-item-main p {
  display: -webkit-box;
  overflow: hidden;
  margin: 7px 0 0;
  color: var(--color-text-4);
  font-size: 11px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.chapter-actions {
  display: grid;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--duration-fast);
}
.chapter-item:hover .chapter-actions,
.chapter-item.active .chapter-actions {
  opacity: 1;
}
.chapter-actions button {
  width: 22px;
  height: 20px;
  color: var(--color-text-3);
  font-size: 12px;
}
.chapter-actions button:disabled {
  opacity: 0.25;
}
.chapter-actions .danger:hover {
  color: var(--color-error);
}
.chapter-editor {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 24px 30px 18px;
}
.chapter-editor-top,
.chapter-editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--color-text-3);
  font-size: 11px;
}
.chapter-order {
  color: var(--color-accent);
  font-weight: 700;
}
.chapter-title-input {
  width: 100%;
  margin: 18px 0 12px;
  border: 0;
  border-bottom: 1px solid var(--color-border);
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-size: 28px;
  font-weight: 750;
  line-height: 1.4;
}
.chapter-title-input:focus {
  border-color: var(--color-accent);
}
.chapter-content-input {
  width: 100%;
  min-height: 480px;
  flex: 1;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--color-text-1);
  font-family: inherit;
  font-size: 15px;
  line-height: 2;
}
.chapter-editor-foot {
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}
.chapter-editor-foot label {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
}
.production-panel {
  padding: 18px;
  border-left: 1px solid var(--color-border);
}
.production-panel h3 {
  margin: 0 0 7px;
  font-size: 15px;
}
.production-panel > p {
  margin: 0 0 14px;
  color: var(--color-text-3);
  font-size: 11px;
  line-height: 1.6;
}
.production-panel ol {
  display: grid;
  max-height: 230px;
  gap: 6px;
  overflow-y: auto;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
  counter-reset: chapter;
}
.production-panel li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-1);
  font-size: 12px;
  counter-increment: chapter;
}
.production-panel li span::before {
  content: counter(chapter) '. ';
  color: var(--color-accent);
}
.production-panel li em {
  flex: none;
  color: var(--color-text-4);
  font-style: normal;
  font-size: 10px;
}
.production-empty {
  margin-bottom: 16px;
  padding: 20px 12px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  color: var(--color-text-4);
  font-size: 11px;
  line-height: 1.5;
  text-align: center;
}
.production-settings {
  display: grid;
  gap: 12px;
  margin: 18px 0;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
}
.production-settings label {
  display: grid;
  gap: 6px;
  color: var(--color-text-3);
  font-size: 11px;
}
.production-settings select {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  background: var(--color-bg-1);
  color: var(--color-text-1);
}
.production-panel :deep(.gradient-btn) {
  width: 100%;
}
@media (max-width: 1100px) {
  .drama-layout {
    grid-template-columns: 240px minmax(380px, 1fr);
  }
  .production-panel {
    display: none;
  }
}
.workflow-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: var(--space-3);
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  cursor: pointer;
}
.workflow-option input {
  margin-top: 3px;
}
.workflow-option span {
  display: grid;
  gap: 3px;
}
.workflow-option small {
  color: var(--color-text-3);
  line-height: 1.5;
}

.layout {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: var(--space-5);
}
.main {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.field {
  display: block;
  margin-bottom: var(--space-4);
}
.field:last-child {
  margin-bottom: 0;
}
.label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--color-text-3);
  margin-bottom: 6px;
  font-weight: 500;
}
.counter {
  font-size: 11px;
  color: var(--color-text-4);
}
.input,
.textarea {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  font-size: 13px;
  color: var(--color-text-1);
  outline: none;
  transition: all var(--duration-fast);
  font-family: inherit;
  resize: vertical;
}
.textarea {
  line-height: 1.7;
  min-height: 200px;
}
.input:focus,
.textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.15);
}

.presets-head {
  font-size: 13px;
  color: var(--color-text-2);
  font-weight: 600;
  margin-bottom: var(--space-3);
}
.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-2);
}
.preset {
  text-align: left;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  transition: all var(--duration-fast);
}
.preset:hover {
  border-color: var(--color-accent);
  background: var(--grad-primary-soft);
}
.preset-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}
.preset-topic {
  font-size: 11px;
  color: var(--color-text-3);
}

.side h3 {
  font-size: 13px;
  margin: 0 0 var(--space-3);
  font-weight: 600;
  color: var(--color-text-2);
}
.style-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
}
.style {
  text-align: left;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  transition: all var(--duration-fast);
}
.style:hover {
  border-color: var(--color-border-strong);
}
.style.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
}
.style-label {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
}
.style-desc {
  font-size: 10px;
  color: var(--color-text-4);
}

.aspect-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.aspect {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 6px 10px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  transition: all var(--duration-fast);
}
.aspect:hover {
  border-color: var(--color-border-strong);
}
.aspect.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
}
.aspect-visual {
  width: 36px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-fill);
  border-radius: 2px;
}
.aspect-box {
  background: currentColor;
  color: var(--color-text-3);
}
.aspect-visual[data-ar='16:9'] .aspect-box { width: 32px; height: 18px; }
.aspect-visual[data-ar='9:16'] .aspect-box { width: 14px; height: 24px; }
.aspect-visual[data-ar='1:1'] .aspect-box { width: 22px; height: 22px; }
.aspect-visual[data-ar='4:3'] .aspect-box { width: 28px; height: 21px; }
.aspect-visual[data-ar='21:9'] .aspect-box { width: 36px; height: 16px; }
.aspect-label {
  font-size: 12px;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: var(--color-bg-2);
  border-radius: var(--radius-full);
  outline: none;
}
.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--grad-primary);
  cursor: pointer;
  border: 2px solid white;
  box-shadow: 0 0 8px rgba(124, 58, 237, 0.4);
}
.slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--grad-primary);
  cursor: pointer;
  border: 2px solid white;
}
.slider-value {
  font-size: 16px;
  font-weight: 700;
  min-width: 50px;
  text-align: right;
}
.hint {
  font-size: 11px;
  color: var(--color-text-4);
  margin: 6px 0 0;
}
.target-select {
  width: 100%;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-fill);
  color: var(--color-text-1);
  font-size: 12px;
  padding: 0 8px;
}
.kv b.over {
  color: #ff6b6b;
}
.product-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.product-thumb {
  position: relative;
  width: 88px;
  height: 88px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
}
.product-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.product-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 14px;
  line-height: 1;
}
.product-del:hover {
  background: var(--color-error);
}
.product-add {
  width: 88px;
  height: 88px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-text-3);
  font-size: 12px;
  line-height: 1.3;
  padding: 8px;
}
.product-add:hover {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: var(--grad-primary-soft);
}

.summary .kv {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 6px;
  color: var(--color-text-3);
}
.summary .kv b {
  color: var(--color-text-1);
  font-weight: 600;
}
</style>
