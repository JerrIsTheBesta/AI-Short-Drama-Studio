<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useAssetsStore, useToastStore } from '@/stores'
import { generateImage, characterSheetPrompt, scenePlatePrompt } from '@/services/ai'
import { imageModelForProject } from '@/services/ai/runtime'
import { effectiveImagePrompt } from '@/utils/shot'
import {
  collectShotRefIds,
  composeShotImagePrompt,
  imageRefSlots,
  missingCastAssets
} from '@/utils/consistency'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'
import ProgressRing from '@/components/common/ProgressRing.vue'
import AssetPicker from '@/components/common/AssetPicker.vue'
import ImageModelSelect from '@/components/settings/ImageModelSelect.vue'
import { lookFromScript } from '@/utils/visualStyle'
import { openLightbox } from '@/composables/useLightbox'
import type { Shot, ID, Subject, Scene } from '@/types'

const router = useRouter()
const project = useProjectStore()
const assets = useAssetsStore()
const toast = useToastStore()

const generating = ref<Set<string>>(new Set())
const progress = ref<Record<string, string>>({})
const imageUrls = ref<Record<string, string>>({})
const refUrls = ref<Record<string, string[]>>({})
const historyUrls = ref<Record<string, string>>({})
const picker = ref<{ mode: 'main' | 'ref'; shotId: string } | null>(null)

onMounted(async () => {
  if (!project.current?.shots.length) {
    toast.warn('请先生成分镜')
    router.push('/storyboard')
    return
  }
  await loadImages()
  await loadRefImages()
  await loadHistory()
  await loadCastImages()
})

const shots = computed(() => project.current?.shots ?? [])
const aspectRatio = computed(() => project.current?.settings.aspectRatio ?? '16:9')
const width = computed(() => project.current?.settings.width ?? 1280)
const height = computed(() => project.current?.settings.height ?? 720)
const style = computed(() => project.current?.script?.style ?? 'cinematic')
const projectRefIds = computed(() => project.current?.script?.referenceAssetIds ?? [])
const projectRefUrls = ref<string[]>([])
const projectRefIdList = computed(() => projectRefIds.value)
const subjects = computed(() => project.current?.subjects ?? [])
const scenes = computed(() => project.current?.scenes ?? [])
const sheetUrls = ref<Record<string, string>>({})
const plateUrls = ref<Record<string, string>>({})
const missing = computed(() =>
  project.current
    ? missingCastAssets(project.current)
    : { subjects: [] as Subject[], scenes: [] as Scene[] }
)

async function loadCastImages() {
  const nextSheets: Record<string, string> = {}
  const nextPlates: Record<string, string> = {}
  for (const s of subjects.value) {
    if (!s.designSheetAssetId) continue
    const u = await assets.getUrl(s.designSheetAssetId)
    if (u) nextSheets[s.id] = u
  }
  for (const s of scenes.value) {
    if (!s.plateAssetId) continue
    const u = await assets.getUrl(s.plateAssetId)
    if (u) nextPlates[s.id] = u
  }
  sheetUrls.value = nextSheets
  plateUrls.value = nextPlates
}

async function productRefBlobs(): Promise<Blob[]> {
  const blobs: Blob[] = []
  for (const id of projectRefIds.value) {
    const b = await assets.getBlob(id)
    if (b) blobs.push(b)
  }
  return blobs.slice(0, 3)
}

async function loadImages() {
  for (const s of shots.value) {
    if (s.imageAssetId) {
      const url = await assets.getUrl(s.imageAssetId)
      if (url) imageUrls.value[s.id] = url
    }
  }
}

async function loadHistory() {
  const next: Record<string, string> = {}
  for (const s of shots.value) {
    for (const id of s.imageHistoryIds ?? []) {
      const url = await assets.getUrl(id)
      if (url) next[id] = url
    }
  }
  historyUrls.value = { ...historyUrls.value, ...next }
}

