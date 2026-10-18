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
You never render images and never draft a design yourself. Each `create_design` creates a design task that a design worker
(skill `design-asset`, for storyboards `storyboard-scene`) and the person in the design studio continue. They are routed to a general-purpose worker agent automatically (their task text says so): never assign them to a planner.

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
- **The character design's own look** (its `wardrobe` attribute) is decided by AGE and the
  workspace POLICY only:
  - nudity `allowed` AND a human adult (age stated or clearly implied 18+, no look younger than
    18): `wardrobe` is ALWAYS `nude` - every adult human character, without exception.
  - Plain neutral clothing (e.g. "plain neutral clothing: simple fitted grey t-shirt and
    trousers") ONLY for a minor, a workspace where nudity is `forbidden`, or a clothed non-human.
  - A creature or animal that wears nothing: `wardrobe` `none`, NO tracker rows and the scene pair
    `<c>:none`.
  `nude` is NEVER decided by whether the character appears nude in a scene or on camera, nor by
  character-table notes like "face never shown", "not shown nude" or "always clothed on screen":
  the character design is the identity/anatomy reference, not a scene. An outfit's garments never
  go into the character's `wardrobe` (outfits carry everything worn). Every `nude` character gets
  the general anatomy/realism NSFW LoRAs of each image family (Phase 1 step 4) and is recorded in
  `nsfw_loras.characters`.
- **Scene-list pairs**: the scene rows' `Outfits` are the UNION of the looks their beats use (the Beats
  tables' `Outfits` column carries the per-beat looks; a character may appear with several looks in one
  row, e.g. `sister:bikini_cardigan; sister:nude`). Plan from the scene rows' pairs (equal to the beat
  looks), excluding `nude` / `none`: those need no design - in a nudity-allowed workspace the character
  design's primary IS the nude base sheet. `<c>:<look>` -> that look's outfit design (the look MUST be a tracker row,
  Phase 0 step 3b); `<c>:nude` (valid only for a nude adult as above) and `<c>:none` (a character
  that wears nothing) -> the character design only, no outfit entry. An invalid `<c>:nude` (minor,
  creature, nudity forbidden; a minor is never nude) -> an outfit entry built from the scene
  context, flagged in the summary.

## Phase 0 - Preflight

