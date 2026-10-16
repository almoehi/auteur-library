---
name: plan-designs
description: >
  Use when your task prompt says "Load and use skill: plan-designs" — turn the character
  table and the scene list into a design plan and create one studio design (character,
  outfit, location) for every entry with create_design, then one storyboard design per scene.
  Produces design_plan.json and the scheduled design tasks. Do NOT invoke for drafting or
  rendering design images (design-asset) or storyboard keyframes (storyboard-scene), writing
  screenplays or scene lists, or creating a single design on request.
agentType: worker
---

# Plan Designs

You are a plain LLM worker. You read text, write one JSON file, and call `create_design`.
Your output files are plain text only: `scene_list.md` (Markdown) and `design_plan.json` (JSON), never PDF, DOCX or any other binary/office format.
You never render images. Each `create_design` creates a design task that a design worker
(skill `design-asset`, for storyboards `storyboard-scene`) and the person in the design studio continue.

You are a planning task: your task is created with `can_create_tasks: true`, which is what
lets you call `create_design` (a worker without the flag has the tool hidden and calls refused).
Never use it for anything but the designs of the plan.

You run on the `design_planner` agent. Tools: `artifact_index`, `task_index`, `read_artifact`, `lora_index`, `sandbox_write_file`, `create_design`,
`task_complete`, `task_failed`.


**Content policy** (`{workspace.contentPolicy.nudity}`; absent or empty = `forbidden`) decides two
things below: the look of a character design ("Characters and outfits") and the NSFW LoRA plan
(Phase 1 step 4). A minor (a child, teen or anyone under 18) is ALWAYS planned as under
`forbidden`, whatever the policy.

## Characters and outfits (THE rule - everything else points here)

- **Outfits**: exactly ONE outfit design per row of a character's WARDROBE TRACKER (look slug = the
  row's look slug). No exceptions: no "most worn" look, no "differs visibly" judgement, no
  garment-state mapping. A tracker row that is nudity itself (no garments) is not an outfit.
