/**
 * 项目 store
 *
 * - 持有当前项目
 * - 自动持久化到 IndexedDB
 * - 提供新建/加载/保存/删除
 */

import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import {
  saveProject,
  loadProject,
  listProjects,
  deleteProject,
  setActiveProjectDir,
  loadProjectFromDir
} from '@/services/storage'
import { isDesktop, desktop } from '@/services/desktop'
import { emptyCanvas } from '@/types/canvas'
import { pushHistory } from '@/utils/shot'
import { rebuildCanvasGraph } from '@/services/canvas/layout'
import type {
  Project,
  Script,
  Shot,
  TimelineClip,
  ProjectSettings,
  AgentWorkspaceState,
  AspectRatio,
  ID,
  Subject,
  Scene,
  CanvasGraph,
  ShotAudioMode
} from '@/types'

const STORAGE_KEY_LAST = 'ai-cut:last-project-id'

function defaultSettings(): ProjectSettings {
  return {
    aspectRatio: '16:9',
    width: 1280,
    height: 720,
    fps: 30,
    defaultShotDuration: 3,
    captionStyle: {
      fontFamily: 'Noto Sans CJK SC',
      fontSizeRatio: 0.03,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 3,
      bgColor: '#000000',
      bgOpacity: 0.4,
      position: 'bottom',
      bold: true
    },
    defaultTransition: 'fade',
    bgmVolume: 0.22,
    originalVolume: 0.55,
    keepAmbientAudio: true,
    captionBg: false,
    burnCaptions: true,
    ttsVoice: 'longanhuan_v3.6'
  }
}

function aspectToSize(ar: AspectRatio): { width: number; height: number } {
  switch (ar) {
    case '16:9':
      return { width: 1280, height: 720 }
    case '9:16':
      return { width: 720, height: 1280 }
    case '1:1':
      return { width: 1080, height: 1080 }
    case '4:3':
      return { width: 960, height: 720 }
    case '21:9':
      return { width: 1680, height: 720 }
  }
}

function newProject(): Project {
  const now = Date.now()
  return {
    id: 'p_' + now.toString(36),
    name: '未命名项目',
    script: null,
    shots: [],
    subjects: [],
    scenes: [],
    timeline: [],
    settings: defaultSettings(),
    canvas: emptyCanvas(),
    agentState: {
      autonomy: 'gated',
      messages: [],
      tasks: [],
      callBudget: 24
    },
    createdAt: now,
    updatedAt: now
  }
}

