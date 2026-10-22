---
name: storyboard-scene
description: >
  Use when your task is a storyboard design — keyed `storyboard_scene_<n>` (e.g.
  "storyboard_scene_3") — or the task prompt says "storyboard scene 3", "draft the keyframes
  for scene 2", "write the shot list for a scene", or the person asks in the storyboard chat for
  a change ("add a close-up", "swap shots 2 and 3", "another angle for shot 4"). Produces
  `shotlist.md` (one section per shot) and hands a structured plan to `draft_storyboard`; the
  server then renders, checks and repairs the keyframe takes. Do NOT invoke for rendering
  keyframes or video clips yourself, character / outfit / location designs (that is
  design-asset), writing `design.json`, or publishing or finishing a design.
agentType: worker
---

# Storyboard Scene — plan, hand over

Analyze once, write `shotlist.md`, hand the plan to `draft_storyboard`, complete. The server
renders several candidates per shot, checks them, repairs what it can and records the best takes;
you render nothing. Prompt and reference conventions for the entity lines: `workflow-calling-conventions`
("References by extent", `load_skill` it).

## Hard rules

- Never write, rename or delete `design.json`, a take file or a published name (`full_body_shot.*`,
  `sheet.*`, `view_*`, `frame_*`). The server owns the takes; the person picks, discards and
  finishes in the studio.
- Never call a `wf_*` tool for a shot take (`take_<shotId>-…`) — it is refused. The only way to get
  shot takes is `draft_storyboard`.
- Write only `shotlist.md` into `/workspace/<artifact id>/`. `<shotId>` = `s<scene>-<nn>` (`s3-01`).
- Compose the whole `shotlist.md` silently first, then write it in ONE call; never a partial or
  draft file. A write that names an unlinked key or breaks R1–R7 is refused and writes nothing:
  fix what it lists and write again. A further rewrite while drafting is allowed only after a
  `draft_storyboard` refusal that names `shotlist.md`.
- `task_complete` is refused until `draft_storyboard` was accepted; never end a drafting turn
  text-only.

## 1 Analyze (read each input once)

- `read_artifact(artifactId="<task id>")`: artifact id, files, `design.json` (`scene`, `notes`,
  `links`: locations (first = default place), characters, outfits; `format` attribute).
- `scene_list`: the scene row and its Beats (action, Location, Outfits, framing, camera move,
  Continuity `continuous` | `parallel` | `new moment`, Blocking / Contact, Sex act / Sex position).
  `screenplay` (if any): the scene's slice.
- Each linked design: its digest (identity cue, outfit garments and colours, published
  `full_body_shot` / `sheet` refs; an older design's `primary.<ext>` stands in for
  `full_body_shot`). Never restate design documents.
- Note: the POV owner, `continuous` chains, beats holding several actions, shots with many people
  (the server binds one picture per principal plus the place and, for a continued shot, the parent
  frame; the number of pictures is limited, so a crowded shot is split by who is in frame).
- Preflight — on any gap call `task_failed(reason)` naming it, plan nothing: the scene row; ≥1
  linked location; every linked design readable with a published full-body shot.

## 2 Plan — `shotlist.md`

```
# Scene <n> shot list
Format: portrait

## s3-01 — Short title
Action: Wife, seated at the table, types on her laptop as the husband watches
Location: location_kitchen
Camera: medium, eye level
Movement: slow push-in
Blocking: husband is the camera (POV, seated); his forearms and hands enter the lower frame; wife across the table, facing him, her hands on the laptop; the two do not touch
Pose: wife: hands on the keyboard, head down
Frame: wife centre background; his hands bottom foreground
Visible: character_wife (upper body); character_husband (limbs: forearms and hands); nobody else
POV: character_husband (seated)
Characters: character_wife, character_husband
Outfits: character_wife:outfit_wife_office; character_husband:outfit_husband_suit
Duration: 4
Transition: cut — first shot of the scene
```

Every line is ONE line (no wrapping). The shot lines are the single authority for who is in frame
and how shots relate (the shot graph is read from `Transition:`); the structured plan of step 3
only adds placement and the compose prompt.

### Shots

- One shot = one moment, one place (`Location:`), one framing (`Camera:` = the opening frame).
- `Action:` = the ONE instant as a state, with participles: "Wife, standing, presses …";
  "Wife mid-stride toward the table, reaching for her laptop".
  - Two successive verbs ("stands and presses", "enters and crosses", "then") = two shots.
  - One shot: simultaneous actions joined by "as" / "while"; speech, breath or a sound together
    with one action; a progressing state ("thrusting faster", "pace building").
  - Visible only: no motives or camera motion. Speech goes on its own `Dialogue: <who>: "<words>"`
    line, never in `Action:` (Action shows only the visible part: mouth open, calling).
  - Bad → good: "Wife sighs and says it is late, closes the laptop and gets up" → s3-01
    `Action: Wife, seated at the table, sighing` + `Dialogue: Wife: "It's late"`; s3-02
    `Action: Wife, laptop closed, rising from her chair`.
    "Wife stands, moves to his chair, hands him the letter" → `Action: Wife, beside his
    chair, holding out the letter` (or one shot per action).
