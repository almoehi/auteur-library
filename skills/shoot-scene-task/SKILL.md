---
name: shoot-scene-task
description: >
  Trigger when the user wants to shoot, film, or render a named scene into video clips —
  e.g. "shoot scene 2", "let's film scene 1", "create a task to shoot the hotel lobby scene",
  "plan and shoot artifact://<storyboard>", "shoot storyboard_scene_3", "shoot @scene_3",
  "shoot scenes 1 and 4" (several scenes or storyboards in one request).
  Validates prerequisites, reads each scene's finished storyboard design (shot list + keyframes),
  and schedules ONE task per clip (one clip per shot) plus one assembly task PER scene that joins
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

Coordinator skill: validates prerequisites, reads the scene's storyboard design, plans one clip per shot and creates ONE task per clip (worker skill `shoot-clip`) plus ONE assembly task (worker skill `assemble-scene`). Never let a worker render several clips.

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

### 1b. Reference designs

- Per shot, bind the designs its shotlist block names by KEY (`Location:`, `Characters:`, `Outfits:` = `<characterKey>:<outfitKey>`; the `Outfits:` line is per shot, never apply one scene-level look) via `artifact_index`. Older shotlists with slugs: map via the `scene_list` row (`location_slug`, beat `Location` slugs, per-BEAT `Outfits` `<character>:<look>`; slugs = character-table file stems) to `location_<slug>`, `outfit_<character>_<look>`, `character_<character>` (suffix tolerated).
- Image per design: the published `sheet.<ext>` first; a design without a sheet gives `full_body_shot.<ext>` (`primary.<ext>` in older designs).
- `<c>:nude` / `<c>:none` -> the character design. Any other look -> its outfit design (key from `design_plan.json` `outfits[]` by character_slug + look_slug when present, else the pattern above). A look without an outfit design -> the character design plus the garments described in the prompt; note the gap.
- Reference = `artifact://<artifact id>/<file>` (real file name from the artifact). Missing designs are not fatal: note and continue without.
- Per clip order: location, that shot's outfits (character design for `:nude` / `:none`), further character sheets ("Anchor (Picture 1) by intent", compose intent, in `workflow-calling-conventions`). The clip's own frame is the `start_frame`, never a reference.

### 1c. Idempotency

`task_index`: a `shoot_scene<N>_clip<M>` or `assemble_scene<N>` task that exists and is not failed / cancelled is SKIPPED (never duplicated or changed). Create only the missing ones. Everything live: "Scene <N> is already scheduled (clips <list> + assembly). No new tasks created. To re-shoot a clip, cancel its task first."

## Step 2 — Discovery (one artifact at a time)

### 2a. Shotlist

`read_artifact(artifactId="storyboard_scene_<n>", artifact_file="shotlist.md")` (pass the key, not the UUID). Sections `## <shotId> — <title>` with lines `Action:`, `Camera:`, `Movement:`, `Characters:`, `Outfits:`, `Duration:` (seconds), `Transition:` (`continue — <reason>` | `cut — <reason>`; absent in older storyboards); designs are KEYS.

- Keep each shot's complete block (heading + every line to the next heading) VERBATIM for the clip task: includes `Blocking:`, `Pose:`, `Frame:`, `Visible:`, `POV:` and, in a `contentPolicy.nudity: allowed` workspace, `Sex act:` / `Sex position:`.
- Extract per shot: id, title, `Action`, `Camera` (keyframe framing), `Movement` (video camera move), `Duration`, `Transition`, characters / outfits keys.
- No `Movement:`: take it from the matching beat's `Camera move` in the `scene_list` artifact (`### Scene <n>` Beats table, read once); no beat either: derive it from the action and say so. Never turn a missing movement into "static".

### 2a-2. Frame edits

The storyboard design's `design.json` `published.outputs[]` entry of each `frame_<i>` file may carry `edits` (strings, oldest first; absent / empty = none). Pass them verbatim per clip (`frame_edits:`); a clip never brings back what an edit removed.

### 2b. Context

- If an approved `character_table` exists, read the `character_<slug>.md` of characters present (better motion prompts); require no other pre-production artifact.
- `style:` line in EVERY clip task: the workspace medium / style from `{workspace.story.plot}` verbatim ("Medium / style is kept" in `workflow-calling-conventions`).
- `negative_prompt:` in every clip task: from the scene's art direction / the workflow's recommended negative (`get_workflow_instructions` of the preferred workflow); omit the line when the workflow has no negative port.

## Step 3 — Planning

### 3a. One clip per shot

Clip M = shot M; start frame `frame_M`; `duration_seconds` = the shot's `Duration` (whole seconds, at least 1). The first clip is a fresh start (treated as a cut).

Every boundary (shot M-1 -> M) is `continue` or `cut`:
1. Take the shot's `Transition:` as given, with its reason; do not second-guess.
2. No `Transition:` (older storyboard): decide ONCE here and note "decided here". CONTINUE when the action carries straight on in the same setup (same place, moment, people), even when the framing changes; CUT for a new moment, place or subject, or an insert.
3. No video-continuation workflow -> every boundary is a CUT.

