# 剧流 Studio

本地优先的 AI 视频创作与剪辑工作台。把剧本、人物、场景、分镜、参考图、视频、配音、音乐和最终导出放进同一套项目流程，也支持直接导入本地视频进行剪辑。

> 当前版本处于积极开发阶段。AI 服务需要用户自行配置，本仓库不包含任何 API Key。

## 主要能力

- 无限画布：用节点组织剧本、人物、场景、分镜图、视频、音频和成片。
- 画布智能体：读取当前项目，协助改剧本、拆分镜、优化提示词及运行生成节点。
- 剧本与分镜：支持章节、Markdown 导入导出、人物/场景提取、按秒动作与对白拆分。
- 参考图体系：上传、资源库复用、单张移除、人物身份锁定、场景和看板参考。
- AI 图片与视频：多模型配置、H3/H3 V5/万相流程、首尾帧和多图参考。
- 智能口播与视频复刻：面向真人口播包装和参考视频重建的独立工作流。
- 视频剪辑：视频、音乐、文字多轨编排，预览、排序、裁切、速度、音量和转场。
- 可编辑文字：内容、字体、字号、颜色、时段和画面内自由拖动定位。
- 本地合成：通过 FFmpeg.wasm 完成拼接、转场、混音、字幕烧录与导出。
- 本地存储：Electron 使用项目目录，Web 模式使用 IndexedDB/localStorage。

完整功能请查看 [FEATURES.md](FEATURES.md)。架构说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 技术栈

- Vue 3、TypeScript、Pinia、Vue Router
- Vue Flow、Naive UI
- Vite、Electron
- FFmpeg.wasm

## 快速开始

环境要求：Node.js 20 或更高版本、npm，以及较新的 Chrome/Edge（Web 模式）。

```bash
npm install
npm run dev
```

默认使用演示模式，无需配置 API Key。

### 配置 AI 服务

```powershell
Copy-Item .env.example .env
```

在本机 `.env` 中填写需要的服务，或启动应用后进入“设置”保存多套接入。可配置：

- 语言模型：剧本、分镜、智能体和提示词优化。
- 视觉理解：参考图分析与画面质检。
- 图像生成：人物、场景、看板和分镜图。
- 视频生成：H3 工作流、万相或自定义服务。
- TTS：后期对白、旁白和音色。
- 音乐生成：AI 配乐。

`.env` 已被 Git 忽略。不要修改 `.env.example` 填入真实值。

## 构建

```bash
# 类型检查
npm run type-check

# 检查 Git 跟踪源码中的疑似硬编码凭据
npm run security:check

# Web 生产构建，同时检查 dist 是否混入本机密钥
npm run build

# Windows Electron 安装包
npm run electron:build
```

FFmpeg 核心文件体积较大，未纳入 Git。根据 [public/ffmpeg/README.md](public/ffmpeg/README.md) 放置对应文件。

## 工作模式

### 普通项目

剧本 → 人物与场景 → 分镜 → 图片 → 视频 → 配音/字幕 → 视频剪辑 → 导出。

### 视频复刻

上传参考视频和至少一张产品图，分析镜头后重建可编辑的生成流程。

### 自由模式

从空白画布开始，右键添加剧本、图片或视频节点，通过连线传递参考图。

### 智能口播

导入真人口播和文案，进行分段生产、视觉包装、字幕处理、质检和导出。

### 视频剪辑

不创建完整 AI 项目也可以直接导入本地视频，调整顺序并加入音乐、文字后合成。

## 项目结构

```text
src/
├─ components/        通用组件、画布节点、时间线和设置组件
├─ services/
│  ├─ ai/             LLM、视觉、图片、视频、TTS、音乐与提示词逻辑
│  ├─ canvas/         画布布局、智能体工具、任务与导出编排
│  ├─ ffmpeg/         裁切、拼接、混音、字幕和最终合成
│  └─ storage/        桌面端与浏览器端存储
├─ skills/            内置剧本、分镜、图片、视频和质检提示规范
├─ stores/            项目、素材、设置和通知状态
├─ types/             项目、画布、素材和任务类型
└─ views/             首页、画布、智能口播、剪辑、字幕和导出页面
electron/             Electron 主进程与预加载脚本
scripts/              诊断、打包和密钥检查脚本
```

## 数据与隐私

- 项目数据默认保存在用户本机。
- API 请求会发送到用户自行配置的第三方服务。
- 项目素材、提示词和生成内容是否被第三方保存，取决于对应服务商条款。
- 公开发布安装包时不得在构建环境注入真实 `VITE_*_API_KEY`。

详细要求见 [SECURITY.md](SECURITY.md)。

## 贡献

欢迎提交 Issue 和 Pull Request。开发与提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 已知限制

- AI 输出需要人工审核，尤其是人物一致性、场景连续性、对白时序和镜头方向。
- FFmpeg.wasm 受浏览器内存与设备性能限制，长视频和高分辨率导出可能较慢。
- 某些模型依赖特定第三方工作流，接口变化可能需要同步适配。
- 当前主要面向 Windows Electron 与现代桌面浏览器。

## License

[MIT](LICENSE)
