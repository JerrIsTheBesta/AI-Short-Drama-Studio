<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore, useLibraryStore, LIBRARY_PUBLIC_ID } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import { isDesktop, desktop } from '@/services/desktop'
import { pickCoverAssetId, projectCoverUrl } from '@/services/storage'
import { pickLocalFiles } from '@/utils/pickLocalFiles'
import { runVideoRemake } from '@/services/canvas/runner'
import { openLightbox } from '@/composables/useLightbox'
import type { AspectRatio } from '@/types'

const router = useRouter()
const project = useProjectStore()
const toast = useToastStore()

const search = ref('')
const showCreateModal = ref(false)
const newName = ref('')
const newTopic = ref('')
const newStyle = ref<'cinematic' | 'anime' | 'photorealistic' | '3d-render'>('cinematic')
const newAspectRatio = ref<AspectRatio>('16:9')
const pipelineMode = ref<'standard' | 'drama' | 'remake' | 'img2video'>('standard')
const remakeVideo = ref<File | null>(null)
const remakeVideoUrl = ref('')
const remakeProducts = ref<File[]>([])
const remakeProductUrls = ref<string[]>([])
const creating = ref(false)
const createProgress = ref('')
const MAX_REMAKE_PRODUCTS = 8

/** 比例预设（带尺寸） */
const aspectPresets: { value: AspectRatio; label: string; desc: string; w: number; h: number }[] = [
  { value: '16:9', label: '🖥 横版', desc: '电脑/YouTube', w: 1280, h: 720 },
  { value: '9:16', label: '📱 竖版', desc: '抖音/小红书/手机', w: 720, h: 1280 },
  { value: '1:1', label: '⬜ 方形', desc: 'Instagram/朋友圈', w: 1024, h: 1024 },
  { value: '4:3', label: '📺 传统', desc: '传统电视/老视频', w: 1024, h: 768 },
  { value: '21:9', label: '🎬 影院', desc: '电影宽屏', w: 1680, h: 720 }
]

const covers = ref<Record<string, string>>({})
const library = useLibraryStore()
const libUrls = ref<Record<string, string>>({})
const libUploading = ref(false)
const homeTab = ref<'projects' | 'library'>('projects')
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

function revokeRemakePreviews() {
  if (remakeVideoUrl.value) URL.revokeObjectURL(remakeVideoUrl.value)
  remakeVideoUrl.value = ''
  for (const u of remakeProductUrls.value) URL.revokeObjectURL(u)
  remakeProductUrls.value = []
}

function resetCreateForm() {
  newName.value = ''
  newTopic.value = ''
  pipelineMode.value = 'standard'
  remakeVideo.value = null
  remakeProducts.value = []
  revokeRemakePreviews()
  creating.value = false
  createProgress.value = ''
}

function closeCreateModal() {
  if (creating.value) return
  showCreateModal.value = false
  resetCreateForm()
}

async function pickRemakeVideo() {
  let files: File[]
  try {
    files = await pickLocalFiles({ kind: 'video', multiple: false })
  } catch (err: any) {
    toast.error(err?.message || '读取视频失败')
    return
  }
  const file = files[0]
  if (!file) return
  if (!file.type.startsWith('video/')) {
    toast.warn('请上传视频文件')
    return
  }
  if (remakeVideoUrl.value) URL.revokeObjectURL(remakeVideoUrl.value)
  remakeVideo.value = file
  remakeVideoUrl.value = URL.createObjectURL(file)
}

async function pickRemakeProducts() {
  let files: File[]
  try {
    files = await pickLocalFiles({ kind: 'image', multiple: true })
  } catch (err: any) {
    toast.error(err?.message || '读取产品图失败')
    return
  }
  const images = files.filter((f) => f.type.startsWith('image/'))
  const room = MAX_REMAKE_PRODUCTS - remakeProducts.value.length
  const take = images.slice(0, Math.max(0, room))
  if (!take.length) return
  remakeProducts.value = [...remakeProducts.value, ...take]
  remakeProductUrls.value = [...remakeProductUrls.value, ...take.map((f) => URL.createObjectURL(f))]
}

