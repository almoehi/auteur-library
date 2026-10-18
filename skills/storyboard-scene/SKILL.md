---
name: storyboard-scene
description: >
  Use when your task is a storyboard design — keyed `storyboard_scene_<n>` (e.g.
  "storyboard_scene_3") — or the task prompt says "storyboard scene 3", "draft the keyframes
  for scene 2", "write the shot list and render a keyframe per shot", or the person asks in the
  storyboard chat for a change ("add a close-up", "swap shots 2 and 3", "another angle for
  shot 4"). Produces `shotlist.md` (one section per shot) and one keyframe image per shot
  (`take_<shotId>-draft-<n>.<ext>`, `take_<shotId>-<slug>.<ext>`) inside the design artifact
  for the person to pick from in the studio. Do NOT invoke for shooting or rendering video
  clips, character / outfit / location designs (that is design-asset), writing `design.json`,
  or publishing or finishing a design.
agentType: worker
---

# Storyboard Scene — shot list and one keyframe per shot

A storyboard is a design (an `llm+hitl` task plus one open artifact, both keyed
`storyboard_scene_<n>`) for ONE scene. The **web studio owns the design**: its `design.json`
and every published file (`primary.*`, `sheet.*`, `view_*`, `frame_*`, the published copy of
`shotlist.md`). You write `shotlist.md`, then put keyframe **images** into the artifact; the
studio shows each `take_<shotId>-…` file as a take of that shot and the person picks one per
shot. Keep visible replies concise: see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`.

## Hard rules

1. **Never write, overwrite, rename or delete `design.json`** — read it only.
2. **Never write published names** (`primary.*`, `sheet.*`, `view_*`, `frame_*`).
3. **File names are flat** (no `/`). The only non-image file you write is `shotlist.md`.
   Initial drafts `take_<shotId>-draft-<n>.<ext>` (n = 1 … drafts per shot); chat-phase takes
   `take_<shotId>-<slug>.<ext>` (slug = a few lowercase hyphenated words naming the content or
   change, `[a-z0-9]+(-[a-z0-9]+)*`, no `_`, never generic or numbered). `<shotId>` =
   `s<scene>-<nn>` (`s3-01`). Names are unique: append `-2`, `-3` … when the name exists in the
   artifact OR was used earlier in this conversation (including discarded takes). Never
   overwrite; every render is a new take.
4. **Write into this artifact's directory** (`/workspace/<artifact id>/<file name>`). Generate
   images with `wf_*` tools via `output_ports`; read source takes via
   `artifact://<artifact id>/<file>`, never copied URLs.
5. **One render per take.** Leave `seed` at its default; never request batches.
6. **Never name a workflow from memory** — choose among the `wf_*` tools you have, by capability.
7. **Write `shotlist.md` in ONE go**: compose the complete shotlist silently first, then ONE
   `sandbox_write_file` (self-check the content BEFORE that write, step 1 of "Check early": a second
   write is refused). Never a partial/draft shotlist; the only rewrite in a drafting run is
   the single one a failing `run_checks` grants (see "Check early"), any other rewrite ends the
   attempt (write-once guard). A chat change to the shots = exactly ONE full
   rewrite. Write every other file once, complete.
8. **Never end the drafting turn early.** No text-only reply and no `task_complete` before every
   shot has its draft render(s) dispatched; a storyboard with 0 takes is a failure.

## Reading inputs (compact, once)

- `read_artifact(artifactId="<task id>")` ONCE → artifact **id**, existing files, `design.json`
  (`scene`, optional `notes`, drafts per shot = `initialDrafts` (default 1), `links`: `location`
  - ONE OR SEVERAL location links, the first is the scene's default place -, `characters`,
  `outfits`). Every location a shot uses must be one of the linked locations: a shot's
  `Location:` is the key of a linked location design (see "One shot = one place").
- Read `scene_list` (the scene's row: location, time of day, summary, characters, outfits as
  `<character_slug>:<look_slug>`; below the table the scene's **Beats**: per beat the action,
  `Location` (the beat's `location_slug`), `Outfits` (the looks of the characters visible in the beat, `<character_slug>:<look_slug>` pairs - the scene row's `Outfits` is only their union), framing, camera move and continuity - `continuous`, `parallel` (happens at the same time somewhere
  ELSE, names its place) or `new moment`) and the `screenplay` (if it exists; use the scene's slice for
  action and mood) exactly ONCE each. Never re-read them later.
- Read each linked design ONCE, compactly: `read_artifact` of a design returns a server-side
  compact digest in later turns; use only `artifact_index` / the published description. Never
  copy or restate design documents, takes history or file lists.
- Map each place slug (the scene row's `location_slug` and the `Location` slug of every beat)
  to the linked location key (`location_<slug>`; the keys in `design.json.links` are the truth, never
  derive one from a display name). A shot takes its beat's `Location`. A place with no
  linked location design cannot be a shot's `Location:`: use the nearest linked location and name
  the gap in the summary.
- **A shot's `Outfits:` line comes from the beat(s) the shot shows, never from the scene row**: looks
  change inside a scene (`sister:bikini_cardigan` in beat 2, `sister:nude` from beat 3), so shots of the
  same scene can differ. A shot spanning several beats takes the look at its opening frame (the first
  beat it shows). `Outfits:` follows the shot's `Characters:` exactly (one pair per character in frame, nobody else; see "Who is in the frame"). A `parallel` cutaway beat's characters come from that beat even when the scene row's `Characters present` omits them. A scene list without a beat `Outfits` column (older) falls back to the scene row.
- Bind each `<character_slug>:<look_slug>` pair (THE binding rule for nude vs clothed; keys in
  `design.json.links` are the truth): a shot's `Outfits:` pair `<c>:nude` or `<c>:none` binds the
  character design primary (`character_<c>`, in a nudity-allowed workspace that primary IS the nude base sheet); `<c>:<look>` binds the outfit design primary: the
  key from `design_plan.json` `outfits[]` (character_slug + look_slug) when present, else
  `outfit_<c>_<look>` (suffix tolerated). A missing outfit design -> bind the character primary,
  describe the garments in the prompt and name the gap in the summary - never let a clothed shot
  come out nude. WHICH image a character gets also depends on how much of them is in frame: see
  "Reference binding by extent" (rule 3).
- Write the bound designs as linked design KEYS - never slugs or display names - in the shotlist's
  `Location:`, `Characters:` and `Outfits:` lines (`Outfits:` entries are
  `<characterKey>:<outfitKey>`, separated by `;`; a nude or no-garment character is `<characterKey>:nude` / `<characterKey>:none`, still one pair). The server refuses a `shotlist.md` naming a key the storyboard
  does not link, and lists the valid keys: fix the line and write it again.
- **Preflight** — if any fails do not guess: render nothing, `task_complete` saying exactly what
  is missing: the scene number (`scene` attribute or task id); a readable `scene_list` with a row
  for it; at least one linked location; each linked design readable with a published `primary.<ext>`
  (`artifact://<id>/primary.<ext>`); at least one image-rendering `wf_*` tool.

## Phase 1 — Shot list

ONE write of `/workspace/<artifact id>/shotlist.md`, one section per shot, exactly:

```
# Scene <n> shot list
Format: portrait        (or "landscape" - ONE line, the frame orientation = the storyboard's `format` attribute in design.json)

## s3-01 — Short title
Action: what is VISIBLE in the frame, in one or two sentences
Location: location_harbor        (key of the ONE linked location design this shot takes place in)
Camera: KEYFRAME framing - the OPENING frame of the shot (= the keyframe): shot size, angle, lens feel (e.g. "wide, eye level")
Movement: the camera move of the VIDEO clip of this shot, within the same place (e.g. "slow push-in", "pan left", "hold")
Blocking: who is where, facing which way, who touches whom or what (e.g. "Mira at the rail, back to camera, facing the sea; Jonas on the crate 2 m behind her, facing her back; no contact")
Pose: body orientation, hands and head per person (e.g. "Mira: torso square to the rail, both hands on it, head turned left; Jonas: seated, elbows on knees, head down")
Frame: where each person sits in the frame, left / centre / right, foreground / background (e.g. "Mira right foreground, Jonas left background")
Visible: character_mira (full figure); character_jonas (upper body); nobody else        (design KEYS, structured, see below)
POV: character_jonas (seated)        (OPTIONAL, omit for an objective camera; see "Who is in the frame")
Sex act: <name>[ + <name>][: detail] or none        (ONLY when contentPolicy.nudity is allowed; see below)
Sex position: <name>[: detail] or none        (ONLY when contentPolicy.nudity is allowed; see below)
Characters: character_mira, character_jonas        (design KEYS, exactly the characters with a Visible entry, or "none")
Outfits: character_mira:outfit_mira_raincoat; character_jonas:outfit_jonas_work_suit      (<characterKey>:<outfitKey> pairs, "; "-separated, or "none")
Duration: 5
Transition: cut — new moment, first shot of the scene
```

### Blocking, Pose, Frame, Visible, Sex act, Sex position - the instant the keyframe must show

Every shot carries `Blocking:`, `Pose:`, `Frame:` and `Visible:`; they keep a keyframe (and the
clip rendered from it) from drifting, so write them concretely, from the beat and the scene
list's Blocking / Contact (and Sex act / Sex position) columns:

- **`Blocking:`** who is where, facing which way, and the contact points (who touches whom or
  what, where); "no contact" when there is none. A character who matters to the moment but is
  NOT in the frame appears here only marked "(off-frame)".
- **`Pose:`** body orientation, hands and head, per person IN the frame. When the action needs a
  body part the person's look covers (applying lotion to shoulders under a cardigan, a hand on bare
  skin under a sleeve), state the garment's state here ("cardigan slipped off both shoulders").
  If the change is lasting (it stays that way in later beats), it is its own look: use that look's
  `Outfits:` pair (the scene list / `plan-designs` define it) instead of improvising.
- **`Frame:`** left, centre or right, foreground or background, per person.
- **`Sex act:` and `Sex position:`** written ONLY when the workspace's `contentPolicy.nudity`
  (`{workspace.contentPolicy.nudity}`) is `allowed`, and only for adults (any depicted minor: never;
  the lines are left out). Copy the beat's `Sex act` / `Sex position` columns (names from section
  "Explicit acts and positions" of skill `workflow-calling-conventions`; detail after `: ` allowed:
  who does what to whom, contact points, plain explicit words). A shot without a sex act omits both
  lines or writes `none` in both; one is `none` exactly when the other is. Nudity, undressing and
  touch alone are not a sex act. Under `forbidden` (or absent) leave both lines out entirely: they
  are ignored there. An older shot list's `Act:` line reads as the sex act with no position.

