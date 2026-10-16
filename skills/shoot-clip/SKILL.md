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

One task = one clip = one render. Never render a second clip, a second take of the same clip
(except the single retry of step 6), or other shots of the scene.

## 1. Preflight

Your task prompt must carry: `scene`, `clip`, `shot`, `mode` (`continue` | `cut`), `movement`,
`duration_seconds`, `start_frame`, `style`, the canonical output files (a `.mp4` and a
`_prompt.txt`), and for `continue` also `prior_clip`. `action`, `camera`, `references`,
`framing_change`, `negative_prompt`, `preferred_workflow`, `shot_block` (the shot's full block from
`shotlist.md`: Blocking, Pose, Frame, Visible, Act ...), `frame_edits` and `width` / `height` are used
when present. You never create tasks (no `create_task`): this task renders ONE clip and nothing else.

- A required field is missing -> render nothing, `task_complete` with a summary starting
  `BLOCKED:` that names it.
- `mode: continue`: `read_artifact` the predecessor's artifact (the `prior_clip` reference) and
  confirm its video file exists and is approved. Missing or not approved -> `BLOCKED:`.
- Confirm the `start_frame` file exists (`read_artifact`; `describe_image` if you need to see it).
  Only a shot that genuinely has no storyboard frame (`start_frame: none`) may be rendered
  text-to-video; any other missing / unreadable frame -> `BLOCKED:`.
- `mode: cut` with a start frame and NO image-to-video workflow among your `wf_*` tools (Step 2) ->
  render nothing, `task_complete` with `BLOCKED: this workspace has no image-to-video workflow - add
  one and ask again.` Never fall back to text-to-video: it cannot take the frame, so the clip would
  not look like the storyboard or the cast.

Reference every image / clip as `artifact://<artifactId>/<file>` (never a copied URL).

## 2. Select the workflow (by capability, never by name)

Read the descriptions and `get_workflow_instructions` of your video `wf_*` tools; prefer what the
manifest declares (`capabilities`, per image input `reference_role` and `label`) and otherwise
infer from descriptions and port order. A workflow with a required input you cannot supply is
disqualified. The `preferred_workflow` is only a tie-breaker between workflows that qualify for the
mode in the table below: for a `cut` it must be image-to-video (type `i2v` / `i2va`) - a
`preferred_workflow` of another type (e.g. text-to-video `t2v` / `t2va`, whatever its name says)
is IGNORED, and you take a qualifying image-to-video workflow instead. Then read the chosen
workflow's instructions fully: prompt syntax, duration parameter, frame constraints.

| Mode | Workflow | Inputs |
|---|---|---|
| `cut` | an **image-to-video** workflow, type `i2v` or `i2va` (flf2v only when its last frame is optional), read from the tool description's type and the manifest `capabilities` | `start_frame` ALWAYS as the first-frame (start image) port; the reference images (see below) in the workflow's optional reference-image ports, matched by the port's `reference_role` / `label` (else port order and descriptions); ports with nothing to fill stay OMITTED |
| `continue` | the video-continuation workflow (a video input port for the prior clip) | `prior_clip` = the predecessor's clip file; when `framing_change: yes`, also `start_frame` (this shot's storyboard frame) as an additional reference image, if the workflow has a free image port |

A `cut` is never faked through the continuation workflow and never rendered text-to-video (only
the `start_frame: none` exception of Preflight). A workflow with a required input you cannot
supply is disqualified. No workflow qualifies for the mode -> `BLOCKED:` naming what is missing.
State the workflow and path used in your summary.

### Reference images (always passed when the workflow has free image ports)

Pass the shot's references to the video workflow, not just the start frame: the character
design's primary (or sheet), the outfit design's primary, the location design's primary - the ones
the shot's `Characters`, `Outfits` and `Location` and its `Visible:` line name (a POV shot's
`Visible:` shows hands or forearms only: do not pass a full-body reference of the POV character).
The task's `references` list is the source; when it is thin, look the designs up in `artifact_index`
(`character_<slug>`, `outfit_<character>_<look>`, `location_<slug>`; `primary.<ext>`, else the
sheet). Fill the workflow's labelled image ports in port order, location first and then people
(compose intent, "Anchor (Picture 1) by intent" of `workflow-calling-conventions`). Do NOT type
"Picture N is ..." lines: pass the same images as `image_inputs` (Step 3) and the code writes them.

### Continue mode: measure the real predecessor

Measure the predecessor's file with `get_video_info` (`path_or_url="artifact://<id>/<file>"`).
Never use its planned length. Set `prior_clip_start_time` = the REAL duration minus 1-2 s (move
earlier until the workflow's minimum of reference frames remains; a clip shorter than the offset
is barely read). The prompt continues `<Video 1>` in the same shot: the continuing action and the
`movement`; NO cut ("the target video cuts to ..."). Output is only the new segment; do not merge.