async function loadRefImages() {
  projectRefUrls.value = []
  for (const id of projectRefIds.value) {
    const url = await assets.getUrl(id)
    if (url && !projectRefUrls.value.includes(url)) {
      projectRefUrls.value.push(url)
    }
  }
  for (const s of shots.value) {
    if (s.referenceAssetIds && s.referenceAssetIds.length > 0) {
      const urls: string[] = []
      for (const id of s.referenceAssetIds) {
        const u = await assets.getUrl(id)
        if (u) urls.push(u)
      }
      refUrls.value[s.id] = urls
    }
  }
}

async function collectRefBlobs(shot: Shot): Promise<{ blobs: Blob[]; labels: string[] }> {
  if (!project.current) return { blobs: [], labels: [] }
  const bundle = collectShotRefIds(shot, project.current)
  const blobs: Blob[] = []
  const labels: string[] = []
  for (let i = 0; i < bundle.ids.length; i++) {
    const b = await assets.getBlob(bundle.ids[i])
    if (!b) continue
    blobs.push(b)
    labels.push(bundle.labels[i])
  }
  return { blobs, labels }
}

function kindLabel(k: string) {
  return k === 'animal' ? '动物' : k === 'other' ? '物体' : '人物'
}

function shotLockPreview(shot: Shot): { url?: string; label: string }[] {
  if (!project.current) return []
  return imageRefSlots(shot, project.current)
    .filter((s) => s.locked)
    .map((s) => {
      const sub = subjects.value.find((x) => x.designSheetAssetId === s.id)
      const scn = scenes.value.find((x) => x.plateAssetId === s.id)
      const url = (sub && sheetUrls.value[sub.id]) || (scn && plateUrls.value[scn.id])
      return { url, label: s.label }
    })
}

function promptOf(shot: Shot) {
  return effectiveImagePrompt(shot)
}

function updateImagePrompt(shot: Shot, value: string) {
  project.updateShot(shot.id, { imagePrompt: value })
}

function resetImagePrompt(shot: Shot) {
  project.updateShot(shot.id, { imagePrompt: shot.visualPrompt })
  toast.info('已恢复为分镜画面描述')
}

async function generateSubjectSheet(sub: Subject) {
  if (!project.current) return
  generating.value.add(sub.id)
  try {
    progress.value[sub.id] = '生成人设图...'
    const refs = await productRefBlobs()
    const useRefs = refs.length > 0 && (Boolean(sub.fromReference) || sub.kind === 'other')
    const look = lookFromScript(project.current.script)
    const prompt = characterSheetPrompt(sub, look.style, useRefs, look)
    const result = await generateImage(
      {
        prompt,
        style: look.style,
        width: 1792,
        height: 1024,
        aspectRatio: '16:9',
        referenceImages: useRefs ? refs : undefined,
        referenceLabels: useRefs
          ? refs.map(() => `photo of character "${sub.name}", copy identity exactly`)
          : undefined,
        model: imageModelForProject(project.current.pipelineMode)
      },
      (msg) => {
        progress.value[sub.id] = msg
      }
    )
    const asset = await assets.add(result.blob, 'image', 'ai-generated', {
      filename: `character_${sub.name}_${Date.now().toString(36)}`,
      prompt,
      projectId: project.current.id
    })
    project.updateSubject(sub.id, { designSheetAssetId: asset.id })
    await project.save()
    const url = await assets.getUrl(asset.id)
    if (url) sheetUrls.value = { ...sheetUrls.value, [sub.id]: url }
    toast.success(`「${sub.name}」多角度人设已生成`)
  } catch (e: any) {
    toast.error(`人设「${sub.name}」失败：${e.message}`)
  } finally {
    generating.value.delete(sub.id)
    delete progress.value[sub.id]
  }
}

