---
name: h3-prompt-writing
description: 分镜出片提示词：integrated_multimodal_description + 图1图2图3身份 + 时间轴 + 台词只进 <d>。
triggers: 视频,Comfy,H3,配音,口播,图生视频,提示词,优化提示词
---

# 分镜视频提示词

点「优化提示词」必须产出下面这个格式。画布上仍然是 **一镜一条成片**。

## 必须写图1 / 图2 / 图3 是谁

参考图是人设/场景锁定，**不是首帧**。正文开头必须按连线顺序写：

```text
Reference pictures (follow this mapping exactly):
图1：「刘彦昌」 / <Picture 1> is this person's character design. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
图2：「沉香」 / <Picture 2> is this person's character design. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
图3：「破屋」 / <Picture 3> is the location. Lock space, materials, weather and light. One unified place.
```

不要写 `Picture 1 aligns with 0.00 seconds`。不要写 Ref2VA 六段。

## 标本格式

```text
integrated_multimodal_description:
Reference pictures (follow this mapping exactly):
图1：「刘彦昌」 / <Picture 1> is this person's character design. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
图2：「沉香」 / <Picture 2> is this person's character design. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
图3：「破屋」 / <Picture 3> is the location. Lock space, materials, weather and light. One unified place.

[Shot 1] Grounded ancient Chinese family drama, photorealistic live-action, 16:9. Clean low-noise digital cinema image, natural skin texture, restrained oil-lamp light and cool rain light. No glamour filter, oily highlights or exaggerated warm color grading.

Rain falls heavily outside the poor mountain house. Sixteen-year-old Shenxiang sits opposite his father Liu Yanchang at a rough wooden table. This is one continuous six-second emotional shot. The camera movement is extremely restrained so the actors' expressions remain the focus.

[00:00.000–00:01.200]
Begin with a tight table-level close-up. Liu Yanchang opens a worn thread-bound book with trembling hands, then places a jade hairpin on the table.

[00:01.200–00:05.200]
The camera slowly pushes into an intimate profile two-shot. Liu Yanchang grips Shenxiang's wrist and looks into his son's eyes:

<d>[Chinese, spoken on screen by Liu Yanchang, urgent reassurance changing into grief, accurate lip synchronization] 你娘没有不要你。</d>

His voice breaks:

<d>[Chinese, spoken on screen by Liu Yanchang, suppressed pain and guilt, accurate lip synchronization] 她被压在华山底下……整整十六年。</d>

Only Liu Yanchang speaks. Shenxiang's lips remain completely closed.

[00:05.200–00:06.000]
Focus shifts to Shenxiang. Relief becomes horror. He still cannot speak. The action develops continuously and finishes naturally within 0.80 seconds.

Camera language:
Tight close-up on trembling hands and jade hairpin → extremely slow push into an intimate profile two-shot → hold during the dialogue → final gentle focus shift onto Shenxiang. No rapid movement, no unnecessary orbit and no dramatic camera shake.

Performance direction:
Liu Yanchang's first sentence protects the mother; his second sentence confesses helplessness. Shenxiang feels relief first, then shock, then grief. Avoid calm exposition, emotionless father, immediate shouting, theatrical sobbing, speaking Shenxiang, subtitles and visible text.

overall_soundscape:
Steady rain on the roof and paper window, faint oil-lamp flame, old pages turning, jade touching wood, Liu Yanchang's uneven breathing and emotionally restrained Mandarin dialogue. No narrator and no music.

non_diegetic_music:
N/A
```

## 台词

- **只有嘴里真正说出来的字**进 `<d>`。场记、时长、画风、图1图2、Camera language、Performance direction 都不是台词。
- 表演、说话人、口型写在括号里：`<d>[Chinese, spoken on screen by Name, delivery, accurate lip synchronization] 原词</d>`。
- 没开口的人嘴唇保持完全闭合。没有对白就写 `No dialogue. No lips moving.`，不要把「无」放进 `<d>`。

## 写法

- 正文用英文写动作、光、表演；中文只允许出现在 `<d>` 和 `图N：「人名」`。
- 人物在正文里用真实名字（图1图2对应的人），不要匿名成不知道是谁的 the man。
- 用 `[00:00.000–00:01.200]` 时间轴写清楚每一拍。不要把时间轴当台词。
- `non_diegetic_music` 固定 `N/A`。不要配乐，不要旁白。
