---
name: create-character-table
description: >
  Use when your task prompt says "Load and use skill: create-character-table" — write one
  character profile file per cast role (character_<slug>.md) from the screenplay: identity and
  slug, personality, visual profile, wardrobe tracker. Produces the `character_table` artifact that
  the scene list and the design planner read.
  Do NOT invoke for writing the screenplay, the scene list, or creating character designs.
agentType: worker
---

# Create character table

Runs in the worker of the `character_table` task (created by `run-preproduction`). The nudity
policy is `{workspace.contentPolicy.nudity}` (absent or empty = `forbidden`); the "Workspace facts"
block below shows its current value.

## Preflight

The task prompt names the input artifact `screenplay` and the output artifact `character_table`
(file pattern `character_<slug>.md`). If the screenplay is missing or unreadable, call
`task_failed` with a clear message; write nothing.

## Rules

- identify every cast role (speaking, named, meaningful presence; no props or walk-ons)
- **Character identity is decided here, once.** `NAME` = the story's proper name if the story
  names the character; otherwise the role in Title Case ("Sister", "Husband"). NEVER invent a name
  the story does not give. `<character_slug>` = NAME lowercased snake_case,
  `[a-z0-9]+(_[a-z0-9]+)*`; it is the file stem. Every later step uses
  this slug exactly (scene list `Characters present` / `Outfits`, `design_plan.json`, design keys)
  and that no later step may introduce a character or a new name.
- write ONE plain Markdown file per character (never PDF or DOCX) with `sandbox_write_file`, named `character_<slug>.md`
  with the `<character_slug>` above
- required-sections checklist (a file missing ANY of the five sections is incomplete and must not be submitted):
  ```
  REQUIRED SECTIONS in every character_<slug>.md (all five, as ## headings, in this order):
  [ ] NAME
  [ ] ROLE
  [ ] PERSONALITY
  [ ] VISUAL PROFILE
  [ ] WARDROBE TRACKER  (table, one row per look worn in the story; creature/animal wearing nothing: no rows)
  Before task_complete, re-open every file and confirm all five headings are present.
  ```
- each file has exactly these sections as `##` headings: `NAME`, `ROLE`, `PERSONALITY`,
  `VISUAL PROFILE` (character type, age, ethnicity, height, hair, eyes, build, build detail,
  proportions, posture, distinguishing features — one `key: value` line each; NO `[...]`
  placeholders or blanks: every field gets a concrete value, or the explicit word `n/a` when it
  does not apply; invent a fitting value the screenplay does not contradict rather than leave a
  field open; in a workspace with `contentPolicy.nudity: allowed` (`{workspace.contentPolicy.nudity}`)
  and an adult character, add the anatomical details needed for a consistent depiction as
  `key: value` lines in the same section, concrete and non-euphemistic; a minor never gets
  them), `WARDROBE TRACKER` (a table with ONE row per look the character wears in the story - garment looks only; nudity is not a row (it is the `nude` pair in the scene list), and a creature or animal that wears nothing has NO rows (pair `none`): look slug | description |
  garments, colors, material, fit, accessories | scenes where worn; look slugs are
  lowercase, `[a-z0-9]+(_[a-z0-9]+)*`, e.g. `raincoat`, `evening_dress`)
- files are registered automatically; run the checklist audit above, then `task_complete`
