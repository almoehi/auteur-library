---
name: shoot-scene-task
description: >
  Trigger when the user wants to shoot, film, or render a named scene into video clips —
  e.g. "shoot scene 2", "let's film scene 1", "create a task to shoot the hotel lobby scene".
  This skill validates prerequisites, determines the clip structure from the shotlist and
  storyboard images, and schedules the worker task that executes the I2V rendering.
  Do NOT invoke for storyboard rendering, prompt writing, or any task that does not
  result in producing final video clips for a named scene.
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

This skill runs in the workspace coordinator. It validates prerequisites, reads the scene
artifacts, groups shots into clips, assigns canonical filenames, and schedules the worker
task that executes the actual rendering. The worker uses the `shoot-single-scene` skill.

---

## Step 0 — Resolve intent

Before reading any artifact, resolve two things from the user's message:

| Required | How to resolve |
|---|---|
| Scene identifier | Explicitly stated ("Scene 2", "s2", "the rain scene") |
| I2V workflow | Named in the message, OR infer from available `wf_` tools whose description mentions video or i2v |

If the scene is ambiguous, ask before proceeding:
> "Which scene should I shoot? Available scenes: [read scene_list artifact and list them]"

If no I2V workflow is named and more than one video workflow is available, ask which to use.

Do not read any artifact or create any task until both are resolved.

---

## Step 1 — Preflight

### 1a. Check required artifacts

Call `artifact_index`. You need two approved artifacts for the target scene:

| Artifact | Key/name pattern |
|---|---|
| Textual shot list | contains `shotlist` and the scene identifier |
| Rendered visual shots | contains `visual_shots`, `rendered_shots`, or `storyboard` and the scene identifier |

If either is missing or not yet approved, tell the user and stop — do not create a task:

> "Cannot shoot <scene>: **<artifact type>** is not yet approved.
> Once `<key>` is approved, ask me to shoot <scene> again."

### 1b. Idempotency check

Call `task_index`. If a task titled "Shoot <scene name>" already exists and is not in a
failed or cancelled state, inform the user and stop:

> "A shoot task for <scene> already exists (status: <status>). No new task created.
> If you want to re-shoot, cancel the existing task first."

---

## Step 2 — Discovery

Process one artifact at a time.

### 2a. Read the shotlist

`read_artifact(artifactId="<shotlist key>")` — pass the key directly, not the UUID.

Extract for every shot: shot ID, description (action, location, mood), camera notes
(angle, lens, movement), characters present.

### 2b. Read the visual shots

`read_artifact(artifactId="<visual-shots key>")` — pass the key directly.

For each shot, note how many storyboard images exist.

### 2c. Read the cast list (if available)

If a `cast` artifact exists and is approved, read it. Character descriptions improve
keyframe generation and motion prompt quality.

---

## Step 3 — Planning

### 3a. Group shots into clips

Classify each shot by storyboard image count:

| Image count | Clip type | Frame strategy for worker |
|---|---|---|
| 3+ images | Action breakdown | First / middle / last storyboard image → start / mid / end frame (no T2I needed) |
| 1–2 images | Single cut | Available image → start frame; worker generates mid + end frame via T2I |

Count total clips. This is how many `.mp4` slots you must declare in the artifact.

### 3b. Assign canonical filenames

One canonical `.mp4` per clip:
```
scene<N>_clip<M>_<short-slug>.mp4
```
- `N` = scene number
- `M` = sequential clip index starting at 1
- `slug` = 2–3 word kebab-case label from the shot description
  (e.g. `lobby-entrance`, `staircase-descent`, `departure-aftermath`)

Derive prompt file names from the clip stem:
- `<clip-stem>_prompt_seg1.txt` — motion prompt for start → mid
- `<clip-stem>_prompt_seg2.txt` — motion prompt for mid → end
- `prompt_neg.txt` — one shared negative prompt for the whole scene (not per clip)

**Write out the full file plan before proceeding:**

| Clip | Shot(s) | Type | Canonical filename |
|---|---|---|---|
| 1 | s2-01 | Single cut | `scene2_clip1_lobby-entrance.mp4` |
| 2 | s2-02, s2-03, s2-04 | Action breakdown | `scene2_clip2_staircase-descent.mp4` |
| … | | | |

---

## Step 4 — Create task and artifact

### 4a. create_task

The task description MUST open with the exact line `Load and use skill: shoot-single-scene`
followed by the scene context block. Do not paraphrase or omit this line — the worker
relies on it to trigger a `load_skill()` call before doing any other work.

```
title:       "Shoot <Scene Name>"
agent:       renderer
description:

  Load and use skill: shoot-single-scene

  scene_name: "<Scene Name>"
  workflow: "<I2V workflow tool name>"

  Clips to render — canonical filenames (worker must use these exactly):
    scene<N>_clip1_<slug>.mp4    — <shot IDs, clip type: action breakdown / single cut>
    scene<N>_clip2_<slug>.mp4    — <shot IDs, clip type>
    …

  Prompt files:
    scene<N>_clip1_<slug>_prompt_seg1.txt
    scene<N>_clip1_<slug>_prompt_seg2.txt
    …
    prompt_neg.txt  (shared negative prompt — one for the whole scene)

  These filenames are canonical. Do not rename clips at any point during execution.
```

Include enough context for the worker to connect each filename to the right shots
(shot IDs and clip type). The worker reads the shot list and visual-shots artifacts
directly; you do not need to re-embed the full shot descriptions.

### 4b. create_artifact (immediately after create_task returns)

```
task_id: <id from 4a>
id:      scene<N>_shooting
name:    "<Scene Name> Shooting"
files:   [every .mp4 and every .txt from Step 3b — list individually, no omissions]
```

---

## Step 5 — Confirm to user

After `create_artifact` succeeds:

> "Scheduled: **Shoot <Scene Name>**
> — <N> clips: <list canonical .mp4 filenames>
> — Worker skill: `shoot-single-scene` · workflow: `<workflow name>`
> — <M> single-cut clip(s) will need T2I keyframe generation before rendering
> — Output artifact: `scene<N>_shooting` (<total file count> declared slots)"

---

## Key rules

1. **Resolve intent before reading artifacts** — never start a discovery pass until scene and workflow are unambiguous.
2. **Bail on missing prerequisites** — if the shotlist or visual-shots artifact is absent or unapproved, tell the user and stop. Do not create a partial task.
3. **Idempotency** — if a Shoot task for this scene already exists and is live, do not create another.
4. **Canonical filenames are set in Step 3** — derive them once, embed them in the task description and artifact files list. The worker locks onto these; renaming causes slot mismatch and completion rejection.
5. **create_artifact immediately follows create_task** — do not read the next scene or do anything else between the two calls.
6. **Single-cut clips need T2I** — declare their `.mp4` slot normally; the `shoot-single-scene` worker skill handles keyframe generation automatically.