1. `artifact_index`: find the artifacts `character_table` and `scene_list`. Both must be
   approved and readable. Note your own output artifact id (the task's artifact) for paths.
2. `read_artifact(artifactId="scene_list")`: must contain a table with columns
   `Scene #`, `INT/EXT`, `Location`, `location_slug`, `Time of day`, `Summary`,
   `Characters present`, `Outfits` (`<character_slug>:<look_slug>` pairs separated by `; `, the union of the looks of the scene's beats).
   Below the scene table a `Beats` section (per scene: beat, action, framing, camera move,
   continuity: `continuous` | `parallel` | `new moment`, an `Outfits` column (the looks visible per beat) and a `Location` column holding the
   `location_slug` where the beat happens) may follow. Your `scene_list.md` copy stays
   verbatim, Beats included. A beat whose `Location` differs from its row's `location_slug` (a
   `parallel` beat) is an extra location of the scene.
3. Read the character table files (pass `artifact_file`): `character_<slug>.md`, each with
   `VISUAL PROFILE` and `WARDROBE TRACKER`.
3b. **Reconcile the scene list with the character table (mandatory, before any planning).**
   Collect (a) the character slugs of every `Characters present` and `Outfits` pair, (b) the file
   stems `<slug>` of the character table, (c) each character's tracker look slugs. If a scene-list
   character slug is not a character-table stem, or a look slug (other than `nude` / `none`) is
   not in that character's tracker, call `task_failed` naming BOTH sets (the offending scene-list
   slugs and the table's stems / looks). Never map names by guesswork, never plan a character
   without a file.
4. Existing designs (idempotency, mandatory: always run it, never assume nothing exists): `artifact_index` keys starting `character_`, `outfit_`,
   `location_`, `storyboard_`, plus `task_index`. Remember them as `existing`.
5. Nudity `allowed`: call `lora_index()` ONCE now (never skip or guess it), before any planning.
If an input is missing or unparseable: `task_failed` with a clear message naming it. Write nothing.

## Phase 1 - Plan -> design_plan.json

Build every entry mechanically, with its FINAL key, then the work list. Nothing is decided later.

1. **Entries**:
   - **characters**: every `character_<slug>.md` file, slug = the file stem (step 3b guarantees
     the scene list uses no other). Look per "Characters and outfits".
   - **locations**: ONE per distinct `location_slug`, collected from the scene rows PLUS the Beats
     `Location` column (re-scan all rows AND all beats, including slugs that appear once). Never
     create a second location for a slug already collected. Per scene the ordered places: the
     row's `location_slug` first, then other beat-`Location` slugs in beat order, no duplicates.
     A location's `scenes` includes every scene whose beats use it. Display name: the scene row's
     `Location` text for a row slug, else the slug's words in Title Case.
   - **`distinct_place`**: a location entry whose `key_slug` words overlap another location
     entry's - the shorter slug has at least two `_` words and all of them are in the longer one
     (`backyard_pool` / `backyard_pool_terrace`; a one-word slug like `harbor` never counts) -
     gets `"distinct_place": true` (the plan says they are different places; `create_design`
     otherwise refuses the second as a near-duplicate of the first). No other entry has it.
   - **outfits**: per "Characters and outfits".
   - **storyboards**: one per scene (see step 6).
2. **Slugs and keys** (single rule, apply everywhere): slug = lowercase, ASCII, non-alphanumerics
   to `_`, collapse repeats, trim `_`; it matches `[a-z0-9]+(_[a-z0-9]+)*`. `create_design`
   takes the key from its `key_slug` argument: key = `<kind>_<key_slug>`. Every entry's `key_slug`
   is its planned key without the `<kind>_` prefix (`sister`, `pool_terrace`,
   `<character_slug>_<look_slug>` for an outfit, `scene_<n>` for a storyboard) and goes into
   `design_plan.json`. `display_name` is the human name and independent of the key (Title Case
   of the slug words, e.g. "Pool Terrace", "Sister - Bikini Cardigan"); never derive a key from
   it. Never use the story's full name as `display_name` (put it in an attribute or notes if
   useful). Keys are at most 64 characters: shorten the look part
   and note it in `flagged:`. Design names are unique across ALL kinds, so a location slug must
   not equal a character slug (suffix `_place` to the location slug, display "Harbor Place").
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
   **Location attributes describe ONLY the place.** A character's action, emotion or dialogue
   never goes into a location's `mood` (or any location attribute). Set `mood` only when the
   source describes the place's own atmosphere (e.g. "dim, tense"); otherwise omit it.
   Put only what the sources state; omit unknown keys (except the character `wardrobe`).
   `character_type` is passed as its own argument, not inside `attributes`.
