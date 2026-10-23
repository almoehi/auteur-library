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
- Compose the whole `shotlist.md` silently first, then write it complete with `sandbox_write_file`
  (never a partial file). A write that names an unlinked key, breaks R1–R11 or leaves a beat of the
  scene uncovered is refused and writes nothing, but your text is kept as a draft. A refusal is the
  normal next step, never a reason to give up: fix ONLY the listed problems with `sandbox_edit_file`
  (exact `old_string` -> `new_string`, many edits in one call; `sandbox_read_file` shows the draft)
  until it is accepted - never rewrite the whole file, never declare the task failed over a refusal.
  An edit that comes back refused IS applied to the draft (only other problems remain): never repeat
  it; read the draft again before editing text you have not seen since your last edit. A further rewrite while
  drafting is allowed only after a `draft_storyboard` refusal that names `shotlist.md`.
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
  (the server binds the place, for a continued shot also the parent frame, and one picture per
  figure; when the workflow has too few image slots it leaves out the lowest-priority person and
  names them in words only - split a crowded shot by who is in frame to keep everyone pictured).
- Preflight — on any gap call `task_failed(reason)` naming it, plan nothing: the scene row; ≥1
  linked location; every linked design readable with a published full-body shot.

## 2 Plan — `shotlist.md`

```
# Scene <n> shot list
Format: portrait

## s3-01 — Short title
Action: Wife, seated across the table, typing on her laptop, head down; the viewer's hands resting on the table edge
Location: location_kitchen
Camera: medium, eye level
Movement: slow push-in
Blocking: the camera is the viewer's eyes (seated); the viewer's forearms and hands enter the lower frame; wife across the table, facing the viewer, her hands on the laptop
Pose: wife: hands on the keyboard, head down; the viewer's hands flat on the table
Frame: wife centre background; the viewer's hands bottom foreground
Visible: character_wife (upper body); character_husband (limbs: forearms and hands); nobody else
POV: character_husband (seated)
Beat: 3.1
Contact: character_wife (hands) on laptop keyboard; character_husband (hands) on table
Characters: character_wife, character_husband
Outfits: character_wife:outfit_wife_office; character_husband:outfit_husband_suit
Duration: 4
Transition: cut — first shot of the scene
```

Every line is ONE line (no wrapping). The shot lines are the single authority for who is in frame,
who touches what and how shots relate (the shot graph is read from `Transition:`); the structured
plan of step 3 only adds placement, facing and the compose prompt.

### Shots

- One shot = ONE moment (a keyframe is a single still), one place (`Location:`), one framing
  (`Camera:` = the opening frame only; a pan from A to B is `Camera:` A, the pan goes in
  `Movement:`).
- `Camera:` OPENS with one standard framing size, then the angle: `extreme close-up` (one detail
  fills the frame) | `close-up` (head and top of the shoulders) | `medium close-up` (head to
  mid-chest) | `medium` (head to waist) | `medium full` / `cowboy` (head to mid-thigh) |
  `full shot` (head to feet) | `wide` (people small in the setting) — e.g. `Camera: close-up on
  the wife's face, eye level`. The server states that size in every render prompt, measures it on
  every take and reframes a subject that came out too small; a `Camera:` line opening with
  anything else ("lounger POV …") gets no framing check.
- `Action:` = the ONE instant as a state, with participles: "Wife, standing, presses …";
  "Wife mid-stride toward the table, reaching for her laptop".
  - The sequence words `then`, `after`, `before`, `followed by`, `cut to` and arrows (`→`, `->`)
    are REFUSED in `Action:` and `Camera:` (rule R9, any case, whole words) and in a plan prompt.
    Never rephrase a sequence around them: it is fixed only by splitting it into shots. A word
    used for PLACE, not time, is reworded instead: "kneels before him" -> "kneels in front of him".
  - Two successive verbs ("stands and presses", "enters and crosses") = separate shots too, one per
    action, in order (not checked by the server - your job).
  - One shot: simultaneous actions joined by "as" / "while" (both happen in the same instant);
    speech, breath or a sound together with one action; a progressing state ("thrusting faster",
    "pace building").
  - Visible only: no motives or camera motion. Speech goes on its own `Dialogue: <who>: "<words>"`
    line, never in `Action:` (Action shows only the visible part: mouth open, calling).
  - Bad → good: "Wife sighs and says it is late, closes the laptop and gets up" → s3-01
    `Action: Wife, seated at the table, sighing` + `Dialogue: Wife: "It's late"`; s3-02
    `Action: Wife, laptop closed, rising from her chair`.
    "Wife stands, moves to his chair, hands him the letter" → three shots: `Wife, rising from her
    chair` / `Wife, mid-stride toward his chair, letter in hand` / `Wife, beside his chair, holding
    out the letter`.
