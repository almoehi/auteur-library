---
name: shoot-scene-task
description: >
  Trigger when the user wants to shoot, film, or render a named scene into video clips —
  e.g. "shoot scene 2", "let's film scene 1", "create a task to shoot the hotel lobby scene".
  This skill validates prerequisites, determines the clip structure from the scene's finished
  storyboard design (shot list + keyframes; older shotlist + storyboard artifacts as fallback),
  and schedules the worker task that renders the video clips.
  Do NOT invoke for storyboard design or keyframe rendering (storyboard-scene), prompt writing,
  or any task that does not result in producing final video clips for a named scene.
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
| Video workflow | Named in the message, OR inferred from the available `wf_` tools by capability: workflow type i2v / flf2v / ref2v / t2v read from the tool description (never by name from memory) |

If the scene is ambiguous, ask before proceeding:
> "Which scene should I shoot? Available scenes: [read scene_list artifact and list them]"

If no video workflow is named and more than one is available, ask which to use. If none exists, tell the user and stop.

Do not read any artifact or create any task until both are resolved.

---

## Step 1 — Preflight

### 1a. Look for the scene's storyboard design FIRST

Call `artifact_index`. The preferred source is the finished storyboard design of the scene:

| Artifact | Requirement |
|---|---|
| `storyboard_scene_<n>` (the key may carry a suffix; match the scene number) | approved; files `shotlist.md` and `frame_1.<ext>` … `frame_N.<ext>` |

If it exists and is approved with a `shotlist.md` and at least one `frame_*` file: use the
**storyboard path** (frame i = start frame of shot i; N frames must equal the shot count of
the shotlist — if not, tell the user and stop). If the storyboard design exists but is not
approved (not finished), tell the user and stop:

> "Cannot shoot <scene>: the storyboard design `<key>` is not finished yet. Finish it in the
> design studio (Pre-production -> Storyboards) and ask me again."

**Fallback path** — only when NO storyboard design exists for the scene: you need two approved
artifacts: the textual shot list (key contains `shotlist` and the scene identifier) and the
rendered visual shots (key contains `visual_shots`, `rendered_shots` or `storyboard` and the
scene identifier). If either is missing or not approved, tell the user and stop:

> "Cannot shoot <scene>: **<artifact type>** is not yet approved.
> Once `<key>` is approved, ask me to shoot <scene> again."

### 1b. Design sheets (references)

For the storyboard path also find the scene's design sheets: the published primaries of the
location design and of the outfit designs used in the scene. Take the scene's row from the
`scene_list` artifact (`location_slug`, `Outfits` as `<character>:<look>`) and look the keys up in
`artifact_index` (`location_<slug>`, `outfit_<character>_<look>`; tolerate a suffix). The
reference is `artifact://<artifact id>/primary.<ext>` (read the artifact to get the file name).
Missing sheets are not fatal: note them and continue without that reference.

### 1c. Idempotency check

Call `task_index`. If a task titled "Shoot <scene name>" already exists and is not in a
failed or cancelled state, inform the user and stop:

> "A shoot task for <scene> already exists (status: <status>). No new task created.
> If you want to re-shoot, cancel the existing task first."

---

## Step 2 — Discovery

Process one artifact at a time.

### 2a. Read the shotlist

Storyboard path: `read_artifact(artifactId="storyboard_scene_<n>", artifact_file="shotlist.md")`; fallback path: `read_artifact(artifactId="<shotlist key>")`. Pass the key directly, not the UUID. Storyboard shot lists are sections `## <shotId> — <title>` with lines `Action:`, `Camera:`, `Characters:`, `Outfits:`, `Duration:` (seconds).

Extract for every shot: shot ID, description (action, location, mood), camera notes
(angle, lens, movement), characters present.

### 2b. Read the visual shots

Storyboard path: `frame_<i>.<ext>` is the start frame of shot i (shotlist order); nothing else
to read. Fallback path: `read_artifact(artifactId="<visual-shots key>")` and note how many
storyboard images each shot has.

### 2c. Character context (optional)

If a `character_table` artifact exists and is approved, read the `character_<slug>.md` files
of the characters present; they improve motion prompt quality. Do not require any other
pre-production artifact.

---

## Step 3 — Planning

### 3a. Group shots into clips

**Storyboard path:** one clip per shot (clip i = shot i, start frame = `frame_i`; the shot's
`Duration` guides the clip length). Skip the table below.

**Fallback path:** classify each shot by storyboard image count:

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
- storyboard path: `<clip-stem>_prompt.txt` — the video prompt of the clip
- fallback path: `<clip-stem>_prompt_seg1.txt` (start → mid) and `<clip-stem>_prompt_seg2.txt` (mid → end)
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
agent:       <an agent from available_agents that has the wf_* workflow tools and the
              sandbox — in the default workspace `generic`; never an agent that is not listed>
description:

  Load and use skill: shoot-single-scene

  scene_name: "<Scene Name>"
  workflow: "<video wf_ tool name>"   (a preference; the worker may pick another by capability)
  source: storyboard `storyboard_scene_<n>` (shotlist.md; frame_i = start frame of shot i)
          — or, fallback path: shotlist artifact `<key>` + visual shots artifact `<key>`
  references: artifact://<location id>/primary.<ext>, artifact://<outfit id>/primary.<ext>, …
              (the scene's design sheets; omit the line when none were found)

  Clips to render — canonical filenames (worker must use these exactly):
    scene<N>_clip1_<slug>.mp4    — <shot IDs, clip type: action breakdown / single cut>
    scene<N>_clip2_<slug>.mp4    — <shot IDs, clip type>
    …

  Prompt files:
    scene<N>_clip1_<slug>_prompt.txt            (storyboard path)
    scene<N>_clip1_<slug>_prompt_seg1.txt / _seg2.txt   (fallback path; one pair per clip)
    …
    prompt_neg.txt  (shared negative prompt — one for the whole scene)

  These filenames are canonical. Do not rename clips at any point during execution.
```

Include enough context for the worker to connect each filename to the right shots
(shot IDs and clip type). The worker reads the shot list and the frames / visual-shots artifact
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
> — Source: <storyboard `<key>` (frame i = start frame of shot i) | shotlist + visual shots (fallback)>
> — Worker skill: `shoot-single-scene` · preferred workflow: `<workflow name>`
> — <fallback path only: M single-cut clip(s) will need T2I keyframe generation before rendering>
> — Output artifact: `scene<N>_shooting` (<total file count> declared slots)"

---

## Key rules

1. **Resolve intent before reading artifacts** — never start a discovery pass until scene and workflow are unambiguous.
2. **Storyboard design first** — use the finished `storyboard_scene_<n>` when it exists; fall back to the shotlist + visual-shots pair only when no storyboard design exists. Bail on missing or unapproved prerequisites; do not create a partial task. No other pre-production artifact (cast, visual bible, art direction) is required.
3. **Idempotency** — if a Shoot task for this scene already exists and is live, do not create another.
4. **Canonical filenames are set in Step 3** — derive them once, embed them in the task description and artifact files list. The worker locks onto these; renaming causes slot mismatch and completion rejection.
5. **Filenames must match exactly** — Before calling `create_task`, confirm that every filename in the task description's "Clips to render" list appears verbatim in the `files` list passed to `create_artifact`, and vice versa. Any mismatch causes `buildArtifacts` to reject the task — fix it before creating the task, not after.
6. **create_artifact immediately follows create_task** — do not read the next scene or do anything else between the two calls.
7. **Fallback single-cut clips need T2I** — declare their `.mp4` slot normally; the `shoot-single-scene` worker skill handles keyframe generation automatically.
