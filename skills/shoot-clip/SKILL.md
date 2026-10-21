---
name: shoot-clip
description: >
  Use when the task prompt says "Load and use skill: shoot-clip", or tasks you with rendering
  ONE video clip of a scene — e.g. "shoot clip 3 of scene 2". Produces exactly one rendered
  clip (from a storyboard frame, or continuing the previous clip) plus the prompt that was
  rendered. Do NOT invoke for planning or scheduling a scene (shoot-scene-task), joining clips
  (assemble-scene), storyboard or keyframe rendering (storyboard-scene), prompt writing only,
  or continuing a clip on a person's request (shoot-continuation).
agentType: worker
---

# Shoot Clip — render exactly one clip

One task = one clip = one render. Never render another clip, another take of this clip (except the single retries of section 6), or other shots. Never `create_task`. This skill is the authority for the `continue` mechanics (section 3), which `shoot-continuation` reuses.

## 1. Preflight

Task prompt fields:
- Required: `scene`, `clip`, `shot`, `mode` (`continue` | `cut`), `movement`, `duration_seconds`, `start_frame`, `style`, the canonical output files (`.mp4` and `_prompt.txt`); `continue` also `prior_clip`.
- Used when present: `action`, `camera`, `references`, `framing_change`, `negative_prompt`, `preferred_workflow`, `shot_block` (the shot's full block: Blocking, Pose, Frame, Visible, Sex act, Sex position …), `frame_edits`, `width` / `height`.

`task_failed(reason)` (render nothing; deterministic causes only) when:
- a required field is missing (name it);
- `continue`: the `prior_clip` artifact has no approved video file (`read_artifact`);
- the `start_frame` file is missing / unreadable (only `start_frame: none` may be rendered text-to-video);
- `cut` with a start frame and no image-to-video workflow among your `wf_*` tools: reason "this workspace has no image-to-video workflow - add one and ask again" (never fall back to text-to-video: it cannot take the frame).

Reference every image / clip as `artifact://<artifactId>/<file>`, never a copied URL.

## 2. Select the workflow (by capability, never by name)

- Read the descriptions and `get_workflow_instructions` of your video `wf_*` tools; prefer manifest `capabilities` and per-image-input `reference_role` / `label`, else descriptions and port order.
- A workflow with a required input you cannot supply is disqualified. None qualifies -> `task_failed` naming what is missing.
- `preferred_workflow` only breaks ties among qualifying workflows; for a `cut` a non-image-to-video preference (`t2v` / `t2va`, whatever its name) is IGNORED.
- Read the chosen workflow's instructions fully (prompt syntax, duration parameter, frame constraints). State workflow and mode in the summary.

| Mode | Workflow | Inputs |
|---|---|---|
| `cut` | image-to-video, type `i2v` / `i2va` (flf2v only when its last frame is optional) | `start_frame` ALWAYS on the first-frame port; references in the optional reference-image ports matched by `reference_role` / `label` (else port order and descriptions); unfilled ports stay OMITTED |
| `continue` | video-continuation (video input port for the prior clip) | `prior_clip`; on `framing_change: yes` also `start_frame` as an extra reference image if a free image port exists |

- A `cut` is never faked through the continuation workflow and never rendered text-to-video.

### References

- Pass the shot's references whenever the workflow has free image ports; the task's `references` list is the source. If thin, look designs up in `artifact_index` by the shot block's keys (`character_<slug>`, `outfit_<character>_<look>`, `location_<slug>`). The task's own `references` list order wins.
- Image per design: the published `full_body_shot.<ext>` (`primary.<ext>` in older designs), else the sheet; the sheet only for a POV owner's limbs / lower body (see "References by extent").
- `<c>:nude` / `<c>:none` -> the character design; `<c>:none` with garments in `Pose:` = clothed without an outfit design: keep those garments in the prompt. Any other look -> its outfit design (key from `design_plan.json` `outfits[]` by character_slug + look_slug when present, else `outfit_<c>_<look>`, suffix tolerated). No outfit design -> the character design plus the garments in the prompt.
- Use only what the shot's own `Characters`, `Outfits` (per shot, never a scene-level look), `Location` and `Visible:` lines name. Only characters with a `Visible:` entry get an image; extent `limbs` / `lower body` (e.g. a POV owner's hands) gets no full-body reference: use their sheet's POV tile or words ("References by extent" in `workflow-calling-conventions`). A `POV:` line means the camera is that character's eyes.
- Fill labelled image ports in port order, location first, then people ("Anchor (Picture 1) by intent", compose intent, in `workflow-calling-conventions`). Do not type "Picture N is …" lines: pass `image_inputs` (section 3) and the code writes them.

## 3. Mode `continue` (authority for continuation mechanics)

