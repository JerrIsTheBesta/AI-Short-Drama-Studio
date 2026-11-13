---
name: h3-prompt-writing
description: 分镜出片提示词。多模态参考用官方六段；首尾帧/首帧/尾帧/纯文本用三段加对齐句。(S1)(S2) 绑定人物，台词只进 <d>。
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词,优化提示词
---

# 分镜视频提示词

点「优化提示词」按节点模式出官方格式。画布上仍然是 **一镜一条成片**。

- 多模态参考：六段 `subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`。人物是 `<Subject N> (S#)`，图是身份锁定，不是首帧。summary 以 `[reference generation]` 开头。
- 首尾帧 FL2VA：对齐句（Picture 1 = 0.00 秒，Picture 2 = 片尾）加三段 `integrated_multimodal_description`。
- 单张首帧 I2VA：`at 0.00 seconds` 对齐句加三段。
- 只有尾帧 L2VA：Picture 1 对齐片尾，加三段。
- 纯文本 T2VA：只有三段，没有对齐句。

## 人物图用 (S1) (S2)，不要用「图1 是人设」

(S1) 永远是第一张人物参考图，(S2) 永远是第二张。编号跟着人走，不跟台词顺序走。参考图是身份锁定，**不是首帧**。

```text
Speaker lock (these labels are the pictures):
(S1) is Ah Kai / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is Da Bin / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location rental room. Lock space, materials, weather and light. One unified place.
Only one (S#) speaks at a time, and each person says their own line once. Everyone else keeps their lips completely closed. No overlap, no chorus, no second person repeating the same line.
```

多模态参考不要写 `Picture 1 aligns with 0.00 seconds`。首尾帧才写那句对齐。不要把六段和三段混在同一条稿里。

## 多模态参考的六段

`subject_definitions` 写 `<Subject N> is EnglishName (S#) in <Picture N>`。名字用英文，不要写「中文名」。下面这段镜头正文放进 `detailed_description`，不要再外包一层 `integrated_multimodal_description`。首尾帧 / 首帧 / 尾帧 / 纯文本才用三段，而且对齐句在三段前面。

```text
subject_definitions:
<Subject 1> is Ah Kai (S1) in <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Subject 2> is Da Bin (S2) in <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Subject 3> is the rental room in <Picture 3>, the location for [Shot 1].

summary:
[reference generation] The target video is one continuous [Shot 1] of <Subject 1> and <Subject 2> in <Subject 3>. Character sheets lock identity only.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 1>.
<Subject 2> (appears in [Shot 1]): fully_preserved - face, hair, body, age and outfit from <Picture 2>.
<Subject 3> (appears in [Shot 1]): fully_preserved - space, materials, weather and light from <Picture 3>.

detailed_description:
[Shot 1] Grounded contemporary comedy, photorealistic live-action, 9:16. Afternoon light through the living-room window. (S1) Ah Kai squats at the left sofa, digging through cushions. (S2) Da Bin sprawls on the right sofa with a bag of chips. Neither looks into the lens.

[00:00.000–00:01.200]
Wide view from the doorway. Both mouths stay closed. Chip crunch and cushion rustle only.

[00:01.200–00:05.600]
Cut to (S1) alone. (S2) is off screen.
(S1) says: <d>[Chinese] 我那条黑领带呢！上周刚买的！你见着没有啊！</d>
Only (S1) speaks in this shot. (S2) keeps their lips completely closed and makes no voice.

[Shot 2] At 00:05.600
Cut to (S2) alone. He swallows before he talks.
(S2) says: <d>[Chinese] 你自己扔的地方问我？反正我零食罐里没藏领带。</d>
Only (S2) speaks in this shot. (S1) keeps their lips completely closed and makes no voice.
The chip bag is visibly emptier than at the start. The action develops continuously and finishes naturally within 8 seconds.

overall_soundscape:
Quiet living-room tone, cushion rustle, crisp chip crunch. Only the speaking (S#) is heard, and only the words inside the d tag. No music.

non_diegetic_music:
N/A
```

## 台词

- 每句台词只说一次，由它自己的 (S#) 说，单独占一个时间段。
- 形式固定：`(S1) says: <d>[Chinese] 原词</d>`，紧跟着写另一个人嘴唇闭合。
- 场记、时长、画风、人物名单都不是台词。
- 没有对白就不要写 dialogue、lips、mouths、voices。不要把「无」放进 `<d>`。

## 写法

- 动作、机位、光、人名、地名都用英文写。中文只留在 `<d>` 台词里。写中文场面或中文名字会被删掉。
- 写这场戏里真正发生的事：谁在左谁在右、手里拿什么、道具怎么变少。不要写 “Begin with the opening frame” 或 “let the frame breathe”。
- `overall_soundscape` 写这场的真实声音，例如薯片咔嚓、靠垫哗啦。不要只写 close breath。
- `non_diegetic_music` 固定 `N/A`。
