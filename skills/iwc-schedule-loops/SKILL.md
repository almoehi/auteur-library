---
name: iwc-schedule-loops
description: >
  Use when the task prompt says "Load and use skill: iwc-schedule-loops", or asks to schedule the
  loop clip renders of an iWantClips episode once its storyboards exist: creates ONE task
  shoot_loop_clip<N> per clip (worker skill iwc-loop-clip), each waiting for its scene's
  storyboard design, with its output artifact. Each task renders all loop variants of its
  clip's anchor. Do NOT invoke for rendering a clip yourself
  (iwc-loop-clip), planning designs (plan-designs), or the film pipeline's scene shoots
  (shoot-scene-task / create_clip_tasks).
agentType: worker
---

# Schedule loops: one render task per clip

A static workspace YAML cannot require `storyboard_scene_<N>`: those designs are created at run
time by `plan_designs`, so their ids do not exist when the YAML is read. This task runs after
`plan_designs` and creates the render tasks dynamically, one per clip, each held back until its
storyboard is finished (the pattern of the library's `shoot-scene-task`: a clip task waits for the
storyboard it renders from). You render nothing.

## 1. Preflight

Fields: `plan` (default `visual_plan`), `design_plan` (default `design_plan`), `clips` (the clip
numbers to schedule, e.g. `[1, 2]`; default all clips of the plan), `inputs` (default
`episode_inputs`), `variants` (variants per clip, default 3, max 4) and `variant_seconds`
(default 12, allowed 10-12): both passed on to every clip task.
1. `read_artifact` `visual_plan.json` (clips: number, outfit_id, set_id, the count of
   `variants[]`; sets: room_id) and
   `design_plan.json` (the design keys: `character_<slug>`, `outfit_<slug>_<look>`,
   `location_<room_id>`, `storyboard_scene_<n>`).
2. `task_index` once: find the storyboard design task of each clip (key `storyboard_scene_<N>`;
   a suffixed key counts when its number matches) and any existing `shoot_loop_clip<N>`.
3. A clip whose `storyboard_scene_<N>` is missing from both lists: do not create its task; name it
   in the reply. An existing live `shoot_loop_clip<N>`: skip it (idempotent).

## 2. Create the tasks (per clip N, in clip order)

ONE `create_task` per clip, then its `create_artifact` right after, then the next clip:

```
create_task({
  id: "shoot_loop_clip<N>",
  title: "Shoot loop clip <N>",
  description: "Render the <variants> loop variants (<variant_seconds> s each) of clip <N> from the anchor frame of storyboard_scene_<N> (h3_loop_clip_nsfw), per-variant checks, joined preview",
  agent: "generic",
  requires_tasks: ["<the storyboard_scene_<N> design task key from task_index>"],
  prompt: "Load and use skill: iwc-loop-clip\nclip: <N>\nvariants: <variants>\nvariant_seconds: <variant_seconds>\nstoryboard: storyboard_scene_<N>\ncharacter: character_<slug>\noutfit: <outfit design key, or none for a nude clip>\nlocation: location_<room_id>\nplan: visual_plan\ninputs: episode_inputs"
})
create_artifact({ task_id: "shoot_loop_clip<N>", id: "loop_clip<N>", title: "Loop clip <N>",
  description: "clip<N>_v<k>.mp4, clip<N>_v<k>_audio.flac, clip<N>_v<k>_checks.txt per variant (+ clip<N>_v<k>-r2.* on a retry), clip<N>_variants_preview.mp4, clip<N>_summary.md" })
```

- The dependency: the storyboard task finishes when a person finishes the storyboard design in
  the studio, so the clip task waits until its frame exists. `requires_tasks` takes the task KEY
  of the existing storyboard design task (the workspace resolves an existing key to its runtime
  id when it takes the tasks over); copy it from `task_index`, never guess.
- `<variants>`: the task's `variants` field, capped at the clip's `variants[]` count in the
  plan (a plan clip with fewer variants: its count; name the cap in the reply).
- Never `can_create_tasks` on a clip task. Never one task for several clips, never one task per
  variant (the clip task renders all variants of its anchor).
- In interactive run mode every created task is held until a person releases it.

## 3. Reply and complete

Write `schedule.md` into your output artifact (`/workspace/<artifact id>/schedule.md`, one
`sandbox_write_file`): one line per clip - `shoot_loop_clip<N>`: created (<variants> × <variant_seconds> s; waits for
<storyboard task key>) / skipped (already exists) / not created (no storyboard design) - and the
line "Release each clip task after its storyboard is finished." Reply with the same lines
(`task://shoot_loop_clip<N>`), then `task_complete`.
