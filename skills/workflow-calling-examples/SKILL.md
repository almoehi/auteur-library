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

# the person's own text; the selected LoRA's trigger word sits at the very start (the route check ignores it there)
wf_xxx(
  prompt="V1nt4geStyle, 1970s faded polaroid of a man in a rainy piazza",
  lora_1="krea2_vintage_style"
)
```

## Prompt writing (the person typed "make the raccoon look left" in the studio chat on an edit workflow)

```
# pass through: short, explicit, concrete -> the person's text ALONE, word for word. Nothing added, not even
# a sentence naming the images (an added sentence is refused); no prompt-writer tools
wf_xxx(prompt="Make the raccoon look left", ...)

# draft: vague, agent-derived, or any call that needs the images named -> the person's text goes in
# `instruction`, the writer keeps it LOCKED; image_inputs lets the code write the "Picture N is ..." lines,
# verbatim_phrases protects must-keep text. Pass the result BY ID (never retype, edit or extend it)
draft_prompt(workflow_name="<wf>", instruction="make it feel more menacing", context="<scene brief>",
             image_inputs=[{"port": "ref0", "ref": "artifact://<id>/frame_1.png"}],
             verbatim_phrases=["<the shot's Sex act: value>", "<the shot's Sex position: value>"])
→ { prompt_id: "p7", prompt: "..." }
wf_xxx(prompt_ids={"prompt": "p7"}, ref0="artifact://<id>/frame_1.png", ...)
```

## Verbatim override

```
Task: 'render one image, use this prompt verbatim: "a red bicycle leaning on a green wall"'

wf_xxx(prompt="a red bicycle leaning on a green wall")     ← exact text, no drafting tools
```

## 3 shots, one file each

```
read_artifact(artifactId="shotlist_scene_2")  → parsed 3 shots
draft_prompts_batch(items=[{workflow_name: "<wf>", context: "<shot s2_01 lines>"}, {…s2_02…}, {…s2_03…}])
→ { results: [{ prompt_id: "p1" }, { prompt_id: "p2" }, { prompt_id: "p3" }] }
wf_xxx(prompt_ids={"prompt": "p1"})   → s2_01.png      # all three calls in ONE response
wf_xxx(prompt_ids={"prompt": "p2"})   → s2_02.png
wf_xxx(prompt_ids={"prompt": "p3"})   → s2_03.png
task_complete(summary="Rendered 3 shots for Scene 2")
```

## One call, multiple same-kind outputs

A character-sheet workflow (`krea2_character_sheet` / `_nsfw`: input `character_image`; params `gender` female|male|other, `white_background`, `identity_prompt`, ...) returns the sheet (including two first-person POV tiles of the character's own body, a right column of the sheet only) plus three full-body views and a portrait. Declared files: `character_sheet.png`, `view_1.png`, `view_2.png`, `view_3.png`, `portrait.png`. One call returns all these image ports; the names do not all follow the port names 1:1 in every task, so bind explicitly:

```
wf_xxx(
  character_image="artifact://<artifactId>/<file>",
  gender="female",
  output_ports={
    "character_sheet": "/workspace/<artifact_uuid>/character_sheet.png",
    "view_1": "/workspace/<artifact_uuid>/view_1.png",
    "view_2": "/workspace/<artifact_uuid>/view_2.png",
    "view_3": "/workspace/<artifact_uuid>/view_3.png",
    "portrait": "/workspace/<artifact_uuid>/portrait.png"
  }
)
→ all 5 slots filled, correctly bound by name
task_complete(summary="Rendered character sheet")
```

## Negative examples — do NOT do these

- `read_artifact(...)` then `task_complete(...)` — WRONG: wf_xxx was never called; output files are missing.
- One `wf_xxx` rendered, then `task_complete(...)` — WRONG: remaining shots are not rendered.
- `sandbox_fetch(url="https://artifact-store.example.com/shotlist.md")` — WRONG: use `read_artifact` for artifact content.
- `read_artifact(...)` → "I have read the shotlist. It contains 27 shots." — WRONG: that is not rendering.
