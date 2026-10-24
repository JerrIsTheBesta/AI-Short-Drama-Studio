<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useProjectStore, useSettingsStore, useAssetsStore, useToastStore, endpointReady } from '@/stores'
import StudioSettings from '@/components/canvas/StudioSettings.vue'
import SetupAgent from '@/components/settings/SetupAgent.vue'
import ZealmanSettings from '@/components/settings/ZealmanSettings.vue'
import AutodlSettings from '@/components/settings/AutodlSettings.vue'
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

type SettingsSection = 'agent' | 'llm' | 'vision' | 'image' | 'tts' | 'video' | 'autodl' | 'zealman' | 'system'
const SECTIONS: SettingsSection[] = ['agent', 'llm', 'vision', 'image', 'tts', 'video', 'autodl', 'zealman', 'system']

const nav = [
  {
    id: 'llm' as const,
    label: '语言模型',
    desc: '剧本、智能体、接入助手',
    lead: '第一步：给 AI 配一个「大脑」。这里填的 Key 决定剧本写作、对话理解和后面的自动配置能不能跑起来。'
  },
  {
    id: 'agent' as const,
    label: '接入助手',
    desc: '用语言模型配置其余能力',
    lead: '懒得手动填表就走这里：你把厂商给的地址和 Key 贴进去（或口述），助手会自动把视觉、生图、配音、视频都配好。'
  },
  {
    id: 'vision' as const,
    label: '视觉理解',
    desc: '看图与质检',
    lead: '第二步：让 AI 「看得懂图」。它负责看懂参考图、检查生成的图片视频是不是符合要求。'
  },
  {
    id: 'image' as const,
    label: '图像生成',
    desc: '云端生图 / 本机 ComfyUI',
    lead: '第三步：负责画图的模型。人物设定图、场景底板、故事看板、分镜关键帧都用它生成。Zealman 镜像的地址在「Zealman 镜像」填写，这里选中后可以直接出图。'
  },
  {
    id: 'tts' as const,
    label: '配音',
    desc: '后期口播 TTS',
    lead: '第四步：给片子配人声。这里选好音色，台词会按照你写的文案念出来，也可以在角色卡上为每个角色单独设声音。'
  },
  {
    id: 'video' as const,
    label: '视频',
    desc: '图生视频',
    lead: '第五步：让静止的画面动起来。这里填图生视频的接口地址、凭证和模型（或工作流）名称。'
  },
  {
    id: 'autodl' as const,
    label: 'AutoDL 算力',
    desc: 'H3 系列图生视频',
    lead: 'H3 系列（15 秒 / v5 1080p / 首尾帧 / 数字人口播）都走 AutoDL。只需填一个 AutoDL Token，内置工作流自动配好。'
  },
  {
    id: 'zealman' as const,
    label: 'Zealman 镜像',
    desc: '生图和视频只填地址',
    lead: 'Zealman 镜像的文生图和视频都在这一页填写 Base URL。填好后到图像生成、视频里选用对应模型即可。'
  },
  {
    id: 'system' as const,
    label: '系统',
    desc: '引擎、存储、关于',
    lead: '剪辑引擎、文件存在哪、项目备份导出，还有版本号和官方交流群。'
  }
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
  if (id === 'autodl') {
    return Boolean(c.autodlToken?.trim()) &&
      c.videos.some((item) => item.provider === 'autodl' && item.apiKey?.trim() === c.autodlToken.trim())
  }
  if (id === 'zealman') return c.videos.some((item) => item.provider === 'zealman' && Boolean(item.baseUrl))
  return false
}
</script>

