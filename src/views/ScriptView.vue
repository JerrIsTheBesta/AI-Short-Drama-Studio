<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useProjectStore, useToastStore, useSettingsStore, useAssetsStore } from '@/stores'
import GlassCard from '@/components/common/GlassCard.vue'
import GradientButton from '@/components/common/GradientButton.vue'
import Tag from '@/components/common/Tag.vue'
import type { Script, VisualStyle, AspectRatio } from '@/types'

const MAX_PRODUCT_IMAGES = 5

const router = useRouter()
const project = useProjectStore()
const toast = useToastStore()
const settings = useSettingsStore()
const assets = useAssetsStore()

const topic = ref('')
const content = ref('')
const style = ref<VisualStyle>('cinematic')
const aspectRatio = ref<AspectRatio>('16:9')
const shotDuration = ref(5)
const keywords = ref('')
const productIds = ref<string[]>([])
const productUrls = ref<Record<string, string>>({})

const presets = [
  {
    name: '夏日旅行 vlog',
    topic: '厦门三日游',
    content: `清晨的鼓浪屿，海风轻拂，远处传来悠扬的钢琴声。
午后骑行在环岛路，一边是椰林，一边是蔚蓝大海。
傍晚曾厝垵的小巷里，灯笼亮起，空气中飘着沙茶面的香气。
夜晚的海滩，篝火闪烁，星空格外清澈。`
  },
  {
    name: '产品发布',
    topic: '智能耳机新品上市',
    content: `开场：极简线条勾勒耳机轮廓，金属质感彰显品质。
核心：降噪技术演示，嘈杂街头瞬间安静。
体验：佩戴轻盈，长时间无负担。
续航：30 小时超长续航，告别频繁充电。
结尾：自由掌控，静享每一刻。`
  },
  {
    name: '知识科普',
    topic: '一分钟了解黑洞',
    content: `黑洞是一个引力极强的天体，连光都无法逃脱。
它由大质量恒星坍缩形成，密度无限大。
事件视界是黑洞的边界，越过就无法返回。
霍金辐射告诉我们，黑洞也会缓慢蒸发。
人类对黑洞的探索从未停止。`
  }
]

const styleOptions: { value: VisualStyle; label: string; desc: string }[] = [
  { value: 'cinematic', label: '🎬 电影', desc: '电影感调色' },
  { value: 'anime', label: '🌸 动漫', desc: '日系动画' },
  { value: 'photorealistic', label: '📸 写实', desc: '真实摄影' },
  { value: '3d-render', label: '💎 3D 渲染', desc: 'C4D/Blender' },
  { value: 'oil-painting', label: '🎨 油画', desc: '古典油画' },
  { value: 'watercolor', label: '🖌 水彩', desc: '水彩画' },
  { value: 'pixel-art', label: '👾 像素', desc: '复古像素' },
  { value: 'ink-wash', label: '🖋 水墨', desc: '中国水墨' }
]

const aspectOptions: { value: AspectRatio; label: string }[] = [
  { value: '16:9', label: '横屏 16:9' },
  { value: '9:16', label: '竖屏 9:16' },
  { value: '1:1', label: '方形 1:1' },
  { value: '4:3', label: '传统 4:3' },
  { value: '21:9', label: '影院 21:9' }
]

onMounted(async () => {
  if (project.current?.script) {
    const s = project.current.script
    topic.value = s.topic
    content.value = s.content
    style.value = s.style
    aspectRatio.value = s.aspectRatio
    shotDuration.value = s.shotDuration
    keywords.value = s.keywords.join(', ')
    productIds.value = [...(s.referenceAssetIds ?? [])].slice(0, MAX_PRODUCT_IMAGES)
    for (const id of productIds.value) {
      const url = await assets.getUrl(id)
      if (url) productUrls.value[id] = url
    }
  } else if (!topic.value && !content.value) {
    const p = presets[0]
    topic.value = p.topic
    content.value = p.content
  }
})

const wordCount = computed(() => content.value.replace(/\s/g, '').length)
const estimatedShots = computed(() => {
  const sentences = content.value.split(/[。！？!?\n]+/).filter((s) => s.trim().length > 4)
  return Math.max(1, Math.min(12, sentences.length))
})
const estimatedDuration = computed(() => estimatedShots.value * shotDuration.value)

function applyPreset(p: typeof presets[0]) {
  topic.value = p.topic
  content.value = p.content
  toast.info(`已套用：${p.name}`)
}

async function saveAndNext() {
  if (!content.value.trim() && productIds.value.length === 0) {
    toast.warn('请填写文案，或上传产品图（电商带货可只传图）')
    return
  }
  if (!project.current) {
    project.create(topic.value || '未命名项目')
  }

  const prev = project.current?.script
  const script: Script = {
    id: prev?.id ?? 's_' + Date.now().toString(36),
    topic: topic.value,
    content: content.value,
    keywords: keywords.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    style: style.value,
    aspectRatio: aspectRatio.value,
    shotDuration: shotDuration.value,
    aesthetic: prev?.aesthetic,
    referenceAssetIds: productIds.value,
    createdAt: prev?.createdAt ?? Date.now()
  }

  project.setScript(script)
  project.setAspectRatio(aspectRatio.value)
  await project.save()
  toast.success('文案已保存')
  router.push('/storyboard')
}

