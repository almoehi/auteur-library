---
name: shoot-scene-task
description: >
  Trigger when the user wants to shoot, film, or render a named scene into video clips —
  e.g. "shoot scene 2", "let's film scene 1", "create a task to shoot the hotel lobby scene",
  "plan and shoot artifact://<storyboard>", "shoot storyboard_scene_3", "shoot @scene_3",
  "shoot scenes 1 and 4" (several scenes or storyboards in one request).
  Validates prerequisites, reads each scene's finished storyboard design (shot list + keyframes),
  and schedules ONE task per clip (one clip per shot, or one per multi-shot bundle when the clip plan bundles shots) plus one assembly task PER scene that joins
  the clips into the scene video. Load this skill instead of creating a single worker task that
  renders the clips itself. Also handles direct assembly requests — "assemble scene 3",
  "stitch the clips of scene 2", "render the final cut of scene 1" — by (re)creating only the
  missing `assemble_scene<N>` task (see "Assembly-only requests").
  Do NOT invoke for storyboard design or keyframe rendering (storyboard-scene), prompt writing,
  rendering a single clip yourself (worker skill shoot-clip), or any task that does not result
  in producing final video clips for a named scene.
agentType: workspace
---

# Shoot Scene

Coordinator skill: validates prerequisites, reads the scene's storyboard design, plans the clips and creates ONE task per clip (worker skill `shoot-clip`) plus ONE assembly task (worker skill `assemble-scene`). A clip is one shot, or - only when the clip plan says so (Step 3a-2) - one bundle of 2-4 consecutive shots rendered as ONE multi-shot clip. Never let a worker render several clips for different tasks.

- A scene is named by a storyboard artifact URI, `storyboard_scene_<n>` or `@scene_<n>` (scene number from the storyboard key).
- Several scenes in one request: run Steps 0-4 per scene in the given order (clip tasks + `assemble_scene<N>` each; never merge scenes); one combined Step 5 reply.

## Assembly-only requests

"Assemble / stitch / final cut of scene N" is this skill; `assemble-scene` runs only as task `assemble_scene<N>`.

