---
name: iwc-loop-clip
description: >
  Use when the task prompt says "Load and use skill: iwc-loop-clip", or asks to render the montage
  CLIPS of one look of an iWantClips episode from its finished storyboard, with the render settings
  of the plan's `render` (the episode's production style): a loop clip starts AND ends on its still's
  storyboard frame (h3_loop_clip_nsfw; the slow style renders 7.3 s played as 10.9 s), with the
  character's face view, the outfit picture and the room plate as named references; ONE in-place
  gesture per clip from the plan; a REVEAL clip (`kind: reveal`) or a fluid STATE-CHANGE clip
  (`kind: state_change`) runs from an earlier still to its still (h3_start_end_clip_nsfw); a fast
  style's MULTISHOT clip (`kind: multishot`) cuts between 3-4 stills in real time
  (h3_multishot_clip_nsfw); a clip list for post-production. Do NOT invoke for
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

**Render settings** come from the plan's `render` (written by the montage planner from the
episode's production style), never from this skill: `workflow`, `duration_seconds` (= D below),
`fps`, `playback_rate`, `shots_per_clip`, `camera_rule` and `tempo_words`. The prompt's seconds are on
the RENDER clock (0-D s). The phase marks below are for any D: the hold to 0.14 D, the gesture to
0.75 D, the return to D (D = 7.3: 0-1 s, 1-5.5 s, 5.5-7.3 s; D = 10: 0-1.4, 1.4-7.5, 7.5-10).
- Slow style (cost test 2026-11-09): rendered SHORT at a natural tempo and played 1.5× slower:
  `duration_seconds` 7.3 with `slow_motion` 1.5 and `fps` 48 (the graph's RIFE 2× makes 48 frames per
  rendered second and plays them at 32 fps, 1.5× slower) = 10.9 s on screen at about 0.54× the cost of a
  full-length render.
- Medium and fast styles play in REAL TIME: `fps` 48, no `slow_motion`; a fast style's clips are
  multishot (section 2c). Never change the plan's fps or playback_rate.
`<camera rule>` below is `render.camera_rule` word for word; `<tempo words>` is `render.tempo_words`
(no `render.camera_rule`: "a fixed camera on a tripod: no handheld movement, no shake, no pan, no
zoom, no cut, no reframing"; no `tempo_words`: "at a natural tempo"). `<set lock>` is
`render.set_lock` when the plan has one (a chroma-key set: the flat green background, keyed in
post), else "the set behind her stays exactly as in the start frame for the whole video: nothing
added, nothing recoloured".

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

The footage is 16:9 landscape; its camera is `<camera rule>` (the slow style: a FIXED camera on a
tripod - never handheld movement, shake, pan, orbit, zoom or reframing). A loop clip never moves
toward or away from her, whatever the camera rule.

## 1. Preflight

Fields: `look` (the look id), `scene` (N), `clips` (optional: only these clip ids of the look, e.g.
`c01, c05`), `storyboard` (default `storyboard_scene_<N>`), `character` (the character design
key), `outfit` (the outfit design key; `none` for a nude look), `location` (the location design
key), `plan` (default `visual_plan`), `inputs` (default `episode_inputs`).
1. `task_failed(reason)` if the tool of a workflow this look's clips need is missing ("load the
   <name> workflow"): `wf_<render.workflow>` for its plain clips, `wf_h3_start_end_clip_nsfw` for a
   `reveal` / `state_change` clip, `wf_h3_multishot_clip_nsfw` for a `multishot` clip.
2. `artifact_index`: the storyboard artifact must be finished (approved); else
   `task_failed("<storyboard> is not finished yet - finish it in the design studio and retry")`.
3. `read_artifact` `visual_plan.json`: `render`, `looks[<look>]` (`camera`, `body_pose`, `stills`
   with `id`, `beat`, `hands`, `face`, `garment_state`, `exposure_part`, `body_state`, `items`) and
   the clips whose `look` is this look (each with `gesture`, `prompt_line`, `seed`; a reveal or
   state change also `kind`, `from_still` (a state change `fluid`); a multishot clip `shots`,
   `gestures`, `prompt_lines`, `shot_seconds`) (in plan order; with a `pilot` block: only the clips
   it lists; with the `clips` field: only those).
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
   lifted, off the shoulders, removed); any fluid on her skin or hair (oil, saliva, sweat, water,
   slime, semen) and where." The frame is the clip's first AND last picture, so this
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
1. The clip: "One continuous take, <camera rule>, 16:9 landscape, framed <the look's camera
   line>. ONE <gesture name> in place, then a return to the exact pose of the start frame."
