<script setup lang="ts">
/**
 * 从资源库挑选已有图片 / 视频
 */
import { ref, computed, watch } from 'vue'
import { useAssetsStore, useLibraryStore, useProjectStore, LIBRARY_PUBLIC_ID } from '@/stores'
import type { Asset, AssetKind, ID } from '@/types'
import { assetContext } from '@/utils/assetLabel'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import { openLightbox } from '@/composables/useLightbox'

const props = defineProps<{
  open: boolean
  kind?: AssetKind | 'all'
  multiple?: boolean
  title?: string
  selectedIds?: ID[]
  /** 本页可用的图片 ID（一图生视频） */
  pageIds?: ID[]
  showLibrary?: boolean
}>()

const emit = defineEmits<{
  close: []
  confirm: [ids: ID[]]
}>()

const assets = useAssetsStore()
const library = useLibraryStore()
const project = useProjectStore()
const picked = ref<Set<ID>>(new Set())
const urls = ref<Record<string, string>>({})
const loading = ref(false)
const tab = ref<'page' | 'library'>('page')
const libraryFolder = ref(LIBRARY_PUBLIC_ID)

const kind = computed(() => props.kind ?? 'image')
const showTabs = computed(() => Boolean(props.showLibrary) && kind.value !== 'video' && kind.value !== 'audio')

const list = computed(() => {
  if (tab.value === 'library' && showTabs.value) {
    return library
      .inFolder(libraryFolder.value)
      .filter((a) => kind.value === 'all' || a.kind === kind.value)
  }
  const items =
    kind.value === 'all'
      ? assets.all
      : assets.all.filter((a) => a.kind === kind.value)
  if (props.pageIds?.length) {
    const allow = new Set(props.pageIds)
    const fromProject = items.filter((a) => allow.has(a.id))
    const have = new Set(fromProject.map((a) => a.id))
    const fromLib = showTabs.value
      ? library.all.filter(
          (a) =>
            allow.has(a.id) &&
            !have.has(a.id) &&
            (kind.value === 'all' || a.kind === kind.value)
        )
      : []
    return [...fromProject, ...fromLib]
  }
  return items
})

const emptyTitle = computed(() => {
  if (tab.value !== 'library') return '本页还没有图片'
  if (libraryFolder.value === LIBRARY_PUBLIC_ID) return '公共资产还是空的'
  return `「${library.folderName(libraryFolder.value)}」还是空的`
})

const emptyDesc = computed(() => {
  if (tab.value !== 'library') return '先用图片节点出图，或点节点上的＋上传参考图'
  if (libraryFolder.value === LIBRARY_PUBLIC_ID) {
    return '去首页资产库上传，或把项目里生成的图加入公共库'
  }
  return '去首页资产库创建分类，再把公共资产转移进来'
})

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    picked.value = new Set(props.selectedIds ?? [])
    tab.value = props.pageIds?.length || !showTabs.value ? 'page' : 'library'
    libraryFolder.value = LIBRARY_PUBLIC_ID
    loading.value = true
    try {
      await assets.refresh()
      if (showTabs.value) await library.refresh()
      await loadUrls()
    } finally {
      loading.value = false
    }
  }
)

watch([tab, libraryFolder], () => {
  if (props.open) loadUrls()
})

async function loadUrls() {
  const next: Record<string, string> = { ...urls.value }
  for (const a of list.value) {
    if (next[a.id]) continue
    if (a.kind === 'video') {
      const u = await assets.ensureThumb(a.id)
      if (u) next[a.id] = u
    } else {
      const u = (await assets.getUrl(a.id)) || (await library.getUrl(a.id))
      if (u) next[a.id] = u
    }
  }
  urls.value = next
}

function toggle(id: ID) {
  if (props.multiple) {
    const next = new Set(picked.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    picked.value = next
  } else {
    picked.value = new Set([id])
  }
}

function confirm() {
  emit('confirm', [...picked.value])
  emit('close')
}

function fmtSize(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB']
  let i = 0
  let b = bytes
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024
    i++
  }
  return `${b.toFixed(1)} ${units[i]}`
}

