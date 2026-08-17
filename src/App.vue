<script setup lang="ts">
import { onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useProjectStore, useAssetsStore } from '@/stores'
import AppLayout from '@/components/layout/AppLayout.vue'
import ToastContainer from '@/components/common/ToastContainer.vue'

const route = useRoute()
const project = useProjectStore()
const assets = useAssetsStore()

const showLayout = computed(() => route.name !== 'home' && route.name !== 'studio')

onMounted(async () => {
  await assets.refresh()
  await project.ensureLoaded()
  project.startAutoSave()
})
</script>

<template>
  <ToastContainer />
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
</template>
