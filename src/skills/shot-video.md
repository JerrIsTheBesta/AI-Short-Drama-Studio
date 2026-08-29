---
name: shot-video
description: 使用角色设计图、场景图和本镜故事看板生成可控的 MiniMax H3 视频。
triggers: 视频,出片,图生视频,运镜,动起来,生成视频
---

# 图生视频

出视频不要传人物+场景配图。最多 9 张参考图，按顺序传：本镜每个角色的设计图、这一镜的场景图、本镜故事看板。看板必须先按场景图和角色设计图生成，再作为这一镜的动作计划送给视频模型。

缺人设、场景或看板先补，不要先出配图。画外音镜头里被叫到的人不能张嘴。最终视频必须是单一完整画面，禁止复制四宫格、分格、边框、拼贴、字幕或标签。

出片使用 `videoPrompt` 的动作表演信息，不把配图用的 `visualPrompt` 原样送入 H3。`videoPrompt` 必须是这一镜的剧情表演（谁看见什么、做什么、情绪怎么变），不是按秒填空。选 **H3** 时按官方 Ref2VA 六段编译（见 `h3-prompt-writing`）：`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`。正文是连续 `[Shot 1]`，第一镜不加时间戳，运镜写成 `The camera pushes in with small amplitude at slow speed` 这种句内动作。中文场记不要写成 `From 0.00s to 1.50s`。人设图不是 I2VA 首帧。选万相时不套这套格式。

## 配音

- `h3-dialogue`：默认。H3 生成出镜对白和自然口型。
- `h3-voiceover`：H3 生成画外口播，画面人物不做说话口型。
- `tts`：H3 不生成人声，最终合成时混入独立 TTS。
- `none`：只有环境声。

人物名、声线和镜头描述都不是台词。最终 H3 提示词用官方英文；只有 `<d>[Chinese] 原词</d>` 会被朗读。出镜写 `<Subject 1> (S1) says:`，画外音写 `says in an off-screen voiceover` 并让嘴唇闭合。口播栏如果写的是景别或动作说明，就写 `No dialogue. No lips moving.`

## 运动与队列

- 每镜只采用分镜指定的一种主要运镜，动作在时长内完整结束。
- 指定镜头使用 `generate_video + shotId`；全部镜头使用 `generate_all_videos`（AutoDL 支持并发，缺视频的镜头会同时提交）。
- 任一步自检或生成失败都暂停后续流水线并报告具体镜头。
