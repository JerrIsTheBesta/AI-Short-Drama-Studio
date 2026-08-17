<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { exportVideo, parseSRT, buildCuesFromClips } from '@/services/ffmpeg'
import { generateMusic, refineMusicPrompt, buildMusicPrompt } from '@/services/ai'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import Tag from '@/components/common/Tag.vue'
import ProgressRing from '@/components/common/ProgressRing.vue'
import type { TimelineClip } from '@/types'

const router = useRouter()
const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()

const format = ref<'mp4' | 'webm'>('mp4')
const burnCaptions = computed({
  get: () => project.current?.settings.burnCaptions !== false,
  set: (v: boolean) => project.setSettings({ burnCaptions: v })
})
const bgmAssetId = ref<string>('')
const bgmPrompt = ref('')
const bgmUrl = ref('')
const generatingBgm = ref(false)
const bgmError = ref('')
const keepAmbientAudio = computed({
  get: () => project.current?.settings.keepAmbientAudio !== false,
  set: (v: boolean) => project.setSettings({ keepAmbientAudio: v })
})

const ambientVolume = computed({
  get: () => project.current?.settings.originalVolume ?? 0.55,
  set: (v: number) => project.setSettings({ originalVolume: v })
})
const exporting = ref(false)
const progress = ref(0)
const progressMsg = ref('')
const resultUrl = ref<string | null>(null)
const resultSize = ref(0)

const audioAssets = computed(() =>
  assets.all.filter((a) => a.kind === 'audio' && !String(a.filename).startsWith('vo_'))
)

onMounted(async () => {
  await assets.refresh()
  if (project.current?.bgmAssetId) {
    bgmAssetId.value = project.current.bgmAssetId
    const url = await assets.getUrl(project.current.bgmAssetId)
    if (url) bgmUrl.value = url
  }
  bgmPrompt.value = project.current?.bgmPrompt || (project.current ? buildMusicPrompt(project.current) : '')
})

watch(bgmAssetId, async (id) => {
  if (!id) {
    bgmUrl.value = ''
    return
  }
  const url = await assets.getUrl(id)
  bgmUrl.value = url || ''
  if (project.current && project.current.bgmAssetId !== id) {
    project.setBgm(id, bgmPrompt.value)
  }
})

async function generateBgm() {
  if (!project.current) return
  generatingBgm.value = true
  bgmError.value = ''
  try {
    let prompt = bgmPrompt.value.trim()
    if (!prompt) {
      prompt = await refineMusicPrompt(project.current)
      bgmPrompt.value = prompt
    }
    const result = await generateMusic({
      prompt,
      duration: Number(totalDuration.value) || 24
    })
    const typed = result.blob.type.startsWith('audio/')
      ? result.blob
      : new Blob([result.blob], { type: result.mimeType || 'audio/mpeg' })
    const asset = await assets.add(typed, 'audio', 'ai-generated', {
      filename: `bgm_${Date.now().toString(36)}`,
      prompt,
      projectId: project.current.id
    })
    project.setBgm(asset.id, prompt)
    await project.save()
    bgmAssetId.value = asset.id
    const url = await assets.getUrl(asset.id)
    if (url) bgmUrl.value = url
    toast.success('整片配乐已生成，可先试听')
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    bgmError.value = msg
    toast.error('配乐生成失败：' + msg, 10000)
  } finally {
    generatingBgm.value = false
  }
}

const timeline = computed(() => project.current?.timeline ?? [])
const shots = computed(() => project.current?.shots ?? [])
const totalDuration = computed(() =>
  timeline.value
    .filter((c) => c.enabled)
    .reduce((s, c) => s + c.duration, 0)
    .toFixed(1)
)

const canExport = computed(() => {
  return (
    !!project.current &&
    timeline.value.length > 0 &&
    timeline.value.some((c) => c.enabled) &&
    !exporting.value
  )
})

