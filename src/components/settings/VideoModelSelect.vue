<script setup lang="ts">
import { computed } from 'vue'
import ParamSelect from '@/components/common/ParamSelect.vue'
import { normalizeVideoGenModel, stillModeForVideoModel, type VideoGenModel } from '@/types'
import { useSettingsStore } from '@/stores'

const props = withDefaults(
  defineProps<{
    modelValue?: VideoGenModel | string
    profileId?: string
    label?: string
  }>(),
  { label: '模型' }
)

const emit = defineEmits<{
  'update:modelValue': [value: VideoGenModel]
  'selectProfile': [profileId: string]
}>()
const settings = useSettingsStore()

const value = computed(() => {
  const m = normalizeVideoGenModel(props.modelValue)
  if (m === 'wan-prime' || m === 'h3-v5') return m
  if (props.profileId && settings.config.videos.some((profile) => profile.id === props.profileId)) {
    return props.profileId
  }
  return settings.config.activeVideoId || 'h3'
})

function profileLabel(profile: { name: string; provider?: string; baseUrl?: string; adapter?: { type?: string } }) {
  const zealman = profile.provider === 'zealman' || profile.adapter?.type === 'zealman-workflow'
  const autodl = !zealman && (profile.provider === 'autodl' || /autodl\.art/i.test(profile.baseUrl || ''))
  const tag = zealman ? 'Zealman' : autodl ? 'AutoDL' : ''
  return tag ? `${tag} · ${profile.name}` : profile.name
}

function onPick(v: string) {
  if (v === 'wan-prime' || v === 'h3-v5' || v === 'h3') {
    emit('update:modelValue', v)
    return
  }
  emit('selectProfile', v)
}
</script>

<template>
  <ParamSelect :label="label" max-width="260px" :model-value="value" @update:model-value="onPick">
    <optgroup v-if="settings.config.videos.length" label="已配置的视频接入">
      <option v-for="p in settings.config.videos" :key="p.id" :value="p.id">
        {{ profileLabel(p) }}{{ stillModeForVideoModel('h3', p) === 'keyframe' ? ' · 关键帧' : stillModeForVideoModel('h3', p) === 'storyboard' ? ' · 看板' : '' }}
      </option>
    </optgroup>
    <optgroup label="工作流（用设置里的 AutoDL 令牌）">
      <option value="h3">
        H3 v5 · 15秒{{ stillModeForVideoModel('h3', settings.config.video) === 'keyframe' ? '（需关键帧）' : stillModeForVideoModel('h3', settings.config.video) === 'storyboard' ? '（需看板）' : '（人设+场景）' }}
      </option>
      <option value="h3-v5">H3 v5 · 10秒 1080p（人设+场景）</option>
      <option value="wan-prime">万相 3.0 Prime（需关键帧）</option>
    </optgroup>
  </ParamSelect>
</template>
