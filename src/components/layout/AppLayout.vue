<script setup lang="ts">
import TopBar from './TopBar.vue'
import StepNav from './StepNav.vue'
</script>

<template>
  <div class="layout">
    <TopBar />
    <div class="main">
      <StepNav />
      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}
.main {
  display: flex;
  flex: 1;
  min-height: 0;
}
.content {
  flex: 1;
  overflow-y: auto;
  position: relative;
}
</style>