async function doExport() {
  if (!project.current || !canExport.value) return

  exporting.value = true
  progress.value = 0
  progressMsg.value = '准备素材...'
  resultUrl.value = null

  try {
    // 构造 voiceover map
    const voiceoverMap = new Map<string, string>()
    for (const clip of timeline.value) {
      if (!clip.enabled) continue
      const shot = shots.value.find((s) => s.id === clip.shotId)
      voiceoverMap.set(clip.shotId, shot?.voiceover ?? '')
    }

    const captionCues = (() => {
      const srt = project.current!.captionSrt?.trim()
      if (srt) return parseSRT(srt).filter((c) => c.text.trim())
      return buildCuesFromClips(
        timeline.value
          .filter((c) => c.enabled)
          .map((c) => {
            const shot = shots.value.find((s) => s.id === c.shotId)
            return {
              startTime: c.startTime,
              duration: c.duration,
              text: shot?.voiceover ?? ''
            }
          })
      ).filter((c) => c.text.trim())
    })()

    if (burnCaptions.value && captionCues.length === 0) {
      toast.warn('没有字幕文本：请到「字幕」页填写，或在分镜里写口播。将导出无字幕成片。')
    }

    // 构造 mediaMap
    const mediaMap = new Map<string, { blob: Blob; kind: 'video' | 'image' }>()
    for (const clip of timeline.value) {
      if (mediaMap.has(clip.shotId)) continue
      const shot = shots.value.find((s) => s.id === clip.shotId)
      if (!shot) continue
      const assetId = shot.videoAssetId || shot.imageAssetId
      if (!assetId) continue
      const blob = await assets.getBlob(assetId)
      if (!blob) continue
      mediaMap.set(clip.shotId, {
        blob,
        kind: shot.videoAssetId ? 'video' : 'image'
      })
    }

    if (mediaMap.size === 0) {
      toast.error('没有可用的素材')
      exporting.value = false
      return
    }

    if (!bgmAssetId.value) {
      progressMsg.value = '生成整片背景音乐...'
      await generateBgm()
    }

    let bgmBlob: Blob | undefined
    if (bgmAssetId.value) {
      bgmBlob = await assets.getBlob(bgmAssetId.value)
    } else {
      toast.warn(
        keepAmbientAudio.value
          ? '没有配乐：成片会保留环境音并叠口播（若有）。'
          : '没有配乐：成片已去掉各镜原声，将只保留口播（若有）。'
      )
    }

    const voiceoverAudioMap = new Map<string, Blob>()
    let missingVo = 0
    for (const clip of timeline.value) {
      if (!clip.enabled || voiceoverAudioMap.has(clip.shotId)) continue
      const shot = shots.value.find((s) => s.id === clip.shotId)
      if (!shot?.voiceover.trim()) continue
      if (!shot.audioAssetId) {
        missingVo++
        continue
      }
      const blob = await assets.getBlob(shot.audioAssetId)
      if (blob) voiceoverAudioMap.set(clip.shotId, blob)
    }
    if (missingVo > 0) {
      toast.warn(`${missingVo} 个分镜有口播文案但还没配音，成片这些段会没有人声。可回「字幕」页生成口播。`)
    }

    const blob = await exportVideo({
      timeline: timeline.value,
      mediaMap,
      voiceoverMap,
      width: project.current.settings.width,
      height: project.current.settings.height,
      fps: project.current.settings.fps,
      captionStyle: project.current.settings.captionStyle,
      burnCaptions: burnCaptions.value,
      captionCues,
      captionBg: project.current.settings.captionBg,
      bgm: bgmBlob,
      bgmVolume: project.current.settings.bgmVolume,
      originalVolume: ambientVolume.value,
      keepAmbientAudio: keepAmbientAudio.value,
      voiceoverAudioMap,
      format: format.value,
      onProgress: (msg) => {
        progressMsg.value = msg
        // 模拟进度（FFmpeg 不直接给百分比）
        progress.value = Math.min(0.95, progress.value + 0.05)
      }
    })

    resultUrl.value = URL.createObjectURL(blob)
    resultSize.value = blob.size
    progress.value = 1
    progressMsg.value = '完成！'
    toast.success(`导出成功！文件大小 ${formatSize(blob.size)}`)
  } catch (e: unknown) {
    console.error('[ExportView] 导出失败:', e)
    const msg = e instanceof Error ? e.message : String(e)
    const displayMsg = msg.length > 600 ? msg.slice(0, 600) + '...' : msg
    toast.error('导出失败：' + displayMsg, 15000)
    progressMsg.value = '失败：' + (msg.split('\n')[0] ?? msg).slice(0, 200)
  } finally {
    exporting.value = false
  }
}

function download() {
  if (!resultUrl.value) return
  const a = document.createElement('a')
  a.href = resultUrl.value
  a.download = `${project.current?.name ?? 'export'}.${format.value}`
  a.click()
}

function formatSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

