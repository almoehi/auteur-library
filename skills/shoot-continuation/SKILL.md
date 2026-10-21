---
name: shoot-continuation
description: >
  Use when the task prompt says "Load and use skill shoot-continuation", or asks to
  "continue", "shoot the next clip", "extend" or "carry on from" an existing rendered video clip
  (named as an `artifact://<id>/<file>` and its `task://<id>`). Produces ONE new video clip that
  picks up where the prior clip ends, rendered with a reference-to-video / video-continuation
  workflow into this task's output artifact. Do NOT invoke for shooting a scene from scratch,
  storyboard rendering, prompt writing only, image or design tasks, or assembling clips.
agentType: worker
---

# Shoot Continuation — one new clip that continues a prior clip

Person-driven variant of `shoot-clip` mode `continue`. `shoot-clip` is the authority for the mechanics: workflow selection, references, measuring the predecessor, start offset, no cut, prompt route, render, `render_info` audit. This skill only adds the brief and the continuity check.

## 1. Preflight

Required in the task prompt: prior clip `artifact://<artifactId>/<fileName>`, prior task `task://<taskId>`, the output artifact's declared file name (canonical; never renamed; used in every render call). Optional: the person's instructions (quoted block).

- Anything required missing, or the clip unreadable / not a video (`read_artifact`) -> `task_failed(reason)` naming it; render nothing.
- Note the prior clip's render provenance (prompt, workflow) from its file record when recorded.

## 2. Brief

- With instructions: they are the brief, in the person's words; add no characters, props or locations.
- Without: derive the next beat from the prior clip's render prompt (provenance, or the prior task's description via `task_index` / `read_artifact`), the story plot, and the storyboard / scene list artifacts (`artifact_index`). A direct, plausible continuation of the last seconds: same place, time of day, lighting, wardrobe, camera language unless the brief changes them.
- A brief that asks for a new framing, subject or insert is a CUT: do not render it here (it needs a fresh image-to-video render, `shoot-clip` mode `cut`); say so in the summary.

## 3. Render

First `load_skill('shoot-clip')` and follow its sections 2-5 (mode `continue`) exactly. The prompt continues `<Video 1>` in the same shot; never write "the target video cuts to …" or a new composition.

- Duration: the task's, if given, else the workflow's default (it is the `duration_seconds` of `shoot-clip` sections 4-5).
- In `shoot-clip` sections 2-5:
  - the video-continuation workflow (video input port for the prior clip); none -> `task_failed` naming that;
  - measured predecessor duration and `prior_clip_start_time`;
  - references: as in `shoot-clip` "References" (`artifact_index`; compose intent);
  - a required reference that is unavailable and not derivable from the prior clip: ask the person if your task has a chat (`llm+hitl`), else `task_failed` naming the missing references.
- Prompt inputs: the brief; the prior clip's measured timing and start offset; reference images and their roles; the continuity requirements of section 2. Instructions go in `instruction` (verbatim only when short, explicit, concrete). Pass `image_inputs` and `verbatim_phrases` (a shot's `Sex act:` / `Sex position:`, dialogue).
- Load the prompt-writer skill for the workflow's model family (`prompt-writer-<family>`; `draft_prompt` applies it when available). Keep the negative prompt consistent with the prior clip's.
- ONE render into this task's artifact, canonical file routed via `output_ports`.

## 4. Verify and hand over

- It is a video from a `wf_*` render (not the sandbox) at exactly the canonical path; duration plausible, not empty / frozen (`get_video_info`).
- Continuity: first frames vs the prior clip's last frames (same subject, place, lighting); a clear break -> redo the prompt once, keep the first clip ("Check, retry once, suggest" in `workflow-calling-conventions`).
- No other file written; the prior clip and its artifact untouched.
- `task_complete`: 1-3 lines — the clip file made and what the next step must know (measured duration, start offset).