- `continue`: rendered with the continuation workflow from clip M-1's real file; keeps `requires_tasks` / `requires_artifacts` on the predecessor (it cannot start before clip M-1 is approved). Mechanics (framing change, start offset, no hard cut): `shoot-clip` mode `continue`.
- `cut`: i2v / i2va from `frame_M` as first frame plus the Step 1b references; no clip dependency (renders in parallel); never faked through the continuation workflow, never text-to-video.

### 3b. Canonical names (set once, never renamed)

Per clip M of scene N (slug = 2-3 word kebab-case label from the shot, e.g. `lobby-entrance`):

| What | Name |
|---|---|
| task id | `shoot_scene<N>_clip<M>` |
| output artifact key | `scene<N>_clip<M>` |
| video file | `scene<N>_clip<M>_<slug>.mp4` |
| prompt file | `scene<N>_clip<M>_<slug>_prompt.txt` |
| assembly | task `assemble_scene<N>`, artifact `scene<N>_assembly`, file `scene<N>_assembled.mp4` |

Write out the FULL plan before creating anything (all clip keys + `assemble_scene<N>`; Step 4c reconciles against it), one row per clip: clip, shot, boundary (`start` | `continue` | `cut`, from storyboard or decided here), reason, duration, movement, task / artifact, video file.

## Step 4 — Create the tasks

ONE `create_task` per task, sequentially, one per round (later `requires_*` use the keys / ids the results report, never assumed). Order: clips 1..N, then assembly. Skip live ones. Each call creates its output artifact inline (`output_artifact_name` + `output_files`); no separate artifact call.

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
  framing_change: yes | no   (continue only; yes when this shot's Camera differs from the previous shot's: "previous: <its Camera>")
  shot_block: |
    <the shot's FULL block from shotlist.md, verbatim, every line: Action, Location, Camera,
     Movement, Transition, Characters, Outfits, Blocking, Pose, Frame, Visible, Duration and the
     Sex act: / Sex position: lines when present>
  frame_edits: <the frame's published `edits`, verbatim; "none" when it has none>
  action: <the shot's Action>
  camera: <the shot's Camera - keyframe framing>
  movement: <the shot's Movement VERBATIM>
  duration_seconds: <planned duration>
  start_frame: artifact://<storyboard id>/frame_<M>.<ext>   (exactly this storyboard artifact and frame file)
  prior_clip: artifact://<scene<N>_clip<M-1> id>/<its video file>     (continue only)
  references: artifact://<location id>/sheet.<ext>, artifact://<outfit id>/sheet.<ext>,
              artifact://<character id>/sheet.<ext>, …   (sheet first; `full_body_shot.<ext>` for a design
              without a sheet; omit the line when none were found)
  style: <the workspace medium/style line, verbatim>
  negative_prompt: <text>
  preferred_workflow: "<wf_ tool name for this mode>"   (a preference; the worker may pick another i2v / i2va by capability, never a text-to-video one)

  Output files (canonical — do not rename):
    scene<N>_clip<M>_<slug>.mp4
    scene<N>_clip<M>_<slug>_prompt.txt
```

- The template is VERBATIM: fill `<...>` slots from the named sources, copy every other line and every verbatim slot word for word (`Sex act:` / `Sex position:` included in a nudity-allowed workspace); never paraphrase or drop a policy-conditional line.
- The prompt MUST open with the exact line `Load and use skill: shoot-clip`.
- `preferred_workflow` comes from the workspace's `wf_` list for the clip's mode (never from memory): the continuation workflow for `continue`, the i2v / i2va one for `cut` / start.

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
    2. …
  Output file (canonical — do not rename): scene<N>_assembled.mp4
```

Use the identifiers the `create_task` results reported; already-existing clip tasks are listed the same way.

### 4c. Reconcile

After the last call, `task_index` vs the Step 3b plan: every planned clip key and `assemble_scene<N>` must exist. Create each missing one (one per round), re-check. Only what still fails goes into the reply, with the error.

## Step 5 — Reply

1-3 short lines ("Concise replies and task/artifact URIs" in `workflow-calling-conventions`): no file names, durations, workflow / skill names; tasks as `task://<runtime id>` from the results; never claim a task neither `create_task` nor `task_index` confirmed.

> Scheduled Scene <N>: <total> clips (task://<clip1>, task://<clip2>, ...) + assembly task://<assemble>. Cut clips render in parallel; continuations follow their predecessor.
> Already scheduled (skipped): task://<id>, ... — only if any.
> Not created: <clip/assembly>: <error> — only if any still failed after 4c.

## Rules

- Resolve scene and workflow before reading artifacts.
- Dependencies: `continue` clip requires its predecessor's task AND artifact; `cut` none; assembly requires ALL clip tasks and artifacts of ITS scene.
- Canonical names from Step 3b are embedded in each prompt and `output_files`; the prompt's "Output files" list must match `output_files` exactly (a mismatch makes the build reject).
- Clip tasks never get `can_create_tasks`.