#### Who is in the frame (`Visible:`, `Characters:`, `Outfits:`, `POV:`)

`Visible:` is a structured line, one entry per character with ANY body part in the frame:

`Visible: <characterKey> (<extent>[: detail]); <characterKey> (<extent>[: detail]); <exclusion>`

- `<extent>` is EXACTLY one of `full figure` | `upper body` | `face` | `back` | `limbs` |
  `lower body`. `detail` narrows it and states counts: `character_b (limbs: one pair of hands)`,
  `character_a (limbs: forearms and hands)`.
- The LAST `;` segment has no brackets and is the **exclusion clause**: `nobody else`, `no other
  hands`, ... Required in every shot.
- Example: `Visible: character_a (upper body); character_b (limbs: forearms and hands); nobody else`.

Then, mechanically:

- **`Characters:`** = exactly the characters that have a `Visible:` entry, and no one else. A
  character whose hands, back or any limb is in frame IS in `Characters:`; a character
  who is off-frame is NOT (only "(off-frame)" in `Blocking:`).
- **`Outfits:`** = exactly one pair per `Characters:` entry - `<characterKey>:<outfitKey>`, or
  `<characterKey>:nude` / `<characterKey>:none` (valid looks, they bind the character primary) - and no pair for anyone not in `Characters:`.
