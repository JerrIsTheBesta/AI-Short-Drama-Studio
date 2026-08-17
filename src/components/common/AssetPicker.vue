<script setup lang="ts">
/**
 * 从资源库挑选已有图片 / 视频
 */
import { ref, computed, watch } from 'vue'
import { useAssetsStore, useProjectStore } from '@/stores'
import type { Asset, AssetKind, ID } from '@/types'
import { assetContext } from '@/utils/assetLabel'
import GradientButton from '@/components/common/GradientButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Tag from '@/components/common/Tag.vue'

const props = defineProps<{
  open: boolean
  kind?: AssetKind | 'all'
  multiple?: boolean
  title?: string
  /** 已经选中的（打开时预勾） */
  selectedIds?: ID[]
}>()

const emit = defineEmits<{
  close: []
  confirm: [ids: ID[]]
}>()

const assets = useAssetsStore()
const project = useProjectStore()
const picked = ref<Set<ID>>(new Set())
const urls = ref<Record<string, string>>({})
const loading = ref(false)

const kind = computed(() => props.kind ?? 'image')

const list = computed(() => {
  const items =
    kind.value === 'all'
      ? assets.all
      : assets.all.filter((a) => a.kind === kind.value)
  return items
})

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    picked.value = new Set(props.selectedIds ?? [])
    loading.value = true
    try {
      await assets.refresh()
      const next: Record<string, string> = {}
      for (const a of list.value) {
        if (a.kind === 'video') {
          const u = await assets.ensureThumb(a.id)
          if (u) next[a.id] = u
        } else {
          const u = await assets.getUrl(a.id)
          if (u) next[a.id] = u
        }
      }
      urls.value = next
    } finally {
      loading.value = false
    }
  }
)

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
              <p>已生成/上传的素材都在这里，不会因为重新生成而丢失</p>
            </div>
            <button class="close" @click="emit('close')">×</button>
          </header>

          <div v-if="loading" class="loading">加载资源库...</div>
          <EmptyState
            v-else-if="list.length === 0"
            icon="📦"
            title="资源库是空的"
            description="生成图片/视频后会自动进入资源库"
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
              </div>
              <div class="meta">
                <div class="name" :title="labelOf(a).title">{{ labelOf(a).title }}</div>
                <div class="sub">
                  <Tag size="sm" :type="a.source === 'ai-generated' ? 'accent' : 'info'">
                    {{ a.source === 'ai-generated' ? 'AI' : '上传' }}
                  </Tag>
                  {{ labelOf(a).projectName }}
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
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text-1);
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