2. The phases on the render clock (marks for D as above): "0-1 s: she holds the pose of the start
   frame: <the DRAWN start pose of step 1.7 - hands, head, gaze>. 1-5.5 s: <the clip's
   prompt_line with <tempo words> (with a slowed playback never "slow": the playback slows it),
   the movement full and clearly visible>. 5.5-7.3 s: she returns exactly to the pose of the start
   frame - hands, head, gaze and garments as at the start - eyes on the lens."
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
4b. The body state: a still with a `body_state` (fluids, as DRAWN where the frame differs): "her
   <body_state, comma-separated> stay as in the start frame for the whole video" (a fluid that
   vanishes mid-clip is a jump in the montage); none: nothing.
5. NOTHING about the room in words: no furniture, lamp, colour or light (a room text that differed
   from the picture made the model repaint the room and widen the shot, pilot v5) - the room lock
   is a verbatim phrase (below).
6. "No speech: her lips stay closed or part only for soft breaths and the gesture's sounds; no
   music. Quiet room tone."

`verbatim_phrases` (kept word for word by code; one the writer drops becomes a line of
`continuity_constraints`): "<camera rule>", "ONE clearly visible gesture in place <tempo words>;
she stays in the same body pose at the same distance from the camera; she never leans toward the
lens", "<set lock>"
(the writer dropped this lock in 3 of 4 drafts, and every clip whose room drifted lacked it - v7),
and the garment state sentence of item 4 and the body state sentence of item 4b.

**Drafting**: `draft_prompt` for `wf_<render.workflow>` with `duration_seconds` = D,
`image_inputs`, `context` and `verbatim_phrases` as above. One `review_prompt` (the picture and
retention sections and the locked phrases are code's - not part of the review): the summary's
`[keyframe completion]` tag, a `detailed_description` with the timestamped phases ending in the
return to the start frame, the gesture, the garment and body state, and no room, furniture, lamp or colour
described in words; a missing one is a significant gap: one `enhance_prompt` naming it.

## 2b. Reveal and state-change clips (`kind: reveal`, `kind: state_change`)

A reveal shows the garment change itself, once per look: it starts on the frame of `from_still`
(a worn still) and ends on the frame of `still` (the exposed still), both of this look - the same
framing, set and body pose. Find both frames as in step 1.5 and describe both as drawn (1.7).
- `image_inputs` (ports of `wf_h3_start_end_clip_nsfw`): `ref0` = the `from_still` frame (the start
  frame), `ref1` = the face view, `ref2` = the outfit's `full_body_shot` with `retention:
  attribute_transfer`, `ref3` = the room plate. The END frame is not an image input of the prompt
  (no picture line): it goes only on the render's `end_frame` port.
- `context`: 1. "One continuous take, <camera rule>, 16:9 landscape, framed <the look's camera
  line>: ONE garment change in place, from the start frame's state to the end state." 2. The phases: "0-1.5 s: she holds the start pose: <the DRAWN pose of the start frame>.
  1.5-5.5 s: with her own hands she <the change: the garment that differs between the two stills'
  `garment_state` (as drawn), from its start state to its end state, e.g. slides the robe off both
  shoulders, pulls the cups of her bra down, lifts her top>, at a natural tempo, the movement full
  and clearly visible. 5.5-7.3 s: she holds the end state: <the DRAWN pose of the end frame>, eyes on
  the lens." 3. The start still's shot lines as in item 3 above. 5. and 6. as above (no room in
  words, no speech).
- `verbatim_phrases`: the camera and set phrases above, "she stays in the same body pose at
  the same distance from the camera; she never leans toward the lens", and the end state: "at the
  end <the garment> is <its end state>, and it stays so".
- Render: `wf_h3_start_end_clip_nsfw` with `ref0`-`ref3`, `end_frame` = `artifact://<storyboard>/<the
  still's frame file>`, `prompt_ids`, `duration_seconds` = D, `fps` and `slow_motion` as in section 3,
  the clip's `seed`; otherwise as in section 3.

A STATE CHANGE (`kind: state_change`, `fluid`) performs a fluid's first appearance the same way: from
the `from_still` frame (without the fluid) to the `still` frame (with it), both of this look. Its
change is the clip's `prompt_line` (she applies it: pours the oil and spreads it, lets saliva fall,
pours the slime), not a garment: phase 2 is "1.5-5.5 s: <the prompt_line, as an action from the start
state>", phase 3 holds the end frame's body state as DRAWN. The look's `items` name the prop the
action uses (a small bottle, a bowl, a glass); say where it is at the start ("a small bottle of oil
in her right hand"). The garments stay as both frames show them (item 4 for the start frame; a
garment that differs between the two frames: `task_failed` naming both stills - a state change
never hides a garment change). `verbatim_phrases`: the camera and set phrases, "she stays in the
same body pose at the same distance from the camera; she never leans toward the lens", and "at the
end <the end still's body_state> stays on her skin". Render as a reveal.