async function generateScenePlate(scn: Scene) {
  if (!project.current) return
  generating.value.add(scn.id)
  try {
    progress.value[scn.id] = '生成场景底板...'
    const look = lookFromScript(project.current.script)
    const prompt = scenePlatePrompt(scn, look.style, look)
    const result = await generateImage(
      {
        prompt,
        style: look.style,
        width: width.value,
        height: height.value,
        aspectRatio: aspectRatio.value,
        model: imageModelForProject(project.current.pipelineMode)
      },
      (msg) => {
        progress.value[scn.id] = msg
      }
    )
    const asset = await assets.add(result.blob, 'image', 'ai-generated', {
      filename: `scene_${scn.name}_${Date.now().toString(36)}`,
      prompt,
      projectId: project.current.id
    })
    project.updateScene(scn.id, { plateAssetId: asset.id })
    await project.save()
    const url = await assets.getUrl(asset.id)
    if (url) plateUrls.value = { ...plateUrls.value, [scn.id]: url }
    toast.success(`场景「${scn.name}」底板已生成`)
  } catch (e: any) {
    toast.error(`场景「${scn.name}」失败：${e.message}`)
  } finally {
    generating.value.delete(scn.id)
    delete progress.value[scn.id]
  }
}

async function generateMissingCast() {
  for (const sub of missing.value.subjects) {
    if (!generating.value.has(sub.id)) await generateSubjectSheet(sub)
  }
  for (const scn of missing.value.scenes) {
    if (!generating.value.has(scn.id)) await generateScenePlate(scn)
  }
}

async function generateOne(shot: Shot) {
  if (!project.current) return
  generating.value.add(shot.id)
  try {
    if (missing.value.subjects.length || missing.value.scenes.length) {
      progress.value[shot.id] = '先生成人设/场景底板...'
      await generateMissingCast()
    }
    progress.value[shot.id] = '准备...'
    const { blobs: refBlobs, labels } = await collectRefBlobs(shot)
    const prompt = composeShotImagePrompt(
      shot,
      project.current,
      promptOf(shot) || shot.title
    )
    if (refBlobs.length > 0) {
      progress.value[shot.id] = `图生图（${refBlobs.length} 张：人设+场景）...`
    } else {
      progress.value[shot.id] = '文生图...'
    }

    const result = await generateImage(
      {
        prompt,
        style: lookFromScript(project.current.script).style,
        width: width.value,
        height: height.value,
        aspectRatio: aspectRatio.value,
        referenceImages: refBlobs.length > 0 ? refBlobs : undefined,
        referenceLabels: labels.length > 0 ? labels : undefined,
        model: imageModelForProject(project.current.pipelineMode)
      },
      (msg) => {
        progress.value[shot.id] = msg
      }
    )
    progress.value[shot.id] = '保存到资源库...'
    const asset = await assets.add(result.blob, 'image', 'ai-generated', {
      filename: `shot_${shot.index + 1}_${Date.now().toString(36)}`,
      prompt,
      projectId: project.current.id,
      shotId: shot.id
    })
    project.assignShotImage(shot.id, asset.id)
    await project.save()
    const url = await assets.getUrl(asset.id)
    if (url) imageUrls.value[shot.id] = url
    await loadHistory()
    toast.success(
      `分镜 ${shot.index + 1} 已生成${refBlobs.length > 0 ? `（${refBlobs.length} 张锁定参考）` : ''}`
    )
  } catch (e: any) {
    toast.error(`分镜 ${shot.index + 1} 生成失败：${e.message}`)
  } finally {
    generating.value.delete(shot.id)
    delete progress.value[shot.id]
  }
}

async function generateAll() {
  await generateMissingCast()
  for (const shot of shots.value) {
    if (!shot.imageAssetId && !generating.value.has(shot.id)) {
      await generateOne(shot)
    }
  }
}

async function regenerate(shot: Shot) {
  if (!confirm('重新生成分镜 ' + (shot.index + 1) + ' 的图片？旧图会留在资源库。')) return
  await generateOne(shot)
}

