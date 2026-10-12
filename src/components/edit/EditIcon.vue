<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
</script>

<template>
  <svg
    class="edit-icon"
    :width="size || 18"
    :height="size || 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'back'"><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></template>
    <template v-else-if="name === 'refresh'"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8.3A7 7 0 0 1 18.6 7L20 12M4 12l1.4 5a7 7 0 0 0 12.5-1.3"/></template>
    <template v-else-if="name === 'play'"><path d="m9 7 8 5-8 5V7Z"/></template>
    <template v-else-if="name === 'next'"><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></template>
    <template v-else-if="name === 'check'"><path d="m5 12 4 4L19 6"/></template>
    <template v-else-if="name === 'plus'"><path d="M12 5v14M5 12h14"/></template>
    <template v-else-if="name === 'video'"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/></template>
    <template v-else-if="name === 'upload'"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M5 14v5h14v-5"/></template>
    <template v-else-if="name === 'music'"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></template>
    <template v-else-if="name === 'text'"><path d="M5 6V4h14v2M12 4v16M8 20h8"/></template>
    <template v-else-if="name === 'close'"><path d="m6 6 12 12M18 6 6 18"/></template>
    <template v-else-if="name === 'trash'"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></template>
    <template v-else-if="name === 'info'"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></template>
    <template v-else-if="name === 'clock'"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></template>
    <template v-else-if="name === 'grip'"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/></template>
  </svg>
</template>

<style scoped>
.edit-icon { display: block; flex: 0 0 auto; }
</style>
