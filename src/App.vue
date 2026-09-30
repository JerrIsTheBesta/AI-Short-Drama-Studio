<script setup lang="ts">
import { onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useProjectStore, useAssetsStore, useSettingsStore } from '@/stores'
import AppLayout from '@/components/layout/AppLayout.vue'
import TitleBar from '@/components/layout/TitleBar.vue'
import ToastContainer from '@/components/common/ToastContainer.vue'
import ImageLightbox from '@/components/common/ImageLightbox.vue'
import NoticeBanner from '@/components/common/NoticeBanner.vue'

const route = useRoute()
const project = useProjectStore()
const assets = useAssetsStore()
const settings = useSettingsStore()

const showLayout = computed(
  () =>
    route.name !== 'home' &&
    route.name !== 'studio' &&
    route.name !== 'smart-speech' &&
    route.name !== 'settings'
)

onMounted(async () => {
  await settings.ensureHydrated()
  await project.ensureLoaded()
  await assets.refresh()
  project.startAutoSave()
})
</script>

<template>
  <div class="app-root">
    <TitleBar />
    <NoticeBanner />
    <div class="app-body">
      <ToastContainer />
      <ImageLightbox />
      <template v-if="showLayout">
        <AppLayout>
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </AppLayout>
      </template>
      <template v-else>
        <router-view />
      </template>
    </div>
  </div>
</template>

<style scoped>
.app-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.app-body {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}
</style>