function triggerRefUpload(shotId: string) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.style.display = 'none'
  input.addEventListener('change', async () => {
    const files = input.files
    if (!files || files.length === 0) {
      document.body.removeChild(input)
      return
    }
    const shot = shots.value.find((s) => s.id === shotId)
    if (!shot) {
      document.body.removeChild(input)
      return
    }
    let count = 0
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      try {
        const asset = await assets.add(file, 'image', 'uploaded', {
          filename: file.name,
          projectId: project.current?.id,
          shotId: shot.id
        })
        const ids = [...(shot.referenceAssetIds ?? []), asset.id]
        project.updateShot(shot.id, { referenceAssetIds: ids })
        const url = await assets.getUrl(asset.id)
        if (url) {
          const list = refUrls.value[shot.id] ?? []
          refUrls.value[shot.id] = [...list, url]
        }
        count++
      } catch (e) {
        console.error('upload ref failed', e)
      }
    }
    if (count > 0) toast.success(`已添加 ${count} 张参考图到资源库`)
    document.body.removeChild(input)
  })
  document.body.appendChild(input)
  input.click()
}

async function removeRef(shot: Shot, assetId: string) {
  const ids = (shot.referenceAssetIds ?? []).filter((i) => i !== assetId)
  project.updateShot(shot.id, { referenceAssetIds: ids })
  const urls: string[] = []
  for (const id of ids) {
    const u = await assets.getUrl(id)
    if (u) urls.push(u)
  }
  refUrls.value[shot.id] = urls
}

function triggerProjectRefUpload() {
  if (!project.current?.script) {
    toast.warn('没有打开的项目')
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.style.display = 'none'
  input.addEventListener('change', async () => {
    const files = input.files
    if (!files || files.length === 0) {
      document.body.removeChild(input)
      return
    }
    const script = project.current!.script!
    const ids = [...(script.referenceAssetIds ?? [])]
    let count = 0
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      try {
        const asset = await assets.add(file, 'image', 'uploaded', {
          filename: file.name,
          projectId: project.current?.id
        })
        ids.push(asset.id)
        const url = await assets.getUrl(asset.id)
        if (url && !projectRefUrls.value.includes(url)) {
          projectRefUrls.value.push(url)
        }
        count++
      } catch (e) {
        console.error('upload ref failed', e)
      }
    }
    project.setScript({ ...script, referenceAssetIds: ids })
    if (count > 0) toast.success(`已添加 ${count} 张项目级参考图`)
    document.body.removeChild(input)
  })
  document.body.appendChild(input)
  input.click()
}

async function removeProjectRef(assetId: string) {
  if (!project.current?.script) return
  const script = project.current.script
  const ids = (script.referenceAssetIds ?? []).filter((i) => i !== assetId)
  project.setScript({ ...script, referenceAssetIds: ids })
  projectRefUrls.value = []
  for (const id of ids) {
    const u = await assets.getUrl(id)
    if (u) projectRefUrls.value.push(u)
  }
}

async function onPickerConfirm(ids: ID[]) {
  const ctx = picker.value
  picker.value = null
  if (!ctx || ids.length === 0) return
  const shot = shots.value.find((s) => s.id === ctx.shotId)
  if (!shot) return

  if (ctx.mode === 'main') {
    const id = ids[0]
    project.assignShotImage(shot.id, id)
    await project.save()
    const url = await assets.getUrl(id)
    if (url) imageUrls.value[shot.id] = url
    await loadHistory()
    toast.success(`分镜 ${shot.index + 1} 已从资源库选用图片`)
    return
  }

  const merged = [...new Set([...(shot.referenceAssetIds ?? []), ...ids])]
  project.updateShot(shot.id, { referenceAssetIds: merged })
  const urls: string[] = []
  for (const id of merged) {
    const u = await assets.getUrl(id)
    if (u) urls.push(u)
  }
  refUrls.value[shot.id] = urls
  toast.success(`已从资源库添加 ${ids.length} 张参考图`)
}

async function restoreHistory(shot: Shot, assetId: ID) {
  project.assignShotImage(shot.id, assetId)
  await project.save()
  const url = await assets.getUrl(assetId)
  if (url) imageUrls.value[shot.id] = url
  await loadHistory()
  toast.success('已切回历史版本')
}