const segmentSummary = computed(() => {
  return timeline.value
    .filter((c) => c.enabled)
    .map((c) => {
      const shot = shots.value.find((s) => s.id === c.shotId)
      return {
        index: shot?.index ?? 0,
        title: shot?.title ?? '?',
        duration: c.duration,
        hasVideo: !!shot?.videoAssetId,
        hasImage: !!shot?.imageAssetId
      }
    })
})
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>🚀 导出成片</h1>
        <p>可选保留或去掉每镜原声，再叠配乐、口播和字幕后导出</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/caption')">← 上一步</GradientButton>
        <GradientButton
          v-if="!resultUrl"
          icon="🚀"
          :loading="exporting"
          :disabled="!canExport"
          @click="doExport"
        >
          {{ exporting ? '导出中...' : '开始导出' }}
        </GradientButton>
        <GradientButton
          v-else
          icon="📥"
          @click="download"
        >下载视频</GradientButton>
      </div>
    </header>

    <div class="layout">
      <main class="left">
        <GlassCard padding="md" v-if="!exporting && !resultUrl">
          <h3>📦 导出设置</h3>

          <div class="field">
            <span>视频格式</span>
            <div class="format-grid">
              <button
                class="format"
                :class="{ active: format === 'mp4' }"
                @click="format = 'mp4'"
              >
                <div class="format-name">MP4</div>
                <div class="format-desc">H.264，兼容性最好</div>
              </button>
              <button
                class="format"
                :class="{ active: format === 'webm' }"
                @click="format = 'webm'"
              >
                <div class="format-name">WebM</div>
                <div class="format-desc">VP9，体积更小</div>
              </button>
            </div>
          </div>

          <div class="field">
            <span>字幕</span>
            <label class="check">
              <input v-model="burnCaptions" type="checkbox" />
              <span>将字幕烧录到视频上（无法再编辑）</span>
            </label>
          </div>

          <div class="field">
            <span>分镜原声（环境音效）</span>
            <div class="format-grid">
              <button
                class="format"
                :class="{ active: keepAmbientAudio }"
                @click="keepAmbientAudio = true"
              >
                <div class="format-name">保留每镜声音</div>
                <div class="format-desc">留下雨声、牛喝水等环境音，再叠口播/BGM</div>
              </button>
              <button
                class="format"
                :class="{ active: !keepAmbientAudio }"
                @click="keepAmbientAudio = false"
              >
                <div class="format-name">去掉每镜声音</div>
                <div class="format-desc">各段静音，成片只保留口播和整片配乐</div>
              </button>
            </div>
            <div v-if="keepAmbientAudio" class="ambient-vol">
              <span class="hint">环境音音量</span>
              <input
                v-model.number="ambientVolume"
                type="range"
                min="0.1"
                max="1"
                step="0.05"
              />
              <span class="hint">{{ Math.round(ambientVolume * 100) }}%</span>
            </div>
            <p class="hint" style="margin-top: 6px;">
              {{
                keepAmbientAudio
                  ? '口播与 BGM 会叠在环境音之上。若某段视频本身无音轨，该段环境仍为静音。'
                  : '将去掉每个镜头视频自带的声音，避免段间配乐打架；只保留口播与整片 BGM。'
              }}
            </p>
          </div>

          <div class="field">
            <span>背景音乐</span>
            <p class="hint" style="margin-bottom: 8px;">
              {{
                keepAmbientAudio
                  ? '整片铺一段纯音乐，与环境音、口播混合。'
                  : '整片铺一段纯音乐，再叠口播人声（各镜原声已去掉）。'
              }}
            </p>
            <textarea
              v-model="bgmPrompt"
              class="input bgm-prompt"
              rows="3"
              placeholder="描述想要的配乐风格，例如：电影感温暖弦乐，平稳铺底，不要人声..."
            />
            <div class="bgm-actions">
              <GradientButton
                size="sm"
                icon="🎵"
                :loading="generatingBgm"
                :disabled="generatingBgm || exporting"
                @click="generateBgm"
              >
                {{ bgmAssetId ? '重新生成配乐' : '生成配乐' }}
              </GradientButton>
              <select v-model="bgmAssetId" class="input" style="flex: 1;">
                <option value="">不使用 BGM</option>
                <option v-for="a in audioAssets" :key="a.id" :value="a.id">
                  {{ a.filename }}
                </option>
              </select>
            </div>
            <audio v-if="bgmUrl" class="bgm-player" :src="bgmUrl" controls />
            <p v-if="bgmError" class="hint" style="color: var(--color-warning);">{{ bgmError }}</p>
          </div>
        </GlassCard>

        <GlassCard padding="md" v-if="exporting">
          <div class="exporting">
            <ProgressRing :progress="progress" :size="100" :stroke-width="6" show-label />
            <div class="exporting-msg">{{ progressMsg }}</div>
            <p class="hint">FFmpeg 正在处理，请耐心等待...</p>
          </div>
        </GlassCard>

        <GlassCard padding="md" v-if="resultUrl">
          <div class="result">
            <h3>✅ 导出完成</h3>
            <video
              :src="resultUrl"
              controls
              autoplay
              class="result-video"
            />
            <div class="result-meta">
              <Tag type="success" size="sm">{{ format.toUpperCase() }}</Tag>
              <span class="result-size">{{ formatSize(resultSize) }}</span>
              <span class="result-duration">{{ totalDuration }}s</span>
            </div>
            <div class="result-actions">
              <GradientButton icon="📥" @click="download">下载视频</GradientButton>
              <GradientButton type="ghost" @click="resultUrl = null">再次导出</GradientButton>
            </div>
          </div>
        </GlassCard>

        <GlassCard padding="md" v-if="!exporting && !resultUrl">
          <h3>📋 时间线预览</h3>
          <div v-if="segmentSummary.length === 0" class="empty">
            时间线是空的，请先回到剪辑步骤加入片段
          </div>
          <div v-else class="seg-list">
            <div v-for="seg in segmentSummary" :key="seg.index" class="seg">
              <div class="seg-num">{{ seg.index + 1 }}</div>
              <div class="seg-info">
                <div class="seg-title">{{ seg.title }}</div>
                <div class="seg-meta">
                  <Tag size="sm" :type="seg.hasVideo ? 'success' : 'info'">
                    {{ seg.hasVideo ? '🎥 视频' : '🖼 图片' }}
                  </Tag>
                  <span>{{ seg.duration }}s</span>
                </div>
              </div>
            </div>
          </div>
        </GlassCard>
      </main>

      <aside class="right">
        <GlassCard padding="md">
          <h3>📊 合成清单</h3>
          <div class="kv">
            <span>总片段</span><b>{{ segmentSummary.length }}</b>
          </div>
          <div class="kv">
            <span>总时长</span><b>{{ totalDuration }}s</b>
          </div>
          <div class="kv">
            <span>分辨率</span>
            <b>{{ project.current?.settings.width }}×{{ project.current?.settings.height }}</b>
          </div>
          <div class="kv">
            <span>帧率</span><b>{{ project.current?.settings.fps }}fps</b>
          </div>
          <div class="kv">
            <span>输出格式</span><b>{{ format.toUpperCase() }}</b>
          </div>
          <div class="kv">
            <span>字幕</span>
            <Tag :type="burnCaptions ? 'success' : 'default'" size="sm">
              {{ burnCaptions ? '烧录' : '不烧录' }}
            </Tag>
          </div>
        </GlassCard>

        <GlassCard padding="md">
          <h3>💡 性能提示</h3>
          <ul class="tips">
            <li>首跑会下载 FFmpeg 核心（约 30MB）</li>
            <li>5 分钟以内的视频一般 1-3 分钟合成完</li>
            <li>长视频建议用 MP4 输出，兼容性更好</li>
            <li>如需更高质量，可改用 MP4 + 调高 crf</li>
          </ul>
        </GlassCard>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: var(--space-6);
  max-width: 1400px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: var(--space-5);
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
  flex-wrap: wrap;
}