4. **NSFW LoRA plan** (only when nudity is `allowed`; never for a scene with a minor in it). The
   base model renders explicit content only with the right LoRAs, so plan them per design now -
   the design workers load what you attach, and ONLY what the `create_design` call carries:
   1. From each scene's row and Beats, list the explicit **content** it shows as short tags in
      three groups: **acts** = the names in the Beats' `Sex act` column, **poses** = the names in
      the `Sex position` column (plus other pose words the beats state, e.g. POV, spread legs), both
      in the canonical names of section "Explicit acts and positions" of skill
      `workflow-calling-conventions` (`none` gives no tag; an `other (...)` value gives its plain
      words), **anatomy / detail** (breasts, nipples, genitals (female / male), pubic hair,
      erection ...). A scene without nudity or sex has none. Every `nude` character has the fixed tag `nude body`.
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
   Summary), `format` (`portrait` | `landscape`: the frame orientation the story / plot states (the task prompt's story line or the "Workspace facts" block), e.g.
   a vertical phone film is `portrait`; derive it, never ask; `landscape` when the story states
   nothing; the SAME value for every scene) and `links` computed from the entries' keys: one `location` link per place the scene
   uses (the row's `location_slug` design FIRST, then parallel-beat places - links can ONLY be
   given at creation, and `storyboard-scene` can only place a shot at a linked location), one
   `character` link per character in `Characters present`, one `outfit` link per pair of the
   `Outfits` column that has an outfit entry ("Characters and outfits"). Location links: row slug
   first, then the other beat-`Location` slugs.
7. **`designs`**: THE work list - every key in creation order: characters, locations, outfits,
   storyboards. Keys are fixed here, once.
8. Write BOTH output files into `/workspace/<your artifact id>/` with `sandbox_write_file`:
   `scene_list.md` first (an exact, character-for-character copy of the `scene_list` artifact's text as you read it; no edits, no summary) because the `design-plan-covers-scenes` task check judges the contents of all your output files, then `design_plan.json`:

```json
{
  "characters": [
    { "display_name": "Mira", "slug": "mira", "key_slug": "mira", "key": "character_mira", "character_type": "woman",
      "attributes": [ { "key": "age", "value": "late 20s" }, { "key": "hair", "value": "auburn, shoulder length" },
                      { "key": "wardrobe", "value": "nude" } ],
      "loras": [ { "name": "<catalog name>" } ], "scenes": [1, 2, 4] },
    { "display_name": "Lena", "slug": "lena", "key_slug": "lena", "key": "character_lena", "character_type": "woman",
      "attributes": [ { "key": "age", "value": "early 30s" }, { "key": "wardrobe", "value": "nude" } ],
      "loras": [ { "name": "<catalog name>" } ], "scenes": [3] },
    { "display_name": "Tim", "slug": "tim", "key_slug": "tim", "key": "character_tim", "character_type": "child",
      "attributes": [ { "key": "age", "value": "9" },
                      { "key": "wardrobe", "value": "plain neutral clothing: simple fitted grey t-shirt and trousers" } ],
      "loras": [], "scenes": [2] }
  ],
  "locations": [
    { "display_name": "Harbor", "slug": "harbor", "key_slug": "harbor", "key": "location_harbor",
      "attributes": [ { "key": "place", "value": "foggy fishing harbor" }, { "key": "time_of_day", "value": "dusk" } ],
      "scenes": [1, 3] }
  ],
  "outfits": [
    { "character_slug": "mira", "look_slug": "raincoat", "key_slug": "mira_raincoat", "key": "outfit_mira_raincoat", "display_name": "Mira - Raincoat",
      "attributes": [ { "key": "garments", "value": "yellow raincoat" }, { "key": "colors", "value": "mustard yellow" } ],
      "scenes": [1, 3] }
  ],
  "storyboards": [
    { "scene": 1, "key_slug": "scene_1", "key": "storyboard_scene_1", "notes": "Mira reaches the harbor in the rain.", "format": "landscape",
      "links": [ { "role": "location", "key": "location_harbor" }, { "role": "character", "key": "character_mira" },
                 { "role": "outfit", "key": "outfit_mira_raincoat" } ],
      "loras": [] }
  ],
  "designs": [ "character_mira", "character_lena", "location_harbor", "outfit_mira_raincoat", "storyboard_scene_1" ],
  "nsfw_loras": {
    "scenes": [ { "scene": 3, "acts": ["blowjob"], "anatomy": ["breasts", "penis"], "poses": ["kneeling", "POV"] } ],
    "characters": [ { "slug": "mira", "tags": ["nude body"] }, { "slug": "lena", "tags": ["nude body"] } ],
    "missing": [ { "scene": 3, "family": "krea2", "tags": ["cowgirl"] } ]
  }
}
```

(The example is a nudity-`allowed` workspace: the adults Mira and Lena are `nude`; only the minor Tim is clothed. Under `forbidden` every character, adults included, gets plain neutral clothing. `nsfw_loras` only when nudity is `allowed`; `loras` omitted or `[]` when none.)

**Writing these files is NOT completion.** Phase 2 (one `create_design` per key of `designs`) must follow. A tool message about files being written, a file count, or one listing `task_complete` as a next action is never completion: the task is complete only after EVERY planned design was created with `create_design` and the Phase 3 `artifact_index` audit passed. If `task_complete` is refused because no tasks/designs were created, do not retry it: continue with Phase 2.

Both file names are canonical: write exactly `scene_list.md` and `design_plan.json` into the `design_plan` artifact. If the files declared on the artifact differ, still write these two names and report the mismatch in the `task_complete` summary (line `file mismatch: <declared> vs scene_list.md, design_plan.json`). Every outfit's `character_slug` must exist in `characters`.

## Phase 2 - Create the designs

Walk `designs` in order: one `create_design` per key, arguments copied from its entry (kind from the
entry list the key belongs to; `start: "attributes"`, `initial_drafts: 1`, `display_name`, `key_slug`,
`character_type` for characters, `attributes`, `links`, `loras`, `distinct_place`). Never re-judge, skip, merge or
add entries - that was decided in Phase 1; an entry that looks wrong is created anyway and noted.
Only a key in `existing` is skipped (record it).

- character: `create_design({ kind: "character", display_name, key_slug, start: "attributes", character_type, attributes, initial_drafts: 1, loras })`
- location: `create_design({ kind: "location", display_name, key_slug, start: "attributes", attributes, initial_drafts: 1 })`; add `distinct_place: true` when the entry has `"distinct_place": true` (see below)
- outfit: `create_design({ kind: "outfit", display_name, key_slug, start: "attributes", attributes, initial_drafts: 1, links: [{ "role": "character", "key": "character_<character_slug>" }] })`
- storyboard: `create_design({ kind: "storyboard", display_name: "Scene <n>", key_slug: "scene_<n>", start: "attributes", attributes: [ { key: "scene", value: "<n>" }, { key: "notes", value: "<notes>" }, { key: "format", value: "<portrait|landscape>" } ], initial_drafts: 1, links, loras })`

Omit `loras` when the entry has none. `display_name` is the entry's (storyboard: `Scene <n>`), `key_slug` the entry's `key_slug`; check that
the result's key equals the entry's key.
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
  noted); different kind -> retry once with a DIFFERENT `key_slug` (the name derives from
  `key_slug`, so a new display name alone never helps): append the kind (`harbor` ->
  `harbor_location`, key `location_harbor_location`), and record `renamed: <planned key> ->
  <created key>` (`designs-cover-plan` accepts the rename; links of later entries use the created key).
- Outfit refused for a missing character: create the character first, then retry.
- A `loras` name refused as unknown: re-check `lora_index`, retry once with the exact names (or
  without the unknown one); never drop the design over a LoRA - note it under `missing`.
- Any other error: retry once; if it fails again record it as failed and continue.

## Phase 3 - Pre-completion audit

1. MANDATORY: re-run `artifact_index` (never skip it). Missing = every key of `designs` (after
   renames and skips) that is not in the index. **Before creating a missing one, check for a
   rename**: a design of the SAME kind created in this run under another key (compare the
   `Design created` registry with the index) is that entry under a different key: record it as
   `renamed: <planned key> -> <actual key>` and do NOT create a second design for it. Create each missing one (Phase 2 rules) and
   re-audit. `task_complete` is forbidden while any key is missing, unless each is listed under
   `failed:` with its error. Zero `create_design` calls so far means Phase 2 never ran: do it now.
2. `design_plan.json` and `scene_list.md` both exist in your artifact directory and equal what you used.
3. If `task_complete` is refused (nothing created yet), go back to Phase 2 and create the designs; never loop on `task_complete`.
4. If the design plan could not be covered at all, call `task_failed`.

Keep replies concise (see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`). The `task_complete` summary uses exactly this format; counts come from the audit and from your own calls, never from the plan (the check sees only the first ~200 characters of the call, hence skipped/renamed first, as FULL keys, never counts):

```
skipped (existing): <full keys> or none
renamed: <old key> -> <new key> (only if any)
designs: <created>/<planned> - characters a/b, locations a/b, outfits a/b, storyboards a/b
failed: <key: error> or none
loras: <n> sent in create_design calls; missing: <scene: tags> or none
```

(the `loras` line only when nudity is `allowed`.) Add `file mismatch:` and `flagged:` lines (invalid `nude` pairs, entries that looked wrong) only when they occurred.

## Key rules

0. Names are never mapped by guesswork: a scene-list character or look that is not in the character table is `task_failed` (Phase 0, step 3b); one location per `location_slug` (rows + beat `Location`).
1. Outfit rule, character look and scene pairs: "Characters and outfits" - nowhere else.
2. Characters before outfits; outfits always link `{role:"character", key:"character_<slug>"}`.
3. Slugs follow one normalization; keys <= 64 chars; names unique across kinds. Every `create_design` passes `key_slug` (the planned key's slug); `display_name` never decides a key.
4. `start` is always `"attributes"`, `initial_drafts` 1.
5. Idempotent: never recreate an existing design.
6. Never write `design.json` or any design file; only `design_plan.json` and `scene_list.md`.
7. Execute `designs` literally; storyboards are created last, linked by the ACTUAL keys.
8. Nudity `allowed`: `lora_index` in Phase 0, LoRAs on the entries and in the `create_design` calls, missing ones reported.
