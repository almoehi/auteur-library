---
name: workflow-calling-conventions
description: "Producing output files with wf_xxx workflow tools — correct call sequence, prompt route (pass the person's instruction through or rewrite it), batch handling, and completion contract."
agentType: all
---

# Rendering Output Files with Workflow Tools

## When to use this skill

Use this skill whenever your task asks you to render, shoot or produce output files like images, video frames, or other media by calling `wf_xxx` workflow tools. Workflow tools are listed in your available tools and start with the prefix `wf_`.

## Correct sequence

```
1. read_artifact(artifactId="<key>")     — load the work specification (shot list, prompts, etc.)
2. If the wf_xxx tool exposes LoRA slot parameters (see "LoRA lookup and loading" below):
       lora_index()                      — list the workspace LoRA catalog ONCE, pick most relevant candidates
3. For each shot or batch your task defines, decide the prompt route (see "Prompt route"):
       wf_xxx(prompt="<description>", prompt_route="verbatim" | "rewritten")
                                         — generate one shot or batch of output files
4. task_complete(summary="...")          — only AFTER every required wf_xxx call is done
```

## LoRA lookup and loading

Some `wf_xxx` tools expose optional **LoRA slot parameters** — one string parameter per slot (e.g. `lora_1`, `lora_2`, or named ports like `style_lora`) plus a matching optional `lora_<port>_strength` number. If the tool has NO such parameters, skip this section entirely — do not call `lora_index`.

When LoRA slots ARE exposed:

1. Call `lora_index()` once before your first render call. It lists every LoRA registered in this workspace: name, description, default strength, and **trigger words**.
2. Compare the catalog against your prompts and pick candidates on either signal:
   - **Trigger-word presence** — a LoRA's trigger word already appears (or belongs) in the shot's prompt, e.g. prompt says "V1nt4geStyle photograph of…" and the catalog has a LoRA with trigger `V1nt4geStyle`.
   - **Description match** — the LoRA's description fits what the prompt is asking for, e.g. a "vintage film look" LoRA for a prompt requesting a faded 1970s photograph.

   **Compatibility gate (applies to both signals): the LoRA must match the workflow's base model family.** A LoRA is trained against one base model (krea2, wan, sdxl, …) and produces garbage on any other. Each `lora_index` entry carries a `modelFamily` field; the `wf_xxx` tool's description states the workflow's model family. Only load a LoRA whose `modelFamily` matches the workflow's — when a candidate matches the prompt but not the family, leave it out. (For old entries without `modelFamily`, infer the base from the name/description.) The system also enforces this: a family-mismatched LoRA is rejected at call time before any render runs.
3. Load a candidate by passing its **exact catalog name** as the slot parameter: `wf_xxx(prompt="...", lora_1="krea2_vintage_style")`. Names not in the catalog are rejected — never guess or invent one.
4. **Include the trigger word in the prompt** when loading a trigger-word LoRA — most LoRAs only take effect when their trigger appears in the prompt text.
5. Strength: omit `lora_<port>_strength` to use the catalog/port default. Only override when the task or catalog description says to.
6. Leaving a slot unset is always safe — the workflow's built-in LoRAs still run; slots only ADD LoRAs on top.

Do NOT load a LoRA just because the catalog has one: load it only when the prompt/task actually calls for its style, character, or effect. An empty `lora_index` result simply means "render without extra LoRAs".

### Example

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

### Prompt route — pass the person's instruction through, or rewrite it

Decide for EVERY prompted wf_xxx call and state the decision with the `prompt_route` argument (`"verbatim"` or `"rewritten"`).

