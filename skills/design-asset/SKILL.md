---
name: design-asset
description: >
  Use when your task is a design-studio design — a character, outfit or location keyed
  `<kind>_<name>` (e.g. "character_mira", "outfit_mira_raincoat", "location_harbor") — or the
  task prompt says "draft the design", "render the initial drafts", or the person asks in the
  design chat for a change ("make her older", "try a red jacket", "another angle"). Produces
  draft and take images inside the design artifact (`take_draft-<n>-<slug>.<ext>`, `take_<slug>.<ext>`, `take_view-<id>.<ext>`)
  for the person to pick from in the studio. Do NOT invoke for shooting scenes, storyboard designs
  (`storyboard_scene_<n>` — that is `storyboard-scene`), character/location sheets requested
  as their own task, writing `design.json`, or publishing or finishing a design.
agentType: worker
---

# Design Asset — draft and iterate on a studio design

The web studio owns the design (`design.json`, takes, primary, description, LoRAs, published files). You only put **images** into the design's artifact; the studio picks them up as takes. Contract: `release/DESIGN_GUIDE.md`. Replies: see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`.

## Hard rules

- Never write, overwrite, rename or delete `design.json`; read it only (`read_artifact(artifactId="<task id>")`, ONCE per turn; never copy or restate it).
- Never write published names (`full_body_shot.*`, `sheet.*`, `view_*`; `take_view-<id>.*` takes are fine).
- File names are flat (no `/`) and unique; every render is a NEW take (never reuse a name or overwrite):
  - Drafts: `take_draft-<n>-<slug>.<ext>`, n = 1 … `initialDrafts`.
  - Chat-phase takes: `take_<slug>.<ext>`.
  - View takes: `take_view-<id>.<ext>` (Phase 3b); no other slug starts with `view-`.
  - slug = a few lowercase hyphenated words naming the content, `[a-z0-9]+(-[a-z0-9]+)*`, no `_`; never generic or numbered.
  - Name taken (in the artifact or earlier in this conversation, discarded takes included): append `-2`, `-3` ….
  - Derived takes (conversion, crop, composite) get a new slug, never the source's base name with another extension.
- Write takes to `/workspace/<artifact id>/<file name>`: images via `wf_*` tools with `output_ports`; derived files via sandbox CLI (ImageMagick, ffmpeg, PIL). Never claim a file done unless it is there. Sources: `artifact://` refs ("Artifact-backed inputs" in `workflow-calling-conventions`).
- One render per take; leave `seed` default; no batches.
- Write each file in one go; never rewrite it within the same attempt (the write-once guard ends the loop).

## Phase 1 — Preflight

