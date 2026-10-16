---
name: workflow-calling-conventions
description: "Producing output files with wf_xxx workflow tools — correct call sequence, prompt writing (pass the person's own words through or draft with the prompt writer), batch handling, and completion contract."
agentType: all
---

# Rendering Output Files with Workflow Tools

Use this whenever your task asks you to render, shoot or produce media (images, frames, video) by calling `wf_xxx` workflow tools (listed in your tools, prefix `wf_`).

Worked examples (only if a call shape is unclear): load_skill workflow-calling-examples.

## Concise replies and task/artifact URIs

Keep every visible reply concise: a short summary of what was done and what happens next or what you need from the person - typically 1-4 short lines. Never restate plans, file lists, durations, workflow or skill names, slot counts, design descriptions, the shotlist or tool results unless asked - the details live in the task or artifact. Think silently; write only decisions. This covers chat replies and `task_complete` summaries (worker task descriptions stay as detailed as needed).

Mention every task or artifact as `task://<id>` / `artifact://<id>` (`artifact://<id>/<file>` for one file) with the runtime id from `create_task` / `create_artifact` / `artifact_index` / `task_index` (a key resolves too; the runtime id is preferred). The chat renders these as clickable chips; never use a bare key or file name instead.

## Reusing earlier values

A ⟦ref:r12.key⟧ in your earlier tool calls stands for a value you sent (call r12, argument key); to reuse it exactly pass the ⟦ref:…⟧ token (alone or inside a longer text) — never retype or copy a shortened value. Refs stay valid for the whole conversation; if one is refused, the error lists the refs that exist.

## Correct sequence

`read_artifact` the work spec -> (LoRA slots exposed: `lora_index()` once) -> per shot or batch write the prompt (see "Prompt route") and call `wf_xxx(prompt=...)` -> `task_complete` only AFTER every required call is done.

## LoRA lookup and loading

Only when the `wf_xxx` tool exposes LoRA slot parameters (`lora_1`, `style_lora`, ... each with an optional `lora_<port>_strength`); otherwise skip it and never call `lora_index`.

1. Call `lora_index()` once before the first render: name, description, default strength, **trigger words**, `modelFamily`.
2. Pick a candidate when its trigger word appears (or belongs) in the prompt or its description fits what the prompt asks for. **Its `modelFamily` must match the workflow's model family** (in the `wf_xxx` tool description; infer from name/description if absent) - a mismatched LoRA produces garbage and is rejected at call time, so leave it out.
3. Pass the **exact catalog name** as the slot parameter; never invent a name. **Trigger words**: for a drafted prompt, put them in the writer's `context` (it keeps them); for the person's verbatim text, put them at the very start or end of the prompt - the route check ignores the trigger words of the LoRAs selected on this call at those two places, nowhere else. Never edit a drafted prompt yourself. Omit the strength unless the task or catalog says otherwise.
4. An unset slot is always safe (built-in LoRAs still run). Never load a LoRA just because the catalog has one.
5. **Obey each LoRA's description** - it carries usage rules: "already baked into <workflow>: never select it there", a phrase the prompt must START with (tell the writer in `context`; never edit the draft), a trigger that renders as a watermark (leave it out unless the effect is missing), a lower strength when stacked, "edits well" / "text-to-image only".

### Prompt route — code decides, you do not state it

There is no `prompt_route` argument: code routes every prompted wf_xxx call. Its prompt is accepted only when it is (a) the unchanged OUTPUT of a prompt-writer tool of this task for the SAME workflow, or (b) the person's own text word for word (found unchanged in your task prompt or a person's chat message). Anything else — a prompt you typed or edited, or the person's text plus an added sentence — is refused (naming workflow and port): run draft_prompt, pass its prompt unchanged.

