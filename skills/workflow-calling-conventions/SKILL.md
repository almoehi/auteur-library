---
name: workflow-calling-conventions
description: "Producing output files with wf_xxx workflow tools — correct call sequence, prompt route (pass the person's instruction through or rewrite it), batch handling, and completion contract."
agentType: all
---

# Rendering Output Files with Workflow Tools

Use this whenever your task asks you to render, shoot or produce media (images, frames, video) by calling `wf_xxx` workflow tools (listed in your tools, prefix `wf_`).

Worked examples (only if a call shape is unclear): load_skill workflow-calling-examples.

## Short visible replies

Keep every visible reply short: what you do next and why, in at most a few lines. Never restate plans you already made, skill or workflow text, design descriptions, the shotlist, or tool results — they are already in the conversation. Think silently; write only decisions. Final summaries: at most ~10 lines.

## Reusing earlier values

A ⟦ref:r12.key⟧ in your earlier tool calls stands for a value you sent (call r12, argument key); to reuse it exactly pass the ⟦ref:…⟧ token (alone or inside a longer text) — never retype or copy a shortened value. Refs stay valid for the whole conversation; if one is refused, the error lists the refs that exist.

## Correct sequence

`read_artifact` the work spec -> (LoRA slots exposed: `lora_index()` once) -> per shot or batch decide the prompt route and call `wf_xxx(prompt=..., prompt_route="verbatim" | "rewritten")` -> `task_complete` only AFTER every required call is done.

## LoRA lookup and loading

Only when the `wf_xxx` tool exposes LoRA slot parameters (`lora_1`, `style_lora`, ... each with an optional `lora_<port>_strength`); otherwise skip it and never call `lora_index`.

1. Call `lora_index()` once before the first render: name, description, default strength, **trigger words**, `modelFamily`.
2. Pick a candidate when its trigger word appears (or belongs) in the prompt or its description fits what the prompt asks for. **Its `modelFamily` must match the workflow's model family** (in the `wf_xxx` tool description; infer from name/description if absent) - a mismatched LoRA produces garbage and is rejected at call time, so leave it out.
3. Pass the **exact catalog name** as the slot parameter; never invent a name. **Put the trigger word in the prompt.** Omit the strength unless the task or catalog says otherwise.
4. An unset slot is always safe (built-in LoRAs still run). Never load a LoRA just because the catalog has one.

### Prompt route — pass the person's instruction through, or rewrite it

Decide for EVERY prompted wf_xxx call and state the decision with the `prompt_route` argument (`"verbatim"` or `"rewritten"`).

- **PASS THROUGH (`prompt_route: "verbatim"`)** only when ALL of these hold: the text comes from the person (chat or studio); it is an explicit, concrete instruction (an imperative change or motion); it is short (about 300 characters or a few clauses); it states what and where without ambiguity; nothing needs adapting to the workflow beyond naming the supplied images. Then the prompt is the person's text VERBATIM, plus one sentence naming the supplied images by the workflow's port labels (for example "Picture 1 is the frame to edit; Picture 2 is Detective Raccoon (outfit).") and at most ONE short keep clause, only if the person did not say what to keep. Do NOT call draft_prompt, review_prompt or enhance_prompt.
- **REWRITE with the prompt writer (`prompt_route: "rewritten"`)** for agent-derived briefs (scene lists, shotlists, design attributes, initial drafts), long, unstructured or vague requests, text-to-image and text-to-video generation, diversity variations and automatic retries after a miss. Pass the person's text, if any, in the `instruction` argument of draft_prompt / enhance_prompt / review_prompt (never only inside `context`): the prompt writer keeps it LOCKED.
- **Explicit overrides**: "use my words exactly" means pass through; "improve the prompt" means rewrite.
- **Batch prompt tools** (`draft_prompts_batch` / `enhance_prompts_batch` / `review_prompts_batch`): `items` is a real JSON array of objects, written out in full. When some items of a batch fail (e.g. a timeout), retry ONLY the failed items - never re-send the whole batch.

## Verbatim prompts - explicit override of the Prompt route

When the user or task asks to skip drafting/enhancement or use the prompt verbatim ("use this prompt as-is", "no prompt enhancement"), do **NOT** call `draft_prompt`, `review_prompt` or `enhance_prompt`; pass the prompt to `wf_xxx` byte for byte (only addition allowed: a required LoRA trigger word, unless forbidden).

## Output file routing

Each `wf_xxx` output is auto-routed to the declared file slot whose name matches the output port name (`pose_front.png` <- port `pose_front`). If one call yields several outputs of the same kind and the declared names do not map 1:1 to the ports, pass `output_ports={"<port>": "/workspace/<artifact_uuid>/<file>"}` explicitly. One call may produce one or more files; your task description says how many calls are needed.

