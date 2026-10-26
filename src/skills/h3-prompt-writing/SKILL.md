---
name: h3-prompt-writing
description: Write shot-video prompts as integrated_multimodal_description. Bind each character picture as a stable (S1)/(S2), put Chinese only inside <d>, and give each spoken line its own turn.
compatibility: Portable to any agent that can read local files; no external tools are required.
---

# Shot Prompt Writing

For this product's shot-video nodes, write one clip as `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music: N/A`.

## Speaker lock (mandatory)

(S1) is permanently the first character reference, (S2) the second. Do not renumber by dialogue order. Reference images are identity locks, not first frames.

```text
Speaker lock (these labels are the pictures):
(S1) is 「阿凯」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「大斌」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location 「出租屋」. Lock space, materials, weather and light. One unified place.
Only one (S#) speaks at a time. Everyone else keeps their lips completely closed.
```

Do not write `Picture 1 aligns with 0.00 seconds`. Do not emit `subject_definitions` / `summary` / `retention_analysis`. Do not write `图1 / this person's character design`.

## Body

1. After the speaker lock, write `[Shot 1]` with the real blocking: who is left or right, what they hold, and how a prop changes.
2. Each trusted line gets its own time range. Form: `(S1) says: <d>[Chinese] 原词</d>` then one sentence that everyone else keeps their lips closed.
3. English for action, camera, and light. Chinese only inside `<d>` and 「names」. A Chinese scene paragraph is deleted and the clip ships as an empty roster.
4. `overall_soundscape` names this scene's real sounds. Do not write only "close breath stay synchronized".
5. `non_diegetic_music` is always `N/A`.
