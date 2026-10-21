---
name: storyboard-scene
description: >
  Use when your task is a storyboard design — keyed `storyboard_scene_<n>` (e.g.
  "storyboard_scene_3") — or the task prompt says "storyboard scene 3", "draft the keyframes
  for scene 2", "write the shot list and render a keyframe per shot", or the person asks in the
  storyboard chat for a change ("add a close-up", "swap shots 2 and 3", "another angle for
  shot 4"). Produces `shotlist.md` (the shot plan: one section per shot with its render plan) and
  keyframe takes per shot (`take_<shotId>-draft-<n>.<ext>`, `take_<shotId>-<slug>.<ext>`) in the
  design artifact for the person to pick from in the studio. Do NOT invoke for shooting or
  rendering video clips, character / outfit / location designs (that is design-asset), writing
  `design.json`, or publishing or finishing a design.
agentType: worker
---

# Storyboard Scene — plan, review, render

Work like an engineer on a large refactor: analyze once, write the plan, get it reviewed until it
passes, then execute strictly per plan. Call conventions (prompt route, references, checks, NSFW,
acts vocabulary): `workflow-calling-conventions` (`load_skill` it).

## Hard rules

- Never write, rename or delete `design.json` or a published name (`full_body_shot.*`, `sheet.*`,
  `view_*`, `frame_*`). The studio owns them; the person picks, discards and finishes.
- Write only into `/workspace/<artifact id>/`, flat names: `shotlist.md` and take images.
  - `<shotId>` = `s<scene>-<nn>` (`s3-01`).
  - Drafts: `take_<shotId>-draft-<n>.<ext>`; chat takes: `take_<shotId>-<slug>.<ext>` (slug
    `[a-z0-9]+(-[a-z0-9]+)*`, names the content); re-renders: base + `-r2`.
  - Never reuse a name that exists or was used in this conversation (append `-2`, `-3`).
- Compose the whole `shotlist.md` silently first, then write it in ONE call; never a partial or
  draft file (the first write counts).
- `shotlist.md` writes: the first write, then one full rewrite per rejected `run_checks`; the server
  refuses any other rewrite, and any write that names an unlinked key or breaks R1–R7 (a refused
  write writes nothing and does not count: fix what it lists and write again).
- `task_complete` is refused while a shot has no take; never end a drafting turn text-only.

## 1 Analyze (read each input once)

- `read_artifact(artifactId="<task id>")`: artifact id, files, `design.json` (`scene`, `notes`,
  `initialDrafts` = drafts per shot, default 1; `links`: locations (first = default place),
  characters, outfits; `format` attribute).
- `scene_list`: the scene row and its Beats (action, Location, Outfits, framing, camera move,
  Continuity `continuous` | `parallel` | `new moment`, Blocking / Contact, Sex act / Sex position).
  `screenplay` (if any): the scene's slice.
- Each linked design: its digest (identity cue, outfit garments and colours, published
  `full_body_shot` / `sheet` refs; an older design's `primary.<ext>` stands in for
  `full_body_shot`). Never restate design documents.
- The keyframe workflow, by capability (never by name; nudity / sex: "NSFW-marked workflows"):
  reference-to-image first, else the multi-reference edit with the most image slots, else a
  single-image edit of the location plate, else text-to-image with everything in words.
  - No reference-to-image workflow and the shot's Camera differs from the plate's framing:
    text-to-image with place, people and outfits described.
  - A workflow with a required input you cannot supply (mask, pose, prior clip) is out.
  `get_workflow_instructions` → its image ports, `label`s and count (e.g. 4 = Picture 1 + 3).
- Note: the POV owner, `continuous` chains, beats holding several actions, shots whose people
  exceed the image ports.
- Preflight — on any gap call `task_failed(reason)` naming it, render nothing: the scene row; ≥1
  linked location; every linked design readable with a published full-body shot; an image `wf_*`.

## 2 Plan — `shotlist.md`

```
# Scene <n> shot list
Format: portrait
Workflow: wf_<keyframe tool> (4 image ports: image_1 … image_4)

## s3-01 — Short title
Action: Wife, seated at the table, types on her laptop as the husband watches
Location: location_kitchen
Camera: medium, eye level
Movement: slow push-in
Blocking: husband is the camera (POV, seated); his forearms and hands enter the lower frame; wife across the table, facing him; no contact
Pose: wife: hands on the keyboard, head down
Frame: wife centre background; his hands bottom foreground
Visible: character_wife (upper body); character_husband (limbs: forearms and hands); nobody else
POV: character_husband (seated)
Characters: character_wife, character_husband
Outfits: character_wife:outfit_wife_office; character_husband:outfit_husband_suit
Duration: 4
Transition: cut — first shot of the scene
Refs: image_1 = location_kitchen (full_body_shot) - place; image_2 = outfit_wife_office (full_body_shot) - wife; image_3 = outfit_husband_suit (sheet) - husband POV hands
Prompt: the wife types at the kitchen table seen from the husband's seat, his forearms and hands at the lower edge
```

Every line is ONE line (no wrapping). The server parses only the shot lines; `Workflow:`, `Refs:`
and `Prompt:` are the render plan for you and the plan check. The file-level `Workflow:` is the
default; a shot rendered with another workflow carries its own `Workflow:` line.

### Shots

- One shot = one moment, one place (`Location:`), one framing (`Camera:` = the opening frame).
- `Action:` = the ONE instant as a state, with participles: "Sister, standing, presses …";
  "Wife mid-stride toward the table, reaching for her laptop".
  - Two successive verbs ("stands and presses", "enters and crosses", "then") = two shots.
  - One shot: simultaneous actions joined by "as" / "while"; speech, breath or a sound together
    with one action; a progressing state ("thrusting faster", "pace building").
  - Visible only: no motives or camera motion. Speech goes on its own `Dialogue: <who>: "<words>"`
    line, never in `Action:` (Action shows only the visible part: mouth open, calling).
  - Bad → good: "Sister exhales and says the fun can start, unties and drops her top" → s3-01
    `Action: Sister, standing at the pool edge, exhaling` + `Dialogue: Sister: "Now the fun can
    start"`; s3-02 `Action: Sister, top untied and slipping off her shoulders`.
    "Sister stands, moves to his chair, hands him the sunscreen" → `Action: Sister, beside his
    chair, holding out the sunscreen bottle` (or one shot per action).
- Split a multi-action beat into one shot per action, in order; count actions, not beats.
- Typically 4–10 shots covering the whole scene in story order, an establishing shot first when
  the place is new. Sections follow story order; a split keeps its id for the first part.
- A `parallel` beat = its own cutaway shot at its place, its characters from that beat:
  `Transition: cut — cutaway (parallel action)`; the main action resumes in a later shot
  (`cut — back to …`).
- `Location:` = a linked location key; a place with no linked design → the nearest linked
  location, and name the gap in the summary.
- `Movement:` = the beat's camera move verbatim (`hold` only when the beat asks for stillness).
- `Transition:` from the beat's Continuity: `continue — <reason>` for `continuous` (same place,
  moment, people; the framing may change), `cut — <reason>` otherwise; the first shot is `cut`.
