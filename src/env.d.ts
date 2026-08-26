/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module '*.md?raw' {
  const content: string
  export default content
}

interface ImportMetaEnv {
  readonly VITE_AI_REAL_MODE: string
  readonly VITE_LLM_BASE_URL: string
  readonly VITE_LLM_API_KEY: string
  readonly VITE_LLM_MODEL: string
  readonly VITE_VISION_BASE_URL: string
  readonly VITE_VISION_API_KEY: string
  readonly VITE_VISION_MODEL: string
  readonly VITE_IMAGE_BASE_URL: string
  readonly VITE_IMAGE_API_KEY: string
  readonly VITE_IMAGE_MODEL: string
  readonly VITE_VIDEO_BASE_URL: string
  readonly VITE_VIDEO_API_KEY: string
  readonly VITE_VIDEO_WORKFLOW_ID: string
  readonly VITE_VIDEO_MODEL: string
  readonly VITE_TTS_BASE_URL: string
  readonly VITE_TTS_API_KEY: string
  readonly VITE_TTS_MODEL: string
  readonly VITE_TTS_VOICE: string
  readonly VITE_MUSIC_BASE_URL: string
  readonly VITE_MUSIC_API_KEY: string
  readonly VITE_MUSIC_MODEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
