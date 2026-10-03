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

The new clip starts from the END of an existing clip: the render workflow receives the prior
clip as a video input (plus reference images that keep characters and places consistent) and
generates what happens next. Work with whichever workflow the workspace offers — never assume
a specific one.

## Phase 1 — Preflight

Extract from the task description / prompt, and **stop early** when something is missing:

- the **prior clip**: `artifact://<artifactId>/<fileName>` — required;
- the **prior task**: `task://<taskId>` — required;
- the **output artifact** and its declared **file name** — the canonical name for the new clip,
  decided by the task, never renamed by you (also embed it in every render call);
- the person's **instructions** (a quoted block) — optional; when absent derive the story beat
  yourself (Phase 3).

If the prior clip, the prior task or the output file name is missing, or the clip cannot be read,
render nothing and call `task_complete` with a summary starting `BLOCKED:` that states exactly
what is missing.

## Phase 2 — Read the prior clip and measure it

1. `read_artifact(artifactId="<artifactId>")` — confirm the file exists and is a video; note its
   file record (render provenance: the prompt and workflow that made it, when recorded).
2. Measure the REAL clip with `get_video_info` (duration, fps, frame count, resolution, audio) on
   the artifact reference (`path_or_url="artifact://<artifactId>/<fileKey>"`; never a copied URL). Never assume the duration the clip was requested with —
   generated clips routinely differ from their target.
3. Choose the **start offset**: the point inside the **last 1–2 seconds** of the measured clip
   where the continuation should resume. Read the chosen workflow's instructions (Phase 4) for its
   constraints and make sure enough reference frames remain after the offset (e.g. a minimum of a
   few frames); move the offset earlier until they do. Note the offset in the summary.

## Phase 3 — Understand what happens next

- With instructions: they are the brief; the quote is the person's words — follow it, do not
  extend it with new characters, props or locations.
- Without: derive the next beat from the prior clip's render prompt (its recorded provenance, or
  the prior task's description via `task_index` / `read_artifact`), the story plot and the
  storyboard / scene list artifacts (`artifact_index`). Keep it a direct, plausible continuation
  of the action in the last seconds of the clip: same place, time of day, lighting, wardrobe,
  camera language unless the brief changes them.

## Phase 4 — Select the workflow and gather references

1. From the available `wf_*` tools and `get_workflow_instructions`, find and use the appropriate
   **reference-to-video / video-continuation workflow** — one with a **video input port for the
   prior clip**. If none exists, `task_complete` with a `BLOCKED:` summary naming that.
2. `get_workflow_instructions(<workflow>)` and read it fully: every input port, prompt structure,
   duration / frame constraints, how the start offset and the reference video are passed.
3. Gather every **reference image** the workflow's ports require or allow: character sheets and
   environment / location plates of finished designs (`artifact_index`: artifacts keyed
   `character_*`, `location_*`, `outfit_*`), else approved artifacts that show the subject. Pass
   them as `artifact://<artifactId>/<file>` (never paste URLs). If a required reference
   is unavailable and cannot be derived from the prior clip, do not guess: if your task has a
   chat with the person (an `llm+hitl` task) ask them which images to use; otherwise
   `task_complete` with a `BLOCKED:` summary naming the missing references.

## Phase 5 — Write the prompt

Load the prompt-writer skill of the chosen workflow's **model family** (`prompt-writer-<family>`
— the one matching the workflow's base model; `draft_prompt` applies it automatically when
available, else `load_skill` it and follow it). Give it: the brief, the prior clip's measured
timing and chosen start offset, the reference images and their roles, and the continuity
requirements from Phase 3. State timing only from your measurements. Keep the negative prompt
consistent with the prior clip's.

## Phase 6 — Render

One render call into this task's artifact, with the canonical file name from Phase 1 routed via
`output_ports`, the prior clip on the video input port (with the chosen start offset where the
workflow takes one), the references and the prompt. Wait for the result. On an error re-read the
workflow instructions, fix the call and retry ONCE; if it fails again report it.

## Phase 7 — Verify and hand over

Measure the new clip with `get_video_info` and check:

- [ ] it is a video, from a `wf_*` render (not made in the sandbox) at exactly the canonical path
- [ ] its duration is plausible for the workflow and not an empty / frozen result
- [ ] **continuity** — compare its first frames with the prior clip's last frames
      (same subject, place, lighting); if it clearly breaks, redo the prompt once
- [ ] no other file was written; the prior clip and its artifact are untouched

Then call `task_complete(summary=...)`: the workflow used, the measured prior duration, the start
offset, the references used, and the prompt. Call it again after the self-review.
