---
name: shoot-single-scene
description: >
  Use when tasked with shooting or filming a specific named scene — e.g. "shoot scene 2",
  "render scene 3 clips", "film the hotel scene". Produces one rendered video clip per
  camera shot in the scene, plus the prompts used. Do NOT invoke for storyboard rendering,
  prompt writing only, or scene assembly.
agentType: worker
---

# Shoot Single Scene

## 1. Gather context

Read all relevant artifacts for the scene: shotlist, visual storyboard, visual bible (style/character/location anchors), cast descriptions. Read the screenplay only if the shotlist is ambiguous.

Extract only the shots and context relevant for your named scene.

## 2. Select a workflow

From your available `wf_*` tools, pick the best fit:

| Type | When |
|---|---|
| t2v | no reference images |
| i2v | storyboard images exist for shots |
| flf2v / r2v | start and end frames both available or reference frame(s) available for continuation or grounding |

Call `get_workflow_instructions` for the chosen workflow and read it fully — note all prompt parameters, specific prompt syntax, strutures, requirements and constraints.

## 3. Prepare keyframes (image-based workflows only, i2v, r2v)

For each shot, check how many storyboard images exist:
- **3+ images**: use first / middle / last as keyframes directly.
- **fewer**: use available image as start frame; generate missing frames with a T2I workflow (`get_workflow_instructions` → `draft_prompt` → call T2I tool). Generated frames must be visually consistent with the start frame.

## 4. Draft prompts

For each shot, call `draft_prompt(workflow_name, context)` once per prompt parameter the workflow expects. Pass the full shot context: shot description, camera, character and location anchors, lighting, mood.

Draft a shared negative prompt once and reuse it across all shots.

Complete prompts for all shots before rendering.

## 5. Render

For each shot in order, call the workflow tool with the prepared frames and prompts. Wait for the result before moving to the next shot. On error, re-read workflow instructions, correct the issue, and retry once.

After each render, write all prompt outputs to their declared paths.

## 6. Verify before completing

- Every declared clip was rendered by the video workflow (not a T2I tool)
- Every render returned a success response with the correct output path
- Every declared prompt file has been written
- **Path audit**: each `.mp4` path returned by the wf_* tool must match exactly the canonical filename declared in your task description. If the wf_* tool saved to a different path than declared, the artifact build will fail — do not call `task_complete` until every path matches. Call the wf_* tool again targeting the correct declared path if needed.

Then call `task_complete`.
