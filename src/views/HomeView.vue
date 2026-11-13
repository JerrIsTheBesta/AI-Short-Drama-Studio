<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore, useLibraryStore, LIBRARY_PUBLIC_ID } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import HomeIcon from '@/components/common/HomeIcon.vue'
import { isDesktop, desktop } from '@/services/desktop'
import { pickCoverAssetId, projectCoverUrl } from '@/services/storage'
import { pickLocalFiles } from '@/utils/pickLocalFiles'
import { openLightbox } from '@/composables/useLightbox'

const router = useRouter()
const project = useProjectStore()
const toast = useToastStore()

const search = ref('')
const searchEl = ref<HTMLInputElement | null>(null)
const creating = ref(false)
type HomeNav = 'home' | 'projects' | 'library' | 'tools'
type ProjectFilter = 'all' | 'active' | 'done'
const nav = ref<HomeNav>('home')
const projectFilter = ref<ProjectFilter>('all')
const viewMode = ref<'grid' | 'list'>('grid')

const covers = ref<Record<string, string>>({})
const library = useLibraryStore()
const libUrls = ref<Record<string, string>>({})
const libUploading = ref(false)
const libFolderId = ref(LIBRARY_PUBLIC_ID)
const libSelected = ref<Set<string>>(new Set())
const libMoveTarget = ref(LIBRARY_PUBLIC_ID)
const folderDraft = ref('')
const renamingId = ref('')
const renameDraft = ref('')
const creatingFolder = ref(false)