function removeRemakeProduct(index: number) {
  URL.revokeObjectURL(remakeProductUrls.value[index])
  remakeProducts.value = remakeProducts.value.filter((_, i) => i !== index)
  remakeProductUrls.value = remakeProductUrls.value.filter((_, i) => i !== index)
}

async function createProject() {
  if (creating.value) return
  if (!newName.value.trim()) {
    toast.warn('请输入项目名')
    return
  }
  if (pipelineMode.value === 'remake') {
    if (!remakeVideo.value) {
      toast.warn('视频复刻需要上传一条参考视频')
      return
    }
    if (!remakeProducts.value.length) {
      toast.warn('视频复刻必须上传至少一张产品图')
      return
    }
  }
  creating.value = true
  createProgress.value = '创建项目…'
  const creatingMode = pipelineMode.value
  let createdId = ''
  try {
    const p = await project.createNamed(newName.value.trim())
    createdId = p.id
    p.pipelineMode = pipelineMode.value
    p.script = {
      id: 's_' + Date.now().toString(36),
      topic: newTopic.value.trim() || newName.value.trim(),
      content: '',
      keywords: [],
      style: newStyle.value,
      aspectRatio: newAspectRatio.value,
      shotDuration: 5,
      createdAt: Date.now()
    }
    if (pipelineMode.value === 'drama') {
      const now = Date.now()
      const firstChapterId = 'ch_' + now.toString(36)
      p.chapters = [{
        id: firstChapterId,
        title: '第 1 章',
        content: '',
        order: 0,
        status: 'draft',
        createdAt: now,
        updatedAt: now
      }]
      p.selectedChapterIds = [firstChapterId]
      p.productionChapterIds = []
      p.script.workflowMode = 'film-chapter'
    }
    if (pipelineMode.value === 'img2video') {
      p.playApproved = true
    }
    project.setScript(p.script)
    project.setAspectRatio(newAspectRatio.value)
    await project.save()

    if (pipelineMode.value === 'remake' && remakeVideo.value) {
      await runVideoRemake({
        videoFile: remakeVideo.value,
        productFiles: remakeProducts.value,
        onProgress: (msg) => {
          createProgress.value = msg
        }
      })
      toast.success('已按参考视频生成脚本，配音将后期合成')
    }

    showCreateModal.value = false
    resetCreateForm()
    router.push(creatingMode === 'drama' ? '/script' : '/studio')
  } catch (e: any) {
    toast.error(e?.message || '创建失败，素材已保存，可进画布重试')
    showCreateModal.value = false
    resetCreateForm()
    if (createdId && project.current?.id === createdId) {
      router.push(project.current.pipelineMode === 'drama' ? '/script' : '/studio')
    }
  }
}

function deleteProject(id: string) {
  if (!confirm('确定要删除该项目吗？素材也会被一起删除。')) return
  project.remove(id)
  toast.success('项目已删除')
}

