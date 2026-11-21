---
name: run-preproduction
description: >
  Trigger when the user wants the whole pre-production phase set up from the story — e.g.
  "run pre-production", "prepare the production", "set up screenplay, cast and designs",
  "get everything ready before we shoot", "start from the plot and create the designs".
  Schedules the chain screenplay -> character table -> scene list -> design planning, so
  characters, outfits, locations and one storyboard per scene end up as design-studio designs.
  Do NOT invoke for shooting or rendering video clips, creating a single
  character/outfit/location/storyboard design, or editing an existing screenplay, cast list or
  scene list.
agentType: workspace
---

# Run Pre-production

Coordinator skill: creates four chained tasks. It writes no content; workers do. `plan_designs`
runs the worker skill `plan-designs`.

Chain: `write_screenplay` -> `character_table` -> `create_scenes` -> `plan_designs`.

## 1. Preflight

- Story brief = `{workspace.story.plot}`. Empty or placeholder -> create nothing; tell the user:
  "Cannot run pre-production: the workspace has no story plot. Add one (workspace spec `story.plot`) and ask me again."
- Scope: when the user narrows the production to PART of the story (some scenes, places, characters or episodes), call `update_story({ scope: "<the user's own words, one short paragraph>" })` BEFORE creating any task (confirm the wording with the user first, as `update_story` requires). The server writes it as a fixed "Production scope" header at the top of the plot, so every task prompt and check reads it. A plot change in the same call takes the same `scope` argument (`update_story({ plot_from_artifact: { artifact, file }, scope })`); a plot change WITHOUT `scope` drops an earlier scope. Never write the scope into task prompts. No narrowing -> no `scope`. Tasks that already exist keep the old plot (`staleTasks`): reset them or tell the user.
- Setting = `{workspace.story.setting}` (WHEN / WHERE: era, place, technology level) and style = `{workspace.story.style}` (HOW the film looks) are GIVEN facts of the workspace - read them from the Workspace facts below, never infer them from the plot. Wardrobe, props, devices, architecture and places of every task you create follow the setting; designs and takes follow the style ("Setting is kept" / "Medium / style is kept" in `workflow-calling-conventions`). Empty = none stated: take the era from the plot only then.
- Call `task_index`, `artifact_index`, `policy_index`, `available_agents`.
- Idempotency: skip every task / artifact that already exists and is live (not failed / cancelled).
  All four exist -> report their statuses and stop. Only a tail missing -> create just the tail
  (reference existing tasks / artifacts in `requires_*`).
- No suitable agent for a role -> name the missing role and stop.

## 2. Checks

