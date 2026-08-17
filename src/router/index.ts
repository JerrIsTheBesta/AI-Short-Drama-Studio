import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useProjectStore, useAssetsStore } from '@/stores'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { step: null, label: '项目' }
  },
  {
    path: '/studio',
    name: 'studio',
    component: () => import('@/views/StudioView.vue'),
    meta: { step: null, label: '画布' }
  },
  {
    path: '/script',
    name: 'script',
    component: () => import('@/views/ScriptView.vue'),
    meta: { step: 'script', label: '1 · 文案' }
  },
  {
    path: '/storyboard',
    name: 'storyboard',
    component: () => import('@/views/StoryboardView.vue'),
    meta: { step: 'storyboard', label: '2 · 分镜' }
  },
  {
    path: '/images',
    name: 'images',
    component: () => import('@/views/ImagesView.vue'),
    meta: { step: 'image', label: '3 · AI 配图' }
  },
  {
    path: '/videos',
    name: 'videos',
    component: () => import('@/views/VideosView.vue'),
    meta: { step: 'video', label: '4 · AI 视频' }
  },
  {
    path: '/edit',
    name: 'edit',
    component: () => import('@/views/EditView.vue'),
    meta: { step: 'edit', label: '5 · 剪辑' }
  },
  {
    path: '/caption',
    name: 'caption',
    component: () => import('@/views/CaptionView.vue'),
    meta: { step: 'caption', label: '6 · 字幕' }
  },
  {
    path: '/export',
    name: 'export',
    component: () => import('@/views/ExportView.vue'),
    meta: { step: 'export', label: '7 · 导出' }
  },
  {
    path: '/drafts',
    name: 'drafts',
    component: () => import('@/views/DraftsView.vue'),
    meta: { step: null, label: '📦 资源库' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { step: null, label: '设置' }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  }
})

/** 进入工作流页之前先恢复 IndexedDB 项目，避免视图把「尚未加载」当成「没有产物」 */
router.beforeEach(async (to) => {
  const project = useProjectStore()
  const assets = useAssetsStore()
  await project.ensureLoaded()
  if (assets.all.length === 0) {
    await assets.refresh()
  }
  project.startAutoSave()
  if (to.name !== 'home' && to.name !== 'settings') {
    if (!project.current && project.allProjects.length > 0) {
      await project.load(project.allProjects[0].id)
    }
    project.rememberCurrent()
  }
})

/** 工作流步骤定义（顺序，用于侧栏） */
export const workflowSteps = [
  { id: 'script', label: '文案', icon: '📝', route: '/script', desc: '输入主题/文案' },
  { id: 'storyboard', label: '分镜', icon: '🎬', route: '/storyboard', desc: 'AI 拆解镜头' },
  { id: 'image', label: 'AI 配图', icon: '🎨', route: '/images', desc: '生成关键帧' },
  { id: 'video', label: 'AI 视频', icon: '🎥', route: '/videos', desc: '图生视频片段' },
  { id: 'edit', label: '剪辑', icon: '✂️', route: '/edit', desc: '时间线编排' },
  { id: 'caption', label: '字幕', icon: '💬', route: '/caption', desc: '台词配音与字幕' },
  { id: 'export', label: '导出', icon: '🚀', route: '/export', desc: '一键合成成片' },
  { id: 'drafts', label: '资源库', icon: '📦', route: '/drafts', desc: '全部图片/视频产物' }
] as const