- **PASS THROUGH** only when ALL hold: it comes from the person (chat or studio); an explicit, concrete, short, unambiguous instruction that needs nothing adapted. Pass it VERBATIM and add nothing, not even a sentence naming the images. Do NOT call draft_prompt, review_prompt or enhance_prompt.
- **REWRITE with the prompt writer** for everything else (agent-derived briefs, long or vague requests, generation from text or references, any call with images, variations, retries). Pass the person's text in `instruction` (kept LOCKED). Pass the call's images as `image_inputs` (`[{ "port": "<input>", "ref": "artifact://<id>/<file>" }]`): code writes the "Picture N is <name>" lines, never write or number pictures yourself. Pass wording that must survive as `verbatim_phrases`: code appends any the writer drops.
- **Explicit overrides**: "use my words exactly" means pass through; "improve the prompt" means rewrite.

A task created with `prompt_writer: "skip"` passes its prompt as given (no draft needed). Details for the rewrite route:

- **`image_inputs`** (`draft_prompt` / `draft_prompts_batch`, per item): a list of `{port, ref}` (the workflow's input port name and the `artifact://` ref passed to it). The code writes the "Picture N is <name>" lines from the workflow's port labels and the artifact titles - never type or renumber Picture lines yourself.
- **`verbatim_phrases`**: phrases that must survive unchanged in the written prompt (a shot's `Act:` text in an NSFW workspace, dialogue to keep). The code appends any phrase the writer dropped.
- **Video clip duration**: for a video workflow (one whose duration parameter, e.g. `video_length`, the `wf_xxx` tool description names), pass `duration_seconds` (the clip's planned duration) to `draft_prompt` / `draft_prompts_batch` (per item) / `enhance_prompt` / `review_prompt` - it MUST equal the value you pass as the `wf_xxx` call's duration parameter; the prompt then states exactly that duration.
- **Batch prompt tools** (`draft_prompts_batch` / `enhance_prompts_batch` / `review_prompts_batch`): `items` is a real JSON array of objects, written out in full. When some items of a batch fail (e.g. a timeout), retry ONLY the failed items - never re-send the whole batch.

## Verbatim prompts - explicit override of Prompt route

When the user or task asks to skip drafting/enhancement or use the prompt verbatim ("use this prompt as-is", "no prompt enhancement"), do **NOT** call `draft_prompt`, `review_prompt` or `enhance_prompt`; pass the prompt to `wf_xxx` byte for byte (only addition allowed: a required LoRA trigger word at its very start or end, unless forbidden).

## Render size (`width` / `height`)

Do not pass `width` / `height` by default - the render profile (draft / preview / master) decides the size. Set them only when the story or shot needs a different format (e.g. a vertical smartphone clip inside the film, the storyboard's aspect ratio); the values you pass then override the profile's size.

To set only the orientation, pass `is_portrait` (`true` = portrait, `false` = landscape) on a `wf_*` tool that has it: the code turns the final size that way round (swapping `width` / `height`, scaled to fit the workflow's bounds) and tells you in the result when it changed the size. Omit it to keep the size as computed. An image-to-video call without it follows its first-frame image, so a clip never crops or stretches its keyframe.

## Output file routing

Each `wf_xxx` output is auto-routed to the declared file slot whose name matches the output port name (`portrait.png` <- port `portrait`). If one call yields several outputs of the same kind and the declared names do not map 1:1 to the ports, pass `output_ports={"<port>": "/workspace/<artifact_uuid>/<file>"}` explicitly. One call may produce one or more files; your task description says how many calls are needed.

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
- People: the number of people visible matches the request's Characters - nobody extra, nobody missing. A point-of-view (POV / first-person) shot shows its viewpoint character at most as hands or forearms, never their face or body.
- Setting: the furniture, props and location match the request's text (a lounger is not a chair, the named place is not another one).
- Outfits: every outfit the request lists is visible and as described; no listed garment is missing, no other garment replaces it.
- Moment: the image shows a single moment of the action, not a sequence.
- Act: only when the request has an "Act (must show)" line - the participants, their body positions and the contact points match it.
- Invented or contradicted: nothing was added that the request does not ask for, and nothing the request rules out is shown.
PASS when every point holds. Otherwise MISS. Be strict about what the request names and lenient about what it leaves open.
If you cannot judge the image (it is unreadable, or you decline), answer UNCHECKED with the reason - never guess PASS.
Answer in exactly this form:
VERDICT: PASS, MISS or UNCHECKED
FINDING: one line on what is missing, contradicted or invented (MISS), or why it cannot be judged (UNCHECKED)
FIX: one concrete corrective instruction - what to change and what to keep (MISS only)
```

A `match` needs no further call. On a `miss` (use its `fix`):

1. Retry ONCE: render again from the SAME source (not the missed take) as a NEW take named base + `-r2` (`take_wide-rain.png` -> `take_wide-rain-r2.png`; a skill owning the naming may define a variant). Keep the missed take. Batch several retries into ONE `draft_prompts_batch` and ONE render response. Keep the original medium/style and every lock VERBATIM and change only what the finding names (pass the original prompt in `context`); draft with the prompt writer, the person's original instruction as `instruction`.
2. If the retry also misses, call `suggest_edit(file, instruction, reason)` on the better take (`instruction`: one concrete corrective edit, what to change and keep, max ~1000 chars; `reason`: one line, max ~300). Report both takes and stop. It is fire-and-forget. A suggested fix the person sends from the Edit box is their explicit instruction: pass it through when it meets the pass-through conditions of "Prompt route".
3. Never retry a `-r2` take (its miss goes straight to `suggest_edit`); sandbox-derived files (crop, conversion, sheet) are not checked.

## Anchor (Picture 1) by intent

In multi-reference image workflows Picture 1 is the anchor (keeps framing and look best). **EDIT**: the image being edited is Picture 1, other references follow, named by the workflow's port labels. **COMPOSE** (new scene): the ENVIRONMENT image is Picture 1, then people/objects by priority. Never anchor a composed scene on an outfit or character image.

A ref2i (reference-to-image) prompt is a scene description naming the pictures by label, not an edit instruction.

## NSFW-marked workflows (content policy)

A workflow whose description starts with **[nsfw]** renders nudity and sex. Choose by the workspace content policy (`{workspace.contentPolicy.nudity}`; absent = forbidden), never by name:
- `forbidden`, or any shot / design depicting a minor (whatever the policy): never use an [nsfw] workflow (a forbidden workspace refuses them anyway).
- `allowed`, and the frame shows nudity or sex between adults: among workflows of the SAME capability prefer the [nsfw] one; capability still comes first (an [nsfw] edit never replaces a needed reference-to-image).
- **Explicit sex acts**: prefer an [nsfw] **reference-to-image** workflow - it composes the act directly from the place (Picture 1) and the characters (Pictures 2, 3), with a general NSFW LoRA (an act LoRA is optional). An [nsfw] multi-reference EDIT cannot produce an act (the people keep their reference poses); without a reference-to-image one use two steps: (1) render the act with the [nsfw] text-to-image workflow plus the act LoRA from the catalog (`lora_index`: missionary, blowjob, deepthroat, ...), describing the room of the location design; (2) put each character in with the [nsfw] multi-reference edit, ONE person per call (Picture 1 = the act frame, then the previous output; Picture 2 = that character's primary): "Replace the woman in image 1 with the adult woman from image 2 ... Leave the man unchanged. Keep the exact poses, camera angle, framing and room of image 1." Never pass two people as one picture for a swap. Frame people large: small figures in a wide shot barely take the identity.
- **NSFW LoRAs**: `design.json.loras` (planned by `plan-designs`) first, `lora_index` only for content they do not cover. A nudity EDIT (undressing, a swap step that must show a nude body) uses the catalog's image-edit nudity LoRA of the edit workflow's family (solo nudity only, never for an act). The "general NSFW LoRA" above is the planned one, else one from `lora_index`.
- Call every depicted person an adult in the prompt.

## Key rules

Call `wf_xxx` for every shot or batch your task defines, `task_complete` only afterwards (never after just reading the artifact); read artifacts with `read_artifact`; check every take, retry at most once.
