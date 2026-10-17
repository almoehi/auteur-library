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

Runs in the workspace coordinator. It creates four chained tasks (each with its checks attached at
task level) and makes sure the coverage policies exist. It does not write content itself. The last task (`plan_designs`) is executed
by a worker using the `plan-designs` skill.

Chain: `write_screenplay` -> `character_table` -> `create_scenes` -> `plan_designs`.

## Step 1 — Preflight

1. **Brief present.** The story brief is `{workspace.story.plot}` (the workspace spec's
   `story.plot`). If it is empty or a placeholder, stop and tell the user:
   > "Cannot run pre-production: the workspace has no story plot. Add one (workspace spec
   > `story.plot`) and ask me again."
   Create nothing.
2. **Current state.** Call `task_index`, `artifact_index`, `policy_index`, `available_agents`.
   Remember which of these already exist (live = not failed/cancelled):
   - tasks `write_screenplay`, `character_table`, `create_scenes`, `plan_designs`
   - artifacts `screenplay`, `character_table`, `scene_list`, `design_plan`
   - policies `screenplay-quality`, `cast-quality`, `scenes-quality`, `scenes-complete`,
     `design-plan-covers-scenes`, `designs-cover-plan`, `storyboards-cover-scenes`
3. **Agents.** You need a writer for the screenplay, one for the cast table, one for the scene
   list, and a plain LLM planner for `plan_designs` (a tool-capable agent without a
   task-specific toolset, the agent `design_planner`, which has `create_design`). Pick by objective from `available_agents`
   (spec defaults: `screenwriter`, `casting_director`, `director`, `design_planner`). Never use the generic `planner` for `plan_designs`. If no suitable
   agent exists, tell the user which role is missing and stop.
4. **Idempotency.** Every task/artifact/policy that already exists is skipped, not recreated.
   If all four tasks exist, report their statuses and stop. If only a tail of the chain is missing,
   create just that tail (existing tasks are referenced in `requires_tasks` / `requires_artifacts`).

## Step 2 — Policies

All seven policies are TASK checks. The workspace's `autoAttach` rules (e.g. `task://plan_designs*`) attach them automatically to the tasks created by key, so the checks never depend on you; passing `create_task.policies` (Step 3 column) is optional reinforcement only. In a task check, `{input}` is the contents of the task's output files and `{toolCalls}` the task's tool calls. They normally already exist in the workspace template. Check `policy_index` and call `create_policy` ONLY for those that are missing, in a workspace that lacks them with text modality,
`Binary` grading and the model the other quality policies in `policy_index` use, with the
intent below, using `{input}` and `{workspace.story.plot}` in the `evalPrompt`:

| id | intent (answer YES/NO only) |
|---|---|
| `screenplay-quality` | `{input}` holds `screenplay.md`: the screenplay faithfully adapts the plot with proper format (INT./EXT. headings, action, dialogue) |
| `cast-quality` | `{input}` holds the `character_<slug>.md` files: every cast role of the story has a dedicated, complete profile. Animals and other non-human creatures with a story role (named, acting or plot-driving, in the title or premise, recurring) ARE cast roles and must be included; only pure background, props or set dressing (unnamed, no action, no plot function) are not. NEVER reject because a cast member is an animal; reject only if a required role is missing or a pure background element / prop was listed as cast |
| `scenes-quality` | `{input}` holds `scene_list.md`: the scene list covers all narrative beats with numbered scenes, INT/EXT, location, one-line action |
| `scenes-complete` | `{input}` holds `scene_list.md`: every scene row has a location slug and, for every character present, an outfit/look slug; EVERY beat has an `Outfits` entry (the looks of the characters visible in it) and the scene row's `Outfits` is the union of its beats' looks, `nude` only where the workspace allows it and never for a minor; every scene also has beats (the `Beats` section below the table) and EVERY beat names a camera move and a continuity (`continuous` | `parallel` | `new moment`; a `parallel` beat names its place) and a `Location` slug; every scene row has exactly one place (one `location_slug`, `INT/EXT` exactly `INT` or `EXT`, never `INT/EXT` or two places in one row) |
| `design-plan-covers-scenes` | `{input}` holds ALL output files of the task: `design_plan.json` and `scene_list.md` (verbatim copy of the scene list, the ground truth). YES only if every character and location (by `location_slug`, including every slug in the Beats `Location` column) occurring in the scene list has an entry in the plan, every (character, look) pair of the scene list other than `<character>:nude` and `<character>:none` (these need no outfit entry) has an `outfits` entry with that `character_slug` and `look_slug`, and no outfit's character is missing from the plan; otherwise NO naming the missing entries |
| `designs-cover-plan` | `{input}` holds the plan (`design_plan.json`); `{toolCalls}` the task's tool calls (the worker's calls). PLANNED = the character, location and outfit keys of the plan's `designs` list (fallback: the keys of the plan's entries); storyboards belong to `storyboards-cover-scenes`. A key is covered by a `Design created: key <key>` tool result, by appearing in an `artifact_index` result, or by the summary's `skipped (existing)` / `renamed: <old> -> <new>` lines (a renamed new key must appear in a `Design created` result). YES only if every planned key is covered; otherwise NO naming the uncovered keys |
| `storyboards-cover-scenes` | `{input}` holds ALL output files of the task: `scene_list.md` (verbatim copy of the scene list, the ground truth) and `design_plan.json`; `{toolCalls}` the task's tool calls. A scene is covered by a successful `create_design` result "Design created: key storyboard_scene_<n>" (match by that key), or a documented skip of an existing `storyboard_scene_<n>`. YES only if every scene number of the scene list has a storyboard; otherwise NO naming the scenes without one |

