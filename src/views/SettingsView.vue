<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useProjectStore, useSettingsStore, useAssetsStore, useToastStore, endpointReady } from '@/stores'
import StudioSettings from '@/components/canvas/StudioSettings.vue'
import SetupAgent from '@/components/settings/SetupAgent.vue'
import ZealmanSettings from '@/components/settings/ZealmanSettings.vue'
import Tag from '@/components/common/Tag.vue'
import { estimateStorage } from '@/services/storage'
import { isFFmpegReady, getFFmpeg, resetFFmpeg } from '@/services/ffmpeg'
import { desktop, isDesktop } from '@/services/desktop'

const router = useRouter()
const route = useRoute()
const project = useProjectStore()
const settings = useSettingsStore()
const assets = useAssetsStore()
const toast = useToastStore()

const storage = ref<{ usage: number; quota: number }>({ usage: 0, quota: 0 })
const ffmpegReady = ref(isFFmpegReady())
const ffmpegLoading = ref(false)
const grantingAccess = ref(false)
const storageRoot = ref('')
const changingStorageRoot = ref(false)
const appVersion = ref('0.1.5')

const diag = ref({
  crossOriginIsolated: false,
  sharedArrayBuffer: false,
  userAgent: '',
  localCore: false,
  jsDelivrReachable: false,
  unpkgReachable: false,
  npmmirrorReachable: false
})

const saving = ref(false)

const llmReady = computed(() => endpointReady(settings.config.llm))
const assistantTargetsReady = computed(() =>
  ['vision', 'image', 'video'].every((kind) =>
    endpointReady(settings.config[kind as 'vision' | 'image' | 'video'])
  )
)

onMounted(async () => {
  await settings.ensureHydrated()
  storage.value = await estimateStorage()
  await assets.refresh()
  if (isDesktop()) {
    try {
      storageRoot.value = await desktop().getRoot()
      appVersion.value = await desktop().getVersion()
    } catch {
      /* desktop info is non-critical */
    }
  }
  await runDiagnostics()
})

async function saveSettings() {
  if (saving.value) return
  saving.value = true
  try {
    await settings.flush()
    toast.success('配置已保存到本机')
    if (section.value === 'llm' && endpointReady(settings.config.llm)) {
      const needsAssistant = !['vision', 'image', 'video'].every((kind) =>
        endpointReady(settings.config[kind as 'vision' | 'image' | 'video'])
      )
      if (needsAssistant) {
        toast.success('第 1 步完成，接下来让接入助手配置其他模型')
        await router.replace('/settings/agent')
      }
    }
  } catch (e: any) {
    toast.error(e?.message || '保存失败，请再试一次')
  } finally {
    saving.value = false
  }
}

async function openSettingsFolder() {
  if (!isDesktop()) return
  try {
    const root = await desktop().getRoot()
    await desktop().openPath(root)
  } catch {
    toast.error('打不开配置目录')
  }
}

async function chooseStorageFolder() {
  if (!isDesktop() || changingStorageRoot.value) return
  try {
    const selected = await desktop().pickDirectory()
    if (!selected || selected === storageRoot.value) return
    const ok = confirm(
      `要把项目、素材和配置迁移到这里吗？\n\n${selected}\n\n现有资料会复制到新目录，完成后应用将自动刷新。`
    )
    if (!ok) return
    changingStorageRoot.value = true
    toast.info('正在迁移项目与素材，请不要关闭应用…', 10000)
    storageRoot.value = await desktop().setRoot(selected)
    toast.success('保存位置已修改，正在重新载入…')
    setTimeout(() => window.location.reload(), 700)
  } catch (err: any) {
    toast.error(err?.message || '修改保存位置失败', 8000)
  } finally {
    changingStorageRoot.value = false
  }
}

async function grantFileAccess() {
  if (!isDesktop()) return
  grantingAccess.value = true
  try {
    await desktop().requestFileAccess()
    toast.success('已授权。请完全退出后重新打开「剧流 Studio」，再试上传参考图。')
  } catch (err: any) {
    toast.error(err?.message || '授权未完成。可用 360 / 火绒把本程序加到信任区。')
  } finally {
    grantingAccess.value = false
  }
}

async function openWindowsSecurity() {
  if (!isDesktop()) return
  try {
    await desktop().openWindowsSecurity()
  } catch {
    toast.error('打不开 Windows 安全中心')
  }
}