async function generateAndNext() {
  if (!content.value.trim() && productIds.value.length === 0) {
    toast.warn('请填写文案，或上传产品图')
    return
  }
  await saveAndNext()
}

function pickProductImages() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = async () => {
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    const room = MAX_PRODUCT_IMAGES - productIds.value.length
    if (room <= 0) {
      toast.warn(`最多 ${MAX_PRODUCT_IMAGES} 张产品图`)
      return
    }
    let added = 0
    for (const file of files.slice(0, room)) {
      const asset = await assets.add(file, 'image', 'uploaded', {
        filename: file.name,
        projectId: project.current?.id
      })
      productIds.value = [...productIds.value, asset.id]
      const url = await assets.getUrl(asset.id)
      if (url) productUrls.value[asset.id] = url
      added++
    }
    await persistProductIds()
    toast.success(`已添加 ${added} 张产品图`)
  }
  input.click()
}

async function persistProductIds() {
  if (!project.current?.script) return
  project.setScript({
    ...project.current.script,
    referenceAssetIds: productIds.value
  })
  await project.save()
}

async function removeProductImage(id: string) {
  productIds.value = productIds.value.filter((x) => x !== id)
  await persistProductIds()
}
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>📝 文案准备</h1>
        <p>输入主题和文案。电商带货可上传产品图（最多 5 张），分镜会按真实产品来写。</p>
      </div>
      <div class="head-actions">
        <GradientButton type="ghost" @click="router.push('/')">← 返回</GradientButton>
        <GradientButton icon="✨" @click="generateAndNext">保存并生成分镜</GradientButton>
      </div>
    </header>

    <div class="layout">
      <div class="main">
        <GlassCard padding="lg">
          <label class="field">
            <span class="label">视频主题</span>
            <input v-model="topic" class="input" placeholder="例如：厦门三日游 / 某品牌口红带货" />
          </label>

          <div class="field">
            <div class="label">
              <span>产品图（可选，最多 {{ MAX_PRODUCT_IMAGES }} 张）</span>
              <span class="counter">{{ productIds.length }}/{{ MAX_PRODUCT_IMAGES }} · 多模态模型会看图写脚本</span>
            </div>
            <p class="hint" style="margin-bottom: 8px;">
              电商带货请上传产品实拍/白底图。没有文案也可以，AI 会按产品图撰写口播和分镜。
            </p>
            <div class="product-row">
              <div v-for="id in productIds" :key="id" class="product-thumb">
                <img v-if="productUrls[id]" :src="productUrls[id]" alt="产品图" />
                <button class="product-del" title="移除" @click="removeProductImage(id)">×</button>
              </div>
              <button
                v-if="productIds.length < MAX_PRODUCT_IMAGES"
                class="product-add"
                @click="pickProductImages"
              >
                ＋ 上传产品图
              </button>
            </div>
          </div>

          <label class="field">
            <span class="label">
              文案内容
              <span class="counter">{{ wordCount }} 字 · 预计 {{ estimatedShots }} 个分镜 · 总时长 {{ estimatedDuration }}s</span>
              <span class="counter-hint" style="margin-left: 8px; color: var(--color-text-4); font-size: 10px;">
                （每段视频 5-10s，最终被自动 clamp）
              </span>
            </span>
            <textarea
              v-model="content"
              class="textarea"
              rows="12"
              placeholder="把视频要讲的内容写在这里。可以分段落，每一段会对应一个或多个分镜..."
            />
          </label>

          <label class="field">
            <span class="label">关键词（可选，用逗号分隔）</span>
            <input v-model="keywords" class="input" placeholder="例如：日落, 沙滩, 美食" />
          </label>
        </GlassCard>

        <GlassCard padding="md" class="presets">
          <div class="presets-head">
            <span>📋 一键套用示例</span>
          </div>
          <div class="preset-grid">
            <button
              v-for="p in presets"
              :key="p.name"
              class="preset"
              @click="applyPreset(p)"
            >
              <div class="preset-name">{{ p.name }}</div>
              <div class="preset-topic">{{ p.topic }}</div>
            </button>
          </div>
        </GlassCard>
      </div>

      <aside class="side">
        <GlassCard padding="md">
          <h3>画面风格</h3>
          <div class="style-grid">
            <button
              v-for="s in styleOptions"
              :key="s.value"
              class="style"
              :class="{ active: style === s.value }"
              @click="style = s.value"
            >
              <div class="style-label">{{ s.label }}</div>
              <div class="style-desc">{{ s.desc }}</div>
            </button>
          </div>
        </GlassCard>

        <GlassCard padding="md">
          <h3>视频比例</h3>
          <div class="aspect-list">
            <button
              v-for="a in aspectOptions"
              :key="a.value"
              class="aspect"
              :class="{ active: aspectRatio === a.value }"
              @click="aspectRatio = a.value"
            >
              <div class="aspect-visual" :data-ar="a.value">
                <div class="aspect-box" />
              </div>
              <div class="aspect-label">{{ a.label }}</div>
            </button>
          </div>
        </GlassCard>

        <GlassCard padding="md">
          <h3>分镜时长参考</h3>
          <div class="slider-row">
            <input
              v-model.number="shotDuration"
              type="range"
              min="5"
              max="10"
              step="1"
              class="slider"
            />
            <div class="slider-value gradient-text">{{ shotDuration }}s</div>
          </div>
          <p class="hint">整体节奏参考。AI 会按每镜口播与画面单独策划 5–10 秒，不会所有镜头同一秒数。</p>
        </GlassCard>

        <GlassCard padding="md" class="summary">
          <h3>📊 概览</h3>
          <div class="kv">
            <span>总字数</span><b>{{ wordCount }}</b>
          </div>
          <div class="kv">
            <span>预计分镜数</span><b>{{ estimatedShots }}</b>
          </div>
          <div class="kv">
            <span>预计总时长</span><b>{{ estimatedDuration }}s</b>
          </div>
          <div class="kv">
            <span>AI 模式</span>
            <Tag :type="settings.config.aiMode === 'real' ? 'success' : 'warning'" size="sm">
              {{ settings.config.aiMode === 'real' ? '真实 API' : '演示' }}
            </Tag>
          </div>
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
  margin-bottom: var(--space-6);
  gap: var(--space-4);
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
  flex-shrink: 0;
}

