<script setup lang="ts">
import { computed, ref } from 'vue'
import { galleryAlbums, galleryTemplates } from '@/utils/galleryTemplates'
import { openLightbox } from '@/composables/useLightbox'

const props = defineProps<{ selectable?: boolean; selected?: Set<string> }>()
const emit = defineEmits<{ pick: [id: string] }>()

type Item = (typeof galleryTemplates)[number]

const albumNotes = [
  '适用于单人特写、走位与情绪转折镜头',
  '适用于对白、冲突与暧昧拉扯的双人镜头',
  '适用于打斗、追逐与高能转折片段',
  '多视角设定板，用于锁定角色外观一致性',
]

const album = ref(-1)
const query = ref('')
const detail = ref<Item>(galleryTemplates[0])
const copyStatus = ref('')

const total = galleryTemplates.length

const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  return galleryAlbums
    .map((name, index) => ({
      name,
      index,
      note: albumNotes[index],
      total: galleryTemplates.filter((item) => item.album === index).length,
      items: galleryTemplates.filter((item) => {
        if (item.album !== index) return false
        if (album.value !== -1 && album.value !== index) return false
        return !q || item.title.toLowerCase().includes(q)
      }),
    }))
    .filter((group) => group.items.length > 0)
})

const activeGroup = computed(() => galleryAlbums[detail.value.album] || '')
const activeNote = computed(() => albumNotes[detail.value.album] || '')
const activeCode = computed(() => codeOf(detail.value))
const activePicked = computed(() => !!props.selected?.has(detail.value.id))

function codeOf(item: Item) {
  return item.id.slice('template:'.length)
}

function groupLabel(index: number) {
  return `GROUP ${String(index + 1).padStart(2, '0')}`
}

function isOn(item: Item) {
  if (props.selectable) return !!props.selected?.has(item.id)
  return detail.value.id === item.id
}

function show(item: Item) {
  detail.value = item
  copyStatus.value = ''
}

function onCard(item: Item) {
  show(item)
  if (props.selectable) emit('pick', item.id)
}

function peek(item: Item) {
  show(item)
  if (!item.prompt) openLightbox(item.url, 'image', item.title)
}

function enlarge() {
  openLightbox(detail.value.url, 'image', detail.value.title)
}

async function copyPrompt() {
  if (!detail.value.prompt) return
  try {
    await navigator.clipboard.writeText(detail.value.prompt)
    copyStatus.value = '已复制'
  } catch {
    copyStatus.value = '复制不可用，请选中文本手动复制'
  }
}
</script>

<template>
  <section class="template-album" :class="{ picker: selectable }">
    <header v-if="!selectable" class="gl-head">
      <div>
        <span class="kicker">图库模板 · 内置线稿</span>
        <h1>{{ total }} 张姿态参考，覆盖 90% 的短剧运镜</h1>
        <p>内置线稿姿态与站位。在画布节点的「资产库」打开图库模板并选用后，这张图会作为参考图进入当前项目。</p>
      </div>
      <span class="badge">{{ total }} 张 · 分 {{ galleryAlbums.length }} 组</span>
    </header>

    <div class="gl-jump">
      <span class="kicker plain">快速定位</span>
      <button type="button" class="chip" :class="{ on: album === -1 }" :aria-pressed="album === -1" @click="album = -1">
        全部 {{ total }}
      </button>
      <button
        v-for="(name, i) in galleryAlbums"
        :key="name"
        type="button"
        class="chip"
        :class="{ on: album === i }"
        :aria-pressed="album === i"
        @click="album = i"
      >
        {{ name }} {{ galleryTemplates.filter((item) => item.album === i).length }}
      </button>
      <label class="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></svg>
        <input v-model="query" class="input" type="search" placeholder="搜索姿势名称" aria-label="搜索姿势名称" />
      </label>
    </div>

    <div class="gl-layout">
      <div>
        <p v-if="groups.length === 0" class="empty">没有名称匹配的模板</p>
        <section v-for="group in groups" :key="group.name" class="gl-group">
          <div class="gl-group-h">
            <span class="kicker plain">{{ groupLabel(group.index) }}</span>
            <h2>{{ group.name }}</h2>
            <span class="c">{{ group.total }} 张</span>
            <span class="d">{{ group.note }}</span>
          </div>
          <div class="gl-grid">
            <article
              v-for="item in group.items"
              :key="item.id"
              class="gl-card"
              :class="{ on: isOn(item), board: item.album === 3 }"
            >
              <button
                type="button"
                class="gl-hit"
                :aria-label="selectable ? `选择${item.title}` : `查看${item.title}`"
                :aria-pressed="selectable ? isOn(item) : undefined"
                @click="onCard(item)"
              >
                <span v-if="isOn(item)" class="ok" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
                </span>
                <div class="th">
                  <img :class="{ 'nb-lineart': item.album !== 3 }" :src="item.url" :alt="item.title" loading="lazy" />
                  <span class="idx">{{ codeOf(item) }}</span>
                </div>
                <div class="nm">{{ item.title }}</div>
              </button>
              <button v-if="selectable" type="button" class="gl-peek" @click="peek(item)">
                {{ item.prompt ? '查看 · 提示词' : '放大' }}
              </button>
            </article>
          </div>
        </section>
      </div>

      <aside v-if="detail" class="gl-detail">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title"><i class="sq"></i>模板详情</div>
            <span class="badge" :class="{ accent: !selectable || activePicked }">
              {{ !selectable || activePicked ? '已选中' : '未选用' }}
            </span>
          </div>
          <div class="panel-body">
            <div class="big" :class="{ sheet: detail.album === 3 }">
              <img
                :class="{ ink: detail.album !== 3 }"
                :src="detail.url"
                :alt="detail.title"
              />
              <span class="frame"></span>
              <span class="fid">{{ activeCode }}</span>
            </div>

            <div class="stack">
              <div class="h3">{{ detail.title }}</div>
              <div class="tags">
                <span class="tag">{{ groupLabel(detail.album) }}</span>
                <span class="tag">{{ activeGroup }}</span>
              </div>
            </div>

            <div class="divider"></div>

            <div class="stack">
              <span class="label">用途说明</span>
              <p class="use">{{ activeNote }}。可在画布节点的「资产库 → 图库模板」里选用这张参考图。</p>
            </div>

            <template v-if="detail.prompt">
              <div class="divider"></div>
              <div class="stack">
                <div class="spread">
                  <span class="label">可复制提示词</span>
                  <button type="button" class="outline" @click="copyPrompt">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
                    复制
                  </button>
                </div>
                <div class="gl-prompt">{{ detail.prompt }}</div>
                <p v-if="copyStatus" class="status" role="status">{{ copyStatus }}</p>
              </div>
            </template>

            <div class="divider"></div>

            <div class="stack">
              <button v-if="selectable" type="button" class="use-btn" @click="emit('pick', detail.id)">
                {{ activePicked ? '取消选用' : '选用这张' }}
              </button>
              <button type="button" class="outline block" @click="enlarge">放大查看</button>
              <span class="hint">
                {{
                  selectable
                    ? '点选卡片会勾选这张模板。确认导入请用窗口底部的「选用」。'
                    : '在画布节点的资产库中打开图库模板，选用后写入当前项目。'
                }}
              </span>
            </div>
          </div>
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.template-album {
  container-type: inline-size;
  max-width: 1440px;
  min-width: 0;
  color: var(--nb-t1);
}
.template-album.picker {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 16px;
}