- **PASS THROUGH (`prompt_route: "verbatim"`)** only when ALL of these hold: the text comes from the person (chat or studio); it is an explicit, concrete instruction (an imperative change or motion); it is short (about 300 characters or a few clauses); it states what and where without ambiguity; nothing needs adapting to the workflow beyond naming the supplied images. Then the prompt is the person's text VERBATIM, plus one sentence naming the supplied images by the workflow's port labels (for example "Picture 1 is the frame to edit; Picture 2 is Detective Raccoon (outfit).") and at most ONE short keep clause, only if the person did not say what to keep. Do NOT call draft_prompt, review_prompt or enhance_prompt.
- **REWRITE with the prompt writer (`prompt_route: "rewritten"`)** for agent-derived briefs (scene lists, shotlists, design attributes, initial drafts), long, unstructured or vague requests, text-to-image and text-to-video generation, diversity variations and automatic retries after a miss. Pass the person's text, if any, in the `instruction` argument of draft_prompt / enhance_prompt / review_prompt (never only inside `context`): the prompt writer keeps it LOCKED.
- **Explicit overrides**: "use my words exactly" means pass through; "improve the prompt" means rewrite.

Examples (the person typed "make the raccoon look left" in the studio chat on an edit workflow):

```
# verbatim: short, explicit, concrete -> the person's text + image naming, no prompt-writer tools
wf_xxx(prompt="Make the raccoon look left. Picture 1 is the frame to edit.",
       prompt_route="verbatim", ...)

# rewritten: vague or agent-derived -> the person's text goes in `instruction`, the writer keeps it LOCKED
draft_prompt(workflow_name="<wf>", instruction="make it feel more menacing", context="<scene brief>")
wf_xxx(prompt="<the drafted prompt>", prompt_route="rewritten", ...)
```

## Verbatim prompts — the explicit-override case of the Prompt route

This is the explicit override of the Prompt route above ("use my words exactly"): if the user or task explicitly asks to skip prompt drafting/enhancement, or to use their prompt verbatim / unmodified / exactly as written ("use this prompt as-is", "no prompt enhancement", "don't rewrite my prompt"), do **NOT** call `draft_prompt`, `review_prompt` or `enhance_prompt` — pass the given prompt string to `wf_xxx` unchanged, byte for byte.

```
Task: 'render one image, use this prompt verbatim: "a red bicycle leaning on a green wall"'

wf_xxx(prompt="a red bicycle leaning on a green wall")     ← exact text, no drafting tools
```

The only permitted addition in that case is a LoRA trigger word when a LoRA is explicitly requested or required by the task — and only if the task doesn't forbid that too.

## Output file routing

The system auto-routes each `wf_xxx` call's output to the declared file slots in your task artifact by matching declared file names to the workflow's output port names (e.g. a declared file `pose_front.png` binds to the `pose_front` port). When your declared file names already match the port names, you don't need to manage routing — just call with the right prompt or parameters.

**Exception — multiple same-kind outputs in one call**: if a single `wf_xxx` call produces MULTIPLE outputs of the same kind (e.g. a workflow that returns several images in one batch) and your declared file names don't obviously correspond 1:1 to the port names, auto-routing is ambiguous. In that case pass `output_ports` explicitly on the call to bind each port to its correct declared path — see the example below and the `output_ports` parameter on the tool itself for the exact port names available.

A single `wf_xxx` call may produce **one or more output files** as a batch. Your task description is the source of truth for how many calls are needed and what each should generate.

## Supplying artifact-backed inputs (reference images, source video, etc.)

When a `wf_xxx` call needs an existing workspace artifact as an input (e.g. a reference image or source clip), pass `artifact://<artifactId>/<fileKey>` directly as the tool's input-port argument — e.g. `artifact://832c9090-d97e-4e9f-89ce-4a1e61c759ab/scene_3_backdrop.png`. Use the artifact UUID from `artifact_index` and the exact filename from the task description; do NOT call `get_artifact_url` for this. The real download URL is resolved for you automatically. Do NOT download the artifact into the sandbox first — sandbox download is only for local command processing (ffmpeg/python), not for workflow-tool inputs.

Every tool that takes a file URL (`describe_image`, `sandbox_fetch`, `get_video_info`, `wf_xxx` input ports) accepts the same `artifact://<artifactId>/<fileKey>` reference, resolved to a fresh download URL at call time. **Never copy, retype or shorten a URL** — a single dropped character in a signed URL gives a 403 that looks like an expiry. `get_artifact_url` returns a short `url` plus that `ref`; use the `ref` with tools, and paste only the short `url` into shell commands (`curl -L`). Plain http(s) URLs are for external sources only.

