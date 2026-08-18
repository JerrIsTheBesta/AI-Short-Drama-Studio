<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import { isDesktop, desktop } from '@/services/desktop'
import { projectCoverUrl } from '@/services/storage'
import { runVideoRemake } from '@/services/canvas/runner'
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
const pipelineMode = ref<'standard' | 'remake'>('standard')
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

onMounted(async () => {
  await project.refreshList()
})

watch(
  () => project.allProjects.map((p) => p.id).join(','),
  async () => {
    const next: Record<string, string> = { ...covers.value }
    for (const p of project.allProjects) {
      if (next[p.id]) continue
      try {
        const url = await projectCoverUrl(p)
        if (url) next[p.id] = url
      } catch {
        /* 某个项目素材读失败就跳过 */
      }
    }
    covers.value = next
  },
  { immediate: true }
)

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
    router.push('/studio')
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

function onPickRemakeVideo(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (!file.type.startsWith('video/')) {
    toast.warn('请上传视频文件')
    return
  }
  if (remakeVideoUrl.value) URL.revokeObjectURL(remakeVideoUrl.value)
  remakeVideo.value = file
  remakeVideoUrl.value = URL.createObjectURL(file)
}

function onPickRemakeProducts(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'))
  input.value = ''
  const room = MAX_REMAKE_PRODUCTS - remakeProducts.value.length
  const take = files.slice(0, Math.max(0, room))
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
  let createdId = ''
  try {
    const p = await project.createNamed(newName.value.trim())
    createdId = p.id
    const preset = aspectPresets.find((a) => a.value === newAspectRatio.value)!
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
    p.settings.aspectRatio = newAspectRatio.value
    p.settings.width = preset.w
    p.settings.height = preset.h
    project.setScript(p.script)
    project.setSettings(p.settings)
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
    router.push('/studio')
  } catch (e: any) {
    toast.error(e?.message || '创建失败，素材已保存，可进画布重试')
    showCreateModal.value = false
    resetCreateForm()
    if (createdId && project.current?.id === createdId) router.push('/studio')
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
</script>

<template>
  <div class="home">
    <div class="hero">
      <div class="hero-bg" />
      <div class="hero-content">
        <div class="brand">
          <span class="brand-mark">▶</span>
          <span class="brand-name">剧流 Studio</span>
        </div>
        <h1 class="title">
          一句话，<span class="gradient-text">一条 AI 流水线</span>，<br />
          输出一条成片
        </h1>
        <p class="subtitle">
          桌面端无限画布 + 智能体：人设、分镜、配图、视频都在一张图上连起来。资源存在本地文件夹。
        </p>
        <div class="hero-actions">
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
            <div class="stat-label">成片总时长</div>
          </div>
        </div>
      </div>
    </div>

    <div class="container">
      <div class="section-header">
        <h2>我的项目</h2>
        <div class="filter">
          <input
            v-model="search"
            class="search"
            placeholder="🔍 搜索项目..."
          />
        </div>
      </div>

      <EmptyState
        v-if="filteredProjects.length === 0"
        icon="🎬"
        title="还没有项目"
        description="点击「创建新项目」开始你的第一条成片"
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
                  ? '上传参考成片和产品图，AI 会按镜头复刻脚本；配音后期合成，成片视频不出口播。'
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
                  :class="{ active: pipelineMode === 'remake' }"
                  @click="pipelineMode = 'remake'"
                >
                  <div class="mode-title">视频复刻</div>
                  <div class="mode-desc">按参考视频镜头换上你的产品</div>
                </button>
              </div>
            </label>

            <label class="field">
              <span>项目名</span>
              <input v-model="newName" placeholder="例如：夏日旅行 vlog" class="input" />
            </label>

            <label class="field">
              <span>主题（可选）</span>
              <input v-model="newTopic" placeholder="一句话描述视频主题" class="input" />
            </label>

            <template v-if="pipelineMode === 'remake'">
              <div class="field">
                <span>参考视频（必传 1 条）</span>
                <div v-if="remakeVideo" class="video-preview">
                  <video :src="remakeVideoUrl" controls muted playsinline />
                  <div class="file-name">{{ remakeVideo.name }}</div>
                  <label class="replace-video">
                    更换视频
                    <input class="file-hidden" type="file" accept="video/*" @change="onPickRemakeVideo" />
                  </label>
                </div>
                <label v-else class="video-add">
                  ＋ 上传参考成片
                  <input class="file-hidden" type="file" accept="video/*" @change="onPickRemakeVideo" />
                </label>
                <p class="upload-hint">支持 mp4 / mov 等常见成片，会抽帧理解镜头语言。</p>
              </div>

              <div class="field">
                <span>产品图（必传，可多张，最多 {{ MAX_REMAKE_PRODUCTS }} 张）</span>
                <p class="field-hint">复刻镜头里的商品都会换成这些图。作图走 APIYI GPT。</p>
                <div class="product-row">
                  <div
                    v-for="(url, i) in remakeProductUrls"
                    :key="url"
                    class="product-thumb"
                  >
                    <img :src="url" alt="产品图" />
                    <button class="product-del" type="button" @click="removeRemakeProduct(i)">×</button>
                  </div>
                  <label
                    v-if="remakeProducts.length < MAX_REMAKE_PRODUCTS"
                    class="product-add"
                  >
                    ＋ 上传产品图
                    <input
                      class="file-hidden"
                      type="file"
                      accept="image/*"
                      multiple
                      @change="onPickRemakeProducts"
                    />
                  </label>
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
              {{ pipelineMode === 'remake' ? '创建并分析视频' : '创建并开始' }}
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
  background:
    radial-gradient(ellipse at 20% 0%, rgba(124, 58, 237, 0.4) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 100%, rgba(236, 72, 153, 0.3) 0%, transparent 50%),
    radial-gradient(ellipse at 50% 50%, rgba(245, 158, 11, 0.2) 0%, transparent 70%);
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--grad-primary);
  color: white;
  font-size: 16px;
  box-shadow: 0 0 24px rgba(124, 58, 237, 0.6);
}
.brand-name {
  font-size: 20px;
  font-weight: 700;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
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
.proj-thumb-grad[data-style='cinematic'] {
  background: linear-gradient(135deg, #1e293b 0%, #7c3aed 50%, #ec4899 100%);
}
.proj-thumb-grad[data-style='anime'] {
  background: linear-gradient(135deg, #fce7f3 0%, #fbcfe8 50%, #c084fc 100%);
}
.proj-thumb-grad[data-style='photorealistic'] {
  background: linear-gradient(135deg, #0f172a 0%, #1e40af 50%, #0891b2 100%);
}
.proj-thumb-grad[data-style='3d-render'] {
  background: linear-gradient(135deg, #fbbf24 0%, #ec4899 50%, #7c3aed 100%);
}
.proj-thumb-grad[data-style='oil-painting'] {
  background: linear-gradient(135deg, #92400e 0%, #d97706 50%, #fde68a 100%);
}
.proj-thumb-grad[data-style='watercolor'] {
  background: linear-gradient(135deg, #dbeafe 0%, #a7f3d0 50%, #fde68a 100%);
}
.proj-thumb-grad[data-style='pixel-art'] {
  background: linear-gradient(135deg, #f97316 0%, #84cc16 50%, #06b6d4 100%);
}
.proj-thumb-grad[data-style='ink-wash'] {
  background: linear-gradient(135deg, #1f2937 0%, #4b5563 50%, #d1d5db 100%);
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
  max-width: 460px;
  max-height: 88vh;
  overflow-y: auto;
}
.modal.remake {
  max-width: 560px;
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
  background: rgba(255, 255, 255, 0.04);
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
</style>
