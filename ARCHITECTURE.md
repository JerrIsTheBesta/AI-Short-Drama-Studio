# 🏗 AI Cut 架构速查

## 数据流

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ Script   │ →  │ Shot[]   │ →  │ Asset[]  │ →  │Timeline[]│
│ (文案)   │    │ (分镜)   │    │ (素材)   │    │ (剪辑)   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
   LLM拆分       AI 配图/视频       IndexedDB        FFmpeg 导出
```

每个 Shot 通过 `imageAssetId` / `videoAssetId` 关联到 Asset；
每个 TimelineClip 通过 `shotId` 反向找到对应的 Shot 和 Asset。

## 模块依赖

```
views/  →  stores/  →  services/  →  external (AI / FFmpeg / IDB)
                                ↓
                              types/
```

- `views/` 只调 store 和 service
- `stores/` 是状态层（Pinia），自动持久化
- `services/` 是业务逻辑
- `types/` 是纯类型，无运行时

## AI 服务切换

`src/services/ai/client.ts` 里的 `getAIMode()` 决定走 mock 还是 real：
- `mock`：演示模式，零依赖
- `real`：调真实 API

每个 AI service 文件结构相同：
```
xxx.ts:
  - realXxx(): 真实实现
  - generateXxx(input, onProgress?): 入口，自动选 real/mock
```

## FFmpeg 流程

```
[素材 blob] → writeFile(虚拟 FS)
             → exec(转码/拼接/转场)
             → exec(烧字幕)
             → exec(混 BGM)
             → exec(转最终格式)
             → readFile → Blob → download
```

## 持久化

```
Pinia store 变更
   ↓
watch (deep)
   ↓
saveProject() / saveAsset()
   ↓
IndexedDB (idb.ts)
   ↓
自动 reload UI
```

## 路由

```
/                  HomeView         项目列表
/script            ScriptView       1. 文案
/storyboard        StoryboardView   2. 分镜
/images            ImagesView       3. AI 配图
/videos            VideosView       4. AI 视频
/edit              EditView         5. 剪辑
/caption           CaptionView      6. 字幕
/export            ExportView       7. 导出
/settings          SettingsView     设置
```

侧栏 StepNav 根据当前 route 高亮，根据项目状态显示 ✓。

## 主题系统

所有颜色 / 间距 / 圆角在 `src/style.css` 的 `:root`。
改一个变量全站生效。

## 关键约束

- **FFmpeg 必须 COOP/COEP**：vite.config.ts 里已加 headers
- **IndexedDB 是异步**：所有 IDB 操作都是 Promise
- **跨域隔离**：SharedArrayBuffer 需要 `crossOriginIsolated`
