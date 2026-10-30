---
name: troubleshoot-production
description: >
  Use when the person reports that a scene, storyboard, shot, frame or clip looks wrong or a task
  seems stuck - "the top disappears between shots", "she never jumps", "the doll is life-size", "the
  gown is the wrong colour", "the act is not shown", "the clip is square", "the storyboard agent said
  it fixed it but nothing changed", "the frame replacement is stuck", "why did this shot fail" - and
  asks to find the cause and fix it in this workspace. Produces a root cause (which layer is wrong)
  and the smallest fix applied at that layer, verified. Do NOT invoke for writing a new storyboard or
  shot list from scratch, shooting a scene, designing a character, or prompt writing.
agentType: worker
---

# Troubleshoot a production (scenes, storyboards, shot lists, frames, clips)

You are a worker: you can read every artifact, look at pictures and clips (sandbox + `describe_image`)
and fix the layers your task owns. Changes only the person (or the coordinator) can make, you ASK for.

## The one rule: fix the layer that is wrong, never the one that shows it

`scene_list.md` (beats, looks, camera) -> designs -> storyboard `shotlist.md` -> frames / takes ->
clip briefs -> clips -> assembly. A defect seen in a clip is usually written in a layer above it; a
fix below the faulty layer comes back on the next run. Find the FIRST wrong layer.

## 1. Pin the defect down

- Name the scene, the shot (`s<scene>-<nn>`) or clip, and the symptom in one sentence; if the person
  did not say which, ask in one line - never guess a shot.
- Read (`read_artifact`; `task_index` for tasks): the scene's rows in `scene_list.md`; the shot block in
  the storyboard's `shotlist.md`; for a clip its task brief and its `*_prompt.txt`.
- Never trust a reply that something was "updated": re-read the artifact.

## 2. Look before you judge (mandatory)

Text says what was ASKED; only the pictures say what HAPPENED. Look before naming a cause, and again
to verify a fix.

1. `sandbox_fetch` by `artifact://` reference into `/workspace/in/`: the frame of each involved shot
   and of the shot before it; each involved clip; for a `continue` clip the previous clip; for a
   failed take also its reference designs' pictures.
2. A clip becomes ONE strip of evenly spaced frames (never a single frame):
   `ffmpeg -v error -i in/clip.mp4 -vf "fps=6/<duration s>,scale=480:-1,tile=6x1" -frames:v 1 strip.png`
   (`get_video_info` gives the duration); the previous clip's last frame:
   `ffmpeg -v error -sseof -0.05 -i in/prev.mp4 -frames:v 1 -vf scale=480:-1 prev_last.png`.
3. Put what must be compared side by side in ONE sheet, in time order (previous last frame |
   keyframe | clip strip, or references | take): `hstack` / `vstack`; save it as
   `/workspace/<your artifactId>/inspect_<shot>.png` so it has an `artifact://` reference.
4. `describe_image(url="artifact://<artifactId>/inspect_<shot>.png", prompt=...)`: name the panels left
   to right, ask the symptom as yes/no questions + why, and always the continuity questions: "Does the
   clip start where the previous panel ends? Does any person or object jump to another position, size
   or camera position between neighbouring panels? Can ONE camera move (push / pull / pan / tilt / arc)
   get from panel A to panel B?" One sheet per question set.
5. Write down what was seen; a cause that contradicts it is wrong.

## 3. Find the faulty layer (symptom -> check -> layer)

