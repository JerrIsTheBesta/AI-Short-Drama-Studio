<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore, useLibraryStore, LIBRARY_PUBLIC_ID } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import GalleryTemplates from '@/components/common/GalleryTemplates.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import HomeIcon from '@/components/common/HomeIcon.vue'
import ThemeToggle from '@/components/common/ThemeToggle.vue'
import { isDesktop, desktop } from '@/services/desktop'
import { pickCoverAssetId, projectCoverUrl } from '@/services/storage'
import { pickLocalFiles } from '@/utils/pickLocalFiles'
import { openLightbox } from '@/composables/useLightbox'

const router = useRouter()
const showWindowChrome = /electron/i.test(navigator.userAgent) || isDesktop()
const project = useProjectStore()
const toast = useToastStore()

const search = ref('')
const searchEl = ref<HTMLInputElement | null>(null)
const creating = ref(false)
type HomeNav = 'home' | 'projects' | 'library' | 'tools' | 'templates'
type ProjectFilter = 'all' | 'active' | 'done'
const nav = ref<HomeNav>('home')
const projectFilter = ref<ProjectFilter>('all')
const viewMode = ref<'grid' | 'list'>('grid')

const covers = ref<Record<string, string>>({})
const library = useLibraryStore()
const libUrls = ref<Record<string, string>>({})
const libUploading = ref(false)
const libKind = ref<'all' | 'image' | 'video' | 'audio'>('all')
const libSelected = ref<Set<string>>(new Set())
const libMoveTarget = ref(LIBRARY_PUBLIC_ID)

function showHomeNav() {
  nav.value = 'home'
}

onMounted(async () => {
  window.addEventListener('aicut:home', showHomeNav)
  await project.refreshList()
  await library.refresh()
  await loadLibraryThumbs()
})

watch(
  () => library.all.map((a) => a.id).join(','),
  () => {
    loadLibraryThumbs()
  }
)

const coverKeys = ref<Record<string, string>>({})

function revokeCover(url?: string) {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

watch(
  () => project.allProjects.map((p) => `${p.id}:${pickCoverAssetId(p) || ''}`).join('|'),
  async () => {
    const next: Record<string, string> = {}
    const nextKeys: Record<string, string> = {}
    for (const p of project.allProjects) {
      const key = pickCoverAssetId(p) || ''
      nextKeys[p.id] = key
      if (key && coverKeys.value[p.id] === key && covers.value[p.id]) {
        next[p.id] = covers.value[p.id]
        continue
      }
      revokeCover(covers.value[p.id])
      if (!key) continue
      try {
        const url = await projectCoverUrl(p)
        if (url) next[p.id] = url
      } catch {
        /* 某个项目素材读失败就跳过 */
      }
    }
    for (const [id, url] of Object.entries(covers.value)) {
      if (!next[id]) revokeCover(url)
    }
    coverKeys.value = nextKeys
    covers.value = next
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  window.removeEventListener('aicut:home', showHomeNav)
  for (const url of Object.values(covers.value)) revokeCover(url)
})

const filteredProjects = computed(() => {
  const kw = search.value.trim().toLowerCase()
  if (!kw) return project.allProjects
  return project.allProjects.filter(
    (p) =>
      p.name.toLowerCase().includes(kw) ||
      p.script?.topic.toLowerCase().includes(kw)
  )
})

function projectDone(p: { shots: { videoAssetId?: string }[] }) {
  return p.shots.length > 0 && p.shots.every((shot) => Boolean(shot.videoAssetId))
}

const activeCount = computed(() => project.allProjects.filter((p) => !projectDone(p)).length)
const doneCount = computed(() => project.allProjects.filter((p) => projectDone(p)).length)

const listedProjects = computed(() => {
  if (projectFilter.value === 'active') return filteredProjects.value.filter((p) => !projectDone(p))
  if (projectFilter.value === 'done') return filteredProjects.value.filter((p) => projectDone(p))
  return filteredProjects.value
})

function focusProjectSearch() {
  if (nav.value === 'library' || nav.value === 'tools' || nav.value === 'templates') nav.value = 'projects'
  nextTick(() => searchEl.value?.focus())
}

function openLatestProject() {
  const latest = [...project.allProjects].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!latest) {
    toast.warn('还没有项目，先创建一个')
    return
  }
  openProject(latest.id)
}

const totalShots = computed(() =>
  project.allProjects.reduce((sum, p) => sum + p.shots.length, 0)
)
const totalDuration = computed(() => {
  let total = 0
  for (const p of project.allProjects) {
    total += p.timeline.reduce((s, c) => s + c.duration, 0)
  }
  return total
})

function openProject(id: string) {
  project.load(id).then(() => {
    const mode = project.current?.pipelineMode
    router.push(mode === 'smart-speech' ? '/smart-speech' : mode === 'drama' ? '/script' : '/studio')
  })
}

function goClassicFlow() {
  if (project.current) {
    router.push('/script')
    return
  }
  const latest = project.allProjects[0]
  if (latest) openProjectAs(latest.id, 'script')
  else router.push('/script')
}

function openProjectAs(id: string, target: 'studio' | 'script') {
  project.load(id).then(() => {
    const mode = project.current?.pipelineMode
    if (mode === 'smart-speech') {
      router.push('/smart-speech')
      return
    }
    router.push(target === 'script' ? '/script' : '/studio')
  })
}

/** 新建：不再弹选项，直接开一张新画布 */
async function quickCreate() {
  if (creating.value) return
  creating.value = true
  try {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const label = `新项目 ${now.getMonth() + 1}-${now.getDate()} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    const p = await project.createNamed(label)
    p.pipelineMode = 'standard'
    p.script = {
      id: 's_' + Date.now().toString(36),
      topic: label,
      content: '',
      keywords: [],
      style: 'cinematic',
      aspectRatio: '16:9',
      shotDuration: 5,
      createdAt: Date.now()
    }
    project.setScript(p.script)
    project.setAspectRatio('16:9')
    await project.save()
    router.push('/studio')
  } catch (e: any) {
    toast.error(e?.message || '创建失败，请重试')
  } finally {
    creating.value = false
  }
}

async function startRemake() {
  if (creating.value) return
  creating.value = true
  try {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const label = `视频复刻 ${now.getMonth() + 1}-${now.getDate()} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    const p = await project.createNamed(label)
    p.pipelineMode = 'remake'
    await project.save()
    router.push('/studio')
  } catch (e: any) {
    toast.error(e?.message || '创建失败，请重试')
  } finally {
    creating.value = false
  }
}

function deleteProject(id: string) {
  if (!confirm('确定要删除该项目吗？素材也会被一起删除。')) return
  project.remove(id)
  toast.success('项目已删除')
}

async function openProjectFolder(projectId?: string) {
  if (!isDesktop()) return
  const target = projectId
    ? project.allProjects.find((item) => item.id === projectId)
    : project.current
  const dir = target?.folderPath
  if (!dir) {
    toast.warn(target ? '这个旧项目没有本地目录记录' : '请先创建或打开一个项目')
    return
  }
  const error = await desktop().openPath(dir)
  if (error) toast.error(`无法打开项目目录：${error}`)
}