**Across a framing change** (`framing_change: yes`): the new shot's storyboard frame goes in as an
additional reference image (named the way the port descriptions do, e.g. "Picture 1 is the target
framing") and the prompt describes the new framing as a camera move / reframe within the same
continuous shot - e.g. "the camera pushes in to a close-up of her face as she turns" - never as a
hard cut, a new scene or a "cuts to". Subjects, place, lighting and wardrobe stay those of
`<Video 1>`.

## 3. Prepare the prompt

Follow "Prompt writing" of `workflow-calling-conventions` (`load_skill` it). The shot brief is
agent-derived, so: ONE `draft_prompt` for this clip - no per-step loops; at most one `review_prompt`,
and one `enhance_prompt` only if it flags a gap. Always pass:

- `workflow_name`, `context`, `duration_seconds`;
- `image_inputs`: every image the render call passes, as `{port, ref}` (start frame, references,
  and for a framing change the target frame) - the code writes the Picture lines;
- `verbatim_phrases`: the shot's `Act:` text (only when the task's `shot_block` has one; it is
  read only in a workspace with `contentPolicy.nudity: allowed`) and any dialogue that must be kept.

- `duration_seconds` = the task's planned duration, passed to `draft_prompt` AND as the render
  call's duration parameter (the value the `wf_*` tool description names, e.g. `video_length`) —
  the same number in both.
- `context`: the shot's full `shot_block` VERBATIM (Blocking, Pose, Frame, Visible, Act stay as
  written - they are how the people are placed and posed), the characters / outfits / location, the
  path used, and the `movement` VERBATIM ("hold" = a locked-off frame; any other move is written as
  that move). With no Movement asking for a move, the frame never moves: no push-in, no
  reframing. Path `cut` with a start frame: describe only the motion from that frame.
- `frame_edits`: restate what the frame's edits changed as a constraint and NEVER re-add an element
  an edit removed (an edit "remove the car" means no car in the clip prompt either).
- Carry the `style` line into the `context` verbatim; a clip in another medium is a miss.
- Use the `negative_prompt` when the workflow has a negative prompt port.

## 4. Render

ONE `wf_*` call with the frames / clip / references, the drafted prompt, the planned
duration and (continue) `prior_clip_start_time`. Keep the `draft` quality unless the task asks
otherwise; an explicit `width` / `height` from the task is passed as given (it overrides the
profile's size). A `cut` call MUST carry the `start_frame` on the
start-image port; a call without it is wrong - fix it before sending. Route the video to the task's canonical `.mp4`
(`output_ports` when needed). On an error re-read the workflow instructions, fix the call and
retry once WITH THE SAME WORKFLOW; if it fails again, `task_complete` with a `BLOCKED:` / failure
summary that quotes the error. A failed render never makes another workflow type acceptable: never
fall back to a text-to-video workflow for a `cut` because the image-to-video render failed.

## 5. Write the prompt file

Write the canonical `_prompt.txt` from the EXACT prompt text that was passed to the render call
(for a `continue` clip also a line `prior_clip_start_time: <value>`) — never a reworded or
reconstructed version.

## 6. Pre-completion audit

- **render inputs**: the render really received what the task asked for. Call
  `render_info({ render_id })` with the `renderId` your `wf_*` call returned (it reports the
  workflow, params and the media inputs that reached the render) and check it
  against your `wf_*` call: for `cut`, the `start_frame` is in the media inputs on the
  start-image port and each intended reference you passed is listed (a clip with no character /
  outfit / location reference although the workflow had free ports is wrong: re-render once); for `continue`, the prior clip
  (and, on a framing change, the frame). Empty media inputs, or the start frame missing, means the
  render failed: re-render ONCE with the corrected call; still wrong -> `BLOCKED:` naming it
- the `.mp4` exists at exactly the canonical path (a returned path elsewhere makes the artifact
  build fail — render again to the declared path) and is a video from a `wf_*` render
- measure it with `get_video_info`: its duration is within ±0.6 s of `duration_seconds`; outside
  it -> re-render ONCE (same prompt, new seed) and keep the better clip; still off -> report the
  measured value in the summary rather than looping
- continue mode: the first frames fit the predecessor's last frames (same subject, place,
  lighting); a clear break -> one retry with a corrected prompt ("Check, retry once, suggest" of
  `workflow-calling-conventions`)
- the prompt file is written and holds the rendered prompt; no other file was written

Then `task_complete` (summary: 1-3 lines - mode, the measured duration, and for continue the start
offset; no prompt or workflow restated; see "Concise replies and task/artifact URIs" in
`workflow-calling-conventions`).
