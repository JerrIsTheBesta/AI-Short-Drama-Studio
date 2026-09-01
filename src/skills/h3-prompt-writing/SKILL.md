---
name: h3-prompt-writing
description: Write shot-video prompts as integrated_multimodal_description with 图1/图2/图3 identity, timed beats, and Chinese only inside <d> tags.
compatibility: Portable to any agent that can read local files; no external tools are required.
---

# Shot Prompt Writing

For this product's shot-video nodes, write one clip as `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music: N/A`.

## Picture roster (mandatory)

Reference images are character/location locks, **not** first frames. Copy this mapping at the start of the description:

```text
Reference pictures (follow this mapping exactly):
图1：「刘彦昌」 / <Picture 1> is this person's character design. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
图2：「沉香」 / <Picture 2> is this person's character design. ...
图3：「破屋」 / <Picture 3> is the location. ...
```

Do not write `Picture 1 aligns with 0.00 seconds`. Do not emit `subject_definitions` / `summary` / `retention_analysis`.

## Body

1. `[Shot 1]` plus genre, photoreal look, aspect, light, who is in the room, that this is one continuous N-second shot, camera restrained.
2. Timed beats `[00:00.000–00:01.200]` covering the whole clip.
3. Spoken words only inside `<d>[Chinese, spoken on screen by Name, delivery, accurate lip synchronization] 原词</d>`. Director notes, timestamps, style, and 图1/图2 are **not** speech.
4. End with `Camera language:` and `Performance direction:`.
5. Last beat ends with `The action develops continuously and finishes naturally within X.00 seconds.`
6. Use the actual names from 图1/图2 in the action. Do not anonymize them if you know who they are.

`non_diegetic_music` is always `N/A`. No narrator and no music.