- **The character design's own look** (its `wardrobe` attribute): `nude` when nudity is `allowed`
  AND the character is a human adult (age stated or clearly implied 18+) with no look younger than
  18; otherwise plain neutral clothing (e.g. "plain neutral clothing: simple fitted grey t-shirt
  and trousers"; a creature or animal that wears nothing: `none`). Minors are always clothed. The
  character design carries identity; outfits carry everything worn.
- **Scene-list pairs**: `<character>:<look>` -> that look's outfit design; `<character>:nude` ->
  the character design only (valid only for such a nude adult). A pair whose look has no tracker
  row -> an outfit entry built from the scene context, flagged in the summary.

## Phase 0 - Preflight

1. `artifact_index`: find the artifacts `character_table` and `scene_list`. Both must be
   approved and readable. Note your own output artifact id (the task's artifact) for paths.
2. `read_artifact(artifactId="scene_list")`: must contain a table with columns
   `Scene #`, `INT/EXT`, `Location`, `location_slug`, `Time of day`, `Summary`,
   `Characters present`, `Outfits` (`<character_slug>:<look_slug>` pairs separated by `; `).
   Below the scene table a `Beats` section (per scene: beat, action, framing, camera move,
   continuity: `continuous` | `parallel` | `new moment`) may follow. Your `scene_list.md` copy stays
   verbatim, Beats included. A `parallel` beat happens at the same time somewhere ELSE and names
   its place: that place is an extra location of the scene.
3. Read the character table files (pass `artifact_file`): `character_<slug>.md`, each with
   `VISUAL PROFILE` and `WARDROBE TRACKER`.
4. Existing designs (idempotency, mandatory: always run it, never assume nothing exists): `artifact_index` keys starting `character_`, `outfit_`,
   `location_`, `storyboard_`, plus `task_index`. Remember them as `existing`.
5. Nudity `allowed`: call `lora_index()` ONCE now (never skip or guess it), before any planning.
If an input is missing or unparseable: `task_failed` with a clear message naming it. Write nothing.

## Phase 1 - Plan -> design_plan.json

Build every entry mechanically, with its FINAL key, then the work list. Nothing is decided later.

1. **Entries**:
   - **characters**: every `character_<slug>.md` file; plus any character named in the scene
     list but without a file (flag in the summary; build it from the scene context only). Look
     per "Characters and outfits".
   - **locations**: EVERY distinct `location_slug` of the scene list PLUS every place named by a
     `parallel` beat (re-scan all scene rows AND all beats, including places that appear once). A
     parallel beat's place is matched to a table slug when it is the same place, else it is a new
     location (slug = the lowercase slug of the place, display name from the beat). Per scene the
     ordered places: the row's `location_slug` first, then parallel-beat places in beat order, no
     duplicates. A location's `scenes` includes every scene whose parallel beats use it.
   - **outfits**: one per WARDROBE TRACKER row of each character, plus one per scene-list pair
     whose look has no tracker row (per "Characters and outfits").
   - **storyboards**: one per scene (see step 6).
2. **Normalize slugs** (single rule, apply everywhere): lowercase, ASCII, non-alphanumerics to
   `_`, collapse repeats, trim `_`. Result must match `[a-z0-9]+(_[a-z0-9]+)*`.
   Key = `<kind>_<name>`, at most 64 characters (for outfits the name is `<character>_<look>`);
   shorten the look slug if needed. Design names are unique across ALL kinds, so a location
   slug must not equal a character slug (suffix `_place` to the location if it does).
   Merge duplicates ("Mira", "MIRA", "young Mira" = slug `mira`; another age or costume is a
   tracker row, not a new character). Style is not an attribute: never add the story's
   medium/style as a design attribute; `design-asset` carries it from `{workspace.story.plot}`.
3. **Map attributes** to registry keys (values are short comma-joined descriptors, never sentences):

| kind | `character_type` (create_design field) / attribute keys |
|---|---|
| character | `character_type`: woman, man, non-binary person, child, elderly person, animal, creature, robot, fantasy being, or free text; attributes: `age`, `ethnicity`, `hair`, `eyes`, `build`, `wardrobe`, `features` |
| outfit | `garments`, `colors`, `pattern`, `material`, `fit`, `accessories` |
| location | `place`, `era`, `time_of_day`, `weather`, `lighting`, `mood` |

   Outfit attributes come from the tracker row. Under `forbidden` - or ALWAYS for a minor - people
   are fully clothed and 'nudity, nude, naked' goes in the negative prompt.
   **One moment per design picture**: a design (a location above all) gets ONE `time_of_day`,
   `lighting`, `weather` and season - the one its first scene uses (else the most common one). Never
   list several together in one attribute; other moments are later edits of the finished design.
   Put only what the sources state; omit unknown keys (except the character `wardrobe`).
   `character_type` is passed as its own argument, not inside `attributes`.
4. **NSFW LoRA plan** (only when nudity is `allowed`; never for a scene with a minor in it). The
   base model renders explicit content only with the right LoRAs, so plan them per design now -
   the design workers load what you attach, and ONLY what the `create_design` call carries:
   1. From each scene's row and Beats, list the explicit **content** it shows as short tags in
      three groups: **acts** (blowjob, missionary, cowgirl, doggystyle, masturbation, kissing
      nude ...), **anatomy / detail** (breasts, nipples, genitals (female / male), pubic hair,
      erection ...), **poses** (kneeling, spread legs, lying on back, POV ...). A scene without
      nudity or sex has none. Every `nude` character has the fixed tag `nude body`.
   2. With the `lora_index` result of Phase 0, pick for every tag the catalog LoRAs whose **trigger
      words or description** match it (several tags may share one LoRA), in EVERY image model
      family the catalog has (e.g. krea2 and flux2): the design worker keeps only the LoRAs of its
      family. Skip video LoRAs (description says video / motion / clip, or a video model family).
      - **General**: a general NSFW / anatomy / realism LoRA goes with every explicit tag.
      - **Acts**: the act's own LoRA; an act without one falls back to an all-in-one sex LoRA -
        only without that is it missing.
      - **Anatomy / detail**: a detail LoRA whose description says "when X is the subject of the
        frame" only for a scene where X is the focus.
      - No image-EDIT LoRAs (workers take those from `lora_index` themselves).
      Never invent a name; never pick a LoRA that matches no tag.
   3. **Put them on the entries** (`loras: [{ "name": "<catalog name>" }, ...]`, names exactly as
      `lora_index` lists them, strength omitted = catalog default): a **storyboard** of a scene
      with tags gets per image family the general LoRA, then act, anatomy and pose LoRAs; a
      **`nude` character** gets per image family the general anatomy / realism LoRAs only (no act or
      frame-subject detail LoRAs); outfits and locations: none. At most 4 LoRAs PER MODEL FAMILY
      per entry, most important first: general > act > anatomy > pose.
   4. Tags without a catalog LoRA in some image family are **missing**: list them in
      `nsfw_loras.missing` (scene or character, with the family) and in the summary - never block.
5. **`nsfw_loras`** (only when nudity is `allowed`) keeps the tags and `missing`; the LoRA names
   live on the entries.
6. **Storyboards and links**: per scene an entry with key `storyboard_scene_<n>`, `notes` (the
   Summary) and `links` computed from the entries' keys: one `location` link per place the scene
   uses (the row's `location_slug` design FIRST, then parallel-beat places - links can ONLY be
   given at creation, and `storyboard-scene` can only place a shot at a linked location), one
   `character` link per character in `Characters present`, one `outfit` link per `<c>:<look>` pair
   of the `Outfits` column except `<c>:nude`.
7. **`designs`**: THE work list - every key in creation order: characters, locations, outfits,
   storyboards. Keys are fixed here, once.
8. Write BOTH output files into `/workspace/<your artifact id>/` with `sandbox_write_file`:
   `scene_list.md` first (an exact, character-for-character copy of the `scene_list` artifact's text as you read it; no edits, no summary) because the `design-plan-covers-scenes` task check judges the contents of all your output files, then `design_plan.json`:

```json
{
  "characters": [
    { "name": "Mira", "slug": "mira", "key": "character_mira", "character_type": "woman",
      "attributes": [ { "key": "age", "value": "late 20s" }, { "key": "hair", "value": "auburn, shoulder length" },
                      { "key": "wardrobe", "value": "plain neutral clothing: simple fitted grey t-shirt and trousers" } ],
      "loras": [], "scenes": [1, 2, 4] },
    { "name": "Lena", "slug": "lena", "key": "character_lena", "character_type": "woman",
      "attributes": [ { "key": "age", "value": "early 30s" }, { "key": "wardrobe", "value": "nude" } ],
      "loras": [ { "name": "<catalog name>" } ], "scenes": [3] }
  ],
  "locations": [
    { "name": "Harbor", "slug": "harbor", "key": "location_harbor",
      "attributes": [ { "key": "place", "value": "foggy fishing harbor" }, { "key": "time_of_day", "value": "dusk" } ],
      "scenes": [1, 3] }
  ],
  "outfits": [
    { "character_slug": "mira", "look_slug": "raincoat", "key": "outfit_mira_raincoat", "display_name": "Mira - Raincoat",
      "attributes": [ { "key": "garments", "value": "yellow raincoat" }, { "key": "colors", "value": "mustard yellow" } ],
      "scenes": [1, 3] }
  ],
  "storyboards": [
    { "scene": 1, "key": "storyboard_scene_1", "notes": "Mira reaches the harbor in the rain.",
      "links": [ { "role": "location", "key": "location_harbor" }, { "role": "character", "key": "character_mira" },
                 { "role": "outfit", "key": "outfit_mira_raincoat" } ],
      "loras": [] }
  ],
  "designs": [ "character_mira", "character_lena", "location_harbor", "outfit_mira_raincoat", "storyboard_scene_1" ],
  "nsfw_loras": {
    "scenes": [ { "scene": 3, "acts": ["blowjob"], "anatomy": ["breasts", "penis"], "poses": ["kneeling", "pov"] } ],
    "characters": [ { "slug": "lena", "tags": ["nude body"] } ],
    "missing": [ { "scene": 3, "family": "krea2", "tags": ["cowgirl"] } ]
  }
}
```

(`nsfw_loras` only when nudity is `allowed`; `loras` omitted or `[]` when none.)

**Writing these files is NOT completion.** Phase 2 (one `create_design` per key of `designs`) must follow. A tool message saying the file was written, or listing `task_complete` as a next action, never ends the task: call `task_complete` only after all create calls and the Phase 3 audit.

Both file names are canonical: write exactly `scene_list.md` and `design_plan.json` into the `design_plan` artifact. If the files declared on the artifact differ, still write these two names and report the mismatch in the `task_complete` summary (line `file mismatch: <declared> vs scene_list.md, design_plan.json`). Every outfit's `character_slug` must exist in `characters`.

## Phase 2 - Create the designs

Walk `designs` in order: one `create_design` per key, arguments copied from its entry (kind from the
entry list the key belongs to; `start: "attributes"`, `initial_drafts: 1`, `display_name`,
`character_type` for characters, `attributes`, `links`, `loras`). Never re-judge, skip, merge or
add entries - that was decided in Phase 1; an entry that looks wrong is created anyway and noted.
Only a key in `existing` is skipped (record it).

- character: `create_design({ kind: "character", display_name, start: "attributes", character_type, attributes, initial_drafts: 1, loras })`
- location: `create_design({ kind: "location", display_name, start: "attributes", attributes, initial_drafts: 1 })`
- outfit: `create_design({ kind: "outfit", display_name, start: "attributes", attributes, initial_drafts: 1, links: [{ "role": "character", "key": "character_<character_slug>" }] })`
- storyboard: `create_design({ kind: "storyboard", display_name: "Scene <n>", start: "attributes", attributes: [ { key: "scene", value: "<n>" }, { key: "notes", value: "<notes>" } ], initial_drafts: 1, links, loras })`

Omit `loras` when the entry has none. `display_name` of a character/location is its `name`; of a
storyboard `Scene <n>` (the key becomes `storyboard_scene_<n>`; check the result's key).
`start: "attributes"` needs a non-sheet text-to-image workflow in the workspace (an outfit needs an image-to-image one: it is drafted as edits of its character's primary and only starts once that design is finished - always pass the character link); `character_type` is REQUIRED for characters (custom text allowed, e.g. "ghost"). A refusal result starts with `error:`; a success reads `Design created: key <key>, @<name>, task id <id>, status <status>`. Treat any result not starting with `Design created` as not created.

Never pass `policies` to `create_design` (the tool does not accept it; designs go through human review), even if the task prompt names checks. Call sequentially (one at a time) and keep
each result's key, `@name` and task id.

**Keep a registry of the ACTUAL keys** (`planned key -> actual key`, from each
`Design created: key <key>` result, the existing/reused key on a skip or "already used by"
reuse, or the renamed key after a suffixed retry). Links of later entries substitute renamed keys;
never derive a key from a slug again. Every given link is required (the storyboard task waits until
those designs are finished): if a link key is refused as unknown, re-check the registry and the
`artifact_index` for the renamed key, retry once, then drop only that link and note it.

**Refusals:**
- `design name "<n>" is already used by "<key>"`: same kind as yours -> reuse it (skipped,
  noted); different kind -> retry once with a suffixed display name (`<name> (place)`) and record the rename.
- Outfit refused for a missing character: create the character first, then retry.
- A `loras` name refused as unknown: re-check `lora_index`, retry once with the exact names (or
  without the unknown one); never drop the design over a LoRA - note it under `missing`.
- Any other error: retry once; if it fails again record it as failed and continue.

## Phase 3 - Pre-completion audit

1. MANDATORY: re-run `artifact_index` (never skip it). Missing = every key of `designs` (after
   renames and skips) that is not in the index. Create each missing one (Phase 2 rules) and
   re-audit. `task_complete` is forbidden while any key is missing, unless each is listed under
   `failed:` with its error. Zero `create_design` calls so far means Phase 2 never ran: do it now.
2. `design_plan.json` and `scene_list.md` both exist in your artifact directory and equal what you used.
3. If the design plan could not be covered at all, call `task_failed`.

Keep replies concise (see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`). The `task_complete` summary uses exactly this format; counts come from the audit and from your own calls, never from the plan (name designs by task URI `task://<id>` where known; never list every key when all went well):

```
designs: <created>/<planned> - characters a/b, locations a/b, outfits a/b, storyboards a/b
skipped (existing): <count, or keys only if few>
failed: <key: error> or none
loras: <n> sent in create_design calls; missing: <scene: tags> or none
```

(the `loras` line only when nudity is `allowed`.) Add `renamed:`, `file mismatch:` and `flagged:` lines (characters without a file, scene pairs without a tracker row, entries that looked wrong) only when they occurred.

## Key rules

1. Outfit rule, character look and scene pairs: "Characters and outfits" - nowhere else.
2. Characters before outfits; outfits always link `{role:"character", key:"character_<slug>"}`.
3. Slugs follow one normalization; keys <= 64 chars; names unique across kinds.
4. `start` is always `"attributes"`, `initial_drafts` 1.
5. Idempotent: never recreate an existing design.
6. Never write `design.json` or any design file; only `design_plan.json` and `scene_list.md`.
7. Execute `designs` literally; storyboards are created last, linked by the ACTUAL keys.
8. Nudity `allowed`: `lora_index` in Phase 0, LoRAs on the entries and in the `create_design` calls, missing ones reported.