| Symptom | Check | Faulty layer if... |
|---|---|---|
| A garment vanishes between shots; an undressing is never shown | the beat's looks column vs its action ("unties her top") | the row lists only the later look -> **scene list** (a beat lists the look AT its start; a look-changing beat lists both) |
| | the shots of that beat | no shot wears the earlier look, or no `Motion:` beat performs the change -> **storyboard** |
| An action never happens (she never jumps); the clip is a still | the shot's `Motion:` | a beat holds one pose for the whole shot ("0-4 s hangs airborne") -> **storyboard** (motion is the action in progress) |
| | a `continue` clip whose next keyframe is a different moment | a continuation only knows where it starts -> **clip planning**: make it its own cut, or split the action into beats |
| A clip morphs, teleports or cuts inside itself | the clip brief's `clip_plan:` line and block vs a FRESH `clip_plan(<storyboard>)` call (read the brief with `task_index` / `task_info`); the sheet of step 2 (previous clip's last frame, this keyframe, this clip) | the brief's `clip_plan:` line (version / shotlist md5) or its `mode` / `framing_change` lines differ from the fresh call -> **clip planning** went stale or wrong: re-plan as the tool says (`update_task` with the fresh block for a clip not started; otherwise ask for a re-run with it, step 4). Same as the fresh call and the derived mode is `continue`, yet it still morphs -> visual reachability, which the server cannot decide: the **storyboard** (fix the shot: its move or framing) or make the boundary a cut there. The table's "overrides shotlist" rows show where the server already refused a written `continue` |
| A clip lands on another composition than it started from | the step-2 sheet: previous last frame vs keyframe; the brief's `clip_plan:` block vs a fresh `clip_plan` call | as the row above: a stale / wrong plan -> re-plan; a derived `continue` between frames from different camera positions -> storyboard fix or a cut |
| A small character (doll, pet, creature) is person-sized | the character design's words; the shot's `Pose:` / `Visible:` | the size is not stated, or the shot pictures it as a full figure beside its holder -> **design / storyboard** ("a small doll in her arms", upper body) |
| Wrong colour of a garment / gown | the take's / clip's prompt file or the frame's "View prompt" text vs the outfit design's colours | the prompt names another colour ("golden ballgown" vs a pink design) -> **prompt / plan**, not the render |
| | strong coloured light in the shot | warm light tints pale fabric -> **shot lines**: state "stays <colour> under the <light>" |
| The explicit act or the contact is not shown | `Sex act:`, `Sex position:`, `Contact:`, `LoRAs:` of the shot | lines missing -> **storyboard**; lines present, act LoRAs not loaded -> **render** (report); both fine -> a render miss: replace the frame |
| A first-person (POV) body is drawn in the wrong order | `POV:` posture, `Visible:` extent, `Wardrobe:` | lines fine -> render miss: replace the frame with "Describe what's wrong" |
| A clip is square / the wrong orientation | `get_video_info` of the clip vs the start frame's size | a size not taken from the frame -> **platform**: report it, do not patch per clip |
| `write_shot` refused a shot | the refusal text | it names the rule; e.g. a touched thing is plain words ("on bin lid", never "bin (lid)") |
| A storyboard / frame job looks stuck | the job's step and the renderer's phase / progress | 20+ minutes of rendering and checking is normal; stuck = no progress and no render in flight |
| An agent says it fixed something, nothing changed | re-read `shotlist.md` / the artifact | no tool was called -> re-send the request naming the exact tools and asking to quote each result |
| A re-run changed more than asked | diff the artifact before vs after | the instruction was not followed -> ask for a re-run with the old text (step 4), say what changed |

## 4. Fix what you own, ask for the rest

- **Shot lines** (you are the storyboard's worker): read the current entry, change only the faulty
  lines with `write_shot`, then `plan_shot` for that shot, then `draft_storyboard` (no arguments).
  Never rename or renumber a shot; quote each tool result. For a text-only correction whose frames
  are already right, keep the takes (`keep_takes`) instead of re-rendering, when the person asks so.
- **A clip brief not started yet**: `update_task` (prompt) with the corrected brief; its `clip_plan` block is copied verbatim from a fresh `clip_plan` call, never edited by hand.
- **Ask the person** (one line each, with the exact change) for anything else: switching the workspace
  to Manual before resets; re-running the scene list or a finished storyboard; "Replace frame" ->
  "Describe what's wrong" with ONE concrete sentence; re-running a finished clip with the corrected
  brief (say the instruction to paste); recreating a storyboard.
- A re-run of a text artifact (scene list, shot list, brief) rewrites the WHOLE file: before asking for
  it, keep the old text; the instruction carries the COMPLETE corrected file between BEGIN / END and
  "write exactly this, byte for byte"; afterwards compare line by line.
- Never delete a task or artifact unless the person asks.

## 5. Verify and report

Look again (step 2) at the new frames / clips. Reply: **Symptom** - **Seen** (what the vision model
saw, panel by panel) - **Root cause** (the layer and the line) - **Fix** (with tool results) - **Asked
of the person** (what only they can do).
