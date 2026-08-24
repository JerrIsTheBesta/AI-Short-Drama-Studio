---
name: h3-prompt-writing
description: 为 MiniMax H3 编译多图参考提示词。图槽是角色设计图、场景图和故事看板，台词只放进 <d>。
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词
---

# MiniMax H3 多图参考提示词

出片用参考生成，不要再写「Picture 1 是 0.00 秒第一帧」。H3 认的是下面这套：

```text
subject_definitions:
<Subject 1> is the person from <Picture 1>...
<Subject 2> is the location from <Picture 2>...
<Picture 3> is a storyboard reference for [Shot 1]...

summary:
[reference generation] ...

detailed_description:
[Shot 1] ...

overall_soundscape:
...

non_diegetic_music:
N/A
```

## 图片

1. 不要把人物+场景配图送给 H3。
2. 角色设计图只锁身份，场景图只锁地点，故事看板只锁动作和顺序。
3. 画外音：出镜人物全部闭嘴。台词里的名字是在叫他，不是他在说。
4. 成片必须是单一全画幅，禁止宫格、拼贴、边框、字幕。

## 台词

1. 台词或旁白都必须写成 `<d>[Chinese] 天还没亮，我就离开了家。</d>`，原词一个字都不能改。
2. 出镜：`Ah Cheng (S1) says: <d>[Chinese] 天还没亮，我就离开了家。</d>`
3. 旁白：`An off-screen voice, Grandmother (S1), says in an off-screen voiceover: <d>[Chinese] 阿诚……阿诚……</d> Ah Cheng keeps the mouth completely closed.`
4. 除了 d 标签里的原词，提示词其余全部英文。
5. 没有口播就写 `No dialogue. No lips moving.`，不要出现 `<d>`。