Each check is attached to the task named in the Step 3 table and judges that task's output files.
Never edit an existing policy here (see `modify-policy`).

## Step 3 — Planning (canonical names, decided once)

| Task id | Agent | Output artifact key | output_files (exact) | Required tasks / artifacts | `policies` (task checks) |
|---|---|---|---|---|---|
| `write_screenplay` | writer | `screenplay` | `["screenplay.md"]` | none | `screenplay-quality` |
| `character_table` | cast writer | `character_table` | open: `character_<slug>.md` per character (`files: []`) | tasks `write_screenplay`; artifacts `screenplay` | `cast-quality` |
| `create_scenes` | director | `scene_list` | `["scene_list.md"]` | tasks `write_screenplay`, `character_table`; artifacts `screenplay`, `character_table` | `scenes-quality`, `scenes-complete` |
| `plan_designs` | `design_planner` | `design_plan` | `["scene_list.md","design_plan.json"]` (BOTH, always) | tasks `create_scenes`, `character_table`; artifacts `character_table`, `scene_list` | `design-plan-covers-scenes`, `designs-cover-plan`, `storyboards-cover-scenes` |

**Format rule:** every declared output file is Markdown (`.md`) or JSON (`.json`), never `.pdf`, `.docx`, `.rtf` or any other binary/office format; downstream agents cannot read those. Every task prompt below tells the worker to write Markdown.

These names are canonical. Embed the exact output file names in each task's prompt; never rename
later. Checks are attached by the workspace's `autoAttach` rules; `create_task.policies` only reinforces them (never put checks in a task's prompt or description, see Key rules).

## Step 4 — Create the tasks (in this order)

Each of the four steps (4a-4d) is exactly ONE `create_task` call, written out literally in its
subsection. It creates the task, its output artifact, the artifact's files and the task's checks
together; there is no separate artifact call. Pass `policies` (the Step 3 column) as reinforcement; auto-attach is the mechanism, so a call without them is still valid.

- `id` = the Step 3 task id; `output_artifact_name` = the Step 3 output artifact KEY (a valid
  free snake_case key); `output_files` = the exact files from the Step 3 table (for the open
  `character_table` artifact use `[]`).
- `can_create_tasks: true` ONLY on `plan_designs` (a planning task: its worker calls
  `create_design`); the writer tasks (`write_screenplay`, `character_table`, `create_scenes`)
  leave it unset, so their workers cannot create tasks. Without the flag a worker's `create_design`
  / `create_task` is refused.
- Unknown check keys are refused with the list of known keys and nothing is created: fix the
  key from that list (or create the missing policy per Step 2) and call again.

**One turn, four calls, no prose.** Create ALL four tasks in the SAME turn, back to back: one
`create_task` call per round, each issued after the previous result (a later step's `requires_*`
references the earlier result, so never put several in one round: a `create_scenes` issued before
`character_table` exists fails with `requires.tasks references unknown task id`). Between the
calls write NO text: no announcements, no "let me verify", no progress notes. A text-only reply
ENDS your turn and the rest of the chain is never created. Do not re-read or re-verify stored
prompts; trust each `create_task` result. Only after the 4th result (or after a stop on failure,
below) may you write your single final report (Step 5), short per "Concise replies and task/artifact URIs" in `workflow-calling-conventions`.

**Use returned identifiers, never assumed ones.** `requires_tasks` / `requires_artifacts` accept
keys (or runtime ids). After every `create_task`, read the task id and artifact key FROM THE
RESULT TEXT (e.g. `key: <key>`) and use exactly those in later `requires_*` (the Step 3 names
are the intent; the result is the truth; never derive a key from a name or guess
`<task>_output`). An `error:` result names the known artifacts/tasks: pick the right one from
that list and correct the call; never retry an identical call.

