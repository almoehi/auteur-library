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

One task = one clip = one render. Never render another clip, another take of this clip (except the single retries of section 7), or other shots. Never `create_task`. This skill is the authority for the `continue` mechanics (section 3), which `shoot-continuation` reuses.

## 1. Preflight

Task prompt fields:
- Required: `scene`, `clip`, `shot`, `mode` (`continue` | `cut`), `movement`, `duration_seconds`, `start_frame`, `style`, the canonical output files (`.mp4` and `_prompt.txt`); `continue` also `prior_clip` (the KEY of clip M-1's output artifact, e.g. `scene2_clip3`).
- Used when present: `action`, `camera`, `beat` (the scene-list beat of this shot, verbatim), `prior_shot_facts` (`continue`: the previous shot's Action / Wardrobe / State lines), `references`, `framing_change`, `negative_prompt`, `preferred_workflow`, `loras` (the shot's curated LoRAs), `shot_block` (the shot's full block: Blocking, Pose, Frame, Visible, Sex act, Sex position …), `frame_edits`, `width` / `height`.

`task_failed(reason)` (render nothing; deterministic causes only) when:
- a required field is missing (name it);
- `continue`: the `prior_clip` key does not resolve (`artifact_index`) to an artifact with an approved video file - resolve the key to `artifact://<artifactId>/<its .mp4>` HERE, at run time (`read_artifact`), and use that reference for every later step;
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

- The start frame (and, for `continue`, the prior clip) carries identity, outfit, place and composition. Pass ONLY the task's `references` list - it holds just what the frame cannot keep (a person whose face turns / comes closer / who enters; a location view for a camera move that reveals new space; rule in `shoot-scene-task` Step 1b). No list = no references: never fill free image ports "because they exist", never look designs up to add more.
- Even when listed, never bind: a `POV:` owner or `limbs` person, an outfit the shot does not wear (a `:nude` / partly undressed person gets the character design), or a `sheet` (grid). Drop such an entry and say so in the summary.
- Fill labelled image ports in port order, location first, then people ("Anchor (Picture 1) by intent" in `workflow-calling-conventions`). Do not type "Picture N is …" lines: pass `image_inputs` (section 5) and the code writes them.

## 3. Mode `continue` (authority for continuation mechanics)

- Measure the predecessor with `get_video_info` (`path_or_url="artifact://<id>/<file>"`); never use its planned length.
- `prior_clip_start_time` = REAL duration minus 1-2 s (inside the last 1-2 s); move earlier until the workflow's minimum of reference frames remains. Pass it on the render call and in the summary.
- The prompt continues `<Video 1>` in the same shot: same framing, subject and setup, the action carrying on, the `movement` continuing or holding. NO cut ("the target video cuts to …"), no new composition. Output is only the new segment; do not merge.
- `framing_change: yes` is only valid with a real `movement` (a push, pull, pan, tilt, orbit …): add this shot's storyboard frame as an extra reference image (named as the port descriptions do, e.g. "Picture 1 is the target framing") and write the shot's `movement` VERBATIM as the only camera move - never invent a reframing to reach the new framing; subjects, place, lighting, wardrobe stay those of `<Video 1>`.
- `framing_change: yes` with `movement` `hold` (or none) is a CUT, not a continuation: the task was planned wrong. `task_failed("framing change with movement hold: this boundary is a cut")` (deterministic; the coordinator re-plans it as a `cut`). A new subject or insert is a CUT too.

## 4. LoRAs (motion first)

Pick the clip's LoRAs once, before the prompt (its trigger words go into the writer's `context`), by "Curated LoRAs" -> Video clips in `workflow-calling-conventions`: call `lora_index()` once, start from the task's `loras` (else the `shot_block`'s `LoRAs:` line), keep the chosen workflow's family only, then rank: the shot's act LoRA first (only when `shot_block` has a `Sex act:`), then motion LoRAs for the action and `Movement:`, then the rest of the shot's video-family list. No realism / skin / anatomy / detail / style LoRAs (the keyframe and the workflow's baked-in LoRAs carry looks). Pass the list on EVERY render of this clip (retries included), one per LoRA port in rank order, and name it in the summary.

## 5. Prepare the prompt

Follow "Prompt route" of `workflow-calling-conventions` (`load_skill` it).

- Normal: ONE `draft_prompt`; then ONE `review_prompt` (the completeness check below); one `enhance_prompt` only if it flags a gap. No per-step loops.
- **Completeness check (before the render).** `review_prompt` with the `prompt_id` the draft returned (never retype the prompt) and `review_instructions` = the `shot_block` + `beat` + `prior_shot_facts` VERBATIM, prefixed with the single line "Check that the prompt states every element of this shot (who, where, extent, pose, wardrobe and state changes, the action from start to end, camera move, dialogue, out-of-frame constraints) and contradicts none. List each missing or contradicted element." Do NOT write your own rubric, scoring criteria or "what a good clip looks like": the shot block IS the rubric. Severity "significant" -> `enhance_prompt` with `prompt_id` and the review text as `additional_context`, once.
- Re-run ("## Instructions for this run" in the kickoff): the instructions OVERRIDE the shot block wherever they conflict.
  - Drop contradicted lines (e.g. "no contact", "neutral expression") from `context`; pass the instructions VERBATIM as `instruction` (not only inside `context`).
  - Previous prompt available (old `_prompt.txt` or `render_info`): `enhance_prompt(original_prompt, instruction)` INSTEAD of `draft_prompt`, then the completeness check once with the same `instruction`, `enhance_prompt` once more only on severity "significant" (max 2 enhances + 1 review). All before the one render.
