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
`negative_prompt`, `preferred_workflow` are used when present.

- A required field is missing -> render nothing, `task_complete` with a summary starting
  `BLOCKED:` that names it.
- `mode: continue`: `read_artifact` the predecessor's artifact (the `prior_clip` reference) and
  confirm its video file exists and is approved. Missing or not approved -> `BLOCKED:`.
- Confirm the `start_frame` file exists (`read_artifact`; `describe_image` if you need to see it).

Reference every image / clip as `artifact://<artifactId>/<file>` (never a copied URL).

## 2. Select the workflow (by capability, never by name)

Read the descriptions and `get_workflow_instructions` of your video `wf_*` tools; prefer what the
manifest declares (`capabilities`, per image input `reference_role` and `label`) and otherwise
infer from descriptions and port order. A workflow with a required input you cannot supply is
disqualified. The `preferred_workflow` is used when it qualifies. Then read the chosen
workflow's instructions fully: prompt syntax, duration parameter, frame constraints.

| Mode | Workflow | Inputs |
|---|---|---|
| `cut` | image-to-video / first-last-frame (i2v, flf2v); reference-to-video (ref2v) with the `references` when it fits better; else text-to-video (t2v) | `start_frame` as the start image (+ references in the order the ports describe; "Anchor (Picture 1) by intent" of `workflow-calling-conventions`, compose intent) |
| `continue` | the video-continuation workflow (a video input port for the prior clip) | `prior_clip` = the predecessor's clip file |

A `cut` is never faked through the continuation workflow. No workflow qualifies for the mode ->
`BLOCKED:` naming what is missing. State the workflow and path used in your summary.

### Continue mode: measure the real predecessor

Measure the predecessor's file with `get_video_info` (`path_or_url="artifact://<id>/<file>"`).
Never use its planned length. Set `prior_clip_start_time` = the REAL duration minus 1-2 s (move
earlier until the workflow's minimum of reference frames remains; a clip shorter than the offset
is barely read). The prompt continues `<Video 1>` in the same shot: the continuing action and the
`movement`; NO cut ("the target video cuts to ...") and no new composition. Output is only the
new segment; do not merge.

## 3. Prepare the prompt

Follow the **Prompt route** rule of `workflow-calling-conventions` (`load_skill` it) and pass
`prompt_route` on the render call. The shot brief is agent-derived, so: ONE `draft_prompt`
(`workflow_name`, `context`, `duration_seconds`) for this clip — no per-step loops; at most one
`review_prompt`, and one `enhance_prompt` only if it flags a gap.

- `duration_seconds` = the task's planned duration, passed to `draft_prompt` AND as the render
  call's duration parameter (the value the `wf_*` tool description names, e.g. `video_length`) —
  the same number in both.
- `context`: action, camera, characters / outfits / location from the task, the path used, and
  the `movement` VERBATIM ("hold" = a locked-off frame; any other move is written as that move,
  never replaced by static / no-zoom locks). Path `cut` with a start frame: describe only the
  motion from that frame. References are named the way the port descriptions do.
- Carry the `style` line into the `context` verbatim; a clip in another medium is a miss.
- Use the `negative_prompt` when the workflow has a negative prompt port.

## 4. Render

ONE `wf_*` call with the frames / clip / references, the prompt, `prompt_route`, the planned
duration and (continue) `prior_clip_start_time`. Route the video to the task's canonical `.mp4`
(`output_ports` when needed). On an error re-read the workflow instructions, fix the call and
retry once; if it fails again, `task_complete` with a `BLOCKED:` / failure summary.

## 5. Write the prompt file

Write the canonical `_prompt.txt` from the EXACT prompt text that was passed to the render call
(for a `continue` clip also a line `prior_clip_start_time: <value>`) — never a reworded or
reconstructed version.

## 6. Pre-completion audit

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