- Split a multi-action beat into one shot per action, in order; count actions, not beats.
- Typically 4–10 shots covering the whole scene in story order, an establishing shot first when
  the place is new. Sections follow story order; a split keeps its id for the first part.
- A `parallel` beat = its own cutaway shot at its place, its characters from that beat:
  `Transition: cut — cutaway (parallel action)`; the main action resumes in a later shot
  (`cut — back to …`).
- `Location:` = a linked location key; a place with no linked design → the nearest linked
  location, and name the gap in the summary.
- `Movement:` = the beat's camera move verbatim (`hold` only when the beat asks for stillness).
- `Transition:` from the beat's Continuity. The FIRST word is the mode and decides the shot graph:
  `continuous` → `continue — <reason>` (same place, moment, people; the framing may change), e.g.
  `Transition: continue — same moment, closer on the sister`; `parallel` / `new moment` →
  `cut — <reason>`, e.g. `Transition: cut — later that afternoon`. The reason says WHY in your own
  words — never the Continuity word itself (`cut — continuous` is a contradiction: write
  `continue — …`). The first shot is `cut — first shot of the scene`.
- `Duration:` 3–10 s. Ids consecutive from `01` on the first write; a rewrite never renumbers
  (new / split shots get ids after the highest).
- `Format:` on the line after the title, always: the `format` attribute, else the story's
  orientation, else `landscape`.

### Who is in frame

- Keys only, copied from `design.json.links` (never names or slugs) in `Location:`,
  `Characters:`, `Outfits:`, `Visible:`, `POV:`.
- `Visible:` = `<characterKey> (<extent>[: detail]); …; <exclusion>`; extent one of
  `full figure` | `upper body` | `face` | `back` | `limbs` | `lower body`; detail states counts
  (`limbs: one pair of hands`); the last segment is the exclusion clause (`nobody else`).
- `Characters:` = exactly the keys in `Visible:`; `Outfits:` = one valid pair per character
  (below), `; `-separated. Nobody in
  frame: `Characters: none`, `Outfits: none`, `Visible: nobody`.
- People without a design (extras, a crowd) get no key: they appear in `Action:` / `Frame:` and in
  the exclusion clause (`character_wife (upper body); three diners in the background, nobody else`).
- `Outfits:` comes from the shot's beat (its opening beat), never the scene row; looks change
  within a scene. Valid pairs: `<characterKey>:<linked outfitKey>` (key from `design_plan.json`
  `outfits[]`, else `outfit_<c>_<look>`), `<characterKey>:nude`, `<characterKey>:none` (no
  outfit design for this look: the character design is the picture; looks: "References by
  extent" in `workflow-calling-conventions`). A clothed look without a linked outfit design is
  `:none`: every shot using it states the garments in `Pose:` (from the beat / the wardrobe
  tracker row; `Pose:` survives into clip tasks), and the plan prompt states them in words;
  note the missing outfit design in the hand-over summary.
- `Blocking:` places only people in frame plus a POV owner: "husband is the camera (POV, seated);
  his forearms and hands enter the lower frame". Never call a POV owner whose limbs are in
  `Visible:` "off-frame"; "(off-frame)" is only for someone with nothing in frame.
- `POV: <characterKey> (seated|lying)` only for a first-person camera; in frame the owner's
  extent is `limbs` / `lower body`.
- `Pose:` per person in frame; when the action needs a body part the look covers, state the
  garment state ("coat unbuttoned and open"); a lasting change is its own look.
- `Sex act:` / `Sex position:` only when `{workspace.contentPolicy.nudity}` is `allowed` and all
  depicted are adults: copy the beat's columns (names: "Explicit acts and positions"); both
  `none` or both set. Otherwise omit both.

## 3 Hand over — `draft_storyboard`

Call `draft_storyboard(shots)` right after the shotlist write was accepted. The first call lists
EVERY shot of `shotlist.md`. Per shot (the example shot s3-01 above):

```
{ "shot": "s3-01",
  "entities": [
    { "key": "character_wife", "kind": "person", "region": { "third": "centre", "depth": "background" },
      "facing": "camera", "support": "chair", "contact_with": ["laptop"] },
    { "key": "character_husband", "kind": "person", "region": { "third": "centre", "depth": "frame-edge" },
      "facing": "away", "limbs": "forearms and hands" },
    { "kind": "object", "count": 1, "region": { "third": "centre", "depth": "midground" }, "facing": "camera" } ],
  "prompt": "Medium shot, eye level, seen from [[character_husband]]'s seat: exactly one person in the
    frame - [[character_wife]], ... seated across the kitchen table, head down, hands on the keyboard of
    an open laptop; at the lower edge his own forearms and hands resting on the table. <place in words>.
    <production style line>. No text or lettering." }
```

Other shapes: a crowd beside a principal = `{ "kind": "person", "count": 3, "extras": 20, … }`
(3 placed figures plus a loosely counted crowd); a shot with nobody in frame (`Visible: nobody`) =
`"entities": []` or only its animals / props, the prompt describing the place.

### Entities — fill them from `Blocking:`, `Pose:`, `Frame:`, `Visible:`

- Exactly one entity per key of the shot's `Characters:`, with that `key` (`kind` = what the
  design depicts: a person, an animal or a creature). Everything else that matters to the frame and
  has no design — extras, animals, props — is an entry without `key`, with its `kind` (`person` |
  `animal` | `creature` | `object`) and the exact `count` the frame shows; `extras` adds loosely
  counted background figures (a crowd). Entries without `key` never take a picture.
