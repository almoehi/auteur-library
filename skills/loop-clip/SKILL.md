---
name: loop-clip
description: >
  Use when the task prompt says "Load and use skill: loop-clip", or asks to render the loopable
  cam-style clips of an approved loop storyboard - one render per clip with the h3_loop_clip_nsfw
  workflow (the clip starts and ends on its anchor keyframe), a seam check and a looped preview.
  Do NOT invoke for planning (play-preproduction), reference images (loop-designs), scene clips
  of the film pipeline (shoot-clip) or joining clips with the episode audio.
agentType: worker
---

> **Superseded - no longer loaded by the workspace; use `iwc-loop-clip` instead.**

# Loop clip: render seamless cam-style loops

One render per clip with `wf_h3_loop_clip_nsfw`: the workflow pins the start frame (`ref0`) as
the LAST frame too, so the clip loops when copies are concatenated. Read
`workflow-calling-conventions` (`load_skill`) and `get_workflow_instructions` of
`wf_h3_loop_clip_nsfw` once. Prompts come from `prompt-writer-minimaxh3` via `draft_prompt`
(pass `prompt_ids`, never typed text).

## 1. Preflight

Fields: `clips` (list of clip numbers to render, e.g. `[1]`; default all), `storyboard` (default
`loop_storyboards`), `character` (default `character_vesper`, a finished design artifact), `outfits` (default
`outfit_designs`), `inputs` (default `episode_inputs`). `read_artifact` the storyboard
(`storyboard.md`, `storyboard.json`). `task_failed(reason)` if the workflow tool
`wf_h3_loop_clip_nsfw` is missing ("load the h3_loop_clip_nsfw workflow") or a clip's anchor
file is missing.

## 2. Per clip

1. **Prompt**: `draft_prompt` for `wf_h3_loop_clip_nsfw` with `duration_seconds` = the clip's
   duration and `context` = the clip's storyboard block verbatim plus these locks:
   - one continuous take from a locked-off webcam at the storyboard's `Camera:` angle, height and
     distance (low looking up, high looking down, …), no camera move, no zoom, no cut;
   - she starts in the anchor pose of Picture 1 and ends in EXACTLY that pose and framing, every
     garment back as at the start;
   - no dialogue: her lips stay closed or part only for soft breaths; sound = soft breathing and
     quiet room tone, no music, no speech;
   - large readable body motions, the reveal / touch in the middle of the clip;
   - the clip's furniture use (`Furniture:` line) as physical contact that stays consistent - she
     lies, kneels, straddles or grinds on the same piece through the loop and is back on it in
     the anchor position at the end;
   - the kink focus (`Kink focus:` line): its motions and outfit cue are the clip's main action,
     not an afterthought;
   - the clip's items (`Items:` line): she uses them as the storyboard says and they are back in
     her hand / in their place at the end; play to the camera angle (open and close the knees
     above a low lens, lean down into a high one).
   `image_inputs`: `ref0` = `artifact://<storyboard>/anchor_clip<N>.png` (the anchor, Picture 1),
   `ref1` = the character design's face view (else its portrait, else its `full_body_shot`;
   identity), `ref2` = the outfit design's named pose view for the clip's body pose (else its front
   view, else its `full_body_shot`; outfit) - find the files in each design's `design.json`
   `published.outputs`. One `review_prompt` against the
   storyboard block; one `enhance_prompt` only on a significant gap.
2. **Render**: `wf_h3_loop_clip_nsfw` with `ref0` / `ref1` / `ref2` as above, `prompt_ids`,
   `duration_seconds`, LoRAs from the block (only when an act needs one). Never pass width /
   height (the anchor's shape decides). Outputs → `/workspace/<artifact id>/clip<N>.mp4`
   (`output_video`) and `clip<N>_audio.flac` (`output_audio`).
3. **Seam check** (sandbox, ffmpeg): `get_video_info`, then extract the first and the last frame
   and compare them (`ffmpeg -i first.png -i last.png -lavfi ssim -f null -`). Build a preview of
   three copies with the duplicated last frame dropped (`clip<N>_loop3.mp4`). Write
   `clip<N>_seam.txt`: duration, fps, SSIM first-vs-last, verdict (`seamless` at SSIM ≥ 0.90,
   else `visible seam`).
4. **Retry once** on a visible seam or a render failure: new `draft_prompt` with the finding in
   `context` (e.g. "she ended kneeling lower than she started"), fresh seed, files named
   `clip<N>-r2.*`. Keep the first take. Never a third render.

## 3. Reply

Per clip: workflow, duration, seam verdict and SSIM, retries, files. Then `task_complete`.
