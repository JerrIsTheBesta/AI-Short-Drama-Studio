---
name: h3-prompt-writing
description: Write shot-video prompts in the official MiniMax layout. Multimodal reference is six sections. First frame, first-and-last frame, last frame, and text-only stay three fields plus the matching alignment line. Bind each character as a stable (S1)/(S2).
compatibility: Portable to any agent that can read local files; no external tools are required.
---

# Shot Prompt Writing

For this product's shot-video nodes, match the node mode. Multimodal reference is the official six-section Ref2VA body. First-and-last frame is FL2VA: the alignment sentence, then the three fields. A single first frame is I2VA. A last frame only is L2VA. Text with no picture is T2VA.

## Speaker lock (mandatory)

(S1) is permanently the first character reference, (S2) the second. Do not renumber by dialogue order. Reference images are identity locks, not first frames.

```text
Speaker lock (these labels are the pictures):
(S1) is 「阿凯」 / <Picture 1>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
(S2) is 「大斌」 / <Picture 2>. Lock face, hair, body, age and outfit. Identity reference only, not the first frame.
<Picture 3> is the location 「出租屋」. Lock space, materials, weather and light. One unified place.
Only one (S#) speaks at a time. Everyone else keeps their lips completely closed.
```

On multimodal reference, identity lives in `subject_definitions` as `<Subject N> is 「name」 (S#) in <Picture N>`. Do not write `Picture 1 aligns with 0.00 seconds` in that mode. The alignment sentence belongs only to I2VA, FL2VA, and L2VA. Do not mix the six-section body with the three-field body.

## Body

1. After the speaker lock, write `[Shot 1]` with the real blocking: who is left or right, what they hold, and how a prop changes.
2. Each trusted line gets its own time range. Form: `(S1) says: <d>[Chinese] 原词</d>` then one sentence that everyone else keeps their lips closed.
3. English for action, camera, and light. Chinese only inside `<d>` and 「names」. A Chinese scene paragraph is deleted and the clip ships as an empty roster.
4. `overall_soundscape` names this scene's real sounds. Do not write only "close breath stay synchronized".
5. `non_diegetic_music` is always `N/A`.
