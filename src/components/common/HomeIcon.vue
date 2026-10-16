<script setup lang="ts">
defineProps<{
  name:
    | 'scissors'
    | 'mic'
    | 'plus'
    | 'folder'
    | 'settings'
    | 'search'
    | 'film'
    | 'image'
    | 'video'
    | 'trash'
    | 'edit'
    | 'upload'
    | 'library'
    | 'wand'
    | 'remake'
    | 'canvas'
    | 'check'
    | 'script'
  size?: number
}>()
</script>

<template>
  <svg
    class="home-icon"
    :width="size ?? 20"
    :height="size ?? 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'scissors'">
      <circle cx="6" cy="7" r="3" /><circle cx="6" cy="17" r="3" />
      <path d="m8.7 8.4 10.8 6.4M8.7 15.6 19.5 9.2" />
    </template>
    <template v-else-if="name === 'mic'">
      <rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" />
    </template>
    <template v-else-if="name === 'film'">
      <rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 5v14M17 5v14M3 9h4M17 9h4M3 15h4M17 15h4" />
    </template>
    <template v-else-if="name === 'image'">
      <rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="9" r="1.5" /><path d="m4 17 5-5 3 3 2-2 6 5" />
    </template>
    <template v-else-if="name === 'video'">
      <rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="m16 10 5-3v10l-5-3z" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16M9 3h6l1 4M6.5 7l1 14h9l1-14M10 11v6M14 11v6" />
    </template>
    <template v-else-if="name === 'edit'">
      <path d="m4 20 4.2-1 10.6-10.6a2 2 0 0 0-2.8-2.8L5.4 16.2zM14.5 7.1l2.8 2.8" />
    </template>
    <template v-else-if="name === 'upload'">
      <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </template>
    <template v-else-if="name === 'library'">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H18a2 2 0 0 1 2 2v14H6.5A2.5 2.5 0 0 0 4 21.5zM4 5.5v16M8 7h8M8 11h6" />
    </template>
    <template v-else-if="name === 'wand'">
      <path d="m4 20 10.5-10.5M13 4l.7 2.3L16 7l-2.3.7L13 10l-.7-2.3L10 7l2.3-.7zM19 12l.5 1.5L21 14l-1.5.5L19 16l-.5-1.5L17 14l1.5-.5zM7 3l.5 1.5L9 5l-1.5.5L7 7l-.5-1.5L5 5l1.5-.5z" />
    </template>
    <template v-else-if="name === 'remake'">
      <path d="M20 7v5h-5M4 17v-5h5M6.1 8.2A7 7 0 0 1 18.8 10M17.9 15.8A7 7 0 0 1 5.2 14" />
    </template>
    <template v-else-if="name === 'canvas'">
      <rect x="3" y="4" width="7" height="6" rx="1.5" /><rect x="14" y="14" width="7" height="6" rx="1.5" /><path d="M10 7h4a3 3 0 0 1 3 3v4" />
    </template>
    <template v-else-if="name === 'script'">
      <path d="M6.5 3.5h7L18 8v12.5a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" /><path d="M13.5 3.5V8H18M9 13h6M9 17h4" />
    </template>
    <template v-else>
      <path d="m5 12 4 4L19 6" />
    </template>
  </svg>
</template>

<style scoped>
.home-icon { display: block; flex: 0 0 auto; }
</style>
