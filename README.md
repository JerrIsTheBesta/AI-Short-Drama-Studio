# 剧流 Studio

> 本地优先、模型自由接入的开源 AI 视频创作工作台。

[![Latest Release](https://img.shields.io/github/v/release/JerrIsTheBesta/AI-Short-Drama-Studio?label=最新版&color=5865f2)](https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883.svg)](https://vuejs.org/)
[![Electron](https://img.shields.io/badge/Electron-Windows-47848f.svg)](https://www.electronjs.org/)

![剧流 Studio：一键生成 AI 短剧、云算力、ComfyUI、中转站接入、视频复刻、AI 带货口播和视频剪辑](docs/images/github-hero-2026.png)

剧流 Studio 把剧本、角色、场景、分镜、图片、视频、配音、音乐和最终合成放进一张可视化画布。你可以让智能体推进完整创作，也可以随时修改节点、连接素材、替换模型或只重做其中一步。

项目不绑定某一家 AI 服务。语言模型、视觉理解、生图、视频、配音和音乐都可以使用不同厂商、中转站、本地 ComfyUI 或自定义工作流。

![剧流 Studio 首页实拍：项目、剧本管理、素材库、图库模板、工具集与视频教程入口](docs/images/studio-home-overview.png)

## 直接下载

不想配置开发环境的 Windows 用户，可以直接下载安装包：

### [下载最新版剧流 Studio](https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio/releases/latest)

在 Release 页面下载 `Studio.Setup.*.exe`，双击安装即可，无需安装 Node.js、npm 或 FFmpeg。

> 安装包暂未购买代码签名证书。如果 Windows SmartScreen 提示风险，请确认文件来自本项目 GitHub Releases，再选择“更多信息 → 仍要运行”。

## 一张画布完成整个创作

![剧流 Studio 统一画布：智能体、剧本、人物、场景、分镜、视频与合成节点](docs/images/studio-workflow-overview.png)

新建项目后会直接进入统一画布：

- 想自动完成：告诉左侧智能体你要做什么，它可以规划、创建节点、连接素材并推进流程。
- 想精细控制：直接编辑剧本、分镜、提示词、模型、参考图、时长和节点连接。
- 已经有素材：把图片、视频、音频或 Markdown 剧本导入画布，从任意步骤开始。
- 只想走传统流程：仍可使用经典步骤导航，依次完成文案、分镜、配图、视频、剪辑与导出。

所有节点都可以检查、修改和局部重做，不必因为一个镜头失败而重新生成整个项目。

## 连续拍：同场接末帧，换场重新起镜

一场戏说不完、演不完，不必硬塞进一个视频，也不必让每段从头演。**连续拍**会把同场戏拆成多个子镜头，让后一段从前一段的实际最后一帧接着拍。换地点或跳时间时，则使用新场景的起始画面，不把上一场的画面带过去。适合连续对白、长动作和多场景短剧。

1. **先看制作计划**：将一集剧本加入画布，或在对话中粘贴、附上剧本。打开画布智能体输入框下方「技能」右侧的「连续拍」，发送「分析剧本」。智能体会按快节奏短剧估算成片时长，列出每场所需资产、原对白和子镜头，把 JSON 计划和分镜稿放到画布上。
2. **逐场确认资产**：先看人物、道具、场景和起始画面清单，回复「继续」才生成本场缺少的素材。同一个角色或道具在后面再次出现时，优先复用已完成的资产。
3. **确认后按场拍摄**：全部场景资产检查齐全后，再回复「继续」启动视频生成。每段至少 6 秒，上限随所选模型或工作流变化。例如，需要约 21 秒的戏，用上限 15 秒的模型可以拆成 15 秒 + 6 秒，让台词按自然语速说完。

连续拍是独立模式，关闭开关即可回到原有创作流程。中断后可继续，已完成的资产和片段不会重新生成。片段按顺序留在画布上，不会自动合成成片。

[查看连续拍使用说明与模型限制](docs/连续拍模式.md)

## 核心能力

### AI 创作智能体

- 根据自然语言判断本轮任务，生成计划并调用画布工具。
- 创建、连接、删除、重命名和整理节点，支持项目体检与失败续跑。
- 可记住本地创作偏好，回复支持富文本、计划卡片、执行轨迹和可复制提示词。
- 创作偏好集中设置画幅、图片模型和视频模型，单个节点仍可覆盖。

### 剧本创作与管理

- 从一句创意起步，让 AI 先拟大纲再分集创作；也可以导入已有剧本，按你的要求改写、续写或打磨对白。
- 剧本自动保存为 Markdown，桌面端存放在项目根目录的 `_scripts/`。
- 支持分集编辑、Markdown 源码与排版预览、插入、删除、排序、导入和导出。
- 写好的剧本可选集送入画布，继续提炼人物、场景与分镜。

### 专业分镜与提示词

- 从剧本提取角色、场景和镜头，并按视频模型允许的时长规划每个镜头。
- 描述镜头内的动作时间轴、站位、视线、表演、运镜、对白和环境声音。
- 支持单镜头优化与批量队列优化，生成结果始终可见、可编辑。
- 支持人物身份、场景、故事看板、首尾帧和多图参考关系。

### 内置导演技能与分镜风格

画布智能体会按任务调用内置创作指南，涵盖短剧编剧、分镜导演、角色一致性、故事看板、图像与视频提示词。比如拆分镜时，把剧本里的动作和对白落实到景别、站位、运镜与声音；优化 MiniMax H3 多图参考提示词时，按六段式组织参考图和镜头描述。

在画布左侧智能体输入框下方打开「技能」，可搭配选择两类偏好：

- **分镜方式**：快切竖屏适合节奏紧凑的短剧；一镜一场强调连续动作；情绪特写突出表演和反应；蒙太奇适合用画面组合压缩时间。
- **题材与内容**：甜宠短剧、逆袭打脸、悬疑反转、家庭伦理、穿越重生、霸总都市、口播带货。

两类偏好可以组合，例如「快切竖屏 + 悬疑反转」。它们为创作提供参考，不替代剧本和你的明确要求。也可以在「技能 → 我的」导入自己的导演技能。

### 内置图库模板

![剧流 Studio 图库模板：单人姿势、双人站位、动态动作与角色定妆，支持预览和参考图选用](docs/images/studio-gallery-overview.png)

从首页左侧打开「图库模板」浏览图册；需要给模型用图时，也可以从画布节点的「添加参考图」里直接选用。

- **单人姿势**：跪坐、奔跑、弓步等线稿，用于参考肢体姿态和重心。
- **双人站位**：相面对话、前坐后立、错身回望等线稿，用于安排人物距离、朝向和前后关系。
- **动态动作**：腾跃、后翻、撑地等线稿，用于设计动作中的关键姿态。
- **角色定妆**：一张多视角角色设定板示例。点击「查看 · 提示词」可复制生成提示词，再换成自己的角色、服装和配饰。

### 图片、视频与声音

- 生成人设图、角色卡、场景图、分镜图、故事看板和关键帧。
- 支持接入 GPT Image、Nano Banana、Seedream 等图像模型，以及 H3、万相与本地或云端 ComfyUI 工作流。
- 支持参考图视频、首尾帧视频、任务轮询、失败恢复和批量处理。
- 角色卡可配置音色描述和参考音频，按“角色名：台词”匹配配音与声音复刻。

### 剪辑与导出

- 导入本地视频、音乐、字幕和文字，也可直接使用项目生成素材。
- 支持片段排序、左右裁切、速度、音量、转场、音乐轨、字幕和文字轨。
- 可选择保留镜头原声或去除原声，再与对白、环境音和配乐合成。
- 使用 FFmpeg.wasm 在本机完成拼接、混音、字幕烧录和导出。

## 三步开始使用

1. 安装并打开应用，在“设置 → 语言模型”配置一套可用 LLM。
2. 打开“接入助手”，粘贴其他服务的 API 文档，让助手配置视觉、生图、视频、配音等能力。
3. 回到首页点击“新建”，直接告诉画布左侧智能体你想制作的视频。

新手先看：[综合视频教程：配置、软件操作与短剧制作入门](https://www.bilibili.com/video/BV1o6n66fE5p/) · [第一次使用图文教程](docs/教程-第一次用.md)

> AI 服务的账号、API Key 和额度需要用户自行准备。仓库及公开安装包不包含任何真实 Key。

## 模型与服务接入

每类能力都可以保存多套配置，并在项目或节点中切换：

- 语言模型：OpenAI Chat Completions 兼容接口、官方厂商或中转站。
- 视觉理解：参考图分析、人物与场景提取、画面质检。
- 图片生成：GPT Image、Nano Banana、Seedream，可通过对应的兼容接口接入，也支持 ComfyUI 和自定义接口。
- 视频生成：MiniMax H3、万相、AutoDL、Zealman、本地或云端 ComfyUI 及自定义工作流。
- 配音与音乐：TTS、参考音频复刻、环境声音和配乐服务。

建议先配置语言模型，再把公开 API 文档交给接入助手。私人 Key 最好在对应设置页面手动填写，不要粘贴到不可信的第三方对话中。

## 从源码运行

### 环境要求

- Node.js 22.12+
- npm 10+
- Windows 10/11 或 macOS（Electron 桌面版）

### 安装并运行桌面版

```bash
git clone https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio.git
cd AI-Short-Drama-Studio
npm ci
```

如果 macOS 上安装 Electron 时遇到网络或代理下载错误，可通过 Electron 镜像并启用 Node 24.5+ 的系统代理支持：

```bash
NODE_OPTIONS=--use-env-proxy ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
```

下载本地 FFmpeg 核心：

```bash
# 国际网络
node scripts/download-ffmpeg-core.cjs

# 中国大陆镜像
node scripts/download-ffmpeg-core.cjs --source=npmmirror
```

启动 Electron 桌面开发版：

```bash
npm run dev
```

如需单独运行 Web 版本：

```bash
npm run web
```

## 构建桌面安装包

在 macOS 上运行以下命令会为当前 Mac 芯片架构生成 `.dmg` 和 `.zip`；在 Windows 上会生成 `.exe` 安装包：

```bash
npm run electron:build
```

安装包会生成到 `release/`。macOS 首次打开未签名应用时，按住 Control 点击应用并选择“打开”。构建流程会自动执行类型检查、源码凭据扫描、生产构建和打包内容检查。

也可以分别执行：

```bash
npm run type-check
npm run security:check
npm run build
```

## 数据存储与隐私

- 桌面端默认将项目保存在“文档/AI-Cut”，也可以在设置中修改素材根目录。
- 每个项目拥有独立目录和 `project.json`；剧本、图片、视频和音频均保存在本地。
- Web 版使用 IndexedDB；清理浏览器站点数据前请先导出重要内容。
- 必要的提示词和素材会发送给用户自行配置的第三方 AI 服务，其数据政策由对应服务商决定。
- `.env`、私钥和常见凭据文件默认被 Git 忽略，发布前还会扫描源码与构建产物。

详细说明：[安全策略](SECURITY.md) · [项目架构](ARCHITECTURE.md) · [完整功能](FEATURES.md)

## 技术栈

Vue 3 · TypeScript · Pinia · Vue Flow · Electron · FFmpeg.wasm

```text
src/
├─ components/   画布节点、智能体、设置与时间线组件
├─ services/     AI 接口、画布编排、存储与 FFmpeg
├─ stores/       项目、剧本、素材与设置状态
├─ types/        项目、节点、任务与时间线类型
└─ views/        首页、统一画布、剧本库、剪辑与设置页面
```

## 参与开发

欢迎提交 Issue 和 Pull Request。新增模型或服务时，请把协议差异封装在 `src/services/ai/`，不要在源码、日志或截图中提交真实凭据。

- [贡献指南](CONTRIBUTING.md)
- [更新日志](CHANGELOG.md)
- [最新版本](https://github.com/JerrIsTheBesta/AI-Short-Drama-Studio/releases/latest)

## License

[MIT License](LICENSE)