function next() {
  router.push('/videos')
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>🎨 AI 配图</h1>
        <p>先生成角色多角度人设和场景底板，再按「人设1 · 人设2 · 场景」三张参考画每一镜</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/storyboard')">← 上一步</GradientButton>
        <ImageModelSelect />
        <GradientButton
          icon="✨"
          :loading="generating.size > 0"
          @click="generateAll"
        >
          {{ generating.size > 0 ? `生成中 ${generating.size}` : '先人设/场景，再一键配图' }}
        </GradientButton>
        <GradientButton icon="→" @click="next">下一步：AI 视频</GradientButton>
      </div>
    </header>

    <GlassCard padding="md" class="cast-board">
      <div class="pr-head">
        <div>
          <h3>🧍 主体人设 · 多角度设计图</h3>
          <p>
            每个角色一张图，里面包含正面/侧面/背面/表情等多种形态。
            有参考图时会尽量长得和参考图里的人一样。
          </p>
        </div>
        <GradientButton
          size="sm"
          :loading="subjects.some((s) => generating.has(s.id)) || scenes.some((s) => generating.has(s.id))"
          :disabled="!missing.subjects.length && !missing.scenes.length"
          @click="generateMissingCast"
        >
          {{ missing.subjects.length || missing.scenes.length ? '生成缺失的人设/场景' : '全部已就绪' }}
        </GradientButton>
      </div>
      <div v-if="subjects.length === 0" class="pr-empty">
        还没有主体。请先回「分镜」让 AI 从文案/参考图里列出人物和动物。
      </div>
      <div v-else class="cast-grid">
        <div v-for="sub in subjects" :key="sub.id" class="cast-card">
          <div class="cast-thumb">
            <img
              v-if="sheetUrls[sub.id]"
              class="zoomable"
              :src="sheetUrls[sub.id]"
              :alt="sub.name"
              title="点击查看大图"
              @click="openLightbox(sheetUrls[sub.id], 'image', sub.name)"
            />
            <div v-else-if="generating.has(sub.id)" class="placeholder generating-placeholder">
              <ProgressRing :progress="0.5" :size="40" :stroke-width="3" />
              <div class="progress-msg">{{ progress[sub.id] }}</div>
            </div>
            <div v-else class="placeholder">
              <div class="placeholder-icon">👤</div>
              <div class="placeholder-text">待生成人设</div>
            </div>
          </div>
          <div class="cast-meta">
            <div class="cast-name">
              {{ sub.name }}
              <Tag size="sm">{{ kindLabel(sub.kind) }}</Tag>
              <Tag v-if="sub.fromReference" type="accent" size="sm">参考图</Tag>
            </div>
            <textarea
              class="cast-desc"
              rows="2"
              :value="sub.description"
              @blur="project.updateSubject(sub.id, { description: ($event.target as HTMLTextAreaElement).value })"
            />
            <GradientButton
              size="sm"
              :type="sub.designSheetAssetId ? 'ghost' : 'primary'"
              :loading="generating.has(sub.id)"
              @click="generateSubjectSheet(sub)"
            >
              {{ sub.designSheetAssetId ? '重新生成人设' : '生成多角度人设' }}
            </GradientButton>
          </div>
        </div>
      </div>

      <div class="pr-head scene-head">
        <div>
          <h3>🏞 场景底板（空镜）</h3>
          <p>不含人物。配图工作流的第 3 张图，用来锁地点和光线。</p>
        </div>
      </div>
      <div v-if="scenes.length === 0" class="pr-empty">还没有场景。回分镜步骤重新生成。</div>
      <div v-else class="cast-grid">
        <div v-for="scn in scenes" :key="scn.id" class="cast-card">
          <div class="cast-thumb">
            <img
              v-if="plateUrls[scn.id]"
              class="zoomable"
              :src="plateUrls[scn.id]"
              :alt="scn.name"
              title="点击查看大图"
              @click="openLightbox(plateUrls[scn.id], 'image', scn.name)"
            />
            <div v-else-if="generating.has(scn.id)" class="placeholder generating-placeholder">
              <ProgressRing :progress="0.5" :size="40" :stroke-width="3" />
              <div class="progress-msg">{{ progress[scn.id] }}</div>
            </div>
            <div v-else class="placeholder">
              <div class="placeholder-icon">🏞</div>
              <div class="placeholder-text">待生成底板</div>
            </div>
          </div>
          <div class="cast-meta">
            <div class="cast-name">{{ scn.name }}</div>
            <textarea
              class="cast-desc"
              rows="2"
              :value="scn.description"
              @blur="project.updateScene(scn.id, { description: ($event.target as HTMLTextAreaElement).value })"
            />
            <GradientButton
              size="sm"
              :type="scn.plateAssetId ? 'ghost' : 'primary'"
              :loading="generating.has(scn.id)"
              @click="generateScenePlate(scn)"
            >
              {{ scn.plateAssetId ? '重新生成底板' : '生成场景底板' }}
            </GradientButton>
          </div>
        </div>
      </div>
    </GlassCard>

    <GlassCard padding="md" class="project-refs">
      <div class="pr-head">
        <div>
          <h3>📌 产品 / 额外参考图</h3>
          <p>生成人设时会参考这些图里的人物。分镜配图本身固定用人设 + 场景三张槽位。</p>
        </div>
        <button class="upload-btn" @click="triggerProjectRefUpload">
          ＋ 上传
        </button>
      </div>
      <div v-if="projectRefUrls.length === 0" class="pr-empty">
        还没有项目级参考图。点「＋ 上传」添加，生成图片时会作为全局参考。
      </div>
      <div v-else class="pr-list">
        <div v-for="(url, i) in projectRefUrls" :key="i" class="pr-item">
          <img
            class="zoomable"
            :src="url"
            alt=""
            title="点击查看大图"
            @click="openLightbox(url)"
          />
          <button
            class="pr-del"
            @click="removeProjectRef(projectRefIdList[i])"
            title="从本项目移除（资源库仍保留）"
          >×</button>
        </div>
      </div>
    </GlassCard>

    <EmptyState
      v-if="shots.length === 0"
      icon="🎨"
      title="还没有分镜"
      description="请先回到分镜步骤"
    />

    <div v-else class="grid">
      <GlassCard
        v-for="shot in shots"
        :key="shot.id"
        padding="md"
        :class="['shot-card', { generating: generating.has(shot.id) }]"
      >
        <div class="shot-head">
          <div class="shot-num">{{ shot.index + 1 }}</div>
          <div class="shot-title">{{ shot.title }}</div>
          <Tag v-if="shot.imageAssetId" type="success" size="sm">已生成</Tag>
          <Tag v-else-if="generating.has(shot.id)" type="warning" size="sm">生成中</Tag>
          <Tag v-else size="sm">待生成</Tag>
        </div>

        <div class="shot-image">
          <img
            v-if="imageUrls[shot.id]"
            class="zoomable"
            :src="imageUrls[shot.id]"
            :alt="shot.title"
            title="点击查看大图"
            @click="openLightbox(imageUrls[shot.id], 'image', shot.title)"
          />
          <div v-else-if="generating.has(shot.id)" class="placeholder generating-placeholder">
            <ProgressRing :progress="0.5" :size="60" :stroke-width="3" />
            <div class="progress-msg">{{ progress[shot.id] || '准备中...' }}</div>
          </div>
          <div v-else class="placeholder">
            <div class="placeholder-icon">🖼</div>
            <div class="placeholder-text">未生成</div>
          </div>
        </div>

        <div
          v-if="(shot.imageHistoryIds?.length ?? 0) > 0"
          class="history"
        >
          <span class="history-label">历史版本</span>
          <button
            v-for="hid in shot.imageHistoryIds"
            :key="hid"
            class="history-item"
            title="切回这个版本"
            @click="restoreHistory(shot, hid)"
          >
            <img
              v-if="historyUrls[hid]"
              class="zoomable"
              :src="historyUrls[hid]"
              alt=""
              title="查看大图并切回这个版本"
              @click="openLightbox(historyUrls[hid])"
            />
          </button>
        </div>

        <div class="shot-prompt">
          <div class="prompt-bar">
            <div class="prompt-label">配图提示词（可改）</div>
            <button class="reset-btn" @click="resetImagePrompt(shot)">恢复分镜原文</button>
          </div>
          <textarea
            class="prompt-edit"
            rows="4"
            :value="shot.imagePrompt ?? shot.visualPrompt"
            placeholder="描述这一镜要生成的画面..."
            @input="updateImagePrompt(shot, ($event.target as HTMLTextAreaElement).value)"
          />
        </div>

        <div class="shot-refs">
          <div class="refs-head">
            <span class="refs-label">
              锁定参考（人设 ×2 + 场景）
              <Tag v-if="shotLockPreview(shot).length" type="accent" size="sm">
                {{ shotLockPreview(shot).length }} 张
              </Tag>
            </span>
          </div>
          <div v-if="shotLockPreview(shot).length" class="refs-list">
            <div
              v-for="(item, i) in shotLockPreview(shot)"
              :key="`${shot.id}-lock-${i}`"
              class="ref-item inherited"
              :title="item.label"
            >
              <img
                v-if="item.url"
                class="zoomable"
                :src="item.url"
                alt=""
                title="点击查看大图"
                @click="openLightbox(item.url)"
              />
            </div>
          </div>
          <div v-else class="refs-empty">还没有人设/场景图。请先在上方生成。</div>
        </div>

        <div class="shot-refs">
          <div class="refs-head">
            <span class="refs-label">
              🖼 额外参考图
              <Tag v-if="(shot.referenceAssetIds?.length ?? 0) > 0" type="info" size="sm">
                {{ shot.referenceAssetIds?.length }} 张
              </Tag>
            </span>
            <div class="refs-actions">
              <button class="upload-mini" @click="picker = { mode: 'ref', shotId: shot.id }">
                资源库
              </button>
              <button class="upload-mini" @click="triggerRefUpload(shot.id)">
                ＋ 上传
              </button>
            </div>
          </div>
          <div
            v-if="(refUrls[shot.id]?.length ?? 0) > 0"
            class="refs-list"
          >
            <div
              v-for="(url, i) in (refUrls[shot.id] ?? [])"
              :key="`s-${i}`"
              class="ref-item"
            >
              <img
                class="zoomable"
                :src="url"
                alt=""
                title="点击查看大图"
                @click="openLightbox(url)"
              />
              <button
                v-if="shot.referenceAssetIds?.[i]"
                class="ref-del"
                @click="removeRef(shot, shot.referenceAssetIds[i])"
                title="从本分镜移除"
              >×</button>
            </div>
          </div>
        </div>

        <div class="shot-actions">
          <GradientButton
            v-if="!shot.imageAssetId"
            size="sm"
            icon="✨"
            :loading="generating.has(shot.id)"
            @click="generateOne(shot)"
          >
            生成图片
          </GradientButton>
          <template v-else>
            <GradientButton
              size="sm"
              type="ghost"
              icon="🔄"
              :loading="generating.has(shot.id)"
              @click="regenerate(shot)"
            >
              重新生成
            </GradientButton>
            <GradientButton
              size="sm"
              type="secondary"
              @click="generateOne(shot)"
            >
              再来一张
            </GradientButton>
          </template>
          <GradientButton
            size="sm"
            type="ghost"
            @click="picker = { mode: 'main', shotId: shot.id }"
          >
            资源库选用
          </GradientButton>
        </div>
      </GlassCard>
    </div>

    <AssetPicker
      :open="!!picker"
      kind="image"
      :multiple="picker?.mode === 'ref'"
      :title="picker?.mode === 'ref' ? '从资源库添加参考图' : '从资源库选用配图'"
      @close="picker = null"
      @confirm="onPickerConfirm"
    />
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
  align-items: center;
}
.head-actions :deep(.img-model) {
  flex: 0 1 220px;
}