- `region.third` (`left` | `centre` | `right`) and `region.depth` (`foreground` | `midground` |
  `background` | `frame-edge`) come from `Frame:` and `Blocking:`; `facing` (`camera` | `left` |
  `right` | `away` | `down` | `up`) from `Blocking:` / `Pose:`.
- `support` = what they sit, stand or lie on, when it matters. `contact_with` = who or what they
  touch (from `Blocking:`), only when there is contact.
- The POV owner (`POV:`) is the camera. When their limbs are in frame (they are in `Characters:`):
  an entity with `region.depth: "frame-edge"` and `limbs` (matching their `Visible:` detail) — never
  a full person. With nothing of them in frame they are not in `Characters:` and get no entity.
- Slots: the place, the parent frame of a `continue` shot and every keyed entity each take one
  picture; the server refuses a shot that needs more than the render workflow takes. Rewrite
  `shotlist.md` first: split such a shot by WHO is in frame (each part shows a subset; the rest is
  off-frame there), never by time alone — or make a `continue` shot a `cut`.

### Prompt — the visible end state of the frame

- Describe what the finished frame SHOWS, never a process or a change ("wife seated, hands on the
  keyboard", not "the wife sits down and starts typing"; no "then", "while she moves").
- Name every principal as `[[<design key>]]` (exactly the entity keys), with their look and outfit
  in words, their place in the frame and the exact count of people ("exactly two people: …").
  Never write "Picture N" or number images; the server does.
- Add the shot's camera and framing, the place in words and the style line of the production
  (the medium / style of the story is kept verbatim).
- No speech bubbles, captions, signs or lettering unless the shot asks for them.
- The POV owner is not a figure: describe only their own limbs at the frame edge as seen from
  their eyes, still named by their placeholder — "[[character_husband]]'s forearms and hands at
  the lower edge" (the server binds the placeholder to their sheet; a POV owner in `Characters:`
  without their `[[key]]` in the prompt is refused).
- Explicit acts and positions: copy the shot's `Sex act:` / `Sex position:` words (names in
  `workflow-calling-conventions`, "Explicit acts and positions"), only under the nudity policy.

The call returns `accepted: …` or an `error:` listing every problem; nothing was started in the
error case. Fix the plan — or, when a problem says to fix it in `shotlist.md`, rewrite the file
first (one full rewrite) — and call again with the whole plan of the first call. Keep fixing and
calling until it is accepted: `task_complete` is refused while no plan was accepted.

## 4 Audit and hand over

- [ ] every shot of `shotlist.md` is in the accepted plan (re-read the file and the plan)
- [ ] `draft_storyboard` was accepted; `design.json` untouched
- `task_complete(summary="Storyboard scene <n>: <N> shots handed to the server; open: …")` (1–3
  lines). The takes land afterwards; this hands the design to the person, it does not finish it.
- Retry drafting: keep the existing `shotlist.md`; call `draft_storyboard` for the shots the stop
  reason names - every shot when no plan was accepted before (the first accepted plan must cover
  them all) - then `task_complete`.

## Chat (after hand-over)

- Each message: `read_artifact` again; the current `shotlist.md` and file list are the truth (a
  missing take was discarded by the person).
- Shot changes (add, remove, reorder, retitle, lines): one full rewrite of `shotlist.md`, ids
  kept (new / split shots get ids after the highest), `Transition` re-derived for shots whose
  predecessor changed; then `draft_storyboard` with ONLY the changed or new shots. A refused write
  changed nothing: fix what the refusal names and write again, or say it failed.
- "Another angle for shot 4" / a different pose: change the shot's lines, rewrite, call
  `draft_storyboard` for that shot. Never `wf_*` for a shot take.
- Who is visible follows the shot lines: change `Visible:` / `Characters:` / `Outfits:` first.
- Reply in one short line naming what THIS turn wrote or handed over, then stop; never claim a
  change you did not make. Never pick, discard or finish — point to the studio.
