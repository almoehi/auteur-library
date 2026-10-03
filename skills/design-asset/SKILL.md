---
name: design-asset
description: >
  Use when your task is a design-studio design — a character, outfit or location keyed
  `<kind>_<name>` (e.g. "character_mira", "outfit_mira_raincoat", "location_harbor") — or the
  task prompt says "draft the design", "render the initial drafts", or the person asks in the
  design chat for a change ("make her older", "try a red jacket", "another angle"). Produces
  draft and take images inside the design artifact (`take_draft_<n>.<ext>`, `take_<id>.<ext>`)
  for the person to pick from in the studio. Do NOT invoke for shooting scenes, storyboards,
  character/location sheets requested as their own task, writing `design.json`, or publishing
  or finishing a design.
agentType: worker
---

# Design Asset — draft and iterate on a studio design

A design is an ordinary `llm+hitl` task plus one open artifact, both keyed `<kind>_<name>`
(`character_mira`). The **web studio owns the design**: its `design.json` (attributes, takes,
primary, description, LoRAs) and every published file (`primary.*`, `sheet.*`, `view_*`). Your
job is only to put **images** into the artifact; the studio picks them up as takes.
Contract reference: `release/DESIGN_GUIDE.md`.

## Hard rules

1. **Never write, overwrite, rename or delete `design.json`** — read it only
   (`read_artifact(artifactId="<task id>")`). The UI writes it with a version check; a write
   from you would be lost or clobber the person's edits.
2. **Never write published names** (`primary.*`, `sheet.*`, `view_*`) — "Finish design" in the
   studio creates those.
3. **File names are flat** — `/` is forbidden. Drafts: `take_draft_<n>.<ext>` (n = 1, 2, …).
   Chat-phase takes: `take_agent<n>.<ext>` (n = next free number). Never reuse or overwrite an
   existing file name — every render is a new take.
4. **Render with `wf_*` tools only**, straight into this artifact's own directory via
   `output_ports` (`/workspace/<artifact id>/<file name>`) — files written there register
   automatically, with their render provenance (prompt, seed, LoRAs) the studio shows.
5. **One render per take.** Leave `seed` at its default (random) so each draft differs; never
   request batches.

## Phase 1 — Preflight (LLM phase)

1. Your task id is the design key; the artifact with the same key is yours.
   `read_artifact(artifactId="<task id>")` → note the artifact **id** (for output paths) and the
   existing file names.
2. From the task prompt, extract:
   - the **attributes** (e.g. hair color, age, build, wardrobe, mood; for locations: place,
     era, time of day, weather);
   - the **workflow** to use (a t2i workflow name) — if none is named, pick the `wf_*` tool
     whose workflow type is text-to-image and whose model family matches the one named in the
     prompt or in `design.json`;
   - **how many drafts** (`initialDrafts`, default 4) and the **file extension** (default
     `png`).
   `design.json` (read above) holds the same attributes and may name `displayName`, `links`
   (an outfit's character) and `loras`.
3. If the attributes are empty, or no text-to-image `wf_*` tool exists, **do not guess**:
   render nothing and call `task_complete` with a summary that says exactly what is missing.
   The person continues in the studio (Generate / upload references).

## Phase 2 — Write the prompt

1. `get_workflow_instructions(<workflow>)` — read it fully (ports, defaults, prompt style).
2. Draft the prompt with `draft_prompt(<workflow>, <context>)`. Pass all attributes, the
   design kind, and the goal: *a clean, well-lit reference image of one subject* — for a
   character: full body or three-quarter, neutral pose, plain background, face clearly
   visible; for an outfit: the linked character wearing the outfit, full body; for a location:
   an establishing wide shot, no people. The prompt writer applies the model-family skill
   (`prompt-writer-<family>`, e.g. `prompt-writer-krea2`) automatically. If `draft_prompt` is
   not available, `load_skill("prompt-writer-<family>")` and follow it yourself.
3. Keep the named attributes verbatim; add no characters, props or text not asked for.
4. LoRAs: if `design.json.loras` lists LoRAs, or the attributes contain a trigger word from
   `lora_index`, pass those LoRAs on the workflow's lora ports (same model family only).

## Phase 3 — Render the drafts

Issue ALL `initialDrafts` calls in ONE response — one `wf_*` call per draft, n = 1 … `initialDrafts`
(they render in parallel; do not wait for one before issuing the next):

```
wf_<workflow>(prompt_positive="<prompt>", …,
  output_ports={"<primary output port>": "/workspace/<artifact id>/take_draft_<n>.png"})
```

- Same prompt for every draft; the random seed gives the variety. If the person's attributes
  suggest clear alternatives (e.g. "short or long hair"), you may vary exactly that phrase
  across drafts — say so in the summary.
- A failed draft fails only itself — the other drafts' results still arrive. For each failed
  draft: re-read the workflow instructions, fix the call, retry that draft once (same file name);
  if it fails again, leave it — the studio shows it as a failed take with a Retry — and report it.

## Phase 4 — Hand over

Audit before completing:

- [ ] every `take_draft_<n>.<ext>` exists in the artifact (re-read it) — n = 1 … initialDrafts —
      except drafts that failed twice (name them in the summary)
- [ ] no other file was written; `design.json` untouched
- [ ] every file came from a `wf_*` render (no sandbox-made images)

Then call `task_complete(summary="Rendered N drafts of <displayName> with <workflow>; prompt: …")`
(call it again after the self-review). This hands the design to the person — it does **not**
finish the design.

## Phase 5 — Chat (HITL phase)

The person may ask for changes in the design chat. For each request:

1. `read_artifact` again — takes may have been added, discarded or re-ordered; read
   `design.json` for the current `primaryTakeId`, takes, LoRAs and linked designs.
2. Pick the source image: the take the person names, else the primary (the file of
   `primaryTakeId`), else the newest take. Pass it as `artifact://<artifact id>/<file name>`.
3. Pick the workflow:
   - a change to an existing image ("older", "red jacket", "other background") → an
     **image-edit** (`i2i`) `wf_*` tool; write the instruction with `draft_prompt` for that
     workflow (skills `prompt-writer-qwenimage` / `prompt-writer-flux2`), referencing the
     source as the first image input and any extra reference as the next;
   - "start over / completely different" → the text-to-image workflow, as in Phase 2.
4. Render one take per requested variant to `take_agent<n>.<ext>` (next free n), one render
   per call. Reply with the new file name(s) and one line on what changed.
5. Never pick a primary, discard takes, write descriptions or finish the design — tell the
   person to use ★ / 🗑 / Describe / Finish design in the studio.