<template>
  <div class="settings">
    <header class="top">
      <button type="button" class="back" @click="goBack">返回</button>
      <div class="brand">
        <h1>{{ currentNav.label }}</h1>
        <span class="crumb">设置 / {{ currentNav.label }}</span>
      </div>
    </header>

    <div class="body">
      <nav class="side" aria-label="设置分区">
        <p class="group">AI 能力</p>
        <RouterLink
          v-for="item in nav.slice(0, 8)"
          :key="item.id"
          :to="`/settings/${item.id}`"
          replace
          active-class=""
          exact-active-class=""
          :class="{ on: section === item.id }"
        >
          <span class="lab">{{ item.label }}</span>
          <span
            v-if="item.id !== 'agent'"
            class="state"
            :class="{ ok: navReady(item.id) }"
          >{{ navReady(item.id) ? '已配置' : '待配置' }}</span>
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
        <p class="page-lead">
          {{ currentNav.lead }}
        </p>
        <section
          v-if="(section === 'llm' || section === 'agent') && !(section === 'agent' && assistantTargetsReady)"
          class="onboarding"
        >
          <div class="onboarding-head">
            <div>
              <b>第一次用？两步就能配好 AI</b>
              <p>先填语言模型（写剧本、聊天、理解需求都靠它），剩下的交给第 2 步的接入助手。</p>
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
                <b>填语言模型</b>
                <small>填接口地址、API Key 和模型名，然后点保存</small>
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
                <b>让助手接管剩下的配置</b>
                <small>{{ llmReady ? '把厂商给的信息贴给它，自动配好其他模型' : '完成第 1 步后解锁' }}</small>
              </span>
            </button>
          </div>
        </section>

        <SetupAgent v-show="section === 'agent'" @open="go($event as SettingsSection)" />
        <AutodlSettings v-if="settings.diskReady && section === 'autodl'" />
        <ZealmanSettings v-if="settings.diskReady && section === 'zealman'" />
        <StudioSettings
          v-if="settings.diskReady && section !== 'agent' && section !== 'zealman' && section !== 'autodl' && section !== 'system'"
          :module="section"
        />
        <p v-else-if="!settings.diskReady && section !== 'agent' && section !== 'system'" class="loading">
          正在读取本机配置…
        </p>

        <div v-else-if="section === 'system'" class="sys">
          <section v-if="isDesktop()" class="panel">
            <h2>本机文件权限</h2>
            <p class="card-desc">
              选参考图、视频素材时走的是系统文件框。正常情况下不需要额外授权；如果被系统拦住了，点下面的按钮放行一次。
            </p>
            <p class="muted">
              放行后请把「剧流 Studio」和你放素材的文件夹加入安全中心的排除项；用 360 / 火绒的话，把它加到信任区。
            </p>
            <div class="acts">
              <button type="button" class="mini" :disabled="grantingAccess" @click="grantFileAccess">
                {{ grantingAccess ? '等待系统授权…' : '授权访问本机文件' }}
              </button>
              <button type="button" class="mini" @click="openWindowsSecurity">打开 Windows 安全中心</button>
            </div>
          </section>

          <section class="panel">
            <h2>剪辑引擎</h2>
            <p class="card-desc">
              素材拼接、转场、烧字幕和成片导出都靠它。首次用到时会自动下载约 30MB 的组件，也可以现在就加载。
            </p>
            <div class="engine-row">
              <div>
                <div class="engine-name">FFmpeg</div>
                <p class="muted small">状态：{{ ffmpegReady ? '可以开始剪辑' : '还没加载' }}</p>
              </div>
              <button
                v-if="!ffmpegReady"
                type="button"
                class="mini"
                :disabled="ffmpegLoading"
                @click="warmupFFmpeg"
              >
                {{ ffmpegLoading ? '加载中…' : '现在加载' }}
              </button>
              <button v-else type="button" class="link" @click="resetAndRetry">重置</button>
            </div>
            <details class="diag">
              <summary>检测结果（加载不出来时看这里）</summary>
              <div class="diag-row">
                <span>浏览器多线程模式<i>加载失败通常是这项没开启</i></span>
                <Tag :type="diag.crossOriginIsolated ? 'success' : 'error'" size="sm">{{ diag.crossOriginIsolated ? '已开启' : '未开启' }}</Tag>
              </div>
              <div class="diag-row">
                <span>共享内存<i>多线程依赖它</i></span>
                <Tag :type="diag.sharedArrayBuffer ? 'success' : 'error'" size="sm">{{ diag.sharedArrayBuffer ? '支持' : '不支持' }}</Tag>
              </div>
              <div class="diag-row">
                <span>本机组件<i>有它可以离线加载</i></span>
                <Tag :type="diag.localCore ? 'success' : 'warning'" size="sm">{{ diag.localCore ? '已有' : '没有，会从网络下载' }}</Tag>
              </div>
              <div class="diag-row">
                <span>CDN 线路一<i>jsDelivr</i></span>
                <Tag :type="diag.jsDelivrReachable ? 'success' : 'error'" size="sm">{{ diag.jsDelivrReachable ? '通畅' : '连不上' }}</Tag>
              </div>
              <div class="diag-row">
                <span>CDN 线路二<i>unpkg</i></span>
                <Tag :type="diag.unpkgReachable ? 'success' : 'error'" size="sm">{{ diag.unpkgReachable ? '通畅' : '连不上' }}</Tag>
              </div>
              <div class="diag-row">
                <span>国内镜像<i>npmmirror</i></span>
                <Tag :type="diag.npmmirrorReachable ? 'success' : 'error'" size="sm">{{ diag.npmmirrorReachable ? '通畅' : '连不上' }}</Tag>
              </div>
              <button type="button" class="link" @click="runDiagnostics">重新检测</button>
            </details>
          </section>

          <section class="panel">
            <h2>模型配置存在哪</h2>
            <p class="card-desc">
              你填的接口地址和密钥只存在这台电脑里，不会上传到任何服务器。想备份就去下面的复制这个文件夹。
            </p>
            <p v-if="settings.persistPath" class="path">{{ settings.persistPath }}</p>
            <p v-else class="muted">浏览器版保存在浏览器自己的本地存储中。</p>
          </section>

          <section class="panel">
            <h2>保存位置</h2>
            <p class="card-desc">
              项目文件、图片、视频、音频都存在下面这个文件夹。换位置会把现有资料一起搬过去，方便你放到大硬盘或网盘同步目录。
            </p>
            <p v-if="isDesktop()" class="path storage-path">{{ storageRoot || '正在读取…' }}</p>
            <p v-else class="muted">浏览器版由浏览器自己管理存储位置。</p>
            <div v-if="isDesktop()" class="acts storage-actions">
              <button type="button" class="mini" @click="openSettingsFolder">打开这个文件夹</button>
              <button
                type="button"
                class="mini"
                :disabled="changingStorageRoot"
                @click="chooseStorageFolder"
              >
                {{ changingStorageRoot ? '正在搬家…' : '换一个保存位置' }}
              </button>
            </div>
            <div class="storage-bar"><div class="storage-bar-fill" :style="{ width: storagePct + '%' }" /></div>
            <div class="storage-info">
              <span>已用 {{ formatSize(storage.usage) }} / 总配额 {{ formatSize(storage.quota) }}</span>
              <span>{{ storagePct.toFixed(1) }}%</span>
            </div>
            <div class="ss">
              <div><b>{{ assetStats.image }}</b><span>图片</span></div>
              <div><b>{{ assetStats.video }}</b><span>视频</span></div>
              <div><b>{{ assetStats.audio }}</b><span>音频</span></div>
              <div><b>{{ assetStats.total }}</b><span>合计</span></div>
            </div>
          </section>

          <section class="panel">
            <h2>备份与清理</h2>
            <p class="card-desc">
              导出会把所有项目打包成一个文件，拿到别的电脑上导入就能接着用；清空会连素材一起删除，删之前想清楚。
            </p>
            <div class="acts">
              <button type="button" class="mini" @click="exportProjectData">导出所有项目</button>
              <button type="button" class="mini" @click="importProjectData">从文件导入</button>
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
      <span>所有改动都保存在这台电脑上，换台机器不会同步。改完记得点保存。</span>
      <button type="button" class="save" :disabled="saving || !settings.diskReady" @click="saveSettings">
        {{ saving ? '保存中…' : '保存改动' }}
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
  gap: 14px;
  min-height: 60px;
  padding: 0 20px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-1);
  flex-shrink: 0;
}
.back {
  flex-shrink: 0;
  margin: 0;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 12px;
  cursor: pointer;
}
.back:hover {
  color: var(--color-text-1);
  border-color: var(--color-border-strong);
  background: rgba(255, 255, 255, 0.03);
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.brand h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 680;
  letter-spacing: -0.015em;
}
.crumb {
  font-size: 11px;
  color: var(--color-text-4);
  letter-spacing: 0.02em;
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
  width: 244px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-1);
  padding: 14px 10px;
  overflow-y: auto;
}
.group {
  margin: 14px 10px 6px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.12em;
  color: var(--color-text-4);
}
.group:first-child {
  margin-top: 0;
}
.side a {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 2px;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--color-text-3);
  font-size: 13px;
  text-align: left;
  text-decoration: none;
  transition: background var(--duration-fast), color var(--duration-fast);
}
.side a::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 3px;
  height: 0;
  border-radius: 99px;
  background: var(--color-accent);
  transform: translateY(-50%);
  transition: height var(--duration-fast);
}
.side a.on::before {
  height: 18px;
}
.side a:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-text-1);
}
.side a.on {
  background: rgba(126, 180, 255, 0.1);
  color: var(--color-text-1);
  font-weight: 600;
}
.state {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 99px;
  border: 1px solid var(--color-border);
  background: rgba(255, 255, 255, 0.03);
  color: var(--color-text-4);
  font-size: 10px;
  font-weight: 500;
}
.state.ok {
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.1);
  color: #6ee7b7;
}
.diag-row span i {
  display: block;
  font-style: normal;
  font-size: 10px;
  color: var(--color-text-4);
  margin-top: 1px;
}
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 22px 28px 40px;
}
.page-lead {
  max-width: 720px;
  margin: 0 0 18px;
  padding: 11px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.025);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--color-text-3);
}
.onboarding {
  max-width: 900px;
  margin: 0 0 16px;
  padding: 16px 18px;
  border: 1px solid rgba(126, 180, 255, 0.28);
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(126, 180, 255, 0.08), rgba(167, 139, 250, 0.05));
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
  padding: 13px 14px;
  text-align: left;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-1);
  color: var(--color-text-2);
  cursor: pointer;
}
.onboarding-step.active { border-color: rgba(126, 180, 255, 0.6); }
.onboarding-step.done i { background: rgba(16, 185, 129, 0.16); color: #34d399; }
.onboarding-step.locked { opacity: 0.5; cursor: not-allowed; }
.onboarding-step i {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border-radius: 50%;
  background: rgba(126, 180, 255, 0.16);
  color: #a8c4ff;
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
  padding: 13px 20px;
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
  padding: 9px 20px;
  border: 1px solid rgba(126, 180, 255, 0.5);
  border-radius: 9px;
  background: rgba(126, 180, 255, 0.16);
  color: #cfe0ff;
  font-size: 12.5px;
  font-weight: 650;
  cursor: pointer;
}
.save:hover:not(:disabled) {
  background: rgba(126, 180, 255, 0.26);
}
.save:disabled {
  opacity: 0.5;
  cursor: default;
}
.sys {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px;
  max-width: 940px;
}
.panel {
  padding: 18px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-bg-1);
}
.panel h2 {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 680;
  letter-spacing: -0.01em;
}
.card-desc,
.muted {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.6;
}
.muted.small {
  margin: 3px 0 0;
  font-size: 11px;
}
.engine-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  margin-bottom: 10px;
}
.engine-name {
  font-size: 13px;
  font-weight: 620;
}
.mini,
.danger,
.link {
  margin: 0;
  padding: 7px 12px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
}
.mini {
  border: 1px solid var(--color-border);
  background: var(--color-bg-2);
  color: var(--color-text-1);
}
.mini:hover:not(:disabled) {
  border-color: var(--color-border-strong);
  background: rgba(255, 255, 255, 0.05);
}
.mini:disabled {
  opacity: 0.5;
  cursor: default;
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
.danger:hover {
  background: rgba(239, 68, 68, 0.1);
}
.diag {
  margin-top: 10px;
  font-size: 12px;
}
.diag summary {
  cursor: pointer;
  padding: 6px 0;
  color: var(--color-text-3);
  font-size: 11.5px;
}
.diag-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px dashed var(--color-border);
  color: var(--color-text-2);
  font-size: 12px;
}
.acts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.storage-bar {
  height: 6px;
  background: var(--color-bg-2);
  border-radius: 99px;
  overflow: hidden;
  margin: 14px 0 6px;
}
.storage-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #6f8cff, #a78bfa);
}
.path {
  margin: 0 0 12px;
  padding: 9px 11px;
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
  color: var(--color-text-2);
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: 9px;
}
.storage-info {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--color-text-4);
  margin-bottom: 12px;
}
.ss {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.ss div {
  text-align: center;
  padding: 10px 6px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}
.ss b {
  display: block;
  font-size: 17px;
  font-weight: 680;
}
.ss span {
  font-size: 11px;
  color: var(--color-text-4);
}
.about-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
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