**Stop on repeated failure.** If a step fails twice, stop the chain and report precisely which
steps were created (with the ids from their results) and which failed, with the error text. Never
claim a task that `create_task` did not confirm. Skip any task/artifact that already exists.

**Task prompts are verbatim and skill-led.** Each worker prompt below opens with `Load and use skill: <name>` (the worker skills `create-character-table`, `create-scene-list`, `plan-designs`; the screenplay task has none) and the fenced blocks are copied word for word. Never paraphrase them: a paraphrase once dropped every nudity-conditional rule (no `Act` column, no `nude` look). `{workspace.*}` placeholders stay literal in the prompt (the server substitutes them).

### 4a. write_screenplay
```
create_task({ id: "write_screenplay", title: "Write screenplay", description: "Adapt the story plot into a screenplay",
  agent: <writer>, policies: ["screenplay-quality"],
  prompt: <prompt below>, requires_tasks: [], requires_artifacts: [],
  output_artifact_name: "screenplay", output_artifact_description: "Screenplay", output_files: ["screenplay.md"] })
```
- prompt: adapt `{workspace.story.plot}` into a film screenplay (INT./EXT. headings, action, dialogue); write `screenplay.md` (the only output file) as plain Markdown, never PDF or DOCX.

### 4b. character_table
```
create_task({ id: "character_table", title: "Character table", description: "One profile file per cast role",
  agent: <cast writer>, policies: ["cast-quality"],
  prompt: <prompt below>, requires_tasks: ["write_screenplay"], requires_artifacts: ["screenplay"],
  output_artifact_name: "character_table", output_artifact_description: "Character Breakdown Table", output_files: [] })
```
- prompt (VERBATIM: copy this block word for word, never paraphrase, shorten or reorder it):
  ```
  Load and use skill: create-character-table

  Inputs: artifact `screenplay` (screenplay.md).
  Deliverable: artifact `character_table`, ONE plain Markdown file per cast role (speaking, named, meaningful presence; no props or walk-ons), named `character_<slug>.md` (never PDF or DOCX). Every later step uses these slugs exactly; no later step may introduce a character or a new name.
  Required sections in every file, all five as ## headings, in this order: NAME, ROLE, PERSONALITY, VISUAL PROFILE, WARDROBE TRACKER. A file missing any of them is incomplete and must not be submitted.
  Workspace content policy (nudity): {workspace.contentPolicy.nudity}. When it is `allowed`, an adult character's VISUAL PROFILE also carries the anatomical details needed for a consistent depiction (concrete, non-euphemistic `key: value` lines); a minor never does. Otherwise add none.
  The skill holds the full rules; follow them. Before `task_complete`, re-open every file and confirm all five headings are present.
  ```
  The character-table rules (identity and slug, section contents, wardrobe tracker, checklist) live in the worker skill `create-character-table`, not here.

### 4c. create_scenes
```
create_task({ id: "create_scenes", title: "Scene list", description: "Scene table with outfits and beats",
  agent: <director>, policies: ["scenes-quality","scenes-complete"],
  prompt: <prompt below>, requires_tasks: ["write_screenplay","character_table"], requires_artifacts: ["screenplay","character_table"],
  output_artifact_name: "scene_list", output_artifact_description: "Scene List", output_files: ["scene_list.md"] })
```
- prompt (VERBATIM: copy this block word for word, including the nudity-conditional lines with `{workspace.contentPolicy.nudity}`; never paraphrase, shorten or drop a line):
  ```
  Load and use skill: create-scene-list

  Inputs: artifact `character_table` (all character_*.md files), artifact `screenplay`.
  Deliverable: artifact `scene_list`, the single plain Markdown file `scene_list.md` (never PDF or DOCX): ONE scene table (one place and one continuous time per row, `INT/EXT` exactly INT or EXT, `Outfits` per scene) plus, per scene, a Beats table. Character and look slugs are copied EXACTLY from the character table; never invent a name, character or look slug.
  EVERY beat row of EVERY Beats table has ALL of these columns, none empty: Beat #, Action, Location, Outfits, Framing, Camera move, Continuity (continuous | parallel | new moment), Blocking, Contact.
  - Contact: who touches whom or what, and where; `none` when nothing does.
  Workspace content policy (nudity): {workspace.contentPolicy.nudity}. When it is `allowed`:
  - Beats tables ALSO have the column Act, filled in every beat: plain, explicit words for who does what to whom, with the positions and contact points, no euphemisms; `none` for a beat without an act. Never an act for a minor.
  - A character who undresses has `<character_slug>:nude` in the Outfits of that beat and of EVERY later beat, and in the scene row's Outfits (adults only; a minor keeps a tracker look).
  When it is not `allowed` (`forbidden` or empty): no Act column, no `nude` look.
  The skill holds the full rules; follow them. Before `task_complete`, re-open scene_list.md and check the columns and the nudity rules above.
  ```