- **`POV: <characterKey> (seated|lying)`** (optional line, absent = objective camera; the posture is optional, default `seated`, and picks the sheet's POV tile): the camera is that
  character's eyes. Never write it for a normal over-the-shoulder or objective shot. A POV
  character with nothing of theirs in frame is simply not in `Characters:`; with their own limbs
  in frame (hands, knees, feet) the extent is `limbs` or `lower body`, never a full-body
  figure, and they ARE in `Characters:`. Example of a POV shot: `POV: character_jonas (seated)`,
  `Visible: character_jonas (limbs: forearms and hands); character_mira (upper body); nobody else`.
- **`Format:`** (file header) is the production's frame orientation, `portrait` or `landscape`:
  copy the storyboard's `format` attribute in `design.json`; if absent, the orientation the
  story/plot states, else `landscape`. ONE line per file.

The server and the studio check these mechanically (set equality of `Characters:` and
`Visible:`, one `Outfits:` pair per character, valid extents and exclusion clause, `POV:` names a
linked character and its extent, `Format:` equals the attribute) and disable Generate for a shot
that breaks them: fix the line and rewrite. A shotlist without a `Format:` line is the older
format and is not checked - always write it.

**A shot asks for ONE moment, never a sequence.** The keyframe is a single instant: one framing,
one place, one state of the action. "She opens the door, steps in, then turns" or "stands, turns,
unties, then dives" is several shots, not one `Action` / `Blocking`; any "then", "and then",
"before", "after" in `Action` is a sign to split. Describe the state at the opening frame and let
`Movement` / the video carry the change. Never show an event from another place in the frame.

### One shot = one place + one opening framing

A keyframe is ONE image: the shot's opening frame. So a shot holds exactly ONE place
(`Location:`) and ONE opening framing (`Camera:`). `Camera` is that opening frame - exactly what
the keyframe shows; `Movement` only moves within the SAME place (a push-in, a pan across the same
room). Never pack two places or two framings into one shot ("POV tight on the sister, then sudden
wide to the driveway" gives a keyframe with neither).

Action happening ELSEWHERE at the same time ("meanwhile", a car arriving outside, someone at the
door, a phone ringing in another room) is its OWN **cutaway shot**: its own `Location:` (a linked
location design), its own `Camera`, `Transition: cut — cutaway (parallel action)`. If the main
action continues afterwards, it resumes in a FOLLOWING shot (back in the first place,
`Transition: cut — back to <the main action>`). A scene-list beat with Continuity `parallel` is
exactly such a cutaway shot, at the place the beat names.

**One moment per keyframe** - short bad -> good pairs (a keyframe freezes one instant):

- Sequence: `X enters, drops the keys, then calls out` -> `X stands in the open doorway, keys on the floor at her feet`.
- Camera move as the frame: `camera pans from A to B` -> `Camera:` is the opening frame only (A); the pan goes in `Movement:`.
- Two framings: `close-up and wide` -> ONE framing in `Camera:`.
- Dialogue as action: `X shouts "come here"` -> the pose while speaking: `mouth open, calling toward the doors`.
- Event at another place -> its own (parallel) cutaway shot, not a clause of this one.

Worked example (beats: "sister freezes at the wall" - continuous; "car pulls up at the driveway" -
parallel, driveway; "sister reacts" - continuous):

```
## s3-02 — Sister freezes
Action: The sister stands pressed against the hallway wall, eyes wide, hand flat on the plaster.
Location: location_hallway
Camera: tight close-up on the sister, eye level
Movement: slow push-in
Transition: continue — same moment, framing changes

## s3-03 — Car arrives
Action: A dark car pulls up at the end of the driveway, headlights on the gravel.
Location: location_driveway
Camera: wide, low angle across the driveway
Movement: hold
Transition: cut — cutaway (parallel action)

## s3-04 — Her reaction
Action: The sister stays against the wall, breath held, glancing toward the window.
Location: location_hallway
Camera: medium close-up, eye level
Movement: slow pan toward the window
Transition: cut — back to the sister's reaction
```

(each shot also carries `Blocking`, `Pose`, `Frame`, `Visible`, `Characters`, `Outfits` and `Duration`, and the file starts with its `Format:` line; omitted here for brevity.)

**`Location`** (ALWAYS written) = the key of the linked location design this shot takes place in
(`location_driveway`), never a free name. A shot at the scene's default place uses the first
linked location.

**`Characters` / `Outfits` / `Location` are design KEYS, matched exactly** against the designs
linked in `design.json.links`: `Characters: character_the_wife, character_the_husband`,
`Outfits: character_the_wife:outfit_the_wife_gown`. A name or slug (`wife`, `the wife`), a wrong
case or a key of a design that is not linked is REFUSED: the `sandbox_write_file` of
`shotlist.md` returns an error naming the bad keys and listing every valid one, and nothing is
written - fix the keys and write the whole file again (the refused write does not count as your
one write). Copy the keys from `design.json.links`; never derive them from display names.

**`Movement`** = the camera move of the video clip shot from this frame, taken from the shot's
beat in the scene list's **Beats** (one shot per beat, in order; the beat's `Camera move` verbatim,
e.g. `slow push-in`, `pan left`, `handheld drift`). Write `hold` ONLY when the beat asks for
stillness. When the scene list has no Beats (an older list), derive a fitting move from the
action and mood; never default to `static`/`hold`. `Camera` stays the framing of the keyframe
IMAGE (a still has no movement): do not put a move into `Camera`, and keyframe prompts use
`Camera`, never `Movement`.

**`Transition`** = how this shot relates to the PREVIOUS shot, taken from the shot's beat
`Continuity` in the scene list: `Transition: continue — <short reason>` when the beat is
`continuous` (the action carries straight on in the same setup: same place, same moment, same
people) **even when the framing changes** (wide -> close-up of the same moment); `Transition:
cut — cutaway (parallel action)` when the beat is `parallel` (it happens at the same time
somewhere else: a shot of its own at the place the beat names); `Transition: cut — <short
reason>` when the beat is a `new moment` (new moment, place or subject, or an insert). The first shot is always `cut`. A scene list without `Continuity` (older list): decide
with the same rule from the actions and say so in the reason. The shoot skills take this line as
given, so it is decided here once.

**`Action` = what is visible** — subjects, positions, pose, expression, objects. No plot, motives,
dialogue or camera motion.
Good: `Action: Mira stands at the harbor rail, hood up, looking out to sea; Jonas sits on a crate behind her.`
Bad: `Action: Mira, who just learned the ship is late, walks to the rail and says "He lied to us" as the camera pushes in.`

4–10 shots, covering the WHOLE action in order, one beat per shot (a beat that packs two places or
two framings is split into several shots), an establishing shot first when the location is not
yet known. `Duration` = whole seconds (3–10). First write: ids consecutive from 01.
**Stable ids**: a rewrite of `shotlist.md` never renumbers an existing shot (its takes are filed
under its id). A split shot keeps its id for the first part; the new parts get new ids appended
after the highest existing id (`s3-08`, `s3-09`). `##` sections follow story order; ids need not be sequential. `Characters` / `Outfits` name only linked
designs by KEY (others: in `Action` only); `Location` names only a linked location design key.

### Rewrite means re-render

After ANY rewrite of `shotlist.md` (also the one a rejected `run_checks` grants), every shot whose
`Action` / `Camera` / `Blocking` / `Pose` / `Frame` / `Visible` / `Characters` / `Outfits` /
`Sex act` / `Sex position` changed, and every new shot, is redrafted (prompt writer, review where
required) and rendered in the SAME attempt, before `task_complete`. You never discard takes: leave
the takes of removed shots and the old takes of changed shots, but render a NEW take so the
shot's newest take matches its current text.

### Check early (a numbered step, not optional)

When the kickoff lists checks and `run_checks` is available, these steps happen in this order:

1. Write `shotlist.md` (ONE write).
   **Before** that write, self-check the content you are about to write: EVERY shot carries every line
   of the format block - `Action`, `Location`, `Camera`, `Movement`, `Transition`, `Blocking`, `Pose`,
   `Frame`, `Visible` (one entry per `Characters:` key, then an exclusion clause), `Characters`,
   `Outfits`, `Duration` (plus `POV` / `Sex act` / `Sex position` where they apply). The file is written
   ONCE; a second write in the same attempt is refused (only a rejecting `run_checks` grants a rewrite).
2. **Call `run_checks` right now - BEFORE any `draft_prompt(s)` and BEFORE any `wf_*` keyframe call.**
   A shot list rejected after the renders wastes every keyframe and an attempt; the same
   rejection costs nothing here.
3. Rejected verdict: it quotes each failing shot with the rule and the words that break it. Fix ALL of
   them in ONE full rewrite of `shotlist.md` (the one rewrite a rejection grants), then continue.
   Never start rendering with a rejected shot list.
4. Render the keyframes (Phase 2).
5. Call `run_checks` again after the renders and BEFORE `task_complete`, to see the checks about
   tool calls.

`run_checks` is capped at 3 calls per attempt: one after the shot list, one before
`task_complete`, one spare - never one per shot.

## Phase 2 — Render the initial drafts (all shots, batched)

**Gate: do not start until `run_checks` (see "Check early") returned no rejected shot for the current `shotlist.md`** (or the kickoff lists no checks).

Follow "Prompt route" of `workflow-calling-conventions` for every prompted `wf_*` call:
initial keyframes from the shot list are drafted with `draft_prompts_batch` (pass `image_inputs`
per item - the shot's references - and, in a workspace with `contentPolicy.nudity: allowed`, the
shot's `Sex act:` and `Sex position:` values as `verbatim_phrases`); a short user-typed chat edit on an edit workflow is a
pass-through candidate. Never loop shot by shot; single
`draft_prompt` / `review_prompt` / `enhance_prompt` calls are serialized, the `*_prompts_batch`
tools run in parallel.

1. **Bind references for every shot** silently: choose the workflow, the reference list in
   priority order and the slot map.
2. **EXACTLY ONE `draft_prompts_batch` call per workflow, in ONE round** (one item per shot;
   one call per workflow; shots may use different workflows, see "Choosing the workflow"). Never repeat it per shot subset or retry
   round for shots already drafted. If refused for size, split into the fewest batches, all in
   the same response.
3. **Review**: at most ONE `review_prompts_batch` and ONE `enhance_prompts_batch` per scene run.
   The review is REQUIRED for every shot with 2+ characters, body contact or a `Sex act:` line (put
   those shots in the batch; other shots may join it); `enhance_prompts_batch` only for flagged
   items, with the feedback as `additional_context`. No single-item tools for several shots.
4. **ONE render round**: ALL `wf_*` calls for ALL shots (`initialDrafts` per shot, never more) in
   ONE response; never wait for one shot before issuing the next:

```
wf_<tool>(prompt_positive="<prompt>", <image ports with artifact:// refs>, …,
  output_ports={"<primary output port>": "/workspace/<artifact id>/take_s3-01-draft-<n>.png"})
```

Same prompt for all drafts of a shot (the random seed varies them). Pass `is_portrait` on every keyframe
call (initial drafts, chat re-renders, retries), derived from the shotlist's `Format:` line
(`portrait` -> `true`, `landscape` -> `false`); on every keyframe call of a workflow that takes it (a workflow with a render size; the code
injects it only there); never leave it to the default. A failed draft fails only
its own take: re-read the workflow instructions, fix the call, retry that draft once (same file
name); if it fails again leave it (the studio shows a failed take with Retry) and report it.

### Reference binding by extent (rule 3)

For each character in `Characters:` read their `Visible:` extent:

- `full figure` / `upper body` / `face` / `back` -> the character's outfit design primary (the
  character primary for a `:nude` / `:none` pair or when no outfit design exists), as above.
- `limbs` / `lower body` of the **POV owner** (the `POV:` character) -> NOT the full-body primary:
  bind their published SHEET (`sheet.<ext>` of the outfit design when the pair names an outfit,
  else of the character design), named "<Name>'s sheet", and add to the shot's `context`: "use
  only its POV <seated|lying> tile: <detail> seen from their own eyes, never their face or
  torso" (posture from the `POV:` line, default `seated`; `<detail>` from the `Visible:`
  detail). Without a published sheet bind their normal primary with the limbs-only phrase below.
