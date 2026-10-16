<script setup lang="ts">
/**
 * 资源库
 *
 * 显示当前项目步骤产物 + IndexedDB 里全部图片/视频。
 * 重新生成不会把旧文件从资源库删掉。
 */

import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore, useScriptsStore } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import type { Asset, AssetWithUrl } from '@/types'
import { assetContext as resolveAssetContext } from '@/utils/assetLabel'

const router = useRouter()
const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()
const scripts = useScriptsStore()

const imageUrls = ref<Record<string, string>>({})
const videoUrls = ref<Record<string, string>>({})
const libraryUrls = ref<Record<string, string>>({})
const libraryThumbs = ref<Record<string, string>>({})
const libraryPlayUrls = ref<Record<string, string>>({})
const playingId = ref<string | null>(null)
const thumbsLoading = ref(false)
const previewAsset = ref<AssetWithUrl | null>(null)
const previewTitle = ref('')

onMounted(async () => {
  if (!project.current) {
    toast.warn('没有打开的项目')
    router.push('/')
    return
  }
  await project.refreshList()
  await assets.refresh()
  await scripts.refresh()
  await loadAssets()
})

async function loadAssets() {
  if (!project.current) return
  for (const shot of project.current.shots) {
    if (shot.imageAssetId) {
      const u = await assets.getUrl(shot.imageAssetId)
      if (u) imageUrls.value[shot.id] = u
    }
    if (shot.videoAssetId) {
      const u = await assets.getUrl(shot.videoAssetId)
      if (u) videoUrls.value[shot.id] = u
    }
  }
  const next: Record<string, string> = {}
  for (const a of assets.all) {
    if (a.kind !== 'video') {
      const u = await assets.getUrl(a.id)
      if (u) next[a.id] = u
    }
  }
  libraryUrls.value = next

  thumbsLoading.value = true
  try {
    for (const a of assets.all) {
      if (a.kind !== 'video') continue
      const thumb = await assets.ensureThumb(a.id)
      if (thumb) {
        libraryThumbs.value = { ...libraryThumbs.value, [a.id]: thumb }
      }
    }
  } finally {
    thumbsLoading.value = false
  }
}

// ===== 派生数据 =====

const project_ = computed(() => project.current)
const shots = computed(() => project.current?.shots ?? [])
const script = computed(() => project.current?.script)
const settings = computed(() => project.current?.settings)
const timeline = computed(() => project.current?.timeline ?? [])

const imageShots = computed(() => shots.value.filter((s) => s.imageAssetId))
const videoShots = computed(() => shots.value.filter((s) => s.videoAssetId))
const allImages = computed(() =>
  imageShots.value.map((s) => ({
    shot: s,
    asset: assets.getMeta(s.imageAssetId!),
    url: imageUrls.value[s.id]
  }))
)
const allVideos = computed(() =>
  videoShots.value.map((s) => ({
    shot: s,
    asset: assets.getMeta(s.videoAssetId!),
    url: videoUrls.value[s.id]
  }))
)

const usedAssetIds = computed(() => {
  const ids = new Set<string>()
  for (const s of shots.value) {
    if (s.imageAssetId) ids.add(s.imageAssetId)
    if (s.videoAssetId) ids.add(s.videoAssetId)
    if (s.audioAssetId) ids.add(s.audioAssetId)
    for (const id of s.referenceAssetIds ?? []) ids.add(id)
    for (const id of s.imageHistoryIds ?? []) ids.add(id)
    for (const id of s.videoHistoryIds ?? []) ids.add(id)
    for (const id of s.audioHistoryIds ?? []) ids.add(id)
  }
  for (const id of script.value?.referenceAssetIds ?? []) ids.add(id)
  if (project.current?.bgmAssetId) ids.add(project.current.bgmAssetId)
  return ids
})

const libraryImages = computed(() => assets.all.filter((a) => a.kind === 'image'))
const libraryVideos = computed(() => assets.all.filter((a) => a.kind === 'video'))

const totalDuration = computed(() =>
  timeline.value
    .filter((c) => c.enabled)
    .reduce((s, c) => s + c.duration, 0)
    .toFixed(1)
)