- Resolve the scene (Step 0; no video workflow needed); run Step 1c.
- Clip tasks `shoot_scene<N>_clip<M>` missing -> never shot: say so, offer the full shoot; never assemble a subset.
- `assemble_scene<N>` live -> tell the user, create nothing. Failed / cancelled, or absent with all clips present -> create just Step 4b (all clips' artifacts listed) and give a one-line Step 5 reply.

## Step 0 — Resolve intent (before reading any artifact)

- Scene: stated explicitly ("Scene 2", "s2", "the rain scene"). Ambiguous -> ask: "Which scene should I shoot? Available scenes: [from the `scene_list` artifact]".
- Video workflows, from the `wf_*` tool list by type / capability in each description and `get_workflow_instructions`, never by name:
  - Fresh-start (REQUIRED, for `cut` and first clips): image-to-video, type `i2v` / `i2va` (flf2v only when its last frame is optional). Text-to-video is not a substitute. None in the workspace -> create nothing; say: "Cannot shoot <scene>: this workspace has no image-to-video workflow. Add one (Workflows page) and ask me again."
  - Video-continuation (optional; a video input for the prior clip): for `continue` clips. Without it every boundary is a `cut`.
- A user-named workflow must qualify for these roles, else say why and stop. Several i2v / i2va qualify and none named: prefer one that also takes reference images (a `reference_role` image input); ask only if they differ in a way the user must choose.

## Step 1 — Preflight

### 1a. Storyboard design

- Source: `artifact_index` -> `storyboard_scene_<n>` (key may carry a suffix; match the number): approved, with `shotlist.md` and `frame_1.<ext>` … `frame_N.<ext>`. Frame i = start frame of shot i; N must equal the shot count, else tell the user and stop. No other source, no partial scheduling.
- None exists: "Cannot shoot <scene>: it has no storyboard design yet. Create and finish it in the design studio (Pre-production -> Storyboards) and ask me again."
- Not approved: "Cannot shoot <scene>: the storyboard design `<key>` is not finished yet. Finish it in the design studio (Pre-production -> Storyboards) and ask me again."

### 1b. Reference designs (only what the start frame cannot hold)

The clip starts from its storyboard frame, which already fixes identity, outfit, place, light and composition. A reference is added ONLY for what the frame cannot keep over the clip; by default a clip has NO references (an extra picture fights the frame: an outfit re-dresses a nude person, a sheet adds grid artifacts, a wrong place replaces the scene).

Per shot, from its shotlist block (designs by KEY via `artifact_index`; `Outfits:` per shot, never a scene-level look):
- A PERSON pictured in the frame gets ONE image only when the motion changes what the frame shows of them: their face turns toward or away from the camera, comes much closer, or they enter / re-enter the frame (Action, Pose, Movement). The image: the outfit design that matches what they wear IN THIS SHOT; for `<c>:nude` / `<c>:none`, or a partly undressed outfit look (`Wardrobe: … removed:`), the CHARACTER design. One image per person, never both.
- The LOCATION gets an image only when the camera move reveals space the frame does not show (`Movement:` a pan, turn, orbit or travel - not `hold`, not a handheld drift): the published view whose description faces that direction, else none. Never the location of another shot.
- NEVER a picture of the `POV:` owner or a `limbs` person (words only), nor their outfit ("References by extent" in `workflow-calling-conventions`).
- `continue` clips: no references (the prior clip and, on a framing change, this shot's frame carry everything) - except a person who enters the frame during the clip.
- Older shotlists with slugs instead of keys: map via the `scene_list` row (`location_slug`, beat `Location` slugs, per-BEAT `Outfits` `<character>:<look>`) to `location_<slug>`, `outfit_<character>_<look>`, `character_<character>` (suffix tolerated).
- Image per design: the published `full_body_shot.<ext>` (`primary.<ext>` in older designs), a chosen `view_<id>.<ext>`, never a `sheet.<ext>` (a grid of angles / poses). Missing designs are not fatal: note and continue without.
- Reference = `artifact://<artifact id>/<file>` (real file name). Order: location (if any), then people. The clip's own frame is the `start_frame`, never a reference.

### 1c. Idempotency

`task_index`: a `shoot_scene<N>_clip<M>` or `assemble_scene<N>` task that exists and is not failed / cancelled is SKIPPED (never duplicated or changed). Create only the missing ones. Everything live: "Scene <N> is already scheduled (clips <list> + assembly). No new tasks created. To re-shoot a clip, cancel its task first."

## Step 2 — Discovery (one artifact at a time)

### 2a. Shotlist

`read_artifact(artifactId="storyboard_scene_<n>", artifact_file="shotlist.md")` (pass the key, not the UUID). Sections `## <shotId> — <title>` with lines `Action:`, `Camera:`, `Movement:`, `Characters:`, `Outfits:`, `Duration:` (seconds), `Transition:` (`continue — <reason>` | `cut — <reason>`; absent in older storyboards); designs are KEYS.

- Keep each shot's complete block (heading + every line to the next heading) VERBATIM for the clip task, EXCEPT the keyframe-plan lines `Workflow:`, `Refs:`, `Prompt:` that older storyboards may carry — strip those three (keyframe-only): includes `Blocking:`, `Pose:`, `Frame:`, `Visible:`, `POV:` and, in a `contentPolicy.nudity: allowed` workspace, `Sex act:` / `Sex position:`.
- Extract per shot: id, title, `Action`, `Camera` (keyframe framing), `Movement` (video camera move), `Duration`, `Transition`, characters / outfits keys, `LoRAs` (the shot's curated list, verbatim in rank order; absent = none).
- No `Movement:`: take it from the matching beat's `Camera move` in the `scene_list` artifact (`### Scene <n>` Beats table, read once); no beat either: leave `movement: none` (the clip then adds no camera move). Never turn a missing movement into "static" and never derive one from the action.
- The matching beat's row of the `scene_list` Beats table (Action, Blocking, Camera move, Continuity, … every column) is passed as `beat:` VERBATIM, never summarised or reworded (the shot's `Action:` is the 0 s state; the beat is what happens next).

### 2a-2. Frame edits

The storyboard design's `design.json` `published.outputs[]` entry of each `frame_<i>` file may carry `edits` (strings, oldest first; absent / empty = none). Pass them verbatim per clip (`frame_edits:`); a clip never brings back what an edit removed.

### 2b. Context

- If an approved `character_table` exists, read the `character_<slug>.md` of characters present (better motion prompts); require no other pre-production artifact.
- `style:` line in EVERY clip task: the workspace medium / style from `{workspace.story.plot}` verbatim ("Medium / style is kept" in `workflow-calling-conventions`).
- `negative_prompt:` in every clip task: the workflow's recommended negative (`get_workflow_instructions` of the preferred workflow); omit the line when the workflow has no negative port.

## Step 3 — Planning

### 3a. One clip per shot

Unless Step 3a-2 bundles it: clip M = shot M; start frame `frame_M`; `duration_seconds` = the shot's `Duration` (whole seconds, at least 1). The first clip is a fresh start (treated as a cut).

Every boundary (shot M-1 -> M) is `continue` or `cut`:
1. Take the shot's `Transition:` as given, with its reason; do not second-guess (except the framing check 2b below).
2. No `Transition:` (older storyboard): decide ONCE here and note "decided here". CONTINUE when the action carries straight on in the same setup (same place, moment, people) AND the framing does not change (`framing_change: no`) or the shot carries a real `Movement:` that performs the change; CUT for a new moment, place or subject, an insert, or a framing change with `Movement:` `hold` / none.
2b. EXCEPTION to 1 (this check overrides a given `Transition: continue`): a `continue` shot whose framing changes (`framing_change: yes`) is kept as `continue` only when its `Movement:` can reach the new framing - push / pull / zoom for a change of shot size, pan / tilt / arc for a change of angle; `hold`, none, a drift or handheld movement cannot. Otherwise plan a `cut` (note "cut: framing changes without a camera move that can reach it"): a continuation cannot change framing by itself and an invented reframe becomes a morph inside the clip.
3. No video-continuation workflow -> every boundary is a CUT.

- `continue`: rendered with the continuation workflow from clip M-1's real file; keeps `requires_tasks` / `requires_artifacts` on the predecessor (it cannot start before clip M-1 is approved). Mechanics (framing change, start offset, no hard cut): `shoot-clip` mode `continue`.
- `cut`: i2v / i2va from `frame_M` as first frame plus the Step 1b references; no clip dependency (renders in parallel); never faked through the continuation workflow, never text-to-video.

### 3a-2. Bundles (from the clip plan, never decided here)

Call the `clip_plan` tool once per scene (it is the authority for modes, references and bundles). Its text has a table with a `bundle` column, a `bundles` list (shots the server joins into ONE multi-shot clip: same place, cut junctions only, at most 4 shots and 15 s) and, per bundle, a section holding the bundle brief followed by "Single-clip fallback" blocks per member shot. A `PROBLEMS` line = stop and tell the user.
- One clip task per plan entry that is not bundled (Steps 3a, 4a) and ONE clip task per bundle (Step 4a-2). A bundle is ONE clip in the numbering: clips are numbered 1..K in plan order, so clip numbers no longer equal shot numbers; record each clip's shots in the Step 3b plan.
- A bundle is a fresh start (like a `cut`): no dependency on the previous clip. The shot after a bundle is a `continue` clip when the plan says so (`break_after` = why the bundle ended); it requires the BUNDLE's task and artifact, and its prior shot is the bundle's LAST member shot: it continues from the bundle clip's last seconds.
- The plan's modes and break reasons win over the in-skill rules of 3a/2b whenever `clip_plan` answers; bundle membership is never authored, widened or split by hand.
- No bundles in the plan (no multi-shot workflow in the workspace, nothing joinable): everything above is skipped and the one-clip-per-shot flow runs unchanged.

### 3b. Canonical names (set once, never renamed)

Per clip M of scene N (slug = 2-3 word kebab-case label from the shot, e.g. `lobby-entrance`):

| What | Name |
|---|---|
| task id | `shoot_scene<N>_clip<M>` |
| output artifact key | `scene<N>_clip<M>` |
| video file | `scene<N>_clip<M>_<slug>.mp4` |
| prompt file | `scene<N>_clip<M>_<slug>_prompt.txt` |
| assembly | task `assemble_scene<N>`, artifact `scene<N>_assembly`, file `scene<N>_assembled.mp4` |

Write out the FULL plan before creating anything (all clip keys + `assemble_scene<N>`; Step 4c reconciles against it), one row per clip: clip, shot(s) (a bundle lists all its shots), boundary (`start` | `continue` | `cut`, from storyboard or decided here), reason, duration, movement, task / artifact, video file.

## Step 4 — Create the tasks

Issue exactly ONE `create_task` per response and wait for its result before the next; NEVER several `create_task` calls in one response: a later clip / `assemble_scene<N>` names the earlier result's task / artifact in `requires_*`, and a batched round drops or guesses them, so the chain runs out of order. `requires_tasks` / `requires_artifacts` are mandatory in every call that has dependencies (4a / 4b). Order: clips 1..N, then assembly. Skip live ones. Each call creates its output artifact inline (`output_artifact_name` + `output_files`); no separate artifact call.

### 4a. Clip task

```
id:                   shoot_scene<N>_clip<M>
title:                "Shoot <Scene Name> – clip <M> (<shot title>)"
description:          one line: what the clip shows
agent:                an agent from available_agents with the wf_* workflow tools and the sandbox
                      (default workspace: `generic`); never a planner, coordinator or director, never an unlisted one
requires_tasks:       ["shoot_scene<N>_clip<M-1>"]   — ONLY for a `continue` clip
requires_artifacts:   ["scene<N>_clip<M-1>"]         — ONLY for a `continue` clip
can_create_tasks:     NOT set
output_artifact_name: scene<N>_clip<M>
output_artifact_description: "<Scene Name> clip <M>"
output_files:         ["scene<N>_clip<M>_<slug>.mp4", "scene<N>_clip<M>_<slug>_prompt.txt"]
prompt:

  Load and use skill: shoot-clip

  scene: "<Scene Name>"  (scene <N>)
  clip: <M> of <total>  — shot <shotId> "<title>"
  mode: continue | cut   (<one-line reason>)
  framing_change: yes | no   (continue only; MECHANICAL: yes iff this shot's `Camera:` line differs from the previous shot's after trimming and lower-casing both; write "previous: <its Camera>")
  shot_block: |
    <the shot's FULL block from shotlist.md, verbatim, every line: Action, Location, Camera,
     Movement, Transition, Characters, Outfits, Wardrobe, State, Blocking, Pose, Frame, Visible,
     Contact, Out of frame, Duration and the Sex act: / Sex position: lines when present; NOT the keyframe-only Workflow: / Refs: / Prompt: lines>
  frame_edits: <the frame's published `edits`, verbatim; "none" when it has none>
  action: <the shot's Action>
  beat: |
    <this shot's row of the scene_list Beats table, verbatim, every column; omit the line when the scene list has no matching beat>
  prior_shot_facts: |
    <continue only: the PREVIOUS shot's Action:, Wardrobe: and State: lines from its shotlist block, verbatim>
  camera: <the shot's Camera - keyframe framing>
  movement: <the shot's Movement VERBATIM; "none" when neither the shot nor its beat has one>
  duration_seconds: <planned duration>
  start_frame: artifact://<storyboard id>/frame_<M>.<ext>   (exactly this storyboard artifact and frame file)
  prior_clip: scene<N>_clip<M-1>     (continue only: the KEY of clip M-1's output artifact; the clip worker resolves it to the real video file at run time - never type an artifact id or file here)
  references: <ONLY what Step 1b allows - usually none: then omit this line. Each entry
              artifact://<design id>/full_body_shot.<ext> (or a chosen view_<id>.<ext>), one per person
              whose face turns / comes closer / who enters, the location view only for a revealing camera
              move; never the POV owner, a limbs person, a sheet, or an outfit the shot does not wear>
  style: <the workspace medium/style line, verbatim>
  negative_prompt: <text>
  loras: <the shot's `LoRAs:` line verbatim, in rank order; "none" when the shot has none - the clip worker keeps the video family and ranks for motion ("Curated LoRAs", Video clips)>
  preferred_workflow: "<wf_ tool name for this mode>"   (a preference; the worker may pick another i2v / i2va by capability, never a text-to-video one)

  Output files (canonical — do not rename):
    scene<N>_clip<M>_<slug>.mp4
    scene<N>_clip<M>_<slug>_prompt.txt
```

- The template is VERBATIM: fill `<...>` slots from the named sources, copy every other line and every verbatim slot word for word (`Sex act:` / `Sex position:` included in a nudity-allowed workspace); never paraphrase or drop a policy-conditional line (a paraphrase would hide rules from the worker).
- The prompt MUST open with the exact line `Load and use skill: shoot-clip` (it lets the worker `load_skill`).
- `preferred_workflow` comes from the workspace's `wf_` list for the clip's mode (never from memory): the continuation workflow for `continue`, the i2v / i2va one for `cut` / start.

### 4a-2. Bundle clip task

Same id / artifact / file names and `output_files` as 4a (the bundle is clip M); no `requires_*`; `can_create_tasks` NOT set; title "Shoot <Scene Name> – clip <M> (shots <first>-<last>)". Prompt:

```
  Load and use skill: shoot-clip

  scene: "<Scene Name>"  (scene <N>)
  clip: <M> of <total>  — bundle <bundleId>, shots <shotId>, <shotId>[, ...]
  mode: bundle
  storyboard: <the storyboard key, for the worker's own `clip_plan` call>
  duration_seconds: <the bundle's durationSeconds>
  bundle_brief: |
    <the bundle's brief block from `clip_plan`, VERBATIM, every line from `clip_plan:` through the shot blocks; it carries `bundle_ref:`, `picture_map:`, `continuity_constraints:`, the scene audio>
  style: <the workspace medium/style line, verbatim>
  negative_prompt: <as 4a>

  Output files (canonical — do not rename):
    scene<N>_clip<M>_<slug>.mp4
    scene<N>_clip<M>_<slug>_prompt.txt
```

No `start_frame`, `references`, guide frames, cut times or `loras`: `shoot_bundle` fills every mechanical port from the plan. The single-clip fallback blocks are NOT copied here: the worker reads them from `clip_plan` itself, if ever needed. The verbatim rule of 4a applies to `bundle_brief`.

### 4b. Assembly task

```
id:                   assemble_scene<N>
title:                "Assemble <Scene Name>"
description:          one line
agent:                same agent as the clips
requires_tasks:       ["shoot_scene<N>_clip1", …, "shoot_scene<N>_clip<last>"]
requires_artifacts:   ["scene<N>_clip1", …, "scene<N>_clip<last>"]
output_artifact_name: scene<N>_assembly
output_artifact_description: "<Scene Name> assembled"
output_files:         ["scene<N>_assembled.mp4"]
prompt:

  Load and use skill: assemble-scene

  scene: "<Scene Name>"  (scene <N>)
  clips (in order, concatenate back to back):
    1. artifact://<id of scene<N>_clip1>/scene<N>_clip1_<slug>.mp4   — <duration>s
    2. …   (clips in PLAN order; a bundle clip is already cut internally and is listed once, with the bundle's duration)
  Output file (canonical — do not rename): scene<N>_assembled.mp4
```

Use the identifiers the `create_task` results reported; already-existing clip tasks are listed the same way.

### 4c. Reconcile

Schedule EVERY clip of EVERY requested scene plus each scene's `assemble_scene<N>` in this one run, however many calls that takes (one per round): there is no later turn, and a reply without tool calls ends the run — never end with "continuing to schedule the remaining clips…" or any promise of more work; keep calling `create_task` until the plan is complete, then write Step 5. Creating many tasks in one turn can end early (a timed-out or cut-off turn leaves the tail uncreated): after the last call, `task_index` vs the Step 3b plan: every planned clip key and `assemble_scene<N>` must exist. Create each missing one (one per round), re-check. Only what still fails goes into the reply, with the error.

## Step 5 — Reply

1-3 short lines ("Concise replies and task/artifact URIs" in `workflow-calling-conventions`): no file names, durations, workflow / skill names; tasks as `task://<runtime id>` from the results; never claim a task neither `create_task` nor `task_index` confirmed.

> Scheduled Scene <N>: <total> clips (task://<clip1>, task://<clip2>, ...) + assembly task://<assemble>. Cut clips render in parallel; continuations follow their predecessor.
> Already scheduled (skipped): task://<id>, ... — only if any.
> Not created: <clip/assembly>: <error> — only if any still failed after 4c.

## Rules

- Resolve scene and workflow before reading artifacts.
- Dependencies: `continue` clip requires its predecessor's task AND artifact (a bundle counts as the predecessor of the shot after it); `cut` and bundle clips none; assembly requires ALL clip tasks and artifacts of ITS scene.
- Canonical names from Step 3b are embedded in each prompt and `output_files`; the prompt's "Output files" list must match `output_files` exactly (a mismatch makes the build reject).
- Clip tasks never get `can_create_tasks`.
