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

A design is an ordinary `llm+hitl` task plus one open artifact, both keyed `<kind>_<name>`
(`character_mira`). The **web studio owns the design**: its `design.json` (attributes, takes,
primary, description, LoRAs) and every published file (`primary.*`, `sheet.*`, `view_*`). You only
put **images** into the artifact; the studio picks them up as takes. Contract reference:
`release/DESIGN_GUIDE.md`. Keep visible replies concise: see "Concise replies and task/artifact URIs" in
`workflow-calling-conventions`.

## Hard rules

1. **Never write, overwrite, rename or delete `design.json`** — read it only
   (`read_artifact(artifactId="<task id>")`, ONCE per turn, compactly: never copy or restate the
   document, takes history or file lists; later reads return a server-side compact digest).
2. **Never write published names** (`primary.*`, `sheet.*`, `view_*`).
3. **File names are flat** — no `/`. Drafts: `take_draft-<n>-<slug>.<ext>` (n = 1 … initialDrafts;
   slug = a few lowercase hyphenated words naming the content, `[a-z0-9]+(-[a-z0-9]+)*`, no `_`).
   Chat-phase takes: `take_<slug>.<ext>` — slug summarizes what the take shows or the change
   (`take_profile-closeup-laughing.png`); never generic or numbered. Names are unique: append
   `-2`, `-3` … when the name exists in the artifact OR was used earlier in this conversation
   (including discarded takes). Never reuse a name or overwrite — every render is a new take.
   Derived takes (conversions, crops, composites) get a new slug (`take_img-9467-converted.png`
   from `take_img-9467-75j0.heic`), never the source's base name with another extension.
4. **Write takes into this artifact's directory** (`/workspace/<artifact id>/<file name>`):
   generate/edit images with `wf_*` tools via `output_ports` (render provenance); derived files
   (contact sheet, crop, conversion) may use sandbox CLI commands (ImageMagick, ffmpeg, PIL).
   Every file there is registered at the end of the turn; never claim a file is done unless it is
   there. Read source takes via `artifact://` refs, never copied URLs.
5. **One render per take.** Leave `seed` at its default; never request batches.

## Phase 1 — Preflight

1. The artifact with your task id's key is yours: one `read_artifact(artifactId="<task id>")` →
   artifact **id** (output paths), existing file names, `design.json` (attributes, `displayName`,
   `links`, `loras`, `initialDrafts`).