async function openQuickEditor() {
  if (!project.current) {
    const now = new Date()
    const label = `${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const p = await project.createNamed(`自由剪辑 ${label}`)
    p.pipelineMode = 'img2video'
    p.playApproved = true
    p.script = {
      id: 's_' + Date.now().toString(36),
      topic: '自由剪辑',
      content: '',
      keywords: [],
      style: 'cinematic',
      aspectRatio: '16:9',
      shotDuration: 5,
      createdAt: Date.now()
    }
    project.setScript(p.script)
    await project.save()
  }
  await router.push('/edit')
}

function fmtDate(ts: number) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const statItems = computed(() => [
  { value: String(project.allProjects.length), label: '项目' },
  { value: String(totalShots.value), label: '分镜' },
  { value: fmtDuration(totalDuration.value), label: '视频总时长', accent: true }
])

const libKindCount = computed(() => ({
  image: library.all.filter((a) => a.kind === 'image').length,
  video: library.all.filter((a) => a.kind === 'video').length,
  audio: library.all.filter((a) => a.kind === 'audio').length,
  all: library.all.length
}))

const libTabs = computed(() => [
  { id: 'image' as const, label: '图片', count: libKindCount.value.image },
  { id: 'video' as const, label: '视频', count: libKindCount.value.video },
  { id: 'audio' as const, label: '音频', count: libKindCount.value.audio },
  { id: 'all' as const, label: '全部', count: libKindCount.value.all }
])

const visibleLibraryAssets = computed(() =>
  libKind.value === 'all' ? library.all : library.all.filter((a) => a.kind === libKind.value)
)

const selectedLibraryNames = computed(() => {
  const names = [...libSelected.value]
    .map((id) => library.getMeta(id)?.filename)
    .filter((name): name is string => Boolean(name))
  if (names.length <= 3) return names.join('、')
  return `${names.slice(0, 3).join('、')} 等`
})

function setLibKind(id: 'all' | 'image' | 'video' | 'audio') {
  libKind.value = id
  libSelected.value = new Set()
}

function openLibraryItem(asset: { id: string; kind: string; filename: string }) {
  const url = libUrls.value[asset.id]
  if (!url || asset.kind === 'audio') return
  openLightbox(url, asset.kind === 'video' ? 'video' : 'image', asset.filename)
}

function clearLibSelected() {
  libSelected.value = new Set()
}

function toggleLibSelect(id: string) {
  const next = new Set(libSelected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  libSelected.value = next
}

async function loadLibraryThumbs() {
  const next: Record<string, string> = { ...libUrls.value }
  for (const a of library.all) {
    if (next[a.id]) continue
    const url = await library.getUrl(a.id)
    if (url) next[a.id] = url
  }
  libUrls.value = next
}

async function uploadLibraryImages() {
  if (libUploading.value) return
  let files: File[]
  try {
    files = (await pickLocalFiles({ kind: 'image', multiple: true })).filter((f) =>
      f.type.startsWith('image/')
    )
  } catch (err: any) {
    toast.error(err?.message || '读取图片失败')
    return
  }
  if (!files.length) return
  libUploading.value = true
  try {
    for (const file of files) {
      await library.add(file, 'uploaded', { filename: file.name })
    }
    await loadLibraryThumbs()
    toast.success(`已上传 ${files.length} 张`)
  } catch (err: any) {
    toast.error(err?.message || '上传失败')
  } finally {
    libUploading.value = false
  }
}

async function removeLibraryItem(id: string) {
  if (!confirm('从资产库删除这张图？')) return
  await library.remove(id)
  delete libUrls.value[id]
  const next = new Set(libSelected.value)
  next.delete(id)
  libSelected.value = next
  toast.success('已删除')
}

async function downloadSelectedLibrary() {
  const ids = [...libSelected.value]
  let saved = 0
  for (const id of ids) {
    const asset = library.getMeta(id)
    const blob = await library.getBlob(id)
    if (!blob || !asset) continue
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = asset.filename || id
    link.click()
    URL.revokeObjectURL(url)
    saved += 1
    await new Promise((resolve) => setTimeout(resolve, 180))
  }
  toast[saved ? 'success' : 'warn'](saved ? `开始下载 ${saved} 项` : '这些素材读不出来')
}

async function removeSelectedLibrary() {
  const ids = [...libSelected.value]
  if (!ids.length) return
  if (!confirm(`从资产库删除这 ${ids.length} 项？`)) return
  for (const id of ids) {
    await library.remove(id)
    delete libUrls.value[id]
  }
  libSelected.value = new Set()
  toast.success(`已删除 ${ids.length} 项`)
}

async function moveSelectedLibrary() {
  const ids = [...libSelected.value]
  if (!ids.length) return
  try {
    await library.moveToFolder(ids, libMoveTarget.value)
    libSelected.value = new Set()
    const label =
      libMoveTarget.value === LIBRARY_PUBLIC_ID
        ? '公共资产'
        : library.folderName(libMoveTarget.value)
    toast.success(`已转移到「${label}」`)
  } catch (err: any) {
    toast.error(err?.message || '转移失败')
  }
}
</script>

<template>
  <div class="home">
    <aside class="sidenav">
      <button v-if="!showWindowChrome" type="button" class="brand" @click="nav = 'home'">
        <img class="brand-mark" src="/logo.png" alt="" />
        <span class="nav-label">剧流 Studio</span>
      </button>
      <nav class="side-links" aria-label="首页导航">
        <button type="button" :class="{ on: nav === 'home' }" @click="nav = 'home'">
          <HomeIcon name="home" :size="18" /><span class="nav-label">首页</span>
        </button>
        <button type="button" :class="{ on: nav === 'projects' }" @click="nav = 'projects'">
          <HomeIcon name="folder" :size="18" /><span class="nav-label">我的项目</span>
        </button>
        <button type="button" @click="router.push('/scripts')">
          <HomeIcon name="script" :size="18" /><span class="nav-label">剧本管理</span>
        </button>
        <button type="button" :class="{ on: nav === 'library' }" @click="nav = 'library'">
          <HomeIcon name="library" :size="18" /><span class="nav-label">素材库</span>
        </button>
        <button type="button" :class="{ on: nav === 'templates' }" @click="nav = 'templates'">
          <HomeIcon name="image" :size="18" /><span class="nav-label">图库模板</span>
        </button>
        <button type="button" :class="{ on: nav === 'tools' }" @click="nav = 'tools'">
          <HomeIcon name="wand" :size="18" /><span class="nav-label">工具集</span>
        </button>
        <button type="button" @click="router.push('/settings')">
          <HomeIcon name="settings" :size="18" /><span class="nav-label">设置</span>
        </button>
        <a class="tutorial-link" href="https://www.bilibili.com/video/BV1o6n66fE5p/" target="_blank" rel="noopener noreferrer">
          <HomeIcon name="play" :size="18" /><span class="nav-label">视频教程</span>
        </a>
      </nav>
      <div class="side-foot">
        <ThemeToggle />
        <a href="https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio" target="_blank" rel="noreferrer">
          <HomeIcon name="github" :size="16" />
          <span class="nav-label">去 GitHub</span>
        </a>
      </div>
    </aside>

    <div class="stage">
      <div v-if="nav !== 'home'" class="stage-bar">
        <button type="button" class="icon-round" title="搜索项目" @click="focusProjectSearch">
          <HomeIcon name="search" :size="16" />
        </button>
        <button type="button" class="icon-round avatar" title="设置" @click="router.push('/settings')">
          <HomeIcon name="settings" :size="16" />
        </button>
      </div>

      <template v-if="nav === 'home'">
        <section class="banner">
          <div class="banner-flow" aria-hidden="true">
            <svg viewBox="0 0 1000 240" preserveAspectRatio="none">
              <defs>
                <linearGradient id="banner-wave" x1="0" y1="0" x2="1000" y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="var(--nb-accent-2)" stop-opacity="0.42" />
                  <stop offset="42%" stop-color="var(--nb-accent)" stop-opacity="0.22" />
                  <stop offset="100%" stop-color="var(--nb-accent)" stop-opacity="0" />
                </linearGradient>
              </defs>
              <path class="wave hint" vector-effect="non-scaling-stroke" d="M0 108C42 94 83 94 125 108C167 122 208 122 250 108C292 94 333 94 375 108C417 122 458 122 500 108C542 94 583 94 625 108C667 122 708 122 750 108C792 94 833 94 875 108C917 122 958 122 1000 108" />
              <path class="wave streak" vector-effect="non-scaling-stroke" d="M0 108C42 94 83 94 125 108C167 122 208 122 250 108C292 94 333 94 375 108C417 122 458 122 500 108C542 94 583 94 625 108C667 122 708 122 750 108C792 94 833 94 875 108C917 122 958 122 1000 108" />
              <path class="wave hint" vector-effect="non-scaling-stroke" d="M0 148C42 160 83 160 125 148C167 136 208 136 250 148C292 160 333 160 375 148C417 136 458 136 500 148C542 160 583 160 625 148C667 136 708 136 750 148C792 160 833 160 875 148C917 136 958 136 1000 148" />
              <path class="wave streak late" vector-effect="non-scaling-stroke" d="M0 148C42 160 83 160 125 148C167 136 208 136 250 148C292 160 333 160 375 148C417 136 458 136 500 148C542 160 583 160 625 148C667 136 708 136 750 148C792 160 833 160 875 148C917 136 958 136 1000 148" />
            </svg>
          </div>
          <div class="banner-copy">
            <span class="home-kicker">剧流 Studio · AI 短剧工作台</span>
            <h1>用 AI 创作<br /><em>属于你的短剧世界</em></h1>
            <p>一站式完成剧本、角色、分镜、影像、配音与合成。模型自由接入，随时重做其中任意一步。</p>
            <div class="banner-actions">
              <button type="button" class="go" :disabled="creating" @click="quickCreate">开始创作</button>
              <button type="button" class="open" @click="openLatestProject">打开项目</button>
            </div>
            <div class="hero-meta">
              <div><strong>{{ project.allProjects.length }}</strong><span>本地项目</span></div>
              <div><strong>{{ totalShots }}</strong><span>已产出分镜</span></div>
              <div><strong>{{ doneCount }}</strong><span>已完成项目</span></div>
            </div>
          </div>
          <img class="banner-art" src="/home-banner.png" alt="" />
        </section>

        <section class="quick">
          <h2><i /> 快速入口</h2>
          <div class="quick-row">
            <button type="button" @click="quickCreate">
              <span class="q-icon violet"><HomeIcon name="video" :size="18" /></span>
              <span><strong>AI 生成视频</strong><em>文生视频 / 图生视频</em></span>
              <b>→</b>
            </button>
            <button type="button" @click="openQuickEditor">
              <span class="q-icon blue"><HomeIcon name="scissors" :size="18" /></span>
              <span><strong>视频剪辑</strong><em>智能剪辑与合成</em></span>
              <b>→</b>
            </button>
            <button type="button" @click="router.push({ name: 'smart-speech', query: { new: '1' } })">
              <span class="q-icon green"><HomeIcon name="video" :size="18" /></span>
              <span><strong>数字人</strong><em>一键复刻与驱动</em></span>
              <b>→</b>
            </button>
            <button type="button" @click="startRemake">
              <span class="q-icon indigo"><HomeIcon name="remake" :size="18" /></span>
              <span><strong>视频复刻</strong><em>克隆你的风格</em></span>
              <b>→</b>
            </button>
            <button type="button" @click="quickCreate">
              <span class="q-icon amber"><HomeIcon name="wand" :size="18" /></span>
              <span><strong>AI 特效</strong><em>创造更多可能</em></span>
              <b>→</b>
            </button>
          </div>
        </section>
      </template>

      <section v-if="nav === 'tools'" class="tools">
        <h2>工具集</h2>
        <div class="quick-row">
          <button type="button" @click="router.push('/scripts')">
            <span class="q-icon indigo"><HomeIcon name="script" :size="18" /></span>
            <span><strong>剧本管理</strong><em>编写、导入、按集修改</em></span>
          </button>
          <button type="button" @click="goClassicFlow">
            <span class="q-icon amber"><HomeIcon name="wand" :size="18" /></span>
            <span><strong>经典步骤</strong><em>文案、分镜、配图、导出</em></span>
          </button>
          <button type="button" @click="openQuickEditor">
            <span class="q-icon blue"><HomeIcon name="scissors" :size="18" /></span>
            <span><strong>视频剪辑</strong><em>时间线编排</em></span>
          </button>
          <button type="button" @click="router.push({ name: 'smart-speech', query: { new: '1' } })">
            <span class="q-icon green"><HomeIcon name="mic" :size="18" /></span>
            <span><strong>智能口播</strong><em>数字人与配音</em></span>
          </button>
        </div>
      </section>

      <section v-if="nav === 'home' || nav === 'projects'" class="projects">
        <div class="proj-head">
          <h2><HomeIcon name="folder" :size="16" /> 我的项目</h2>
          <div class="filters" role="tablist">
            <button type="button" :class="{ on: projectFilter === 'all' }" @click="projectFilter = 'all'">全部 ({{ project.allProjects.length }})</button>
            <button type="button" :class="{ on: projectFilter === 'active' }" @click="projectFilter = 'active'">进行中 ({{ activeCount }})</button>
            <button type="button" :class="{ on: projectFilter === 'done' }" @click="projectFilter = 'done'">已完成 ({{ doneCount }})</button>
          </div>
          <label class="filter">
            <HomeIcon class="search-icon" name="search" :size="16" />
            <input id="home-search" ref="searchEl" v-model="search" class="search" placeholder="搜索项目" />
          </label>
          <div class="view-toggle">
            <button type="button" :class="{ on: viewMode === 'grid' }" title="网格" @click="viewMode = 'grid'">
              <HomeIcon name="image" :size="15" />
            </button>
            <button type="button" :class="{ on: viewMode === 'list' }" title="列表" @click="viewMode = 'list'">
              <HomeIcon name="library" :size="15" />
            </button>
          </div>
        </div>
      <div class="grid" :class="viewMode">
        <button type="button" class="create-card" :disabled="creating" @click="quickCreate">
          <span class="create-mark"><HomeIcon name="film" :size="28" /></span>
          <strong>新建项目</strong>
          <em>从空白开始创作</em>
          <span class="create-go">创建项目 →</span>
        </button>
        <p v-if="listedProjects.length === 0" class="filter-empty">这个分类里还没有项目</p>
        <GlassCard
          v-for="p in listedProjects"
          :key="p.id"
          hoverable
          padding="none"
          class="proj"
          @click="openProject(p.id)"
        >
          <div class="proj-thumb">
            <img v-if="covers[p.id]" class="proj-cover" :src="covers[p.id]" alt="" />
            <div v-else class="proj-thumb-grad" :data-style="p.script?.style || 'cinematic'" />
            <div v-if="!covers[p.id]" class="proj-thumb-overlay">
              <div class="proj-thumb-icon"><HomeIcon name="film" :size="42" /></div>
            </div>
            <div class="proj-open">
              <button
                type="button"
                class="open-btn primary"
                title="在无限画布里继续"
                @click.stop="openProjectAs(p.id, 'studio')"
              >
                画布<em>→</em>
              </button>
              <button
                type="button"
                class="open-btn"
                title="按 剧本 → 分镜 → 图片 → 视频 → 剪辑 的分步流程继续"
                @click.stop="openProjectAs(p.id, 'script')"
              >
                经典步骤<em>→</em>
              </button>
            </div>
            <div class="proj-meta-top">
              <span v-if="p.shots.length" class="shot-pill">{{ p.shots.length }} 个分镜</span>
              <span class="phase" :class="projectDone(p) ? 'done' : 'active'">{{ projectDone(p) ? '已完成' : '进行中' }}</span>
              <Tag v-if="p.pipelineMode === 'remake'" type="warning" size="sm">复刻</Tag>
              <Tag v-else-if="p.pipelineMode === 'img2video'" type="info" size="sm">自由模式</Tag>
              <Tag v-else-if="p.pipelineMode === 'smart-speech'" type="success" size="sm">智能口播</Tag>
              <Tag v-else-if="p.pipelineMode === 'drama'" type="accent" size="sm">AI 短剧 · {{ p.chapters?.length || 0 }} 章</Tag>
              <Tag v-if="p.shots.length > 0" type="accent" size="sm">
                <HomeIcon name="film" :size="12" />{{ p.shots.length }} 个分镜
              </Tag>
              <Tag
                v-if="p.shots.some((s) => s.imageAssetId)"
                type="info"
                size="sm"
              >
                <HomeIcon name="image" :size="12" />{{ p.shots.filter((s) => s.imageAssetId).length }} 张图
              </Tag>
              <Tag
                v-if="p.shots.some((s) => s.videoAssetId)"
                type="success"
                size="sm"
              >
                <HomeIcon name="video" :size="12" />{{ p.shots.filter((s) => s.videoAssetId).length }} 段视频
              </Tag>
            </div>
          </div>
          <div class="proj-info">
            <div class="proj-name">{{ p.name }}</div>
            <div class="proj-topic" v-if="p.script?.topic">
              {{ p.script.topic }}
            </div>
            <div class="proj-bottom">
              <span class="proj-date">{{ fmtDate(p.updatedAt) }}</span>
              <div class="proj-actions" @click.stop>
                <button
                  v-if="isDesktop()"
                  class="proj-folder"
                  :disabled="!p.folderPath"
                  :title="p.folderPath ? '打开项目目录' : '该项目没有本地目录记录'"
                  @click="openProjectFolder(p.id)"
                >
                  <HomeIcon name="folder" :size="16" />
                </button>
                <button
                  class="proj-del"
                  title="删除"
                  @click="deleteProject(p.id)"
                >
                  <HomeIcon name="trash" :size="16" />
                </button>
              </div>
            </div>
          </div>
        </GlassCard>
      </div>
      </section>

      <GalleryTemplates v-if="nav === 'templates'" />
      <div v-if="nav === 'library'" class="lib-page">
        <header class="lib-top">
          <div>
            <span class="home-kicker">资源库 · 全部项目</span>
            <h2>所有素材，都在这里</h2>
            <p>跨项目的画面、视频和音频。勾选后可以批量下载、转移到文件夹，或一起删除。</p>
          </div>
          <button type="button" class="lib-upload" :disabled="libUploading" @click="uploadLibraryImages">
            <HomeIcon name="upload" :size="16" />
            {{ libUploading ? '上传中…' : '导入素材' }}
          </button>
        </header>
        <div class="lib-tabs" role="tablist">
          <button
            v-for="tab in libTabs"
            :key="tab.id"
            type="button"
            role="tab"
            class="lib-tab"
            :class="{ on: libKind === tab.id }"
            :aria-selected="libKind === tab.id"
            @click="setLibKind(tab.id)"
          >
            {{ tab.label }} <span class="cnt">{{ tab.count }}</span>
          </button>
        </div>
        <div v-if="libSelected.size" class="lib-batch">
          <span class="n">已选择 {{ libSelected.size }} 项</span>
          <span v-if="selectedLibraryNames" class="d">{{ selectedLibraryNames }}</span>
          <div class="lib-batch-actions">
            <select v-model="libMoveTarget" aria-label="移动到文件夹">
              <option :value="LIBRARY_PUBLIC_ID">公共资产</option>
              <option v-for="f in library.folders" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <button type="button" class="outline" @click="moveSelectedLibrary">移动到文件夹</button>
            <button type="button" class="outline" @click="downloadSelectedLibrary">
              <HomeIcon name="download" :size="14" />
              批量下载
            </button>
            <button type="button" class="danger" @click="removeSelectedLibrary">
              <HomeIcon name="trash" :size="14" />
              删除
            </button>
            <button type="button" class="ghost" @click="clearLibSelected">取消选择</button>
          </div>
        </div>
        <EmptyState
          v-if="visibleLibraryAssets.length === 0"
          :title="library.all.length === 0 ? '资产库还是空的' : '这个分类还是空的'"
          :description="library.all.length === 0 ? '上传图片，或在项目画布里把生成图加入公共库' : '换一个标签，或导入新的素材'"
        >
          <template #icon>
            <HomeIcon :name="libKind === 'video' ? 'video' : libKind === 'audio' ? 'mic' : 'image'" :size="44" />
          </template>
        </EmptyState>
        <div v-else class="lib-grid">
          <div
            v-for="a in visibleLibraryAssets"
            :key="a.id"
            class="lib-card"
            :class="{ picked: libSelected.has(a.id) }"
          >
            <label class="lib-check">
              <input
                type="checkbox"
                :checked="libSelected.has(a.id)"
                @change="toggleLibSelect(a.id)"
              />
            </label>
            <button type="button" class="lib-thumb" :aria-label="`查看：${a.filename}`" @click="openLibraryItem(a)">
              <img v-if="a.kind === 'image' && libUrls[a.id]" :src="libUrls[a.id]" alt="" />
              <video v-else-if="a.kind === 'video' && libUrls[a.id]" :src="libUrls[a.id]" muted />
              <span v-else><HomeIcon :name="a.kind === 'audio' ? 'mic' : a.kind === 'video' ? 'video' : 'image'" :size="30" /></span>
            </button>
            <div class="lib-meta">
              <span>{{ a.filename }}</span>
              <button type="button" title="删除" @click="removeLibraryItem(a.id)"><HomeIcon name="trash" :size="14" /></button>
            </div>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.home {
  height: 100%;
  display: flex;
  min-height: 0;
  background: var(--nb-bg-0);
  color: var(--nb-t1);
}
.sidenav {
  width: 64px;
  flex: 0 0 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 0 14px;
  background: var(--nb-bg-1);
  border-right: 1px solid var(--nb-line-2);
  overflow: visible;
  z-index: 6;
}
.brand {
  position: relative;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
}
.brand-mark {
  width: 28px;
  height: 28px;
  object-fit: contain;
}
.side-links {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
}
.side-links button,
.side-links .tutorial-link,
.side-foot a,
.brand {
  position: relative;
}
.side-links button,
.side-links .tutorial-link {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--nb-t3);
  cursor: pointer;
  text-decoration: none;
}
.nav-label {
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  z-index: 8;
  transform: translateY(-50%);
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--nb-line-3);
  background: var(--nb-bg-3);
  color: var(--nb-t1);
  font-size: 12px;
  font-weight: 550;
  line-height: 1.2;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.brand:hover .nav-label,
.side-links button:hover .nav-label,
.side-links .tutorial-link:hover .nav-label,
.side-foot a:hover .nav-label {
  opacity: 1;
}
.side-links button.on {
  color: var(--nb-accent);
  background: var(--nb-accent-soft);
}
.side-links button:hover:not(.on),
.side-links .tutorial-link:hover {
  background: var(--nb-bg-2);
  color: var(--nb-t1);
}
.side-foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
}
.side-foot :deep(.nb-theme),
.side-foot a {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--nb-line-2);
  border-radius: 8px;
  background: var(--nb-bg-2);
  color: var(--nb-t2);
  text-decoration: none;
}
.side-foot a:hover,
.side-foot :deep(.nb-theme:hover) {
  background: var(--nb-bg-3);
  color: var(--nb-t1);
  border-color: var(--nb-line-accent);
}
.stage {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 28px 36px 48px;
  background:
    radial-gradient(900px 480px at 18% -8%, var(--nb-accent-wash), transparent 62%),
    radial-gradient(700px 420px at 88% 4%, var(--nb-ai-soft), transparent 60%),
    linear-gradient(var(--nb-grid-line-2) 1px, transparent 1px),
    linear-gradient(90deg, var(--nb-grid-line-2) 1px, transparent 1px),
    var(--nb-bg-0);
  background-size: auto, auto, 32px 32px, 32px 32px, auto;
  background-repeat: no-repeat, no-repeat, repeat, repeat, no-repeat;
}
.stage-bar {
  position: relative;
  z-index: 3;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-bottom: 8px;
}
.icon-round {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(20, 16, 40, 0.7);
  color: #d9d4ea;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.icon-round:hover { border-color: var(--nb-line-accent); color: var(--nb-accent); }
.home-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--nb-t3);
}
.home-kicker::before {
  content: "";
  width: 14px;
  height: 1px;
  background: var(--nb-line-accent);
}
.banner {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(336px, 552px);
  gap: 36px;
  align-items: center;
  min-height: 384px;
  margin: 0 0 28px;
  padding: 12px 0 8px;
}
.banner-stars {
  position: absolute;
  z-index: 0;
  inset: 0 0 -8px;
  overflow: hidden;
  pointer-events: none;
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 50%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 50%, transparent 100%);
}
.banner-stars::before,
.banner-stars::after {
  content: "";
  position: absolute;
  top: -8%;
  left: 0;
  width: calc(100% + 720px);
  height: 116%;
  background-repeat: repeat;
  background-size: 720px 240px;
  background-image:
    radial-gradient(1.2px 1.2px at 40px 48px, rgba(255, 255, 255, 0.9) 50%, transparent 51%),
    radial-gradient(1px 1px at 140px 160px, rgba(214, 204, 255, 0.75) 50%, transparent 51%),
    radial-gradient(1.4px 1.4px at 230px 72px, rgba(255, 255, 255, 0.8) 50%, transparent 51%),
    radial-gradient(1px 1px at 330px 190px, rgba(255, 214, 170, 0.65) 50%, transparent 51%),
    radial-gradient(1.1px 1.1px at 430px 36px, rgba(255, 255, 255, 0.85) 50%, transparent 51%),
    radial-gradient(1px 1px at 520px 120px, rgba(198, 186, 255, 0.7) 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 610px 64px, rgba(255, 255, 255, 0.9) 50%, transparent 51%),
    radial-gradient(1px 1px at 680px 176px, rgba(255, 226, 190, 0.6) 50%, transparent 51%);
  animation: star-drift 38s linear infinite, star-twinkle 5.5s ease-in-out infinite;
}
.banner-stars::after {
  width: calc(100% + 860px);
  background-size: 860px 280px;
  background-image:
    radial-gradient(1px 1px at 90px 90px, rgba(255, 255, 255, 0.55) 50%, transparent 51%),
    radial-gradient(1.3px 1.3px at 240px 40px, rgba(210, 198, 255, 0.65) 50%, transparent 51%),
    radial-gradient(1px 1px at 400px 170px, rgba(255, 255, 255, 0.5) 50%, transparent 51%),
    radial-gradient(1.2px 1.2px at 560px 100px, rgba(255, 220, 180, 0.55) 50%, transparent 51%),
    radial-gradient(1px 1px at 700px 210px, rgba(255, 255, 255, 0.6) 50%, transparent 51%),
    radial-gradient(1.4px 1.4px at 790px 30px, rgba(214, 204, 255, 0.65) 50%, transparent 51%);
  animation-name: star-drift-slow, star-twinkle;
  animation-duration: 58s, 7.5s;
  animation-direction: reverse, alternate;
}
@keyframes star-drift-slow {
  from { transform: translateX(0); }
  to { transform: translateX(-860px); }
}
@keyframes star-drift {
  from { transform: translateX(0); }
  to { transform: translateX(-720px); }
}
@keyframes star-twinkle {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.9; }
}
.banner-flow {
  position: absolute;
  z-index: 0;
  inset: 8% 4% 6% 30%;
  overflow: hidden;
  pointer-events: none;
  mask-image: linear-gradient(90deg, transparent, #000 8%, #000 86%, transparent);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 8%, #000 86%, transparent);
}
.banner-flow svg { width: 100%; height: 100%; display: block; }
.banner-flow .wave {
  fill: none;
  stroke: url(#banner-wave);
  stroke-width: 1.2;
  stroke-linecap: round;
}
.banner-flow .wave.hint { opacity: 0.28; }
.banner-flow .wave.streak {
  stroke-width: 1.6;
  opacity: 0.72;
  stroke-dasharray: 56 1100;
  filter: blur(0.4px);
  animation: banner-wave 1.7s linear infinite;
}
.banner-flow .wave.streak.late { animation-duration: 2.3s; animation-delay: -0.8s; }
@keyframes banner-wave {
  to { stroke-dashoffset: -1156; }
}
@media (prefers-reduced-motion: reduce) {
  .banner-stars::before,
  .banner-stars::after,
  .banner-flow .wave { animation: none; }
  .banner-flow .wave.streak { stroke-dasharray: none; opacity: 0.2; }
}
.banner-copy { position: relative; z-index: 2; min-width: 0; }
.banner h1 {
  margin: 12px 0 10px;
  font-size: 42px;
  line-height: 1.12;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.banner h1 em { font-style: normal; color: var(--nb-t4); }
.banner p {
  margin: 0;
  max-width: 460px;
  color: var(--nb-t3);
  font-size: 14px;
  line-height: 1.7;
}
.banner-actions { display: flex; gap: 12px; margin-top: 22px; }
.banner-actions button {
  height: 40px;
  padding: 0 18px;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
}
.banner-actions .go {
  border: 0;
  color: var(--nb-accent-ink);
  background: var(--nb-accent);
}
.banner-actions .go:hover:not(:disabled) { background: #67e4fb; }
.banner-actions .go:disabled { opacity: 0.6; cursor: default; }
.banner-actions .open {
  color: var(--nb-t1);
  background: transparent;
  border: 1px solid var(--nb-line-3);
}
.banner-actions .open:hover { border-color: var(--nb-line-accent); color: var(--nb-accent); }
.hero-meta {
  display: flex;
  gap: 28px;
  margin-top: 28px;
  padding-top: 18px;
  border-top: 1px solid var(--nb-line-1);
}
.hero-meta strong {
  display: block;
  font-size: 20px;
  font-weight: 650;
  color: var(--nb-t1);
}
.hero-meta span { font-size: 12px; color: var(--nb-t4); }
.banner-art {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 384px;
  object-fit: contain;
  object-position: center;
  pointer-events: none;
  filter: drop-shadow(0 18px 28px rgba(0, 0, 0, 0.28));
}
.quick, .tools, .projects { margin-top: 8px; }
.quick h2, .tools h2, .proj-head h2, .lib-top h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 14px;
  font-size: 16px;
  font-weight: 650;
}
.quick h2 i {
  width: 8px;
  height: 14px;
  border-radius: 2px;
  background: linear-gradient(180deg, #8d74ff, #5b46e6);
}
.quick-row {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
.quick-row button, .tools .quick-row button {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 74px;
  padding: 14px;
  text-align: left;
  color: inherit;
  cursor: pointer;
  border-radius: 12px;
  border: 1px solid var(--nb-line-2);
  background: var(--nb-bg-2);
}
.quick-row button:hover { border-color: var(--nb-line-accent); transform: translateY(-2px); }
.quick-row strong, .tools strong { display: block; font-size: 13px; color: var(--nb-t1); }
.quick-row em, .tools em {
  display: block;
  margin-top: 3px;
  font-style: normal;
  font-size: 11px;
  color: var(--nb-t3);
}
.quick-row b { margin-left: auto; color: #7d7696; font-weight: 500; }
.q-icon {
  width: 36px;
  height: 36px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.q-icon.violet { background: rgba(255, 180, 84, 0.13); color: var(--nb-t-video, #ffb454); }
.q-icon.blue { background: rgba(255, 143, 168, 0.13); color: var(--nb-t-audio, #ff8fa8); }
.q-icon.green { background: rgba(52, 216, 168, 0.13); color: var(--nb-t-image, #34d8a8); }
.q-icon.indigo { background: rgba(125, 140, 255, 0.13); color: var(--nb-t-script, #7d8cff); }
.q-icon.amber { background: rgba(183, 139, 255, 0.13); color: var(--nb-t-compose, #b78bff); }
.projects { margin-top: 26px; }
.proj-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}
.proj-head h2 { margin: 0; white-space: nowrap; }
.filters { display: flex; gap: 8px; }
.filters button, .view-toggle button {
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--nb-t3);
  cursor: pointer;
  font-size: 13px;
}
.filters button.on {
  color: var(--nb-accent);
  background: var(--nb-accent-soft);
  border-color: var(--nb-line-accent);
}
.view-toggle {
  display: flex;
  padding: 3px;
  border-radius: 10px;
  background: var(--nb-fill-1);
  border: 1px solid var(--nb-line-1);
}
.view-toggle button {
  width: 30px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--nb-t3);
}
.view-toggle button.on { background: var(--nb-bg-3); color: var(--nb-t1); }
.filter {
  margin-left: auto;
  position: relative;
  display: flex;
  align-items: center;
  height: 36px;
}
.filter .search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  z-index: 1;
  transform: translateY(-50%);
  color: var(--nb-t4);
  pointer-events: none;
}
.filter .search {
  box-sizing: border-box;
  width: 220px;
  height: 36px;
  padding: 0 14px 0 34px;
  line-height: 36px;
  border-radius: 8px;
  border: 1px solid var(--nb-line-2);
  background: var(--nb-bg-inset);
  color: var(--nb-t1);
  outline: none;
}
.create-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 228px;
  border-radius: 12px;
  border: 1px dashed var(--nb-line-3);
  background: var(--nb-fill-1);
  color: var(--nb-t2);
  cursor: pointer;
}
.create-card:hover { border-color: var(--nb-line-accent); color: var(--nb-accent); background: var(--nb-accent-soft); }
.create-card em { font-style: normal; color: var(--nb-t4); font-size: 12px; }
.create-mark {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  border: 1px solid var(--nb-line-3);
  background: transparent;
  color: inherit;
}
.create-go {
  margin-top: 6px;
  color: var(--nb-accent);
  font-size: 13px;
}
.filter-empty { grid-column: 1 / -1; color: var(--nb-t4); font-size: 13px; }
.shot-pill, .phase {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(6, 8, 11, 0.72);
  color: #eef4fa;
}
.phase.active { background: var(--nb-accent-soft); color: var(--nb-accent); }
.phase.done { background: var(--nb-success-soft, rgba(61, 217, 160, 0.14)); color: var(--nb-success, #3dd9a0); }
.proj-open { display: none; }
.grid.list { grid-template-columns: 1fr; }
.grid.list .create-card { min-height: 84px; flex-direction: row; }
.lib-top {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 8px 0 18px;
}
.lib-top h2 { margin: 8px 0 6px; font-size: 28px; letter-spacing: -0.03em; }
.lib-top p { margin: 0; max-width: 620px; color: var(--nb-t3); font-size: 13px; line-height: 1.6; }
@media (max-width: 1100px) {
  .quick-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .banner { grid-template-columns: 1fr; min-height: 0; }
  .banner-flow { display: none; }
  .banner-art { height: 264px; }
  .banner p { white-space: normal; }
  .banner-art { height: 70%; right: 8px; bottom: 0; }
}
@media (max-width: 860px) {
  .home { flex-direction: column; }
  .sidenav { width: auto; flex: none; flex-direction: row; border-right: 0; border-bottom: 1px solid var(--nb-line-2); padding: 8px 12px; }
  .side-links { flex-direction: row; }
  .side-foot { flex-direction: row; width: auto; margin-top: 0; margin-left: auto; }
  .brand { margin: 0 8px 0 0; }
  .nav-label { left: 50%; top: calc(100% + 8px); transform: translateX(-50%); }
  .proj-head { flex-wrap: wrap; }
  .filter { margin-left: 0; }
}

/* ───────── Hero ───────── */
.hero {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.hero-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(ellipse 80% 70% at 60% 30%, #000 0%, transparent 78%);
  -webkit-mask-image: radial-gradient(ellipse 80% 70% at 60% 30%, #000 0%, transparent 78%);
}
.hero-glow {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(560px 280px at 22% 18%, rgba(126, 180, 255, 0.16), transparent 62%),
    radial-gradient(520px 300px at 78% 26%, rgba(167, 139, 250, 0.13), transparent 66%),
    linear-gradient(180deg, #12141a 0%, #0d0e12 100%);
  z-index: 0;
}
.hero-content {
  position: relative;
  z-index: 1;
  width: min(1180px, calc(100% - 40px));
  padding: 60px 0 46px;
}
.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 20px;
  padding: 5px 12px 5px 10px;
  border: 1px solid rgba(126, 180, 255, 0.28);
  border-radius: 99px;
  background: rgba(126, 180, 255, 0.07);
  color: #a9c8ff;
  font-size: 11px;
  letter-spacing: 0.06em;
}
.hero-badge .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7eb4ff;
  box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.18);
  animation: badge-pulse 2.4s ease-in-out infinite;
}
@keyframes badge-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
.title {
  max-width: 780px;
  font-size: clamp(38px, 4.4vw, 58px);
  font-weight: 700;
  line-height: 1.1;
  margin: 0 0 18px;
  letter-spacing: -0.035em;
}
.subtitle {
  max-width: 640px;
  font-size: 14px;
  color: var(--color-text-3);
  margin: 0 0 28px;
  line-height: 1.75;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 34px;
}
.hero-actions :deep(.grad-btn) {
  min-height: 38px;
  padding: 9px 15px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 500;
  box-shadow: none;
}
.hero-actions :deep(.type-primary) {
  background: linear-gradient(135deg, #7eb4ff, #8f9dff);
  border-color: transparent;
  color: #0b0d13;
  font-weight: 600;
}
.hero-actions :deep(.type-primary:hover:not(:disabled)) {
  filter: brightness(1.08);
}
.hero-actions :deep(.type-secondary) {
  background: rgba(255, 255, 255, 0.045);
  border-color: rgba(255, 255, 255, 0.1);
}
.hero-actions :deep(.type-secondary:hover:not(:disabled)),
.hero-actions :deep(.type-ghost:hover:not(:disabled)) {
  background: rgba(255, 255, 255, 0.085);
  border-color: rgba(255, 255, 255, 0.2);
}

/* ───────── 指标 ───────── */
.stats {
  display: flex;
  width: fit-content;
  gap: 0;
  padding: 10px 4px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.025);
}
.stat {
  min-width: 118px;
  padding: 2px 20px;
  border-right: 1px solid rgba(255, 255, 255, 0.07);
}
.stat:last-child {
  border-right: 0;
}
.stat-value {
  font-size: 21px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--color-text-1);
  margin-bottom: 3px;
  font-variant-numeric: tabular-nums;
}
.stat-value.accent {
  background: linear-gradient(120deg, #7eb4ff, #c4b5fd);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.stat-label {
  font-size: 11px;
  color: var(--color-text-4);
  letter-spacing: 0.08em;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 30px 20px 52px;
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}
.section-header h2 {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
}
.home-tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}
.home-tabs button {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 13px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-4);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.home-tabs button em {
  font-style: normal;
  font-size: 11px;
  font-weight: 600;
  min-width: 18px;
  padding: 1px 6px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text-4);
}
.home-tabs button.on {
  background: rgba(255, 255, 255, 0.075);
  border-color: transparent;
  color: var(--color-text-1);
}
.home-tabs button.on em {
  background: rgba(126, 180, 255, 0.18);
  color: #a9c8ff;
}
.filter {
  position: relative;
}
.search-icon {
  position: absolute;
  left: 11px;
  top: 50%;
  z-index: 1;
  color: var(--color-text-4);
  transform: translateY(-50%);
  pointer-events: none;
}
.search {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  padding: 9px 14px 9px 36px;
  font-size: 13px;
  color: var(--color-text-1);
  outline: none;
  width: 240px;
  transition: all 0.18s;
}
.search:focus {
  border-color: rgba(126, 180, 255, 0.6);
  background: rgba(126, 180, 255, 0.06);
  box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.1);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));
  gap: 16px;
}
.proj {
  cursor: pointer;
  overflow: hidden;
  border-radius: var(--radius-lg) !important;
  box-shadow: none !important;
  border: 1px solid var(--nb-line-2) !important;
  background: var(--nb-bg-2) !important;
  color: var(--nb-t1);
  transition:
    border-color 0.18s,
    transform 0.18s,
    box-shadow 0.18s,
    background 0.18s !important;
}
.proj:hover {
  transform: translateY(-3px) !important;
  border-color: var(--nb-line-3) !important;
  background: var(--nb-bg-2) !important;
  box-shadow: var(--nb-e3) !important;
}
.proj-thumb {
  position: relative;
  aspect-ratio: 16/9;
  background: var(--nb-bg-inset);
  overflow: hidden;
}
.proj-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.4s ease;
}
.proj:hover .proj-cover {
  transform: scale(1.04);
}
.proj-thumb-grad {
  position: absolute;
  inset: 0;
  background: var(--nb-bg-inset);
}
.proj-thumb-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.proj-thumb-icon {
  color: var(--nb-t4);
  opacity: 0.85;
}
.proj-open {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 3;
  align-items: flex-end;
  justify-content: flex-start;
  gap: 8px;
  padding: 12px 14px;
  opacity: 0;
  background: linear-gradient(to top, rgba(6, 8, 11, 0.72), transparent 58%);
  transition: opacity 0.2s;
}
.proj:hover .proj-open {
  opacity: 1;
}
.open-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 99px;
  background: rgba(6, 8, 11, 0.55);
  backdrop-filter: blur(4px);
  color: #e9f0f9;
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: all 0.15s;
}
.open-btn:hover {
  border-color: var(--nb-line-accent);
  background: var(--nb-accent-soft);
  color: #e9f0f9;
}
.open-btn.primary {
  border-color: var(--nb-line-accent);
  background: var(--nb-accent-soft);
  color: #e9f0f9;
}
.open-btn.primary:hover {
  background: rgba(53, 214, 247, 0.22);
}
.proj-open em {
  font-style: normal;
}
.proj-meta-top {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  z-index: 2;
}
.proj-info {
  padding: 14px 16px 12px;
}
.proj-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--nb-t1);
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proj-topic {
  font-size: 12px;
  color: var(--nb-t3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 10px;
}
.proj-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.proj-date {
  font-size: 11px;
  color: var(--nb-t4);
  font-variant-numeric: tabular-nums;
}
.proj-actions {
  display: flex;
  gap: 2px;
}
.proj-del,
.proj-folder {
  display: inline-flex;
  padding: 5px;
  border: none;
  background: transparent;
  border-radius: 6px;
  opacity: 0.5;
  color: var(--nb-t3);
  cursor: pointer;
  transition: all 0.15s;
}
.proj-del:hover {
  opacity: 1;
  background: var(--nb-danger-soft);
  color: var(--nb-danger);
}
.proj-folder:hover:not(:disabled) {
  opacity: 1;
  background: var(--nb-accent-soft);
  color: var(--nb-accent);
}
.proj-folder:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(6, 7, 10, 0.72);
  backdrop-filter: blur(6px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal {
  width: 90%;
  max-width: 620px;
  max-height: 88vh;
  overflow-y: auto;
  background: #14161c !important;
}
.modal.remake {
  max-width: 620px;
}
.modal h3 {
  margin: 0 0 6px;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.modal-desc {
  margin: 0 0 22px;
  font-size: 12px;
  color: var(--color-text-4);
  line-height: 1.6;
}
.field {
  display: block;
  margin-bottom: 18px;
}
.field > span {
  display: block;
  font-size: 11px;
  color: var(--color-text-4);
  margin-bottom: 7px;
  font-weight: 500;
  letter-spacing: 0.04em;
}
.input {
  width: 100%;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 13px;
  color: var(--color-text-1);
  outline: none;
  transition: all 0.18s;
}
.input:focus {
  border-color: rgba(126, 180, 255, 0.6);
  background: rgba(126, 180, 255, 0.05);
  box-shadow: 0 0 0 3px rgba(126, 180, 255, 0.1);
}
.style-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.style-pick {
  padding: 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  color: var(--color-text-3);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.16s;
}
.style-pick:hover {
  border-color: rgba(255, 255, 255, 0.16);
  color: var(--color-text-2);
}
.style-pick.active {
  background: rgba(126, 180, 255, 0.12);
  border-color: rgba(126, 180, 255, 0.6);
  color: #cfe0ff;
}

.aspect-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
}
.aspect-pick {
  text-align: left;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  padding: 10px 8px;
  cursor: pointer;
  transition: all 0.16s;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
}
.aspect-pick:hover {
  border-color: rgba(255, 255, 255, 0.16);
}
.aspect-pick.active {
  background: rgba(126, 180, 255, 0.1);
  border-color: rgba(126, 180, 255, 0.6);
}
.aspect-pick.active .aspect-label {
  color: var(--color-text-1);
}
.aspect-visual {
  width: 100%;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 6px;
}
.aspect-box {
  background: var(--color-text-4);
  border-radius: 2px;
}
.aspect-visual[data-ar='16:9'] .aspect-box { width: 36px; height: 20px; }
.aspect-visual[data-ar='9:16'] .aspect-box { width: 14px; height: 24px; }
.aspect-visual[data-ar='1:1'] .aspect-box { width: 22px; height: 22px; }
.aspect-visual[data-ar='4:3'] .aspect-box { width: 30px; height: 22px; }
.aspect-visual[data-ar='21:9'] .aspect-box { width: 42px; height: 18px; }
.aspect-pick.active .aspect-box {
  background: linear-gradient(120deg, #7eb4ff, #c4b5fd);
}
.aspect-info {
  text-align: center;
  width: 100%;
}
.aspect-label {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
  color: var(--color-text-2);
}
.aspect-desc {
  font-size: 10px;
  color: var(--color-text-4);
  line-height: 1.3;
}
.aspect-size {
  font-size: 10px;
  color: var(--color-text-4);
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 24px;
}
.mode-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
.mode-note {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-4);
}
.mode-pick {
  text-align: left;
  padding: 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  color: var(--color-text-3);
  cursor: pointer;
  transition: all 0.18s;
}
.mode-pick > .home-icon {
  margin-bottom: 12px;
  color: var(--color-text-4);
}
.mode-pick:hover {
  border-color: rgba(255, 255, 255, 0.16);
}
.mode-pick.active {
  background: rgba(126, 180, 255, 0.1);
  border-color: rgba(126, 180, 255, 0.6);
  color: #e7eeff;
}
.mode-pick.active > .home-icon {
  color: #9ec1ff;
}
.mode-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--color-text-1);
}
.mode-desc {
  font-size: 11px;
  color: var(--color-text-4);
  line-height: 1.45;
}
.file-hidden {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
.field {
  position: relative;
}
.field-hint,
.upload-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.5;
}
.video-preview video {
  width: 100%;
  max-height: 180px;
  border-radius: 10px;
  background: #000;
  object-fit: contain;
}
.video-add,
.replace-video {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 6px;
  padding: 18px 12px;
  font-size: 13px;
  color: var(--color-text-4);
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  cursor: pointer;
  gap: 8px;
  transition: all 0.16s;
}
.replace-video {
  padding: 8px;
  font-size: 12px;
}
.video-add:hover,
.replace-video:hover {
  border-color: rgba(126, 180, 255, 0.6);
  color: var(--color-text-1);
  background: rgba(126, 180, 255, 0.06);
}
.file-name {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text-3);
  word-break: break-all;
}
.product-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.product-thumb {
  position: relative;
  width: 72px;
  height: 72px;
  border-radius: 8px;
  overflow: hidden;
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
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 12px;
  line-height: 18px;
}
.video-add,
.replace-video,
.product-add,
.lib-upload {
  font-family: inherit;
}
.product-add {
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  font-size: 11px;
  line-height: 1.3;
  color: var(--color-text-4);
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  cursor: pointer;
  flex-direction: column;
  gap: 6px;
  transition: all 0.16s;
}
.product-add:hover {
  border-color: rgba(126, 180, 255, 0.6);
  color: var(--color-text-1);
  background: rgba(126, 180, 255, 0.06);
}
.creating-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 28px 8px 12px;
}
.creating-spin {
  width: 28px;
  height: 28px;
  border: 2px solid rgba(126, 180, 255, 0.25);
  border-top-color: #7eb4ff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.creating-text {
  font-size: 13px;
  color: var(--color-text-2);
  text-align: center;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.lib-upload {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  border: 0;
  background: var(--nb-accent);
  color: var(--nb-accent-ink);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.lib-upload:hover:not(:disabled) { background: #67e4fb; }
.lib-upload:disabled { opacity: 0.6; cursor: default; }
.lib-page {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.lib-tabs {
  display: flex;
  align-items: center;
  gap: 24px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--nb-line-2);
}
.lib-tab {
  position: relative;
  margin: 0;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--nb-t3);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.lib-tab:hover { color: var(--nb-t2); }
.lib-tab.on { color: var(--nb-t1); }
.lib-tab.on::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--nb-accent);
  box-shadow: 0 0 10px var(--nb-accent-glow);
}
.lib-tab .cnt {
  margin-left: 5px;
  color: var(--nb-t4);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.lib-batch {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--nb-line-accent);
  background: var(--nb-accent-soft);
}
.lib-batch .n {
  font-size: 12px;
  font-weight: 650;
  color: var(--nb-accent);
}
.lib-batch .d {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--nb-t2);
}
.lib-batch-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-wrap: wrap;
}
.lib-batch select {
  height: 28px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--nb-line-2);
  background: var(--nb-bg-3);
  color: var(--nb-t1);
  font-size: 12px;
}
.lib-batch button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  margin: 0;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--nb-line-3);
  background: transparent;
  color: var(--nb-t1);
  font-size: 12px;
  cursor: pointer;
}
.lib-batch button.danger {
  border-color: var(--nb-danger-line);
  color: var(--nb-danger);
}
.lib-batch button.ghost {
  border-color: transparent;
  color: var(--nb-t3);
}
.lib-batch button:hover { background: rgba(255, 255, 255, 0.04); }
.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(212px, 1fr));
  gap: 16px;
  padding-bottom: 32px;
}
.lib-card {
  position: relative;
  background: var(--nb-bg-2);
  border: 1px solid var(--nb-line-2);
  border-radius: 12px;
  overflow: hidden;
  transition: border-color 0.16s, transform 0.16s;
}
.lib-card:hover {
  transform: translateY(-2px);
  border-color: var(--nb-line-accent);
}
.lib-card.picked {
  border-color: var(--nb-accent);
  box-shadow: 0 0 0 1px var(--nb-accent), 0 0 24px var(--nb-accent-glow);
}
.lib-check {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 1;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(10, 11, 15, 0.6);
}
.lib-check input {
  margin: 0;
  cursor: pointer;
}
.lib-thumb {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 16 / 10;
  height: auto;
  margin: 0;
  padding: 0;
  border: none;
  background: var(--nb-bg-inset);
  cursor: zoom-in;
}
.lib-thumb img,
.lib-thumb video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.lib-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--color-text-3);
}
.lib-meta span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lib-meta button {
  margin: 0;
  padding: 2px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text-4);
  display: inline-flex;
}
.lib-meta button:hover {
  color: var(--color-error);
}
.proj-meta-top :deep(.tag) { display: none; }
.grid.list .proj { display: flex !important; align-items: stretch; }
.grid.list .proj-thumb { width: 240px; flex: none; }
.search { border-radius: 999px; }
.modal-actions :deep(.grad-btn) { border-radius: 10px; box-shadow: none; }
@media (max-width: 720px) {
  .hero-content {
    width: min(calc(100% - 28px), 1180px);
    padding-top: 36px;
  }
  .title { font-size: 34px; }
  .stats { width: 100%; }
  .stat { min-width: 0; flex: 1; padding-inline: 10px; }
  .section-header { align-items: stretch; gap: 12px; flex-direction: column; }
  .search { width: 100%; }
  .mode-grid,
  .aspect-grid { grid-template-columns: 1fr 1fr; }
  .lib-batch-actions { margin-left: 0; }
}
</style>