- Measure the predecessor with `get_video_info` (`path_or_url="artifact://<id>/<file>"`); never use its planned length.
- `prior_clip_start_time` = REAL duration minus 1-2 s (inside the last 1-2 s); move earlier until the workflow's minimum of reference frames remains. Pass it on the render call and in the summary.
- The prompt continues `<Video 1>` in the same shot: same framing, subject and setup, the action carrying on, the `movement` continuing or holding. NO cut ("the target video cuts to …"), no new composition. Output is only the new segment; do not merge.
- `framing_change: yes`: add this shot's storyboard frame as an extra reference image (named as the port descriptions do, e.g. "Picture 1 is the target framing") and describe the new framing as a camera move / reframe within the same continuous shot ("the camera pushes in to a close-up of her face as she turns"); subjects, place, lighting, wardrobe stay those of `<Video 1>`.
- A new framing, subject or insert that is not a reframe is a CUT: it does not belong in `continue`.

## 4. Prepare the prompt

Follow "Prompt route" of `workflow-calling-conventions` (`load_skill` it).

- Normal: ONE `draft_prompt`; at most one `review_prompt`; one `enhance_prompt` only if it flags a gap. No per-step loops.
- Re-run ("## Instructions for this run" in the kickoff): the instructions OVERRIDE the shot block wherever they conflict.
  - Drop contradicted lines (e.g. "no contact", "neutral expression") from `context`; pass the instructions VERBATIM as `instruction` (not only inside `context`).
  - Previous prompt available (old `_prompt.txt` or `render_info`): `enhance_prompt(original_prompt, instruction)` INSTEAD of `draft_prompt`, then `review_prompt` once with the same `instruction`, `enhance_prompt` once more only on severity "significant" (max 2 enhances + 1 review). All before the one render.
- Always pass `workflow_name`, `context`, `duration_seconds`, and:
  - `image_inputs`: every image the render passes, as `{port, ref}` (start frame, references, target frame on a framing change);
  - `verbatim_phrases`: the shot's `Sex act:` / `Sex position:` values (only when `shot_block` has them; read only in a workspace with `contentPolicy.nudity: allowed`) and dialogue to keep.
- `duration_seconds` = the planned duration, passed to `draft_prompt` AND as the render call's duration parameter (the name the `wf_*` description gives, e.g. `video_length`): the same number.
- `context`:
  - the `shot_block` VERBATIM (Blocking, Pose, Frame, Visible, Sex act, Sex position stay as written);
  - characters / outfits / location and the path used;
  - `movement` VERBATIM ("hold" = locked-off frame; without a move asked for, the frame never moves: no push-in, no reframing);
  - `cut` with a start frame: describe only the motion from that frame;
  - `style` verbatim (a clip in another medium is a miss);
  - `frame_edits` restated as a constraint: never re-add an element an edit removed ("remove the car" = no car in the clip prompt).
- Use `negative_prompt` when the workflow has a negative-prompt port.

## 5. Render

- Kickoff lists checks gating this clip: call `run_checks` BEFORE the render and fix every listed problem (a rejection after rendering wastes the render; "Checks that gate the task" in `workflow-calling-conventions`).
- ONE `wf_*` call: frames / clip / references, drafted prompt, planned duration, (continue) `prior_clip_start_time`; `draft` quality unless the task says otherwise; the `.mp4` routed to the canonical path (`output_ports`).
- A `cut` call MUST carry `start_frame` on the start-image port.
- Do NOT pass `width` / `height` by default (the render profile decides); set them only when the task carries them or the shot needs another format. Size and `is_portrait`: "Render size" of `workflow-calling-conventions`.
- Error: re-read instructions, fix, retry ONCE with the SAME workflow; failing again -> quote the error in the final reply and end WITHOUT `task_failed` / `task_complete` (render errors may be transient; `task_failed` is for deterministic causes only). A failed render never makes another workflow type acceptable (no text-to-video fallback).
- Write the canonical `_prompt.txt` from the EXACT prompt passed to the render (continue: plus a line `prior_clip_start_time: <value>`); never reworded.

## 6. Pre-completion audit

- Call `render_info({ render_id })` with the returned `renderId` and compare with your call:
  - `cut`: `start_frame` on the start-image port and every intended reference listed (no references although free ports existed = wrong);
  - `continue`: the prior clip (and the frame on a framing change);
  - wrong or empty media inputs -> re-render ONCE with the corrected call; still wrong -> `task_complete` stating the problem (`task_failed` is refused once the outputs are written).
- The `.mp4` exists at exactly the canonical path and is a `wf_*` render (a path elsewhere breaks the artifact build: render again to the declared path).
- `get_video_info`: duration within ±0.6 s of `duration_seconds`; outside -> re-render ONCE (same prompt, new seed), keep the better; still off -> report the measured value rather than looping.
- `continue`: first frames fit the predecessor's last frames (same subject, place, lighting); a clear break -> one retry with a corrected prompt ("Check, retry once, suggest" in `workflow-calling-conventions`).
- The prompt file holds the rendered prompt; no other file written.
- `task_complete`: 1-3 lines — mode, measured duration, (continue) the start offset; no prompt / workflow restated ("Concise replies and task/artifact URIs" in `workflow-calling-conventions`).
