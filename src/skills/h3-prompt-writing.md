---
name: h3-prompt-writing
description: 选 MiniMax H3 时按官方规则写镜头提示词。多图人设/场景/看板走 Ref2VA 六段；单张首帧走 I2VA。台词只放进 <d>。
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词
---

# MiniMax H3 官方提示词

只在出片模型是 **H3** 时用这套规则。万相不套。

本产品分镜出片传的是角色设计图 + 场景图 + 故事看板，走 **Ref2VA（全参考）**，不是 I2VA。人设图和看板 **不是** 成片 0.00 秒第一帧，不要写 `For the target video, at 0.00 seconds... <Picture 1> is fully referenced.`

数字人口播只有一张人物图，才走 **I2VA**，那张图才是 0.00 秒第一帧。

## Ref2VA 六段（分镜出片）

顺序固定，全文英文；只有 `<d>` 里的台词和画面上可见文字保留原文。

```text
subject_definitions:
<Subject 1> is Person 1 in <Picture 1>, the person whose face, hair, body, age and outfit must stay locked.
<Subject 2> is Place 1 in <Picture 2>, the location for [Shot 1].
<Picture 3> is a storyboard reference for [Shot 1], defining viewpoint, subject placement, and shot order.

summary:
[reference generation] The target video is one continuous [Shot 1] of <Subject 1> in <Subject 2>. <Picture 3> is a storyboard reference for [Shot 1] only.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 1>.
<Subject 2> (appears in [Shot 1]): fully_preserved - space, materials, weather and light from <Picture 2>.
<Picture 3> (storyboard for [Shot 1]): weak_reference - viewpoint, blocking and order only; the panel grid never appears on screen.

detailed_description:
The target video is in a cinematic, live-action style with soft lighting.
[Shot 1] A medium-wide shot frames...

overall_soundscape:
Natural room tone and physical action sounds stay synchronized with the picture.

non_diegetic_music:
N/A
```

人设图只锁身份：写进 `<Subject N> is ... in <Picture N>`，**不要**再单开一行把人设图写成 first frame。看板才单独写 `<Picture N> is a storyboard reference for [Shot 1]...`。

`retention_analysis` 标记只用：`fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`。

## 镜头正文（和 T2VA/I2VA 共用）

- `[Shot 1]` **不加时间戳**。不要写 `From 0.00s to 1.50s`。
- 后续镜才写：`[Shot 2] At 00:03.500, the camera cuts to...`
- 本产品一镜一条成片：写成 **一条连续 [Shot 1]**。只改距离或小角度就用运镜，不要切镜。
- Ref2VA：风格写在 `[Shot 1]` **前面** 1–2 句英文。I2VA：风格写在 `[Shot 1]` 后面。
- 时间线用连续叙事：开幅构图 → 动作起幅 → 持续发展 → 结果/反应。不要写成 `From 0.00s to 1.50s`。
- 生成任务 `detailed_description` 通常 **350–500 英文词**。每镜写清构图、外貌站位、环境光、动作状态、运镜、声音、参考标签生效点。不要缩成剧情摘要。
- 运镜写成句内动作，三维：**类型 + amplitude + speed**。例：`The camera pushes in with small amplitude at slow speed toward...`
- 可用类型：Push In / Pull Out / Pan Left|Right / Truck / Tilt Up / Down / Pedestal / Arc Shot / Tracking Shot / Static Shot / Shake Slightly
- 整镜只用一种运镜：起幅 → 持续 → 收住。
- 表情必须跟看见的事挂钩。每个人写清 foreground/behind、身体朝向、眼睛看谁。人设图是正面身份锁，成片不要抄成合影看镜头。说话者可以在后面，前面的人回头或侧头看他。

## I2VA（仅数字人 / 单张首帧）

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description:
[Shot 1] Live-action, cinematic, a medium-wide shot frames...

overall_soundscape:
...

non_diegetic_music:
N/A
```

`<Picture 1>` 就是 0.00 秒第一帧。

## 图片

1. 不要把人物+场景配图送给 H3。
2. 角色设计图只锁身份，场景图只锁地点，故事看板只锁动作和顺序。
3. 不同 Picture 是不同的人，禁止换脸。
4. 画外音：出镜人物全部闭嘴。台词里的名字是在叫他，不是他在说。
5. 成片必须是单一全画幅连续动作，禁止宫格、拼贴、边框、字幕，禁止把六格看板播成幻灯片。

## 台词

1. 台词或旁白都必须写成 `<d>[Chinese] 天还没亮，我就离开了家。</d>`，原词一个字都不能改。
2. 出镜：`<Subject 1> (S1) says: <d>[Chinese] 天还没亮，我就离开了家。</d>`
3. 旁白：`<Subject 1> (S1) says in an off-screen voiceover: <d>[Chinese] 阿诚……阿诚……</d> while his lips remain completely closed.`
4. 除了 d 标签里的原词，提示词其余全部英文。
5. 没有口播就写 `No dialogue. No lips moving.`，不要出现 `<d>`。
