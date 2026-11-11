---
name: iwc-schedule-loops
description: >
  Use when the task prompt says "Load and use skill: iwc-schedule-loops", or asks to schedule the
  montage clip renders of an iWantClips episode once its storyboards exist: creates ONE task
  shoot_look<N> per look (worker skill iwc-loop-clip), each waiting for its scene's storyboard
  design, with its output artifact. Each task renders all clips of its look from the look's
  stills. Do NOT invoke for rendering clips yourself (iwc-loop-clip), planning designs
  (plan-designs), or the film pipeline's scene shoots (shoot-scene-task / create_clip_tasks).
agentType: worker
---

# Schedule looks: one render task per look

**Catalog tools:** none in this task (no `search_catalog` / `use_reference`, no catalog outfit or
`garment_reference`).

A static workspace YAML cannot require `storyboard_scene_<N>`: those designs are created at run
time by `plan_designs`. This task runs after `plan_designs` and creates the render tasks, one per
look (scene N = look N), each held back until its storyboard is finished. You render nothing.

## 1. Preflight

Fields: `plan` (default `visual_plan`), `design_plan` (default `design_plan`), `looks` (the scene
numbers to schedule, e.g. `[1]`; default all looks of the plan), `inputs` (default
`episode_inputs`).
1. `read_artifact` `visual_plan.json` (`looks`: each with `scene`, `outfit_id`, `set_id`, its
   `clips` ids; `sets`: `room_id`; `render`: `workflow`, `fps`) and `design_plan.json` (the design keys: `character_<slug>`,
   `outfit_<slug>_<look>`, `location_<room_id>`, `storyboard_scene_<n>`).
2. `task_index` once: find the storyboard design task of each scene (key `storyboard_scene_<N>`;
   a suffixed key counts when its number matches) and any existing `shoot_look<N>`.
3. A look whose `storyboard_scene_<N>` is missing from both lists: do not create its task; name it
   in the reply. An existing live `shoot_look<N>`: skip it (idempotent).

## 2. Create the tasks (per look, in scene order)

ONE `create_task` per look, then its `create_artifact` right after, then the next look:

```
create_task({
  id: "shoot_look<N>",
  title: "Shoot look <N> (<look id>)",
  description: "Render the <clip count> montage clips of look <N> (<look id>) from the stills of storyboard_scene_<N> (per the plan's `render`: <render.workflow>, <render.fps> fps)",
  agent: "generic",
  requires_artifacts: ["storyboard_scene_<N>"],
  prompt: "Load and use skill: iwc-loop-clip\nlook: <look id>\nscene: <N>\nstoryboard: storyboard_scene_<N>\ncharacter: character_<slug>\noutfit: <outfit design key, or none for a nude look>\nlocation: location_<room_id>\nplan: visual_plan\ninputs: episode_inputs"
})
create_artifact({ task_id: "shoot_look<N>", id: "look<N>_clips", title: "Look <N> clips",
  description: "<clip id>.mp4 per clip, look<N>_clips.json" })
```

- The dependency: `requires_artifacts` holds the task until the storyboard design
  `storyboard_scene_<N>` is FINISHED (a person finishes it in the studio, which publishes its
  frames). Use the artifact key exactly as in `design_plan.json` / the artifact index (a suffixed
  key: the one whose number matches); an unknown key is refused - fix the key, never drop the
  dependency. Do not use `requires_tasks` for this.
- Never `can_create_tasks` on a look task. Never one task for several looks, never one task per
  clip (the look task renders all clips of its look).
- In interactive run mode every created task is held until a person releases it.

## 3. Reply and complete

Write `schedule.md` into your output artifact (`/workspace/<artifact id>/schedule.md`, one
`sandbox_write_file`): one line per look - `shoot_look<N>` (<look id>): created (<clip count>
clips; waits for <storyboard task key>) / skipped (already exists) / not created (no storyboard
design) - and the line "Release each look task after its storyboard is finished." Reply with the
same lines (`task://shoot_look<N>`), then `task_complete`.