.project-refs {
  margin-bottom: var(--space-4);
}
.cast-board {
  margin-bottom: var(--space-4);
}
.scene-head {
  margin-top: var(--space-4);
}
.cast-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-3);
}
.cast-card {
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.cast-thumb {
  aspect-ratio: 16/9;
  background: #111;
}
.cast-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cast-meta {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cast-name {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.cast-desc {
  width: 100%;
  resize: vertical;
  min-height: 48px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-2);
  font-size: 11px;
  line-height: 1.45;
  padding: 6px 8px;
  font-family: inherit;
}
.refs-empty {
  font-size: 11px;
  color: var(--color-text-4);
}
.pr-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}
.pr-head h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}
.pr-head p {
  font-size: 11px;
  color: var(--color-text-3);
  margin: 0;
}
.pr-head > div {
  flex: 1;
}
.upload-btn {
  background: var(--grad-primary-soft);
  color: var(--color-text-1);
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--color-accent);
  transition: all var(--duration-fast);
}
.upload-btn:hover {
  background: var(--grad-primary);
}
.pr-empty {
  font-size: 12px;
  color: var(--color-text-4);
  padding: var(--space-3);
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  border: 1px dashed var(--color-border);
}
.pr-list {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.pr-item {
  position: relative;
  width: 80px;
  height: 80px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--color-border);
}
.pr-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pr-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
}
.pr-del:hover {
  background: var(--color-error);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--space-4);
}
.shot-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.shot-card.generating {
  border-color: var(--color-accent);
}
.shot-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.shot-num {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  background: var(--grad-primary);
  color: white;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.shot-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.shot-image {
  position: relative;
  aspect-ratio: 16/9;
  background: var(--color-bg-2);
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--color-border);
}
.shot-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-4);
}
.generating-placeholder {
  background: var(--grad-primary-soft);
}
.placeholder-icon {
  font-size: 32px;
  opacity: 0.5;
}
.placeholder-text {
  font-size: 12px;
}
.progress-msg {
  font-size: 11px;
  color: var(--color-text-3);
  text-align: center;
  padding: 0 var(--space-2);
}
.history {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.history-label {
  font-size: 10px;
  color: var(--color-text-4);
  font-weight: 600;
}
.history-item {
  width: 36px;
  height: 36px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  padding: 0;
}
.history-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.history-item:hover {
  border-color: var(--color-accent);
}
.shot-prompt {
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.prompt-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.prompt-label {
  font-size: 10px;
  color: var(--color-text-4);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}
.reset-btn {
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.reset-btn:hover {
  background: var(--grad-primary-soft);
}
.prompt-edit {
  width: 100%;
  resize: vertical;
  min-height: 72px;
  background: var(--color-bg-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-2);
  font-size: 12px;
  line-height: 1.5;
  padding: 8px;
  font-family: inherit;
}
.prompt-edit:focus {
  outline: none;
  border-color: var(--color-accent);
}

.shot-refs {
  background: var(--color-bg-2);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.refs-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  gap: 8px;
}
.refs-label {
  font-size: 11px;
  color: var(--color-text-3);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}
.refs-actions {
  display: flex;
  gap: 4px;
}
.upload-mini {
  font-size: 11px;
  color: var(--color-accent-2);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}
.upload-mini:hover {
  background: var(--grad-primary-soft);
}
.refs-list {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ref-item {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--color-border);
}
.ref-item.inherited {
  border-style: dashed;
  border-color: var(--color-text-4);
  opacity: 0.7;
}
.ref-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ref-del {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 14px;
  height: 14px;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  border-radius: 50%;
  font-size: 10px;
  line-height: 1;
}
.ref-del:hover {
  background: var(--color-error);
}

.shot-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.shot-actions > * {
  flex: 1;
}
</style>