2. Extract: the **attributes** (hair color, age, build, wardrobe, mood; locations: place, era,
   time of day, weather); the **workflow**, chosen by CAPABILITY, never from memory: the one the
   prompt names if it exists among your `wf_*` tools, else the text-to-image `wf_*` tool (per its
   description / `get_workflow_instructions`) whose model family matches the prompt or
   `design.json`. **Exception — an outfit (or any design drafted as image EDITS of a linked
   design's primary):** an image-edit (`i2i`) workflow, never text-to-image; the linked design's
   `primary:` line in the prompt's "Referenced designs" block (`artifact://<id>/primary.<ext>`) is
   its first image input; **how many drafts** (`initialDrafts`, default 4) and the **extension**
   (default `png`).
3. Empty attributes, or no text-to-image `wf_*` tool (outfit: no image-edit `wf_*` tool with an
   image input, or no `primary:` line for the linked character) → **do not guess**, and never
   fall back to text-to-image for an outfit (it invents a different person): render nothing and
   `task_complete` saying exactly what is missing. The person continues in the studio.

## Phase 2 — Write the prompt

1. `get_workflow_instructions(<workflow>)` — read fully (ports, defaults, prompt style). Follow
   "Prompt route" of `workflow-calling-conventions` (`load_skill` it) for every prompted
   `wf_*` call: a user-typed chat edit ("make her older") is a pass-through candidate (the
   person's words verbatim); attributes, initial drafts, retries and diversity variations are
   drafted with `draft_prompt` (pass `image_inputs` for the images the call carries).
2. Draft with `draft_prompt(<workflow>, <context>)` (ONE prompt serves all `initialDrafts`). When
   several DIFFERENT prompts are needed at once (distinct drafts, several edits in one message):
   ONE `draft_prompts_batch` call in ONE round, at most one `review_prompts_batch`; never a
   per-prompt `draft_prompt` / `review_prompt` loop and never a repeat batch for items already
   drafted. `context` is short: all attributes, the design kind and the goal *a clean, well-lit
   reference image of one subject* — character: full body or three-quarter, neutral pose, plain
   background, face clearly visible; outfit: an edit instruction dressing the person of the linked
   character's primary in the outfit (keep face, hair, body unchanged), full body; location: an
   establishing wide shot, no people. Never restate design descriptions or what reference images
   show. The prompt writer applies `prompt-writer-<family>` itself (without `draft_prompt`,
   `load_skill` it).
3. Carry the workspace's medium/style (`{workspace.story.plot}`, see "Medium / style is kept" in
   `workflow-calling-conventions`) verbatim into every `context`. "Clean reference image" is
   composition, never a photographic medium: no photography wording unless the story asks for a
   photograph. Keep named attributes verbatim; add no characters, props or text not asked for.
4. **Nudity follows the workspace content policy** (`{workspace.contentPolicy.nudity}`; absent or
   empty = forbidden). When it is `forbidden` - or ALWAYS for a minor (a child, teen or anyone
   under 18) whatever the policy - depict people fully clothed (use the `wardrobe` attribute,
   else simple everyday clothing) and put `nudity, nude, naked` in the negative prompt (the
   workflow's negative-prompt port, keeping its default text before these terms), in every
   render of a person, chat-phase edits and variations included. When it is `allowed`, follow
   the brief (do not add clothing or a nudity negative on your own), and:
   - **Character design**: render it per its `wardrobe` attribute. `nude` (adult only - else
     follow the `forbidden` rule above): fully NUDE - full body, neutral standing pose, facing the
     camera, plain backdrop, face clearly visible, no garments, no covering hands or props; it is
     the identity reference every shot binds, so anatomy must be complete and natural; use the
     [nsfw] text-to-image workflow (see "NSFW-marked workflows" in `workflow-calling-conventions`).
     Anything else: the plain neutral clothing the attribute names.
   - **Outfit**: always dresses the linked character primary (edit): exactly the outfit's garments,
     face, hair, body and skin unchanged. Use the [nsfw] image-edit workflow only when the outfit
     itself leaves nudity visible (lingerie, open robe).
5. LoRAs: `design.json.loras` were attached by the planner for this design (e.g. NSFW anatomy
   LoRAs of a nude character): pass EVERY one whose `modelFamily` matches the workflow on its lora
   ports, with its `strength`, and put its trigger words in the prompt (`context`); a LoRA of
   another family is skipped (say so in the summary). Also pass a `lora_index` LoRA whose trigger
   word the attributes contain (same model family only).

## Phase 3 — Render the drafts

For an outfit each call edits the linked character's primary: pass the prompt's `primary:` ref
(same `artifact://`, never a copied URL) as the image input and the edit instruction as the
prompt; the description says who the person is, the image defines how they look.

Issue ALL `initialDrafts` calls in ONE response, n = 1 … `initialDrafts` (they render in parallel):

```
wf_<workflow>(prompt_positive="<prompt>", …,
  output_ports={"<primary output port>": "/workspace/<artifact id>/take_draft-<n>-<slug>.png"})
```

- Same prompt for every draft; the seed gives the variety. If the attributes suggest clear
  alternatives ("short or long hair"), you may vary exactly that phrase across drafts — say so.
- A failed draft fails only itself: re-read the workflow instructions, fix the call, retry that
  draft once (same file name); if it fails again leave it (the studio shows a failed take with
  Retry) and report it.

## Check, retry once, suggest

For EVERY take you render follow "Check, retry once, suggest" of `workflow-calling-conventions`.
Retry naming: base + `-r2` (`take_profile-closeup.png` -> `take_profile-closeup-r2.png`). For a
draft `take_draft-<k>-<slug>.<ext>` the retry is `take_<slug>-draft-<k>-r2.<ext>` — it must NOT
start with `take_draft-`, so it never collides with the draft id `draft_<k>`.

## Phase 4 — Hand over

Audit before completing:

- [ ] every `take_draft-<n>-<slug>.<ext>` exists (re-read the artifact), n = 1 … initialDrafts,
      except drafts that failed twice (name them)
- [ ] no other file written; `design.json` untouched
- [ ] every take checked with `check_take` (file + the request it was rendered from); at most one retry per take (`<base>-r2`; drafts
      `take_<slug>-draft-<k>-r2.<ext>`); `suggest_edit` exactly for takes whose retry also missed
- [ ] drafts came from `wf_*` renders (sandbox-derived files are fine in the chat phase)

Then `task_complete(summary="Rendered N drafts of <displayName>.")` (1-3 lines, no prompt or workflow
restated - they are in the takes' render records; call it again after the self-review). This hands the design to the person — it
does **not** finish it.

## Phase 5 — Chat (HITL phase)

For each request:

1. `read_artifact` again (takes may have been added, discarded or re-ordered; `design.json` for
   `primaryTakeId`, takes, LoRAs, links). A take you rendered earlier that is gone was discarded on
   purpose — never re-render it.
2. Source image: the take the person names, else the primary (file of `primaryTakeId`), else the
   newest. Pass `artifact://<artifact id>/<file name>`, the same ref for `describe_image`,
   `check_take` and `sandbox_fetch` — never copy or retype a URL (one dropped character gives a 403).
3. Workflow: a change to an existing image ("older", "red jacket") → an **image-edit** (`i2i`)
   `wf_*` tool (prefer `capabilities` that fit, e.g. `multi-reference-edit`; else the one whose
   image inputs and required ports fit); instruction via `draft_prompt` (several edits in one
   message: ONE `draft_prompts_batch`, then all renders in one response), the source as the first
   image input, extra references next, named by each input's `label` / `reference_role`
   (`subject` = the image being edited) or port descriptions; anchoring per "Anchor (Picture 1) by
   intent". "Start over / completely different" → text-to-image as in Phase 2.
4. Render only what THIS message asks — one take unless it gives a count; never redo earlier
   requests. One take per variant to `take_<slug>.<ext>`; check every take. Reply with one short line
   (new take name(s), what changed), then stop.
5. When the studio asks you to assemble given takes into a sheet ("Assemble exactly these takes …
   Save it as /workspace/<artifact id>/<file name>"), do exactly that: ONE sandbox command
   (ImageMagick `montage`/`convert` or PIL), listed takes in listed order, no text, labels or
   borders beyond a thin uniform gap, same height per row, written to the given name. No `wf_*`
   render, no other file, no prompt writing. Reply with the file name only.
6. Write each file in one go (complete content, one write) and never rewrite it within the same
   attempt — the runtime's write-once guard blocks the rewrite and ends the loop.
7. Never pick a primary, discard takes, write descriptions or finish the design — tell the person
   to use ★ / 🗑 / Describe / Finish design in the studio.