- **Beats columns, the contract** (the block above and the `create-scene-list` skill both state it; the `scenes-complete` check judges it): `Contact` is always required; `Act` is required whenever `{workspace.contentPolicy.nudity}` is `allowed`; both filled in EVERY beat.
- **Pre-send self-check (before the `create_task` call).** Re-read the prompt you are about to send and confirm it (1) starts with `Load and use skill: create-scene-list`, (2) contains the line `- Contact: who touches whom or what`, (3) contains the `Workspace content policy (nudity):` line with the placeholder `{workspace.contentPolicy.nudity}` still literal (the server substitutes it), and (4) contains the `Act` and `nude` bullets. A missing item means the block was paraphrased: re-copy it from this file and check again. Do the same for 4b (`Load and use skill: create-character-table`, the five headings, the nudity line).
- The scene-list rules themselves (columns, slugs, Outfits union, POV, beats, downstream use) live in the worker skill `create-scene-list`; do not restate them in the prompt.

### 4d. plan_designs (the orchestrator)
```
create_task({ id: "plan_designs", title: "Plan and create designs", description: "Create the designs of the pre-production",
  agent: "design_planner", policies: ["design-plan-covers-scenes","designs-cover-plan","storyboards-cover-scenes"],
  difficulty: "hard", can_create_tasks: true,
  prompt: <prompt below>, requires_tasks: ["create_scenes","character_table"], requires_artifacts: ["character_table","scene_list"],
  output_artifact_name: "design_plan", output_artifact_description: "Design Plan",
  output_files: ["scene_list.md","design_plan.json"] })
```
`can_create_tasks: true` is set only here. BOTH output files must be declared (`scene_list.md` is a verbatim copy of the scene list, so the task check judge sees both in `{input}`). The prompt is VERBATIM (copy it word for word; the first line is exact, the worker keys on it):

```
Load and use skill: plan-designs

Inputs: artifact `character_table` (files character_<slug>.md), artifact `scene_list` (scene_list.md).
Deliverable: the designs. Create one design per key of the plan's `designs` list with `create_design`, in order (characters, locations, outfits, then one storyboard per scene; see the skill). Writing files (or a tool message about files written or a file count) is NOT completion: call `task_complete` only after every planned design was created with `create_design` and the `artifact_index` audit passed; if `task_complete` is refused because no tasks were created, continue creating designs, and report only counts the tool results show.
Along the way, write the plan record as output artifact `design_plan` (canonical names, write exactly these, plain text only, never PDF or DOCX): `scene_list.md` (Markdown, verbatim copy of the scene list) and `design_plan.json`.
```

## Step 5 — Verify and confirm

Reconcile before replying: call `task_index` once. All four tasks of the Step 3 plan must be
present with the expected `requires`; create any planned task that is missing (Step 4 rules, one
per round) and call `task_index` again. Report only tasks confirmed by `create_task` results and
this index; list only what still failed, precisely, and do not use the success message below for
a chain that is incomplete.

Checks need no verification calls: each `create_task` result shows the checks attached to the task, with "(auto)" marking auto-attached ones. The final reply lists each created task with the checks its result showed (no extra tool calls).

Then tell the user, in at most 4 short lines
(see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`):

> "Scheduled pre-production: task://<screenplay> -> task://<cast> -> task://<scene_list> -> task://<plan_designs>.
> Checks: <task id>: <checks from its create_task result>; ... (one entry per created task).
> Skipped (already existed): task://<id>, ... (only if any).
> Designs and storyboards appear in the Pre-production tab once plan-designs finishes."

## Key rules

1. Preflight first; no plot means no tasks.
2. All four `create_task` calls in the same turn, one per round, in order, no prose between them; later `requires_*` use the keys/ids returned by earlier results.
3. Idempotent: skip existing tasks, artifacts and policies; never duplicate.
4. Canonical ids and filenames from the Step 3 table, identical in every prompt and in every `create_task` call.
5. Checks come from the workspace's `autoAttach` rules; `policies` (Step 3 column) is optional reinforcement, never the only mechanism, and checks never go in prompt or description text. No `task_info` / `assign_policy` verification: report the checks from the `create_task` results.
6. Policies exist before the `create_task` that references them (create missing ones with `create_policy` first, Step 2); an unknown key in `policies` is refused and nothing is created.
7. Never claim an unconfirmed task. Do not read artifacts or run `create_design` yourself; the `plan_designs` worker does it (it is the only task created with `can_create_tasks: true`).