- `Duration:` 3–10 s. Ids consecutive from `01` on the first write; a rewrite never renumbers
  (new / split shots get ids after the highest).
- `Format:` on the line after the title, always: the `format` attribute, else the story's
  orientation, else `landscape`.

### Who is in frame

- Keys only, copied from `design.json.links` (never names or slugs) in `Location:`,
  `Characters:`, `Outfits:`, `Visible:`, `POV:`, `Refs:`.
- `Visible:` = `<characterKey> (<extent>[: detail]); …; <exclusion>`; extent one of
  `full figure` | `upper body` | `face` | `back` | `limbs` | `lower body`; detail states counts
  (`limbs: one pair of hands`); the last segment is the exclusion clause (`nobody else`).
- `Characters:` = exactly the keys in `Visible:`; `Outfits:` = one valid pair per character
  (below), `; `-separated. Nobody in
  frame: `Characters: none`, `Outfits: none`, `Visible: nobody`.
- People without a design appear in `Action` only.
- `Outfits:` comes from the shot's beat (its opening beat), never the scene row; looks change
  within a scene. Valid pairs: `<characterKey>:<linked outfitKey>` (key from `design_plan.json`
  `outfits[]`, else `outfit_<c>_<look>`), `<characterKey>:nude`, `<characterKey>:none` (no
  outfit design for this look: the character design is the picture; looks: "References by
  extent" in `workflow-calling-conventions`). A clothed look without a linked outfit design is
  `:none`: every shot using it states the garments in `Pose:` (from the beat / the wardrobe
  tracker row; `Pose:` survives into clip tasks, `Prompt:` does not), and the take's check request
  states them; note the missing outfit design in the hand-over summary.
- `Blocking:` places only people in frame plus a POV owner: "husband is the camera (POV, seated);
  his forearms and hands enter the lower frame". Never call a POV owner whose limbs are in
  `Visible:` "off-frame"; "(off-frame)" is only for someone with nothing in frame.
- `POV: <characterKey> (seated|lying)` only for a first-person camera; in frame the owner's
  extent is `limbs` / `lower body`.
- `Pose:` per person in frame; when the action needs a body part the look covers, state the
  garment state ("cardigan slipped off both shoulders"); a lasting change is its own look.
- `Sex act:` / `Sex position:` only when `{workspace.contentPolicy.nudity}` is `allowed` and all
  depicted are adults: copy the beat's columns (names: "Explicit acts and positions"); both
  `none` or both set. Otherwise omit both.

### Render plan per shot

- `Refs:` = the reference plan of `workflow-calling-conventions` ("Reference plan") on one line,
  `;`-separated, the workflow's port names; which image per person: "References by extent".
  - Picture 1 (compose anchor): the shot's location `full_body_shot`; a `Transition: continue`
    shot: the previous shot's take (`image_1 = take of s3-01 - previous shot`).
  - Exactly one picture per `Characters:` key: the outfit design of its `Outfits:` pair; the
    character design for `:nude` / `:none`.
  - Pictures ≤ the workflow's image ports. Too many: pick a workflow with more slots, or split the
    shot by WHO is in frame (each part shows a subset; the rest is off-frame there), never by time
    alone. Only a continue shot drops the place plate (the previous take shows it).
- Two-step explicit act (no [nsfw] reference-to-image workflow; "NSFW-marked workflows"): the
  shot carries `Workflow: <t2i tool> + <edit tool>` and `Refs: step 1 = <t2i tool>, no image (act
  LoRA); step 2 = <edit tool>: image_1 = step 1 output, image_2 = <key> (full_body_shot) - <who>;
  step 3 = <edit tool>: image_1 = step 2 output, image_2 = <key> (full_body_shot) - <other>`;
  anatomy LoRAs on every step; the last step's output is the take.
- `Prompt:` = the core of the frame in one line: who does what where, the camera, each person's
  outfit in words.
- Self-check before the write: re-read every `Action:` line (one instant), recount each shot's
  pictures against the workflow's image ports.

## 3 Plan review loop

- Only if the kickoff lists checks (else go to 4): right after the write call `run_checks`
  (before any prompt writer or `wf_*` call) — a plan rejected after the renders wastes every
  keyframe and an attempt; never render from a rejected plan.
- The plan check returns findings `[severe|major|minor] <shot> (<rule>): "<words>" - <correction>`.
- A two-moment finding (rule a) is fixed ONLY by splitting the shot into separate shots (new ids, in order) or rewriting it to ONE instant — never by rephrasing the same actions (the same finding comes back).
- Rejected: rewrite the WHOLE `shotlist.md` applying every finding not marked minor (severe,
  major and unrated findings of any check; minor ones when cheap), keeping ids; call `run_checks`
  again.
- Accept when it passes (no severe or major finding). At most 5 correction rounds; still rejected
  → `task_failed(reason)` listing the open findings (the design goes to the person, who can retry).

## 4 Execute strictly per plan, in shot order

- Continue chains render in waves: wave 1 = every shot that is not `continue`; each further wave =
  the `continue` shots whose predecessor has its take. One draft batch, one review batch and one
  render response per wave and workflow. Several shots = one batch AND one response of renders;
  never wait for one shot before issuing the next (within a wave).
- Never redraft shots already drafted and never loop shot by shot (single prompt tools run one at
  a time, batches in parallel); a batch refused for size → split into the fewest batches, all in
  the same response.
- A continue shot's Picture 1 = the predecessor's first take that passed `check_take` (with
  several drafts: the first matching one), else its better take, else the location plate.
- Per wave and workflow ONE `draft_prompts_batch` (one item per shot):
  - `image_inputs` = the shot's `Refs:` bindings (`artifact://` refs; a continue shot's Picture 1
    = the predecessor's take).
  - `context`: the `Refs:` line first, then `Prompt:`, then `Action`, `Camera`, `Blocking`,
    `Pose`, `Frame`, `Visible`, `POV` verbatim; per person the identity cue (from the Picture
    line) and outfit in words; the style line ("Medium / style is kept"); the goal "one
    cinematic keyframe of this shot; no text, captions or panels". Never `Movement`,
    `Transition`, `Duration`.
  - POV owner in `context`: "the camera is <name>'s eyes"; the extent phrases of "References by
    extent".
  - `verbatim_phrases` = the shot's `Sex act:` / `Sex position:` values.
- ONE `review_prompts_batch` per wave with every shot that has 2+ people, contact or a sex act;
  `enhance_prompts_batch` (items: `original_prompt` = the drafted prompt, `additional_context` =
  the review feedback) only for flagged items.
- Render the wave in ONE response: per shot `initialDrafts` calls (at most 48 draft renders in
  total: with many shots render fewer drafts per shot, at least 1), each `wf_*(prompt_ids={"<port>": "<prompt_id>"}, <the Refs ports>, is_portrait=<Format:
  portrait = true>, output_ports={"<port>": "/workspace/<artifact id>/take_<shotId>-draft-<n>.png"})`.
  The server refuses retyped prompt text and an `is_portrait` that differs from `Format:`.
- LoRAs: from `design.json.loras` only those that fit the shot (family of the workflow): the
  general NSFW LoRA on every explicit shot, an act LoRA where `Sex act` names it, a pose LoRA
  where `Sex position` names it, anatomy where shown; trigger words in `context`; clothed shots
  none. Explicit content without a planned LoRA → `lora_index` once before rendering, and name
  gaps in the summary.
- Every take: `check_take` (see "Check, retry once, suggest") with `request` = the shot's lines
  (keys replaced by display names) and `references` = the plan's pictures with labels (design
  display names, "previous shot's take").
