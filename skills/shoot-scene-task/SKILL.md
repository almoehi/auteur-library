---
name: shoot-scene-task
description: >
  Trigger when the user wants to shoot, film, or render a named scene into video clips —
  e.g. "shoot scene 2", "let's film scene 1", "create a task to shoot the hotel lobby scene".
  Validates prerequisites, reads the scene's finished storyboard design (shot list + keyframes),
  and schedules ONE task per clip (one clip per shot) plus one assembly task that joins the
  clips into the scene video. Also handles direct assembly requests — "assemble scene 3",
  "stitch the clips of scene 2", "render the final cut of scene 1" — by (re)creating only the
  missing `assemble_scene<N>` task (see "Assembly-only requests").
  Do NOT invoke for storyboard design or keyframe rendering (storyboard-scene), prompt writing,
  rendering a single clip yourself (worker skill shoot-clip), or any task that does not result
  in producing final video clips for a named scene.
agentType: workspace
---

# Shoot Scene

## When this skill applies

Use this skill when the user expresses intent to film or shoot a named scene:

> "let's shoot scene 2"
> "create a task to shoot scene 1"
> "shoot scene X using the I2V workflow"
> "start filming the hotel lobby scene"
> "schedule scene 3 for shooting"

This skill runs in the workspace coordinator. It validates prerequisites, reads the scene's
storyboard design, plans one clip per shot, and schedules **one task per clip** (worker skill
`shoot-clip`) plus **one assembly task** (worker skill `assemble-scene`). Per-clip tasks render
in parallel where the story allows, can be retried, reviewed and checked individually, and keep
every worker's context small.

---

## Assembly-only requests

"Assemble scene N", "stitch the clips of scene N", "render the final cut of scene N" (the former
`scene-assembler` intents) are this skill too: the worker skill `assemble-scene` runs only as the
task `assemble_scene<N>` created here. Handle them as follows:

- Resolve the scene (Step 0; no video workflow is needed). Run Step 1c's `task_index` check.
- Clip tasks `shoot_scene<N>_clip<M>` missing -> the scene was never shot: say so and offer the
  full shoot (Steps 1-5) instead; never assemble a subset.
- `assemble_scene<N>` exists and is live -> tell the user, create nothing. Failed or cancelled ->
  create it again (Step 4b only), listing every clip's artifact as in 4b.
- Otherwise create just the Step 4b task and confirm with a one-line Step 5 reply.

---

## Step 0 — Resolve intent

Before reading any artifact, resolve two things from the user's message:

| Required | How to resolve |
|---|---|
| Scene identifier | Explicitly stated ("Scene 2", "s2", "the rain scene") |
| Video workflow | Named in the message, OR inferred from the available `wf_` tools by capability: workflow type i2v / flf2v / ref2v / t2v / video-continuation read from the tool description (never by name from memory) |

If the scene is ambiguous, ask before proceeding:
> "Which scene should I shoot? Available scenes: [read scene_list artifact and list them]"

If no video workflow is named and more than one is available, ask which to use. If none exists, tell the user and stop. Note two preferences, both taken from the `wf_` tool list: the workflow for fresh starts (`cut` clips: i2v / flf2v, else t2v) and, when one exists, the video-continuation workflow (a workflow with a video input for the prior clip) for `continue` clips. Without a continuation workflow every boundary is a `cut`.

Do not read any artifact or create any task until both are resolved.

---

## Step 1 — Preflight

### 1a. The storyboard design

Call `artifact_index`. The source is the finished storyboard design of the scene:

| Artifact | Requirement |
|---|---|
| `storyboard_scene_<n>` (the key may carry a suffix; match the scene number) | approved; files `shotlist.md` and `frame_1.<ext>` … `frame_N.<ext>` |

Frame i is the start frame of shot i; N frames must equal the shot count of the shotlist — if not,
tell the user and stop. There is no fallback source (without storyboard keyframes there is no
per-clip start frame to plan from). If no storyboard design exists for the scene:

> "Cannot shoot <scene>: it has no storyboard design yet. Create and finish it in the design
> studio (Pre-production -> Storyboards) and ask me again."

If it exists but is not approved:

> "Cannot shoot <scene>: the storyboard design `<key>` is not finished yet. Finish it in the
> design studio (Pre-production -> Storyboards) and ask me again."

### 1b. Design sheets (references)

