# 🎬 AI Cut · 一站式 AI 混剪工作台

> 从文案到成片，全流程 AI 驱动。
> **AI 配图 → 分镜拆解 → 图生视频 → 时间线剪辑 → 字幕叠加 → 一键导出**

![tech](https://img.shields.io/badge/Vue-3-42b883) ![tech](https://img.shields.io/badge/TypeScript-5-3178c6) ![tech](https://img.shields.io/badge/FFmpeg.wasm-0.12-orange) ![tech](https://img.shields.io/badge/license-MIT-blue)

---

## ✨ 核心亮点

- 🎨 **AI 配图**：分镜级关键帧生成，电影/动漫/写实/3D 等 8 种风格
- 🎬 **AI 分镜**：一句话文案 → 自动拆分成 3-12 个镜头
- 🎥 **图生视频**：图片 + 描述 → 动态视频片段（支持 6 种运镜）
- ✂️ **可视化剪辑**：拖拽时间线、调时长、加转场、变速
- 💬 **字幕烧录**：SRT 导入/导出、字体/颜色/位置/描边实时预览
- 🚀 **一键导出**：FFmpeg.wasm 浏览器内合成，MP4/WebM
- 💾 **本地优先**：IndexedDB 存储，零后端依赖
- 🎭 **演示模式**：不配 API 也能跑通全流程（程序化生成演示图/视频）

---

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动开发服务器
npm run dev
# → http://localhost:5173

# 3. 构建生产版本
npm run build
npm run preview
```

> ⚠️ **首次访问**：会下载 FFmpeg 核心（约 30MB），需要稳定网络。
> 浏览器需要支持 `SharedArrayBuffer`（Chrome / Edge / Firefox 较新版本都行）。

---

## 📁 项目结构

```
ai-cut/
├── src/
│   ├── main.ts                  # 入口
│   ├── App.vue                  # 根组件
│   ├── style.css                # 全局样式（暗色主题 + 渐变）
│   ├── env.d.ts                 # 环境变量类型
│   │
│   ├── types/                   # 类型定义
│   │   ├── project.ts           # 项目 / 分镜 / 时间线
│   │   ├── asset.ts             # 素材
│   │   └── pipeline.ts          # 任务 / 步骤
│   │
│   ├── services/                # 业务服务
│   │   ├── ai/                  # AI 能力层
│   │   │   ├── client.ts        # 通用 API client（mock/real）
│   │   │   ├── mock.ts          # 演示模式（Canvas + MediaRecorder）
│   │   │   ├── image.ts         # 图像生成
│   │   │   ├── storyboard.ts    # 分镜生成（LLM）
│   │   │   └── video.ts         # 视频生成（图生视频）
│   │   │
│   │   ├── ffmpeg/              # FFmpeg.wasm 封装
│   │   │   ├── client.ts        # 单例 + 懒加载
│   │   │   ├── concat.ts        # 视频拼接
│   │   │   ├── subtitle.ts      # SRT 解析/生成 + drawtext 滤镜
│   │   │   ├── export.ts        # 一键合成（含转场/字幕/BGM）
│   │   │   └── probe.ts         # 媒体元数据探测
│   │   │
│   │   └── storage/             # IndexedDB
│   │       └── idb.ts           # 项目 + 素材存储
│   │
│   ├── stores/                  # Pinia 状态
│   │   ├── project.ts           # 当前项目
│   │   ├── assets.ts            # 素材库
│   │   ├── toast.ts             # 通知
│   │   └── settings.ts          # 应用设置
│   │
│   ├── router/                  # 路由 + 步骤定义
│   │   └── index.ts
│   │
│   ├── components/              # 组件
│   │   ├── common/              # 通用（按钮、卡片、空状态、进度等）
│   │   ├── layout/              # 布局（TopBar、StepNav）
│   │   └── timeline/            # 时间线
│   │
│   └── views/                   # 页面
│       ├── HomeView.vue         # 项目列表
│       ├── ScriptView.vue       # 1. 文案输入
│       ├── StoryboardView.vue   # 2. 分镜拆解
│       ├── ImagesView.vue       # 3. AI 配图
│       ├── VideosView.vue       # 4. AI 视频
│       ├── EditView.vue         # 5. 剪辑（时间线）
│       ├── CaptionView.vue      # 6. 字幕
│       ├── ExportView.vue       # 7. 导出
│       └── SettingsView.vue     # 设置
│
├── .env.example                 # 环境变量示例
├── vite.config.ts               # Vite 配置（含 COOP/COEP for FFmpeg）
└── package.json
```

---

## 🎬 工作流（7 步）

```
📝 文案        →  输入主题/文案，选择画面风格和视频比例
   ↓
🎬 分镜        →  AI 自动拆分成 3-12 个镜头，可手动微调
   ↓
🎨 AI 配图     →  为每个分镜生成关键帧图片
   ↓
🎥 AI 视频     →  用图片 + 描述生成动态视频片段
   ↓
✂️ 剪辑        →  时间线排序、调时长、加转场、变速
   ↓
💬 字幕        →  编辑字幕文本 + 样式，实时预览
   ↓
🚀 导出        →  FFmpeg 一键合成 MP4/WebM
```

每一步的产物自动流向下一步，整个流水线在浏览器里闭环。

---

## 🎭 演示模式 vs 真实 API

| 维度 | 演示模式（默认） | 真实 API |
|------|-----------------|---------|
| 是否需要 API key | ❌ 不需要 | ✅ 需要 |
| 分镜 | 关键词启发拆解 | LLM 智能拆解 |
| 配图 | Canvas 程序化生成 | DALL·E / 自定义服务 |
| 视频 | MediaRecorder 录屏 | 图生视频服务 |
| 适合场景 | 体验流程 / UI 调试 | 实际产出 |

**切换到真实模式**：
1. 在项目根目录创建 `.env`（复制 `.env.example`）
2. 填入你的 API 配置
3. 设置 `VITE_AI_REAL_MODE=true`
4. 重启 `npm run dev`

---

## 🔌 接入自定义 AI 能力

### 1. LLM（分镜生成）
走 OpenAI Chat Completions 兼容协议：
- 任何 OpenAI / DeepSeek / Moonshot / 智谱 GLM 都可以
- 改 `.env` 的 `VITE_LLM_BASE_URL` / `VITE_LLM_API_KEY` / `VITE_LLM_MODEL` 即可

### 2. 图像生成
默认走 OpenAI Images API 协议（DALL·E 3 / gpt-image-1）。
要接入 MiniMax（图像）/ Stable Diffusion WebUI / ComfyUI，修改：
```
src/services/ai/image.ts  →  realGenerateImage()
```

### 3. 视频生成
默认走自定义 endpoint 协议：
- `POST /videos/generations` 提交任务（multipart/form-data）
- `GET /videos/generations/{id}` 轮询（返回 `{status, url, error}`）
- MiniMax 的视频 API / 自建服务都可以这样接

修改 `src/services/ai/video.ts  →  realGenerateVideo()`

---

## 🎨 主题与样式

- 暗色系 + 紫粉橙渐变
- 玻璃拟态（Glassmorphism）
- 流畅的微动画（shimmer、float、spring easing）
- 自定义属性集中在 `src/style.css` 的 `:root`，改一个变量即可全站换肤

---

## 💾 数据存储

所有数据都存在浏览器 IndexedDB：

- **projects** store：项目元数据（含分镜、时间线、设置）
- **assets** store：素材二进制（图片 / 视频 / 音频）
- **thumbs** store：视频缩略图

项目自动保存（数据变更后写入 IDB）。可以在 Settings 页面：
- 查看存储用量
- 导出全部项目为 JSON
- 从 JSON 导入
- 清空所有数据

---

## 🛠 二次开发指南

### 加一个新页面
1. 在 `src/views/` 创建 `XxxView.vue`
2. 在 `src/router/index.ts` 注册路由
3. 如果是工作流一步，加进 `workflowSteps`

### 接一个新的 AI 能力
1. 在 `src/services/ai/` 创建 `xxx.ts`
2. 导出 `generateXxx(input, onProgress?)` 函数
3. 在 `services/ai/client.ts` 加 `getAIMode()` 判断
4. 在 `services/ai/mock.ts` 加 mock 实现

### 自定义转场
修改 `src/services/ffmpeg/export.ts` 里的 `applyTransition()`，
按 FFmpeg 文档加新的 `-vf` 滤镜。

### 自定义字幕样式
字幕样式在 `ProjectSettings.captionStyle` 里，
drawtext 滤镜生成在 `src/services/ffmpeg/subtitle.ts` 的 `cuesToDrawTextFilter()`。

---

## ⚠ 已知限制

- **浏览器要求**：需要 `SharedArrayBuffer`，Chrome 92+ / Edge 92+ / Firefox 89+
- **首次加载慢**：FFmpeg 核心约 30MB，需要稳定网络
- **合成速度**：浏览器内 FFmpeg 比原生慢 5-10x，1 分钟视频约需 2-3 分钟
- **真视频质量**：演示模式的视频是抽象动画，要真实画面需接入图生视频 API
- **存储限制**：浏览器 IndexedDB 配额通常 1-10GB，超出可能失败

---

## 📜 License

MIT
