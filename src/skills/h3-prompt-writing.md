---
name: h3-prompt-writing
description: 按 MiniMax H3 规范写给 ComfyUI 的图生视频提示词；每镜可选择 H3 对白/画外口播、独立 TTS 或无口播。
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词
---

# MiniMax H3 → ComfyUI 提示词

代码路径已用 `composeH3VideoPrompt` / `composeVideoPrompt` 自动组装，智能体不要另写一套自由格式。

底层语义规范在 `src/skills/h3-prompt-writing/references/base-en.txt`。

## 传给 ComfyUI 的结构（I2VA）

1. `Aesthetic`
2. `[SHOT 1]` / `Duration` / `Camera Motion`
3. `Visual Prompt:`（从第一帧接着演。写细：每个角色的表情神态、动作、环境反应；对白原词同时放进 `<d>`）
4. `overall_soundscape:` **单独一段，必须英文**。环境音、动作音、非语言人声。禁止中文，禁止把台词写进来。
5. `non_diegetic_music:` 观众才能听到的配乐；没有则 `N/A`。

## 配音职责

- `h3-dialogue`：H3 生成出镜对白并对口型，台词原样放进 `<d>`。
- `h3-voiceover`：H3 生成画外口播。
- `tts`：H3 不生成人声，后期混入独立 TTS。
- `none`：不生成口播，只保留环境声。
- 说话人、音色与情绪写成英文自然句；**只有 `<d>` 内可以保留中文台词**。
- 「衣衫摩擦、梨子轻碰盘底、远处铜铃」这类必须进 `overall_soundscape:` 的英文 foley，不能跟对白混在一行。

## 生成视频时

- **只传本镜配图**。不要附加人设图或场景底板。
- 用视觉模型认画面里谁是谁，写在视频内容表现开头。
- **禁止把配图 visualPrompt 拿去出视频。**
- 必须带上 `audioDescription`，组装时转成英文 `overall_soundscape`。
- 时长与描述一致（约 5–10 秒）。