.layout {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: var(--space-5);
}
.main {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.field {
  display: block;
  margin-bottom: var(--space-4);
}
.field:last-child {
  margin-bottom: 0;
}
.label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--color-text-3);
  margin-bottom: 6px;
  font-weight: 500;
}
.counter {
  font-size: 11px;
  color: var(--color-text-4);
}
.input,
.textarea {
  width: 100%;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  font-size: 13px;
  color: var(--color-text-1);
  outline: none;
  transition: all var(--duration-fast);
  font-family: inherit;
  resize: vertical;
}
.textarea {
  line-height: 1.7;
  min-height: 200px;
}
.input:focus,
.textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.15);
}

.presets-head {
  font-size: 13px;
  color: var(--color-text-2);
  font-weight: 600;
  margin-bottom: var(--space-3);
}
.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-2);
}
.preset {
  text-align: left;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  transition: all var(--duration-fast);
}
.preset:hover {
  border-color: var(--color-accent);
  background: var(--grad-primary-soft);
}
.preset-name {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}
.preset-topic {
  font-size: 11px;
  color: var(--color-text-3);
}

.side h3 {
  font-size: 13px;
  margin: 0 0 var(--space-3);
  font-weight: 600;
  color: var(--color-text-2);
}
.style-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2);
}
.style {
  text-align: left;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  transition: all var(--duration-fast);
}
.style:hover {
  border-color: var(--color-border-strong);
}
.style.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
}
.style-label {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
}
.style-desc {
  font-size: 10px;
  color: var(--color-text-4);
}

.aspect-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.aspect {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 6px 10px;
  background: var(--color-bg-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  transition: all var(--duration-fast);
}
.aspect:hover {
  border-color: var(--color-border-strong);
}
.aspect.active {
  background: var(--grad-primary-soft);
  border-color: var(--color-accent);
}
.aspect-visual {
  width: 36px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 2px;
}
.aspect-box {
  background: currentColor;
  color: var(--color-text-3);
}
.aspect-visual[data-ar='16:9'] .aspect-box { width: 32px; height: 18px; }
.aspect-visual[data-ar='9:16'] .aspect-box { width: 14px; height: 24px; }
.aspect-visual[data-ar='1:1'] .aspect-box { width: 22px; height: 22px; }
.aspect-visual[data-ar='4:3'] .aspect-box { width: 28px; height: 21px; }
.aspect-visual[data-ar='21:9'] .aspect-box { width: 36px; height: 16px; }
.aspect-label {
  font-size: 12px;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: var(--color-bg-2);
  border-radius: var(--radius-full);
  outline: none;
}
.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--grad-primary);
  cursor: pointer;
  border: 2px solid white;
  box-shadow: 0 0 8px rgba(124, 58, 237, 0.4);
}
.slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--grad-primary);
  cursor: pointer;
  border: 2px solid white;
}
.slider-value {
  font-size: 16px;
  font-weight: 700;
  min-width: 50px;
  text-align: right;
}
.hint {
  font-size: 11px;
  color: var(--color-text-4);
  margin: 6px 0 0;
}
.product-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.product-thumb {
  position: relative;
  width: 88px;
  height: 88px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--color-border);
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
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 14px;
  line-height: 1;
}
.product-del:hover {
  background: var(--color-error);
}
.product-add {
  width: 88px;
  height: 88px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-bg-2);
  color: var(--color-text-3);
  font-size: 12px;
  line-height: 1.3;
  padding: 8px;
}
.product-add:hover {
  border-color: var(--color-accent);
  color: var(--color-text-1);
  background: var(--grad-primary-soft);
}

.summary .kv {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 6px;
  color: var(--color-text-3);
}
.summary .kv b {
  color: var(--color-text-1);
  font-weight: 600;
}
</style>