- A failed render: fix the call per the workflow instructions, retry it once under the same name;
  fails again → `task_failed(reason)` naming the shot (the design goes to the studio, takes kept).

## 5 Audit and hand over

- [ ] every shot of `shotlist.md` has a take (re-read the artifact), rendered per its `Refs:`;
  render any missing shot first
- [ ] every take checked; at most one `-r2` per take; `suggest_edit` where the `-r2` missed
- [ ] the plan passed `run_checks` (when checks are listed); `design.json` untouched
- After the renders never rewrite `shotlist.md` unless a check finding requires it. The same plan
  check runs again at `task_complete`; if it rejects, apply its must-fix findings in ONE rewrite,
  re-render only the shots whose plan changed, then `task_complete` again.
- `task_complete(summary="Storyboard scene <n>: <N> shots drafted; open: …")` (1–3 lines). This
  hands the design to the person; it does not finish it.
- Retry drafting: continue from the existing `shotlist.md` and takes; redo only what the stop
  reason or findings name.

## Chat (after hand-over)

- Each message: `read_artifact` again; the current `shotlist.md` and file list are the truth (a
  missing take was discarded: never re-render it or its name).
- Shot changes (add, remove, reorder, retitle, lines, Refs): one full rewrite of `shotlist.md`,
  ids kept, `Transition` re-derived for shots whose predecessor changed; render only new shots
  (as in "4 Execute") or what is asked. A refused write changed nothing: fix what the refusal
  names and write again, or say it failed.
- Re-render ("another angle for shot 4"): one take `take_<shotId>-<slug>` from the take the person
  names, else the selected, else the newest; a change to it = i2i edit with that take as Picture 1
  (+ the shot's Refs); "start over" = render from the Refs; several shots = one batch.
- Who is visible follows the shot lines: change `Visible:` / `Characters:` / `Outfits:` first.
- Render only what this message asks (one take unless it names a count); check every take.
- Reply in one short line naming what THIS turn wrote or rendered, then stop; never claim a change
  you did not make. Never pick, discard or finish — point to the studio.
