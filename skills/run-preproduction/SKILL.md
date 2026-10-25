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
  - `scenes-quality`: scene list covers all beats, numbered, INT/EXT, location, one-line action.
  - `scenes-complete`: location slug, INT/EXT, looks per character, beats with camera move / continuity / `Outfits` (+ sex columns when nudity allowed).
  - `design-plan-covers-scenes`: plan has every character, location and (character, look) outfit of the scene list.
  - `designs-cover-plan`: a design was created (or existed) for every planned key; no stray or duplicate designs.
  - `storyboards-cover-scenes`: a storyboard exists for every scene.
  - `shotlist-consistent` (attached to every storyboard by the spec): no shot of a `shotlist.md` contradicts itself (camera geometry, garments hiding what is said to be bare, the viewer's own seat drawn in frame, removed garments worn, identical continue framings).
- A named check missing from `policy_index` -> `create_policy` it first (text modality, `Binary` grading, the model the other quality policies in `policy_index` use). Write each `evalPrompt` with `{input}` (the task's output files) and `{workspace.story.plot}`; `designs-cover-plan` / `storyboards-cover-scenes` also use `{toolCalls}` (covered = a `Design created: key <key>` result). Never edit an existing policy here (`modify-policy`).
- An unknown key in `policies` is refused with the list of known keys and nothing is created: fix the key from the listed known keys (or create the missing policy) and call again.

## 3. Plan (canonical names, set once, never renamed)

| Task id | Agent role | Output artifact key | `output_files` | Requires | `policies` |
|---|---|---|---|---|---|
| `write_screenplay` | writer | `screenplay` | `["screenplay.md"]` | none | `screenplay-quality` |
| `character_table` | cast writer | `character_table` | `[]` (open: `character_<slug>.md` per character) | tasks `write_screenplay`; artifacts `screenplay` | `cast-quality` |
| `create_scenes` | director | `scene_list` | `["scene_list.md"]` | tasks `write_screenplay`, `character_table`; artifacts `screenplay`, `character_table` | `scenes-quality`, `scenes-complete` |
| `plan_designs` | design planner | `design_plan` | `["scene_list.md","design_plan.json"]` (both, always) | tasks `create_scenes`, `character_table`; artifacts `character_table`, `scene_list` | `design-plan-covers-scenes`, `designs-cover-plan`, `storyboards-cover-scenes` |

- Output files are Markdown or JSON only; never PDF, DOCX or other binary formats.
- Embed the exact output file names in each task prompt.
- Agent choice: pick from `available_agents` by `role` / `objective`, never by guessed id (stock: `screenwriter`, `casting_director`, `director`, `design_planner`).
  - Production tasks (`write_screenplay`, `character_table`, `create_scenes`): the role's agent, else the general-purpose worker; never a planner.
  - `plan_designs`: the planner agent that plans designs (tool-capable LLM with `create_design`, e.g. `design_planner`); never the generic `planner`, never a general-purpose worker.

## 4. Create the tasks

- ONE `create_task` call per round, each issued AFTER the previous call's result, in chain order; all four in the SAME turn.
- NEVER put several `create_task` calls in one round (one response): a later call's `requires_*` names the task / artifact the earlier call creates, so it must exist first (a `create_scenes` issued before `character_table` exists fails with `requires.tasks references unknown task id`).
- `requires_tasks` and `requires_artifacts` are MANDATORY in every call, exactly as in the templates (right after `id`): a task created without them starts at once, before its inputs exist, and fails or works from nothing.
- Each call creates the task, its output artifact (`output_artifact_name`, `output_files`) and its checks; no separate artifact call.
- NO text between calls — no announcements, no "let me verify", no progress notes (a text-only reply ends the turn and the rest of the chain is never created); do not re-read stored prompts. Only after the 4th result (or a stop on failure) may you write your single final report (section 5).
- Use ids / keys from each result (`key: <key>`) in later `requires_*`; never assume or derive keys. On an `error:` result pick the right key from the listed known ones and correct the call; never retry an identical call.
- Step fails twice -> stop; report which tasks were created (ids from results) and which failed (error text). Never claim a task `create_task` did not confirm.
- `can_create_tasks: true` ONLY on `plan_designs`; unset on the others.
- Task prompts below are VERBATIM: copy each fenced block word for word (it is the worker's whole instruction; the worker cannot load this skill). `{workspace.*}` placeholders stay literal (the server substitutes them).
- Never paraphrase, shorten, reorder or drop a line: a paraphrase once dropped every nudity-conditional rule. Before each 4b/4c call re-read the prompt: it starts with the block's `Inputs:` line, keeps `Workspace content policy (nudity): {workspace.contentPolicy.nudity}` literal, and (4c) contains the `Contact` and `Sex act` / `Sex position` bullets and the nude-from-that-beat-on rule; anything missing → re-copy the block.

### 4a. write_screenplay

```
create_task({ id: "write_screenplay", requires_tasks: [], requires_artifacts: [], title: "Write screenplay", description: "Adapt the story plot into a screenplay",
  agent: <writer>, policies: ["screenplay-quality"], prompt: <below>,
  output_artifact_name: "screenplay", output_artifact_description: "Screenplay", output_files: ["screenplay.md"] })
```
prompt: adapt `{workspace.story.plot}` into a film screenplay (INT./EXT. headings, action, dialogue); write `screenplay.md` (the only output file) as plain Markdown, never PDF or DOCX.

### 4b. character_table

```
create_task({ id: "character_table", requires_tasks: ["write_screenplay"], requires_artifacts: ["screenplay"], title: "Character table", description: "One profile file per cast role",
  agent: <cast writer>, policies: ["cast-quality"], prompt: <below>,
  output_artifact_name: "character_table", output_artifact_description: "Character Breakdown Table", output_files: [] })
```
prompt:
````
Inputs: artifact `screenplay` (screenplay.md). Deliverable: artifact `character_table`, files `character_<slug>.md`.
Workspace content policy (nudity): {workspace.contentPolicy.nudity} (absent or empty = forbidden).

Cast
- Identify every cast role: speaking, named, or meaningful presence; no props or walk-ons.
- Animals and creatures with a story role (named, acting or plot-driving, in the title or premise, recurring) ARE cast roles.

Identity (decided here, once)
- NAME = the story's proper name; if the story gives none, the role in Title Case ("Sister", "Husband"). Never invent a name.
- `<character_slug>` = NAME lowercased snake_case `[a-z0-9]+(_[a-z0-9]+)*`; it is the file stem.
- Every later step uses this slug exactly (scene list, `design_plan.json`, design keys). No later step may introduce a character or name.

Files
- Write ONE plain Markdown file per character (never PDF or DOCX) with `sandbox_write_file`, named `character_<slug>.md`.
- Each file has exactly these five `##` headings, in this order: `NAME`, `ROLE`, `PERSONALITY`, `VISUAL PROFILE`, `WARDROBE TRACKER`. A file missing any is incomplete and must not be submitted.
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
  - Garment looks only; nudity is not a row (it is the `nude` pair in the scene list).
  - A creature / animal wearing nothing has NO rows.
  - Look slugs: lowercase `[a-z0-9]+(_[a-z0-9]+)*`, e.g. `raincoat`, `evening_dress`.

Pre-completion audit: before `task_complete`, re-open every file; confirm all five headings are present and VISUAL PROFILE has no blank or `[...]` field. Files are registered automatically.
````

### 4c. create_scenes

```
create_task({ id: "create_scenes", requires_tasks: ["write_screenplay","character_table"], requires_artifacts: ["screenplay","character_table"], title: "Scene list", description: "Scene table with outfits and beats",
  agent: <director>, policies: ["scenes-quality","scenes-complete"], prompt: <below>,
  output_artifact_name: "scene_list", output_artifact_description: "Scene List", output_files: ["scene_list.md"] })
```
prompt:
````
Inputs: artifact `character_table` (all character_*.md files), artifact `screenplay`. Deliverable: artifact `scene_list`, the single file `scene_list.md`.
Workspace content policy (nudity): {workspace.contentPolicy.nudity} (absent or empty = forbidden).
Nudity `allowed`: load skill `workflow-calling-conventions` first and use the names of its section "Explicit acts and positions".

First step, before writing
- Read every `character_<slug>.md`; list (a) the character stems and (b) each character's WARDROBE TRACKER look slugs.
- From then on copy those slugs EXACTLY. Never invent a name, a character or a look slug (a character the story names only by role keeps the role slug, e.g. `sister`).

Output
- Write `scene_list.md` as plain Markdown (never PDF or DOCX): ONE scene table, then a Beats section.

Scene table columns
- `Scene #` | `INT/EXT` (exactly `INT` or `EXT`; never `INT/EXT` / `EXT/INT`) | `Location` (display name of the ONE place) | `location_slug` (lowercase slug; the same place has the same slug in every scene) | `Time of day` | `Summary` | `Characters present` | `Outfits`.
- `Summary`: one sentence naming every entrance, exit and spoken line that matters to the story, not only the main action.
- `Characters present`: slugs equal the `character_<slug>.md` stems; every listed character appears in some beat's `Outfits` of that scene, else drop them from the row.
- `Outfits`: `<character_slug>:<look_slug>` pairs separated by `; `, e.g. `mira:raincoat; jonas:work_suit`.
  - A character who changes look inside the scene appears once per look: `mira:raincoat; mira:nightgown`.
  - The row's `Outfits` is exactly the UNION of its beats' `Outfits`: nothing missing, nothing extra.
- A scene row = ONE place and ONE continuous time. A change of place starts a new scene; never merge places into one row ("Backyard terrace / Hallway" is two scenes). The ~4-scene short-film default never overrides this: add scenes rather than merge places.

Looks
- Allowed look values: a look slug from that character's WARDROBE TRACKER (copy exactly; add a tracker row only if the screenplay demands one, and say so in the summary), `nude`, or `none` (a character that wears nothing, e.g. an animal).
- `nude`: only for an adult, only when nudity is `allowed`; never for a minor. Garments belong to outfit looks, never to the base look.
- A character's BASE look (the `wardrobe` of its character design in `plan-designs`) is decided by age and policy only, never by whether the character is shown nude in a scene or by character-table notes ("face never shown").
- A character with ANY body part in frame in a beat (a POV character's hands or knees included) is visible: list them in that beat's `Outfits`. An off-frame character is not listed.
- A character appearing only in a `parallel` cutaway at another place need not be in the row's `Characters present`, but is listed in that beat's `Outfits` and in the row's `Outfits` union.

Beats section (same file, below the table)
- Per scene: a `### Scene <n>` heading and a table with one row per beat. Every scene has at least one beat (typically 2-6).
- Columns, ALL filled in EVERY beat (an empty cell fails the `scenes-complete` check):
  - `Beat #`: `<scene>.<n>` (`1.1`, `1.2`, …), unique and never renumbered on a rewrite — the
    storyboard's shots name their beat by it (`Beat: 1.2`).
  - `Action`: what visibly happens.
  - `Location`: a `location_slug`. For every non-`parallel` beat EXACTLY the scene row's own slug; only a `parallel` beat names another place.
  - `Outfits` (right after `Location`): looks of the characters VISIBLE in the beat as `<character_slug>:<look_slug>` pairs separated by `; `, e.g. `jonas:work_suit; mira:raincoat`; `none` when nobody is visible. Written out for EVERY beat, never "same as above" or empty.
  - `Framing`: ONE opening shot size and angle (never "close-up then wide": a change of framing is a
    `Camera move` or a new beat).
  - `Camera move`: push-in, pull-out, pan left/right, tilt up/down, track, crane, handheld drift, orbit, or `hold` ONLY when the beat asks for stillness.
  - `Continuity` (relation to the PREVIOUS beat):
    - `continuous` = the action carries straight on: same place, same moment, same people, even when the framing changes.
    - `parallel` = happens at the same time somewhere ELSE; MUST give its place in `Location` (reuse a table slug or define a new stable slug of lowercase a-z0-9 words joined by `_`, e.g. `driveway`; inventing a place slug is allowed).
    - `new moment` = a jump in time, place or subject, or an insert. The first beat of a scene is `new moment`.
  - `Blocking`: who is where, facing which way.
  - `Contact`: who touches whom or what, and where on the body or object, in plain body-part words
    (hands, mouth, shoulders, waist, lap, groin, …): the storyboard turns it into the shot's
    structured `Contact:` line; `none` when nothing does.
  - `Sex act` and `Sex position` (nudity `allowed` ONLY, after `Contact`; under `forbidden` or absent leave both columns out):
    - Names exactly as listed in "Explicit acts and positions" of `workflow-calling-conventions`, or `other (<plain words>)`.
    - Value: `none`, or `<name>[ + <name>]*[: <detail>]`. `Sex act` may combine acts with ` + `; `Sex position` names exactly ONE position (a position change is a new beat).
    - `<detail>` = who does what to whom and the contact points, plain explicit words, no euphemisms (e.g. `Sex act: vaginal penetration: Jonas enters Lena from behind`, `Sex position: doggy style: Lena on hands and knees on the bed, Jonas kneeling behind her`).
    - `Sex act` is `none` exactly when `Sex position` is `none`.
    - Nudity alone, undressing, posing nude, kissing, hugging, caressing and touching are NOT a sex act (both `none`; nudity is the `Outfits` look, touch is `Contact`).
    - Never an act for a depicted minor.
- A beat is ONE moment: one beat per distinct action or happening; each entrance, exit and picture-changing dialogue line is its own beat. Two successive verbs ("sits down and opens the laptop") = two beats; only simultaneous actions ("as" / "while") share one. The sequence words `then`, `after`, `before`, `followed by`, `cut to` and arrows never appear in a beat's `Action` or `Framing` — the storyboard refuses them in its shots, so a beat holding one is split here, in order. One beat = one place and one opening framing; split a beat that packs two places or two framings.
- A beat with a `Sex act` holds only that act (its lead-up — undressing, climbing on, straddling — is an earlier beat, `none`), so the shot that shows the act carries it whole.
- POV beats: name the POV character in `Blocking` ("POV: <character_slug>"); that character is the camera and shows only their own limbs (hands, forearms, knees, feet), only when in frame, never a full-body figure.
- Undressing (nudity `allowed`, adult only): the beat where a character undresses already carries `<character_slug>:nude`, and so does EVERY later beat of that character in the scene (until a later beat dresses them); the row's `Outfits` lists the `nude` pair too. Otherwise keep a tracker look.
- Garment state: when a beat's action needs a body part the current look covers, the beat's `Action` / `Blocking` names the garment state ("cardigan slipped off her shoulders"); when it lasts into later beats it is its own WARDROBE TRACKER look in this and every later beat's `Outfits`.
- Downstream use: the storyboard's `Movement:`, `Transition:` and `Outfits:` lines and the clip prompts are taken from the beats (`continuous` -> `continue` transition; `parallel` -> cutaway shot at its named place with that place's location design; extra location designs come from the beat `Location` slugs, outfit designs from the rows' `Outfits` union).

Pre-completion audit: before `task_complete`, re-open `scene_list.md`; confirm every Beats table has `Outfits`, `Camera move`, `Continuity`, `Blocking`, `Contact` (plus `Sex act` / `Sex position` when nudity is allowed: each `none` or listed names / `other (...)`, `none` in both or neither), no empty cell, every beat's `Action` and `Framing` is ONE moment (no two successive verbs, no `then` / `after` / `before` / `followed by` / `cut to` / arrows: split it), a beat with a `Sex act` holds only that act, every row's `Outfits` equals the union of its beats' looks, and a character stays `nude` after an undressing beat.
````

### 4d. plan_designs

```
create_task({ id: "plan_designs", requires_tasks: ["create_scenes","character_table"], requires_artifacts: ["character_table","scene_list"], title: "Plan and create designs", description: "Create the designs of the pre-production",
  agent: <design planner>, policies: ["design-plan-covers-scenes","designs-cover-plan","storyboards-cover-scenes"],
  difficulty: "hard", can_create_tasks: true, prompt: <below>,
  output_artifact_name: "design_plan", output_artifact_description: "Design Plan",
  output_files: ["scene_list.md","design_plan.json"] })
```
Both output files are declared (`scene_list.md` is a verbatim copy so the checks see both). The first prompt line is exact (the worker keys on it). prompt:
```
Load and use skill: plan-designs

Inputs: artifact `character_table` (files character_<slug>.md), artifact `scene_list` (scene_list.md).
Deliverable: the designs. Create one design per key of the plan's `designs` list with `create_design`, in order (characters, locations, outfits, then one storyboard per scene, each with a `format` attribute `portrait` | `landscape` derived from the story below, default `landscape`; see the skill). Story (medium / format): {workspace.story.plot}
Writing files (or a tool message about files written or a file count) is NOT completion: call `task_complete` only after every planned design was created with `create_design` and the `artifact_index` audit passed; if `task_complete` is refused because no tasks were created, continue creating designs, and report only counts the tool results show.
Along the way, write the plan record as output artifact `design_plan` (canonical names, write exactly these, plain text only, never PDF or DOCX): `scene_list.md` (Markdown, verbatim copy of the scene list) and `design_plan.json`.
```

## 5. Verify and reply

- Call `task_index` once; all four tasks must exist with the expected `requires`. Create any missing one (section 4 rules), then re-check.
- No check-verification calls: each `create_task` result lists the attached checks ("(auto)" = auto-attached).
- Reply in at most 4 short lines (see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`); list only confirmed tasks and precisely what failed; do not use the success message for a chain that is incomplete:
  > Scheduled pre-production: task://<screenplay> -> task://<cast> -> task://<scene_list> -> task://<plan_designs>.
  > Checks: <task id>: <checks from its create_task result>; ... (one entry per created task).
  > Skipped (already existed): task://<id>, ... (only if any).
  > Designs and storyboards appear in the Pre-production tab once plan-designs finishes.

## Never

- Read artifacts or run `create_design` yourself.
- Create a task out of order, duplicate an existing one, or paraphrase a worker prompt.