1. `read_artifact(artifactId="<task id>")` -> artifact id, existing files, `design.json` (attributes, `displayName`, `links`, `loras`, `initialDrafts`).
2. Extract:
   - attributes (character: hair, age, build, wardrobe, mood - NOT `voice`: a character's `voice` is heard, never pictured, so it goes into no prompt, request or check; the finish records the voice sample from it; location: place, space, era, time of day, weather, and for a set `set`, `set_style`, `connections`);
   - a location with a `set_anchor` link is a SET MEMBER ("Sets" in `plan-designs`): the prompt's "Referenced designs" block carries the anchor's `full_body_shot:` ref (`artifact://<id>/full_body_shot.<ext>`); without that ref (anchor not finished) or without a reference-compose tool, draft with text-to-image from `set_style` + `connections` and say so in the hand-over;
   - `initialDrafts` (the task states it; default 1) and extension (default `png`);
   - workflow, by CAPABILITY (per tool description / `get_workflow_instructions`): the one the prompt names if it is among your `wf_*` tools, else the text-to-image tool whose model family matches the prompt or `design.json`.
   - Outfit (or any design drafted as edits of a linked design's full-body shot): an image-edit (`i2i`) workflow, never text-to-image; the first image input is the `full_body_shot:` ref (`artifact://<id>/full_body_shot.<ext>`) from the prompt's "Referenced designs" block.
3. Empty attributes, no suitable `wf_*` tool, or (outfit) no image-edit tool / no `full_body_shot:` line -> render nothing, never guess, never fall back to text-to-image for an outfit (it invents a different person); `task_complete` saying exactly what is missing (it hands the design to the person in the studio with what exists).

## Phase 1b — Curate LoRAs (first step of the take planner)

Before any `wf_*` render: run "Curated LoRAs" of `workflow-calling-conventions` for this design. Call `lora_index()`, pick the up to 8 LoRAs most relevant to the design, inferred from each LoRA's name and description: a character design (a character LoRA for the person, body / skin detail), an outfit design (clothing, fabric and garment LoRAs), a location design (environment, architecture, lighting LoRAs), and for every kind the style / look LoRAs (`{workspace.story.plot}`), camera / lens and nudity-state LoRAs as the design needs. Every `design.json.loras` entry is a pick the person made explicitly in the studio: it ranks FIRST, your additions follow, most relevant first. Keep the list for the whole task; a LoRA the workflow already loads itself is skipped automatically by the render. This curated list goes on EVERY `wf_*` render of the design (drafts, retries, edits, variations).

## Phase 2 — Write the prompt

1. `get_workflow_instructions(<workflow>)`, read fully. Follow "Prompt route" of `workflow-calling-conventions` for every prompted `wf_*` call: a user-typed chat edit is a pass-through candidate (person's words verbatim); attributes, initial drafts, retries, diversity variations use `draft_prompt` (pass `image_inputs`).
2. The prompt writer applies `prompt-writer-<family>` itself (without `draft_prompt`, `load_skill` it). `draft_prompt(<workflow>, <context>)`: ONE prompt serves all `initialDrafts`. Several DIFFERENT prompts at once: ONE `draft_prompts_batch` in one round, at most one `review_prompts_batch`; no per-prompt loops, no repeat batch.
3. `context` is short: all attributes, the design kind and the goal "a clean, well-lit reference image of one subject":
   - character: full body or three-quarter, neutral pose, plain background, face clearly visible;
   - outfit: an edit instruction dressing the person of the linked character's full-body shot in the outfit (face, hair, body unchanged), full body;
   - location: a WIDE establishing view of ONE space, not a close plate of a surface (no bare wall, door or floor filling the frame):
     - show at least one stated `connections` opening (a doorway, glass doors, a gate, a window onto the neighbouring space) and the set's signature materials (`set_style`); an interior is shot from a corner so the doorway is in frame, an exterior wide enough to show the building or boundary it belongs to;
     - set member: ONE reference-compose (`ref2i`) draft with the anchor's `full_body_shot` as Picture 1 ("Anchor (Picture 1) by intent", "turning the camera" in `workflow-calling-conventions`): "Picture 1 is <anchor name>, another space of the SAME property: same materials, frames, palette and era. Render <this place>, a different space; show the openings listed in connections." The finished anchor's picture / description is authoritative over the `set_style` text where they differ.
   - A person's prompt (character, and outfit where a person is shown) puts the identity traits that tell them apart from the other characters FIRST (face, hair, skin, build), before framing, pose and style text; a retry or edit keeps them first and never drops them.
   - Never restate design descriptions or what reference images show; keep named attributes verbatim; add no characters, props or text not asked for.
   - Carry the workspace medium / style (`{workspace.story.plot}`; "Medium / style is kept" in `workflow-calling-conventions`) verbatim. "Clean reference image" is composition, never a photographic medium.
4. Nudity follows `{workspace.contentPolicy.nudity}` (absent or empty = forbidden); a minor is ALWAYS `forbidden`:
   - `forbidden`: people fully clothed (the `wardrobe` attribute, else simple everyday clothing); put `nudity, nude, naked` in the negative prompt (the workflow's negative-prompt port, default text first) in EVERY render of a person, chat edits and variations included. This is the authority for the nudity negative.
   - `allowed`: follow the brief; add no clothing or nudity negative of your own.
     - Character design: per its `wardrobe` (decided in `plan-designs`, "Characters and outfits"): `nude` = fully nude, full body, neutral standing pose facing the camera, plain backdrop, face visible, no garments, no covering hands or props, complete natural anatomy, rendered with the [nsfw] text-to-image workflow ("NSFW-marked workflows" in `workflow-calling-conventions`); `none` = no garments or accessories, natural appearance, never render the word; anything else = the plain neutral clothing named.
     - Outfit: edit of the linked character's full-body shot with exactly the outfit's garments, face / hair / body / skin unchanged; [nsfw] image-edit workflow only when the outfit itself leaves nudity visible (lingerie, open robe).
5. Kinds without people (locations, props, any kind depicting no people): describe the subject positively as empty ("an empty, uninhabited <place>"); no negated people in the positive prompt (negated terms are weak in these models: naming people, even to exclude them, tends to summon them; the same holds for "nobody else" in a shot — state counts, never names to exclude); put `people, person, human figure, crowd` in the negative prompt (default text first), in every render including edits and variations.
6. LoRAs: pass the curated list of Phase 1b (it includes every `design.json.loras` entry) on the lora ports of EVERY `wf_*` render: the entries whose `modelFamily` matches the workflow, in rank order, up to the workflow's lora ports, each with its `strength` and its trigger words in `context`; other families are skipped (say so in the summary).

## Phase 3 — Render the drafts

- Issue ALL `initialDrafts` calls in ONE response (they render in parallel), n = 1 … `initialDrafts`:
  `wf_<workflow>(prompt_positive="<prompt>", …, output_ports={"<primary output port>": "/workspace/<artifact id>/take_draft-<n>-<slug>.png"})`
- Same prompt for every draft; the seed varies them. Clear alternatives in the attributes ("short or long hair") may vary exactly that phrase across drafts (say so).
- Outfit: each call passes the prompt's `full_body_shot:` ref as the image input and the edit instruction as the prompt.
- A failed draft fails only itself: re-read instructions, fix, retry that draft once (same name); still failing -> leave it (the studio shows a failed take with Retry) and report it.

## Phase 3b — Named views (only when `design.json.attributes` has `views`)

Runs after the drafts rendered (and checked), before `run_checks` / hand-over. `views` = comma-joined entries, at most 6: for a location camera directions ("facing the pool"), for a character / outfit poses and expressions ("kneeling", "laughing"). Make ONE view take per entry, all renders in one response, each from the BEST draft (the one the checks matched; else the first): it is Picture 1 / the source.

- File: `take_view-<id>.png`; `<id>` = the entry as a slug (lowercase, spaces and punctuation to `-`, starts with a letter, at most 40 chars, never all digits; "facing the pool" -> `facing-the-pool`; "facing the pool (right 90°)" -> `facing-the-pool-right-90`). Retry: `take_view-<id>-r2.png`. The studio reads view and kind from the name; write nothing else for it. (Contract: `release/DESIGN_GUIDE.md` "Named views".)
- Location (a direction): the TURN is the one the entry states in parentheses ("facing the pool (right 90°)" -> right, 90°; 45° is a quarter turn); an entry without a stated turn is composed from its words alone. A NEW composition from the draft as Picture 1, by "turning the camera" in `workflow-calling-conventions` (a known turn of at most 90° uses the camera-turn tool when the workspace has one, else reference-compose). Prompt: the same place and attributes seen from the new direction, the camera turned to face it; keep `connections` true (an opening on that side shows its neighbour) and, for a set member, add the anchor's picture as a further reference; say what is behind the camera when the attributes or beats tell; empty place, no people (Phase 2 step 5).
- A view that is a REVERSE (about 180°, "the other side of the property") is a gap, not a view: do not invent it; skip that entry and report it in the hand-over (`plan-designs` plans it as a sibling set location).
- Character / outfit (a pose or expression): an image EDIT (`i2i`) of the draft: change only the pose / facial expression; keep the face, hair, skin, body and (outfit) every garment exactly. Outfit: also dressed as in the draft.
- Check each (below) with `request` = "<design name> seen <entry>" / "<design name> <entry>", `references` = `[{ref: the draft, label: <design name>}]` (a set member or anchor: plus `{ref: the anchor's full_body_shot, label: <anchor name>}`): a location must be the very same place as the draft seen from that direction (same materials, shared features, light, time of day; the same view as the draft is a miss), a person the same person (face, hair, build, skin, age; for an outfit the same garments) in the asked pose / expression. Retry once, then `suggest_edit`.
- Tell the person in the hand-over: the views follow that draft; if they pick another primary, the studio's "Re-make from primary" renders them again.

## Check, retry once, suggest

- Every rendered take follows "Check, retry once, suggest" of `workflow-calling-conventions`.
- Set member (location with `set_anchor`): `check_take` `references` always include `{ref: the anchor's full_body_shot, label: <anchor name>}` and the `request` adds: "another space of the same property as <anchor name>: same architecture, materials, palette, era, a different space (not the same view), and the openings listed in connections hold". A miss is retried once, then `suggest_edit`.
- Retry naming: base + `-r2` (`take_profile-closeup.png` -> `take_profile-closeup-r2.png`); for a draft `take_draft-<k>-<slug>.<ext>` -> `take_<slug>-draft-<k>-r2.<ext>` (must NOT start with `take_draft-`).

## Phase 4 — Hand over

- Kickoff lists checks that gate this design: you MUST call `run_checks` before `task_complete` and fix every listed problem (a rejection after completing wastes the attempt; "Checks that gate the task" in `workflow-calling-conventions`).
- Audit:
  - every `take_draft-<n>-<slug>.<ext>` exists (re-read the artifact), except drafts that failed twice (name them); every `views` entry has its `take_view-<id>.<ext>` (Phase 3b), reverse entries named as a gap;
  - no other file written; `design.json` untouched;
  - every take checked with `check_take` (file + its request); at most one retry per take; `suggest_edit` exactly for takes whose retry also missed;
  - drafts came from `wf_*` renders (sandbox-derived files only in the chat phase).
- `task_complete(summary="Rendered N drafts of <displayName>.")` (1-3 lines, no prompt / workflow restated; call it again after the self-review). This hands the design to the person; it does not finish it.

## Phase 5 — Chat (per request)

Every message after the hand-over is the person's new request: a described change, correction or reference image ("use artifact://… as reference", "the wall forms a corner") asks for a NEW take made with it — render it (steps below). Never answer with the drafting status ("drafts rendered", "task goal met").

1. `read_artifact` again; a take you rendered earlier that is gone was discarded on purpose: never re-render it.
2. Source image: the take the person names, else the primary (`primaryTakeId`), else the newest. Pass `artifact://<artifact id>/<file name>` to `describe_image`, `check_take`, `sandbox_fetch`.
3. Pick the workflow by what changes. A new angle, viewpoint, re-framing or "show another part of the place" is a NEW COMPOSITION: render a NEW take from the reference(s) with a reference-compose (`ref2i`) or text-to-image workflow - an in-place editor returns the source unchanged. In-place editors are only for changes inside the existing frame (colour, material, object, garment, expression, lighting, small pose). Change to an existing image ("older", "red jacket", a reference image to follow) -> an `i2i` `wf_*` tool (prefer fitting `capabilities`, e.g. `multi-reference-edit`); instruction via `draft_prompt` (several edits in one message: ONE `draft_prompts_batch`, then all renders in one response); source first, extra references next, named by each input's `label` / `reference_role` (`subject` = the image being edited); anchoring per "Anchor (Picture 1) by intent". "Start over / completely different" -> text-to-image as in Phase 2.
   - A reference image the person names ("use artifact://… as reference", a design of the "Referenced designs" block) is an EXTRA input, never the source: Picture 1 (`subject`) stays THIS design's take from step 2, the reference goes into the next image input (Picture 2), so pick an `i2i` workflow with a second image input. Never render from the referenced image alone - an edit of it returns that other design, not a take of this one. Pass both images in `draft_prompt`'s `image_inputs` and say in `context` what to take from the reference (setting, layout, look) and what to keep of this design.
4. Render only what THIS message asks: one take unless it gives a count; never redo earlier requests; one take per variant to `take_<slug>.<ext>`; check every take. Reply with one short line (new take name(s), what changed), then stop.
5. Never pick a primary, discard takes, write descriptions or finish the design: tell the person to use ★ / 🗑 / Describe / Finish design in the studio.