Find the scene's design sheets: the published primaries of the location design and of the outfit
designs used in the scene. Take the scene's row from the `scene_list` artifact (`location_slug`,
`Outfits` as `<character>:<look>`) and look the keys up in `artifact_index` (`location_<slug>`,
`outfit_<character>_<look>`; tolerate a suffix). A pair with no outfit design is the character's
base look (`base_look` in `design_plan.json`, when available): the character design's primary
(`character_<character>`) is its reference, and that is not a missing sheet. The reference is
`artifact://<artifact id>/primary.<ext>` (read the artifact to get the file name). Missing sheets
are not fatal: note them and continue without that reference. List them per clip, location first,
then that shot's outfits ("Anchor (Picture 1) by intent" of `workflow-calling-conventions`,
compose intent).

### 1c. Idempotency check

Call `task_index`. The keys that matter are `shoot_scene<N>_clip<M>` (per clip) and
`assemble_scene<N>`. A clip or assembly task that already exists and is not failed or cancelled is
SKIPPED (never duplicate it, never change it). Plan and create only the missing ones; if every
key exists and is live, tell the user and stop:

> "Scene <N> is already scheduled (clips <list> + assembly). No new tasks created.
> To re-shoot a clip, cancel its task first."

---

## Step 2 — Discovery

Process one artifact at a time.

### 2a. Read the shotlist

`read_artifact(artifactId="storyboard_scene_<n>", artifact_file="shotlist.md")` — pass the key
directly, not the UUID. Sections are `## <shotId> — <title>` with lines `Action:`, `Camera:`,
`Movement:`, `Characters:`, `Outfits:`, `Duration:` (seconds).

Extract for every shot: shot ID and title, `Action`, `Camera` (keyframe framing), `Movement` (the
camera move of the VIDEO; absent in older storyboards), `Duration`, characters and outfits. When a
shot has no `Movement:`, take it from the matching beat in the `Beats` section of the
`scene_list` artifact (read it once; the scene's `### Scene <n>` table: beat, action, framing,
camera move); no beat either: derive it from the action and say so. Never turn a missing
movement into "static".

### 2b. Character context (optional)

If a `character_table` artifact exists and is approved, read the `character_<slug>.md` files of
the characters present; they improve motion prompt quality. Do not require any other
pre-production artifact.

Carry the workspace's stated medium/style (from `{workspace.story.plot}`, see "Medium / style is
kept" in `workflow-calling-conventions`) verbatim into every clip task as a `style:` line. Take
the negative prompt text from the scene's art direction / the workflow's recommended negative
(via `get_workflow_instructions` of the preferred workflow) and embed it as `negative_prompt:`
in every clip task; leave the line out when the workflow has no negative prompt port.

---

## Step 3 — Planning

### 3a. One clip per shot

Clip M = shot M, start frame = `frame_M`; the shot's `Duration` is the clip's planned duration in
seconds (the authoritative `duration_seconds`; round to whole seconds, at least 1).

**Decide every boundary: CONTINUE or CUT.** For each pair of neighbouring clips (shot M-1 -> M)
decide from the shotlist and decide ONCE, here:

- **CONTINUE** - same setup (same location, subjects and framing), the action carries on, the
  camera move continues or holds. Example: same framing, Brianna wakes -> Brianna sits up.
  Clip M is rendered with the video-continuation workflow from clip M-1's real file; its prompt
  contains NO cut. It cannot start before clip M-1 is approved.
- **CUT** - new framing, new subject or an insert. Example: princess -> pudding insert ->
  Brianna's grin. Clip M starts fresh with the image-to-video (or text-to-video) workflow from its
  storyboard frame. A cut is never faked through the continuation workflow. A cut clip has no
  clip dependency and renders in parallel with the others.

The first clip is always a fresh start (`start`, treated as a cut). Record per boundary
`continue`/`cut` and a one-line reason in the plan.

### 3b. Canonical names (decided once, never renamed)

Per clip M of scene N (slug = 2–3 word kebab-case label from the shot, e.g. `lobby-entrance`):

| What | Name |
|---|---|
| task id | `shoot_scene<N>_clip<M>` |
| output artifact key | `scene<N>_clip<M>` |
| video file | `scene<N>_clip<M>_<slug>.mp4` |
| prompt file | `scene<N>_clip<M>_<slug>_prompt.txt` |

Assembly: task id `assemble_scene<N>`, artifact key `scene<N>_assembly`, file
`scene<N>_assembled.mp4`.

**Write out the full plan before creating anything:**

| Clip | Shot | Boundary | Reason | Duration | Movement | Task / artifact | Video file |
|---|---|---|---|---|---|---|---|
| 1 | s2-01 | start | – | 5 | slow push-in | `shoot_scene2_clip1` / `scene2_clip1` | `scene2_clip1_lobby-entrance.mp4` |
| 2 | s2-02 | continue | same framing, action carries on | 5 | hold | `shoot_scene2_clip2` / `scene2_clip2` | `scene2_clip2_staircase-descent.mp4` |
| … | | | | | | | |

