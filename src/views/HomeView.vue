<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore, useLibraryStore, LIBRARY_PUBLIC_ID } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
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
const creating = ref(false)

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
    <div class="hero">
      <div class="hero-grid" />
      <div class="hero-glow" />
      <div class="hero-content">
        <span class="hero-badge"><i class="dot" />剧流 Studio · AI 短剧工作台</span>
        <h1 class="title">
          一句话，<span class="gradient-text">一条 AI 流水线</span>，<br />
          输出一条视频
        </h1>
        <p class="subtitle">
          桌面端无限画布 + 智能体：人设、分镜、配图、视频都在一张图上连起来。资源存在本地文件夹。
        </p>
        <div class="hero-actions">
          <GradientButton size="lg" type="secondary" @click="openQuickEditor">
            <template #icon><HomeIcon name="scissors" :size="18" /></template>
            视频剪辑
          </GradientButton>
          <GradientButton size="lg" type="secondary" @click="router.push({ name: 'smart-speech', query: { new: '1' } })">
            <template #icon><HomeIcon name="mic" :size="18" /></template>
            智能口播
          </GradientButton>
          <GradientButton size="lg" :loading="creating" :disabled="creating" @click="quickCreate">
            <template #icon><HomeIcon name="plus" :size="18" /></template>
            新建
          </GradientButton>
          <GradientButton
            size="lg"
            type="ghost"
            title="本地 Markdown 剧本库：编辑正文、增删集数、导入导出"
            @click="router.push('/scripts')"
          >
            <template #icon><HomeIcon name="script" :size="18" /></template>
            剧本库
          </GradientButton>
          <GradientButton
            size="lg"
            type="ghost"
            title="按 剧本 → 分镜 → 图片 → 视频 → 剪辑 的分步流程制作"
            @click="goClassicFlow"
          >
            <template #icon><HomeIcon name="wand" :size="18" /></template>
            经典步骤
          </GradientButton>
          <GradientButton
            v-if="isDesktop()"
            size="lg"
            type="ghost"
            :disabled="!project.current?.folderPath"
            :title="project.current?.folderPath || '请先创建或打开一个项目'"
            @click="openProjectFolder()"
          >
            <template #icon><HomeIcon name="folder" :size="18" /></template>
            打开当前项目目录
          </GradientButton>
          <GradientButton size="lg" type="ghost" @click="router.push('/settings')">
            <template #icon><HomeIcon name="settings" :size="18" /></template>
            接入 AI 能力
          </GradientButton>
        </div>
        <div class="stats">
          <div v-for="s in statItems" :key="s.label" class="stat">
            <div class="stat-value" :class="{ accent: s.accent }">{{ s.value }}</div>
            <div class="stat-label">{{ s.label }}</div>
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
          <HomeIcon class="search-icon" name="search" :size="17" />
          <input v-model="search" class="search" placeholder="搜索项目" />
        </div>
        <button v-else type="button" class="lib-upload" :disabled="libUploading" @click="uploadLibraryImages">
          <HomeIcon name="upload" :size="16" />
          {{ libUploading ? '上传中…' : `上传到${currentFolderLabel}` }}
        </button>
      </div>

      <div v-if="homeTab === 'projects'">
      <EmptyState
        v-if="filteredProjects.length === 0"
        title="还没有项目"
        description="点击「新建」直接开一张画布，告诉左侧智能体想做什么就行"
      >
        <template #icon><HomeIcon name="film" :size="44" /></template>
        <template #action>
          <GradientButton :loading="creating" :disabled="creating" @click="quickCreate">
            <template #icon><HomeIcon name="plus" :size="16" /></template>
            新建
          </GradientButton>
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
  overflow-y: auto;
  background: #0d0e12;
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
  border-radius: 14px !important;
  box-shadow: none !important;
  background: #14161c !important;
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
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
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
.proj-meta-top :deep(.tag) { gap: 4px; }
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
