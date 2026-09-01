---
name: h3-prompt-writing
description: 选 MiniMax H3 时按官方规则写镜头提示词。分镜出片用 integrated_multimodal_description，一条成片内部可切 [Shot 1/2/3]。台词只放进 <d>，且只用中文原词。
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词,优化提示词
---

# MiniMax H3 官方提示词

只在出片模型是 **H3** 时用这套规则。万相不套。点「优化提示词」必须产出下面这个格式。

画布上仍然是 **一镜一条成片**。成片内部可以按官方格式切 `[Shot 1]` / `[Shot 2]` / `[Shot 3]`，这不是画布上的三个分镜节点。

## 分镜出片（默认）

全文英文；**只有** `<d>` 里的台词保留中文原词。不要写 Ref2VA 六段，不要写 Picture 1 首帧对齐句。

```text
integrated_multimodal_description:
[Shot 1] Cinematic, medium close-up, handheld with subtle natural sway, framed from a slight side angle so the man stands on the left of the frame and the boy on the right, with a soft shallow depth of field. Daylight in a narrow alley, low-key natural light. The man (S1), a lean, hard-faced young adult with a cold, controlled, low voice, stands in front of the boy (S2), a slight teenager with a soft, breathy, frightened voice. The man speaks first, his lips moving with a hard, flat delivery, and at the same time his open hand snaps across the boy's face in a sharp, fast slap: <d>[Chinese] 你知道我们为什么找你吗？</d>
The boy's head whips to the side from the impact, his body flinching back half a step. He slowly turns his head back to face the man, his eyes wide, his jaw trembling.

[Shot 2] At 00:03.000, the camera holds the same framing. The boy (S2) shakes his head slowly, his voice thin and breaking, the words barely louder than a whisper: <d>[Chinese] 我不知道啊。</d>
A short beat. The man (S1) does not let him finish; he steps in and delivers another sharp, fast slap across the boy's cheek, his lips moving again with the same hard, flat delivery: <d>[Chinese] 你很喜欢为朋友出头是吗？</d>
The boy stumbles back, both hands rising partway, but he does not raise them to fight back — only to brace himself against the wall behind him.

[Shot 3] At 00:06.000, the camera cuts to a slightly wider mid-shot from the same side angle. The man (S1) finishes speaking and immediately drives a hard, controlled front kick into the boy's lower torso. The boy's body folds around the impact and he drops to the packed earth with a heavy, dull thud, curling inward on instinct, arms wrapping over his head. The man (S1) does not follow up; he stands over the boy for a beat, breathing hard, then turns his head to look off-frame. The action develops continuously and finishes naturally within 3.00 seconds.

overall_soundscape:
A continuous low urban hum sits underneath. The first sharp, bright crack of an open-palm slap cuts in with the man's flat, hard voice, followed by a short, strangled gasp from the boy. The boy's thin, breaking reply is barely louder than a breath. The second slap lands with another bright crack, sharper than the first, and the man's second line follows immediately. After a beat, a heavy, dull thud of a kick into the body, then the wet, heavy sound of the boy's body hitting packed earth, followed by a choked grunt and rapid, shallow breathing. After that, almost nothing — only the wind, the man's slow exhale, and a thin, distant street noise.

non_diegetic_music:
N/A
```

## 写法

- `[Shot 1]` **不加时间戳**。不要写 `From 0.00s to 1.50s`。
- 后续内部镜写：`[Shot 2] At 00:03.000, the camera holds / cuts to...`
- 人物用英文外貌 + 稳定编号：`the man (S1)`、`the boy (S2)`。同一人跨内部镜编号不变。
- 除了 d 标签里的台词，提示词其余全部英文。禁止把中文人名、地名、场记写进正文。
- 风格、景别、构图、光线、人物外貌和声线写在 `[Shot 1]` 开头。
- 一条成片里可以有多个说话者；每句台词一个 `<d>[Chinese] 原词</d>`，放在那个人开口的那一拍。
- 最后一拍必须以 `The action develops continuously and finishes naturally within X.00 seconds.` 收住，X 是这一拍的时长，不是整条成片时长。
- 运镜写成句内动作。只改距离或小角度就用运镜；对白轮次、动作升级或景别变化才切内部镜。
- `overall_soundscape` 只写环境声和动作声，不要引用中文台词。
- `non_diegetic_music` 固定 `N/A`。

## 台词

1. 必须写成 `<d>[Chinese] 天还没亮，我就离开了家。</d>`，原词一个字都不能改。
2. 出镜：把说话动作和声线写在标签外，标签内只有语言标记和原词。
3. 旁白：`says in an off-screen voiceover`，出镜人物全部闭嘴。
4. 没有口播就写 `No dialogue. No lips moving.`，不要出现 `<d>`。

## I2VA（仅数字人 / 单张首帧）

数字人口播只有一张人物图，才走 I2VA，那张图才是 0.00 秒第一帧：

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description:
[Shot 1] Live-action, cinematic, a medium-wide shot frames...

overall_soundscape:
...

non_diegetic_music:
N/A
```
