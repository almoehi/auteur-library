---
name: iwc-loop-clip
description: >
  Use when the task prompt says "Load and use skill: iwc-loop-clip", or asks to render the montage
  CLIPS of one look of an iWantClips episode from its finished storyboard: each clip starts AND ends
  on its still's storyboard frame (h3_loop_clip_nsfw, slow motion: 7.3 s rendered, played 10.9 s),
  with the character's face view, the outfit picture and the room plate as named references; ONE
  in-place gesture per clip from the plan; a REVEAL clip (`kind: reveal`) runs from the look's worn
  still to its exposed still instead (h3_start_end_clip_nsfw); a clip list for post-production. Do NOT invoke for
  planning (iwc-play-preproduction), scheduling the look tasks (iwc-schedule-loops), storyboards
  (storyboard-scene), scene clips of the film pipeline (shoot-clip) or editing the montage with the
  episode audio (post-production).
agentType: worker
---

# Montage clips: render the clips of one look

**Catalog tools:** none in this task (no `search_catalog` / `use_reference`, no catalog outfit or
`garment_reference`).

A look is one camera set-up of the montage. Its clips are listed in the visual plan (`clips` with
`look` = this look): each has a slot on the audio, a STILL (one frame of the look's storyboard) and
ONE gesture with its `prompt_line`. Every clip is one render of `wf_h3_loop_clip_nsfw`: the
still's frame is pinned as the FIRST and the LAST frame (`ref0`), so the clip holds the still's
framing, room and garment state and returns to them - the montage cuts hard between clips, and a
clip that ends on its still can also be repeated seamlessly. Read `workflow-calling-conventions`
(`load_skill`) and `get_workflow_instructions` of `wf_h3_loop_clip_nsfw` once. Prompts come from
`prompt-writer-minimaxh3` via `draft_prompt` (pass `prompt_ids`, never typed text). No clip
checks and no retries: the prompt carries the quality (one render per clip).

**Slow motion** (cost test 2026-11-09): every clip is rendered SHORT at a natural tempo and
played 1.5× slower: `duration_seconds` = 7.3 with `fps` = 32 (the graph's RIFE 2× makes 48 frames
per rendered second; 32 fps plays them 1.5× slower), so it plays 10.9 s at about 0.54× the cost of
a full-length render (the workspace profile sets 6 steps). The prompt's seconds are on the RENDER
clock (0-7.3 s).

**What the pilots taught** (built into the template below):
- the end-frame pin holds the framing: without it, clips cropped in or pulled back to a wide shot
  (montage pilot v5, 3 of 9 renders);
- the room is ONLY pictured, never described: a room text that differed from the location picture
  (a "crimson" lamp, a vanity) made the model repaint the room and widen the shot to fit it;
- every reference is named in `subject_definitions` with a retention level in
  `retention_analysis` (H3 Template B) - written by platform CODE from `image_inputs` (a writer
  once swapped the face and outfit pictures), never by hand-written picture definitions;
- a still with a garment partly off: the outfit picture (fully worn) must not be `fully_preserved`,
  or the model pulls the garment back on mid-clip;
- ONE gesture in place; nothing toward or away from the lens.

The footage is 16:9 landscape from a FIXED camera on a tripod: never handheld movement, shake, pan,
orbit, zoom or reframing.

## 1. Preflight

Fields: `look` (the look id), `scene` (N), `clips` (optional: only these clip ids of the look, e.g.
`c01, c05`), `storyboard` (default `storyboard_scene_<N>`), `character` (the character design
key), `outfit` (the outfit design key; `none` for a nude look), `location` (the location design
key), `plan` (default `visual_plan`), `inputs` (default `episode_inputs`).
1. `task_failed(reason)` if the tool `wf_h3_loop_clip_nsfw` is missing ("load the
   h3_loop_clip_nsfw workflow"), or - when a clip of this look is `kind: reveal` -
   `wf_h3_start_end_clip_nsfw` is ("load the h3_start_end_clip_nsfw workflow").
2. `artifact_index`: the storyboard artifact must be finished (approved); else
   `task_failed("<storyboard> is not finished yet - finish it in the design studio and retry")`.
3. `read_artifact` `visual_plan.json`: `looks[<look>]` (`camera`, `body_pose`, `stills` with `id`,
   `beat`, `hands`, `face`, `garment_state`, `exposure_part`) and the clips whose `look` is this look
   (each with `gesture`, `prompt_line`, `seed`; a reveal also `kind`, `from_still`) (in plan
   order; with a `pilot` block: only the clips it lists; with the `clips` field: only those).
4. `read_artifact` the storyboard: `design.json` (`notes`; `published.outputs`: entries of group
   `frame` with `file`, `shot`, `edits`) and `shotlist.md`.
5. **The still frames**: the storyboard `notes` (= scene N's Summary) START with `Montage stills:
   beats N.a-N.b.` Still k of the look (its `beat` = k) is beat `N.(a+k-1)`. For each still: the
   shots of `shotlist.md` whose `Beat:` line is exactly that beat AND that have a published frame
   (a person may leave a bad shot unpublished); take the one whose `Camera:` line matches the
   look's camera (the same framing size, height and direction - `medium close-up, eye level, from
   the front` matches `medium close-up shot, eye level, from the front`; a beat can carry an extra
   wider shot that only shows a contact), else the LAST of them in shot order; and its published
   frame (the `frame` output whose `shot` is that shot id). Keep its `Action`, `Pose`, `Contact`
   and `Camera` lines and the frame's `edits` trail. No marker, or a still without a shot or a
   published frame: `task_failed` naming it (never fall back to another still's frame).
6. `read_artifact` the DESIGNS (they are the authority, never the plan's text):
   - the character design: its display name (`<name>`), `view_face.<ext>`, and from
     `design.json` `attributes` its age, hair, eyes and one face feature (`<identity>`) and its
     `marks` (`kind | part | side | description; ...`);
   - the outfit design (none for a nude look): `full_body_shot.<ext>` and its garment attributes
     (`garments`, `colors`, `material`);
   - the location design: the room plate - `full_body_shot.<ext>` for the set's `view: main`, else
     the published view named by the set's `view`.
7. **The start pose as DRAWN** (one `describe_image` per still frame of this task, before any
   drafting): "In this frame, state in one short line each: her hands and arms; her head (angle,
   tilt); her gaze (on the lens or where); each garment and how it is worn (on, pulled down,
   lifted, off the shoulders, removed)." The frame is the clip's first AND last picture, so this
   drawn pose is the start pose the prompt states - a frame can differ from its plan (a hand
   placed elsewhere, a garment further off than planned). Keep the answer per still.

## 2. The prompt (one per clip)

**The references are named by the platform, never by you.** Pass every picture as `image_inputs`
of `draft_prompt` (`{port, ref[, retention]}`); platform code writes the prompt's
`subject_definitions` picture lines (the start frame, the face view with the character's identity
cue and marks, the outfit by its garments, the place's main picture) and the per-picture
`retention_analysis` lines from them (H3 Template B, `picture_sections` of the workflow), after the
writer answers and again after every enhance. A picture's `retention` defaults to
`fully_preserved`. In `context`, NEVER number or describe a picture; when an instruction is about
one picture, name it by its `artifact://` ref - code rewrites the ref into that picture's label.

`image_inputs` (ports of `wf_h3_loop_clip_nsfw`, without gaps): `ref0` = the clip's still frame
(`artifact://<storyboard>/<frame file>`, pinned as the first AND last frame), `ref1` =
`artifact://<character>/view_face.<ext>`, `ref2` = the outfit's `full_body_shot` (not for a nude
look) - with `retention: attribute_transfer` on a `partly` / `removed` still (the outfit picture
shows the garments fully worn; kept `fully_preserved`, it pulled a garment back on mid-clip, pilot
v5) -, `ref3` = the room plate (a nude look: `ref2`).

**`context`** - only what the platform cannot know, in this order:
1. The clip: "One continuous take from a fixed camera on a tripod, 16:9 landscape, framed <the look's
   camera line>. ONE <gesture name> in place, then a return to the exact pose of the start frame."
2. The phases on the render clock: "0-1 s: she holds the pose of the start frame: <the DRAWN
   start pose of step 1.7 - hands, head, gaze>. 1-5.5 s: <the clip's prompt_line, its tempo words made natural (not slow - the playback is
   slowed), the movement full and clearly visible>. 5.5-7.3 s: she returns exactly to the pose of
   the start frame - hands, head, gaze and garments as at the start - eyes on the lens."
3. The shot's `Action`, `Pose`, `Contact` and `Camera` lines verbatim (NEVER its `Location`,
   `Frame` or `Lighting` lines, never the plan's set or outfit text) and the frame's `edits`
   trail ("the frame was edited: <edits> - keep those changes"); where a line contradicts the
   DRAWN start pose (hands, head, a garment's state), leave that part out - the frame wins, two
   different start poses in one prompt make the clip jump.
4. The garment state (`garment_state`, as DRAWN where the frame differs - step 1.7): a `worn` still - "her outfit stays fully on as in the
   start frame"; a `partly` / `removed` still - the displaced garment and its end state held for
   the whole video ("her <garment> stays <its state from the still's `garment_state`> as in the
   start frame, it is never put back on", e.g. a top lifted, a strap off the shoulder, a cup
   pulled down, a robe off the shoulders) plus "the outfit picture `artifact://<outfit>/full_body_shot.<ext>`
   gives only the garments' colours, materials and details; how they are worn comes only from the
   start frame".
5. NOTHING about the room in words: no furniture, lamp, colour or light (a room text that differed
   from the picture made the model repaint the room and widen the shot, pilot v5) - the room lock
   is a verbatim phrase (below).
6. "No speech: her lips stay closed or part only for soft breaths and the gesture's sounds; no
   music. Quiet room tone."

`verbatim_phrases` (kept word for word by code; one the writer drops becomes a line of
`continuity_constraints`): "a fixed camera on a tripod: no handheld movement, no shake, no pan, no
zoom, no cut, no reframing", "ONE clearly visible gesture in place at a natural tempo; she stays in
the same body pose at the same distance from the camera; she never leans toward the lens", "the
set behind her stays exactly as in the start frame for the whole video: nothing added, nothing
recoloured"
(the writer dropped this lock in 3 of 4 drafts, and every clip whose room drifted lacked it - v7),
and the garment state sentence of item 4.

**Drafting**: `draft_prompt` for `wf_h3_loop_clip_nsfw` with `duration_seconds` = 7.3,
`image_inputs`, `context` and `verbatim_phrases` as above. One `review_prompt` (the picture and
retention sections and the locked phrases are code's - not part of the review): the summary's
`[keyframe completion]` tag, a `detailed_description` with the timestamped phases ending in the
return to the start frame, the gesture, the garment state, and no room, furniture, lamp or colour
described in words; a missing one is a significant gap: one `enhance_prompt` naming it.

## 2b. Reveal clips (`kind: reveal`)

A reveal shows the garment change itself, once per look: it starts on the frame of `from_still`
(a worn still) and ends on the frame of `still` (the exposed still), both of this look - the same
framing, set and body pose. Find both frames as in step 1.5 and describe both as drawn (1.7).
- `image_inputs` (ports of `wf_h3_start_end_clip_nsfw`): `ref0` = the `from_still` frame (the start
  frame), `ref1` = the face view, `ref2` = the outfit's `full_body_shot` with `retention:
  attribute_transfer`, `ref3` = the room plate. The END frame is not an image input of the prompt
  (no picture line): it goes only on the render's `end_frame` port.
- `context`: 1. "One continuous take from a fixed camera on a tripod, 16:9 landscape, framed <the
  look's camera line>: ONE garment change in place, from the start frame's state to the end
  state." 2. The phases: "0-1.5 s: she holds the start pose: <the DRAWN pose of the start frame>.
  1.5-5.5 s: with her own hands she <the change: the garment that differs between the two stills'
  `garment_state` (as drawn), from its start state to its end state, e.g. slides the robe off both
  shoulders, pulls the cups of her bra down, lifts her top>, at a natural tempo, the movement full
  and clearly visible. 5.5-7.3 s: she holds the end state: <the DRAWN pose of the end frame>, eyes on
  the lens." 3. The start still's shot lines as in item 3 above. 5. and 6. as above (no room in
  words, no speech).
- `verbatim_phrases`: the fixed-camera and set phrases above, "she stays in the same body pose at
  the same distance from the camera; she never leans toward the lens", and the end state: "at the
  end <the garment> is <its end state>, and it stays so".
- Render: `wf_h3_start_end_clip_nsfw` with `ref0`-`ref3`, `end_frame` = `artifact://<storyboard>/<the
  still's frame file>`, `prompt_ids`, `duration_seconds` = 7.3, `fps` = 32, the clip's `seed`;
  otherwise as in section 3.

## 3. Render (per clip, in plan order)

`wf_h3_loop_clip_nsfw` with `ref0`-`ref3` as above, `prompt_ids`, `duration_seconds` = 7.3, `fps`
= 32 (slow motion; never 48), `seed` = the clip's `seed`, no `steps` (the workspace profile sets
6), LoRAs: only the shot's `LoRAs:` names of the minimaxh3 family (no act LoRA). Never pass width
/ height (the still's 16:9 shape decides). Output → `/workspace/<artifact id>/<clip id>.mp4`
(`output_video`); the audio output is not kept. One render per clip, no retries; the clips are
independent: submit them one after another, then collect. A render that FAILS (an error, no
video) is submitted once more; a finished render is delivered as it is.

## 4. Clip list

`look<N>_clips.json` (for post-production; one `sandbox_exec` python3 snippet): one entry per clip
in plan order - `id`, `slot` (`start`, `end` from the plan), `still` (id, beat, shot, frame
file), `gesture`, `garment_state`, `file`, `prompt_id`, `seed`; a reveal also `kind: "reveal"`,
`from_still` (id, beat, shot, frame file) and `workflow`.

## 5. Reply

Workflow, look, the stills (beat, shot, frame), per clip one line (gesture, file), files. Then
`task_complete`.