async function runDiagnostics() {
  diag.value.userAgent = navigator.userAgent
  diag.value.crossOriginIsolated = self.crossOriginIsolated
  diag.value.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'
  try {
    const r = await fetch('/ffmpeg/ffmpeg-core.js', { method: 'HEAD' })
    diag.value.localCore = r.ok
  } catch {
    diag.value.localCore = false
  }
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

type SettingsSection = 'agent' | 'llm' | 'vision' | 'image' | 'tts' | 'video' | 'zealman' | 'system'
const SECTIONS: SettingsSection[] = ['agent', 'llm', 'vision', 'image', 'tts', 'video', 'zealman', 'system']

const nav = [
  { id: 'llm' as const, label: '语言模型', desc: '剧本、智能体、接入助手' },
  { id: 'agent' as const, label: '接入助手', desc: '用语言模型配置其余能力' },
  { id: 'vision' as const, label: '视觉理解', desc: '看图与质检' },
  { id: 'image' as const, label: '图像生成', desc: '人设、场景、看板' },
  { id: 'tts' as const, label: '配音', desc: '后期口播 TTS' },
  { id: 'video' as const, label: '视频', desc: '图生视频' },
  { id: 'zealman' as const, label: 'Zealman 镜像', desc: '内置工作流镜像接口' },
  { id: 'system' as const, label: '系统', desc: '引擎、存储、关于' }
]

const section = computed<SettingsSection>(() => {
  const fallback: SettingsSection = llmReady.value ? 'agent' : 'llm'
  const raw = String(route.params.section || fallback)
  return SECTIONS.includes(raw as SettingsSection) ? (raw as SettingsSection) : fallback
})

const currentNav = computed(() => nav.find((n) => n.id === section.value) || nav[0])

function go(id: SettingsSection) {
  router.replace(`/settings/${id}`)
}

function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

function navReady(id: SettingsSection) {
  const c = settings.config
  if (id === 'llm') return endpointReady(c.llm)
  if (id === 'vision') return endpointReady(c.vision)
  if (id === 'image') return endpointReady(c.image)
  if (id === 'tts') return endpointReady(c.tts)
  if (id === 'video') return endpointReady(c.video)
  if (id === 'zealman') return c.videos.some((item) => item.provider === 'zealman' && Boolean(item.baseUrl))
  return false
}
</script>

<template>
  <div class="settings">
    <header class="top">
      <button type="button" class="back" @click="goBack">返回</button>
      <div class="brand">
        <div>
          <h1>设置</h1>
          <p>{{ currentNav.desc }}。改完点右下角「保存」，写入本机文件，重启也不会丢。</p>
        </div>
      </div>
    </header>

    <div class="body">
      <nav class="side" aria-label="设置分区">
        <p class="group">配置</p>
        <RouterLink
          v-for="item in nav.slice(0, 7)"
          :key="item.id"
          :to="`/settings/${item.id}`"
          replace
          active-class=""
          exact-active-class=""
          :class="{ on: section === item.id }"
        >
          <span class="lab">{{ item.label }}</span>
          <i v-if="item.id !== 'agent'" class="dot" :class="{ on: navReady(item.id) }" />
        </RouterLink>
        <p class="group">应用</p>
        <RouterLink
          to="/settings/system"
          replace
          active-class=""
          exact-active-class=""
          :class="{ on: section === 'system' }"
        >
          <span class="lab">系统</span>
        </RouterLink>
      </nav>

      <main class="main">
        <section
          v-if="(section === 'llm' || section === 'agent') && !(section === 'agent' && assistantTargetsReady)"
          class="onboarding"
        >
          <div class="onboarding-head">
            <div>
              <b>开始使用前，按这两步完成 AI 配置</b>
              <p>先让语言模型可用，再由接入助手帮你配置视觉、生图、视频和配音。</p>
            </div>
            <span v-if="assistantTargetsReady" class="onboarding-done">基础能力已就绪</span>
          </div>
          <div class="onboarding-steps">
            <button
              type="button"
              class="onboarding-step"
              :class="{ active: section === 'llm', done: llmReady }"
              @click="go('llm')"
            >
              <i>{{ llmReady ? '✓' : '1' }}</i>
              <span>
                <b>配置语言模型</b>
                <small>填写接口地址、API Key 和模型名，然后点击保存</small>
              </span>
            </button>
            <div class="onboarding-arrow">→</div>
            <button
              type="button"
              class="onboarding-step"
              :class="{ active: section === 'agent', locked: !llmReady, done: assistantTargetsReady }"
              :disabled="!llmReady"
              @click="go('agent')"
            >
              <i>{{ assistantTargetsReady ? '✓' : '2' }}</i>
              <span>
                <b>让接入助手配置其他模型</b>
                <small>{{ llmReady ? '按提示配置视觉、生图、视频和配音' : '完成第 1 步后解锁' }}</small>
              </span>
            </button>
          </div>
        </section>

        <SetupAgent v-show="section === 'agent'" @open="go($event as SettingsSection)" />
        <ZealmanSettings v-if="settings.diskReady && section === 'zealman'" />
        <StudioSettings
          v-if="settings.diskReady && section !== 'agent' && section !== 'zealman' && section !== 'system'"
          :module="section"
        />
        <p v-else-if="!settings.diskReady && section !== 'agent' && section !== 'system'" class="loading">
          正在读取本机配置…
        </p>

        <div v-else-if="section === 'system'" class="sys">
          <section v-if="isDesktop()" class="panel">
            <h2>本机文件权限</h2>
            <p class="card-desc">
              上传参考图走系统文件框，由主进程复制进当前保存目录，不再经过浏览器沙箱。
            </p>
            <p class="muted">
              若仍被拦截，点「授权访问本机文件」。会弹出 Windows 账户控制，允许后把本程序和素材目录加入安全中心排除项。360 / 火绒请把「剧流 Studio」加到信任区。
            </p>
            <div class="proj">
              <button type="button" class="mini" :disabled="grantingAccess" @click="grantFileAccess">
                {{ grantingAccess ? '等待系统授权…' : '授权访问本机文件' }}
              </button>
              <button type="button" class="mini" @click="openWindowsSecurity">打开 Windows 安全中心</button>
            </div>
          </section>

          <section class="panel">
            <h2>引擎状态</h2>
            <p class="card-desc">FFmpeg 在浏览器里跑，首次使用时会下载约 30MB 核心</p>
            <div class="engine-row">
              <div>
                <div class="engine-name">FFmpeg.wasm</div>
                <Tag v-if="ffmpegReady" type="success" size="sm">已就绪</Tag>
                <Tag v-else type="warning" size="sm">未加载</Tag>
              </div>
              <button
                v-if="!ffmpegReady"
                type="button"
                class="mini"
                :disabled="ffmpegLoading"
                @click="warmupFFmpeg"
              >
                {{ ffmpegLoading ? '加载中…' : '预加载' }}
              </button>
              <button v-else type="button" class="link" @click="resetAndRetry">重置</button>
            </div>
            <p class="muted">用于视频拼接、转场、字幕烧录、最终导出。</p>
            <details class="diag">
              <summary>诊断信息</summary>
              <div class="diag-row"><span>cross-origin isolation</span><Tag :type="diag.crossOriginIsolated ? 'success' : 'error'" size="sm">{{ diag.crossOriginIsolated ? '启用' : '未启用' }}</Tag></div>
              <div class="diag-row"><span>SharedArrayBuffer</span><Tag :type="diag.sharedArrayBuffer ? 'success' : 'error'" size="sm">{{ diag.sharedArrayBuffer ? '支持' : '不支持' }}</Tag></div>
              <div class="diag-row"><span>本地 core</span><Tag :type="diag.localCore ? 'success' : 'warning'" size="sm">{{ diag.localCore ? '存在' : '缺失' }}</Tag></div>
              <div class="diag-row"><span>jsDelivr</span><Tag :type="diag.jsDelivrReachable ? 'success' : 'error'" size="sm">{{ diag.jsDelivrReachable ? '可达' : '不可达' }}</Tag></div>
              <div class="diag-row"><span>unpkg</span><Tag :type="diag.unpkgReachable ? 'success' : 'error'" size="sm">{{ diag.unpkgReachable ? '可达' : '不可达' }}</Tag></div>
              <div class="diag-row"><span>npmmirror</span><Tag :type="diag.npmmirrorReachable ? 'success' : 'error'" size="sm">{{ diag.npmmirrorReachable ? '可达' : '不可达' }}</Tag></div>
              <button type="button" class="link" @click="runDiagnostics">重新检测</button>
            </details>
          </section>

          <section class="panel">
            <h2>模型配置</h2>
            <p class="card-desc">语言模型、生图、配音、视频等密钥写在本机 SQLite，不进安装目录，也不走浏览器。</p>
            <p v-if="settings.persistPath" class="path">{{ settings.persistPath }}</p>
            <p v-else class="muted">浏览器端保存在本机 localStorage。</p>
          </section>

          <section class="panel">
            <h2>保存位置</h2>
            <p class="card-desc">
              项目、图片、视频、音频和模型配置都会保存在下面的目录。修改后会迁移现有资料，之后的新资料也会存入新目录。
            </p>
            <p v-if="isDesktop()" class="path storage-path">{{ storageRoot || '正在读取…' }}</p>
            <p v-else class="muted">浏览器端使用 IndexedDB，保存位置由浏览器管理。</p>
            <div v-if="isDesktop()" class="proj storage-actions">
              <button type="button" class="mini" @click="openSettingsFolder">打开保存文件夹</button>
              <button
                type="button"
                class="mini"
                :disabled="changingStorageRoot"
                @click="chooseStorageFolder"
              >
                {{ changingStorageRoot ? '正在迁移…' : '选择新的保存文件夹' }}
              </button>
            </div>
            <div class="storage-bar"><div class="storage-bar-fill" :style="{ width: storagePct + '%' }" /></div>
            <div class="storage-info">
              <span>已用 {{ formatSize(storage.usage) }} / 配额 {{ formatSize(storage.quota) }}</span>
              <span>{{ storagePct.toFixed(1) }}%</span>
            </div>
            <div class="ss">
              <div><b>{{ assetStats.image }}</b><span>图片</span></div>
              <div><b>{{ assetStats.video }}</b><span>视频</span></div>
              <div><b>{{ assetStats.audio }}</b><span>音频</span></div>
              <div><b>{{ assetStats.total }}</b><span>总数</span></div>
            </div>
          </section>

          <section class="panel">
            <h2>项目管理</h2>
            <p class="card-desc">导出 / 导入 / 清理</p>
            <div class="proj">
              <button type="button" class="mini" @click="exportProjectData">导出所有项目数据</button>
              <button type="button" class="mini" @click="importProjectData">导入项目数据</button>
              <button type="button" class="danger" @click="clearAll">清空所有数据</button>
            </div>
          </section>

          <section class="panel">
            <h2>关于</h2>
            <div class="about-row"><span>版本</span><b>v{{ appVersion }}</b></div>
            <div class="about-row qq-group">
              <span><i>QQ</i> 官方交流群</span>
              <b>13892383</b>
            </div>
          </section>
        </div>
      </main>
    </div>
    <footer v-if="section !== 'system'" class="save-bar">
      <span>地址、Key、工作流都可以直接改，改完请点保存。</span>
      <button type="button" class="save" :disabled="saving || !settings.diskReady" @click="saveSettings">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg-0);
}
.top {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-1);
  flex-shrink: 0;
}
.back {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-2);
  font-size: 13px;
}
.back:hover {
  color: var(--color-text-1);
  background: var(--color-fill);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.brand h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.brand p {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.side {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-1);
  padding: 12px 8px;
  overflow-y: auto;
}
.group {
  margin: 10px 8px 6px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--color-text-4);
  text-transform: uppercase;
}
.group:first-child {
  margin-top: 2px;
}
.side a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin: 0 0 2px;
  padding: 8px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 13px;
  text-align: left;
  text-decoration: none;
}
.side a:hover {
  background: var(--color-fill);
  color: var(--color-text-1);
}
.side a.on {
  background: var(--grad-primary-soft);
  color: var(--color-text-1);
  font-weight: 600;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-4);
  flex-shrink: 0;
}
.dot.on {
  background: var(--color-success);
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 24px 28px 40px;
}
.onboarding {
  max-width: 900px;
  margin: 0 0 22px;
  padding: 16px;
  border: 1px solid rgba(124, 58, 237, 0.42);
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(124, 58, 237, 0.14), rgba(37, 99, 235, 0.07));
}
.onboarding-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.onboarding-head > div > b { font-size: 15px; color: var(--color-text-1); }
.onboarding-head p { margin: 4px 0 0; color: var(--color-text-3); font-size: 12px; }
.onboarding-done { flex-shrink: 0; color: #34d399; font-size: 12px; }
.onboarding-steps {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: stretch;
  gap: 10px;
}
.onboarding-step {
  display: flex;
  align-items: center;
  gap: 11px;
  margin: 0;
  padding: 12px;
  text-align: left;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-2);
  color: var(--color-text-2);
  cursor: pointer;
}
.onboarding-step.active { border-color: var(--color-accent); box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.2); }
.onboarding-step.done i { background: rgba(16, 185, 129, 0.2); color: #34d399; }
.onboarding-step.locked { opacity: 0.5; cursor: not-allowed; }
.onboarding-step i {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 50%;
  background: rgba(124, 58, 237, 0.2);
  color: #c4b5fd;
  font-style: normal;
  font-weight: 700;
}
.onboarding-step span { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.onboarding-step b { font-size: 13px; color: var(--color-text-1); }
.onboarding-step small { color: var(--color-text-4); line-height: 1.4; }
.onboarding-arrow { align-self: center; color: var(--color-text-4); }
@media (max-width: 760px) {
  .onboarding-steps { grid-template-columns: 1fr; }
  .onboarding-arrow { display: none; }
}
.loading {
  margin: 12px 0;
  font-size: 13px;
  color: var(--color-text-4);
}
.save-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-1);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.save-bar span {
  font-size: 12px;
  color: var(--color-text-4);
}
.save {
  margin: 0;
  padding: 8px 18px;
  border: 0;
  border-radius: 6px;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
.save:hover:not(:disabled) {
  filter: brightness(1.06);
}
.save:disabled {
  opacity: 0.55;
  cursor: default;
}
.sys {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  max-width: 920px;
}
.panel {
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-1);
}
.panel h2 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 650;
}
.card-desc,
.muted {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.5;
}
.engine-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px;
  background: var(--color-bg-2);
  border-radius: 4px;
  margin-bottom: 10px;
}
.engine-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.mini,
.danger,
.link {
  margin: 0;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 12px;
}
.mini {
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-1);
}
.link {
  color: var(--color-accent);
  background: transparent;
}
.danger {
  border: 1px solid rgba(248, 113, 113, 0.35);
  background: transparent;
  color: #fca5a5;
}
.diag {
  margin-top: 8px;
  font-size: 12px;
}
.diag summary {
  cursor: pointer;
  color: var(--color-text-2);
}
.diag-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  color: var(--color-text-3);
}
.storage-bar {
  height: 6px;
  background: var(--color-bg-2);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 8px;
}
.storage-bar-fill {
  height: 100%;
  background: var(--color-accent);
}
.path {
  margin: 0 0 12px;
  padding: 8px 10px;
  font-size: 11px;
  line-height: 1.45;
  word-break: break-all;
  color: var(--color-text-2);
  background: var(--color-bg-2);
  border-radius: 4px;
}
.storage-info {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--color-text-4);
  margin-bottom: 10px;
}
.ss {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.ss div {
  text-align: center;
  padding: 8px;
  background: var(--color-bg-2);
  border-radius: 4px;
}
.ss b {
  display: block;
  font-size: 18px;
}
.ss span {
  font-size: 11px;
  color: var(--color-text-4);
}
.proj {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.about-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  color: var(--color-text-3);
}
.about-row:last-child {
  border-bottom: none;
}
.about-row b {
  color: var(--color-text-1);
  font-weight: 600;
}
.about-row.qq-group {
  align-items: center;
  margin-top: 10px;
  padding: 12px 14px;
  border: 1px solid rgba(59, 130, 246, 0.5);
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.18), rgba(124, 58, 237, 0.13));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 6px 20px rgba(37, 99, 235, 0.08);
}
.qq-group span {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #bfdbfe;
  font-weight: 600;
}
.qq-group span i {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: #2563eb;
  color: white;
  font-size: 10px;
  font-style: normal;
  font-weight: 800;
  letter-spacing: -0.3px;
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
}
.about-row.qq-group b {
  color: #f8fafc;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 1.5px;
  text-shadow: 0 0 14px rgba(96, 165, 250, 0.5);
}
</style>