- Checks are attached by name: the workspace spec's `autoAttach` rules attach them to the tasks by key; their rules live in the workspace spec.
- Pass the `policies` column of section 3 in each `create_task` as reinforcement (optional).
- Never put checks into a task prompt or description.
- Intent of each check (rules live in the spec):
  - `screenplay-quality`: screenplay faithfully adapts the plot in proper format.
  - `cast-quality`: every cast role (animals / creatures with a story role included) has a complete profile; no two characters look alike (twins excepted).
  - `scenes-quality`: scene list covers all beats, numbered, INT/EXT, location, time of day, lighting, one-line summary.
  - `scenes-complete`: location slug, INT/EXT, a `Lighting` phrase per scene, looks per character, beats with continuity / `Outfits` (+ sex columns when nudity allowed) that are story units (a bodily signal is never a beat of its own), a `## Places` row per location slug (set, space, connections, and the inventory its beats use), no location that is a surface. The server verifies the optional columns' grammar, the input contract and every beat's seat / prop against the place's inventory.
  - `design-plan-covers-scenes`: plan has every character, location and (character, look) outfit of the scene list; locations of one property are sets (`set_anchor` links, one `set_style` per set).
  - `storyboards-cover-scenes`: the plan has a storyboard entry for every scene (that every plan entry gets a design is the server's `create_designs_from_plan` gate).
  - `shotlist-consistent` (attached to every storyboard by the spec): no shot of a `shotlist.md` contradicts itself (camera geometry, garments hiding what is said to be bare, the viewer's own seat drawn in frame, removed garments worn, identical continue framings).
- A named check missing from `policy_index` -> `create_policy` it first (text modality, `Binary` grading, the model the other quality policies in `policy_index` use). Write each `evalPrompt` with `{input}` (the task's output files) and `{workspace.story.plot}`; `design-plan-covers-scenes` / `storyboards-cover-scenes` also use `{inputs.scene_list}`. Never edit an existing policy here (`modify-policy`).
- An unknown key in `policies` is refused with the list of known keys and nothing is created: fix the key from the listed known keys (or create the missing policy) and call again.

## 3. Plan (canonical names, set once, never renamed)

| Task id | Agent role | Output artifact key | `output_files` | Requires | `policies` |
|---|---|---|---|---|---|
| `write_screenplay` | writer | `screenplay` | `["screenplay.md"]` | none | `screenplay-quality` |
| `character_table` | cast writer | `character_table` | `[]` (open: `character_<slug>.md` per character) | tasks `write_screenplay`; artifacts `screenplay` | `cast-quality` |
| `create_scenes` | director | `scene_list` | `["scene_list.md"]` | tasks `write_screenplay`, `character_table`; artifacts `screenplay`, `character_table` | `scenes-quality`, `scenes-complete` |
| `plan_designs` | design planner | `design_plan` | `["design_plan.json"]` | tasks `create_scenes`, `character_table`; artifacts `character_table`, `scene_list`, `screenplay` | `design-plan-covers-scenes`, `storyboards-cover-scenes` |

- Output files are Markdown or JSON only; never PDF, DOCX or other binary formats.
- Embed the exact output file names in each task prompt.
- Agent choice: pick from `available_agents` by `role` / `objective`, never by guessed id (stock: `screenwriter`, `casting_director`, `director`, `design_planner`).
  - Production tasks (`write_screenplay`, `character_table`, `create_scenes`): the role's agent, else the general-purpose worker; never a planner.
  - `plan_designs`: the planner agent that plans designs (tool-capable LLM with `create_designs_from_plan`, e.g. `design_planner`); never the generic `planner`, never a general-purpose worker.

## 4. Create the tasks

- ONE `create_task` call per round, each issued AFTER the previous call's result, in chain order; all four in the SAME turn.
- NEVER put several `create_task` calls in one round (one response): a later call's `requires_*` names the task / artifact the earlier call creates, so it must exist first (a `create_scenes` issued before `character_table` exists fails with `requires.tasks references unknown task id`).
- `requires_tasks` and `requires_artifacts` are MANDATORY in every call, exactly as in the templates (right after the output arguments): a task created without them starts at once, before its inputs exist, and fails or works from nothing.
- Each call creates the task, its output artifact (`output_artifact_name`, `output_files`) and its checks; no separate artifact call.
- EVERY `create_task` call carries its template's `output_artifact_name` + `output_files` exactly as written (they sit right after `id`). A result containing `Note: this task has no output artifacts` means the call was wrong: `remove_task` that task and `create_task` it again WITH those arguments before making the next call.
- NO text between calls — no announcements, no "let me verify", no progress notes (a text-only reply ends the turn and the rest of the chain is never created); do not re-read stored prompts. Only after the 4th result (or a stop on failure) may you write your single final report (section 5).
- Use ids / keys from each result (`key: <key>`) in later `requires_*`; never assume or derive keys. On an `error:` result pick the right key from the listed known ones and correct the call; never retry an identical call.
- Step fails twice -> stop; report which tasks were created (ids from results) and which failed (error text). Never claim a task `create_task` did not confirm.
- `can_create_tasks: true` ONLY on `plan_designs`; unset on the others.
- Each task's prompt is the NAMED PROMPT BLOCK below its call (the fence `prompt <task id>`; it is the worker's whole instruction, the worker cannot load this skill). Pass it as `prompt_block: "run-preproduction/<task id>"` exactly as in the call templates, and NO `prompt`: the server copies the block word for word. Never copy, paraphrase or edit a block into `prompt` (a copied prompt once carried the wrong task's block; a paraphrase once dropped every nudity-conditional rule). An `error:` naming the block lists the blocks that exist - fix the name, never fall back to `prompt`.

### 4a. write_screenplay

```
create_task({ id: "write_screenplay", output_artifact_name: "screenplay", output_artifact_description: "Screenplay", output_files: ["screenplay.md"], requires_tasks: [], requires_artifacts: [], title: "Write screenplay", description: "Adapt the story plot into a screenplay",
  agent: <writer>, policies: ["screenplay-quality"], prompt_block: "run-preproduction/write_screenplay" })
```
Prompt block (passed by `prompt_block`, never copied):
```prompt write_screenplay
Adapt {workspace.story.plot} into a film screenplay set in {workspace.story.setting} (its technology, props, wardrobe and places; INT./EXT. headings, action, dialogue); write `screenplay.md` (the only output file) as plain Markdown, never PDF or DOCX. When the story starts with an `## Adaptation` section (an adopted micro-drama brief), keep its Mode, Format, Directives kept, Source sex acts and scene cap, and write the screenplay episode by episode in its order (an `EPISODE <n>` heading each, n = the brief's own episode number, which may start above 1), keeping its Cast, Places, hooks, cliffhangers and key lines. If the story opens with a production scope, that scope decides what is in the production and overrides the brief's coverage lists (episodes, Cast, Places, source acts): write only what the scope covers, and anything outside it is no gap and is left out.
Write what happens, not how it is framed: a scene may cross a room, hold a crowd or a group and open on a wide place; framing, sizes and cuts belong to the storyboard. Keep the adaptation's voice-over lines verbatim, each as a V.O. dialogue line at the moment it is spoken (never turned into action, never dropped), and carry each scene's camera value, when the adaptation states one (a `Scenes:` entry `[camera: ...]`), as a line `Camera: <value>` under its scene heading.
Workspace content policy (nudity): {workspace.contentPolicy.nudity} (absent or empty = forbidden).
Nudity `allowed`: every sexual act, every moment of nudity and every climax the story names stays in the screenplay as its own action lines - the same act, participants, position, place and order - in plain explicit anatomical words; never softened, euphemised, implied, summarised, cut away from or faded out of.
```

### 4b. character_table

```
create_task({ id: "character_table", output_artifact_name: "character_table", output_artifact_description: "Character Breakdown Table", output_files: [], requires_tasks: ["write_screenplay"], requires_artifacts: ["screenplay"], title: "Character table", description: "One profile file per cast role",
  agent: <cast writer>, policies: ["cast-quality"], prompt_block: "run-preproduction/character_table" })
```
Prompt block (passed by `prompt_block`, never copied):
````prompt character_table
Inputs: artifact `screenplay` (screenplay.md). Deliverable: artifact `character_table`, files `character_<slug>.md`.
Workspace content policy (nudity): {workspace.contentPolicy.nudity} (absent or empty = forbidden).

Cast
- Identify every cast role: speaking, named, or meaningful presence; no props or walk-ons.
- Animals and creatures with a story role (named, acting or plot-driving, in the title or premise, recurring) ARE cast roles.

Identity (decided here, once)
- NAME = the story's proper name; if the story gives none, the role in Title Case ("Guard", "Neighbour"). Never invent a name.
- `<character_slug>` = NAME lowercased snake_case `[a-z0-9]+(_[a-z0-9]+)*`; it is the file stem.
- Every later step uses this slug exactly (scene list, `design_plan.json`, design keys). No later step may introduce a character or name.

Order of work (each extra round re-reads the whole screenplay)
1. Read the screenplay ONCE, then in your next message list the FULL cast: every NAME with its slug. Count them.
2. Write ALL the character files in ONE message: one `sandbox_write_file` call per character, all calls in the same message.
3. Only then `run_checks`. A check finding names what to fix: change only the files it names (a missing character = write that file; never rewrite files the finding does not mention).

Files
- Write ONE plain Markdown file per character (never PDF or DOCX) with `sandbox_write_file`, named `character_<slug>.md`.
- Each file has exactly these five `##` headings, in this order: `NAME`, `ROLE`, `PERSONALITY`, `VISUAL PROFILE`, `WARDROBE TRACKER`. A file missing any is incomplete and must not be submitted.
- `PERSONALITY` ends with two lines: `Want:` (what the character pursues) and `Obstacle:` (what stops them, or their flaw).
- `VISUAL PROFILE`: one `key: value` line each for character type, age, ethnicity, height, face (shape, notable features), hair (colour, length, style), skin tone, eyes, build, build detail, proportions, posture, distinguishing features.
  - No `[...]` placeholders or blanks: every field gets a concrete value, or `n/a` when it does not apply.
  - Invent a fitting value the screenplay does not contradict rather than leave a field open.
  - Keep the cast visually distinct: every character differs from every other in face, hair, skin tone, build or distinguishing marks; characters of the same sex need at least TWO clear visible differences, family members included. Only characters the story or cast calls twins share their look, differing only in what the story names (e.g. hair, clothing).
  - Nudity `allowed` (`{workspace.contentPolicy.nudity}`) and an adult character: add the anatomical details needed for a consistent depiction as concrete, non-euphemistic `key: value` lines in the same section. A minor never gets them.
- `WARDROBE TRACKER`: a Markdown table with a header row and a separator row, then ONE row per look the character wears in the story; the look slug is the FIRST column (later steps read the looks from it - a table without the header and separator rows has no looks):
  ```
  | look slug | description | garments, colors, material, fit, accessories | scenes where worn |
  |---|---|---|---|
  | raincoat | ... | ... | 1, 3 |
  ```
  - One row per OUTFIT, not per garment state: undressed, open or lowered garments are states of the outfit's row, never extra rows. The garments column lists every garment the story shows, including what it reveals underneath (underwear, stockings). A garment state gets its own row ONLY when the character wears a garment that belongs to no outfit of theirs (a towel, a bathrobe, a borrowed shirt, lingerie put on separately). Name such a row by what is worn (`towel`, `bathrobe`). A state carried into a later scene (a scene starts with the character already partly undressed) is no row: that scene's Action / Blocking states it under the outfit's look (LOOK RULE). A row that only names a state of another row of the same character (its garments all part of that row, worn only in scenes where that row is worn) is a defect (REDUNDANT LOOK ROW).
  - Nudity is not a row (it is the `nude` pair in the scene list): never a `nude` / `naked` / "no garments" row.
  - A row lists what IS worn. Never a row for an outfit with pieces removed, lowered or open (`partial_undress`, `undressed_state`: "shirt removed; shorts lowered") - that is the outfit's own row, and the scene list names the state in the beat's Action. Undressing never needs a row of its own; the `cast-quality` check refuses such rows (NUDE ROW, REDUNDANT LOOK ROW).
  - A creature / animal wearing nothing has NO rows.
  - Look slugs: lowercase `[a-z0-9]+(_[a-z0-9]+)*`, e.g. `raincoat`, `evening_dress`.

Pre-completion audit: before `task_complete`, re-open every file; confirm all five headings are present and VISUAL PROFILE has no blank or `[...]` field. Files are registered automatically.
````

### 4c. create_scenes

```
create_task({ id: "create_scenes", output_artifact_name: "scene_list", output_artifact_description: "Scene List", output_files: ["scene_list.md"], requires_tasks: ["write_screenplay","character_table"], requires_artifacts: ["screenplay","character_table"], title: "Scene list", description: "Scene table with outfits and beats",
  agent: <director>, policies: ["scenes-quality","scenes-complete"], prompt_block: "run-preproduction/create_scenes" })
```
Prompt block (passed by `prompt_block`, never copied):
````prompt create_scenes
Inputs: artifact `character_table` (all character_*.md files), artifact `screenplay`. Deliverable: artifact `scene_list`, the single file `scene_list.md`.
Workspace content policy (nudity): {workspace.contentPolicy.nudity} (absent or empty = forbidden).
Nudity `allowed`: `load_skill explicit-acts` first and use its names for `Sex act` / `Sex position`.
Nudity `allowed`: every sexual act and climax of the screenplay is its own beat (or beats) whose `Action` names it in plain explicit words (never "an intimate act") and whose `Sex act` / `Sex position` are filled (a climax: `orgasm`; its finish `cumshot`, `cum on face`, `cum on breasts`, `cum on feet`, `creampie`, `squirting` or `cum swallowing` as the screenplay shows it); keep each act's participants, and its `Sex position` matches how the screenplay stages the bodies, read by which way they FACE: standing and facing each other is `standing face to face` (also when he lifts her with her legs around his waist, or presses her back against a wall, vanity or counter); standing with one behind the other is `against the wall from behind` when she faces a wall with her chest and palms on it, else `standing from behind` (she bends forward, no wall); `doggy style` is ONLY on all fours (hands and knees); lying bodies take a lying position (`missionary`, `prone bone`, `lying on side`); never a position the screenplay does not stage. A hand that strokes or rubs genitals is a sex act (`handjob`, `fingering`), never `none`.

First step, before writing
- Read every `character_<slug>.md`; list (a) the character stems and (b) each character's WARDROBE TRACKER look slugs.
- From then on copy those slugs EXACTLY. Never invent a name, a character or a look slug (a character the story names only by role keeps the role slug, e.g. `<role>`).

Output
- The server writes `scene_list.md` (scene table, Places table, Beats section) from what you send - never `sandbox_write_file` or `sandbox_edit_file` it (refused).
- Plan every scene's beats (their `Outfits`, who is visible) BEFORE the first write, so each scene row's `Characters present` and `Outfits` are right on the first write.
- First `write_places` with every Places row, inventories included (section "Places table" below): write the inventory BEFORE any scene, so every beat uses only what its place holds.
- Then ONE `write_scene` per scene, in scene order: `scene` (its number), `row` (the scene-table cells) and `beats` (every beat of the scene, in order). Each scene is checked alone: a refusal lists only that scene's problems and saves nothing; an accepted scene replaces any earlier version of it, other scenes are never touched.
- FIXES go through `write_beats({ scene, beats, remove? })`: send ONLY the beats you change (with their `beat` ids; a new id inserts a beat), never the whole scene again - a refusal or a check finding names the beats to fix. `write_scene` again only to rewrite a scene from scratch.
- Argument fields = the column names below in snake_case: row `episode`, `int_ext`, `location`, `location_slug`, `time_of_day`, `lighting`, `summary`, `characters_present`, `outfits`, `audio`, `camera`; beat `beat`, `action`, `location`, `outfits`, `framing`, `camera_move`, `continuity`, `blocking`, `pov`, `contact`, `sex_act`, `sex_position`, and the optional `heat`, `gaze`, `watcher`, `signal`, `vo`, `caption`, `offscreen`, `seats`; place `location_slug`, `set`, `space`, `connections`, and the optional `inventory`, `seat_map`, `sightlines`. Cell values are plain text on one line (no `|`); write a spoken line in 'single quotes' (or typographic quotes), never straight double quotes - they break the call's JSON.

Story units, not shots
- A beat is a STORY unit: one continuous stretch of action at one place, however long. Actions that run on into each other ("<A> kneels over <B>, pulls <B>'s shorts down, takes <B> in her mouth") are ONE beat, written in order in `Action`; a jump in time or place, a new subject or a spoken exchange that changes the situation starts the next beat. Expect fewer, longer beats than a shot list: the storyboard decides sizes, angles, cuts and moves. Never write a beat to give the camera something to frame; no beat is only a bodily signal.
- A sensation or inner moment (a breath, a swallow, a hand that stops short, eyes closing, a want, a memory) stays INSIDE the beat that causes it: name its visible or audible signal in plain words in `Action` ("her breath catches, her fingers stop short of his wrist"; never an unfilmable state alone: "she feels guilty") and, when the story wants it landed on a line or pushed in on, in the `Signal` column.
- `Framing` and `Camera move` are OPTIONAL intent (one line each, only when the story needs a size or a move): never required, never refused, never checked against the shots. Canvas, shot sizes and group framing are the storyboard's concern: write no canvas vocabulary and no limit on who a beat may show; an ensemble is staged in depth, with one ensemble frame per new configuration.

Input contract (read from the adapted drama: `{workspace.story.plot}` and the screenplay)
- At most 6 characters on screen in the whole drama and at most 3 bodies in contact in one beat. A drama that needs more is simplified UPSTREAM (the adaptation); the server refuses a scene list that breaks it with "simplify upstream" - tell the user, never split people across beats to hide it.
- `Camera` per scene row: copy the adapted drama's value for that scene (the screenplay's `Camera:` line under the scene heading, else the drama's `Scenes:` entry `[camera: ...]`): `first-person <owner character slug>` | `third person` | `mixed`; silent = leave the cell out (= third person).
- VO lines of the adapted drama are carried VERBATIM into the `VO` column of the beat they accompany, with their moment (`<speaker>: <line> @start | @on the line | @after the line | @end`). `VO`, `Caption` (on-screen text: a message, a title) and `Off-screen` (a sound from out of frame) are post-production: never a picture beat, nothing in shooting generates them.

Scene table columns
- `Scene #` | `Episode` (ONLY when the screenplay has `EPISODE <n>` headings: the number of the episode the scene belongs to, copied from its heading - a whole number, never lower than the row above; a scene belongs to exactly ONE episode: a place the next episode continues in is a new scene row with a new number; otherwise leave the column out) | `INT/EXT` (exactly `INT` or `EXT`; never `INT/EXT` / `EXT/INT`) | `Location` (display name of the ONE place: take one name per place from the Places table or its first scene and repeat it identically in every row sharing that `location_slug`; never re-type each screenplay slugline - "<Place> Terrace" / "<Place>" is refused) | `location_slug` (lowercase slug; the same place has the same slug in every scene) | `Time of day` | `Lighting` | `Summary` | `Characters present` | `Outfits` | `Audio` | `Camera` (optional, see the input contract).
- `location_slug` names a SPACE a camera can stand in ("hallway", "backyard_terrace"), never a surface or feature of one (a wall, door, window, table): those belong to the space's `connections` and to shot framing. Never a slug like `grey_house_wall`.
- `Audio`: the scene's atmosphere in one line — room tone, the space (small and dry / large and echoing), distance of the sounds, mood ("small dry kitchen at night, fridge hum, rain on the window"). The ambient bed is ALWAYS audible at a natural level: 'quiet', 'distant', 'faint' or 'hushed' may describe the PLACE (its size, its sources), never the loudness of the sound; every clip carries an audible ambient bed. No dialogue and no events; the storyboard copies it verbatim onto every shot of the scene and the clip prompts carry it. Filled for EVERY scene.
- `Lighting`: ONE short phrase naming the scene's main motivated light: a visible source, its direction, quality and colour / time ("window light from the left, soft, warm afternoon"). How the scene ends lit / its main state; a change inside the scene is written per shot by `storyboard-scene` (`Lighting:`). The storyboard and clip briefs repeat it verbatim. Filled for EVERY scene.
- `Summary`: one sentence "<who> wants <goal>; <obstacle>; ends with <changed situation>" (every scene turns something), plus any entrance, exit or spoken line that matters to the story.
- `Characters present`: slugs equal the `character_<slug>.md` stems; exactly the characters named in some beat's `Outfits` of that scene (a voice-over or off-frame character is not listed).
- `Outfits`: `<character_slug>:<look_slug>` pairs separated by `; `, e.g. `<a>:raincoat; <b>:work_suit`.
  - A character who changes look inside the scene appears once per look: `<a>:raincoat; <a>:nightgown`.
  - The row's `Outfits` is exactly the UNION of its beats' `Outfits`: nothing missing, nothing extra.
- A scene row = ONE place and ONE continuous time. A change of place starts a new scene; never merge places into one row ("Backyard terrace / Hallway" is two scenes). Runtime budget: use the runtime the story states (an episode brief: its episodes' total, scene numbers running on across episodes - never restarting per episode); otherwise plan 3-5 scenes for a 1-5 minute film, one new turn per scene, and scene 1's first beat is the hook (an action or a question). The budget never overrides this: add scenes rather than merge places.

Looks
- LOOK RULE (mirrors `LOOK_STATE_RULE` in `video-harness/src/preproduction/scene-list-check.ts` - change both together): A garment state is not a look: a beat keeps the outfit look (its WARDROBE TRACKER row) while ANY garment of that look is still on the body — dress off but its underwear on, shirt open, shorts lowered — and its Action / Blocking says what is off or open; `nude` = nothing worn at all; never invent a look.
  - Undressing: the look turns `nude` only at the beat whose Action shows the LAST garment off, and stays `nude` in every later beat of the scene until a beat's Action shows a garment put on — from that beat the look is the look whose tracker row lists that garment, even when the rest of that look stays off ("pulls her panties up" → the look listing the underwear).
  - Valid looks: the character's tracker rows, `nude` (adult, nudity `allowed`), `none` (wears nothing by nature - a creature or an animal). A person whose beat `Action` / `Blocking` names garments carries a WARDROBE TRACKER look, never `none` (a `none` look has no outfit picture; the `scenes-complete` check refuses it).
- `nude`: only for an adult, only when nudity is `allowed`; never for a minor. Garments belong to outfit looks, never to the base look.
- A character's BASE look (the `wardrobe` of its character design in `plan-designs`) is decided by age and policy only, never by whether the character is shown nude in a scene or by character-table notes ("face never shown").
- A character with ANY body part in frame in a beat (a POV character's hands or knees included) is visible: list them in that beat's `Outfits`. An off-frame character is not listed.
- A character appearing only in a `parallel` cutaway at another place need not be in the row's `Characters present`, but is listed in that beat's `Outfits` and in the row's `Outfits` union.

Places table (sent with `write_places`; the server places it between the scene table and the Beats section)
- ONE row per distinct `location_slug` of the scene table and of the beats (`parallel` places included), columns `location_slug` | `set` | `space` | `connections` and the optional `inventory` | `seat_map` | `sightlines` (write the three for EVERY place the beats use: a place with an inventory is checked against its beats, one without is unchecked).
- `set`: the display name of the property the space belongs to ("Grey House"); spaces of the same house, garden or compound share it exactly; a standalone place is its own set.
- `space`: exactly `interior` or `exterior`.
- `connections`: what each door, window or opening of the space opens onto and where the neighbouring features lie, as the screenplay states or implies it, naming other rows by `location_slug` ("glass doors in the back wall open onto `backyard_terrace`, the garden beyond them; the front door opens onto `driveway`"). `none` only for a space with no neighbour in the story. Invent a plausible layout the screenplay does not contradict rather than leave it open; keep it consistent between rows (A opens onto B means B shows A). A change of level reads `stairs | ramp | ladder | elevator [up | down] to <slug>`.
- `inventory`: `;`-separated `<item> [xN] (<detail>; ...)` for EVERY seat, fixture, vehicle seat or window, barrier (bars, a doorway, a window: who is on which side), water feature and piece of furniture the beats use. The inventory is the place's FIXED set: only what is there when the place is empty and stays there for the whole story. Never list garments or anything worn, a carried or handheld item, or a thing a beat brings in, drops, hands over or picks up - those belong to the character, the outfit or the beat's `Action`, not to the place (a location design is checked against every inventory item, so a thing that is not part of the empty place fails its finish). An entry without `xN` is exactly one unit; anything that comes in many is written as a plural ("chairs") or with `xN` (`chair x6`) - the location design is checked against these counts, so a one-off item written without a number must really be the only one. Details: `seats <n>` (per unit), `material: ...`, `position: ...` (relative to an anchor), `state: ...` (a prop's or water feature's state: wet, steaming, locked). State the far end of a larger room (what stands opposite the entrance) so a view toward it has something to show. Plan the inventory from the beats you are about to write: whatever a beat will touch, sit on or look at is an item. A beat may use only these items, and a place's sitters never exceed its seats.
- `seat_map` (a place where several sit around one item): `<seat label> = <item>`, one entry per named seat (for the second of two identical units write `#2` right after the name, e.g. `<item>#2`; no brackets) (`head = dining table; left = dining table`); `Seats` of the beats refer to these labels.
- `sightlines`: `<from item | seat | here> -> <to item | seat | place slug> [(<how>)]` for every line of sight across levels or between places that a beat's `Gaze` or story uses (`balcony -> garden_path (looks down onto the path)`); a beat may look into another place only along a stated sightline.

Beats (sent with each scene's `write_scene`)
- One beat per row of the scene's `beats`. Every scene has at least one beat (typically 1-4: a beat is a story unit, so expect fewer, longer beats).
- Columns: `Beat #`, `Action`, `Location`, `Outfits`, `Continuity`, `Blocking`, `POV`, `Contact` (+ `Sex act` / `Sex position` under `allowed`) are filled in EVERY beat (an empty cell fails the `scenes-complete` check); `Framing`, `Camera move` and the optional story columns may stay empty:
  - `Beat #`: `<scene>.<n>` (`1.1`, `1.2`, …), unique and never renumbered on a rewrite — the
    storyboard's shots name their beat by it (`Beat: 1.2`).
  - `Action`: what visibly happens. Name the characters' visible emotion where it matters ("<A>, smiling nervously, …"); a sensation (a breath, a hesitating hand, skin, lips, eyes, a voice) is named in plain words inside the beat that causes it.
  - `Location`: a `location_slug`. For every non-`parallel` beat EXACTLY the scene row's own slug; only a `parallel` beat names another place.
  - `Outfits` (right after `Location`): looks of the characters VISIBLE in the beat as `<character_slug>:<look_slug>` pairs separated by `; `, e.g. `<b>:work_suit; <a>:raincoat`; `none` when nobody is visible. Written out for EVERY beat, never "same as above" or empty. EVERY person your `Blocking` places in frame gets a pair, also the one not in focus: a Blocking "<A> left of frame, Jonas right of frame" needs both pairs, even on a close-up framed on <A>. A person the beat's words call naked has the look `nude`, never an outfit look.
  - `Framing` (optional intent): a shot size / angle you want for the beat ("wide, her small in the doorway"); empty when the story does not need one. Never refused, never checked.
  - `Camera move` (optional intent): a move the story calls for as a canonical id `<move> <dir> [N°]` - `push in`, `pull out`, `pan left|right`, `tilt up|down`, `truck left|right`, `follow <who>` / `lead <who>`, `arc left|right [N°]`, `crane up|down`, `pedestal up|down`, `rack focus` - followed by what the frame shows when it ends (`push in, ending on her hands`) - what the frame holds when the beat's action is finished, never the place the next action will happen. Never `zoom` (write `push in` / `pull out`), `track` (write `truck` or `follow`) or `handheld drift`. Empty when the story names none.
  - `Continuity` (relation to the PREVIOUS beat):
    - `continuous` = the action carries straight on: same place, same moment, same people, even when the framing changes. Continuity is a story fact and the ONLY continuity authority downstream: never relabel a beat (`continuous` to `new moment`) to suit a camera or a framing.
    - `parallel` = happens at the same time somewhere ELSE; MUST give its place in `Location` (reuse a table slug or define a new stable slug of lowercase a-z0-9 words joined by `_`, e.g. `driveway`; inventing a place slug is allowed).
    - `new moment` = a jump in time, place or subject, or an insert. The first beat of a scene is `new moment`, UNLESS the screenplay marks the scene CONTINUOUS at the same place as the previous scene: then it is `continuous` and the scene's first beats carry on the state the previous scene ended in (positions, contacts, a joined act).
  - `Contact` PERSISTS: a contact is stated in every beat until a beat's `Action` ends it. Example (any genre): <A>'s hand on <B>'s shoulder in beat 3 stays in `Contact` for beats 4, 5, ... until a beat says <A> lets go or steps away; a beat that silently drops it is wrong, and so is one that keeps it after the release. Under nudity `allowed` the same holds for a joined act: while the bodies stay joined, `Sex act` + `Sex position` are stated in every beat until the beat that separates them, also as a motionless pause after a climax beat (`Sex act: <act>: <A> stays <joined to> <B>, motionless`).
  - `POV` (right after `Blocking`): `none`, or the character whose eyes the camera is and the posture of their own body: `<character_slug> (<posture>)` with the posture one of `seated`, `standing`, `kneeling`, `lying`, `walking` (the storyboard's `POV:` vocabulary), e.g. `<a> (seated)`. Written for EVERY beat: the owner and posture in a first-person scene (the same owner and posture while they stay put - change the posture only in the beat whose Action changes it), `none` in a third-person one. The slug is a character-table slug and the posture is never left out; the server refuses any other value. The storyboard's `POV:` line is taken from this column, and a scene whose `Camera` is first person has that owner in every beat's `POV`.
  - `Blocking`: who is where, facing which way; in a conversation name each person's screen side (left / right of frame), kept for the whole scene.
  - `Contact`: who touches whom or what, and where on the body or object, in plain body-part words
    (hands, mouth, shoulders, waist, lap, groin, …): the storyboard turns it into the shot's
    structured `Contact:` line; `none` when nothing does.
  - Optional story columns (leave a cell empty rather than invent; each is the story's own fact, written in the beat that has it):
    - `Heat`: `none` | `teasing` | `aroused` | `intense` | `climax` - the beat's dramatic intensity (in a sexual story: the sexual one). It may fall and rise again across a scene. The storyboard turns the level into acting intensity; it sets no shot size.
    - `Gaze`: `<who> -> <whom | thing>; ...` - the eyelines the storyboard builds shot / reverse-shot and reaction cut-ins on (`wife -> husband; husband -> the door`); a look into another place needs a stated sightline.
    - `Watcher`: a present non-actor (the cast's watcher role), `<character key> (<posture>[, gaze -> <whom | thing>]); ...`, at most two; posture `seated` | `standing` | `kneeling` | `lying` | `walking`.
    - `Signal`: `<character>: <signal> [@start | on the line | after the line | end] [-> acted | push-in | detail | sound]; ...` - the sensation the beat's cause makes visible or audible, in the beat that causes it. Signals: breath catches / quickens / held, gasp, sigh, shaky exhale, swallow, lips part, bitten lip, eyes close / widen, gaze breaks / held, hand tightens / trembles / stops short, shiver, flush, goosebumps, heartbeat, voice breaks, or `other (<plain words>)`.
    - `VO`: `<speaker>: <line> [@start | @on the line | @after the line | @end]; ...` - the adaptation's voice-over verbatim. `Caption`: free text shown on screen (a message, a title). `Off-screen`: `<sound> [from <place slug | thing>]; ...` (a laugh through a vent, footsteps, a knock). All three are laid in post, never a picture beat.
    - `Seats`: `<character key> @ <seat label | item>; ...` (the second of two identical units is `<item>#2`, no brackets) - who sits where, only in a place with an inventory; no seat twice, no more sitters than an item seats.
  - `Sex act` and `Sex position` (nudity `allowed` ONLY, after `Contact`; under `forbidden` or absent leave both columns out):
    - Names exactly as listed in skill `explicit-acts`, or `other (<plain words>)`.
    - Value: `none`, or `<name>[ + <name>]*[: <detail>]`. `Sex act` may combine acts with ` + `; `Sex position` names exactly ONE position (a position change is a new beat), or - for a beat with three bodies in contact - one position per pair: `<a>-<b>: <position>; <a>-<c>: <position>`.
    - `<detail>` = who does what to whom and the contact points, plain explicit words, no euphemisms (e.g. `Sex act: <act>: <A> <does what> to <B>, <contact points>`, `Sex position: <position name>: <B's posture and support>, <A's posture and support>`).
    - `Sex act` is `none` exactly when `Sex position` is `none`. A position may carry modifiers in parentheses (`explicit-acts`, "Modifiers"); a solo act takes a `solo ...` position.
    - The `Action` shows the act the cell names, in the act's own plain words ("<A> strokes <B>'s <body part>" for a `<act>`, never only a covered or implied version); an `Action` that shows penetration or another act has that act in `Sex act`, never `none`.
    - Nudity alone, undressing, posing nude, kissing, hugging, caressing and touching are NOT a sex act (both `none`; nudity is the `Outfits` look, touch is `Contact`).
    - Never an act for a depicted minor.
- A beat is a story unit (see "Story units, not shots"): one beat per change of place, jump in time, new subject or turn of the situation - not per verb. A run of actions that flow into each other is one beat, its `Action` naming them in order in plain verbs (no arrows); the storyboard times them as motion beats of one shot. Each entrance, exit and picture-changing dialogue line that changes the situation starts a beat; one beat = one place.
- A beat's `Sex act` / `Sex position` name the act and position the beat shows (one position per beat, or per pair for three bodies; a position change is a new beat); the lead-up that runs straight on (undressing, climbing on, straddling) may be part of the same beat's `Action`, with the look turning `nude` at the garment that comes off (LOOK RULE).
- POV beats: state the POV character and posture in the `POV` column (`<character_slug> (<posture>)`), and say in `Blocking` where they sit or stand; that character is the camera and shows only their own limbs (hands, forearms, knees, feet), only when in frame, never a full-body figure.
- A beat's `Outfits` is the look AT THAT BEAT, never the scene's end state. A character who changes look during the scene (changes clothes, takes the last garment off) keeps the look they arrived in in EVERY beat before the beat whose `Action` shows the change; the new look (`nude` included) starts at that beat. The change is never the character's first beat in the scene: at least one beat before it shows them in the earlier look (split the opening action if needed), so the row's `Outfits` union holds BOTH looks and the storyboard gets the earlier outfit's picture. Example:

  | Beat # | Action | Outfits |
  |---|---|---|
  | 1.1 | <A> stands at the door in her raincoat | `<a>:raincoat` |
  | 1.2 | <A> lets the raincoat fall to the floor | `<a>:nude` |
  | 1.3 | <A> steps into the shower | `<a>:nude` |

  Row `Outfits`: `<a>:raincoat; <a>:nude`. Wrong: `<a>:nude` in 1.1 (she still wears the raincoat), or a scene whose first beat is already the undressing.
- The beat whose look turns `nude` NAMES the last garment coming off in its `Action` ("<A> steps out of the last garment and into the water"). A top untied or off while the bottom is on is still the same look; a beat that only shows the result ("jumps in", "stands naked") without the last garment coming off is refused by the `scenes-complete` check.
- Self-check before writing: for each character, read that scene's beats in order — the look changes only at the beat whose `Action` changes it, every beat before it keeps the earlier look, and no beat pairs `nude` while its `Action` / `Blocking` still has them wearing ANY garment (underwear included), nor an outfit look while it says they wear nothing; a partly worn outfit keeps its look; a person whose beat names garments has a WARDROBE TRACKER look, never `none`.
- Garment state: when a beat's action needs a body part the current look covers, the beat's `Action` / `Blocking` names the garment state ("cardigan slipped off her shoulders"); the beat keeps the outfit look (LOOK RULE) and never gets a tracker row or look slug of its own for that state.
- Downstream use: the storyboard's `Transition:` and `Outfits:` lines and the clip prompts are taken from the beats (`parallel` -> cutaway shot at its named place with that place's location design; extra location designs come from the beat `Location` slugs, outfit designs from the rows' `Outfits` union, location views from the directions the scenes face, a location's inventory from its Places row). The storyboard owns shot sizes, angles, cuts and moves.

Pre-completion audit: before `task_complete`, confirm every scene of the screenplay was accepted by `write_scene` (the server refuses a scene with a defect, one line per beat - fix exactly those beats and send them again with `write_beats`), no beat is only a bodily signal (each sensation sits inside the beat that causes it, named in `Action`), every beat with an inner moment names its visible / audible signal in `Action`, every sexual act / climax of the screenplay has its beat with `Sex act` filled, every scene row's `Camera` equals the adapted drama's value (empty only where it is silent), every VO line of the adapted drama sits verbatim in a beat's `VO`, the cast stays within 6 and no beat has more than 3 bodies in contact, every `location_slug` has exactly one Places row with `set`, `space`, `connections` and an `inventory` covering every seat, fixed prop, fixture and eyeline target its beats use (including the far end of a larger room) and holding nothing worn, carried or brought in by a beat, no slug names a surface, every Beats table has `Outfits`, `Continuity`, `Blocking`, `Contact` (plus `Sex act` / `Sex position` when nudity is allowed: each `none` or listed names / `other (...)`, `none` in both or neither), no empty cell, every beat is a story unit (one place, one continuous stretch of action), every contact (and joined act) is stated in each beat until the beat whose `Action` ends it, a scene the screenplay marks CONTINUOUS at the same place starts `continuous` with the previous scene's ending state, every row's `Outfits` equals the union of its beats' looks, a character keeps the earlier look in every beat before the beat that changes it (the change never their first beat in the scene), `nude` only where nothing is worn, and it stays until a beat puts a garment on; a partly worn outfit keeps its look, and `none` is used only for a character who wears nothing by nature (never for a person whose beat names garments).
````

### 4d. plan_designs

```
create_task({ id: "plan_designs", output_artifact_name: "design_plan", output_artifact_description: "Design Plan", output_files: ["design_plan.json"], requires_tasks: ["create_scenes","character_table"], requires_artifacts: ["character_table","scene_list","screenplay"], title: "Plan and create designs", description: "Create the designs of the pre-production",
  agent: <design planner>, policies: ["design-plan-covers-scenes","storyboards-cover-scenes"],
  difficulty: "hard", can_create_tasks: true, prompt_block: "run-preproduction/plan_designs" })
```
The only output file is `design_plan.json` (the checks read the scene list from the `scene_list` input). The first prompt line is exact (the worker keys on it). Prompt block (passed by `prompt_block`, never copied):
```prompt plan_designs
Load and use skill: plan-designs

Inputs: artifact `character_table` (files character_<slug>.md), artifact `scene_list` (scene_list.md, with its Places table), artifact `screenplay` (screenplay.md).
Deliverable: the designs. Write the plan, then create every design of its `designs` list with ONE `create_designs_from_plan` call (characters, set anchors, other locations, outfits, then one storyboard per scene, each with a `format` attribute `portrait` | `landscape` from the production canvas {workspace.profiles.master.video.width} x {workspace.profiles.master.video.height}: `portrait` when the height is larger than the width, else `landscape`; see the skill). Story: {workspace.story.plot}
Writing files (or a tool message about files written or a file count) is NOT completion: call `task_complete` only after every planned design exists (the last `create_designs_from_plan` result has no `refused` / `blocked` row); if `task_complete` is refused because designs are missing, fix the named entries and call `create_designs_from_plan` again, and report only counts the tool results show.
Along the way, write the plan record as output artifact `design_plan`: `design_plan.json` only (one entry per `write_design` call, never one whole-file write; never copy `scene_list.md` - the checks read it from the `scene_list` input).
```

## 4e. Repair: designs not all created
If `plan_designs` ended (or was stopped) with designs of its plan missing, call `create_designs_from_plan({ plan_task: "plan_designs" })` once: it creates every missing design of that task's `design_plan.json` for the planner (idempotent; rows `created` / `existing` / `refused` / `blocked`). Report any `refused` / `blocked` rows to the user; do not fix the plan yourself. `create_design` stays for one-off designs only.

## 5. Verify and reply

- Call `task_index` once; all four tasks must exist with the expected `requires`, and each must show its output artifact (`screenplay`, `character_table`, `scene_list`, `design_plan` with `design_plan.json`). Create any missing one, and remove and create again any task without its output artifact (section 4 rules), then re-check.
- No check-verification calls: each `create_task` result lists the attached checks ("(auto)" = auto-attached).
- Reply in at most 4 short lines (see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`); list only confirmed tasks and precisely what failed; do not use the success message for a chain that is incomplete:
  > Scheduled pre-production: task://<screenplay> -> task://<cast> -> task://<scene_list> -> task://<plan_designs>.
  > Checks: <task id>: <checks from its create_task result>; ... (one entry per created task).
  > Skipped (already existed): task://<id>, ... (only if any).
  > Designs and storyboards appear in the Pre-production tab once plan-designs finishes.

## Never

- Read artifacts or run `create_design` / `create_designs_from_plan` yourself, except the repair in 4e.
- Create a task out of order, duplicate an existing one, or paraphrase a worker prompt.
