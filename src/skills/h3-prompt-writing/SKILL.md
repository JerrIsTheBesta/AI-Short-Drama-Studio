---
name: h3-prompt-writing
description: Write MiniMax H3 prompts in the official English layout. Use Ref2VA for character sheets + scene + storyboard. Use I2VA only when Picture 1 is the actual first frame.
compatibility: Portable to any agent that can read local files; no external tools are required.
---

# H3 Prompt Writing

Follow the official MiniMax-H3 guides in `references/base-en.txt` (T2VA / I2VA / FL2VA / L2VA) and `references/ref-en.txt` (full-reference / Ref2VA). Do not use Chinese section headings. Do not use `From 0.00s to 1.50s`.

## When to use which layout

- **Ref2VA**: character design sheets, scene plate, storyboard. Pictures lock identity / place / planning. They are **not** the 0.00s first frame.
- **I2VA**: a single picture that **is** the first frame at 0.00s (talking-head / digital human).

## Ref2VA

Six sections in this order: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`.

```text
subject_definitions:
<Subject 1> is the young man in <Picture 1>, with ...
<Picture 3> is a storyboard reference for [Shot 1], defining viewpoint, subject placement, and shot order.

summary:
[reference generation] The target video is one continuous [Shot 1] ...

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - face, hair, outfit retained.

detailed_description:
The target video is in a cinematic, live-action style.
[Shot 1] A medium-wide shot frames...

overall_soundscape:
...

non_diegetic_music:
N/A
```

If a picture only defines a character or location, cite it inside `<Subject N>`. Do not also write `<Picture N> is the first frame`.

## Shared shot rules (base guide)

- `[Shot 1]` has **no timestamp**. Later shots: `[Shot 2] At 00:03.500, the camera cuts to...`
- Prefer camera motion over cuts when only distance or a slight angle changes.
- Camera as natural English: type + amplitude + speed. `The camera pushes in with small amplitude at slow speed toward...`
- Ref2VA style: 1–2 English sentences **before** `[Shot 1]`. I2VA style: after `[Shot 1]`.
- Timeline in prose: opening composition → action onset → continuous development → result. Generation tasks: 350–500 English words.
- Speakers: `<Subject 1> (S1) says: <d>[Chinese] ...</d>`
- Voiceover: `says in an off-screen voiceover` then `while his lips remain completely closed`.
- One continuous full-frame take. Never a slideshow, animatic, or panel-to-panel cut.

## I2VA

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames...

overall_soundscape: ...

non_diegetic_music: N/A
```