- `limbs` / `lower body` of **any other character** -> their normal primary, plus in `context`:
  "only their <detail> are in frame, never their face or the rest of their body".
- a character NOT in `Characters:` (off-frame, or a POV owner with nothing in frame) gets no image
  and is never mentioned as a figure in the prompt.

### Choosing the workflow (capability, never name)

Read each candidate's description and `get_workflow_instructions(<tool>)`. Prefer the manifest:
`capabilities` (`multi-reference-edit`), per image input `reference_role` and `label` (the exact
name the prompt must use, e.g. "Picture 2"); else infer from workflow type, number/kind/ORDER of
image inputs, required ports and port descriptions. Never pick by a tool's name or family.

References in priority order (keyframe = COMPOSE intent, the SHOT's location - its `Location:`
line, not necessarily the scene's first - is the anchor, Picture 1; see
"Anchor (Picture 1) by intent"): 1. primary of the shot's `Location:` design; 2. outfit primary of the shot's main
character (the outfit primary for a `<c>:<look>` pair, the character primary for `<c>:nude`/`<c>:none`
or a missing outfit design, see the binding rule above); 3. further outfits / characters by presence.
   Only characters in the shot's `Characters:` get an image, and WHICH image follows "Reference
   binding by extent" below.

- **Reference-to-image (ref2i)**: preferred - composes a NEW frame from the references (location =
  Picture 1), any camera.