onMounted(async () => {
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
  if (nav.value === 'library' || nav.value === 'tools') nav.value = 'projects'
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

const visibleLibraryAssets = computed(() => library.inFolder(libFolderId.value))

const currentFolderLabel = computed(() =>
  libFolderId.value === LIBRARY_PUBLIC_ID ? '公共资产' : library.folderName(libFolderId.value)
)

function selectLibFolder(id: string) {
  libFolderId.value = id
  libSelected.value = new Set()
  libMoveTarget.value =
    id === LIBRARY_PUBLIC_ID
      ? library.folders[0]?.id ?? LIBRARY_PUBLIC_ID
      : LIBRARY_PUBLIC_ID
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
      await library.add(file, 'uploaded', {
        filename: file.name,
        folderId: libFolderId.value
      })
    }
    await loadLibraryThumbs()
    toast.success(`已上传 ${files.length} 张到${currentFolderLabel.value}`)
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

async function createLibFolder() {
  creatingFolder.value = true
  try {
    const folder = await library.createFolder(folderDraft.value)
    folderDraft.value = ''
    libFolderId.value = folder.id
    toast.success(`已创建「${folder.name}」`)
  } catch (err: any) {
    toast.error(err?.message || '创建失败')
  } finally {
    creatingFolder.value = false
  }
}

function startRenameFolder(id: string, name: string) {
  renamingId.value = id
  renameDraft.value = name
}

async function commitRenameFolder() {
  const id = renamingId.value
  if (!id) return
  try {
    await library.renameFolder(id, renameDraft.value)
    renamingId.value = ''
    toast.success('已重命名')
  } catch (err: any) {
    toast.error(err?.message || '重命名失败')
  }
}

async function removeLibFolder(id: string, name: string) {
  const n = library.folderCount(id)
  const msg =
    n > 0
      ? `删除「${name}」后，里面的 ${n} 张图会回到公共资产。确定删除？`
      : `删除文件夹「${name}」？`
  if (!confirm(msg)) return
  try {
    await library.deleteFolder(id)
    if (libFolderId.value === id) libFolderId.value = LIBRARY_PUBLIC_ID
    libSelected.value = new Set()
    toast.success('已删除文件夹')
  } catch (err: any) {
    toast.error(err?.message || '删除失败')
  }
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
      <button type="button" class="brand" @click="nav = 'home'">
        <img class="brand-mark" src="/logo.png" alt="" />
        <span>
          <strong>剧流 Studio</strong>
          <em>AI 短剧工作台</em>
        </span>
      </button>
      <nav class="side-links" aria-label="首页导航">
        <button type="button" :class="{ on: nav === 'home' }" @click="nav = 'home'">
          <HomeIcon name="home" :size="18" /> 首页
        </button>
        <button type="button" :class="{ on: nav === 'projects' }" @click="nav = 'projects'">
          <HomeIcon name="folder" :size="18" /> 我的项目
        </button>
        <button type="button" @click="router.push('/scripts')">
          <HomeIcon name="script" :size="18" /> 剧本管理
        </button>
        <button type="button" :class="{ on: nav === 'library' }" @click="nav = 'library'">
          <HomeIcon name="library" :size="18" /> 素材库
        </button>
        <button type="button" :class="{ on: nav === 'tools' }" @click="nav = 'tools'">
          <HomeIcon name="wand" :size="18" /> 工具集
        </button>
        <button type="button" @click="router.push('/settings')">
          <HomeIcon name="settings" :size="18" /> 设置
        </button>
      </nav>
      <div class="side-foot">
        <div class="side-kicker">开源，免费</div>
        <a href="https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio" target="_blank" rel="noreferrer">
          <HomeIcon name="github" :size="15" />
          去 GitHub →
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
          <div class="banner-stars" aria-hidden="true"></div>
          <div class="banner-copy">
            <h1>用 AI，轻松创作<br /><span>属于你的短剧世界</span></h1>
            <p>一站式 AI 短剧创作平台，支持图文、视频、数字人、智能剪辑与多种生成能力</p>
            <div class="banner-actions">
              <button type="button" class="go" :disabled="creating" @click="quickCreate">开始创作 →</button>
              <button type="button" class="open" @click="openLatestProject">打开项目</button>
            </div>
          </div>
          <img class="banner-art" src="/home-banner.png" alt="" />
        </section>

        <section class="quick">
          <h2><i /> 快速入口</h2>
          <div class="quick-row">
            <button type="button" @click="quickCreate">
              <span class="q-icon violet"><HomeIcon name="image" :size="18" /></span>
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

      <div v-if="nav === 'library'" class="lib-layout">
        <div class="lib-top">
          <h2>素材库</h2>
          <button type="button" class="lib-upload" :disabled="libUploading" @click="uploadLibraryImages">
            <HomeIcon name="upload" :size="16" />
            {{ libUploading ? '上传中…' : `上传到${currentFolderLabel}` }}
          </button>
        </div>
        <aside class="lib-side">
          <div class="lib-side-title">分类</div>
          <button
            type="button"
            class="lib-folder"
            :class="{ on: libFolderId === LIBRARY_PUBLIC_ID }"
            @click="selectLibFolder(LIBRARY_PUBLIC_ID)"
          >
            <HomeIcon name="library" :size="16" />
            <span>公共资产</span>
            <em>{{ library.folderCount(LIBRARY_PUBLIC_ID) }}</em>
          </button>
          <div v-for="f in library.folders" :key="f.id" class="lib-folder-row">
            <button
              v-if="renamingId !== f.id"
              type="button"
              class="lib-folder"
              :class="{ on: libFolderId === f.id }"
              @click="selectLibFolder(f.id)"
            >
              <span>{{ f.name }}</span>
              <em>{{ library.folderCount(f.id) }}</em>
            </button>
            <form v-else class="lib-rename" @submit.prevent="commitRenameFolder">
              <input v-model="renameDraft" maxlength="24" @keydown.esc="renamingId = ''" />
              <button type="submit">好</button>
            </form>
            <button
              type="button"
              class="lib-folder-act"
              title="重命名"
              @click="startRenameFolder(f.id, f.name)"
            >
              <HomeIcon name="edit" :size="14" />
            </button>
            <button
              type="button"
              class="lib-folder-act danger"
              title="删除文件夹"
              @click="removeLibFolder(f.id, f.name)"
            >
              <HomeIcon name="trash" :size="14" />
            </button>
          </div>
          <form class="lib-new-folder" @submit.prevent="createLibFolder">
            <input
              v-model="folderDraft"
              maxlength="24"
              placeholder="新文件夹名称"
              :disabled="creatingFolder"
            />
            <button type="submit" :disabled="creatingFolder || !folderDraft.trim()">创建</button>
          </form>
        </aside>

        <div class="lib-main">
          <p class="lib-hint">
            公共资产可转移到自己的文件夹分类。选图时也能从公共资产或这些文件夹里挑。
          </p>
          <div v-if="libSelected.size" class="lib-move-bar">
            <span>已选 {{ libSelected.size }} 张</span>
            <select v-model="libMoveTarget">
              <option :value="LIBRARY_PUBLIC_ID">公共资产</option>
              <option v-for="f in library.folders" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <button type="button" @click="moveSelectedLibrary">转移</button>
            <button type="button" class="ghost" @click="clearLibSelected">取消</button>
          </div>
          <EmptyState
            v-if="visibleLibraryAssets.length === 0"
            :title="
              library.all.length === 0 && libFolderId === LIBRARY_PUBLIC_ID
                ? '资产库还是空的'
                : `${currentFolderLabel}还是空的`
            "
            :description="
              library.all.length === 0 && libFolderId === LIBRARY_PUBLIC_ID
                ? '上传图片，或在项目画布里把生成图加入公共库'
                : '上传到这里，或从公共资产勾选后点「转移」'
            "
          >
            <template #icon>
              <HomeIcon :name="library.all.length === 0 ? 'image' : 'folder'" :size="44" />
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
              <button type="button" class="lib-thumb" @click="libUrls[a.id] && openLightbox(libUrls[a.id], 'image')">
                <img v-if="libUrls[a.id]" :src="libUrls[a.id]" alt="" />
                <span v-else><HomeIcon name="image" :size="30" /></span>
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

  </div>
</template>

<style scoped>
.home {
  height: 100%;
  display: flex;
  min-height: 0;
  background:
    radial-gradient(900px 480px at 78% 8%, rgba(98, 54, 196, 0.28), transparent 60%),
    #0c0b14;
  color: #f4f1ff;
}
.sidenav {
  width: 228px;
  flex: 0 0 228px;
  display: flex;
  flex-direction: column;
  padding: 22px 16px 18px;
  background: linear-gradient(180deg, #141226 0%, #100e1c 100%);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 22px;
  background: none;
  border: 0;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.brand-mark {
  width: 36px;
  height: 36px;
  object-fit: contain;
}
.brand strong {
  display: block;
  font-size: 15px;
  letter-spacing: -0.02em;
}
.brand em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 11px;
  color: #8d88a8;
}
.side-links {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.side-links button {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  padding: 0 14px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: #c8c3dc;
  font-size: 14px;
  cursor: pointer;
  text-align: left;
}
.side-links button.on {
  color: white;
  background: linear-gradient(90deg, #6d4dff 0%, #7a5cff 100%);
  box-shadow: 0 8px 20px rgba(109, 77, 255, 0.35);
}
.side-links button:hover:not(.on) {
  background: rgba(255, 255, 255, 0.04);
}
.side-foot {
  margin-top: auto;
  padding: 14px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}
.side-kicker {
  font-size: 13px;
  font-weight: 650;
}
.side-foot a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: #b9a6ff;
  font-size: 13px;
  text-decoration: none;
}
.stage {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 18px 28px 40px;
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
.icon-round:hover { border-color: rgba(167, 139, 250, 0.6); }
.banner {
  position: relative;
  min-height: 280px;
  margin: -18px -28px 4px;
  padding: 36px 56px 20px;
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
}
.banner::before {
  content: "";
  position: absolute;
  z-index: 0;
  inset: 0 0 -8px;
  pointer-events: none;
  background:
    radial-gradient(480px 260px at 84% 42%, rgba(255, 166, 77, 0.34), transparent 68%),
    radial-gradient(680px 360px at 72% 18%, rgba(132, 96, 255, 0.46), transparent 70%),
    radial-gradient(520px 280px at 8% 80%, rgba(64, 28, 140, 0.28), transparent 72%),
    linear-gradient(102deg, rgba(18, 12, 36, 0.2) 0%, rgba(36, 18, 78, 0.72) 36%, rgba(62, 26, 120, 0.94) 68%, rgba(78, 34, 132, 0.96) 100%);
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 46%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 0%, #000 46%, transparent 100%);
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
@media (prefers-reduced-motion: reduce) {
  .banner-stars::before,
  .banner-stars::after { animation: none; opacity: 0.45; }
}
.banner-copy { position: relative; z-index: 2; max-width: min(540px, 54%); }
.banner h1 {
  margin: 0;
  font-size: 40px;
  line-height: 1.25;
  font-weight: 750;
  letter-spacing: -0.03em;
}
.banner h1 span {
  background: linear-gradient(90deg, #d7cbff 0%, #8b78ff 55%, #6d5efc 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.banner p {
  margin: 14px 0 22px;
  max-width: 560px;
  color: #c9c3de;
  font-size: 14px;
  line-height: 1.7;
  white-space: nowrap;
}
.banner-actions { display: flex; gap: 12px; }
.banner-actions button {
  height: 42px;
  padding: 0 18px;
  border-radius: 999px;
  font-size: 14px;
  cursor: pointer;
}
.banner-actions .go {
  border: 0;
  color: white;
  background: linear-gradient(90deg, #6a4dff, #7d5cff);
  box-shadow: 0 10px 24px rgba(106, 77, 255, 0.4);
}
.banner-actions .go:disabled { opacity: 0.6; cursor: default; }
.banner-actions .open {
  color: #efeaff;
  background: rgba(12, 10, 24, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.16);
}
.banner-art {
  position: absolute;
  z-index: 1;
  top: 14px;
  right: 24px;
  width: auto;
  height: calc(100% - 18px);
  max-width: none;
  object-fit: contain;
  object-position: right center;
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
  padding: 12px 14px;
  text-align: left;
  color: inherit;
  cursor: pointer;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: linear-gradient(180deg, rgba(36, 32, 58, 0.96), rgba(24, 21, 42, 0.96));
}
.quick-row button:hover { border-color: rgba(154, 132, 255, 0.45); }
.quick-row strong, .tools strong { display: block; font-size: 14px; }
.quick-row em, .tools em {
  display: block;
  margin-top: 3px;
  font-style: normal;
  font-size: 12px;
  color: #958eae;
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
.q-icon.violet { background: rgba(124, 92, 255, 0.18); color: #b7a6ff; }
.q-icon.blue { background: rgba(72, 149, 239, 0.16); color: #8ec2ff; }
.q-icon.green { background: rgba(52, 199, 123, 0.16); color: #7de7b2; }
.q-icon.indigo { background: rgba(99, 102, 241, 0.16); color: #a5b4fc; }
.q-icon.amber { background: rgba(245, 166, 35, 0.16); color: #f6c56b; }
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
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: #b7b1cb;
  cursor: pointer;
  font-size: 13px;
}
.filters button.on {
  color: white;
  background: rgba(109, 77, 255, 0.22);
  border-color: rgba(141, 116, 255, 0.45);
}
.view-toggle {
  display: flex;
  padding: 3px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
}
.view-toggle button {
  width: 30px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 8px;
}
.view-toggle button.on { background: rgba(255, 255, 255, 0.08); color: white; }
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
  color: #8d88a8;
  pointer-events: none;
}
.filter .search {
  box-sizing: border-box;
  width: 220px;
  height: 36px;
  padding: 0 14px 0 34px;
  line-height: 36px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: white;
  outline: none;
}
.create-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 228px;
  border-radius: 16px;
  border: 1px dashed rgba(154, 140, 255, 0.28);
  background: rgba(22, 18, 40, 0.72);
  color: #efeaff;
  cursor: pointer;
}
.create-card em { font-style: normal; color: #8d88a8; font-size: 12px; }
.create-mark {
  width: 54px;
  height: 54px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  background: rgba(109, 77, 255, 0.16);
  color: #c4b6ff;
}
.create-go {
  margin-top: 6px;
  color: #b7a6ff;
  font-size: 13px;
}
.filter-empty { grid-column: 1 / -1; color: #8d88a8; font-size: 13px; }
.shot-pill, .phase {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(8, 6, 18, 0.62);
  color: white;
}
.phase.active { background: rgba(59, 130, 246, 0.9); }
.phase.done { background: rgba(34, 160, 98, 0.92); }
.proj-open { display: none; }
.grid.list { grid-template-columns: 1fr; }
.grid.list .create-card { min-height: 84px; flex-direction: row; }
.lib-top { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; }
@media (max-width: 1100px) {
  .quick-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .banner { min-height: 420px; margin-top: -18px; padding-bottom: 200px; }
  .banner p { white-space: normal; }
  .banner-art { height: 58%; right: 8px; bottom: 0; }
}
@media (max-width: 860px) {
  .home { flex-direction: column; }
  .sidenav { width: auto; flex-basis: auto; border-right: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
  .side-links { flex-direction: row; overflow: auto; }
  .side-foot { display: none; }
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
  border-radius: 16px !important;
  box-shadow: none !important;
  border: 1px solid rgba(255, 255, 255, 0.06) !important;
  background: #17142a !important;
  transition:
    border-color 0.18s,
    transform 0.18s,
    background 0.18s !important;
}
.proj:hover {
  transform: translateY(-3px) !important;
  border-color: rgba(126, 180, 255, 0.4) !important;
  background: #171921 !important;
}
.proj-thumb {
  position: relative;
  aspect-ratio: 16/9;
  background: #191b22;
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
  opacity: 0.55;
  background:
    radial-gradient(120% 100% at 30% 0%, rgba(126, 180, 255, 0.22), transparent 60%),
    linear-gradient(135deg, #23262f 0%, #171921 100%);
}
.proj-thumb-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.proj-thumb-icon {
  color: var(--color-text-4);
  opacity: 0.5;
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
  background: linear-gradient(to top, rgba(10, 11, 15, 0.72), transparent 58%);
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
  border: 1px solid var(--color-border);
  border-radius: 99px;
  background: rgba(16, 18, 24, 0.55);
  backdrop-filter: blur(4px);
  color: var(--color-text-2);
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: all 0.15s;
}
.open-btn:hover {
  border-color: rgba(126, 180, 255, 0.6);
  background: rgba(126, 180, 255, 0.16);
  color: #eaf0ff;
}
.open-btn.primary {
  border-color: rgba(126, 180, 255, 0.5);
  background: rgba(126, 180, 255, 0.2);
  color: #dce6ff;
}
.open-btn.primary:hover {
  background: rgba(126, 180, 255, 0.3);
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
  color: var(--color-text-1);
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proj-topic {
  font-size: 12px;
  color: var(--color-text-3);
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
  color: var(--color-text-4);
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
  color: var(--color-text-2);
  cursor: pointer;
  transition: all 0.15s;
}
.proj-del:hover {
  opacity: 1;
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
}
.proj-folder:hover:not(:disabled) {
  opacity: 1;
  background: rgba(126, 180, 255, 0.14);
  color: #a9c8ff;
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
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: var(--color-text-1);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.16s;
}
.lib-upload:hover:not(:disabled) {
  border-color: rgba(126, 180, 255, 0.5);
  background: rgba(126, 180, 255, 0.08);
  color: #cfe0ff;
}
.lib-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.lib-side {
  position: sticky;
  top: 12px;
  padding: 12px;
  background: #14161c;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
}
.lib-side-title {
  font-size: 10px;
  font-weight: 650;
  color: var(--color-text-4);
  letter-spacing: 0.08em;
  margin-bottom: 10px;
}
.lib-folder-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 2px;
  align-items: center;
}
.lib-folder {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0 0 4px;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-3);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
}
.lib-folder span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lib-folder em {
  font-style: normal;
  font-size: 11px;
  color: var(--color-text-4);
  font-variant-numeric: tabular-nums;
}
.lib-folder:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text-2);
}
.lib-folder.on {
  background: rgba(126, 180, 255, 0.12);
  border-color: rgba(126, 180, 255, 0.32);
  color: var(--color-text-1);
}
.lib-folder-act {
  margin: 0 0 4px;
  padding: 4px;
  background: transparent;
  border: none;
  color: var(--color-text-4);
  cursor: pointer;
  display: inline-flex;
}
.lib-folder-act:hover {
  color: var(--color-text-1);
}
.lib-folder-act.danger:hover {
  color: var(--color-error);
}
.lib-rename,
.lib-new-folder {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}
.lib-rename {
  margin: 0 0 4px;
}
.lib-rename input,
.lib-new-folder input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: var(--color-text-1);
  font-size: 12px;
  outline: none;
}
.lib-rename input:focus,
.lib-new-folder input:focus {
  border-color: rgba(126, 180, 255, 0.55);
}
.lib-rename button,
.lib-new-folder button {
  margin: 0;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: var(--color-text-1);
  font-size: 12px;
  cursor: pointer;
}
.lib-new-folder button:disabled {
  opacity: 0.45;
  cursor: default;
}
.lib-hint {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--color-text-4);
}
.lib-move-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(126, 180, 255, 0.3);
  background: rgba(126, 180, 255, 0.08);
  font-size: 12px;
  color: var(--color-text-2);
}
.lib-move-bar select {
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: #14161c;
  color: var(--color-text-1);
}
.lib-move-bar button {
  margin: 0;
  padding: 4px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: linear-gradient(135deg, #7eb4ff, #8f9dff);
  color: #0b0d13;
  font-weight: 600;
  cursor: pointer;
}
.lib-move-bar button.ghost {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.1);
  color: var(--color-text-2);
  font-weight: 400;
}
.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  padding-bottom: 32px;
}
.lib-card {
  position: relative;
  background: #14161c;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 12px;
  overflow: hidden;
  transition: border-color 0.16s, transform 0.16s;
}
.lib-card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.16);
}
.lib-card.picked {
  border-color: rgba(126, 180, 255, 0.8);
  box-shadow: 0 0 0 1px rgba(126, 180, 255, 0.6);
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
  width: 100%;
  aspect-ratio: 1;
  margin: 0;
  padding: 0;
  border: none;
  background: #171921;
  cursor: pointer;
}
.lib-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
  .lib-layout {
    grid-template-columns: 1fr;
  }
  .lib-side {
    position: static;
  }
}
</style>
