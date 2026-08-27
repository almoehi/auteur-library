---
name: workflow-calling-conventions
description: "Producing output files with wf_xxx workflow tools — correct call sequence, batch handling, and completion contract."
agentType: worker
---

# Rendering Output Files with Workflow Tools

## When to use this skill

Use this skill whenever your task asks you to produce output files (images, video frames, or other media) by calling `wf_xxx` workflow tools. Workflow tools are listed in your available tools and start with the prefix `wf_`.

## Correct sequence

```
1. read_artifact(artifactId="<key>")     — load the work specification (shot list, prompts, etc.)
2. For each shot or batch your task defines:
       wf_xxx(prompt="<description>")    — generate one shot or batch of output files
3. task_complete(summary="...")          — only AFTER every required wf_xxx call is done
```

## Output file routing

The system auto-routes each `wf_xxx` call's output to the declared file slots in your task artifact by matching declared file names to the workflow's output port names (e.g. a declared file `pose_front.png` binds to the `pose_front` port). When your declared file names already match the port names, you don't need to manage routing — just call with the right prompt or parameters.

**Exception — multiple same-kind outputs in one call**: if a single `wf_xxx` call produces MULTIPLE outputs of the same kind (e.g. a workflow that returns several images in one batch) and your declared file names don't obviously correspond 1:1 to the port names, auto-routing is ambiguous. In that case pass `output_ports` explicitly on the call to bind each port to its correct declared path — see the example below and the `output_ports` parameter on the tool itself for the exact port names available.

A single `wf_xxx` call may produce **one or more output files** as a batch. Your task description is the source of truth for how many calls are needed and what each should generate.

## Supplying artifact-backed inputs (reference images, source video, etc.)

When a `wf_xxx` call needs an existing workspace artifact as an input (e.g. a reference image or source clip), pass `artifact://<artifactId>/<fileKey>` directly as the tool's input-port argument — e.g. `artifact://832c9090-d97e-4e9f-89ce-4a1e61c759ab/scene_3_backdrop.png`. Use the artifact UUID from `artifact_index` and the exact filename from the task description; do NOT call `get_artifact_url` for this. The real download URL is resolved for you automatically. Do NOT download the artifact into the sandbox first — sandbox download is only for local command processing (ffmpeg/python), not for workflow-tool inputs.

`get_artifact_url` still exists for other uses (e.g. downloading a file into the sandbox for `ffmpeg`/`python` processing) — just don't use it, or paste its returned URL, for `wf_xxx` input ports.

## Positive example — 3 shots, one file each

Task: render shots s2_01.png, s2_02.png, s2_03.png

```
read_artifact(artifactId="shotlist_scene_2")
→ parsed 3 shots

wf_xxx(prompt="Rainy Italian piazza at dusk, stone fountain, lone figure under umbrella")
→ slot 1 filled (s2_01.png)

wf_xxx(prompt="Hotel room interior, warm lamplight, woman standing at rain-streaked window")
→ slot 2 filled (s2_02.png)

wf_xxx(prompt="Hotel lobby, elderly padrone bowing behind dark oak desk")
→ slot 3 filled (s2_03.png)

task_complete(summary="Rendered 3 shots for Scene 2")
```

## Positive example — one call, multiple same-kind outputs

Task: produce a character turnaround sheet with declared files `character_sheet.png`, `pose_face_closeup.png`, `pose_right_profile.png`, `pose_left_profile.png`, `pose_front.png`, `pose_frightened.png`

A single workflow call here returns several image ports at once (`character_sheet`, `pose_front`, `pose_face_closeup`, `pose_left_profile`, `pose_right_profile`, `pose_frightened`, plus auxiliary ports you don't want). Auto-routing can't reliably tell these apart — pass `output_ports` to bind each one explicitly:

```
read_artifact(artifactId="character_sheet_images")
→ 6 declared files

wf_xxx(
  prompt="...",
  output_ports={
    "character_sheet": "/workspace/<artifact_uuid>/character_sheet.png",
    "pose_front": "/workspace/<artifact_uuid>/pose_front.png",
    "pose_face_closeup": "/workspace/<artifact_uuid>/pose_face_closeup.png",
    "pose_left_profile": "/workspace/<artifact_uuid>/pose_left_profile.png",
    "pose_right_profile": "/workspace/<artifact_uuid>/pose_right_profile.png",
    "pose_frightened": "/workspace/<artifact_uuid>/pose_frightened.png"
  }
)
→ all 6 slots filled, correctly bound by name

task_complete(summary="Rendered character turnaround sheet")
```

## Negative examples — do NOT do these

**Stopping after reading the artifact** (no files produced)
```
read_artifact(...)
task_complete(...)     ← WRONG — wf_xxx was never called; output files are missing
```

**Calling task_complete before all shots are rendered**
```
wf_xxx(...)            ← only shot 1 rendered
task_complete(...)     ← WRONG — remaining shots are not rendered
```

**Fetching artifact content via sandbox_fetch with an invented URL**
```
sandbox_fetch(url="https://artifact-store.example.com/shotlist.md", ...)
                       ← WRONG — use read_artifact to access artifact content
```

**Reading the shotlist then returning a text summary instead of rendering**
```
read_artifact(...)
→ "I have read the shotlist. It contains 27 shots."   ← WRONG — this is not rendering
```

## Key rules

1. Call `wf_xxx` for **every** shot or batch your task defines — do not skip any.
2. Call `task_complete` **only** after all `wf_xxx` calls are complete.
3. Access artifact content via `read_artifact`, not `sandbox_fetch` or invented URLs.
4. Your task description is authoritative: if it lists 27 shots, make all the `wf_xxx` calls required to cover them — do not stop early.
5. When a single `wf_xxx` call produces multiple outputs of the same kind, pass `output_ports` explicitly rather than relying on automatic routing.