- The clip's motion is a FROM -> TO delta, written into `context` as the action in progress (never as a frozen pose, never as a list of prohibitions):
  - `continue`: FROM = the end state of the prior clip (`prior_shot_facts`: its Action / Wardrobe / State), TO = this shot's state (`shot_block` Action / Wardrobe / State). A Wardrobe or State change between the two (a garment removed, wet hair, a prop picked up) IS this clip's action: state it as happening during the clip, in the shot block's words.
  - `cut`: FROM = the start frame, TO = what the `beat` text says happens (verbatim). The shot's `Action:` is the state AT 0 s; the beat carries it forward.
  - Add no behaviour the shot block and beat do not state.
- Always pass `workflow_name`, `context`, `duration_seconds`, and:
  - `image_inputs`: every image the render passes, as `{port, ref}` (start frame, references, target frame on a framing change);
  - `verbatim_phrases`: the shot's `Sex act:` / `Sex position:` values (only when `shot_block` has them; read only in a workspace with `contentPolicy.nudity: allowed`) and dialogue to keep.
- `duration_seconds` = the planned duration, passed to `draft_prompt` AND as the render call's duration parameter (the name the `wf_*` description gives, e.g. `video_length`): the same number.
- `context`:
  - the `shot_block` VERBATIM (Blocking, Pose, Frame, Visible, Sex act, Sex position stay as written);
  - characters / outfits / location and the path used;
  - `beat` VERBATIM (the scene-list beat text: Action, Blocking, Camera move …), and `prior_shot_facts` for a `continue`;
  - `movement` VERBATIM ("hold" = locked-off frame; no `movement` = the framing of `camera`, no camera move added);
  - `cut` with a start frame: describe only the motion from that frame;
  - `style` verbatim (a clip in another medium is a miss);
  - `frame_edits` restated as a constraint: never re-add an element an edit removed ("remove the car" = no car in the clip prompt);
  - prohibitions (an `Out of frame:` line, a removed element, "no contact") are stated ONCE as constraints in `context` ("Constraint: nothing of X is visible") - never pasted as raw "do not" text into the drafted prompt, and never added to the prompt after the writer returned.
- Use `negative_prompt` when the workflow has a negative-prompt port.

## 6. Render

- Kickoff lists checks gating this clip: call `run_checks` BEFORE the render and fix every listed problem (a rejection after rendering wastes the render; "Checks that gate the task" in `workflow-calling-conventions`).
- ONE `wf_*` call: frames / clip / references, drafted prompt, planned duration, (continue) `prior_clip_start_time`; `draft` quality unless the task says otherwise; the `.mp4` routed to the canonical path (`output_ports`).
- A `cut` call MUST carry `start_frame` on the start-image port.
- Do NOT pass `width` / `height` by default (the render profile decides); set them only when the task carries them or the shot needs another format. Size and `is_portrait`: "Render size" of `workflow-calling-conventions`.
- Error: read the failure result. `retryable: false` (infrastructure failure the server already retried, or `cancelled`) -> do NOT render again: quote the error in the final reply and end WITHOUT `task_failed` / `task_complete`. Otherwise (a wrong argument or output you can fix): re-read instructions, fix, retry ONCE with the SAME workflow; failing again -> quote the error and end the same way. The server enforces this: a task has a budget of 2 failed renders, and once it is used up every `wf_*` call is refused with "render failures for this task are used up (2 of 2): report the problem and stop - do not render again" and the task ends as a declared failure - never try to render after that. A failed render never makes another workflow type acceptable (no text-to-video fallback).
- Write the canonical `_prompt.txt` from the EXACT prompt passed to the render (continue: plus a line `prior_clip_start_time: <value>`); never reworded.

## 7. Pre-completion audit

- Call `render_info({ render_id })` with the returned `renderId` and compare with your call:
  - `cut`: `start_frame` on the start-image port and exactly the task's `references` (none when the task lists none);
  - `continue`: the prior clip (and the frame on a framing change);
  - wrong or empty media inputs -> re-render ONCE with the corrected call; still wrong -> `task_complete` stating the problem (`task_failed` is refused once the outputs are written).
- The `.mp4` exists at exactly the canonical path and is a `wf_*` render (a path elsewhere breaks the artifact build: render again to the declared path).
- `get_video_info`: duration within ±0.6 s of `duration_seconds`; outside -> re-render ONCE (same prompt, new seed), keep the better; still off -> report the measured value rather than looping.
- `continue`: first frames fit the predecessor's last frames (same subject, place, lighting); a clear break -> one retry with a corrected prompt ("Check, retry once, suggest" in `workflow-calling-conventions`).
- The prompt file holds the rendered prompt; no other file written.
- `task_complete`: 1-3 lines — mode, measured duration, (continue) the start offset; no prompt / workflow restated ("Concise replies and task/artifact URIs" in `workflow-calling-conventions`).
