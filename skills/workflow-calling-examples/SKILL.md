---
name: workflow-calling-examples
description: "Need a worked example of wf_xxx calls (multi-shot, multi-output, LoRA, prompt route, common mistakes). Do NOT load by default; workflow-calling-conventions has all the rules."
agentType: all
---

# Worked examples for wf_xxx calls

Rules live in `workflow-calling-conventions`; these only illustrate call shapes.

## LoRA

Task prompt: "1970s faded polaroid of a man in a rainy piazza"

```
lora_index()
→ [ { name: "krea2_vintage_style", modelFamily: "krea2", triggers: ["V1nt4geStyle"],
      description: "vintage style lora for krea2" } ]

wf_xxx(
  prompt="V1nt4geStyle, 1970s faded polaroid of a man in a rainy piazza",
  lora_1="krea2_vintage_style"
)
```

## Prompt route (the person typed "make the raccoon look left" in the studio chat on an edit workflow)

```
# verbatim: short, explicit, concrete -> the person's text + image naming, no prompt-writer tools
wf_xxx(prompt="Make the raccoon look left. Picture 1 is the frame to edit.",
       prompt_route="verbatim", ...)

# rewritten: vague or agent-derived -> the person's text goes in `instruction`, the writer keeps it LOCKED
draft_prompt(workflow_name="<wf>", instruction="make it feel more menacing", context="<scene brief>")
wf_xxx(prompt="<the drafted prompt>", prompt_route="rewritten", ...)
```

## Verbatim override

```
Task: 'render one image, use this prompt verbatim: "a red bicycle leaning on a green wall"'

wf_xxx(prompt="a red bicycle leaning on a green wall")     ← exact text, no drafting tools
```

## 3 shots, one file each

```
read_artifact(artifactId="shotlist_scene_2")  → parsed 3 shots
wf_xxx(prompt="Rainy Italian piazza at dusk, stone fountain, lone figure under umbrella")      → s2_01.png
wf_xxx(prompt="Hotel room interior, warm lamplight, woman standing at rain-streaked window")   → s2_02.png
wf_xxx(prompt="Hotel lobby, elderly padrone bowing behind dark oak desk")                       → s2_03.png
task_complete(summary="Rendered 3 shots for Scene 2")
```

## One call, multiple same-kind outputs

Declared files: `character_sheet.png`, `pose_front.png`, `pose_face_closeup.png`, `pose_left_profile.png`, `pose_right_profile.png`, `pose_frightened.png`. One call returns all these image ports (plus auxiliary ones you don't want); auto-routing cannot tell them apart, so bind explicitly:

```
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

- `read_artifact(...)` then `task_complete(...)` — WRONG: wf_xxx was never called; output files are missing.
- One `wf_xxx` rendered, then `task_complete(...)` — WRONG: remaining shots are not rendered.
- `sandbox_fetch(url="https://artifact-store.example.com/shotlist.md")` — WRONG: use `read_artifact` for artifact content.
- `read_artifact(...)` → "I have read the shotlist. It contains 27 shots." — WRONG: that is not rendering.
