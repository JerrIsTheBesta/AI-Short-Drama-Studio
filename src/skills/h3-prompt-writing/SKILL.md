---
name: h3-prompt-writing
description: Write MiniMax H3 I2VA prompts in the official English three-field layout.
compatibility: Portable to any agent that can read local files; no external tools are required.
---

# H3 Prompt Writing

Use the official I2VA layout from the local reference files. Do not use Chinese section headings.

```text
For the target video, at 0.00 seconds into the target video, (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: N/A
```

- Pictures are character design sheets, the scene plate, and this shot's storyboard. Never send the composed still.
- Character sheets lock identity only. The scene plate locks place only. The storyboard is the action plan.
- One continuous full-frame video. Never reproduce grids, four-view sheets, storyboards, collage, or labels.
- Spoken words belong only in `<d>[Chinese] exact words</d>`. Shot directions are never spoken.
- If there is no speech, write `No dialogue. No lips moving.`
