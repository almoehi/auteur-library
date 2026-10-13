---
name: shoot-single-scene
description: >
  Use when tasked with shooting or filming a specific named scene — e.g. "shoot scene 2",
  "render scene 3 clips", "film the hotel scene". Produces one rendered video clip per
  camera shot in the scene (from the scene's storyboard keyframes where they exist), plus the
  prompts used. Do NOT invoke for storyboard design or keyframe rendering (storyboard-scene),
  prompt writing only, or scene assembly.
agentType: worker
---

# Shoot Single Scene

## 1. Gather context

Your task description lists the source (a finished storyboard design `storyboard_scene_<n>`,
or a shotlist + visual-shots pair as fallback), the design-sheet `references:`, and the
canonical clip and prompt file names. Read:

- **Storyboard source:** `shotlist.md` (sections `## <shotId> — <title>` with `Action`,
  `Camera`, `Characters`, `Outfits`, `Duration`) and the frames `frame_1.<ext>` … `frame_N.<ext>`
  of the storyboard artifact; frame i is the start frame of shot i. Reference every frame as
  `artifact://<artifact id>/<file>` (never a copied URL). Look at a frame with `describe_image`
  when you need to know what it shows.
- **Fallback source:** the shotlist and the visual storyboard artifacts; the visual bible and
  cast descriptions only if they exist (they are optional).
- The `references:` design sheets (location / outfit primaries) as `artifact://` references.

Read the screenplay only if the shotlist is ambiguous. Extract only what is relevant for your
scene.

## 2. Select a workflow (by capability, never by name)

Read the descriptions and `get_workflow_instructions` of your video `wf_*` tools. Prefer what
the manifest declares — `capabilities` and, per image input, `reference_role` (`subject`,
`background`, `reference`, `garment`) and `label` (how the prompt names that image, e.g.
"Subject 1") — and otherwise infer from the descriptions and port order: the workflow type (i2v, flf2v, ref2v, t2v …), the image / video inputs (number, kind, order), which ports
are REQUIRED, the port descriptions, declared capabilities. A workflow with a required input
you cannot supply (e.g. a prior-clip or video input for the first clip, a mask) is
**disqualified**. The task description's `workflow:` is a preference — use it if it qualifies.
Pick, in this order:

| Path | Workflow | Inputs |
|---|---|---|
| (a) | first/last-frame (flf2v) or image-to-video (i2v) | the picked storyboard frame as the start frame (flf2v: end frame = the next shot's frame only when it continues the same action, else leave it empty if optional) |
| (b) | reference-to-video (ref2v) | the frame + the design sheets as references, in the order the ports describe |
| (c) | text-to-video (t2v) | the shot text only |

Fallback source without a storyboard frame for a shot: i2v/flf2v still apply to its available
images; missing frames are generated with a text-to-image `wf_*` tool (choose by capability the
same way; generated frames must stay visually consistent with the start frame).

State the path used for the scene — and why a better path was not available — in your
`task_complete` summary, so the person knows (e.g. "path (b): no i2v workflow accepted a start
frame without a required video input").

Call `get_workflow_instructions` for the chosen workflow and read it fully — note all prompt
parameters, specific prompt syntax, structures, requirements and constraints.

## 3. Prepare keyframes (fallback source only)

For each shot of the fallback source, check how many storyboard images exist:
- **3+ images**: use first / middle / last as keyframes directly.
- **fewer**: use the available image as start frame; generate missing frames with a text-to-image
  workflow (`get_workflow_instructions` → `draft_prompt` → call the tool).

With the storyboard source the frames are ready; skip this step.

## 4. Draft prompts

Follow the **Prompt route** rule of `workflow-calling-conventions` (`load_skill` it) for every prompted `wf_*` call and pass `prompt_route`. Typical here: scene and shot briefs are agent-derived, so they are rewritten (`draft_prompts_batch`); only a short explicit user instruction qualifies as verbatim.

Fan out across ALL shots — single `draft_prompt` / `review_prompt` / `enhance_prompt` calls are
serialized by the runtime, the `*_prompts_batch` tools run their items in parallel:

1. Bind the path (a/b/c), frames and references for every shot (reasoning only).
2. ONE `draft_prompts_batch(workflow_name, items=[{context}, …])`, one item per shot (and per
   prompt parameter the workflow expects). `workflow_name` is per call: one batch per distinct
   workflow, issued in the same response. Carry the workspace's stated medium/style (from `{workspace.story.plot}`, see "Medium / style is kept" in `workflow-calling-conventions`) into every `context`, verbatim; never drop it. Each `context`: the full shot context (action,
   camera, characters, outfits, location, mood, duration) and the path used. For path (a)
   describe only the motion from the start frame; for path (b) name the references the way the
   port descriptions do ("Figure 1", "Picture 1" …). The prompt text per clip goes to its
   declared prompt file(s). Order the reference images by "Anchor (Picture 1) by intent" of
   `workflow-calling-conventions` (shooting from references is COMPOSE intent: location first,
   then the shot's characters / outfits).
3. Optionally audit with at most ONE `review_prompts_batch` over all prompts; if it flags gaps,
   at most ONE `enhance_prompts_batch` for the flagged items only. No per-shot loops.

Draft a shared negative prompt once and reuse it across all shots (only when the workflow has a
negative prompt port).

Complete prompts for all shots before rendering.

## 5. Render

For each shot in order, call the workflow tool with the prepared frames / references and
prompts. Wait for the result before moving to the next shot. On error, re-read the workflow
instructions, correct the issue, and retry once.

After each render, write all prompt outputs to their declared paths.

## 6. Verify before completing

- Every declared clip was rendered by the video workflow (not a text-to-image tool)
- Every render returned a success response with the correct output path
- Every declared prompt file has been written
- Every still frame you generated yourself (fallback source, text-to-image) was checked and
  retried at most once as in "Check, retry once, suggest" of `workflow-calling-conventions`;
  the storyboard's own frames and the video clips are not re-checked here
- **Path audit**: each `.mp4` path returned by the wf_* tool must match exactly the canonical
  filename declared in your task description. If it saved elsewhere, the artifact build will
  fail — do not call `task_complete` until every path matches. Call the wf_* tool again
  targeting the declared path if needed.

Then call `task_complete` (summary: the path (a/b/c) used per scene and why).