export const useProjectStore = defineStore('project', () => {
  const current = ref<Project | null>(null)
  const allProjects = ref<Project[]>([])
  const dirty = ref(false)
  const lastSavedAt = ref<number | null>(null)
  /** 首次从 IndexedDB 恢复完成，视图据此避免「还没加载就当成空项目」 */
  const hydrated = ref(false)
  let hydratePromise: Promise<void> | null = null

  const isLoaded = computed(() => current.value !== null)
  const shotCount = computed(() => current.value?.shots.length ?? 0)
  const totalDuration = computed(() =>
    (current.value?.timeline ?? []).reduce((sum, c) => sum + c.duration, 0)
  )

  function rememberCurrent() {
    if (current.value) {
      localStorage.setItem(STORAGE_KEY_LAST, current.value.id)
    }
  }

  /** 加载项目列表 */
  async function refreshList() {
    allProjects.value = await listProjects()
  }

  /**
   * 路由进入工作流页之前调用：从 IDB 恢复上次项目，避免刷新后每一步都像没做过。
   * 不自动新建空项目（首页自己处理）。
   */
  async function ensureLoaded() {
    if (hydrated.value) return
    if (hydratePromise) return hydratePromise
    hydratePromise = (async () => {
      await refreshList()
      if (!current.value) {
        const lastId = localStorage.getItem(STORAGE_KEY_LAST)
        const target =
          (lastId && allProjects.value.find((p) => p.id === lastId)) ||
          allProjects.value[0]
        if (target) {
          await load(target.id)
        }
      }
      hydrated.value = true
    })().finally(() => {
      hydratePromise = null
    })
    return hydratePromise
  }

  /** 加载项目 */
  async function load(id: string) {
    const p = await loadProject(id)
    if (p) {
      // 兼容旧数据：缺字段补默认
      p.shots = (p.shots ?? []).map((s, i) => ({
        ...s,
        index: s.index ?? i,
        imageHistoryIds: s.imageHistoryIds ?? [],
        videoHistoryIds: s.videoHistoryIds ?? [],
        audioHistoryIds: s.audioHistoryIds ?? [],
        subjectIds: s.subjectIds ?? [],
      }))
      p.subjects = p.subjects ?? []
      p.scenes = p.scenes ?? []
      p.timeline = p.timeline ?? []
      p.canvas = p.canvas ?? emptyCanvas()
      if (p.canvas.nodes?.length) {
        p.canvas = {
          ...p.canvas,
          nodes: p.canvas.nodes.map((n) =>
            n.status === 'running' || n.status === 'pending'
              ? { ...n, status: 'idle', error: undefined }
              : n
          )
        }
      }
      p.agentState = {
        autonomy: p.agentState?.autonomy ?? 'gated',
        messages: p.agentState?.messages ?? [],
        tasks: (p.agentState?.tasks ?? []).map((t) =>
          t.status === 'running' ? { ...t, status: 'cancelled' as const, finishedAt: Date.now() } : t
        ),
        callBudget: p.agentState?.callBudget ?? 24
      }
      if (p.folderPath) setActiveProjectDir(p.folderPath)
      p.settings = {
        ...defaultSettings(),
        ...(p.settings ?? {}),
        captionStyle: {
          ...defaultSettings().captionStyle,
          ...(p.settings?.captionStyle ?? {})
        }
      }
      current.value = p
      dirty.value = false
      rememberCurrent()
    }
  }

  /** 新建项目 */
  function create(name = '未命名项目'): Project {
    if (current.value && dirty.value) {
      saveProject(current.value).catch(() => {})
    }
    const p = newProject()
    p.name = name
    current.value = p
    dirty.value = true
    rememberCurrent()
    return p
  }

  async function createNamed(name: string): Promise<Project> {
    const p = create(name)
    if (isDesktop()) {
      const dir = await desktop().ensureProjectDir(p.name, p.id)
      p.folderPath = dir
      setActiveProjectDir(dir)
      await save()
    }
    return p
  }

  async function openFromFolder(dir: string) {
    const p = await loadProjectFromDir(dir)
    if (!p) return
    p.canvas = p.canvas ?? emptyCanvas()
    current.value = p
    dirty.value = false
    rememberCurrent()
    await refreshList()
  }

  /** 设置文案 */
  function setScript(script: Script) {
    if (!current.value) return
    current.value.script = script
    touch()
  }

  /** 设置分镜 */
  function setShots(shots: Shot[]) {
    if (!current.value) return
    current.value.shots = shots
    touch()
  }

  function setSubjects(subjects: Subject[]) {
    if (!current.value) return
    current.value.subjects = subjects
    touch()
  }

  function updateSubject(id: ID, patch: Partial<Subject>) {
    if (!current.value) return
    const list = current.value.subjects ?? []
    const idx = list.findIndex((s) => s.id === id)
    if (idx === -1) return
    const next = [...list]
    next[idx] = { ...next[idx], ...patch }
    current.value.subjects = next
    touch()
  }

  function setScenes(scenes: Scene[]) {
    if (!current.value) return
    current.value.scenes = scenes
    touch()
  }

  function updateScene(id: ID, patch: Partial<Scene>) {
    if (!current.value) return
    const list = current.value.scenes ?? []
    const idx = list.findIndex((s) => s.id === id)
    if (idx === -1) return
    const next = [...list]
    next[idx] = { ...next[idx], ...patch }
    current.value.scenes = next
    touch()
  }

  /** 更新单个分镜 */
  function updateShot(id: ID, patch: Partial<Shot>) {
    if (!current.value) return
    const idx = current.value.shots.findIndex((s) => s.id === id)
    if (idx === -1) return
    current.value.shots[idx] = { ...current.value.shots[idx], ...patch }
    touch()
  }

  function assignShotBoard(shotId: ID, assetId: ID) {
    if (!current.value) return
    const shot = current.value.shots.find((s) => s.id === shotId)
    if (!shot) return
    updateShot(shotId, {
      boardAssetId: assetId,
      boardHistoryIds: pushHistory(shot.boardAssetId, assetId, shot.boardHistoryIds)
    })
  }

  /** 把图片绑到分镜：旧图进历史，不从资源库删除 */
  function assignShotImage(shotId: ID, assetId: ID) {
    if (!current.value) return
    const shot = current.value.shots.find((s) => s.id === shotId)
    if (!shot) return
    updateShot(shotId, {
      imageAssetId: assetId,
      imageHistoryIds: pushHistory(shot.imageAssetId, assetId, shot.imageHistoryIds),
      status:
        shot.status === 'video-generated' || shot.videoAssetId
          ? shot.status
          : 'image-generated'
    })
  }

  /** 把视频绑到分镜：旧视频进历史，不从资源库删除 */
  function assignShotVideo(shotId: ID, assetId: ID) {
    if (!current.value) return
    const shot = current.value.shots.find((s) => s.id === shotId)
    if (!shot) return
    updateShot(shotId, {
      videoAssetId: assetId,
      videoHistoryIds: pushHistory(shot.videoAssetId, assetId, shot.videoHistoryIds),
      status: 'video-generated'
    })
  }

  /** 把口播音频绑到分镜 */
  function assignShotAudio(shotId: ID, assetId: ID) {
    if (!current.value) return
    const shot = current.value.shots.find((s) => s.id === shotId)
    if (!shot) return
    updateShot(shotId, {
      audioAssetId: assetId,
      audioHistoryIds: pushHistory(shot.audioAssetId, assetId, shot.audioHistoryIds)
    })
  }

  /** 设置时间线 */
  function setTimeline(timeline: TimelineClip[]) {
    if (!current.value) return
    current.value.timeline = timeline
    touch()
  }

  function updateClip(id: ID, patch: Partial<TimelineClip>) {
    if (!current.value) return
    const idx = current.value.timeline.findIndex((c) => c.id === id)
    if (idx === -1) return
    current.value.timeline[idx] = { ...current.value.timeline[idx], ...patch }
    touch()
  }

  function addClip(clip: TimelineClip) {
    if (!current.value) return
    current.value.timeline.push(clip)
    touch()
  }

  function removeClip(id: ID) {
    if (!current.value) return
    current.value.timeline = current.value.timeline.filter((c) => c.id !== id)
    touch()
  }

  function setSettings(patch: Partial<ProjectSettings>) {
    if (!current.value) return
    current.value.settings = { ...current.value.settings, ...patch }
    touch()
  }

  function setCaptionSrt(srt: string) {
    if (!current.value) return
    current.value.captionSrt = srt
    touch()
  }

  function setBgm(assetId: string | undefined, prompt?: string) {
    if (!current.value) return
    current.value.bgmAssetId = assetId
    if (prompt !== undefined) current.value.bgmPrompt = prompt
    touch()
  }

  function setFinalVideo(assetId: string | undefined) {
    if (!current.value) return
    current.value.finalVideoAssetId = assetId
    touch()
  }

  /** 人声方案属于视频生成条件；切换时保留旧视频到历史并要求局部重做。 */
  function setShotAudioMode(id: ID, audioMode: ShotAudioMode) {
    if (!current.value) return
    const idx = current.value.shots.findIndex((s) => s.id === id)
    if (idx < 0) return
    const shot = current.value.shots[idx]
    if (shot.audioMode === audioMode) return
    const keepTts = audioMode === 'tts'
    current.value.shots[idx] = {
      ...shot,
      audioMode,
      videoHistoryIds: pushHistory(shot.videoAssetId, '', shot.videoHistoryIds).filter(Boolean),
      videoAssetId: undefined,
      audioHistoryIds: keepTts
        ? shot.audioHistoryIds
        : pushHistory(shot.audioAssetId, '', shot.audioHistoryIds).filter(Boolean),
      audioAssetId: keepTts ? shot.audioAssetId : undefined,
      status: shot.imageAssetId ? 'image-generated' : 'draft'
    }
    touch()
  }

  /** 局部修改时只失效受影响的下游产物；旧素材仍留在历史和资源库中。 */
  function invalidateShotAssets(shotId: ID, from: 'image' | 'video' | 'audio') {
    if (!current.value) return
    const idx = current.value.shots.findIndex((s) => s.id === shotId)
    if (idx < 0) return
    const shot = current.value.shots[idx]
    const patch: Partial<Shot> = {}
    if (from === 'image') {
      patch.imageAssetId = undefined
      patch.videoAssetId = undefined
      patch.status = 'draft'
    } else if (from === 'video') {
      patch.videoAssetId = undefined
      patch.status = shot.imageAssetId ? 'image-generated' : 'draft'
    } else {
      patch.audioAssetId = undefined
    }
    current.value.shots[idx] = { ...shot, ...patch }
    touch()
  }

  function setAgentState(state: AgentWorkspaceState) {
    if (!current.value) return
    current.value.agentState = state
    touch()
  }

  function patchAgentState(patch: Partial<AgentWorkspaceState>) {
    if (!current.value) return
    const currentState: AgentWorkspaceState = current.value.agentState ?? {
      autonomy: 'gated',
      messages: [],
      tasks: [],
      callBudget: 24
    }
    current.value.agentState = { ...currentState, ...patch }
    touch()
  }

  function setCanvas(canvas: CanvasGraph) {
    if (!current.value) return
    current.value.canvas = canvas
    touch()
  }

  function syncCanvasFromProject() {
    if (!current.value) return
    current.value.canvas = rebuildCanvasGraph(current.value, true)
    touch()
  }

  function setAspectRatio(ar: AspectRatio) {
    if (!current.value) return
    const { width, height } = aspectToSize(ar)
    current.value.settings.aspectRatio = ar
    current.value.settings.width = width
    current.value.settings.height = height
    touch()
  }

  function setPlayApproved(ok: boolean) {
    if (!current.value) return
    current.value.playApproved = ok
    touch()
  }

  function touch() {
    if (!current.value) return
    current.value.updatedAt = Date.now()
    dirty.value = true
  }

  /** 自动保存（watch） */
  let stopWatch: (() => void) | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  function startAutoSave() {
    if (stopWatch) return
    stopWatch = watch(
      current,
      (p) => {
        if (!p || !dirty.value) return
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          save().catch((e) => console.warn('[project] autosave failed', e))
        }, 200)
      },
      { deep: true }
    )
  }

  function stopAutoSave() {
    stopWatch?.()
    stopWatch = null
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  /** 主动保存（串行，避免并行生成互相覆盖） */
  let saveChain: Promise<void> = Promise.resolve()
  async function save() {
    const run = async () => {
      if (!current.value) return
      const stamp = current.value.updatedAt
      await saveProject(current.value)
      lastSavedAt.value = Date.now()
      if (current.value.updatedAt === stamp) {
        dirty.value = false
      }
      await refreshList()
    }
    const next = saveChain.then(run, run)
    saveChain = next.catch(() => undefined)
    return next
  }

  /** 删除项目 */
  async function remove(id: string) {
    await deleteProject(id)
    if (current.value?.id === id) {
      current.value = null
    }
    await refreshList()
  }

  return {
    current,
    allProjects,
    dirty,
    lastSavedAt,
    hydrated,
    isLoaded,
    shotCount,
    totalDuration,
    refreshList,
    ensureLoaded,
    load,
    create,
    createNamed,
    openFromFolder,
    setScript,
    setShots,
    setSubjects,
    updateSubject,
    setScenes,
    updateScene,
    updateShot,
    setShotAudioMode,
    assignShotBoard,
    assignShotImage,
    assignShotVideo,
    assignShotAudio,
    invalidateShotAssets,
    setTimeline,
    updateClip,
    addClip,
    removeClip,
    setSettings,
    setCaptionSrt,
    setBgm,
    setFinalVideo,
    setAgentState,
    patchAgentState,
    setCanvas,
    syncCanvasFromProject,
    setAspectRatio,
    setPlayApproved,
    save,
    remove,
    startAutoSave,
    stopAutoSave,
    rememberCurrent
  }
})