- **Multi-image i2i edit**: for shots matching the location plate's framing; the fillable i2i
  workflow with the MOST image slots able to hold references (not masks/depth/control); fewer
  slots → drop from the end of the list.
- **Single-image i2i only** → edit the location primary into the scene (characters in the prompt).
- **No usable i2i** → t2i with characters, outfits and location described in the prompt.
- **INTERIM**: when no ref2i workflow exists and the shot's Camera differs from the plate's
  framing, use the text-to-image workflow with a rich description of place, characters and
  outfits instead of an edit.

Nudity or sex in a shot: follow "NSFW-marked workflows" in `workflow-calling-conventions` ([nsfw] workflows, explicit acts in two steps).

Several workflows may be used within one scene (chosen per shot). The workflow type is read from
the `wf_*` tool description, which ends with the type display name (e.g. "(reference-to-image)").

A workflow with a required input you cannot supply (mask, pose, prior clip) is disqualified. Say
the choice and reason in the summary.

### Prompt `context` (per shot)

`context` carries, per shot: the shot's `Action`, `Camera`, `Blocking`, `Pose`, `Frame` and
`Visible` lines VERBATIM (plus the `POV:` line when present, and the POV-tile phrase of "Reference
binding by extent"), the image labels (slot map by port label: "Picture 1 is the harbor, Picture 2
is Mira"), one style line (`{workspace.story.plot}` medium/style verbatim, see "Medium / style is
kept"), and the goal: *one cinematic keyframe of this shot, consistent with the reference images;
compose as the camera line says; no text, captions or panels*. The `Sex act:` and `Sex position:` values go in
`verbatim_phrases`. Never pass `Movement`, `Transition` or `Duration` (a keyframe is a still), and
never restate what the reference images show or the design descriptions. **The goal line belongs
in `context`, NEVER in `instruction`**: `instruction` is only for a person's own explicit
correction (see "Prompt route"); anything else there is pasted into the prompt. The prompt writer
applies `prompt-writer-<family>` itself.

### LoRAs per shot

`design.json.loras` holds the scene's planned LoRAs (in a nudity-allowed workspace: the NSFW
acts / anatomy / poses LoRAs of `plan-designs`). Per shot pass only those that FIT that shot -
an act LoRA only on shots whose `Sex act` names that act, anatomy LoRAs only where those body parts are
visible, a position / pose LoRA only where `Sex position` names it - with their `strength`, same `modelFamily` as the shot's
workflow only, and put their trigger words in the shot's `context`. A clothed or non-sexual shot
gets none of them. An explicit shot whose content has no planned LoRA: check `lora_index` (once
per turn) for a matching one before rendering without; name content left without a LoRA in the
summary. Two-step explicit acts ("NSFW-marked workflows" in `workflow-calling-conventions`): the
act LoRA goes on step 1 (the act frame), anatomy LoRAs on both steps.