.gl-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 0 12px;
}
.gl-head h1 {
  margin: 6px 0 8px;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.15;
}
.gl-head p {
  margin: 0;
  max-width: 620px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--nb-t3);
}
.kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--nb-t3);
}
.kicker::before {
  content: "";
  width: 14px;
  height: 1px;
  background: var(--nb-line-accent);
}
.kicker.plain::before { display: none; }
.badge {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--nb-line-2);
  border-radius: 6px;
  background: var(--nb-bg-3);
  color: var(--nb-t2);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
}
.badge.accent {
  background: var(--nb-accent-soft);
  border-color: var(--nb-line-accent);
  color: var(--nb-accent-text, var(--nb-accent));
}

.gl-jump {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--nb-line-1);
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--nb-line-2);
  border-radius: 999px;
  background: var(--nb-bg-3);
  color: var(--nb-t2);
  font-size: 11px;
}
.chip:hover { border-color: var(--nb-line-3); color: var(--nb-t1); }
.chip.on {
  background: var(--nb-accent-soft);
  border-color: var(--nb-line-accent);
  color: var(--nb-accent);
}
.search {
  position: relative;
  display: flex;
  align-items: center;
  width: 210px;
  margin-left: auto;
}
.search svg {
  position: absolute;
  left: 8px;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--nb-t4);
  stroke-width: 1.8;
  stroke-linecap: round;
  pointer-events: none;
}
.search .input {
  width: 100%;
  height: 32px;
  padding: 0 10px 0 30px;
  border: 1px solid var(--nb-line-2);
  border-radius: 10px;
  background: var(--nb-bg-inset);
  color: var(--nb-t1);
  font-size: 13px;
  outline: none;
}
.search .input::placeholder { color: var(--nb-t4); }
.search .input:hover { border-color: var(--nb-line-3); }
.search .input:focus {
  border-color: var(--nb-accent);
  box-shadow: 0 0 0 3px var(--nb-accent-soft);
}

