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

Plain LLM planning worker: read text, write `design_plan.json`, call `create_design`.

- Tools: `artifact_index`, `task_index`, `read_artifact`, `lora_index`, `sandbox_write_file`, `create_design`, `task_complete`, `task_failed`.
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
- Every `nude` character gets the general anatomy / realism NSFW LoRAs per image family (step 1.4) and is listed in `nsfw_loras.characters`.
- Scene-list pairs: plan from the scene rows' `Outfits` (union of the beats' looks).
  - `<c>:<look>` -> that look's outfit design (look must be a tracker row, Phase 0.3).
  - `<c>:nude` and `<c>:none` -> the character design only, no outfit entry (the character's full-body shot is the picture: the nude base, or the creature as it is).
  - An invalid `<c>:nude` (minor, creature, nudity forbidden) -> build an outfit entry from the scene context and flag it under `flagged:` in the summary.

## Phase 0 — Preflight

1. `artifact_index`: `character_table` and `scene_list` must exist, be approved and readable. Note your own output artifact id.
2. `read_artifact(artifactId="scene_list")`: scene table columns `Scene #`, `INT/EXT`, `Location`, `location_slug`, `Time of day`, `Summary`, `Characters present`, `Outfits`; a Beats section (beat, action, framing, camera move, continuity, `Outfits`, `Location`) follows.
   - Your `scene_list.md` copy stays verbatim, Beats included.
   - A beat whose `Location` differs from its row's slug (`parallel`) is an extra location of the scene.
3. Read the `character_<slug>.md` files (`artifact_file`): `VISUAL PROFILE`, `WARDROBE TRACKER`.
   - Reconcile before planning: collect scene-list character slugs and look slugs vs the table's file stems and tracker looks (`nude` / `none` are always valid).
   - Any unknown slug or look -> `task_failed` naming BOTH sets. Never map names by guesswork.
4. Idempotency (always run; never assume nothing exists): `artifact_index` keys starting `character_`, `outfit_`, `location_`, `storyboard_`, plus `task_index` -> `existing`.
5. Nudity `allowed`: call `lora_index()` ONCE now (never skip or guess it).
6. Missing or unparseable input -> `task_failed(reason)` naming it; write nothing.

## Phase 1 — Plan -> design_plan.json

Build every entry with its FINAL key; nothing is decided later.

1. Entries:
   - `characters`: every `character_<slug>.md` stem; look per "Characters and outfits".
   - `locations`: ONE per distinct `location_slug` over scene rows AND all Beats `Location` cells (including slugs seen once); never two for one slug.
     - Per scene, places ordered: row slug first, then beat-`Location` slugs in beat order, no duplicates. A location's `scenes` includes every scene whose beats use it.
     - Display name: the row's `Location` text for a row slug, else the slug's words in Title Case.
   - `distinct_place: true` on a location whose shorter `key_slug` has at least two `_` words, all contained in another location's slug (`harbor_pier` / `harbor_pier_cafe`; one-word slugs never). No other entry has it.
   - `outfits`: per "Characters and outfits". Every outfit's `character_slug` exists in `characters`.
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
| location | `place`, `era`, `time_of_day`, `weather`, `lighting`, `mood` |

   - One moment per design: ONE `time_of_day`, `lighting`, `weather`, season — the first scene's (else the most common); never several in one attribute.
   - Location attributes describe ONLY the place; `mood` only when the source gives the place's own atmosphere, else omit.
   - Under `forbidden` (and always for a minor) people are fully clothed.
4. NSFW LoRA plan (nudity `allowed` only; never for a scene with a minor):
   1. Per scene, list tags from its row and Beats: **acts** (`Sex act` names), **poses** (`Sex position` names, plus pose words like POV, spread legs), in the canonical names of "Explicit acts and positions" in `workflow-calling-conventions` (`none` = no tag; `other (...)` = its plain words); **anatomy / detail** (breasts, nipples, genitals, pubic hair, erection ...). Every `nude` character has tag `nude body`.
   2. From the Phase 0 `lora_index`, pick for each tag the catalog LoRAs whose trigger words or description match, in EVERY image family of the catalog (workers keep only their family). Skip video LoRAs and image-EDIT LoRAs. Never invent a name or pick a LoRA matching no tag.
      - General: a general NSFW / anatomy / realism LoRA goes with every explicit tag.
      - Acts: the act's own LoRA; else an all-in-one sex LoRA.
      - Anatomy / detail: a "when X is the subject of the frame" LoRA only for a scene where X is the focus.
   3. Attach as `loras: [{ "name": "<exact catalog name>" }]` (strength omitted): a storyboard with tags gets per family general, act, anatomy, pose LoRAs; a `nude` character gets per family the general anatomy / realism LoRAs only; outfits and locations none. At most 4 per model family per entry, priority general > act > anatomy > pose.
   4. Tags without a catalog LoRA in a family -> `nsfw_loras.missing` (scene or character, with family) and the summary; never block.
   - `nsfw_loras` (nudity `allowed` only) holds tags and `missing`; LoRA names live on the entries.
5. Storyboards: per scene key `storyboard_scene_<n>` with:
   - `notes` = the Summary.
   - `format` `portrait` | `landscape`: from the story / plot (task prompt story line or "Workspace facts"), e.g. a vertical phone film = `portrait`; derive it, never ask; `landscape` if unstated; the SAME value for every scene.
   - `links` (only settable at creation; `storyboard-scene` places shots only at linked locations): one `location` link per place the scene uses (row slug design FIRST, then parallel-beat places); one `character` link per `Characters present`; one `outfit` link per `Outfits` pair that has an outfit entry. Every given link is required (the storyboard task waits until those designs are finished). Check before creating it: every `<c>:<look>` pair of the row's AND the beats' `Outfits` (not `nude` / `none`) has its outfit link — links are fixed at creation, and a missing one leaves the storyboard without that outfit's picture. `create_design` refuses a storyboard missing any of the scene's place / character / outfit links and lists the missing ones as `{ role, key }`: copy them into `links` and retry.
6. `designs`: THE work list — every key in creation order: characters, locations, outfits, storyboards.
7. Write into `/workspace/<your artifact id>/` with `sandbox_write_file`: `scene_list.md` FIRST (character-for-character copy of the `scene_list` artifact; the `design-plan-covers-scenes` check judges all output files), then `design_plan.json`:

```json
{
  "characters": [ { "display_name": "Mira", "key_slug": "mira", "key": "character_mira", "character_type": "woman",
      "attributes": [ { "key": "age", "value": "late 20s" }, { "key": "wardrobe", "value": "nude" } ],
      "loras": [ { "name": "<catalog name>" } ], "scenes": [1, 3] } ],
  "locations": [ { "display_name": "Harbor", "key_slug": "harbor", "key": "location_harbor",
      "attributes": [ { "key": "place", "value": "foggy fishing harbor" } ], "scenes": [1, 3] } ],
  "outfits": [ { "character_slug": "mira", "look_slug": "raincoat", "key_slug": "mira_raincoat", "key": "outfit_mira_raincoat",
      "display_name": "Mira - Raincoat", "attributes": [ { "key": "garments", "value": "yellow raincoat" } ], "scenes": [1, 3] } ],
  "storyboards": [ { "scene": 1, "key_slug": "scene_1", "key": "storyboard_scene_1", "notes": "Mira reaches the harbor.", "format": "landscape",
      "links": [ { "role": "location", "key": "location_harbor" }, { "role": "character", "key": "character_mira" },
                 { "role": "outfit", "key": "outfit_mira_raincoat" } ], "loras": [] } ],
  "designs": [ "character_mira", "location_harbor", "outfit_mira_raincoat", "storyboard_scene_1" ],
  "nsfw_loras": { "scenes": [ { "scene": 3, "acts": ["blowjob"], "anatomy": ["breasts"], "poses": ["kneeling"] } ],
      "characters": [ { "slug": "mira", "tags": ["nude body"] } ], "missing": [ { "scene": 3, "family": "krea2", "tags": ["cowgirl"] } ] }
}
```

- Example is a nudity-`allowed` workspace; `nsfw_loras` only then; `loras` omitted or `[]` when none.
- The file names are canonical: write exactly these two into the `design_plan` artifact; if the declared files differ, still write them and add `file mismatch: <declared> vs scene_list.md, design_plan.json` to the summary.
- Writing files is NOT completion: Phase 2 must follow. If `task_complete` is refused because nothing was created, go to Phase 2; never loop on `task_complete`.

## Phase 2 — Create the designs

Walk `designs` in order, one `create_design` per key; arguments copied from the entry. Never re-judge, skip, merge or add entries (an odd-looking entry is created and noted). Skip only keys in `existing` (record them). ONE `create_design` per response, issued after the previous result; NEVER several in one response: later outfits / storyboards link the ACTUAL keys earlier results report (renames, reuses), and an outfit is refused until its character exists. Keep each result's key, `@name` and task id.

- Common: `start: "attributes"`, `initial_drafts: 1`, `display_name`, `key_slug`, `attributes`; omit `loras` when none.
- character: `{ kind: "character", character_type, loras }` (`character_type` REQUIRED; custom text allowed).
- location: `{ kind: "location" }` + `distinct_place: true` when the entry has it.
- outfit: `{ kind: "outfit", links: [{ "role": "character", "key": "character_<character_slug>" }] }` (always pass the link; the outfit is drafted as edits of that character's full-body shot).
- storyboard: `{ kind: "storyboard", display_name: "Scene <n>", key_slug: "scene_<n>", links, loras }` with attributes `scene` = `<n>`, `notes`, `format`.
- `start: "attributes"` needs a non-sheet text-to-image workflow in the workspace (outfits: an image-to-image one).
- Success reads `Design created: key <key>, @<name>, task id <id>, status <status>`; anything else (`error:` ...) is NOT created. Check the created key equals the entry's key.
- Keep a registry `planned key -> actual key` (from results, reused existing keys, renamed keys). Later links use actual keys; never re-derive a key from a slug.
- A link key refused as unknown: re-check the registry and `artifact_index`, retry once, then drop only that link and note it.

Refusals:
- `design name "<n>" is already used by "<key>"`: same kind -> reuse it (skipped, noted); different kind -> retry once with a DIFFERENT `key_slug` (the name derives from `key_slug`, so a new display name alone never helps; append the kind: `harbor` -> `harbor_location`) and record `renamed: <planned key> -> <created key>`.
- Outfit refused for a missing character: create the character first, retry.
- Unknown `loras` name: re-check `lora_index`, retry once with exact names (or without it); never drop the design over a LoRA; note under `missing`.
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
loras: <n> sent in create_design calls; missing: <scene: tags> or none
```

- `loras` line only when nudity is `allowed`. Add `file mismatch:` and `flagged:` lines only when they occurred.
