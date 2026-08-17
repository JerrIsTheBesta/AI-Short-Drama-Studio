import { readonly, ref } from 'vue'

const src = ref('')
const kind = ref<'image' | 'video'>('image')
const caption = ref('')

export function openLightbox(
  url: string,
  type: 'image' | 'video' = 'image',
  title = ''
) {
  if (!url) return
  src.value = url
  kind.value = type
  caption.value = title
}

export function closeLightbox() {
  src.value = ''
  caption.value = ''
}

export function useLightbox() {
  return {
    src: readonly(src),
    kind: readonly(kind),
    caption: readonly(caption),
    open: openLightbox,
    close: closeLightbox
  }
}