## Artifact-backed inputs (reference images, source video)

Pass `artifact://<artifactId>/<fileKey>` directly as the input-port argument (UUID from `artifact_index`, exact filename from the task). Do NOT call `get_artifact_url` or download into the sandbox for this. Every file-URL tool (`describe_image`, `sandbox_fetch`, `get_video_info`, `wf_xxx` ports) accepts the same `artifact://` ref. **Never copy, retype or shorten a URL** (a dropped character gives a 403 that looks like expiry); for shell commands paste only the short `url` of `get_artifact_url` (`curl -L`). Plain http(s) is for external sources only.

## Medium / style is kept

The stated medium/style (comic, watercolor, anime, 3D render, ...) lives in `{workspace.story.plot}` (the "Workspace facts" block) and the design brief. Carry it VERBATIM into the `context` of every `draft_prompt` / `draft_prompts_batch` / `enhance_prompt` (inside the locked `instruction` when the person gave it). A take in a different medium is a MISS.

## Check, retry once, suggest

Applies to EVERY take you render with a `wf_xxx` tool (drafts, chat edits, re-renders); skills that render takes reference this section and add only their naming. Never re-check a take you did not render (the studio server checks takes made with its buttons).

Verify each take with `check_take(file, request)` (batch one round's checks in one response): `file` is the take's file name in the design artifact (or its `artifact://<artifactId>/<file>` ref), `request` is REQUIRED - what the take was asked to show (the render prompt you used, or the person's instruction); a check without it cannot be judged. The tool judges with the rubric below (the server uses the byte-identical text - do not reword it) and returns `{verdict: "match" | "miss" | "unchecked", finding, fix}`. `unchecked` means the judge failed: say so, never treat it as a match. `describe_image` stays for general description, not for take checks.

```
Check the image against the request. Judge only what can be seen in the image; ignore story, motives, dialogue and anything that is not visual.
- Subjects: every subject the request names is present and recognisable.
- Changes: every change the request asks for is visible, and nothing else was changed.
- Composition: framing, camera angle, layout and positions match the request.
- Single image: one continuous scene - no panels, split screen, collage, grid or several versions of the subject, unless the request asks for a sheet / turnaround.
- Style: the requested medium and style (the request's, else the workspace's stated style) are kept. An image in a different medium or style than requested (photoreal instead of comic, a render instead of a painting) is a MISS.
- Invented or contradicted: nothing was added that the request does not ask for, and nothing the request rules out is shown.
PASS when every point holds. Otherwise MISS. Be strict about what the request names and lenient about what it leaves open.
Answer in exactly this form:
VERDICT: PASS or MISS
FINDING: one line on what is missing, contradicted or invented (MISS only)
FIX: one concrete corrective instruction - what to change and what to keep (MISS only)
```

A `match` needs no further call. On a `miss` (use its `fix`):

1. Retry ONCE: render again from the SAME source (not the missed take) as a NEW take named base + `-r2` (`take_wide-rain.png` -> `take_wide-rain-r2.png`; a skill owning the naming may define a variant). Keep the missed take. Batch several retries into ONE `draft_prompts_batch` and ONE render response. Keep the original medium/style and every lock VERBATIM and change only what the finding names (pass the original prompt in `context`); REWRITE route, the person's original instruction as `instruction`.
2. If the retry also misses, call `suggest_edit(file, instruction, reason)` on the better take (`instruction`: one concrete corrective edit, what to change and keep, max ~1000 chars; `reason`: one line, max ~300). Report both takes and stop. It is fire-and-forget. A suggested fix the person sends from the Edit box is their explicit instruction: pass it through (`prompt_route: "verbatim"`) when it meets the Prompt route conditions.
3. Never retry a `-r2` take (its miss goes straight to `suggest_edit`); sandbox-derived files (crop, conversion, sheet) are not checked.

## Anchor (Picture 1) by intent

In multi-reference image workflows Picture 1 is the anchor (keeps framing and look best). **EDIT**: the image being edited is Picture 1, other references follow, named by the workflow's port labels. **COMPOSE** (new scene): the ENVIRONMENT image is Picture 1, then people/objects by priority. Never anchor a composed scene on an outfit or character image.

A ref2i (reference-to-image) prompt is a scene description naming the pictures by label, not an edit instruction.

## Key rules

Call `wf_xxx` for every shot or batch your task defines, `task_complete` only afterwards (never after just reading the artifact); read artifacts with `read_artifact`; set `prompt_route` on every prompted call; check every take, retry at most once.
