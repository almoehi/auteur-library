---
name: shoot-scene-task
description: >
  Trigger when the user wants to shoot, film, or render a named scene into video clips —
  e.g. "shoot scene 2", "let's film scene 1", "create a task to shoot the hotel lobby scene",
  "plan and shoot artifact://<storyboard>", "shoot storyboard_scene_3", "shoot @scene_3",
  "shoot scenes 1 and 4" (several scenes or storyboards in one request).
  Validates prerequisites, reads each scene's finished storyboard design and clip plan,
  and schedules, with ONE `create_clip_tasks` call per scene, ONE task per clip (one clip per shot, or one per multi-shot bundle when the clip plan bundles shots) plus one assembly task that joins
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

Coordinator skill: validates prerequisites, reads the scene's clip plan and has the server create ALL its tasks in ONE call: `create_clip_tasks` makes one task per clip (worker skill `shoot-clip`) plus the assembly task (worker skill `assemble-scene`), all or nothing. A clip is one shot, or - only when the clip plan says so - one bundle of 2-4 consecutive shots rendered as ONE multi-shot clip. The server writes every task brief (prompts, shot blocks, dependencies, file names) from the plan: you never hand-write or copy a clip brief, and you never `create_task` a clip or assembly task of a plan. Never let a worker render several clips for different tasks.

- A scene is named by a storyboard artifact URI, `storyboard_scene_<n>` or `@scene_<n>` (scene number from the storyboard key).
- Several scenes in one request: run Steps 0-3 per scene in the given order (one `create_clip_tasks` each; never merge scenes); one combined Step 4 reply.

## Assembly-only requests

"Assemble / stitch / final cut of scene N" is this skill; `assemble-scene` runs only as the assembly task.

- Resolve the scene (Step 0; no video workflow needed); run Step 1c.
- Clip tasks missing -> never shot: say so, offer the full shoot; never assemble a subset.
- All clips present: call `create_clip_tasks` (Step 3) with the key prefix of that run - it reports the clips as existing and creates only the missing assembly. The assembly already live -> tell the user, create nothing.
- An older run whose clip briefs were hand-written is refused ("already exists with a different brief"; nothing is created): create only its assembly with ONE `create_task`: id `assemble_scene<N>`, `requires_tasks` / `requires_artifacts` = every clip task / artifact of the run, `output_artifact_name` `scene<N>_assembly`, `output_files` `["scene<N>_assembled.mp4"]`, prompt `Load and use skill: assemble-scene`, `scene: "<Scene Name>"`, the clips in plan order as `artifact://<artifact id>/<video file>   — <duration>s` (ids from `artifact_index`) and `Output file (canonical — do not rename): scene<N>_assembled.mp4`.

## Step 0 — Resolve intent (before reading any artifact)

- Scene: stated explicitly ("Scene 2", "s2", "the rain scene"). Ambiguous -> ask: "Which scene should I shoot? Available scenes: [from the `scene_list` artifact]".
- Video workflows, from the `wf_*` tool list by type / capability in each description and `get_workflow_instructions`, never by name:
  - Fresh-start (REQUIRED, for `cut` and first clips): image-to-video, type `i2v` / `i2va` (flf2v only when its last frame is optional). Text-to-video is not a substitute. None in the workspace -> create nothing; say: "Cannot shoot <scene>: this workspace has no image-to-video workflow. Add one (Workflows page) and ask me again."
  - Video-continuation (optional; a video input for the prior clip): for `continue` clips. Without it the plan makes every boundary a `cut`.
- A user-named workflow must qualify for these roles, else say why and stop. Several i2v / i2va qualify and none named: prefer one that also takes reference images (a `reference_role` image input); ask only if they differ in a way the user must choose.

## Step 1 — Preflight

### 1a. Storyboard design

- Source: `artifact_index` -> `storyboard_scene_<n>` (key may carry a suffix; match the number): approved, with `shotlist.md` and `frame_1.<ext>` … `frame_N.<ext>`. Frame i = start frame of shot i; N must equal the shot count, else tell the user and stop. No other source, no partial scheduling.
- None exists: "Cannot shoot <scene>: it has no storyboard design yet. Create and finish it in the design studio (Pre-production -> Storyboards) and ask me again."
- Not approved: "Cannot shoot <scene>: the storyboard design `<key>` is not finished yet. Finish it in the design studio (Pre-production -> Storyboards) and ask me again."

