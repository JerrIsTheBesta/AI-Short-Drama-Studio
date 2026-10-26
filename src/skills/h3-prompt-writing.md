---
name: h3-prompt-writing
description: 分镜出片提示词：integrated_multimodal_description + (S1)(S2) 绑定参考图 + 独占台词 + 台词只进 <d>。
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词,优化提示词
---

# 分镜视频提示词

点「优化提示词」必须产出下面这个格式。画布上仍然是 **一镜一条成片**。

## 人物图用 (S1) (S2)，不要用「图1 是人设」

(S1) 永远是第一张人物参考图，(S2) 永远是第二张。编号跟着人走，不跟台词顺序走。参考图是身份锁定，**不是首帧**。

```text
Speaker lock (these labels are the pictures):
(S1) is 「阿凯」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「大斌」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location 「出租屋」. Lock space, materials, weather and light. One unified place.
Only one (S#) speaks at a time, and each person says their own line once. Everyone else keeps their lips completely closed. No overlap, no chorus, no second person repeating the same line.
```

不要写 `Picture 1 aligns with 0.00 seconds`。不要写 Ref2VA 六段。

## 标本格式

```text
integrated_multimodal_description:
Speaker lock (these labels are the pictures):
(S1) is 「阿凯」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「大斌」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.

[Shot 1] Grounded contemporary comedy, photorealistic live-action, 9:16. Afternoon light through the living-room window. (S1) 「阿凯」 squats at the left sofa, digging through cushions. (S2) 「大斌」 sprawls on the right sofa with a bag of chips. Neither looks into the lens.

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
- 没有对白就写 `No dialogue. No lips moving.`，不要把「无」放进 `<d>`。

## 写法

- 动作、机位、光用英文写。中文只留在 `<d>` 和「人名」里。写中文场面会被删掉，最后只剩人物名单。
- 写这场戏里真正发生的事：谁在左谁在右、手里拿什么、道具怎么变少。不要写 “Begin with the opening frame” 或 “let the frame breathe”。
- `overall_soundscape` 写这场的真实声音，例如薯片咔嚓、靠垫哗啦。不要只写 close breath。
- `non_diegetic_music` 固定 `N/A`。
