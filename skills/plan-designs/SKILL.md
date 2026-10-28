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

Plain LLM planning worker: read text, write `design_plan.json` one entry per `write_design` call, call `create_design`.

- Tools: `artifact_index`, `task_index`, `read_artifact`, `sandbox_write_file` (only `scene_list.md`), `write_design`, `create_design`, `task_complete`, `task_failed`.
- `create_design` needs `can_create_tasks: true` on your task; use it only for the plan's designs. Never pass `policies` to it.
- Output files (plain text only, never PDF / DOCX): `scene_list.md` and `design_plan.json`.
- Never render, draft or write any design file (`design.json` included); design workers (`design-asset`, `storyboard-scene`) continue each design.
- Replies: see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`.

## Characters and outfits (authority; other skills point here)

Content policy = `{workspace.contentPolicy.nudity}` (absent or empty = `forbidden`). A minor (child, teen, anyone under 18) is ALWAYS planned as `forbidden`.

- Outfits: exactly ONE outfit design per WARDROBE TRACKER row (look slug = the row's look slug); no exceptions (no "most worn", no "differs visibly" judgement). A tracker row that is nudity itself (no garments) is not an outfit.
- Character design `wardrobe`, decided by AGE and POLICY only:
  - nudity `allowed` + human adult (18+ stated or clearly implied): `nude`, for EVERY such adult.
  - minor, nudity `forbidden`, or clothed non-human: plain neutral clothing (e.g. "plain neutral clothing: simple fitted grey t-shirt and trousers").
  - creature / animal wearing nothing: `none`; no tracker rows; scene pair `<c>:none`.
  - Never decided by nudity on screen or by character-table notes ("face never shown", "always clothed on screen"): the character design is the identity / anatomy reference.
  - An outfit's garments never go into the character's `wardrobe`.
- LoRAs are NOT planned here: each design's and storyboard shot's agent curates its own ("Curated LoRAs" in `workflow-calling-conventions`, the single definition).
- Scene-list pairs: plan from the scene rows' `Outfits` (union of the beats' looks).
  - `<c>:<look>` -> that look's outfit design (look must be a tracker row, Phase 0.3).
  - `<c>:nude` and `<c>:none` -> the character design only, no outfit entry (the character's full-body shot is the picture: the nude base, or the creature as it is).
  - An invalid `<c>:nude` (minor, creature, nudity forbidden) -> build an outfit entry from the scene context and flag it under `flagged:` in the summary.

## Sets (authority; other skills point here)

A SET = the locations of ONE property (a house with its terrace, garden and driveway). Sets keep the spaces looking like the same place: members are drafted from the set's anchor (`design-asset`).

- Group locations by the scene list's `## Places` table: same `set` value = one set. A standalone place is a set of one: no `set_anchor` link, no `connections` needed.
- Anchor (one per set, STAR topology: members link the anchor, the anchor links nothing, never a chain): the exterior space showing the facade; else the space with the most connections; else the one used in the most scenes.
- A location is a SPACE a camera stands in, never a surface or feature ("Grey House Wall", "Front Door"): fold such an entry into the space it belongs to (its `connections` and shot framing) and note it under `flagged:`.
- Per set write ONCE `set_style` (set bible: architecture, materials, palette, era, signature elements; from the screenplay and the anchor's `place`) on the anchor; `write_design` copies it (and `set`) verbatim onto every member that omits them, and refuses a member whose text differs. `set` = the property's display name, identical on every member.
- Per location `connections`: the Places row's facts with design KEYS ("glass doors in the back wall open onto location_backyard_pool_terrace; pool beyond them"). Both sides state the link.

## Phase 0 — Preflight

1. `artifact_index`: `character_table` and `scene_list` must exist, be approved and readable. Note your own output artifact id.
2. `read_artifact(artifactId="scene_list")`: scene table columns `Scene #`, `INT/EXT`, `Location`, `location_slug`, `Time of day`, `Summary`, `Characters present`, `Outfits`; a Beats section (beat, action, framing, camera move, continuity, `Outfits`, `Location`) follows.
   - A `## Places` table follows the scene table: `location_slug`, `set`, `space`, `connections`. Missing or incomplete -> `task_failed` naming it (`run-preproduction`'s `create_scenes` writes it).
   - Your `scene_list.md` copy stays verbatim, Places and Beats included.
   - A beat whose `Location` differs from its row's slug (`parallel`) is an extra location of the scene.
3. Read the `character_<slug>.md` files (`artifact_file`): `VISUAL PROFILE`, `WARDROBE TRACKER`.
   - Reconcile before planning: collect scene-list character slugs and look slugs vs the table's file stems and tracker looks (`nude` / `none` are always valid).
   - Any unknown slug or look -> `task_failed` naming BOTH sets. Never map names by guesswork.
4. `read_artifact(artifactId="screenplay")`: use it to confirm the Places `connections` (doors, windows, what lies beyond) and the property's look for `set_style`; never to add characters, places or looks.
5. Idempotency (always run; never assume nothing exists): `artifact_index` keys starting `character_`, `outfit_`, `location_`, `storyboard_`, plus `task_index` -> `existing`.
6. Missing or unparseable input -> `task_failed(reason)` naming it; write nothing.

## Phase 1 — Plan -> design_plan.json

Build every entry with its FINAL key; nothing is decided later.

0. Keep the reply short: first state the plan as a plain list of design keys, one line per key, in creation order (characters, set anchors, other locations, outfits, storyboards) - no long deliberation, no draft JSON in the reply. Then write the entries (step 7).

1. Entries:
   - `characters`: every `character_<slug>.md` stem; look per "Characters and outfits".
   - `locations`: ONE per distinct `location_slug` over scene rows AND all Beats `Location` cells (including slugs seen once); never two for one slug.
     - Per scene, places ordered: row slug first, then beat-`Location` slugs in beat order, no duplicates. A location's `scenes` includes every scene whose beats use it.
     - Display name: the row's `Location` text for a row slug, else the slug's words in Title Case.
     - Group into sets ("Sets"): the anchor carries `set` and `set_style` (required on a location of a set) and links nothing; a member links its anchor (`set_anchor`) and may omit `set` / `set_style` in its `write_design` call - they are copied from the anchor, so every member ends up with the same text.
   - `distinct_place: true` on a location whose shorter `key_slug` has at least two `_` words, all contained in another location's slug (`harbor_pier` / `harbor_pier_cafe`; one-word slugs never). No other entry has it.
   - `outfits`: per "Characters and outfits". Every outfit carries `character_slug` and `look_slug` (the tracker row) and the link `{ "role": "character", "key": "character_<character_slug>" }`.
   - `storyboards`: one per scene (step 5).
2. Slugs and keys:
   - slug = lowercase ASCII, non-alphanumerics to `_`, repeats collapsed, `_` trimmed; matches `[a-z0-9]+(_[a-z0-9]+)*`.
   - key = `<kind>_<key_slug>`; `key_slug` is the key without the kind prefix (`mira`, `pier_cafe`, `<character_slug>_<look_slug>` for outfits, `scene_<n>` for storyboards).
   - `display_name`: human name in Title Case ("Pier Cafe", "Mira - Raincoat"), independent of the key; never the story's full name.
   - Keys <= 64 chars: shorten the look part, note in `flagged:`.
   - Design names are unique across ALL kinds: a location slug must not equal a character slug (suffix `_place`, display "Harbor Place").
   - Merge duplicate characters ("Mira", "MIRA", "young Mira" = `mira`; another costume is a tracker row).
   - Never add the story's medium / style as an attribute (`design-asset` carries it).
3. Attributes (short comma-joined descriptors, never sentences; only what the sources state; omit unknown keys except the character `wardrobe`):

| kind | keys |
|---|---|
| character | `character_type` (own `create_design` argument, not an attribute: woman, man, non-binary person, child, elderly person, animal, creature, robot, fantasy being, or free text); attributes `age`, `ethnicity`, `hair`, `eyes`, `build`, `wardrobe`, `features` |
| outfit | `garments`, `colors`, `pattern`, `material`, `fit`, `accessories` (from the tracker row) |
| location | `place`, `space` (`interior` \| `exterior`, from the Places row), `era`, `time_of_day`, `weather`, `lighting`, `mood`, `set`, `set_style`, `connections`, `views` |

   - Character `hair`, `build` and `features` copy the profile's face, hair, skin tone and distinguishing marks verbatim; never summarize them away.
   - One moment per design: ONE `time_of_day`, `lighting`, `weather`, season — the first scene's (else the most common); never several in one attribute.
   - Location attributes describe ONLY the place; `mood` only when the source gives the place's own atmosphere, else omit.
   - Under `forbidden` (and always for a minor) people are fully clothed.
   - `views` (optional, every kind but storyboard; comma-joined, 2-4 entries, at most 6): the NAMED VIEWS the scene-list beats need beyond the design's main picture. `design-asset` makes one extra picture per entry; a shot picks it with `(view <id>)` (`storyboard-scene`). Only what a beat actually needs; omit the key when none.
     - location: camera DIRECTIONS the beats look toward that a typical establishing view of the place does not show ("facing the pool", "looking back at the villa"); a direction is a short phrase naming what the camera faces. State the TURN in the entry whenever you know it: `<phrase> (left 45°)` / `(left 90°)` / `(right 45°)` / `(right 90°)`, e.g. "facing the pool (right 90°)" (the pool lies a quarter turn to the right of the main picture; the web studio and `design-asset` read the direction from those words, never from the phrase; the view id is the whole entry as a slug). Only turns of at most 90° from the main picture (left / right / a quarter turn): the view tool turns the camera up to 90° reliably. The opposite direction ("reverse", 180°, "the other side of the property") is NOT a view: plan it as its own sibling location of the same set (`set_anchor` link, own `connections`).
     - character, outfit: POSES and EXPRESSIONS the beats need ("kneeling", "lying on the lounger", "laughing", "eyes closed"); one pose or expression per entry. A pose belongs to the character; put it on the outfit only when it shows the garment in a way the beats need (e.g. "sitting, coat open").
4. LoRAs: assign none. Never write `loras` or tag-based LoRA lists into the plan or `create_design` calls; the design's agent and the storyboard's shot curation pick LoRAs from the catalog's names and descriptions ("Curated LoRAs" in `workflow-calling-conventions`).
5. Storyboards: per scene key `storyboard_scene_<n>` (`display_name` "Scene <n>", `key_slug` `scene_<n>`) with attributes `scene` = `<n>`, `notes`, `format`:
   - `notes` = the Summary.
   - `format` `portrait` | `landscape`: from the story / plot (task prompt story line or "Workspace facts"), e.g. a vertical phone film = `portrait`; derive it, never ask; `landscape` if unstated; the SAME value for every scene.
   - `links` (only settable at creation; `storyboard-scene` places shots only at linked locations): one `location` link per place the scene uses (row slug design FIRST, then parallel-beat places); one `character` link per `Characters present`; one `outfit` link per `Outfits` pair that has an outfit entry. Every given link is required (the storyboard task waits until those designs are finished). Check before creating it: every look worn in ANY beat of the scene — every `<c>:<look>` pair of the row's AND the beats' `Outfits` (not `nude` / `none`), the earlier look of a character who undresses mid-scene included — has its outfit link — links are fixed at creation, and a missing one leaves the storyboard without that outfit's picture. `create_design` refuses a storyboard missing any of the scene's place / character / outfit links and lists the missing ones as `{ role, key }`: copy them into `links` and retry.
6. `sets` and `designs` (THE work list: every key in creation order - characters, set anchors and standalone places, set members, outfits, storyboards by scene) are filled in by `write_design`; never write them yourself.
7. Write into `/workspace/<your artifact id>/`: `scene_list.md` FIRST with `sandbox_write_file` (character-for-character copy of the `scene_list` artifact; the `design-plan-covers-scenes` check judges all output files), then `design_plan.json` ONLY with `write_design` - ONE entry per call, a few calls per reply, in creation order (a link must name an entry already written). Never write `design_plan.json` with `sandbox_write_file`.
   - An entry = the design's `create_design` arguments (`kind`, `display_name`, `key_slug`, `character_type`, `attributes`, `links`, `distinct_place`; no `start`, no `loras`) plus `scenes` and, for an outfit, `character_slug` and `look_slug`.
   - A set member may omit `set` / `set_style`: they are copied from its anchor (one text per set).
   - A refusal (`design <key> was NOT saved ...`) lists that entry's problems and their fix: fix exactly those and send that entry again; other entries stay. A wrong entry already written: send it again (same `kind` + `key_slug` replaces it) or `remove: true`.
   - Success reads `design <key> written (<counts> in design_plan.json)`.

Example calls (one production; a few per reply):

```json
[
  { "kind": "character", "display_name": "Mira", "key_slug": "mira", "character_type": "woman",
    "attributes": [ { "key": "age", "value": "late 20s" }, { "key": "wardrobe", "value": "nude" } ], "scenes": [1, 3] },
  { "kind": "location", "display_name": "Harbor", "key_slug": "harbor",
    "attributes": [ { "key": "place", "value": "foggy fishing harbor" }, { "key": "space", "value": "exterior" },
      { "key": "set", "value": "Harbor Quarter" }, { "key": "set_style", "value": "weathered timber, rusted steel, grey-blue palette" },
      { "key": "connections", "value": "pier steps lead down to location_harbor_pier_cafe" } ], "scenes": [1, 3] },
  { "kind": "location", "display_name": "Harbor Pier Cafe", "key_slug": "harbor_pier_cafe",
    "attributes": [ { "key": "place", "value": "small waterfront cafe" }, { "key": "space", "value": "interior" },
      { "key": "connections", "value": "window wall faces the pier of location_harbor" } ],
    "links": [ { "role": "set_anchor", "key": "location_harbor" } ], "scenes": [3] },
  { "kind": "outfit", "display_name": "Mira - Raincoat", "key_slug": "mira_raincoat", "character_slug": "mira", "look_slug": "raincoat",
    "attributes": [ { "key": "garments", "value": "yellow raincoat" } ],
    "links": [ { "role": "character", "key": "character_mira" } ], "scenes": [1, 3] },
  { "kind": "storyboard", "display_name": "Scene 1", "key_slug": "scene_1",
    "attributes": [ { "key": "scene", "value": "1" }, { "key": "notes", "value": "Mira reaches the harbor." }, { "key": "format", "value": "landscape" } ],
    "links": [ { "role": "location", "key": "location_harbor" }, { "role": "character", "key": "character_mira" },
               { "role": "outfit", "key": "outfit_mira_raincoat" } ] }
]
```

- The file names are canonical: write exactly these two into the `design_plan` artifact; if the declared files differ, still write them and add `file mismatch: <declared> vs scene_list.md, design_plan.json` to the summary.
- Writing files is NOT completion: Phase 2 must follow. If `task_complete` is refused because nothing was created, go to Phase 2; never loop on `task_complete`.

## Phase 2 — Create the designs

Walk the creation order (the file's `designs` array = your step-0 key list), one `create_design` per key; arguments = the entry as written WITHOUT the plan-only facts `key`, `scenes`, `character_slug`, `look_slug`, plus `start` / `initial_drafts` below. Never re-judge, skip, merge or add entries (an odd-looking entry is created and noted). Skip only keys in `existing` (record them). ONE `create_design` per response, issued after the previous result; NEVER several in one response: later outfits / storyboards link the ACTUAL keys earlier results report (renames, reuses), and an outfit is refused until its character exists. Keep each result's key, `@name` and task id.

- Common: `start: "attributes"`, `initial_drafts: 1`, `display_name`, `key_slug`, `attributes`.
- character: `{ kind: "character", character_type }` (`character_type` REQUIRED; custom text allowed).
- location: `{ kind: "location" }` + `distinct_place: true` when the entry has it; a set member also `links: [{ "role": "set_anchor", "key": <anchor's ACTUAL key from the registry> }]`. `create_design` refuses a `set_anchor` that itself has a `set_anchor`, and a `set` differing from the anchor's: fix the plan (star topology, identical `set`), do not drop the link.
- outfit: `{ kind: "outfit", links: [{ "role": "character", "key": "character_<character_slug>" }] }` (always pass the link; the outfit is drafted as edits of that character's full-body shot).
- storyboard: `{ kind: "storyboard", display_name: "Scene <n>", key_slug: "scene_<n>", links }` with the entry's attributes `scene`, `notes`, `format`.
- `start: "attributes"` needs a non-sheet text-to-image workflow in the workspace (outfits: an image-to-image one).
- Success reads `Design created: key <key>, @<name>, task id <id>, status <status>`; anything else (`error:` ...) is NOT created. Check the created key equals the entry's key.
- Keep a registry `planned key -> actual key` (from results, reused existing keys, renamed keys). Later links use actual keys; never re-derive a key from a slug.
- A link key refused as unknown: re-check the registry and `artifact_index`, retry once, then drop only that link and note it.

Refusals:
- `design name "<n>" is already used by "<key>"`: same kind -> reuse it (skipped, noted); different kind -> retry once with a DIFFERENT `key_slug` (the name derives from `key_slug`, so a new display name alone never helps; append the kind: `harbor` -> `harbor_location`) and record `renamed: <planned key> -> <created key>`.
- Outfit refused for a missing character: create the character first, retry.
- Any other error: retry once; if it fails again record it as failed and continue.

## Phase 3 — Audit and complete

1. Re-run `artifact_index` (mandatory). Missing = every key of `designs` (after renames / skips) not in the index.
   - Before creating a missing one, check for a rename: a design of the SAME kind created this run under another key is that entry -> record `renamed: <planned> -> <actual>`; never create a second design.
   - Create each remaining missing one (Phase 2 rules), re-audit.
2. `task_complete` is forbidden while any key is missing unless listed under `failed:` with its error. Zero `create_design` calls so far = Phase 2 never ran.
3. `design_plan.json` and `scene_list.md` exist in your artifact directory and equal what you used.
4. Plan not coverable at all -> `task_failed`.
5. `task_complete` summary, exactly this format (counts from the audit and your own calls; the check sees only the first ~200 characters, so skipped / renamed come first as FULL keys, never counts):

```
skipped (existing): <full keys> or none
renamed: <old key> -> <new key> (only if any)
designs: <created>/<planned> - characters a/b, locations a/b, outfits a/b, storyboards a/b
failed: <key: error> or none
```

- Add `file mismatch:` and `flagged:` lines only when they occurred.