const filledProgress = computed(() => {
  const total = shots.value.length
  if (total === 0) return { scripts: 0, images: 0, videos: 0, edits: 0, captions: 0 }
  return {
    scripts: 100,
    images: Math.round((imageShots.value.length / total) * 100),
    videos: Math.round((videoShots.value.length / total) * 100),
    edits: timeline.value.length > 0 ? 100 : 0,
    captions: timeline.value.length > 0 ? 100 : 0
  }
})

// ===== 操作 =====

function goTo(step: string) {
  router.push('/' + step)
}

async function downloadAsset(assetId: string, filename: string) {
  const blob = await assets.getBlob(assetId)
  if (!blob) {
    toast.error('下载失败：素材不存在')
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast.success('已下载')
}

async function deleteImage(shotId: string) {
  if (!project.current) return
  const shot = shots.value.find((s) => s.id === shotId)
  if (!shot || !shot.imageAssetId) return
  project.updateShot(shotId, { imageAssetId: undefined })
  delete imageUrls.value[shotId]
  toast.success('已从分镜移除，图片仍在资源库')
}

async function deleteVideo(shotId: string) {
  if (!project.current) return
  const shot = shots.value.find((s) => s.id === shotId)
  if (!shot || !shot.videoAssetId) return
  project.updateShot(shotId, { videoAssetId: undefined })
  delete videoUrls.value[shotId]
  toast.success('已从分镜移除，视频仍在资源库')
}

async function deleteLibraryAsset(id: string) {
  if (!confirm('从资源库永久删除该素材？使用它的分镜会取消关联。')) return
  for (const s of shots.value) {
    const patch: Record<string, unknown> = {}
    if (s.imageAssetId === id) patch.imageAssetId = undefined
    if (s.videoAssetId === id) patch.videoAssetId = undefined
    if (s.audioAssetId === id) patch.audioAssetId = undefined
    if (s.referenceAssetIds?.includes(id)) {
      patch.referenceAssetIds = s.referenceAssetIds.filter((x) => x !== id)
    }
    if (s.imageHistoryIds?.includes(id)) {
      patch.imageHistoryIds = s.imageHistoryIds.filter((x) => x !== id)
    }
    if (s.videoHistoryIds?.includes(id)) {
      patch.videoHistoryIds = s.videoHistoryIds.filter((x) => x !== id)
    }
    if (s.audioHistoryIds?.includes(id)) {
      patch.audioHistoryIds = s.audioHistoryIds.filter((x) => x !== id)
    }
    if (Object.keys(patch).length) project.updateShot(s.id, patch as any)
  }
  if (script.value?.referenceAssetIds?.includes(id) && project.current?.script) {
    project.setScript({
      ...project.current.script,
      referenceAssetIds: script.value.referenceAssetIds.filter((x) => x !== id)
    })
  }
  await assets.remove(id)
  await loadAssets()
  toast.success('已从资源库删除')
}

function previewImage(shotId: string) {
  const shot = shots.value.find((s) => s.id === shotId)
  if (!shot || !shot.imageAssetId) return
  const a = assets.getMeta(shot.imageAssetId)
  if (!a) return
  previewTitle.value = `${shot.title || a.filename}`
  previewAsset.value = {
    ...(a as any),
    url: imageUrls.value[shotId]
  }
}

function previewVideo(shotId: string) {
  const shot = shots.value.find((s) => s.id === shotId)
  if (!shot || !shot.videoAssetId) return
  const a = assets.getMeta(shot.videoAssetId)
  if (!a) return
  const url = videoUrls.value[shotId]
  if (!url) return
  previewTitle.value = `${shot.title || a.filename}`
  previewAsset.value = {
    ...(a as any),
    url
  }
}

function closePreview() {
  previewAsset.value = null
}

function fmtSize(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let b = bytes
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024
    i++
  }
  return `${b.toFixed(1)} ${units[i]}`
}

