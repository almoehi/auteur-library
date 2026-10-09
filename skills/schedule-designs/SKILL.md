---
name: schedule-designs
description: >
  Use when your task prompt says "Load and use skill: schedule-designs" — turn the character
  table and the scene list into a design manifest and create one studio design (character,
  outfit, location) for every entry with create_design. Produces design_manifest.json and the
  scheduled design tasks. Do NOT invoke for drafting or rendering design images (that is
  design-asset), writing screenplays or scene lists, or creating a single design on request.
agentType: worker
---

# Schedule Designs

You are a plain LLM worker. You read text, write one JSON file, and call `create_design`.
You never render images. Each `create_design` creates a design task that a design worker
(skill `design-asset`) and the person in the design studio continue.

Tools: `artifact_index`, `task_index`, `read_artifact`, `sandbox_write_file`, `create_design`,
`task_complete`, `task_failed`.

## Phase 0 — Preflight

1. `artifact_index`: find the artifacts `character_table` and `scene_list`. Both must be
   approved and readable. Note your own output artifact id (the task's artifact) for paths.
2. `read_artifact(artifactId="scene_list")`: must contain a table with columns
   `Scene #`, `INT/EXT`, `Location`, `location_slug`, `Time of day`, `Summary`,
   `Characters present`, `Outfits` (`<character_slug>:<look_slug>` pairs separated by `; `).
3. Read the character table files (pass `artifact_file`): `character_<slug>.md`, each with
   `VISUAL PROFILE` and `WARDROBE TRACKER`.
4. Existing designs (idempotency): `artifact_index` keys starting `character_`, `outfit_`,
   `location_`, plus `task_index`. Remember them as `existing`.
If an input is missing or unparseable: `task_failed` with a clear message naming it. Write nothing.

## Phase 1 — Extraction -> design_manifest.json

1. Build the entity lists:
   - **characters**: every `character_<slug>.md` file; plus any character named in the scene
     list but without a file (flag in the summary; create it from the scene context only).
   - **locations**: distinct `location_slug` values of the scene list; display name from the
     `Location` column.
   - **outfits**: distinct (character_slug, look_slug) pairs from the `Outfits` column, plus
     looks in WARDROBE TRACKERs that are used in a scene.
2. **Normalize slugs** (single rule, apply everywhere): lowercase, ASCII, non-alphanumerics to
   `_`, collapse repeats, trim `_`. Result must match `[a-z0-9]+(_[a-z0-9]+)*`.
   Key = `<kind>_<name>`, at most 64 characters (for outfits the name is `<character>_<look>`);
   shorten the look slug if needed. Design names are unique across ALL kinds, so a location
   slug must not equal a character slug (suffix `_place` to the location if it does).
3. **Merge duplicates and variants** ("Mira", "MIRA", "young Mira" = same slug `mira`; a
   different age or costume is an outfit/look, not a new character).
4. **Map attributes** to registry keys (values are short comma-joined descriptors, never sentences):

| kind | `character_type` (create_design field) / attribute keys |
|---|---|
| character | `character_type`: woman, man, non-binary person, child, elderly person, animal, creature, robot, fantasy being, or free text; attributes: `age`, `ethnicity`, `hair`, `eyes`, `build`, `wardrobe`, `features` |
| outfit | `garments`, `colors`, `pattern`, `material`, `fit`, `accessories` |
| location | `place`, `era`, `time_of_day`, `weather`, `lighting`, `mood` |

   Put only what the sources state; omit unknown keys. `character_type` is passed as its own
   argument, not inside `attributes`.
5. Write `/workspace/<your artifact id>/design_manifest.json` with `sandbox_write_file`:

```json
{
  "characters": [
    { "name": "Mira", "slug": "mira", "character_type": "woman",
      "attributes": [ { "key": "age", "value": "late 20s" }, { "key": "hair", "value": "auburn, shoulder length" } ],
      "scenes": [1, 2, 4] }
  ],
  "locations": [
    { "name": "Harbor", "slug": "harbor",
      "attributes": [ { "key": "place", "value": "foggy fishing harbor" }, { "key": "time_of_day", "value": "dusk" } ],
      "scenes": [1, 3] }
  ],
  "outfits": [
    { "character_slug": "mira", "look_slug": "raincoat", "display_name": "Mira - Raincoat",
      "attributes": [ { "key": "garments", "value": "yellow raincoat" }, { "key": "colors", "value": "mustard yellow" } ],
      "scenes": [1, 3] }
  ]
}
```

The file name is canonical. Every outfit's `character_slug` must exist in `characters`.

## Phase 2 — Create the designs

Order: all characters first, then locations, then outfits (an outfit links to its character).
Skip any entity whose key is in `existing` (record as skipped). One call per entity:

- character: `create_design({ kind: "character", display_name: "<name>", start: "attributes", character_type, attributes, initial_drafts: 1 })`
- location: `create_design({ kind: "location", display_name: "<name>", start: "attributes", attributes, initial_drafts: 1 })`
- outfit: `create_design({ kind: "outfit", display_name: "<display_name>", start: "attributes", attributes, initial_drafts: 1, links: [{ "role": "character", "key": "character_<character_slug>" }] })`

Do not pass `policies` unless the task prompt asks for it. Call sequentially (one at a time) and keep
each result's key, `@name` and task id.

**Refusals:**
- `design name "<n>" is already used by "<key>"`: same kind as yours -> reuse it (skipped,
  noted); different kind -> retry once with a suffixed display name (`<name> (place)` / slug
  suffix) and record the rename.
- Outfit refused for a missing character: create the character first, then retry.
- Any other error: retry once; if it fails again record it as failed and continue.

## Phase 3 — Pre-completion audit

1. Re-run `artifact_index`; every manifest entry must have a design key now (created or
   pre-existing). Re-create anything missing once.
2. `design_manifest.json` exists in your artifact directory and equals what you used.
3. If any entity failed: `task_complete` is still correct only if all others are done and the
   summary lists the failures; if the manifest could not be covered at all, call `task_failed`.

`task_complete` summary format:

```
manifest: <n> characters, <n> locations, <n> outfits
created: <keys>
skipped (existing): <keys>
renamed: <old -> new, reason>
failed: <key: error> or none
```

## Key rules

1. Characters before outfits; outfits always link `{role:"character", key:"character_<slug>"}`.
2. Slugs follow one normalization; keys <= 64 chars; names unique across kinds.
3. `start` is always `"attributes"`, `initial_drafts` 1.
4. Idempotent: never recreate an existing design.
5. Never write `design.json` or any design file; only `design_manifest.json`.