- Split every multi-action beat into one shot per action, in order — never one shot that lists
  them. Count actions, not beats: 4 beats can need 7 shots.
- `Beat:` = the `Beat #` of the scene-list beat the shot shows, copied exactly (`Beat: 1.9`); every
  shot has one, every shot of a split beat carries the same beat, and every beat of the scene has
  at least one shot (all checked at the write: `beat 1.3: no shot shows it`).
- A sequence is fixed ONLY by splitting it into shots, never by rephrasing it into one sentence
  (participles or "as" around successive actions are still a sequence).
- Typically 4–10 shots covering the whole scene in story order, an establishing shot first when
  the place is new. Sections follow story order; a split keeps its id for the first part.
- A `parallel` beat = its own cutaway shot at its place, its characters from that beat:
  `Transition: cut — cutaway (parallel action)`; the main action resumes in a later shot
  (`cut — back to …`).
- `Location:` = a linked location key; a place with no linked design → the nearest linked
  location, and name the gap in the summary.
- `Movement:` = the beat's camera move verbatim (`hold` only when the beat asks for stillness).
- `Transition:` from the beat's Continuity. The FIRST word is the mode and decides the shot graph:
  `continuous` → `continue — <reason>` (same place, moment, people; the framing may change; the
  SAME `Location:` as the previous shot — a frame of one place never seeds another, so a
  `continue` at another place renders without the previous frame: make it a `cut`), e.g.
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
- `Visible:` = `<characterKey> (<extent>[: detail]); …; <exclusion>`; extent EXACTLY one of
  `full figure` | `upper body` | `face` | `back` | `limbs` | `lower body` — one per person, never a
  combination (the write is refused): pick the WIDEST part of them in frame (`face and upper body`
  → `upper body`); nudity is not an extent, it goes in `Outfits:` (`<characterKey>:nude`), so
  `full figure, nude` → `(full figure)` + `<characterKey>:nude`; a change during the shot
  (`back then upper body`) is two moments → split it into two shots. Detail states counts
  (`limbs: one pair of hands`); the last segment is the exclusion clause (`nobody else`).
- `Characters:` = exactly the keys in `Visible:`; `Outfits:` = one valid pair per character
  (below), `; `-separated. Nobody in
  frame: `Characters: none`, `Outfits: none`, `Visible: nobody`.
- The exclusion clause states a count (`nobody else`, `no other hands`), never names people to
  exclude: negated names are weak in image models and tend to summon the people they name.
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
- `Blocking:` places only people in frame plus a POV owner: "the camera is the viewer's eyes
  (seated); the viewer's forearms and hands enter the lower frame". Never call a POV owner whose
  limbs are in `Visible:` "off-frame"; "(off-frame)" is only for someone with nothing in frame.