async function openLocalFolder() {
  if (!isDesktop()) return
  const dir = await desktop().pickDirectory()
  if (!dir) return
  await project.openFromFolder(dir)
  if (!project.current) {
    toast.error('这个文件夹里没有 project.json')
    return
  }
  router.push('/studio')
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
    <div class="hero">
      <div class="hero-bg" />
      <div class="hero-content">
        <div class="brand">
          <img class="brand-mark" src="/logo.png" alt="" />
          <span class="brand-name">剧流 Studio</span>
        </div>
        <h1 class="title">
          一句话，<span class="gradient-text">一条 AI 流水线</span>，<br />
          输出一条视频
        </h1>
        <p class="subtitle">
          桌面端无限画布 + 智能体：人设、分镜、配图、视频都在一张图上连起来。资源存在本地文件夹。
        </p>
        <div class="hero-actions">
          <GradientButton size="lg" icon="◉" @click="router.push({ name: 'smart-speech', query: { new: '1' } })">
            智能口播
          </GradientButton>
          <GradientButton size="lg" icon="✨" @click="showCreateModal = true">
            创建新项目
          </GradientButton>
          <GradientButton v-if="isDesktop()" size="lg" type="ghost" @click="openLocalFolder">
            打开本地文件夹
          </GradientButton>
          <GradientButton size="lg" type="ghost" @click="router.push('/settings')">
            ⚙ 接入 AI 能力
          </GradientButton>
        </div>
        <div class="stats">
          <div class="stat">
            <div class="stat-value">{{ project.allProjects.length }}</div>
            <div class="stat-label">项目</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ totalShots }}</div>
            <div class="stat-label">分镜</div>
          </div>
          <div class="stat">
            <div class="stat-value gradient-text">
              {{ fmtDuration(totalDuration) }}
            </div>
            <div class="stat-label">视频总时长</div>
          </div>
        </div>
      </div>
    </div>

    <div class="container">
      <div class="section-header">
        <div class="home-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            :class="{ on: homeTab === 'projects' }"
            :aria-selected="homeTab === 'projects'"
            @click="homeTab = 'projects'"
          >
            我的项目
            <em>{{ project.allProjects.length }}</em>
          </button>
          <button
            type="button"
            role="tab"
            :class="{ on: homeTab === 'library' }"
            :aria-selected="homeTab === 'library'"
            @click="homeTab = 'library'"
          >
            资产库
            <em>{{ library.all.length }}</em>
          </button>
        </div>
        <div v-if="homeTab === 'projects'" class="filter">
          <input
            v-model="search"
            class="search"
            placeholder="🔍 搜索项目..."
          />
        </div>
        <button v-else type="button" class="lib-upload" :disabled="libUploading" @click="uploadLibraryImages">
          {{ libUploading ? '上传中…' : `＋ 上传到${currentFolderLabel}` }}
        </button>
      </div>

      <div v-if="homeTab === 'projects'">
      <EmptyState
        v-if="filteredProjects.length === 0"
        icon="🎬"
        title="还没有项目"
        description="点击「创建新项目」开始你的第一条视频"
      >
        <template #action>
          <GradientButton @click="showCreateModal = true">创建新项目</GradientButton>
        </template>
      </EmptyState>

      <div v-else class="grid">
        <GlassCard
          v-for="p in filteredProjects"
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
              <div class="proj-thumb-icon">🎬</div>
            </div>
            <div class="proj-meta-top">
              <Tag v-if="p.pipelineMode === 'remake'" type="warning" size="sm">复刻</Tag>
              <Tag v-else-if="p.pipelineMode === 'img2video'" type="info" size="sm">自由模式</Tag>
              <Tag v-else-if="p.pipelineMode === 'smart-speech'" type="success" size="sm">智能口播</Tag>
              <Tag v-else-if="p.pipelineMode === 'drama'" type="accent" size="sm">AI 短剧 · {{ p.chapters?.length || 0 }} 章</Tag>
              <Tag v-if="p.shots.length > 0" type="accent" size="sm">
                🎬 {{ p.shots.length }} 个分镜
              </Tag>
              <Tag
                v-if="p.shots.some((s) => s.imageAssetId)"
                type="info"
                size="sm"
              >
                🖼 {{ p.shots.filter((s) => s.imageAssetId).length }} 张图
              </Tag>
              <Tag
                v-if="p.shots.some((s) => s.videoAssetId)"
                type="success"
                size="sm"
              >
                🎥 {{ p.shots.filter((s) => s.videoAssetId).length }} 段视频
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
                  class="proj-del"
                  title="删除"
                  @click="deleteProject(p.id)"
                >
                  🗑
                </button>
              </div>
            </div>
          </div>
        </GlassCard>
      </div>
      </div>

      <div v-else class="lib-layout">
        <aside class="lib-side">
          <div class="lib-side-title">分类</div>
          <button
            type="button"
            class="lib-folder"
            :class="{ on: libFolderId === LIBRARY_PUBLIC_ID }"
            @click="selectLibFolder(LIBRARY_PUBLIC_ID)"
          >
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
              ✎
            </button>
            <button
              type="button"
              class="lib-folder-act danger"
              title="删除文件夹"
              @click="removeLibFolder(f.id, f.name)"
            >
              🗑
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
            :icon="library.all.length === 0 ? '🖼' : '📂'"
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
          />
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
                <span v-else>🖼</span>
              </button>
              <div class="lib-meta">
                <span>{{ a.filename }}</span>
                <button type="button" title="删除" @click="removeLibraryItem(a.id)">🗑</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 创建项目弹窗 -->
    <transition name="fade">
      <div v-if="showCreateModal" class="modal-mask" @click.self="closeCreateModal">
        <GlassCard padding="lg" class="modal" :class="{ remake: pipelineMode === 'remake' }">
          <h3>{{ creating ? '正在准备项目' : '创建新项目' }}</h3>
          <p class="modal-desc">
            {{
              creating
                ? createProgress
                : pipelineMode === 'remake'
                  ? '上传参考视频和产品图，AI 会按镜头复刻脚本；配音后期合成，视频里不出口播。'
                  : pipelineMode === 'img2video'
                    ? '自由画布：右键添加图片、视频和剧本。剧本可以提炼角色、场景和分镜。'
                    : pipelineMode === 'drama'
                      ? '先进入剧本工作台，可以长期创作多个章节；准备好后再选择章节制作分镜和视频。'
                    : '起个好名字，下一步可以填具体文案'
            }}
          </p>

          <div v-if="creating" class="creating-box">
            <div class="creating-spin" />
            <div class="creating-text">{{ createProgress || '处理中…' }}</div>
          </div>

          <template v-else>
            <label class="field">
              <span>创作方式</span>
              <div class="mode-grid">
                <button
                  class="mode-pick"
                  :class="{ active: pipelineMode === 'standard' }"
                  @click="pipelineMode = 'standard'"
                >
                  <div class="mode-title">普通创作</div>
                  <div class="mode-desc">从主题/文案写剧本</div>
                </button>
                <button
                  class="mode-pick"
                  :class="{ active: pipelineMode === 'drama' }"
                  @click="pipelineMode = 'drama'"
                >
                  <div class="mode-title">AI 短剧</div>
                  <div class="mode-desc">多章节写作，选章节后再做视频</div>
                </button>
                <button
                  class="mode-pick"
                  :class="{ active: pipelineMode === 'remake' }"
                  @click="pipelineMode = 'remake'"
                >
                  <div class="mode-title">视频复刻</div>
                  <div class="mode-desc">按参考视频镜头换上你的产品</div>
                </button>
                <button
                  class="mode-pick"
                  :class="{ active: pipelineMode === 'img2video' }"
                  @click="pipelineMode = 'img2video'"
                >
                  <div class="mode-title">自由模式</div>
                  <div class="mode-desc">画布上自由加图片、视频和剧本</div>
                </button>
              </div>
            </label>

            <label class="field">
              <span>项目名</span>
              <input v-model="newName" placeholder="例如：夏日旅行 vlog" class="input" />
            </label>

            <label v-if="pipelineMode !== 'img2video'" class="field">
              <span>主题（可选）</span>
              <input v-model="newTopic" placeholder="一句话描述视频主题" class="input" />
            </label>

            <template v-if="pipelineMode === 'remake'">
              <div class="field">
                <span>参考视频（必传 1 条）</span>
                <div v-if="remakeVideo" class="video-preview">
                  <video :src="remakeVideoUrl" controls muted playsinline />
                  <div class="file-name">{{ remakeVideo.name }}</div>
                  <button type="button" class="replace-video" @click="pickRemakeVideo">
                    更换视频
                  </button>
                </div>
                <button v-else type="button" class="video-add" @click="pickRemakeVideo">
                  ＋ 上传参考视频
                </button>
                <p class="upload-hint">支持 mp4 / mov 等常见视频，会抽帧理解镜头语言。</p>
              </div>

              <div class="field">
                <span>产品图（必传，可多张，最多 {{ MAX_REMAKE_PRODUCTS }} 张）</span>
                <p class="field-hint">复刻镜头里的商品都会换成这些图。</p>
                <div class="product-row">
                  <div
                    v-for="(url, i) in remakeProductUrls"
                    :key="url"
                    class="product-thumb"
                  >
                    <img :src="url" alt="产品图" />
                    <button class="product-del" type="button" @click="removeRemakeProduct(i)">×</button>
                  </div>
                  <button
                    v-if="remakeProducts.length < MAX_REMAKE_PRODUCTS"
                    type="button"
                    class="product-add"
                    @click="pickRemakeProducts"
                  >
                    ＋ 上传产品图
                  </button>
                </div>
              </div>
            </template>

            <label class="field">
              <span>画面风格</span>
              <div class="style-grid">
                <button
                  v-for="s in ['cinematic', 'anime', 'photorealistic', '3d-render'] as const"
                  :key="s"
                  class="style-pick"
                  :class="{ active: newStyle === s }"
                  @click="newStyle = s"
                >
                  {{ { cinematic: '电影', anime: '动漫', photorealistic: '写实', '3d-render': '3D 渲染' }[s] }}
                </button>
              </div>
            </label>

            <label class="field">
              <span>视频比例（生成图片和视频都会用这个比例，复刻请尽量和参考视频一致）</span>
              <div class="aspect-grid">
                <button
                  v-for="a in aspectPresets"
                  :key="a.value"
                  class="aspect-pick"
                  :class="{ active: newAspectRatio === a.value }"
                  @click="newAspectRatio = a.value"
                >
                  <div class="aspect-visual" :data-ar="a.value">
                    <div class="aspect-box" />
                  </div>
                  <div class="aspect-info">
                    <div class="aspect-label">{{ a.label }}</div>
                    <div class="aspect-desc">{{ a.desc }}</div>
                    <div class="aspect-size">{{ a.w }}×{{ a.h }}</div>
                  </div>
                </button>
              </div>
            </label>
          </template>

          <div class="modal-actions">
            <GradientButton type="ghost" :disabled="creating" @click="closeCreateModal">取消</GradientButton>
            <GradientButton icon="✨" :loading="creating" :disabled="creating" @click="createProject">
              {{ pipelineMode === 'remake' ? '创建并分析视频' : pipelineMode === 'drama' ? '创建并写剧本' : '创建并开始' }}
            </GradientButton>
          </div>
        </GlassCard>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.home {
  height: 100%;
  overflow-y: auto;
  background: var(--color-bg-0);
}
.hero {
  position: relative;
  min-height: 420px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.hero-bg {
  position: absolute;
  inset: 0;
  background: var(--color-bg-0);
  z-index: 0;
}
.hero-content {
  position: relative;
  z-index: 1;
  text-align: center;
  padding: var(--space-8) var(--space-5);
  max-width: 900px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-6);
}
.brand-mark {
  display: block;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  object-fit: contain;
}
.brand-name {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text-1);
  letter-spacing: 0.5px;
}
.title {
  font-size: 48px;
  font-weight: 800;
  line-height: 1.2;
  margin: 0 0 var(--space-5);
  letter-spacing: -0.02em;
}
.subtitle {
  font-size: 16px;
  color: var(--color-text-2);
  margin: 0 0 var(--space-8);
  letter-spacing: 0.3px;
}
.hero-actions {
  display: flex;
  gap: var(--space-3);
  justify-content: center;
  margin-bottom: var(--space-10);
}
.stats {
  display: flex;
  gap: var(--space-6);
  justify-content: center;
  padding-top: var(--space-6);
  border-top: 1px solid var(--color-border);
  max-width: 600px;
  margin: 0 auto;
}
.stat {
  text-align: center;
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--color-text-1);
  margin-bottom: 4px;
}
.stat-label {
  font-size: 12px;
  color: var(--color-text-3);
  letter-spacing: 0.5px;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: var(--space-8) var(--space-5) var(--space-12);
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-6);
}
.section-header h2 {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
}
.home-tabs {
  display: flex;
  gap: 6px;
}
.home-tabs button {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-3);
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
}
.home-tabs button em {
  font-style: normal;
  font-size: 11px;
  font-weight: 600;
  min-width: 18px;
  padding: 1px 6px;
  border-radius: 99px;
  background: var(--color-fill);
  color: var(--color-text-4);
}
.home-tabs button.on {
  background: var(--color-bg-2);
  border-color: var(--color-border);
  color: var(--color-text-1);
}
.home-tabs button.on em {
  background: var(--color-fill-strong);
  color: var(--color-text-2);
}
.search {
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 8px 14px;
  font-size: 13px;
  color: var(--color-text-1);
  outline: none;
  width: 220px;
  transition: all var(--duration-fast);
}
.search:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.15);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-5);
}
.proj {
  cursor: pointer;
  overflow: hidden;
  transition: transform var(--duration-fast) var(--ease-out);
}
.proj:hover {
  transform: translateY(-4px);
}
.proj-thumb {
  position: relative;
  aspect-ratio: 16/9;
  background: var(--color-bg-2);
}
.proj-cover {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.proj-thumb-grad {
  position: absolute;
  inset: 0;
  opacity: 0.6;
}
.proj-thumb-grad[data-style='cinematic'],
.proj-thumb-grad[data-style='anime'],
.proj-thumb-grad[data-style='photorealistic'],
.proj-thumb-grad[data-style='3d-render'],
.proj-thumb-grad[data-style='oil-painting'],
.proj-thumb-grad[data-style='watercolor'],
.proj-thumb-grad[data-style='pixel-art'],
.proj-thumb-grad[data-style='ink-wash'] {
  background: linear-gradient(135deg, #ececec 0%, #d4d4d4 50%, #bdbdbd 100%);
}
.proj-thumb-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.proj-thumb-icon {
  font-size: 48px;
  opacity: 0.4;
}
.proj-meta-top {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  right: var(--space-2);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  z-index: 2;
}
.proj-info {
  padding: var(--space-3) var(--space-4);
}
.proj-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-1);
  margin-bottom: 2px;
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
  margin-bottom: var(--space-2);
}
.proj-bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: var(--space-2);
}
.proj-date {
  font-size: 11px;
  color: var(--color-text-4);
}
.proj-del {
  font-size: 13px;
  opacity: 0.4;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  transition: all var(--duration-fast);
}
.proj-del:hover {
  opacity: 1;
  background: rgba(239, 68, 68, 0.15);
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
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
}
.modal.remake {
  max-width: 620px;
}
.modal h3 {
  margin: 0 0 var(--space-1);
  font-size: 18px;
}
.modal-desc {
  margin: 0 0 var(--space-5);
  font-size: 13px;
  color: var(--color-text-3);
}
.field {
  display: block;
  margin-bottom: var(--space-4);
}
.field > span {
  display: block;
  font-size: 12px;
  color: var(--color-text-3);
  margin-bottom: 6px;
  font-weight: 500;
}
.input {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  font-size: 13px;
  color: var(--color-text-1);
  outline: none;
  transition: all var(--duration-fast);
}
.input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.15);
}
.style-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.style-pick {
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  color: var(--color-text-2);
  font-size: 12px;
  font-weight: 500;
  transition: all var(--duration-fast);
}
.style-pick:hover {
  border-color: var(--color-border-strong);
}
.style-pick.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
  color: var(--color-text-1);
}

