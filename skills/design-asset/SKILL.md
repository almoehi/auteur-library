---
name: design-asset
description: >
  Use when your task is a design-studio design — a character, outfit or location keyed
  `<kind>_<name>` (e.g. "character_mira", "outfit_mira_raincoat", "location_harbor") — or the
  task prompt says "draft the design", "render the initial drafts", or the person asks in the
  design chat for a change ("make her older", "try a red jacket", "another angle"). Produces
  draft and take images inside the design artifact (`take_draft-<n>-<slug>.<ext>`, `take_<slug>.<ext>`)
  for the person to pick from in the studio. Do NOT invoke for shooting scenes, storyboard designs
  (`storyboard_scene_<n>` — that is `storyboard-scene`), character/location sheets requested
  as their own task, writing `design.json`, or publishing or finishing a design.
agentType: worker
---

# Design Asset — draft and iterate on a studio design

The web studio owns the design (`design.json`, takes, primary, description, LoRAs, published files). You only put **images** into the design's artifact; the studio picks them up as takes. Contract: `release/DESIGN_GUIDE.md`. Replies: see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`.

## Hard rules

- Never write, overwrite, rename or delete `design.json`; read it only (`read_artifact(artifactId="<task id>")`, ONCE per turn; never copy or restate it).
- Never write published names (`full_body_shot.*`, `sheet.*`, `view_*`).
- File names are flat (no `/`) and unique; every render is a NEW take (never reuse a name or overwrite):
  - Drafts: `take_draft-<n>-<slug>.<ext>`, n = 1 … `initialDrafts`.
  - Chat-phase takes: `take_<slug>.<ext>`.
  - slug = a few lowercase hyphenated words naming the content, `[a-z0-9]+(-[a-z0-9]+)*`, no `_`; never generic or numbered.
  - Name taken (in the artifact or earlier in this conversation, discarded takes included): append `-2`, `-3` ….
  - Derived takes (conversion, crop, composite) get a new slug, never the source's base name with another extension.
- Write takes to `/workspace/<artifact id>/<file name>`: images via `wf_*` tools with `output_ports`; derived files via sandbox CLI (ImageMagick, ffmpeg, PIL). Never claim a file done unless it is there. Sources: `artifact://` refs ("Artifact-backed inputs" in `workflow-calling-conventions`).
- One render per take; leave `seed` default; no batches.
- Write each file in one go; never rewrite it within the same attempt (the write-once guard ends the loop).

## Phase 1 — Preflight

