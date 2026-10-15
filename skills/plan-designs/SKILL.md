---
name: plan-designs
description: >
  Use when your task prompt says "Load and use skill: plan-designs" — turn the character
  table and the scene list into a design plan and create one studio design (character,
  outfit, location) for every entry with create_design, then one storyboard design per scene.
  Produces design_plan.json and the scheduled design tasks. Outfit designs are created only for looks differing visibly from a character's base look. Do NOT invoke for drafting or
  rendering design images (design-asset) or storyboard keyframes (storyboard-scene), writing
  screenplays or scene lists, or creating a single design on request.
agentType: worker
---

# Plan Designs

You are a plain LLM worker. You read text, write one JSON file, and call `create_design`.
Your output files are plain text only: `scene_list.md` (Markdown) and `design_plan.json` (JSON), never PDF, DOCX or any other binary/office format.
You never render images. Each `create_design` creates a design task that a design worker
(skill `design-asset`, for storyboards `storyboard-scene`) and the person in the design studio continue.

You run on the `design_planner` agent. Tools: `artifact_index`, `task_index`, `read_artifact`, `lora_index`, `sandbox_write_file`, `create_design`,
`task_complete`, `task_failed`.

**Content policy** (`{workspace.contentPolicy.nudity}`; absent or empty = `forbidden`) decides two
things below: the base look of a character ("Base look and outfits") and the NSFW LoRA plan
(Phase 1 step 6). A minor (a child, teen or anyone under 18) is ALWAYS planned as under
`forbidden`, whatever the policy.

## Phase 0 — Preflight