.gl-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 20px;
  align-items: start;
  margin-top: 20px;
}
.gl-group { margin-bottom: 32px; }
.gl-group-h {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.gl-group-h h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--nb-t1);
}
.gl-group-h .c {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--nb-t4);
}
.gl-group-h .d {
  margin-left: auto;
  font-size: 12px;
  color: var(--nb-t3);
}
.gl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(146px, 1fr));
  gap: 8px;
}
.gl-card {
  position: relative;
  display: grid;
  border: 1px solid var(--nb-line-2);
  border-radius: 10px;
  background: var(--nb-bg-2);
  overflow: hidden;
  transition: border-color 200ms ease, transform 200ms ease, box-shadow 200ms ease;
}
.gl-card:hover {
  border-color: var(--nb-line-3);
  transform: translateY(-2px);
  box-shadow: var(--nb-e2);
}
.gl-card.on {
  border-color: var(--nb-accent);
  box-shadow: var(--nb-e-glow, 0 0 0 1px var(--nb-line-accent), 0 0 28px var(--nb-accent-glow));
}
.gl-hit {
  display: grid;
  width: 100%;
  padding: 0;
  text-align: left;
  color: inherit;
  cursor: pointer;
}
.th {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--nb-bg-inset);
  border-bottom: 1px solid var(--nb-line-1);
  overflow: hidden;
}
.board .th { aspect-ratio: 2 / 1; }
.th img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 6px;
}
.nb-lineart {
  filter: var(--nb-lineart-filter, none);
  mix-blend-mode: var(--nb-lineart-blend, normal);
}
.gl-card.on .th { background: var(--nb-accent-wash-2, var(--nb-accent-wash)); }
.nm {
  padding: 6px 8px 10px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--nb-t2);
}
.gl-card.on .nm { color: var(--nb-t1); }
.idx {
  position: absolute;
  top: 5px;
  left: 5px;
  padding: 1px 5px;
  border: 1px solid var(--nb-chip-line, var(--nb-line-3));
  border-radius: 4px;
  background: var(--nb-chip-bg, var(--nb-bg-3));
  color: var(--nb-chip-ink, var(--nb-t2));
  font-family: var(--font-mono);
  font-size: 10px;
}
.ok {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--nb-accent);
  color: var(--nb-accent-ink);
}
.ok svg {
  width: 9px;
  height: 9px;
  fill: none;
  stroke: currentColor;
  stroke-width: 3.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.gl-peek {
  padding: 0 8px 8px;
  text-align: right;
  font-size: 11px;
  color: var(--nb-accent-text, var(--nb-accent));
}
.empty {
  margin: 12px 0 24px;
  color: var(--nb-t3);
  font-size: 13px;
}

.gl-detail { position: sticky; top: 16px; }
.panel {
  background: var(--nb-bg-2);
  border: 1px solid var(--nb-line-2);
  border-radius: 14px;
  overflow: hidden;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--nb-line-1);
  background: var(--nb-panel-sheen, transparent);
}
.panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}
.panel-title .sq {
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: var(--nb-accent);
}
.panel-body { padding: 12px; }
.big {
  position: relative;
  margin-bottom: 8px;
  overflow: hidden;
  border: 1px solid var(--nb-line-2);
  border-radius: 10px;
  background: var(--nb-bg-inset);
}
.big img {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: contain;
  padding: 12px;
}
.big.sheet img { aspect-ratio: 16 / 9; }
.big img.ink { filter: var(--nb-lineart-ink-filter, none); }
.frame { position: absolute; inset: 0; pointer-events: none; }
.frame::before,
.frame::after {
  content: "";
  position: absolute;
  width: 14px;
  height: 14px;
  border: 1px solid var(--nb-line-accent);
}
.frame::before { top: 8px; left: 8px; border-right: none; border-bottom: none; }
.frame::after { right: 8px; bottom: 8px; border-left: none; border-top: none; }
.fid {
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 2px 6px;
  border: 1px solid var(--nb-chip-line, var(--nb-line-3));
  border-radius: 4px;
  background: var(--nb-chip-bg, var(--nb-bg-3));
  color: var(--nb-chip-ink, var(--nb-t2));
  font-family: var(--font-mono);
  font-size: 10px;
}
.stack { display: grid; gap: 6px; }
.h3 {
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
}
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--nb-bg-4);
  color: var(--nb-t3);
  font-family: var(--font-mono);
  font-size: 10px;
}
.divider { height: 1px; margin: 12px 0; background: var(--nb-line-1); }
.label {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--nb-t3);
}
.use {
  margin: 0;
  font-size: 12px;
  line-height: 1.75;
  color: var(--nb-t2);
}
.spread { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gl-prompt {
  max-height: 220px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--nb-line-2);
  border-radius: 10px;
  background: var(--nb-bg-inset);
  color: var(--nb-t2);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}
.status { margin: 0; font-size: 11px; color: var(--nb-accent-text, var(--nb-accent)); }
.hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--nb-t3);
}
.outline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--nb-line-3);
  border-radius: 6px;
  background: transparent;
  color: var(--nb-t2);
  font-size: 11px;
}
.outline svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.outline:hover { background: var(--nb-bg-3); color: var(--nb-t1); }
.outline.block { width: 100%; }
.use-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 32px;
  border: 1px solid var(--nb-accent);
  border-radius: 10px;
  background: var(--nb-accent);
  color: var(--nb-accent-ink);
  font-size: 12px;
  font-weight: 600;
}
.use-btn:hover { filter: brightness(1.08); }

@container (max-width: 860px) {
  .gl-layout { grid-template-columns: 1fr; }
  .gl-detail { position: static; }
  .gl-group-h { flex-wrap: wrap; }
  .gl-group-h .d { margin-left: 0; width: 100%; }
  .search { width: 100%; margin-left: 0; }
}
</style>