### 1b. Reference pictures: the server binds them

You choose NO reference pictures and pass none (`create_clip_tasks` has no `references` argument). For every clip - single `cut`, `continue` and bundle - the server decides who is pictured (never the `POV:` owner or a `limbs` person), in which look (outfit design while worn; the character design for `:nude` / `:none` and for removed garments; both for a partly undressed look), which published image (full-body shot or the shot's named view, never a sheet), in which priority and on which workflow port, and writes it into each clip brief's `picture_map:`; the clip worker renders through `shoot_clip` / `shoot_bundle`, which bind exactly that map. A continuation re-supplies its chain's identity. Missing designs are noted in the brief (`picture_notes:`), never fatal.

### 1c. Idempotency

`task_index`: tasks of an earlier run exist? A re-run of the same `key_prefix` is safe (existing tasks are reported, never duplicated or changed). A NEW shoot of the same scene (user asks "again", "as v2") takes a NEW `key_prefix` (Step 3). Everything live and nothing to add: "Scene <N> is already scheduled (clips <list> + assembly). No new tasks created. To re-shoot a clip, cancel its task first."

## Step 2 — Read the plan

- `clip_plan(storyboard)` once per scene. It is the authority for modes (`cut` / `continue`), reasons, bundles, start frames and framing; its text shows the clips and the bundles it will make. A `PROBLEMS` line = stop and tell the user. Never decide, change or "improve" a mode, a bundle or a clip number yourself.
- `style` defaults to the workspace style (`{workspace.story.style}`, one line, "Medium / style is kept" in `workflow-calling-conventions`; NEVER the plot): pass `style` only to override, or when the workspace has none (the call is refused without one). The server adds the workspace setting (`{workspace.story.setting}`) to every clip brief as its own `setting:` line. `negative_prompt`: the preferred video workflow's recommended negative (`get_workflow_instructions`); omit when the workflow has no negative port.
- The server reads the shotlist, scene list beats, frame edits and the shots' LoRAs itself: you read none of it.

## Step 3 — Create the tasks (ONE call per scene)

```
create_clip_tasks({
  storyboard: "storyboard_scene_<n>",
  key_prefix: "shoot_scene<N>",          // a new shoot of the same scene: shoot_scene<N>_v2, _v3 ...
  negative_prompt: "<as Step 2>",        // optional
  agent: "<id>"                          // optional: default `generic`; else an agent from available_agents with the wf_* tools and the sandbox, never a planner, coordinator or director
})
```

- The tool creates, all or nothing: clip tasks `<key_prefix>_clip<M>` (clips numbered 1..K in plan order, a bundle is ONE clip) and `assemble_<name>` (`key_prefix` minus `shoot_`). A `continue` clip requires its prior clip's task and artifact (also a bundle clip); `cut` and bundle clips depend on nothing; the assembly requires every clip. Canonical file names are chosen by the server.
- An `error:` result created NOTHING. Read it: a changed brief of an existing key -> new `key_prefix` (or the user cancels the old tasks); a plan problem -> Step 2; a `continue` clip names a missing earlier clip -> create that clip too. Fix the cause and call again; the call is idempotent, so retrying is always safe. Do not fall back to `create_task` for plan clips.
- `clips: [..]` limits the call to some clip numbers (adding missing clips of an earlier run); the assembly follows with the call that completes the set.
- Do not `task_index`-reconcile afterwards: the result IS the record.

## Step 4 — Reply

1-3 short lines ("Concise replies and task/artifact URIs" in `workflow-calling-conventions`): no file names, durations, workflow / skill names. Quote the tool's listing: every task as `task://<id>` from its rows, the counts it states (created / already existing), and any note or error it printed; never claim a task the listing does not show.

> Scheduled Scene <N>: <total> clips (task://<clip1>, task://<clip2>, ...) + assembly task://<assemble>. Cut clips render in parallel; continuations follow their predecessor.
> Already scheduled (skipped): task://<id>, ... — only if the listing says existing.
> Not created: <what> — <the tool's error> — only if the call failed.

## Rules

- ONE `create_clip_tasks` per scene; the server owns names, briefs and dependencies - never re-type them into `create_task`.
- Resolve scene and workflow before reading artifacts.
- The plan's modes, bundles and break reasons are final.
- Clip tasks never get `can_create_tasks` (the tool never sets it).