1. `artifact_index`: find the artifacts `character_table` and `scene_list`. Both must be
   approved and readable. Note your own output artifact id (the task's artifact) for paths.
2. `read_artifact(artifactId="scene_list")`: must contain a table with columns
   `Scene #`, `INT/EXT`, `Location`, `location_slug`, `Time of day`, `Summary`,
   `Characters present`, `Outfits` (`<character_slug>:<look_slug>` pairs separated by `; `).
   Below the scene table a `Beats` section (per scene: beat, action, framing, camera move, continuity) may
   follow: it is not part of the scene table and does not change the plan, but your `scene_list.md`
   copy stays verbatim, Beats included.
3. Read the character table files (pass `artifact_file`): `character_<slug>.md`, each with
   `VISUAL PROFILE` and `WARDROBE TRACKER`.
4. Existing designs (idempotency): `artifact_index` keys starting `character_`, `outfit_`,
   `location_`, `storyboard_`, plus `task_index`. Remember them as `existing`.
If an input is missing or unparseable: `task_failed` with a clear message naming it. Write nothing.

## Phase 1 — Extraction -> design_plan.json

1. Build the entity lists:
   - **characters**: every `character_<slug>.md` file; plus any character named in the scene
     list but without a file (flag in the summary; create it from the scene context only).
   - **locations**: distinct `location_slug` values of the scene list; display name from the
     `Location` column.
   - **looks**: distinct (character_slug, look_slug) pairs from the `Outfits` column, plus
     looks in WARDROBE TRACKERs that are used in a scene. Looks are candidates only; see
     "Base look and outfits" below for which become outfit designs.
2. **Base look and outfits** (per character, decide before writing anything). Default (clothed
   base):
   - Choose ONE **base look**: the look the character wears in the most scenes (tie: the look of
     their first appearance). The character design wears it: it becomes the character's base
     `wardrobe` attribute, and its slug is recorded as `base_look` on the character entry of
     `design_plan.json`. The character design COVERS the base look: no outfit design for it.
   - Create an **outfit design only for a look that differs visibly from the base look**: other
     garments or a clear costume change (e.g. a raincoat over pyjamas).
   - These are NOT outfits: the base look itself; the same garment in another state ("messy
     pyjamas", "wet coat", "torn shirt"); accessory-only changes (hat, glasses, bag); "natural
     fur", "no clothes" or any look that is just the character's own body; a character's only look.
   - Result: `outfits` lists only non-base, visibly different looks. A scene-list pair
     `<character>:<base_look>` is covered by the character design.

   **Nude base - overrides the default** for a character that meets ALL of: nudity is `allowed`;
   human (`character_type` woman, man, non-binary person or elderly person, or free text naming
   an adult human); stated or clearly implied age 18+; NO look of it is younger than 18
   (flashback, "young X"). Anything else - unknown age, child, teen, animal, creature, robot -
   keeps the clothed base. A minor-age look of an adult character is its OWN character design
   (clothed base, name e.g. `young_<slug>`), never an outfit of the nude design.
   - The character design is the NUDE body (identity reference for every shot; dressing an
     image is reliable, undressing is not): `wardrobe` = `nude`, `base_look` = `nude`.
   - A pair whose look is no clothes / nude / naked (whatever its slug) is covered by the
     character design: no outfit, no link.
   - Exceptions to "These are NOT outfits": the most-worn look and a character's only look ARE
     outfits; EVERY clothed look a scene uses is an outfit design (drafted as an edit dressing the
     nude primary).
   - A garment-state or accessory-only variant ("wet coat", "with hat") is not its own outfit: it
     maps to the outfit of the look it varies (storyboards link that outfit for the pair).
   - An EXISTING character design (`existing`) keeps its regime: if it is clothed, record its
     actual wardrobe slug as `base_look` and plan as the clothed base for that character.
3. **Normalize slugs** (single rule, apply everywhere): lowercase, ASCII, non-alphanumerics to
   `_`, collapse repeats, trim `_`. Result must match `[a-z0-9]+(_[a-z0-9]+)*`.
   Key = `<kind>_<name>`, at most 64 characters (for outfits the name is `<character>_<look>`);
   shorten the look slug if needed. Design names are unique across ALL kinds, so a location
   slug must not equal a character slug (suffix `_place` to the location if it does).
4. **Merge duplicates and variants** ("Mira", "MIRA", "young Mira" = same slug `mira`; a
   different age or costume is an outfit/look, not a new character - except under a nude base,
   where a minor-age look is its own clothed character design, see "Nude base").
   Style is not an attribute: never add the story's medium/style as a design attribute; `design-asset` carries it from `{workspace.story.plot}` into every prompt.
5. **Map attributes** to registry keys (values are short comma-joined descriptors, never sentences):

| kind | `character_type` (create_design field) / attribute keys |
|---|---|
| character | `character_type`: woman, man, non-binary person, child, elderly person, animal, creature, robot, fantasy being, or free text; attributes: `age`, `ethnicity`, `hair`, `eyes`, `build`, `wardrobe`, `features` |
| outfit | `garments`, `colors`, `pattern`, `material`, `fit`, `accessories` |
| location | `place`, `era`, `time_of_day`, `weather`, `lighting`, `mood` |

   Base `wardrobe`: a nude-base character gets `nude` (never a garment; its clothed looks are
   outfits). Every other character gets its base look (see "Base look and outfits"; e.g.
   "school uniform", "worn leather jacket, jeans"), described from the WARDROBE TRACKER, even
   when other looks are separate outfit designs; when the sources state none, give a plain everyday one ("simple, plain everyday clothing").
   Under `forbidden` - or ALWAYS for a minor whatever the policy - people are fully clothed and
   'nudity, nude, naked' goes in the negative prompt.
   **One moment per design picture**: a design (a location above all) gets ONE base `time_of_day`,
   `lighting`, `weather` and season - the one its first scene uses (else the most common one). Never
   list several together in one attribute ("night, also sun-flooded morning" renders as a
   two-panel image); other moments of the same place are later edits or variations of the finished
   design, not extra attribute text.
   Put only what the sources state; omit unknown keys (except the base `wardrobe`). `character_type` is passed as its own
   argument, not inside `attributes`.
6. **NSFW LoRA plan** (only when nudity is `allowed`; skip entirely otherwise, and never for a
   scene with a minor in it). The base model renders explicit content only with the right LoRAs,
   so plan them per design now - the design workers load what you attach:
   1. From each scene's row and Beats, list the explicit **content** it shows, as short tags in
      three groups: **acts** (the sex act / position: e.g. blowjob, missionary, cowgirl,
      doggystyle, masturbation, kissing nude), **anatomy / detail** (nude bodies: breasts,
      nipples, genitals (female / male), pubic hair, erection, ...), **poses** (body pose or
      framing an act needs: kneeling, spread legs, lying on back, POV, ...). A scene without
      nudity or sex has none.
   Every nude-base character also has fixed tags: the nude anatomy of its sex (breasts, nipples,
      vulva / penis, pubic hair) - whether or not a scene shows it explicitly.
   2. Call `lora_index()` ONCE. For every tag pick the catalog LoRA whose **trigger words or
      description** match it (several tags may share one LoRA); also note one **general NSFW**
      LoRA (nudity / sex in general) if the catalog has one. Never invent a name; never pick a
      LoRA that matches no tag ("never load a LoRA just because the catalog has one"). Note each
      LoRA's `modelFamily`.
   3. **Attach** (the `loras` argument of `create_design`, names exactly as `lora_index` lists
      them, strength omitted = the catalog default):
      - **storyboard** of a scene with tags: the general NSFW LoRA, then its act, anatomy and pose
        LoRAs (the storyboard worker picks per shot which apply);
      - **nude-base character**: the anatomy LoRAs of its sex (never act LoRAs) - so the nude
        reference is anatomically right;
      - outfits and locations: none.
      At most 4 LoRAs per design, most important first: general > act > anatomy > pose.
   4. Tags without a catalog LoRA are **missing**: list them in `design_plan.json`
      `nsfw_loras.missing` (per scene or per character) and in the summary, so the person can
      import one (Civitai import in the studio / API) - never block on them.
7. Write BOTH output files into `/workspace/<your artifact id>/` with `sandbox_write_file`:
   `scene_list.md` first (an exact, character-for-character copy of the `scene_list` artifact's text as you read it; no edits, no summary) because the `design-plan-covers-scenes` task check judges the contents of all your output files, then `design_plan.json`:

```json
{
  "characters": [
    { "name": "Mira", "slug": "mira", "character_type": "woman", "base_look": "work_suit",
      "attributes": [ { "key": "age", "value": "late 20s" }, { "key": "hair", "value": "auburn, shoulder length" },
                      { "key": "wardrobe", "value": "grey work suit" } ],
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

With nudity `allowed`, a nude-base character entry reads
`{ "name": "Lena", "slug": "lena", "character_type": "woman", "base_look": "nude", "attributes": [ …, { "key": "wardrobe", "value": "nude" } ], … }`
and the plan adds the top-level key `nsfw_loras` (tags and the LoRA names attached to each design):

```json
"nsfw_loras": {
  "scenes": [
    { "scene": 3, "acts": ["blowjob"], "anatomy": ["breasts", "penis"], "poses": ["kneeling", "pov"],
      "storyboard_loras": ["<catalog name>", "<catalog name>"] }
  ],
  "characters": [ { "slug": "lena", "tags": ["breasts", "vulva"], "loras": ["<catalog name>"] } ],
  "missing": [ { "scene": 3, "tags": ["deepthroat"] }, { "character": "lena", "tags": ["pubic hair"] } ]
}
```

Both file names are canonical: write exactly `scene_list.md` and `design_plan.json` into the `design_plan` artifact. If the files declared on the artifact differ, still write these two names and report the mismatch in the `task_complete` summary (line `file mismatch: <declared> vs scene_list.md, design_plan.json`). Every outfit's `character_slug` must exist in `characters`, every character has a `base_look` (the look slug it wears; omit only when the sources name no look at all), and no outfit's `look_slug` equals its character's `base_look`.

## Phase 2 — Create the designs

Order: all characters first, then locations, then outfits (an outfit links to its character), then the storyboards (they link to the designs created before).
Skip any entity whose key is in `existing` (record as skipped). One call per entity:

- character: `create_design({ kind: "character", display_name: "<name>", start: "attributes", character_type, attributes, initial_drafts: 1 })` (+ `loras: [{ "name": "<catalog name>" }, …]` from the NSFW LoRA plan, when it has any)
- location: `create_design({ kind: "location", display_name: "<name>", start: "attributes", attributes, initial_drafts: 1 })`
- outfit: `create_design({ kind: "outfit", display_name: "<display_name>", start: "attributes", attributes, initial_drafts: 1, links: [{ "role": "character", "key": "character_<character_slug>" }] })`

`start: "attributes"` needs a non-sheet text-to-image workflow in the workspace (an outfit needs an image-to-image one: it is drafted as edits of its character's primary, and it only starts once its character design is finished - always pass the character link); `character_type` is REQUIRED for characters (custom text is allowed, e.g. "ghost"). A refusal result starts with `error:`; a success reads `Design created: key <key>, @<name>, task id <id>, status <status>`. Treat any result not starting with `Design created` as not created.

Never pass `policies` to `create_design` (the tool does not accept it; designs go through human review), even if the task prompt names checks. Call sequentially (one at a time) and keep
each result's key, `@name` and task id.

**Keep a registry of the ACTUAL keys** while you go (`<slug> -> key` per kind, from each
`Design created: key <key>` result, or the existing/reused key on a skip or "already used by"
reuse, or the renamed key after a suffixed retry). Never derive a key from a slug again later.

### Storyboards (after all outfits)

One storyboard per scene of the scene list (`Scene #` = `<n>`), skipping scenes whose key
`storyboard_scene_<n>` is in `existing`. `display_name` is `Scene <n>` (the design name is its
slug, so the key becomes `storyboard_scene_<n>`; check the result's key). Links come from the
registry, mapped from the scene's row:

- `location`: the key of the scene's `location_slug` design (exactly one);
- `characters`: the keys of every slug in `Characters present` (one link each);
- `outfits`: the keys of every `<character_slug>:<look_slug>` pair of the `Outfits` column
  (one link each). A pair whose look is the character's `base_look` has no outfit design: the
  character link covers it (no outfit link, not reported as missing). With a nude base that is
  exactly the nude / no-clothes pairs; every clothed pair links its outfit. Any other pair whose outfit
  design failed or does not exist is dropped and noted.

```
create_design({ kind: "storyboard", display_name: "Scene <n>", start: "attributes",
  attributes: [ { key: "scene", value: "<n>" }, { key: "notes", value: "<Summary of the scene, optional>" } ],
  initial_drafts: 1,
  loras: [ { name: "<catalog name>" }, … ],   // NSFW LoRA plan of the scene; omit when none
  links: [ { role: "location", key: "<location key>" },
           { role: "character", key: "<character key>" }, …one per character…
           { role: "outfit", key: "<outfit key>" }, …one per outfit… ] })
```

(`initial_drafts` = drafts PER SHOT, default 1. A role is repeated once per linked design; if the
tool refuses a role name, use the role names its error or description lists.) Every given link is required: the storyboard
task waits until those designs are finished, so never link a design you did not create or
find; if a link key is refused as unknown, re-check the registry and the `artifact_index`
for the renamed key, retry once, then drop only that link and note it. The storyboard also
needs the `scene_list` artifact (it is approved). The storyboard's duplicate-name refusal
(`already used by "storyboard_scene_<n>"`) means it exists: skip.

**Refusals:**
- `design name "<n>" is already used by "<key>"`: same kind as yours -> reuse it (skipped,
  noted); different kind -> retry once with a suffixed display name (`<name> (place)` / slug
  suffix) and record the rename.
- Outfit refused for a missing character: create the character first, then retry.
- A `loras` name refused as unknown: re-check `lora_index`, retry once with the exact names (or
  without the unknown one); never drop the design over a LoRA - note it under `missing`.
- Any other error: retry once; if it fails again record it as failed and continue.

## Phase 3 — Pre-completion audit

1. Re-run `artifact_index`; every design plan entry must have a design key now (created or
   pre-existing), and every scene must have a `storyboard_scene_<n>`. Re-create anything
   missing once.
2. `design_plan.json` and `scene_list.md` both exist in your artifact directory and equals what you used.
3. If any entity failed: `task_complete` is still correct only if all others are done and the
   summary lists the failures; if the design plan could not be covered at all, call `task_failed`.

Keep replies concise (see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`). `task_complete` summary format (omit lines that are empty/none except `failed`; name designs by their task URI `task://<id>` where known, never list every key when all went well):

```
design plan: <n> characters, <n> locations, <n> outfits (non-base looks only), <n> storyboards - all created
skipped (existing): <count, or keys only if few>
failed: <key: error> or none
nsfw loras: <n> attached to <n> designs; missing: <scene: tags> or none
```
(the `nsfw loras` line only when nudity is `allowed`.)
Add `renamed:` / `file mismatch:` lines only when they occurred.

## Key rules

1. Characters before outfits; outfits always link `{role:"character", key:"character_<slug>"}` (the link makes the outfit wait for its character and is drafted from the character's primary - never omit it).
2. Slugs follow one normalization; keys <= 64 chars; names unique across kinds.
3. `start` is always `"attributes"`, `initial_drafts` 1.
4. Idempotent: never recreate an existing design.
5. Never write `design.json` or any design file; only `design_plan.json` and `scene_list.md`.
6. Outfits only for looks that differ visibly from the character's base look (the character design covers the base look); a nude base turns every clothed look into an outfit (see "Nude base").
7. One storyboard per scene (`storyboard_scene_<n>`), created last, linked by the ACTUAL
   design keys from the create results; existing storyboards are skipped. Storyboards are not
   part of `design_plan.json`.
8. Nudity `allowed`: the NSFW LoRA plan (Phase 1 step 6) - only catalog LoRAs matching a tag, attached via `create_design` `loras`, missing ones reported.
