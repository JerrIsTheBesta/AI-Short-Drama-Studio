<script setup lang="ts">
defineProps<{
  name:
    | 'image'
    | 'video'
    | 'audio'
    | 'script'
    | 'character'
    | 'prop'
    | 'scene'
    | 'shot'
    | 'duplicate'
    | 'delete'
    | 'compose'
}>()
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <template v-if="name === 'image'">
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <circle cx="8.2" cy="9" r="1.7" fill="currentColor" stroke="none" />
      <path d="M3.6 16.4 8.5 12.2 12.2 15.4 15.4 12.6 20.4 16.8" />
    </template>
    <template v-else-if="name === 'video'">
      <path d="M4 10.2 6.4 5.2h3.6L7.8 10.2" />
      <path d="M10.2 5.2h3.8L11.8 10.2" />
      <path d="M16.2 5.2h3.4L17.4 10.2" />
      <path d="M4 10.2h16V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19V10.2Z" />
    </template>
    <template v-else-if="name === 'audio'">
      <path d="M3.5 10v4h3.2l4.3 3.4V6.6L6.7 10H3.5Z" fill="currentColor" stroke="none" />
      <path d="M14.2 9.1a3.4 3.4 0 0 1 0 5.8" />
      <path d="M16.6 6.8a6.2 6.2 0 0 1 0 10.4" />
    </template>
    <template v-else-if="name === 'script'">
      <path d="M6 3.5h8.2L19 8.2V20.5H6V3.5Z" />
      <path d="M14 3.6V8.2H19" />
      <path d="M8.6 12h6.8M8.6 15h6.8M8.6 18h4.2" />
    </template>
    <template v-else-if="name === 'character'">
      <circle cx="12" cy="7.2" r="2.8" />
      <path d="M5.4 19.4c.8-3.7 3.1-5.6 6.6-5.6s5.8 1.9 6.6 5.6" />
    </template>
    <template v-else-if="name === 'prop'">
      <path d="M12 3.4 20 7.4v9L12 20.6 4 16.4v-9L12 3.4Z" />
      <path d="M12 12.2 20 7.4M12 12.2 4 7.4M12 12.2v8.4" />
    </template>
    <template v-else-if="name === 'scene'">
      <circle cx="16.6" cy="7" r="1.8" fill="currentColor" stroke="none" />
      <path d="M3 16.8 8.2 11.6 12 14.8 16.4 10.2 21 15.6" />
      <path d="M3.2 19.2h17.6" />
    </template>
    <template v-else-if="name === 'shot'">
      <rect x="3.4" y="3.8" width="7.4" height="6.4" rx="1.1" />
      <rect x="13.2" y="3.8" width="7.4" height="6.4" rx="1.1" />
      <rect x="3.4" y="13.2" width="7.4" height="6.4" rx="1.1" />
      <rect x="13.2" y="13.2" width="7.4" height="6.4" rx="1.1" />
    </template>
    <template v-else-if="name === 'compose'">
      <rect x="3.2" y="4" width="7.2" height="5.2" rx="1" />
      <rect x="13.6" y="4" width="7.2" height="5.2" rx="1" />
      <path d="M7 9.4v2.1h10V9.4" />
      <rect x="4.2" y="14.2" width="15.6" height="5.4" rx="1.1" />
    </template>
    <template v-else-if="name === 'duplicate'">
      <rect x="8" y="8" width="11" height="11" rx="1.6" />
      <path d="M6.2 16V5.6A1.6 1.6 0 0 1 7.8 4H16" />
    </template>
    <template v-else>
      <path d="M5 7.6h14" />
      <path d="M9.4 7.5V5.2h5.2v2.3" />
      <path d="M7.4 7.6 8.1 19h7.8l.7-11.4" />
      <path d="M10.2 11.1v5.2M13.8 11.1v5.2" />
    </template>
  </svg>
</template>