### Keyframe-ready check rejection

A rejection of check `shotlist-keyframe-ready` under rule (d) or (e) is about the tool calls, not the file: fix it by redrafting that shot's prompt (with `review_prompts_batch` for (e), the right `is_portrait` for (d)) and rendering its keyframe again - editing `shotlist.md` alone never fixes it.

### Check, retry once, suggest

For EVERY take you render follow "Check, retry once, suggest" of `workflow-calling-conventions`.
Retry naming: base + `-r2` (`take_s3-02-wide-rain.png` -> `take_s3-02-wide-rain-r2.png`;
`take_s3-01-draft-1.png` -> `take_s3-01-draft-1-r2.png`).

## Phase 3 — Hand over

Audit before completing:

- [ ] every shot in `shotlist.md` has a take rendered from its current text
- [ ] `run_checks` returned no rejected shot BEFORE the first `draft_prompt(s)` / `wf_*` keyframe call (when the kickoff lists checks), and ran again before `task_complete`
- [ ] `shotlist.md` written in one go (at most the single rewrite a failing `run_checks` granted); every shot has `## <shotId> — <title>` plus `Action`,
      `Location` (a linked location key), `Camera`, `Movement`, `Characters` (linked character keys), `Outfits` (`<characterKey>:<outfitKey>` linked keys), `Duration`, `Transition`; ids unique and stable (`s<scene>-01…` on the first write, never renumbered by a rewrite);
      `Visible:` / `Characters:` / `Outfits:` / `POV:` / `Format:` follow "Who is in the frame"; every `Movement` comes from its beat (`hold` only when the beat asks for stillness);
      every `Transition` is `continue` or `cut` with a reason, from the beat's continuity, the first is `cut`;
      a `parallel` beat is its own cutaway shot at its named place; no shot holds two places or two framings