function labelOf(a: Asset) {
  return assetContext(a, project.allProjects, project.current)
}
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="open" class="mask" @click.self="emit('close')">
        <div class="modal">
          <header class="head">
            <div>
              <h3>{{ title || '从资源库选择' }}</h3>
              <p>{{ showTabs ? '可从本页图片、公共资产或自己的分类文件夹选用' : '已生成/上传的素材都在这里' }}</p>
            </div>
            <button class="close" @click="emit('close')">×</button>
          </header>
          <div v-if="showTabs" class="tabs">
            <button type="button" :class="{ on: tab === 'page' }" @click="tab = 'page'">本页图片</button>
            <button type="button" :class="{ on: tab === 'library' }" @click="tab = 'library'">资产库</button>
          </div>
          <div v-if="showTabs && tab === 'library'" class="folder-rail">
            <button
              type="button"
              :class="{ on: libraryFolder === LIBRARY_PUBLIC_ID }"
              @click="libraryFolder = LIBRARY_PUBLIC_ID"
            >
              公共资产
              <em>{{ library.folderCount(LIBRARY_PUBLIC_ID) }}</em>
            </button>
            <button
              v-for="f in library.folders"
              :key="f.id"
              type="button"
              :class="{ on: libraryFolder === f.id }"
              @click="libraryFolder = f.id"
            >
              {{ f.name }}
              <em>{{ library.folderCount(f.id) }}</em>
            </button>
          </div>

          <div v-if="loading" class="loading">加载资源库...</div>
          <EmptyState
            v-else-if="list.length === 0"
            icon="📦"
            :title="emptyTitle"
            :description="emptyDesc"
          />
          <div v-else class="grid">
            <button
              v-for="a in list"
              :key="a.id"
              class="card"
              :class="{ selected: picked.has(a.id) }"
              @click="toggle(a.id)"
            >
              <div class="thumb">
                <img v-if="urls[a.id] && a.kind === 'image'" :src="urls[a.id]" alt="" />
                <img v-else-if="urls[a.id] && a.kind === 'video'" :src="urls[a.id]" alt="" />
                <div v-else class="ph">{{ a.kind === 'video' ? '🎥' : '🖼' }}</div>
                <button
                  v-if="urls[a.id]"
                  class="zoom"
                  type="button"
                  title="查看大图"
                  @click.stop="openLightbox(urls[a.id])"
                >
                  放大
                </button>
              </div>
              <div class="meta">
                <div class="name" :title="labelOf(a).title">{{ labelOf(a).title }}</div>
                <div class="sub">
                  <Tag size="sm" :type="a.source === 'ai-generated' ? 'accent' : 'info'">
                    {{ a.library ? (a.folderId ? library.folderName(a.folderId) : '公共') : a.source === 'ai-generated' ? 'AI' : '上传' }}
                  </Tag>
                  {{ a.library ? library.folderName(a.folderId) : labelOf(a).projectName }}
                  · {{ fmtSize(a.size) }}
                </div>
              </div>
              <div v-if="picked.has(a.id)" class="check">✓</div>
            </button>
          </div>

          <footer class="foot">
            <span class="count">已选 {{ picked.size }} 项</span>
            <GradientButton type="ghost" @click="emit('close')">取消</GradientButton>
            <GradientButton :disabled="picked.size === 0" @click="confirm">
              选用
            </GradientButton>
          </footer>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(0, 0, 0, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.modal {
  width: min(960px, 100%);
  max-height: min(86vh, 820px);
  background: var(--color-bg-1);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-lg);
}
.head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--color-border);
}
.head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.head p {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-3);
}
.close {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  font-size: 20px;
  color: var(--color-text-3);
}
.close:hover {
  background: var(--color-fill-hover);
  color: var(--color-text-1);
}
.tabs {
  display: flex;
  gap: 6px;
  padding: 10px 20px 0;
}
.tabs button {
  margin: 0;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  cursor: pointer;
}
.tabs button.on {
  background: var(--color-fill-strong);
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
}
.folder-rail {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 20px 0;
}
.folder-rail button {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 99px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  cursor: pointer;
}
.folder-rail button em {
  font-style: normal;
  font-size: 10px;
  color: var(--color-text-4);
}
.folder-rail button.on {
  background: var(--color-fill-strong);
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
}
.loading {
  padding: 48px;
  text-align: center;
  color: var(--color-text-3);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 10px;
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
}
.card {
  position: relative;
  text-align: left;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  color: inherit;
  transition: border-color var(--duration-fast);
}
.card:hover {
  border-color: var(--color-border-strong);
}
.card.selected {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
}
.thumb {
  position: relative;
  aspect-ratio: 16/10;
  background: #000;
}
.thumb img,
.thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.zoom {
  position: absolute;
  right: 6px;
  bottom: 6px;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 99px;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
}
.ph {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  opacity: 0.5;
}
.meta {
  padding: 8px 10px 10px;
}
.name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-4);
  display: flex;
  align-items: center;
  gap: 6px;
}
.check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--grad-primary);
  color: white;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
}
.count {
  flex: 1;
  font-size: 12px;
  color: var(--color-text-3);
}
</style>
