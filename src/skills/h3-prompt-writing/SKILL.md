---
name: h3-prompt-writing
description: Write MiniMax H3 video prompts using the project's production script layout (Aesthetic, shot timing, camera, visual prompt, audio/dialogue) while preserving H3 dialogue and reference-frame semantics.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---

# H3 Prompt Writing

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, read `references/base-en.txt` for H3 semantics, then render the project production template below.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve dialogue verbatim inside `<d>[Language] ...</d>` and keep timing consistent with the requested duration.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

For this project, output sections in this exact order: `Aesthetic`, `[SHOT 1]`, `Duration`, `Camera Motion`, `Visual Prompt`, `overall_soundscape`, `non_diegetic_music`. Ambient sound belongs only in `overall_soundscape` and must be English. Chinese is allowed only inside `<d>` for spoken lines. I2VA visual text starts from the reference frame and locks subject identity, clothing, props, lighting direction, and layout.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.
## Tips for Better Results
- Always match the total duration of the description to the requested video length (4–15 seconds).
- Keep reference labels consistent (e.g. `<Picture 1>`, `<Video 1>`, `<Audio 1>`) across every section.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.