## Check, retry once, suggest

The generic procedure for EVERY take or render you produce with a `wf_xxx` tool (initial drafts, chat-requested edits and re-renders). Skills that render takes reference this section and add only their own file naming and audit lines.

The studio's server runs the same check for takes made with studio buttons (Generate, Edit, Variations). Never re-check a take you did not render yourself.

Verify each take against the request with `describe_image` on its `artifact://<artifactId>/<file>` ref (batch the checks of one round in one response), using this rubric as the question. The server uses the byte-identical text — do not reword it:

```
Check the image against the request. Judge only what can be seen in the image; ignore story, motives, dialogue and anything that is not visual.
- Subjects: every subject the request names is present and recognisable.
- Changes: every change the request asks for is visible, and nothing else was changed.
- Composition: framing, camera angle, layout and positions match the request.
- Style: the requested medium and style are kept, not replaced by another look.
- Invented or contradicted: nothing was added that the request does not ask for, and nothing the request rules out is shown.
PASS when every point holds. Otherwise MISS. Be strict about what the request names and lenient about what it leaves open.
Answer in exactly this form:
VERDICT: PASS or MISS
FINDING: one line on what is missing, contradicted or invented (MISS only)
FIX: one concrete corrective instruction - what to change and what to keep (MISS only)
```

A take that passes needs no further tool call. On a MISS:

1. Retry ONCE, automatically: fold the finding into a revised prompt that fixes exactly what is off, and render again from the SAME source (not from the missed take) as a NEW take named the original's base + `-r2` (`take_wide-rain.png` -> `take_wide-rain-r2.png`). The skill that owns the file naming may define a variant for its own pattern. Keep the missed take (never delete or overwrite it). Batch the retries of several takes into ONE `draft_prompts_batch` and ONE render response; file names stay write-once. The automatic retry takes the REWRITE route (`prompt_route: "rewritten"`, see "Prompt route"): pass the person's original instruction, if any, as `instruction` so it stays LOCKED.
2. If the retry also misses, call `suggest_edit(file, instruction, reason)` on the better of the two takes: `file` = its file name, `instruction` = one concrete corrective edit instruction (what to change and what to keep, max ~1000 chars), `reason` = one line on what is off (max ~300 chars). Report both takes in chat and stop. The tool is fire-and-forget: its result is a short confirmation, wait for nothing. A suggested fix the person sends from the Edit box is a person's explicit instruction: pass it through (`prompt_route: "verbatim"`) when it meets the Prompt route conditions.
3. Never retry more than once: a `-r2` take is never retried; its own miss goes straight to `suggest_edit`. A derived file from a sandbox command (crop, conversion, sheet) is not checked.

## Anchor (Picture 1) by intent

For multi-reference image workflows, the first image is the anchor — the model keeps its framing and look most faithfully. Choose it by intent:

- **EDIT intent** (change an existing image): the image being edited is the anchor — Picture 1, or the `subject`-style first image port. Other references (a person, an outfit, an object) follow as further pictures, and the prompt names them by the workflow's port labels.
- **COMPOSE intent** (build a NEW scene from references): the ENVIRONMENT (location / background image) is the anchor = Picture 1. People and objects fill the remaining reference slots in priority order.

Never anchor a composed scene on an outfit or character image.

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
6. If the workflow exposes LoRA slot parameters, consult `lora_index` and load matching LoRAs by their exact catalog name — only LoRAs whose base model family matches the workflow's, include the trigger word in the prompt, and leave slots unset when nothing compatible fits.
7. When the user asks for a verbatim/unmodified prompt or to skip drafting/enhancement, do not call `draft_prompt`/`enhance_prompt` — pass the prompt to `wf_xxx` exactly as given.
8. Decide the prompt route for every prompted `wf_xxx` call and pass `prompt_route` (`"verbatim"` or `"rewritten"`); a short, explicit, concrete instruction from the person is passed through, everything else is rewritten with the person's text in `instruction` (see "Prompt route").
9. Check every take you render and retry at most once, as in "Check, retry once, suggest"; place multi-reference images as in "Anchor (Picture 1) by intent".