- [ ] before writing `shotlist.md`: every shot has every line of the format block (`Blocking`, `Pose`, `Frame`, `Visible`, ... - none missing)
- [ ] **self-audit of the shotlist before the write and again here** (the studio checks R1-R5
      mechanically; a policy `shotlist-keyframe-ready` judges the rest after drafting):
      R1 `Characters:` = the `Visible:` entries; R2 one `Outfits:` pair per character, no extra;
      R3 valid extents + an exclusion clause; R4 `POV:` names a linked character, extent `limbs` /
      `lower body` if in frame; R5 `Format:` line = the `format` attribute; ONE moment and ONE
      framing per shot (no "then"); `Pose` states the garment's state where the look covers the
      body part; `Visible:` covers everyone `Blocking` places in frame and only them; no event from
      another place; every keyframe call of a workflow that takes it passed `is_portrait` from `Format:`; every shot with 2+
      characters, contact or a `Sex act` went through the review batch
- [ ] every shot has `take_<shotId>-draft-<n>.<ext>` for n = 1 … drafts per shot (re-read the
      artifact), except drafts that failed twice (name them); all from `wf_*` renders
- [ ] no other file written; `design.json` untouched; no published names
- [ ] every take checked; at most one retry per take (`<base>-r2`); `suggest_edit` exactly for
      takes whose retry also missed