- `POV: <characterKey> (seated|standing|kneeling|lying)` only for a first-person camera (no other
  posture: the write is refused); the posture is said in words only ("first-person view,
  standing"). A first-person view shows only the viewer's own body seen from their eyes; the
  posture decides the extent in frame (rule R4): seated / kneeling / standing `limbs` or `lower body`
  (lap, thighs — and the hands resting there); lying also `upper body` (the chest seen from above) —
  never `face` or `full figure`. Pick the extent that shows every part of theirs a `Contact:` or the
  act touches: a touch on the viewer's lap or groin is `lower body` (or `upper body` lying), never
  `limbs`. With none of their body in frame, leave them out of `Characters:` / `Visible:`. The server
  states the viewer's sex, skin tone and garments itself (from their design and `Outfits:` look) —
  never describe their face. Their key appears ONLY in
  `POV:`, `Visible:`, `Characters:` and `Outfits:`. In `Action:`, `Blocking:`, `Pose:` and `Frame:`
  they are only "the viewer" ("the viewer's forearms and hands enter the lower frame") — never
  their name, key or a figure ("as the husband watches", "husband seated centre frame as POV"):
  the server copies these lines verbatim into the prompt, and a name there summons the whole
  person. The write is refused (rule R8: "Blocking names the POV owner (`Husband`) …") when one of
  these lines holds the owner's key, the key's name words (`character_husband` → "husband") or
  their display name — also as an owner of something ("her husband's hand", "sister and husband
  remain"): write "the viewer's hand", "the sister remains in front of the viewer". Anyone else
  seen only by `limbs` / `lower body` is likewise named by role in words ("a man's hands"), never
  as a figure.
- `Pose:` per person in frame (body position); for a `:none` look also its garments.
- `Wardrobe:` = partial undress of an OUTFIT look, `<characterKey> (wearing: <garment>, …; removed:
  <garment>, …)`, `;` between characters: the `Outfits:` pair keeps the outfit key (its picture
  stays bound) while ANY of its garments is still on, e.g. `Outfits: character_sister:outfit_sister_bikini`
  + `Wardrobe: character_sister (wearing: bikini bottom; removed: bikini top)`. `<key>:nude` only when
  nothing is worn (a Wardrobe entry on a `:nude` or `:none` look, or with an empty list, is refused).
  A change that lasts into the next beats is a new look in the scene list instead.
- `Contact:` = every touch the frame shows, `<characterKey> (<body part>) on <characterKey> (<body part>)`
  or `<characterKey> (<body part>) on <thing>`, `;`-separated (`none` / omit = no touch). Body parts
  (exactly these; singular or `lips` accepted): head, face, mouth, neck, shoulders, chest, breasts,
  back, waist, belly, hips, buttocks, groin, lap, thighs, legs, knees, feet, arms, forearms, hands,
  fingers. Copy the beat's `Contact` onto the shot that shows the touch: a beat with a `Contact` needs
  at least one shot with a `Contact:` line. Every named part must be in frame by that person's
  `Visible:` extent (rule R10): `face` shows head, face, mouth, neck; `upper body` head to hands;
  `lower body` waist, hips, buttocks, groin, lap, legs, feet; `limbs` arms and legs; `back` the figure
  from behind; `full figure` everything — widen the extent (or reframe) when a touched part is
  hidden. A shot with a `Sex act:` always has a `Contact:` line naming the contact points.
- `Sex act:` / `Sex position:` only when `{workspace.contentPolicy.nudity}` is `allowed` and all
  depicted are adults: copy the beat's columns (names: "Explicit acts and positions"); both
  `none` or both set. Otherwise omit both. A split beat's act goes on every shot whose frame shows
  the act being performed; its lead-up or aftermath shots carry `none` — never drop the act: at
  least one shot of the beat carries every act name of the beat (checked at the write: `beat 1.9:
  Sex act \`blowjob\` is on no shot of the beat`), with its `Contact:` points.

### Self-check before the write

Re-read every shot silently before writing `shotlist.md` (and again before `draft_storyboard`):
- every `Visible:` entry has ONE extent (no "and", "then" or ", nude" inside the parentheses);
  a POV owner in frame is `limbs` / `lower body` (lying: also `upper body`);
- every `Action:` and `Camera:` is ONE moment: no two successive verbs, no `then` / `after` /
  `before` / `followed by` / `cut to` / arrows; a sequence is split into more shots (never
  rephrased); every action of every beat has a shot;
- every shot has `Beat:`; every beat has a shot; every beat's `Contact` is on a shot's `Contact:`
  whose touched parts the `Visible:` extents show (the viewer's lap / groin = `lower body`);
- partial undress of an outfit = the outfit key + `Wardrobe:`; `:nude` only when nothing is worn;
- `Camera:` is the opening framing only and opens with a standard framing size; the shot holds
  one place; a `continue` shot keeps the previous shot's `Location:`;
- the POV owner is "the viewer" in `Action:` / `Blocking:` / `Pose:` / `Frame:` — never by name,
  key, name word or as a figure, not even as an owner ("husband's glass"); limbs-only people
  likewise only as their limbs in words;
- every beat's `Sex act` / `Sex position` is on the shot(s) that show it (nudity `allowed` only).

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
  "prompt": "Medium shot, eye level, first-person view from a seat at the kitchen table:
    [[character_wife]], ... seated across the table, head down, hands on the
    keyboard of an open laptop; at the lower edge the viewer's own forearms and hands resting on the
    table. <place in words>. <production style line>. No text or lettering." }
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
  `right` | `away` | `down` | `up`) from `Blocking:` / `Pose:` — the server states it for every
  figure as a frame requirement ("Wife faces away from the camera"), so set it deliberately.
- `motion` = where a moving figure is heading in this instant ("walking toward the doors"); omit
  for a still figure. The server adds it to the figure's facing line.
- `support` = what they sit, stand or lie on, when it matters. `contact_with` = who or what they
  touch (from `Blocking:`), only when there is contact.
- The POV owner (`POV:`) is the camera. When their limbs are in frame (they are in `Characters:`):
  an entity with `region.depth: "frame-edge"` and `limbs` (matching their `Visible:` detail) — never
  a full person. With nothing of them in frame they are not in `Characters:` and get no entity.
- Pictures: the place; for a `continue` shot ALSO the previous shot's frame; then one picture
  per figure (words-only people — the POV owner, limbs-only — take none). A shot needing more than
  the render workflow's image slots is not refused: the server leaves out the lowest-priority
  person and names them in words. To keep everyone pictured, split such a shot in `shotlist.md` by
  WHO is in frame (each part shows a subset; the rest is off-frame there), never by time alone.

### Prompt — the visible end state of the frame

The server appends the shot's own `Visible:` (as the exact people count), the viewer's body
(sex, skin tone, garments), `Blocking:`, `Pose:`, each figure's facing / motion, the `Wardrobe:`
state, the `Contact:` points and `Frame:` lines to every prompt, under
`Frame requirements (authoritative - they override anything above):`. So the prompt is the scene
in your words: never repeat those lines and never contradict them. State NO people count in the
prompt ("exactly two people", "three of them", "alone") — the server states the one count; a count
of your own can only disagree with it.

- Describe what the opening frame SHOWS, never a process or a change ("wife seated, hands on the
  keyboard", not "the wife sits down and starts typing"). A prompt with `then` / `after` / `before`
  / `followed by` / `cut to` / an arrow is refused ("Close-up on her face then cut to hands" is two
  shots). Never put `Movement:`, `Transition:` or `Duration:` in it (a keyframe is a still).
- Write each shot's prompt from ITS OWN lines: never copy another shot's people, placeholders or
  who-is-where wording.
- Name every figure as `[[<design key>]]` (the entity keys, except words-only people), with their look and outfit
  in words and their place in the frame — no count. Never exclude anybody by name ("no husband"
  summons him; the server's count excludes everyone else). Never write "Picture N" or number
  images; the server does.
- Add the shot's camera and framing, the place in words and the style line of the production
  (the medium / style of the story is kept verbatim).
- No speech bubbles, captions, signs or lettering unless the shot asks for them.
- Words-only people — the POV owner and anyone seen only by `limbs` / `lower body` — are never a
  placeholder or a name: "the viewer's own forearms and hands at the lower edge" (a `[[key]]` of
  theirs is refused).
- Explicit acts and positions: copy the shot's `Sex act:` / `Sex position:` words (names in
  `workflow-calling-conventions`, "Explicit acts and positions"), only under the nudity policy.

The call returns `accepted: …` or an `error:` listing every problem; nothing was started in the
error case. Fix the plan — or, when a problem says to fix it in `shotlist.md`, rewrite the file
first (one full rewrite) — and call again with the whole plan of the first call. Keep fixing and
calling until it is accepted: `task_complete` is refused while no plan was accepted.

## 4 Audit and hand over

- [ ] every shot of `shotlist.md` is in the accepted plan (re-read the file and the plan)
- [ ] ONE moment and ONE framing per shot (no `then` / `after` / `before` / `followed by` /
      `cut to` / arrows, no two successive verbs; every multi-action beat split into one shot per
      action, never rephrased)
- [ ] every shot names its `Beat:`; every beat has a shot; every beat's `Contact` is on a shot
- [ ] the POV owner is only "the viewer" in `Action:` / `Blocking:` / `Pose:` / `Frame:` and the
      prompt (no name, key, placeholder or figure); no prompt copies another shot's people
- [ ] no plan prompt states a people count (the server's frame requirements state it)
- [ ] every beat's `Sex act` / `Sex position` is carried by the shot(s) that show it (nudity
      `allowed` only)
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
  changed nothing but keeps your text as a draft: fix what the refusal names with
  `sandbox_edit_file`, or say it failed.
- "Another angle for shot 4" / a different pose: change the shot's lines, rewrite, call
  `draft_storyboard` for that shot. Never `wf_*` for a shot take.
- Who is visible follows the shot lines: change `Visible:` / `Characters:` / `Outfits:` first.
- Reply in one short line naming what THIS turn wrote or handed over, then stop; never claim a
  change you did not make. Never pick, discard or finish — point to the studio.
