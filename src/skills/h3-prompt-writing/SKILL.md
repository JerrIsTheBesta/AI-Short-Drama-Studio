---
name: h3-prompt-writing
description: Write MiniMax H3 shot prompts as integrated_multimodal_description with internal [Shot 1/2/3] cuts. Chinese only inside <d> tags.
compatibility: Portable to any agent that can read local files; no external tools are required.
---

# H3 Prompt Writing

Follow the official MiniMax-H3 guides in `references/base-en.txt` (T2VA / I2VA / FL2VA / L2VA). For this product's shot-video nodes, use the I2VA three-field body **without** a Picture 1 first-frame lead. Do not use Chinese section headings. Do not use `From 0.00s to 1.50s`.

## Shot video (default)

One canvas shot = one generated clip. Inside the clip you MAY cut:

```text
integrated_multimodal_description:
[Shot 1] Cinematic, medium close-up, handheld with subtle natural sway... The man (S1)... : <d>[Chinese] 你知道我们为什么找你吗？</d>
...

[Shot 2] At 00:03.000, the camera holds the same framing. The boy (S2)... : <d>[Chinese] 我不知道啊。</d>
...

[Shot 3] At 00:06.000, the camera cuts to a slightly wider mid-shot... The action develops continuously and finishes naturally within 3.00 seconds.

overall_soundscape:
A continuous low urban hum sits underneath. ...

non_diegetic_music:
N/A
```

- `[Shot 1]` has **no timestamp**. Later shots: `[Shot 2] At 00:03.000, ...`
- English everywhere except the exact spoken words inside `<d>[Chinese] ...</d>`.
- Refer to people as `the man (S1)` / `the boy (S2)` from appearance. Never write Chinese names outside `<d>`.
- One `<d>` tag per spoken line. Multiple speakers in one clip are allowed.
- Last internal shot ends with `finishes naturally within X.00 seconds` using that beat's duration.
- `non_diegetic_music` is always `N/A`.
- Do not emit `subject_definitions` / `summary` / `retention_analysis` for shot video.

## Shared shot rules (base guide)

- Prefer camera motion over cuts when only distance or a slight angle changes.
- Camera as natural English: type + amplitude + speed.
- Style, composition, light, and character appearance sit at the start of `[Shot 1]`.
- Voiceover: `says in an off-screen voiceover` then lips remain closed.

## I2VA (digital human / true first frame only)

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames...

overall_soundscape: ...

non_diegetic_music: N/A
```