function fmtTime(ts: number) {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function assetContext(a: Asset) {
  const ctx = resolveAssetContext(a, project.allProjects, project.current)
  return {
    ...ctx,
    sub: [ctx.projectName, ctx.duration, fmtTime(a.createdAt)].filter(Boolean).join(' · ')
  }
}

async function playLibraryVideo(id: string, ev?: Event) {
  ev?.stopPropagation()
  if (playingId.value === id) {
    playingId.value = null
    return
  }
  if (!libraryPlayUrls.value[id]) {
    const url = await assets.getUrl(id)
    if (url) libraryPlayUrls.value = { ...libraryPlayUrls.value, [id]: url }
  }
  playingId.value = id
}

async function previewLibrary(id: string) {
  const a = assets.getMeta(id)
  if (!a) return
  const url = await assets.getUrl(id)
  if (!url) return
  const ctx = assetContext(a)
  previewTitle.value = `${ctx.title} · ${ctx.projectName}`
  previewAsset.value = { ...(a as any), url }
  if (a.kind === 'video') playingId.value = null
}

function copyText(text: string, label: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${label} 已复制`),
    () => toast.error('复制失败')
  )
}

function scriptSourceLabel(source: string) {
  return source === 'ai-generated' ? 'AI 生成' : source === 'imported' ? '导入' : '手建'
}

async function downloadScript(id: string) {
  const ok = await scripts.download(id)
  if (ok) toast.success('已导出 Markdown')
}

async function removeScript(id: string) {
  const doc = scripts.docs.find((d) => d.id === id)
  if (!doc) return
  if (!confirm(`从剧本库删除「${doc.title}」？本地 Markdown 文件也会一起删除。`)) return
  await scripts.remove(id)
  toast.success('已删除')
}

function downloadProjectJson() {
  if (!project.current) return
  const blob = new Blob([JSON.stringify(project.current, null, 2)], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${project.current.name}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast.success('项目 JSON 已下载')
}
</script>

<template>
  <div class="page" v-if="project_">
    <header class="page-head">
      <div>
        <h1>📦 资源库</h1>
        <p>每一步的图片、视频都会存下来。重新生成只换当前选用，旧文件仍在这里。</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/')">← 返回</GradientButton>
        <GradientButton type="secondary" icon="📥" @click="downloadProjectJson">
          导出项目 JSON
        </GradientButton>
      </div>
    </header>

    <!-- 项目元数据 -->
    <GlassCard padding="md" class="meta-card">
      <div class="meta-grid">
        <div>
          <div class="meta-label">项目名</div>
          <div class="meta-value">{{ project_.name }}</div>
        </div>
        <div>
          <div class="meta-label">比例</div>
          <div class="meta-value">
            {{ settings?.aspectRatio }}
            <span class="meta-dim">· {{ settings?.width }}×{{ settings?.height }}</span>
          </div>
        </div>
        <div>
          <div class="meta-label">风格</div>
          <div class="meta-value">{{ script?.style }}</div>
        </div>
        <div>
          <div class="meta-label">最后修改</div>
          <div class="meta-value">{{ fmtTime(project_.updatedAt) }}</div>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-segment" :style="{ width: filledProgress.images + '%' }" :title="`图片 ${filledProgress.images}%`" />
        <div class="progress-segment videos" :style="{ width: filledProgress.videos + '%' }" :title="`视频 ${filledProgress.videos}%`" />
      </div>
      <div class="progress-legend">
        <span><span class="dot dot-img" /> 图片 {{ imageShots.length }}/{{ shots.length }}</span>
        <span><span class="dot dot-vid" /> 视频 {{ videoShots.length }}/{{ shots.length }}</span>
        <span><span class="dot dot-tl" /> 时间线 {{ timeline.length }} 条</span>
      </div>
    </GlassCard>

    <!-- 资源库全部素材 -->
    <GlassCard padding="md" class="section-card">
      <div class="card-head">
        <h3>🖼 资源库图片（{{ libraryImages.length }}）</h3>
      </div>
      <div v-if="libraryImages.length === 0" class="empty-mini">还没有图片</div>
      <div v-else class="asset-grid">
        <div v-for="a in libraryImages" :key="a.id" class="asset-card">
          <div class="asset-thumb" @click="previewLibrary(a.id)">
            <img v-if="libraryUrls[a.id]" :src="libraryUrls[a.id]" :alt="a.filename" />
          </div>
          <div class="asset-meta">
            <div class="asset-title" :title="assetContext(a).title">{{ assetContext(a).title }}</div>
            <div class="asset-dim">{{ assetContext(a).sub }}</div>
            <div class="asset-dim">
              <Tag v-if="usedAssetIds.has(a.id)" type="success" size="sm">使用中</Tag>
              <Tag v-else size="sm">未选用</Tag>
              · {{ fmtSize(a.size) }}
            </div>
            <div class="asset-actions">
              <button class="link-btn" @click="downloadAsset(a.id, a.filename || 'image.png')">📥 下载</button>
              <button class="link-btn danger" @click="deleteLibraryAsset(a.id)">🗑 删除</button>
            </div>
          </div>
        </div>
      </div>
    </GlassCard>

    <GlassCard padding="md" class="section-card">
      <div class="card-head">
        <h3>🎥 资源库视频（{{ libraryVideos.length }}）</h3>
        <span v-if="thumbsLoading" class="meta-dim">正在生成封面…</span>
      </div>
      <div v-if="libraryVideos.length === 0" class="empty-mini">还没有视频</div>
      <div v-else class="asset-grid">
        <div v-for="a in libraryVideos" :key="a.id" class="asset-card">
          <div class="asset-thumb" @click="playLibraryVideo(a.id, $event)">
            <video
              v-if="playingId === a.id && libraryPlayUrls[a.id]"
              :src="libraryPlayUrls[a.id]"
              controls
              autoplay
              playsinline
              class="playing"
              @click.stop
            />
            <img
              v-else-if="libraryThumbs[a.id]"
              :src="libraryThumbs[a.id]"
              :alt="assetContext(a).title"
            />
            <div v-else class="thumb-ph">🎥</div>
            <div v-if="playingId !== a.id" class="play-badge">▶ 播放</div>
          </div>
          <div class="asset-meta">
            <div class="asset-title" :title="assetContext(a).title">{{ assetContext(a).title }}</div>
            <div class="asset-dim">{{ assetContext(a).sub }}</div>
            <div class="asset-dim">
              <Tag v-if="usedAssetIds.has(a.id)" type="success" size="sm">使用中</Tag>
              <Tag v-else size="sm">未选用</Tag>
              · {{ fmtSize(a.size) }}
            </div>
            <div class="asset-actions">
              <button class="link-btn" @click="previewLibrary(a.id)">放大预览</button>
              <button class="link-btn" @click="downloadAsset(a.id, a.filename || 'video.mp4')">📥 下载</button>
              <button class="link-btn danger" @click="deleteLibraryAsset(a.id)">🗑 删除</button>
            </div>
          </div>
        </div>
      </div>
    </GlassCard>

    <!-- 剧本库 -->
    <GlassCard padding="md" class="section-card">
      <div class="card-head">
        <h3>📜 剧本（{{ scripts.docs.length }}）</h3>
        <div class="head-tools">
          <button class="mini-btn" @click="router.push('/scripts')">管理剧本 →</button>
        </div>
      </div>
      <div v-if="!scripts.docs.length" class="empty-mini">
        还没有剧本。让 AI 写一篇，或去「剧本」页导入 Markdown。
      </div>
      <div v-else class="script-list">
        <div v-for="d in scripts.docs" :key="d.id" class="script-row">
          <div class="script-main">
            <div class="script-title">{{ d.title }}</div>
            <div class="script-sub">
              <Tag size="sm">{{ scriptSourceLabel(d.source) }}</Tag>
              {{ d.episodeCount }} 集 · {{ d.totalWords }} 字 · {{ fmtTime(d.updatedAt) }}
            </div>
          </div>
          <div class="script-acts">
            <button class="link-btn" @click="router.push('/scripts')">✎ 编辑</button>
            <button class="link-btn" @click="downloadScript(d.id)">📥 导出 MD</button>
            <button class="link-btn danger" @click="removeScript(d.id)">🗑 删除</button>
          </div>
        </div>
      </div>
    </GlassCard>

    <!-- Aesthetic -->
    <GlassCard v-if="script?.aesthetic" padding="md" class="section-card">
      <div class="card-head">
        <h3>🎨 整体氛围（项目级）</h3>
        <div class="head-tools">
          <button class="mini-btn" @click="copyText(script.aesthetic, '整体氛围')">📋 复制</button>
          <button class="mini-btn" @click="goTo('storyboard')">✎ 编辑</button>
        </div>
      </div>
      <pre class="aesthetic-text">{{ script.aesthetic }}</pre>
    </GlassCard>

    <!-- 文案 -->
    <GlassCard v-if="script" padding="md" class="section-card">
      <div class="card-head">
        <h3>📝 文案</h3>
        <div class="head-tools">
          <button class="mini-btn" @click="copyText(script.content, '文案')">📋 复制</button>
          <button class="mini-btn" @click="goTo('script')">✎ 编辑</button>
        </div>
      </div>
      <div class="kv-list">
        <div class="kv"><span>主题</span><b>{{ script.topic }}</b></div>
        <div class="kv"><span>风格</span><b>{{ script.style }}</b></div>
        <div class="kv"><span>关键词</span><b>{{ script.keywords?.join('、') || '—' }}</b></div>
        <div class="kv"><span>字数</span><b>{{ script.content.length }}</b></div>
      </div>
      <pre class="content-text">{{ script.content || '（无）' }}</pre>
    </GlassCard>

    <!-- 分镜列表 -->
    <GlassCard padding="md" class="section-card">
      <div class="card-head">
        <h3>🎬 分镜（{{ shots.length }} 个）</h3>
        <button class="mini-btn" @click="goTo('storyboard')">✎ 编辑分镜</button>
      </div>
      <div v-if="shots.length === 0" class="empty-mini">
        还没有分镜
      </div>
      <div v-else class="shot-list">
        <div
          v-for="(s, i) in shots"
          :key="s.id"
          class="shot-row"
        >
          <div class="shot-num">{{ i + 1 }}</div>
          <div class="shot-info">
            <div class="shot-title">{{ s.title }}</div>
            <div class="shot-prompt-mini">{{ s.visualPrompt.slice(0, 100) }}...</div>
          </div>
          <div class="shot-status">
            <Tag v-if="s.imageAssetId" type="info" size="sm">🖼</Tag>
            <Tag v-if="s.videoAssetId" type="success" size="sm">🎥</Tag>
            <Tag v-if="s.referenceAssetIds?.length" type="accent" size="sm">
              +{{ s.referenceAssetIds.length }} refs
            </Tag>
          </div>
          <div class="shot-dur">{{ s.duration }}s</div>
        </div>
      </div>
    </GlassCard>

    <!-- 图片网格 -->
    <GlassCard padding="md" class="section-card">
      <div class="card-head">
        <h3>🖼 已生成图片（{{ allImages.length }} 张）</h3>
        <button class="mini-btn" @click="goTo('images')">+ 添加 / 重新生成</button>
      </div>
      <div v-if="allImages.length === 0" class="empty-mini">
        还没有图片。
        <button class="link-btn" @click="goTo('images')">去生成 →</button>
      </div>
      <div v-else class="asset-grid">
        <div v-for="img in allImages" :key="img.shot.id" class="asset-card">
          <div class="asset-thumb" @click="previewImage(img.shot.id)">
            <img v-if="img.url" :src="img.url" :alt="img.shot.title" />
          </div>
          <div class="asset-meta">
            <div class="asset-title">#{{ img.shot.index + 1 }} {{ img.shot.title }}</div>
            <div class="asset-dim">
              <template v-if="img.asset && img.asset.kind === 'image'">
                {{ img.asset.width }}×{{ img.asset.height }}
              </template>
              · {{ fmtSize(img.asset?.size ?? 0) }}
            </div>
            <div class="asset-actions">
              <button class="link-btn" @click="downloadAsset(img.shot.imageAssetId!, `shot_${img.shot.index + 1}_image.png`)">📥 下载</button>
              <button class="link-btn danger" @click="deleteImage(img.shot.id)">🗑 删除</button>
            </div>
          </div>
        </div>
      </div>
    </GlassCard>

    <!-- 视频列表 -->
    <GlassCard padding="md" class="section-card">
      <div class="card-head">
        <h3>🎥 已生成视频（{{ allVideos.length }} 段）</h3>
        <button class="mini-btn" @click="goTo('videos')">+ 添加 / 重新生成</button>
      </div>
      <div v-if="allVideos.length === 0" class="empty-mini">
        还没有视频。
        <button class="link-btn" @click="goTo('videos')">去生成 →</button>
      </div>
      <div v-else class="asset-grid">
        <div v-for="v in allVideos" :key="v.shot.id" class="asset-card">
          <div class="asset-thumb" @click="previewVideo(v.shot.id)">
            <img
              v-if="v.shot.videoAssetId && libraryThumbs[v.shot.videoAssetId]"
              :src="libraryThumbs[v.shot.videoAssetId]"
              :alt="v.shot.title"
            />
            <video
              v-else-if="v.url"
              :src="v.url"
              muted
              playsinline
              preload="metadata"
            />
            <div v-else class="loading-mini">…</div>
            <div class="play-badge">▶ 预览</div>
          </div>
          <div class="asset-meta">
            <div class="asset-title">#{{ v.shot.index + 1 }} {{ v.shot.title }}</div>
            <div class="asset-dim">
              <template v-if="v.asset && v.asset.kind === 'video'">
                {{ v.asset.width }}×{{ v.asset.height }}
                · {{ v.asset.duration?.toFixed(1) }}s
              </template>
              · {{ fmtSize(v.asset?.size ?? 0) }}
            </div>
            <div class="asset-actions">
              <button class="link-btn" @click="downloadAsset(v.shot.videoAssetId!, `shot_${v.shot.index + 1}_video.mp4`)">📥 下载</button>
              <button class="link-btn danger" @click="deleteVideo(v.shot.id)">🗑 删除</button>
            </div>
          </div>
        </div>
      </div>
    </GlassCard>

    <!-- 时间线状态 -->
    <GlassCard padding="md" class="section-card">
      <div class="card-head">
        <h3>✂️ 时间线（{{ timeline.length }} 条 · 总时长 {{ totalDuration }}s）</h3>
        <button class="mini-btn" @click="goTo('edit')">编辑时间线 →</button>
      </div>
      <div v-if="timeline.length === 0" class="empty-mini">
        时间线是空的
      </div>
      <div v-else class="tl-summary">
        <Tag v-for="c in timeline.slice(0, 12)" :key="c.id" type="info" size="sm">
          {{ c.duration.toFixed(1) }}s
        </Tag>
        <span v-if="timeline.length > 12" class="more-mini">+ {{ timeline.length - 12 }} 更多</span>
      </div>
    </GlassCard>

    <!-- 字幕 -->
    <GlassCard padding="md" class="section-card">
      <div class="card-head">
        <h3>💬 字幕</h3>
        <button class="mini-btn" @click="goTo('caption')">编辑字幕 →</button>
      </div>
      <div class="caption-summary">
        <div v-for="(s, i) in shots" :key="s.id" class="caption-line">
          <span class="caption-num">{{ i + 1 }}</span>
          <span class="caption-text">{{ s.voiceover || '（无）' }}</span>
          <span class="caption-audio">{{ s.audioDescription || '' }}</span>
        </div>
      </div>
    </GlassCard>

    <!-- 预览弹窗 -->
    <transition name="fade">
      <div v-if="previewAsset" class="preview-mask" @click.self="closePreview">
        <div class="preview-modal">
          <button class="preview-close" @click="closePreview">×</button>
          <img
            v-if="previewAsset.kind === 'image' && previewAsset.url"
            :src="previewAsset.url"
            class="preview-img"
          />
          <video
            v-else-if="previewAsset.kind === 'video' && previewAsset.url"
            :src="previewAsset.url"
            controls
            autoplay
            playsinline
            class="preview-vid"
          />
          <div class="preview-meta">
            {{ previewTitle || previewAsset.filename }}
            <template v-if="previewAsset.kind === 'image'">
              · {{ previewAsset.width }}×{{ previewAsset.height }}
            </template>
            <template v-else-if="previewAsset.kind === 'video'">
              · {{ previewAsset.width }}×{{ previewAsset.height }}
              · {{ previewAsset.duration?.toFixed(1) }}s
            </template>
            · {{ fmtSize(previewAsset.size) }}
          </div>
        </div>
      </div>
    </transition>
  </div>

  <EmptyState
    v-else
    icon="📦"
    title="没有打开的项目"
    description="先创建一个项目"
  >
    <template #action>
      <GradientButton @click="router.push('/')">返回首页</GradientButton>
    </template>
  </EmptyState>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.page-head h1 {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 var(--space-1);
}
.page-head p {
  font-size: 13px;
  color: var(--color-text-3);
  margin: 0;
}
.head-actions {
  display: flex;
  gap: var(--space-2);
}

.meta-card {
  background: var(--grad-primary-soft);
}
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-4);
  margin-bottom: var(--space-3);
}
.meta-label {
  font-size: 11px;
  color: var(--color-text-3);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.meta-value {
  font-size: 14px;
  color: var(--color-text-1);
  font-weight: 600;
}
.meta-dim {
  color: var(--color-text-3);
  font-weight: 400;
  font-size: 12px;
  margin-left: 4px;
}
.progress-bar {
  display: flex;
  height: 8px;
  background: var(--color-fill);
  border-radius: var(--radius-full);
  overflow: hidden;
  margin-bottom: 6px;
}
.progress-segment {
  height: 100%;
  background: var(--color-info);
  transition: width 0.3s var(--ease-out);
}
.progress-segment.videos {
  background: var(--color-success);
}
.progress-legend {
  display: flex;
  gap: var(--space-3);
  font-size: 11px;
  color: var(--color-text-3);
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.dot-img { background: var(--color-info); }
.dot-vid { background: var(--color-success); }
.dot-tl { background: var(--color-warning); }

.section-card {
  /* default */
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
  gap: var(--space-2);
}
.card-head h3 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}
.head-tools {
  display: flex;
  gap: var(--space-2);
}
.mini-btn {
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: transparent;
  transition: all var(--duration-fast);
}
.mini-btn:hover {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
}
.link-btn {
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}
.link-btn:hover {
  background: var(--grad-primary-soft);
}
.link-btn.danger {
  color: var(--color-error);
}
.link-btn.danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

.aesthetic-text,
.content-text {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-2);
  white-space: pre-wrap;
  margin: 0;
  padding: var(--space-3);
  background: var(--color-bg-1);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  max-height: 240px;
  overflow-y: auto;
}
.kv-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.kv {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  padding: 4px 8px;
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
}
.kv span { color: var(--color-text-3); }
.kv b { color: var(--color-text-1); font-weight: 500; }

.script-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
}
.script-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 8px 10px;
  background: var(--color-bg-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
}
.script-row:hover {
  border-color: var(--color-border-strong);
}
.script-main {
  flex: 1;
  min-width: 0;
}
.script-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.script-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-3);
  margin-top: 2px;
}
.script-acts {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.shot-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 360px;
  overflow-y: auto;
}
.shot-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 6px 8px;
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.shot-num {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: var(--grad-primary);
  color: white;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.shot-info {
  flex: 1;
  min-width: 0;
}
.shot-title {
  font-weight: 600;
  margin-bottom: 2px;
}
.shot-prompt-mini {
  color: var(--color-text-3);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-status {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.shot-dur {
  color: var(--color-text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.empty-mini {
  text-align: center;
  color: var(--color-text-4);
  padding: var(--space-4);
  font-size: 12px;
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  border: 1px dashed var(--color-border);
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-3);
}
.asset-card {
  background: var(--color-bg-2);
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--color-border);
}
.asset-thumb img,
.asset-thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.asset-thumb video.playing {
  object-fit: contain;
  background: #000;
}
.thumb-ph {
  color: var(--color-text-4);
  font-size: 28px;
}
.play-badge {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.28);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  pointer-events: none;
}
.asset-thumb {
  aspect-ratio: 16/9;
  background: #111;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  position: relative;
}
.loading-mini {
  color: var(--color-text-4);
  font-size: 12px;
}
.asset-meta {
  padding: 8px 10px;
}
.asset-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.asset-dim {
  font-size: 10px;
  color: var(--color-text-3);
  margin-bottom: 4px;
}
.asset-actions {
  display: flex;
  gap: 4px;
}

.tl-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.more-mini {
  font-size: 11px;
  color: var(--color-text-3);
}

.caption-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
}
.caption-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.caption-num {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: var(--color-accent);
  color: white;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.caption-text {
  flex: 1;
  color: var(--color-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.caption-audio {
  font-size: 10px;
  color: var(--color-text-3);
  font-style: italic;
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(8px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-modal {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
}
.preview-close {
  position: absolute;
  top: -36px;
  right: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: white;
  font-size: 20px;
}
.preview-close:hover {
  background: rgba(255, 255, 255, 0.2);
}
.preview-img,
.preview-vid {
  max-width: 90vw;
  max-height: 80vh;
  border-radius: var(--radius-md);
}
.preview-meta {
  text-align: center;
  color: var(--color-text-3);
  font-size: 11px;
  margin-top: var(--space-2);
}
</style>