.layout {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: var(--space-4);
}
.left, .right {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
h3 {
  font-size: 13px;
  margin: 0 0 var(--space-3);
  font-weight: 600;
}

.field {
  margin-bottom: var(--space-4);
}
.field > span {
  display: block;
  font-size: 12px;
  color: var(--color-text-3);
  margin-bottom: 6px;
  font-weight: 500;
}
.format-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
}
.format {
  text-align: left;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  transition: all var(--duration-fast);
}
.format:hover {
  border-color: var(--color-border-strong);
}
.format.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
}
.format-name {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 2px;
}
.format-desc {
  font-size: 11px;
  color: var(--color-text-3);
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-2);
  cursor: pointer;
}
.ambient-vol {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.ambient-vol input[type='range'] {
  flex: 1;
}
.input {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  font-size: 12px;
  color: var(--color-text-1);
  font-family: inherit;
}
.bgm-prompt {
  resize: vertical;
  min-height: 64px;
  line-height: 1.5;
  margin-bottom: 8px;
}
.bgm-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bgm-player {
  width: 100%;
  margin-top: 8px;
  height: 32px;
}
.hint {
  font-size: 11px;
  color: var(--color-text-4);
  margin: 6px 0 0;
}

.exporting {
  text-align: center;
  padding: var(--space-8) 0;
}
.exporting-msg {
  font-size: 14px;
  color: var(--color-text-1);
  margin: var(--space-3) 0;
  font-weight: 500;
}

.result h3 {
  margin-bottom: var(--space-3);
}
.result-video {
  width: 100%;
  max-height: 60vh;
  background: #000;
  border-radius: var(--radius-md);
}
.result-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
  font-size: 12px;
  color: var(--color-text-3);
}
.result-size, .result-duration {
  font-variant-numeric: tabular-nums;
}
.result-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.empty {
  text-align: center;
  color: var(--color-text-4);
  padding: var(--space-6);
}
.seg-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 400px;
  overflow-y: auto;
}
.seg {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
}
.seg-num {
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
.seg-info {
  flex: 1;
  min-width: 0;
}
.seg-title {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.seg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--color-text-4);
  margin-top: 2px;
}

.kv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  margin-bottom: 6px;
  color: var(--color-text-3);
}
.kv b {
  color: var(--color-text-1);
  font-weight: 600;
}
.tips {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--color-text-3);
  line-height: 1.7;
}
.tips li {
  margin-bottom: 4px;
}
</style>
