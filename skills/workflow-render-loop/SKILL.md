---
name: workflow-render-loop
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

The system automatically routes each `wf_xxx` call's output to the declared file slots in your task artifact. You do not manage filenames during the call — just call with the right prompt or parameters.

A single `wf_xxx` call may produce **one or more output files** as a batch. Your task description is the source of truth for how many calls are needed and what each should generate.

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
