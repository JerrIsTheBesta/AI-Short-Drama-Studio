<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useSettingsStore, useAssetsStore, useToastStore } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import Tag from '@/components/common/Tag.vue'
import StudioSettings from '@/components/canvas/StudioSettings.vue'
import { estimateStorage } from '@/services/storage'
import { isFFmpegReady, getFFmpeg, resetFFmpeg } from '@/services/ffmpeg'

const router = useRouter()
const project = useProjectStore()
const settings = useSettingsStore()
const assets = useAssetsStore()
const toast = useToastStore()

const storage = ref<{ usage: number; quota: number }>({ usage: 0, quota: 0 })
const ffmpegReady = ref(isFFmpegReady())
const ffmpegLoading = ref(false)

const diag = ref({
  crossOriginIsolated: false,
  sharedArrayBuffer: false,
  userAgent: '',
  localCore: false,
  jsDelivrReachable: false,
  unpkgReachable: false,
  npmmirrorReachable: false
})

onMounted(async () => {
  storage.value = await estimateStorage()
  await assets.refresh()
  await runDiagnostics()
})

async function runDiagnostics() {
  diag.value.userAgent = navigator.userAgent
  diag.value.crossOriginIsolated = self.crossOriginIsolated
  diag.value.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'

  // 探测本地
  try {
    const r = await fetch('/ffmpeg/ffmpeg-core.js', { method: 'HEAD' })
    diag.value.localCore = r.ok
  } catch {
    diag.value.localCore = false
  }

  // 探测 CDN
  diag.value.jsDelivrReachable = await ping('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js')
  diag.value.unpkgReachable = await ping('https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js')
  diag.value.npmmirrorReachable = await ping('https://registry.npmmirror.com/@ffmpeg/core@0.12.6/files/dist/umd/ffmpeg-core.js')
}

async function ping(url: string): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 5000)
    const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctl.signal })
    clearTimeout(timer)
    try { await r.body?.cancel() } catch {}
    return r.ok || r.status === 206
  } catch {
    return false
  }
}

async function warmupFFmpeg() {
  ffmpegLoading.value = true
  try {
    await getFFmpeg((msg) => toast.info(msg, 1500))
    ffmpegReady.value = true
    toast.success('FFmpeg 已就绪')
    await runDiagnostics()
  } catch (e: any) {
    toast.error('FFmpeg 加载失败：' + e.message, 8000)
  } finally {
    ffmpegLoading.value = false
  }
}

function resetAndRetry() {
  resetFFmpeg()
  ffmpegReady.value = false
  toast.info('已重置，请重新点击「预加载」')
  runDiagnostics()
}