1. `read_artifact(artifactId="<task id>")` -> artifact id, existing files, `design.json` (attributes, `displayName`, `links`, `loras`, `initialDrafts`).
2. Extract:
   - attributes (character: hair, age, build, wardrobe, mood; location: place, era, time of day, weather);
   - `initialDrafts` (the task states it; default 1) and extension (default `png`);
   - workflow, by CAPABILITY (per tool description / `get_workflow_instructions`): the one the prompt names if it is among your `wf_*` tools, else the text-to-image tool whose model family matches the prompt or `design.json`.
   - Outfit (or any design drafted as edits of a linked design's full-body shot): an image-edit (`i2i`) workflow, never text-to-image; the first image input is the `full_body_shot:` ref (`artifact://<id>/full_body_shot.<ext>`) from the prompt's "Referenced designs" block.
3. Empty attributes, no suitable `wf_*` tool, or (outfit) no image-edit tool / no `full_body_shot:` line -> render nothing, never guess, never fall back to text-to-image for an outfit (it invents a different person); `task_complete` saying exactly what is missing (it hands the design to the person in the studio with what exists).

## Phase 2 — Write the prompt

1. `get_workflow_instructions(<workflow>)`, read fully. Follow "Prompt route" of `workflow-calling-conventions` for every prompted `wf_*` call: a user-typed chat edit is a pass-through candidate (person's words verbatim); attributes, initial drafts, retries, diversity variations use `draft_prompt` (pass `image_inputs`).
2. The prompt writer applies `prompt-writer-<family>` itself (without `draft_prompt`, `load_skill` it). `draft_prompt(<workflow>, <context>)`: ONE prompt serves all `initialDrafts`. Several DIFFERENT prompts at once: ONE `draft_prompts_batch` in one round, at most one `review_prompts_batch`; no per-prompt loops, no repeat batch.
3. `context` is short: all attributes, the design kind and the goal "a clean, well-lit reference image of one subject":
   - character: full body or three-quarter, neutral pose, plain background, face clearly visible;
   - outfit: an edit instruction dressing the person of the linked character's full-body shot in the outfit (face, hair, body unchanged), full body;
   - location: an establishing wide shot.
   - Never restate design descriptions or what reference images show; keep named attributes verbatim; add no characters, props or text not asked for.
   - Carry the workspace medium / style (`{workspace.story.plot}`; "Medium / style is kept" in `workflow-calling-conventions`) verbatim. "Clean reference image" is composition, never a photographic medium.
4. Nudity follows `{workspace.contentPolicy.nudity}` (absent or empty = forbidden); a minor is ALWAYS `forbidden`:
   - `forbidden`: people fully clothed (the `wardrobe` attribute, else simple everyday clothing); put `nudity, nude, naked` in the negative prompt (the workflow's negative-prompt port, default text first) in EVERY render of a person, chat edits and variations included. This is the authority for the nudity negative.
   - `allowed`: follow the brief; add no clothing or nudity negative of your own.
     - Character design: per its `wardrobe` (decided in `plan-designs`, "Characters and outfits"): `nude` = fully nude, full body, neutral standing pose facing the camera, plain backdrop, face visible, no garments, no covering hands or props, complete natural anatomy, rendered with the [nsfw] text-to-image workflow ("NSFW-marked workflows" in `workflow-calling-conventions`); `none` = no garments or accessories, natural appearance, never render the word; anything else = the plain neutral clothing named.
     - Outfit: edit of the linked character's full-body shot with exactly the outfit's garments, face / hair / body / skin unchanged; [nsfw] image-edit workflow only when the outfit itself leaves nudity visible (lingerie, open robe).
5. Kinds without people (locations, props, any kind depicting no people): describe the subject positively as empty ("an empty, uninhabited <place>"); no negated people in the positive prompt (negated terms are weak in these models: naming people, even to exclude them, tends to summon them; the same holds for "nobody else" in a shot — state counts, never names to exclude); put `people, person, human figure, crowd` in the negative prompt (default text first), in every render including edits and variations.
6. LoRAs: pass EVERY `design.json.loras` entry whose `modelFamily` matches the workflow on its lora ports with its `strength`, and its trigger words in `context`; other families are skipped (say so in the summary). Also pass a `lora_index` LoRA (same family) whose trigger word the attributes contain.

## Phase 3 — Render the drafts

- Issue ALL `initialDrafts` calls in ONE response (they render in parallel), n = 1 … `initialDrafts`:
  `wf_<workflow>(prompt_positive="<prompt>", …, output_ports={"<primary output port>": "/workspace/<artifact id>/take_draft-<n>-<slug>.png"})`
- Same prompt for every draft; the seed varies them. Clear alternatives in the attributes ("short or long hair") may vary exactly that phrase across drafts (say so).
- Outfit: each call passes the prompt's `full_body_shot:` ref as the image input and the edit instruction as the prompt.
- A failed draft fails only itself: re-read instructions, fix, retry that draft once (same name); still failing -> leave it (the studio shows a failed take with Retry) and report it.

## Check, retry once, suggest

- Every rendered take follows "Check, retry once, suggest" of `workflow-calling-conventions`.
- Retry naming: base + `-r2` (`take_profile-closeup.png` -> `take_profile-closeup-r2.png`); for a draft `take_draft-<k>-<slug>.<ext>` -> `take_<slug>-draft-<k>-r2.<ext>` (must NOT start with `take_draft-`).

## Phase 4 — Hand over

- Kickoff lists checks that gate this design: you MUST call `run_checks` before `task_complete` and fix every listed problem (a rejection after completing wastes the attempt; "Checks that gate the task" in `workflow-calling-conventions`).
- Audit:
  - every `take_draft-<n>-<slug>.<ext>` exists (re-read the artifact), except drafts that failed twice (name them);
  - no other file written; `design.json` untouched;
  - every take checked with `check_take` (file + its request); at most one retry per take; `suggest_edit` exactly for takes whose retry also missed;
  - drafts came from `wf_*` renders (sandbox-derived files only in the chat phase).
- `task_complete(summary="Rendered N drafts of <displayName>.")` (1-3 lines, no prompt / workflow restated; call it again after the self-review). This hands the design to the person; it does not finish it.

## Phase 5 — Chat (per request)

Every message after the hand-over is the person's new request: a described change, correction or reference image ("use artifact://… as reference", "the wall forms a corner") asks for a NEW take made with it — render it (steps below). Never answer with the drafting status ("drafts rendered", "task goal met").

1. `read_artifact` again; a take you rendered earlier that is gone was discarded on purpose: never re-render it.
2. Source image: the take the person names, else the primary (`primaryTakeId`), else the newest. Pass `artifact://<artifact id>/<file name>` to `describe_image`, `check_take`, `sandbox_fetch`.
3. Change to an existing image ("older", "red jacket", a reference image to follow) -> an `i2i` `wf_*` tool (prefer fitting `capabilities`, e.g. `multi-reference-edit`); instruction via `draft_prompt` (several edits in one message: ONE `draft_prompts_batch`, then all renders in one response); source first, extra references next, named by each input's `label` / `reference_role` (`subject` = the image being edited); anchoring per "Anchor (Picture 1) by intent". "Start over / completely different" -> text-to-image as in Phase 2.
   - A reference image the person names ("use artifact://… as reference", a design of the "Referenced designs" block) is an EXTRA input, never the source: Picture 1 (`subject`) stays THIS design's take from step 2, the reference goes into the next image input (Picture 2), so pick an `i2i` workflow with a second image input. Never render from the referenced image alone - an edit of it returns that other design, not a take of this one. Pass both images in `draft_prompt`'s `image_inputs` and say in `context` what to take from the reference (setting, layout, look) and what to keep of this design.
4. Render only what THIS message asks: one take unless it gives a count; never redo earlier requests; one take per variant to `take_<slug>.<ext>`; check every take. Reply with one short line (new take name(s), what changed), then stop.
5. Studio asks to assemble given takes into a sheet ("Assemble exactly these takes … Save it as /workspace/<artifact id>/<file name>"): ONE sandbox command (ImageMagick `montage` / `convert` or PIL), listed takes in listed order, no text / labels / borders beyond a thin uniform gap, same height per row, written to the given name; no `wf_*` render, no other file, no prompt writing; reply with the file name only.
6. Never pick a primary, discard takes, write descriptions or finish the design: tell the person to use ★ / 🗑 / Describe / Finish design in the studio.