.aspect-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-2);
}
.aspect-pick {
  text-align: left;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px;
  transition: all var(--duration-fast);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.aspect-pick:hover {
  border-color: var(--color-border-strong);
}
.aspect-pick.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
}
.aspect-pick.active .aspect-label {
  color: var(--color-text-1);
}
.aspect-visual {
  width: 100%;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-fill);
  border-radius: 4px;
}
.aspect-box {
  background: var(--color-text-3);
}
.aspect-visual[data-ar='16:9'] .aspect-box { width: 36px; height: 20px; }
.aspect-visual[data-ar='9:16'] .aspect-box { width: 14px; height: 24px; }
.aspect-visual[data-ar='1:1'] .aspect-box { width: 22px; height: 22px; }
.aspect-visual[data-ar='4:3'] .aspect-box { width: 30px; height: 22px; }
.aspect-visual[data-ar='21:9'] .aspect-box { width: 42px; height: 18px; }
.aspect-pick.active .aspect-box {
  background: var(--color-accent);
}
.aspect-info {
  text-align: center;
  width: 100%;
}
.aspect-label {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
}
.aspect-desc {
  font-size: 10px;
  color: var(--color-text-3);
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
  gap: var(--space-2);
  margin-top: var(--space-6);
}
.mode-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-2);
}
.mode-pick {
  text-align: left;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  color: var(--color-text-2);
  transition: all var(--duration-fast);
}
.mode-pick:hover {
  border-color: var(--color-border-strong);
}
.mode-pick.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
  color: var(--color-text-1);
}
.mode-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.mode-desc {
  font-size: 11px;
  color: var(--color-text-3);
  line-height: 1.4;
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
  border-radius: var(--radius-sm);
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
  color: var(--color-text-3);
  background: var(--color-bg-2);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.replace-video {
  padding: 8px;
  font-size: 12px;
}
.video-add:hover,
.replace-video:hover {
  border-color: var(--color-accent);
  color: var(--color-text-1);
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
  border-radius: var(--radius-sm);
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
  color: var(--color-text-3);
  background: var(--color-bg-2);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.product-add:hover {
  border-color: var(--color-accent);
  color: var(--color-text-1);
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
  border: 3px solid rgba(124, 58, 237, 0.25);
  border-top-color: var(--color-accent);
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
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
  cursor: pointer;
}
.lib-layout {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: var(--space-5);
  align-items: start;
}
.lib-side {
  position: sticky;
  top: 12px;
  padding: 12px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.lib-side-title {
  font-size: 11px;
  font-weight: 650;
  color: var(--color-text-4);
  letter-spacing: 0.06em;
  margin-bottom: 8px;
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
  color: var(--color-text-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
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
}
.lib-folder.on {
  background: var(--color-fill-strong);
  border-color: var(--color-border-strong);
  color: var(--color-text-1);
}
.lib-folder-act {
  margin: 0 0 4px;
  padding: 4px;
  background: transparent;
  border: none;
  color: var(--color-text-4);
  cursor: pointer;
  font-size: 11px;
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
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
}
.lib-rename button,
.lib-new-folder button {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-1);
  font-size: 12px;
  cursor: pointer;
}
.lib-new-folder button:disabled {
  opacity: 0.45;
  cursor: default;
}
.lib-hint {
  margin: 0 0 var(--space-4);
  font-size: 12px;
  color: var(--color-text-4);
}
.lib-move-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--space-4);
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-1);
  font-size: 12px;
  color: var(--color-text-2);
}
.lib-move-bar select {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-1);
}
.lib-move-bar button {
  margin: 0;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-fill-strong);
  color: var(--color-text-1);
  cursor: pointer;
}
.lib-move-bar button.ghost {
  background: transparent;
}
.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-3);
  padding-bottom: var(--space-8);
}
.lib-card {
  position: relative;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.lib-card.picked {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
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
  background: rgba(0, 0, 0, 0.45);
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
  background: var(--color-bg-2);
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
  padding: 6px 8px;
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
}
.lib-meta button:hover {
  color: var(--color-error);
}
@media (max-width: 720px) {
  .lib-layout {
    grid-template-columns: 1fr;
  }
  .lib-side {
    position: static;
  }
}
</style>
