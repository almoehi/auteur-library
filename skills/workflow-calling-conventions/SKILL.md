---
name: workflow-calling-conventions
description: "Producing output files with wf_xxx workflow tools — correct call sequence, batch handling, and completion contract."
agentType: worker
---

# Rendering Output Files with Workflow Tools

## When to use this skill

Use this skill whenever your task asks you to render, shoot or produce output files like images, video frames, or other media by calling `wf_xxx` workflow tools. Workflow tools are listed in your available tools and start with the prefix `wf_`.

## Correct sequence

```
1. read_artifact(artifactId="<key>")     — load the work specification (shot list, prompts, etc.)
2. If the wf_xxx tool exposes LoRA slot parameters (see "LoRA lookup and loading" below):
       lora_index()                      — list the workspace LoRA catalog ONCE, pick most relevant candidates
3. For each shot or batch your task defines:
       wf_xxx(prompt="<description>")    — generate one shot or batch of output files
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

## Verbatim prompts — when NOT to draft or enhance

If the user or task explicitly asks to skip prompt drafting/enhancement, or to use their prompt verbatim / unmodified / exactly as written ("use this prompt as-is", "no prompt enhancement", "don't rewrite my prompt"), do **NOT** call `draft_prompt`, `review_prompt` or `enhance_prompt` — pass the given prompt string to `wf_xxx` unchanged, byte for byte.

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
6. If the workflow exposes LoRA slot parameters, consult `lora_index` and load matching LoRAs by their exact catalog name — only LoRAs whose base model family matches the workflow's, include the trigger word in the prompt, and leave slots unset when nothing compatible fits.
7. When the user asks for a verbatim/unmodified prompt or to skip drafting/enhancement, do not call `draft_prompt`/`enhance_prompt` — pass the prompt to `wf_xxx` exactly as given.