## 2c. Multishot clips (`kind: multishot`, a fast style)

One clip = 3-4 HARD-CUT shots of this look in real time: `shots` lists one still per shot (shot k
plays `gestures[k]` / `prompt_lines[k]` for `shot_seconds`). Each shot's keyframe is that still's
storyboard frame (found as in step 1.5).
- **Continuity gate** (before drafting): describe each keyframe as drawn (step 1.7). The shots of a
  clip are ONE continuous moment: the same room, outfit and identity, and the garment and body state
  never go backwards between shots (a garment back on after it was off, a fluid gone). A keyframe
  that breaks this: leave the clip out (no render) and list it in the reply as `not rendered:
  keyframe continuity (<shot>: <what differs>)`.
- `image_inputs` (ports of `wf_h3_multishot_clip_nsfw`, without gaps): `ref0` = shot 1's keyframe,
  `key1`-`key3` = the keyframes of shots 2-4 (as many as the clip has), `ref1` = the face view,
  `ref2` = the outfit's `full_body_shot` (`attribute_transfer` when a shot's still is `partly` /
  `removed`), `ref3` = the room plate (a nude look: `ref2`).
- `context`: 1. "<shots> shots with hard cuts, real time, <camera rule>, 16:9 landscape." 2. One
  block per shot k (t = (k - 1) × `shot_seconds`): "[Shot k] At <t> s, hard cut: <the shot's
  still's camera line>; <the DRAWN pose of its keyframe>; <prompt_lines[k] with <tempo words>, ONE
  action, the movement full and clearly visible>. End state: <where her hands and head end>." (shot
  1 without "hard cut"). 3.-6. as for a loop clip (garment and body state per shot as drawn).
- `verbatim_phrases`: "<camera rule>", the set phrase, "every cut is a hard cut to the next
  keyframe; no zoom or push-in inside a shot".
- Render: `wf_h3_multishot_clip_nsfw` with the ports above, `prompt_ids`, `duration_seconds` = D,
  `fps` and `slow_motion` as in section 3, `guide<k>_frame` = round(k × `shot_seconds` × 24) for k = 1 .. shots - 1
  (the cut times of the prompt × 24), the clip's `seed`; otherwise as in section 3.

## 3. Render (per clip, in plan order)

`wf_<render.workflow>` with `ref0`-`ref3` as above, `prompt_ids`, `duration_seconds` = D, `fps` 48,
`slow_motion` = `render.playback_rate` when it is above 1 (the slow style's 1.5; omit it otherwise), `seed` = the clip's `seed`, no `steps` (the workspace profile sets
6), LoRAs: a clip with `loras` in the plan (a fluid's state-change clip, e.g. `h3_squirt`) takes
exactly those and nothing else (they load alone); every other clip only the shot's `LoRAs:` names of
the minimaxh3 family (no act LoRA). Never pass width
/ height (the still's 16:9 shape decides). Output → `/workspace/<artifact id>/<clip id>.mp4`
(`output_video`); the audio output is not kept. One render per clip, no retries; the clips are
independent: submit them one after another, then collect. A render that FAILS (an error, no
video) is submitted once more; a finished render is delivered as it is.

## 4. Clip list

`look<N>_clips.json` (for post-production; one `sandbox_exec` python3 snippet): one entry per clip
in plan order - `id`, `slot` (`start`, `end` from the plan), `still` (id, beat, shot, frame
file), `gesture`, `garment_state`, `body_state`, `file`, `prompt_id`, `seed`, `fps`,
`playback_rate`, `chroma_key` (the plan's `render.chroma_key`, for keying; none for a real set); a reveal or state change also `kind`, `from_still` (id, beat, shot, frame file)
and `workflow` (a state change `fluid`); a multishot clip `shots` (per shot: still, frame file,
gesture, start s) and `workflow`; a clip left out by the continuity gate `not_rendered` with the
reason.

## 5. Reply

Workflow, look, the stills (beat, shot, frame), per clip one line (gesture, file), files. Then
`task_complete`.
