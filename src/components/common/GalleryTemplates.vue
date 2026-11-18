<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { galleryAlbums, galleryTemplates } from '@/utils/galleryTemplates'
import { openLightbox } from '@/composables/useLightbox'

const props = defineProps<{ selectable?: boolean; selected?: Set<string> }>()
const emit = defineEmits<{ pick: [id: string] }>()
const album = ref(0)
const items = computed(() => galleryTemplates.filter(item => item.album === album.value))
const detail = ref<(typeof galleryTemplates)[number]>()
const previewDialog = ref<HTMLDialogElement>()
const copyStatus = ref('')

async function preview(item: (typeof galleryTemplates)[number]) {
  if (!item.prompt) return openLightbox(item.url, 'image', item.title)
  detail.value = item
  copyStatus.value = ''
  await nextTick()
  previewDialog.value?.showModal()
}

async function copyPrompt() {
  if (!detail.value?.prompt) return
  try {
    await navigator.clipboard.writeText(detail.value.prompt)
    copyStatus.value = '已复制'
  } catch {
    copyStatus.value = '复制不可用，请选中文本手动复制'
  }
}
</script>

<template>
  <section class="template-album">
    <header v-if="!props.selectable">
      <small>构图参考 · 内置图册</small>
      <h1>图库模板</h1>
      <p>从单人姿势到双人调度，先找到合适的动作和空间关系。可在画布节点的「资产库」直接选用。</p>
    </header>
    <div class="album-tabs" aria-label="参考图册">
      <button v-for="(name, i) in galleryAlbums" :key="name" type="button" :aria-pressed="album === i" @click="album = i">{{ name }} · {{ galleryTemplates.filter(item => item.album === i).length }}</button>
    </div>
    <div class="album-grid">
      <article v-for="(item, i) in items" :key="item.id" class="pose-card" :class="{ picked: selected?.has(item.id), board: item.prompt }">
        <button type="button" class="pose-image" :aria-label="selectable ? `选择${item.title}` : `放大${item.title}`" :aria-pressed="selectable ? selected?.has(item.id) ?? false : undefined" @click="selectable ? emit('pick', item.id) : preview(item)">
          <img :src="item.url" :alt="item.title" loading="lazy" />
        </button>
        <footer><span><small>{{ String(i + 1).padStart(2, '0') }}</small> {{ item.title }}</span><button v-if="selectable || item.prompt" type="button" @click="preview(item)">{{ item.prompt ? '查看 · 提示词' : '放大' }}</button></footer>
      </article>
    </div>
    <dialog ref="previewDialog" class="template-detail" aria-label="定妆图与生成提示词">
      <template v-if="detail">
        <div class="detail-bar"><strong>{{ detail.title }}</strong><button type="button" autofocus @click="previewDialog?.close()">关闭</button></div>
        <img :src="detail.url" :alt="detail.title" />
        <div class="detail-bar"><strong>生成提示词</strong><button type="button" @click="copyPrompt">复制提示词</button></div>
        <textarea readonly :value="detail.prompt" rows="5" aria-label="生成提示词" />
        <p role="status">{{ copyStatus }}</p>
      </template>
    </dialog>
  </section>
</template>

<style scoped>
.template-album { padding: 20px; min-height: 0; overflow-y: auto; }
header { padding: 26px 28px; border-radius: 16px; background: linear-gradient(120deg, #22203a, #171821); margin-bottom: 18px; }
h1 { margin: 6px 0 8px; font-size: 28px; }
p { margin: 0; color: #c2c0d1; }
small { color: #a8a5bc; }
.album-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.album-tabs button { padding: 7px 14px; border-radius: 9px; background: #22232b; color: #dad9e6; }
.album-tabs button[aria-pressed="true"] { background: #514580; color: white; }
.album-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 185px), 1fr)); grid-auto-rows: max-content; gap: 14px; }
.pose-card { overflow: hidden; border: 1px solid #34343e; border-radius: 12px; background: #1c1c24; }
.pose-card.picked { border-color: #aa96ff; box-shadow: inset 0 0 0 1px #aa96ff; }
.pose-image { display: block; width: 100%; padding: 0; background: #fff; height: clamp(174px, 24vh, 250px); cursor: pointer; }
.pose-image img { display: block; width: 100%; height: 100%; object-fit: contain; }
footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 42px; padding: 6px 10px; color: #e9e7f2; }
footer button { font-size: 12px; color: #c5b6ff; }
.board { grid-column: 1 / -1; width: min(100%, 640px); }
.board .pose-image { height: auto; aspect-ratio: 16 / 9; }
.template-detail { width: min(900px, 94vw); max-height: 90dvh; overflow: auto; padding: 16px; border: 1px solid #474354; border-radius: 14px; background: #1c1c24; color: #f4f1ff; }
.template-detail::backdrop { background: #000b; }
.template-detail img { display: block; width: 100%; max-height: 56dvh; object-fit: contain; background: #121218; }
.detail-bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 0; }
.detail-bar button { padding: 6px 11px; background: #514580; color: white; border-radius: 7px; }
.template-detail textarea { box-sizing: border-box; width: 100%; padding: 10px; background: #121218; color: #fff; border: 1px solid #474354; border-radius: 8px; resize: vertical; }
</style>
