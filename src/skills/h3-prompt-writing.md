---
name: h3-prompt-writing
description: 按当前设置写给 ComfyUI 的图生视频提示词；每镜可选择 H3 对白/画外口播、独立 TTS 或无口播。
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词
---

# MiniMax H3 → ComfyUI 提示词

代码路径已用 `composeH3VideoPrompt` / `composeVideoPrompt` 自动组装。写法看设置里的「提示词写法」，智能体不要另写一套。

底层语义规范在 `src/skills/h3-prompt-writing/references/base-en.txt`。

## 场景叙事（默认，配图里已经有人）

喂给 ComfyUI 的是两段连贯中文，不要套 Aesthetic / SHOT / Visual Prompt 标签：

1. `从第一帧接着演。画面中：站位、发型、衣服、手脚正在做什么、年龄的人是名字；下一个人……`
2. 空一行后连续叙述：谁做什么、表情神态、台词原词放在引号里、环境怎么动、镜头怎么走、怎么收。

出视频时只用本镜配图。用视觉模型对照人设点名画面里的人，写进第一段。

## 格式化（人物图 + 空镜底板直接出视频）

画面里还没合成好人时用。结构：

1. `Aesthetic`
2. `[SHOT 1]` / `Duration` / `Camera Motion`
3. `Visual Prompt:`（从第一帧接着演。写细：每个角色的表情神态、动作、环境反应；对白原词同时放进 `<d>`）
4. `overall_soundscape:` **单独一段，必须英文**。环境音、动作音、非语言人声。禁止中文，禁止把台词写进来。
5. `non_diegetic_music:` 观众才能听到的配乐；没有则 `N/A`。

说话人、音色与情绪写成英文自然句；**只有 `<d>` 内可以保留中文台词**。

## 配音职责

- `h3-dialogue`：H3 生成出镜对白并对口型。场景叙事把原词写进叙述引号；格式化把原词放进 `<d>`。
- `h3-voiceover`：H3 生成画外口播。
- `tts`：H3 不生成人声，后期混入独立 TTS。
- `none`：不生成口播，只保留环境声。

## 生成视频时

- 场景叙事：**只传本镜配图**。不要附加人设图或场景底板。
- 格式化：可以附加人物图 / 空镜底板，并在提示词里说明图一、图二是什么。
- **禁止把配图 visualPrompt 拿去出视频。**
- 时长与描述一致（约 5–10 秒）。