- [ ] one `draft_prompts_batch` per workflow, one review batch (required per the rule above) and at most one enhance batch, all
      renders in one response

Then `task_complete(summary="Storyboard scene <n>: <N> shots drafted; failed: …")` (1-3 lines; no
workflow types or slot counts). This hands the design to the person; it does
**not** finish it.

## Phase 4 — Chat (HITL phase)

For each message:

1. `read_artifact` again; read `design.json` for takes, primary/selection and discarded takes. A
   take you rendered earlier that is gone was discarded on purpose — never re-render it or its name.
2. **Shot list changes** (add / remove / reorder / retitle / change action, location, camera, movement or transition): rewrite
   `shotlist.md` as a whole file (the one allowed overwrite), existing ids kept (new shots get new ids after the highest, see "Stable ids"); re-derive `Transition` of every shot whose predecessor changed (the first stays `cut`).
   Existing takes keep their file names.
   Render nothing unless asked or the shot is new (new shots get drafts as in Phase 2, one batch).
3. **Re-render a shot** ("another angle for shot 4"): one new take `take_<shotId>-<slug>.<ext>`
   from the take the person names, else the selected, else the newest. A change to an existing
   take is an **i2i edit with that take as the FIRST image** (+ references by priority); "start
   over" re-renders from the references as in Phase 2. SEVERAL shots in one message = ONE
   `draft_prompts_batch` and ONE response of renders; a single `draft_prompt` only for one shot.
   The shot lines are authoritative for who is visible: a note or edit cannot remove a person the
   shot lists (and cannot add one) - change `Visible:` / `Characters:` / `Outfits:` in the shotlist
   first (the one allowed rewrite), then render.
4. Render only what THIS message asks (one take unless it names a count); check every take. Reply
   with one short line (new take name(s), what changed), then stop.
5. Never pick a primary / frame, discard takes, write descriptions, or finish the design — point
   the person to the studio controls (★ / 🗑 / Finish design).