async function exportProjectData() {
  const data = {
    version: '0.1.0',
    exportedAt: Date.now(),
    projects: project.allProjects,
    settings: settings.config
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `ai-cut-export-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast.success('已导出项目数据')
}

function importProjectData() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      if (Array.isArray(data.projects)) {
        for (const p of data.projects) {
          // @ts-ignore
          await import('@/services/storage').then((m) => m.saveProject(p))
        }
        await project.refreshList()
        toast.success(`已导入 ${data.projects.length} 个项目`)
      } else {
        toast.error('文件格式不对')
      }
    } catch (e: any) {
      toast.error('导入失败：' + e.message)
    }
  }
  input.click()
}

async function clearAll() {
  if (!confirm('确定要清空所有项目数据吗？素材也会被一起删除，无法恢复！')) return
  for (const p of project.allProjects) {
    await project.remove(p.id)
  }
  toast.success('已清空')
}

function formatSize(bytes: number) {
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

const assetStats = computed(() => {
  const stats = { image: 0, video: 0, audio: 0, total: 0 }
  for (const a of assets.all) {
    if (a.kind === 'image') stats.image++
    if (a.kind === 'video') stats.video++
    if (a.kind === 'audio') stats.audio++
    stats.total++
  }
  return stats
})

const storagePct = computed(() => {
  if (!storage.value.quota) return 0
  return (storage.value.usage / storage.value.quota) * 100
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>⚙ 设置</h1>
        <p>管理 AI 能力、素材库、引擎状态</p>
      </div>
      <GradientButton type="ghost" @click="router.back()">← 返回</GradientButton>
    </header>

    <div class="grid">
      <GlassCard padding="lg">
        <h2>🤖 AI 能力配置</h2>
        <p class="card-desc">主智能体使用 DeepSeek；Qwen 仅用于看图和多模态质量验收。配置改完立即生效。</p>
        <StudioSettings />
      </GlassCard>

      <GlassCard padding="lg">
        <h2>🔧 引擎状态</h2>
        <p class="card-desc">FFmpeg 在浏览器里跑，首次使用时会下载约 30MB 核心</p>

        <div class="engine-row">
          <div>
            <div class="engine-name">FFmpeg.wasm</div>
            <div class="engine-state">
              <Tag v-if="ffmpegReady" type="success" size="sm">已就绪</Tag>
              <Tag v-else type="warning" size="sm">未加载</Tag>
            </div>
          </div>
          <GradientButton
            v-if="!ffmpegReady"
            type="secondary"
            size="sm"
            icon="📦"
            :loading="ffmpegLoading"
            @click="warmupFFmpeg"
          >
            预加载
          </GradientButton>
          <Tag v-else type="success" size="sm">✓</Tag>
        </div>

        <div class="engine-info">
          <p>
            FFmpeg 用于视频拼接、转场、字幕烧录、最终导出。<br />
            推荐首次进入「剪辑」或「导出」页面时让它预加载。
          </p>
        </div>

        <details class="diag-details">
          <summary>🔍 诊断信息（点击展开）</summary>
          <div class="diag-grid">
            <div class="diag-row">
              <span>cross-origin isolation</span>
              <Tag :type="diag.crossOriginIsolated ? 'success' : 'error'" size="sm">
                {{ diag.crossOriginIsolated ? '✓ 启用' : '✗ 未启用' }}
              </Tag>
            </div>
            <div class="diag-row">
              <span>SharedArrayBuffer</span>
              <Tag :type="diag.sharedArrayBuffer ? 'success' : 'error'" size="sm">
                {{ diag.sharedArrayBuffer ? '✓ 支持' : '✗ 不支持' }}
              </Tag>
            </div>
            <div class="diag-row">
              <span>本地 core 文件</span>
              <Tag :type="diag.localCore ? 'success' : 'warning'" size="sm">
                {{ diag.localCore ? '✓ 存在' : '✗ 缺失' }}
              </Tag>
            </div>
            <div class="diag-row">
              <span>jsDelivr CDN</span>
              <Tag :type="diag.jsDelivrReachable ? 'success' : 'error'" size="sm">
                {{ diag.jsDelivrReachable ? '✓ 可达' : '✗ 不可达' }}
              </Tag>
            </div>
            <div class="diag-row">
              <span>unpkg CDN</span>
              <Tag :type="diag.unpkgReachable ? 'success' : 'error'" size="sm">
                {{ diag.unpkgReachable ? '✓ 可达' : '✗ 不可达' }}
              </Tag>
            </div>
            <div class="diag-row">
              <span>npmmirror 国内镜像</span>
              <Tag :type="diag.npmmirrorReachable ? 'success' : 'error'" size="sm">
                {{ diag.npmmirrorReachable ? '✓ 可达' : '✗ 不可达' }}
              </Tag>
            </div>
          </div>
          <div class="diag-tip">
            💡 <b>加载失败最常见原因</b>：CDN 资源没带 <code>Cross-Origin-Resource-Policy</code> 头，
            被 COEP 策略拦了。<br />
            解决：把 core 文件下载到 <code>public/ffmpeg/</code>（已下好），用本地源。
          </div>
          <button class="refresh-diag" @click="runDiagnostics">↻ 重新检测</button>
        </details>
      </GlassCard>

      <GlassCard padding="lg">
        <h2>💾 存储</h2>
        <p class="card-desc">项目、素材都存在浏览器 IndexedDB</p>

        <div class="storage-bar">
          <div class="storage-bar-fill" :style="{ width: storagePct + '%' }" />
        </div>
        <div class="storage-info">
          <span>已用 {{ formatSize(storage.usage) }} / 配额 {{ formatSize(storage.quota) }}</span>
          <span>{{ storagePct.toFixed(1) }}%</span>
        </div>

        <div class="storage-stats">
          <div class="ss-item">
            <div class="ss-num">{{ assetStats.image }}</div>
            <div class="ss-label">图片</div>
          </div>
          <div class="ss-item">
            <div class="ss-num">{{ assetStats.video }}</div>
            <div class="ss-label">视频</div>
          </div>
          <div class="ss-item">
            <div class="ss-num">{{ assetStats.audio }}</div>
            <div class="ss-label">音频</div>
          </div>
          <div class="ss-item">
            <div class="ss-num">{{ assetStats.total }}</div>
            <div class="ss-label">总数</div>
          </div>
        </div>
      </GlassCard>

      <GlassCard padding="lg">
        <h2>📦 项目管理</h2>
        <p class="card-desc">导出 / 导入 / 清理</p>

        <div class="proj-actions">
          <GradientButton
            type="secondary"
            icon="📤"
            block
            @click="exportProjectData"
          >导出所有项目数据（JSON）</GradientButton>
          <GradientButton
            type="secondary"
            icon="📥"
            block
            @click="importProjectData"
          >导入项目数据</GradientButton>
          <GradientButton
            type="danger"
            icon="🗑"
            block
            @click="clearAll"
          >清空所有数据</GradientButton>
        </div>
      </GlassCard>

      <GlassCard padding="lg">
        <h2>ℹ 关于</h2>
        <p class="card-desc">剧流 Studio · 从剧本到成片</p>
        <div class="about">
          <div class="about-row">
            <span>版本</span><b>v0.1.0</b>
          </div>
          <div class="about-row">
            <span>前端</span><b>Vue 3 + Vite + TypeScript</b>
          </div>
          <div class="about-row">
            <span>视频引擎</span><b>FFmpeg.wasm 0.12</b>
          </div>
          <div class="about-row">
            <span>存储</span><b>IndexedDB</b>
          </div>
        </div>
      </GlassCard>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  max-width: 1100px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-5);
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
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: var(--space-4);
}
h2 {
  font-size: 16px;
  font-weight: 700;
  margin: 0 0 var(--space-1);
}
.card-desc {
  font-size: 12px;
  color: var(--color-text-3);
  margin: 0 0 var(--space-4);
}
.ai-mode-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-3);
}
.ai-mode-row > span {
  font-size: 13px;
  color: var(--color-text-2);
  font-weight: 500;
}
.mode-toggle {
  display: flex;
  background: var(--color-bg-2);
  border-radius: var(--radius-md);
  padding: 2px;
  border: 1px solid var(--color-border);
}
.mode-toggle button {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--color-text-3);
  border-radius: var(--radius-sm);
  font-weight: 500;
  transition: all var(--duration-fast);
}
.mode-toggle button:hover {
  color: var(--color-text-1);
}
.mode-toggle button.active {
  background: var(--grad-primary);
  color: white;
}
.env-config {
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}
.env-hint {
  font-size: 12px;
  color: var(--color-text-2);
  line-height: 1.6;
  margin: 0 0 var(--space-2);
}
.env-hint code,
.env-hint pre code {
  background: var(--color-bg-1);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-accent-2);
}
.env-block {
  display: block;
  background: var(--color-bg-1) !important;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: var(--space-3) !important;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-1);
  white-space: pre-wrap;
  margin: var(--space-2) 0 !important;
  line-height: 1.6;
  overflow-x: auto;
}
.mock-mode ul {
  margin: var(--space-2) 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--color-text-2);
  line-height: 1.7;
}

.engine-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3);
  background: var(--color-bg-2);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-3);
}
.engine-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}
.engine-info {
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.6;
}

.engine-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.link-btn {
  font-size: 12px;
  color: var(--color-text-3);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.link-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text-1);
}

.diag-details {
  margin-top: var(--space-3);
  background: var(--color-bg-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  overflow: hidden;
}
.diag-details summary {
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-2);
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.diag-details summary::-webkit-details-marker {
  display: none;
}
.diag-details summary::before {
  content: '▶';
  display: inline-block;
  margin-right: 6px;
  font-size: 9px;
  transition: transform var(--duration-fast);
}
.diag-details[open] summary::before {
  transform: rotate(90deg);
}
.diag-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 12px 8px;
}
.diag-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: var(--color-text-3);
  padding: 4px 0;
}
.diag-tip {
  font-size: 11px;
  color: var(--color-text-2);
  line-height: 1.7;
  padding: 0 12px 8px;
}
.diag-tip code {
  background: var(--color-bg-1);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-accent-2);
}
.refresh-diag {
  margin: 0 12px 12px;
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.refresh-diag:hover {
  background: var(--grad-primary-soft);
}

.storage-bar {
  height: 8px;
  background: var(--color-bg-2);
  border-radius: var(--radius-full);
  overflow: hidden;
  margin-bottom: var(--space-2);
}
.storage-bar-fill {
  height: 100%;
  background: var(--grad-primary);
  transition: width 0.3s var(--ease-out);
}
.storage-info {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--color-text-3);
  margin-bottom: var(--space-3);
}
.storage-stats {
  display: flex;
  gap: var(--space-3);
}
.ss-item {
  flex: 1;
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  padding: 10px;
  text-align: center;
}
.ss-num {
  font-size: 20px;
  font-weight: 700;
  background: var(--grad-primary);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 2px;
}
.ss-label {
  font-size: 11px;
  color: var(--color-text-3);
}

.proj-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.about {
  font-size: 12px;
}
.about-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-3);
}
.about-row:last-child {
  border-bottom: none;
}
.about-row b {
  color: var(--color-text-1);
  font-weight: 600;
}
</style>