---

## Step 4 — Create the tasks

One `create_task` call per task, **sequentially, one per round** (a later task's `requires_*` names
an earlier task's artifact; use the key/id the result reports, never an assumed one). Order: clips
1..N, then the assembly. Skip those the idempotency check found live. Each call creates the task
AND its output artifact inline (`output_artifact_name` + `output_files`); never create the artifact
separately.

### 4a. Clip task (`shoot-clip`)

```
id:                   shoot_scene<N>_clip<M>
title:                "Shoot <Scene Name> – clip <M> (<shot title>)"
description:          one line: what the clip shows
agent:                <an agent from available_agents that has the wf_* workflow tools and the
                       sandbox — in the default workspace `generic`; never one that is not listed>
requires_artifacts:   ["scene<N>_clip<M-1>"]   — ONLY for a `continue` clip; omit for start / cut
output_artifact_name: scene<N>_clip<M>
output_artifact_description: "<Scene Name> clip <M>"
output_files:         ["scene<N>_clip<M>_<slug>.mp4", "scene<N>_clip<M>_<slug>_prompt.txt"]
prompt:

  Load and use skill: shoot-clip

  scene: "<Scene Name>"  (scene <N>)
  clip: <M> of <total>  — shot <shotId> "<title>"
  mode: continue | cut   (<one-line reason>)
  action: <the shot's Action>
  camera: <the shot's Camera - keyframe framing>
  movement: <the shot's Movement VERBATIM>
  duration_seconds: <planned duration>
  start_frame: artifact://<storyboard id>/frame_<M>.<ext>
  prior_clip: artifact://<scene<N>_clip<M-1> id>/<its video file>     (continue only)
  references: artifact://<location id>/primary.<ext>, artifact://<outfit id>/primary.<ext>, …
              (omit the line when none were found)
  style: <the workspace medium/style line, verbatim>
  negative_prompt: <text>
  preferred_workflow: "<wf_ tool name for this mode>"   (a preference; the worker may pick another by capability)

  Output files (canonical — do not rename):
    scene<N>_clip<M>_<slug>.mp4
    scene<N>_clip<M>_<slug>_prompt.txt
```

The task `prompt` MUST open with the exact line `Load and use skill: shoot-clip` — the worker
relies on it to `load_skill()` before doing anything else. Name the preferred workflow from the
workspace's `wf_` tool list for the clip's mode (never from memory): the continuation workflow
for `continue`, the i2v / flf2v (else t2v) one for `cut` / start.

### 4b. Assembly task (`assemble-scene`)

```
id:                   assemble_scene<N>
title:                "Assemble <Scene Name>"
description:          one line
agent:                same agent as the clips (needs the sandbox)
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

Use the task/artifact identifiers each earlier `create_task` result reported. If some clip tasks
already existed (idempotency), their artifacts are listed the same way.

---

## Step 5 — Confirm to user

After the last `create_task` succeeds, reply in 1-3 short lines (see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`): no file names, durations, workflow or skill names, slot counts or sources. Refer to the tasks by `task://<runtime id>` as the `create_task` results reported them.

> "Scheduled Scene <N>: <total> clips (task://<clip1>, task://<clip2>, ...) + assembly task://<assemble>. Cut clips render in parallel; continuations follow their predecessor."
> "Already scheduled (skipped): task://<id>, ..." - only if any.

---

## Key rules

1. **Resolve intent before reading artifacts** — never start a discovery pass until scene and workflow are unambiguous.
2. **Storyboard design only** — the finished `storyboard_scene_<n>` is the source; bail on a missing or unapproved one. No partial scheduling. No other pre-production artifact (cast, visual bible, art direction) is required.
3. **One task per clip, one assembly task** — never one task for several clips.
4. **Dependencies** — `continue` clip: `requires_artifacts: [scene<N>_clip<M-1>]` (starts once the predecessor is approved and reads its real file); `cut` clip: no clip dependency; assembly: all clip tasks and artifacts.
5. **Idempotency** — skip every clip / assembly task whose key already exists and is live; never duplicate.
6. **Canonical names are set in Step 3b** — derive them once, embed them in each task prompt and `output_files`; filenames in the prompt's "Output files" list must match `output_files` exactly (a mismatch makes the task build reject).
7. **Each `create_task` carries its output artifact inline**, issued one per round using the identifiers the previous result reported.
