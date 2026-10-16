<script setup lang="ts">
defineProps<{
  name:
    | 'back'
    | 'assistant'
    | 'layout'
    | 'folder'
    | 'steps'
    | 'settings'
    | 'panel'
    | 'more'
    | 'expand'
    | 'sparkles'
    | 'script'
  size?: number
}>()
</script>

<template>
  <svg :width="size ?? 20" :height="size ?? 20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'back'"><path d="m15 5-7 7 7 7" /><path d="M8 12h11" /></template>
    <template v-else-if="name === 'assistant'"><path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.2V6.5Z" /><path d="M9 9h6M9 12.5h4" /></template>
    <template v-else-if="name === 'layout'"><rect x="3.5" y="4" width="7" height="6.5" rx="1.3" /><rect x="13.5" y="4" width="7" height="6.5" rx="1.3" /><rect x="3.5" y="13.5" width="7" height="6.5" rx="1.3" /><rect x="13.5" y="13.5" width="7" height="6.5" rx="1.3" /></template>
    <template v-else-if="name === 'folder'"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.5l2 2H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5Z" /></template>
    <template v-else-if="name === 'steps'"><circle cx="5" cy="6" r="1.3" /><circle cx="5" cy="12" r="1.3" /><circle cx="5" cy="18" r="1.3" /><path d="M9 6h11M9 12h11M9 18h11" /></template>
    <template v-else-if="name === 'settings'"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" /></template>
    <template v-else-if="name === 'panel'"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></template>
    <template v-else-if="name === 'more'"><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></template>
    <template v-else-if="name === 'sparkles'"><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z" /><path d="m18.5 13 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /><path d="m5.5 12 .7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" /></template>
    <template v-else-if="name === 'script'"><path d="M6.5 3.5h7L18 8v12.5a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" /><path d="M13.5 3.5V8H18M9 13h6M9 17h4" /></template>
    <template v-else><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5" /></template>
  </svg>
</template>
