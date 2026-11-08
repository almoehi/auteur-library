---
name: plan-designs
description: >
  Use when your task prompt says "Load and use skill: plan-designs" — turn the character
  table and the scene list into a design plan and create one studio design (character,
  outfit, location) for every entry with a single create_designs call, then one storyboard
  design per scene. Produces design_plan.json and the scheduled design tasks. Do NOT invoke for drafting or
  rendering design images (design-asset) or storyboard keyframes (storyboard-scene), writing
  screenplays or scene lists, or creating a single design on request.
agentType: worker
---

# Plan Designs

Plain LLM planning worker: read text, write `design_plan.json` one entry per `write_design` call, then ONE `create_designs` call creates every design of the plan.

- Tools: `artifact_index`, `task_index`, `read_artifact`, `write_design`, `create_designs`, `task_complete`, `task_failed`.
- `create_designs` takes no input: it reads your own `design_plan.json` and creates every entry that has no design yet, in the file's order. It needs `can_create_tasks: true` on your task. Never create designs one by one, and never pass `policies`.
- Output file: `design_plan.json` only, written with `write_design` (the checks read the scene list from your `scene_list` input; never copy it).
- Never render, draft or write any design file (`design.json` included); design workers (`design-asset`, `storyboard-scene`) continue each design.
- Replies: see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`.

## Characters and outfits (authority; other skills point here)

Content policy = `{workspace.contentPolicy.nudity}` (absent or empty = `forbidden`). A minor (child, teen, anyone under 18) is ALWAYS planned as `forbidden`.

Setting = `{workspace.story.setting}` (a given fact, never inferred from the plot): garments, accessories, props and architecture of every design belong in it, and a location's `era` states it unless the screenplay names another time for that place.

- Outfits: exactly ONE outfit design per WARDROBE TRACKER row (look slug = the row's look slug); no exceptions (no "most worn", no "differs visibly" judgement). A tracker row that is nudity itself (no garments) is not an outfit.
- Character design `wardrobe`, decided by AGE and POLICY only:
  - nudity `allowed` + human adult (18+ stated or clearly implied): `nude`, for EVERY such adult.
  - minor, nudity `forbidden`, or clothed non-human: plain neutral clothing in construction terms (e.g. "plain neutral clothing: fitted grey cotton crew-neck t-shirt, straight-leg charcoal trousers").
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
2. `read_artifact(artifactId="scene_list")`: scene table columns `Scene #`, `Episode` (micro-drama briefs only), `INT/EXT`, `Location`, `location_slug`, `Time of day`, `Lighting`, `Summary`, `Characters present`, `Outfits`; a Beats section (beat, action, framing, camera move, continuity, `Outfits`, `Location`) follows.
   - A `## Places` table follows the scene table: `location_slug`, `set`, `space`, `connections`. Missing or incomplete -> `task_failed` naming it (`run-preproduction`'s `create_scenes` writes it).
   - A beat whose `Location` differs from its row's slug (`parallel`) is an extra location of the scene.
3. Read the `character_<slug>.md` files (`artifact_file`): `VISUAL PROFILE`, `WARDROBE TRACKER`.
   - Reconcile before planning: collect scene-list character slugs and look slugs vs the table's file stems and tracker looks (`nude` / `none` are always valid).
   - Any unknown slug or look -> `task_failed` naming BOTH sets. Never map names by guesswork.
4. `read_artifact(artifactId="screenplay")`: use it to confirm the Places `connections` (doors, windows, what lies beyond) and the property's look for `set_style`; never to add characters, places or looks.
5. Re-run: if your `design_plan.json` already holds entries, `read_artifact` it and keep them (send an entry again with `write_design` only to fix it); `create_designs` skips designs that already exist, so there is nothing to inspect first.
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
| character | `character_type` (own entry field, not an attribute: woman, man, non-binary person, child, elderly person, animal, creature, robot, fantasy being, or free text); attributes `age`, `ethnicity`, `hair`, `eyes`, `build`, `wardrobe`, `features`, `voice` |
| outfit | `garments`, `colors`, `pattern`, `material`, `fit`, `accessories` (from the tracker row); `garments` in construction terms, one comma-joined entry per garment: type and cut, then defining details ("cropped double-breasted wool blazer with gold buttons, high-waisted wide-leg trousers, pointed-toe leather pumps"), never vague tags ("nice outfit", "sparkly dress"), never details the sources do not state |
| location | `place`, `space` (`interior` \| `exterior`, from the Places row), `era`, `time_of_day`, `weather`, `lighting`, `mood`, `set`, `set_style`, `connections`, `views` |

   - Character `hair`, `build` and `features` copy the profile's face, hair, skin tone and distinguishing marks verbatim; never summarize them away.
   - A character that is not human-sized (a doll, a toy, a pet, a small creature, a giant) starts `features` with its true size and what it is ("11.5-inch doll", "cat-sized dragon", "3 m tall giant"): its reference picture shows no scale, and the server names every picture and shot of it with that size.
   - Character `voice` (heard, never pictured: the finish records a short voice sample from it, and every clip passes it verbatim): comma-joined descriptors in this order - pitch (low / mid / high), timbre (gravelly, warm, breathy, nasal, smooth ...), apparent age, accent, pace, and ONE signature quality (a rasp, a lilt, a clipped delivery, a habitual sigh). Take what the profile states about the voice; otherwise invent one that fits the character's age, type and role. EVERY speaking character gets a `voice`, and the voices of the whole cast must differ CLEARLY: before writing the plan, list all voices side by side and make sure no two characters share the same pitch AND timbre, and that two characters who share a scene differ in at least pitch, timbre and pace. A non-speaking character (an animal, a creature without speech) gets no `voice`. Never name a real person, actor or celebrity as a voice reference.
   - One moment per design: ONE `time_of_day`, `lighting`, `weather`, season — the first scene's (else the most common); never several in one attribute.
   - Location attributes describe ONLY the place; `mood` only when the source gives the place's own atmosphere, else omit.
   - Under `forbidden` (and always for a minor) people are fully clothed.
   - `views` (optional, every kind but storyboard; typically 2-4 entries, at most 10 (the standard views come on top), separated by `; ` - never by a comma: one entry may contain commas): the NAMED VIEWS the scene-list beats need beyond the design's main picture AND beyond the STANDARD views. A character gets `front`, `profile`, `back` and `face`, an outfit `front`, `profile` and `back`, made automatically at Finish: NEVER list them or a synonym ("standing facing the camera", "seen from behind", "side view", "profile", "close-up of the face"). Write each entry as ONE phrase whose parts are joined by words ("with", "and", "while"), e.g. `standing with her back to the camera and both palms pressed flat in front of her; kneeling upright with hands on the thighs; laughing`. `design-asset` makes one extra picture per entry; a shot picks it with `(view <id>)` (`storyboard-scene`). Only what a beat actually needs; omit the key when none.
     - location: camera DIRECTIONS the beats look toward that a typical establishing view of the place does not show ("facing the pool", "looking back at the villa"); a direction is a short phrase naming what the camera faces. State the TURN in the entry whenever you know it: `<phrase> (left 45°)` / `(left 90°)` / `(right 45°)` / `(right 90°)`, e.g. "facing the pool (right 90°)" (the pool lies a quarter turn to the right of the main picture; the web studio and `design-asset` read the direction from those words, never from the phrase; the view id is the whole entry as a slug). Only turns of at most 90° from the main picture (left / right / a quarter turn): the view tool turns the camera up to 90° reliably. The opposite direction ("reverse", 180°, "the other side of the property") is NOT a view: plan it as its own sibling location of the same set (`set_anchor` link, own `connections`).
     - character, outfit: POSES and EXPRESSIONS the beats need ("kneeling and looking back over the shoulder", "lying on her side propped on one elbow", "laughing", "eyes closed"); one pose or expression per entry, in BODY words only: posture, which way the body faces the camera, arms / hands, head, expression. Never a place, furniture, an object, another person, a clothing state or the story ("back to the vanity", "facing him", "flies open" do not belong in a view: the view is a reference picture on a plain backdrop, the shot adds the rest). A view is always the person SEEN BY A CAMERA, never what they see of their own body (a first-person / POV picture: only a storyboard's `POV:` shot makes one; the view tool refuses it).
       - Put each view on the design whose LOOK the beats that need it show, read from those beats' `Outfits` cell: a beat with the character's base look (`<character>:nude`, `:none`, or the character's plain look) -> the CHARACTER design; a beat with an outfit look (`<character>:<look slug>`) -> that OUTFIT design. A pose the beats need in both looks goes on both. Never put a view on the character design for beats that only ever show the person in an outfit: the character design is nude or neutral, so the view would show the wrong look.
       - Never a view of the main picture's own pose: standing, facing the camera, arms at the sides (in any wording) IS the main picture, so it adds nothing. Every entry must differ from it, and from the standard `front` / `profile` / `back` / `face`, in posture, facing, arms / head or expression.
       - Two-person beats (an act, a carry, an embrace): the act itself is not a view (the storyboard renders it), but the person's OWN body in it is - read each such beat for what this person's head, back, hips, arms and face do, alone: "head thrown back with eyes closed", "back arched with the chest lifted", "bent forward at the waist", "arms raised and crossed behind the head", "biting the lower lip". A character whose base-look beats are mostly acts gets 2-4 such views on the character design, never one placeholder; a character design with no view at all is right only when no base-look beat shows a pose or expression other than the main picture's.
4. LoRAs: assign none. Never write `loras` or tag-based LoRA lists into the plan; the design's agent and the storyboard's shot curation pick LoRAs from the catalog's names and descriptions ("Curated LoRAs" in `workflow-calling-conventions`).
5. Storyboards: per scene key `storyboard_scene_<n>` (`display_name` "Scene <n>", `key_slug` `scene_<n>`) with attributes `scene` = `<n>`, `notes`, `format`:
   - `notes` = the Summary.
   - `format` `portrait` | `landscape`: from the production canvas `{workspace.profiles.master.video.width} x {workspace.profiles.master.video.height}` ("Workspace facts"): `portrait` when the height is larger than the width (e.g. 9:16), else `landscape` (also when empty); never ask; the SAME value for every scene.
   - `links` (only settable at creation; `storyboard-scene` places shots only at linked locations): one `location` link per place the scene uses (row slug design FIRST, then parallel-beat places); one `character` link per `Characters present`; one `outfit` link per `Outfits` pair that has an outfit entry. Every given link is required (the storyboard task waits until those designs are finished). Check before creating it: every look worn in ANY beat of the scene — every `<c>:<look>` pair of the row's AND the beats' `Outfits` (not `nude` / `none`), the earlier look of a character who undresses mid-scene included — has its outfit link — links are fixed at creation, and a missing one leaves the storyboard without that outfit's picture. `create_designs` reports a storyboard missing any of the scene's place / character / outfit links as a `refused` row listing the missing ones as `{ role, key }`: add them to that entry's `links` with `write_design` and call `create_designs` again.
6. `sets` and `designs` (THE work list: every key in creation order - characters, set anchors and standalone places, set members, outfits, storyboards by scene) are filled in by `write_design`; never write them yourself.
7. Write `design_plan.json` ONLY with `write_design` - ONE entry per call, a few calls per reply, in creation order (a link must name an entry already written). Never write it with `sandbox_write_file`, and never copy `scene_list.md` (the checks read the `scene_list` input).
   - An entry = the design's creation arguments (`kind`, `display_name`, `key_slug`, `character_type`, `attributes`, `links`, `distinct_place`; no `start`, no `loras`) plus `scenes` and, for an outfit, `character_slug` and `look_slug`.
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

- The file name is canonical: `design_plan.json` in the `design_plan` artifact; if the declared files differ, still write it and add `file mismatch: <declared> vs design_plan.json` to the summary.
- Writing files is NOT completion: Phase 2 must follow. If `task_complete` is refused because nothing was created or plan entries have no design, go to Phase 2; never loop on `task_complete`.

## Phase 2 — Create the designs with `create_designs`

Once every entry is written, call `create_designs` ONCE (no input). It creates every entry without a design in the file's order and returns a count line, then one row per key (`- <key>: created|existing - task id <id>` or `- <key>: REFUSED|BLOCKED - <reason>`):

- `created`: the design now exists (key, `@name`, task id).
- `existing`: a design with that key already exists (a failed one counts); nothing was created.
- `refused`: the entry was not created; the row names the problem.
- `blocked`: not attempted because a link names a `refused` or `blocked` key.

Repeat until no row is `refused` or `blocked`:

1. Fix each `refused` entry with `write_design` (same `kind` + `key_slug` replaces it), as the row says: e.g. add the missing `{ role, key }` links, a different `key_slug` when the name clashes (`design name "<n>" is already used by "<key>"`: the name derives from `key_slug`, so a new display name alone never helps; append the kind: `harbor` -> `harbor_location`, and fix every link to the old key), or a `set` identical to the anchor's. A `set_anchor` must be an anchor itself (star topology): fix the plan, do not drop the link. `blocked` rows need no change of their own; they clear once the key they wait for is created.
2. Call `create_designs` again (idempotent: rows already created come back `existing`).
3. A row you cannot fix (the same problem after a fix, or one that needs input you do not have) -> `task_failed(reason)` naming the key and the problem.

Never re-judge, skip, merge or add entries beyond these fixes (an odd-looking entry is created and noted).

## Phase 3 — Audit and complete

1. The last `create_designs` result has only `created` / `existing` rows. `task_complete` is refused while any plan key has no design (the refusal names the missing keys): call `create_designs` again.
2. `design_plan.json` exists in your artifact directory and equals what you used.
3. `task_complete` summary, exactly this format (counts from the last `create_designs` result: created = its `created` rows, planned = all its rows):

```
designs: <created>/<planned> created, the rest existing - characters <n>, locations <n>, outfits <n>, storyboards <n>
```

- Add `file mismatch:` and `flagged:` lines only when they occurred.
