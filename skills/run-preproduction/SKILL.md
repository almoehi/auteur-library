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

All seven policies are attached as TASK checks (`create_task.policies`). In a task check, `{input}` is the contents of the task's output files and `{toolCalls}` the task's tool calls. They normally already exist in the workspace template. Check `policy_index` and call `create_policy` ONLY for those that are missing, in a workspace that lacks them with text modality,
`Binary` grading and the model the other quality policies in `policy_index` use, with the
intent below, using `{input}` and `{workspace.story.plot}` in the `evalPrompt`:

| id | intent (answer YES/NO only) |
|---|---|
| `screenplay-quality` | `{input}` holds `screenplay.md`: the screenplay faithfully adapts the plot with proper format (INT./EXT. headings, action, dialogue) |
| `cast-quality` | `{input}` holds the `character_<slug>.md` files: every cast role of the story has a dedicated, complete profile. Animals and other non-human creatures with a story role (named, acting or plot-driving, in the title or premise, recurring) ARE cast roles and must be included; only pure background, props or set dressing (unnamed, no action, no plot function) are not. NEVER reject because a cast member is an animal; reject only if a required role is missing or a pure background element / prop was listed as cast |
| `scenes-quality` | `{input}` holds `scene_list.md`: the scene list covers all narrative beats with numbered scenes, INT/EXT, location, one-line action |
| `scenes-complete` | `{input}` holds `scene_list.md`: every scene row has a location slug and, for every character present, an outfit/look slug; every scene also has beats (the `Beats` section below the table) and EVERY beat names a camera move and a continuity (`continuous` | `parallel` | `new moment`; a `parallel` beat names its place) |
| `design-plan-covers-scenes` | `{input}` holds ALL output files of the task: `design_plan.json` and `scene_list.md` (verbatim copy of the scene list, the ground truth). YES only if every character and location (by `location_slug`, including every place named by a `parallel` beat) occurring in the scene list has an entry in the plan, every (character, look) pair of the scene list is either that character's `base_look` (covered by the character entry, no outfit entry needed) or has an outfit entry, and no outfit's character is missing from the plan; otherwise NO naming the missing entries |
| `designs-cover-plan` | `{input}` holds the plan (`design_plan.json`); `{toolCalls}` the task's tool calls (the worker's calls). Count the successful `create_design` calls (result "Design created: ..."), identified by `kind` + `display_name`, and compare with the plan entries; a design that already existed and is documented as skipped counts as covered. Tool-call args may be truncated at about 200 characters, so match on `kind` and `display_name` only. Base looks have no outfit entry and need no outfit design (the character design covers them). YES only if every plan entry is covered |
| `storyboards-cover-scenes` | `{input}` holds ALL output files of the task: `scene_list.md` (verbatim copy of the scene list, the ground truth) and `design_plan.json`; `{toolCalls}` the task's tool calls. Count the successful `create_design` calls with `kind` `storyboard` (result "Design created: ..."); a storyboard that already existed (`storyboard_scene_<n>`) and is documented as skipped counts as covered. Tool-call args may be truncated at about 200 characters, so match on `kind` and `display_name` ("Scene <n>"). YES only if every scene number of the scene list has a storyboard; otherwise NO naming the scenes without one |

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
later. Checks are attached ONLY through `create_task.policies` (never in a task's prompt or
description, see Key rules).

## Step 4 — Create the tasks (in this order)

Each of the four steps is exactly ONE `create_task` call. It creates the task, its output
artifact, the artifact's files and the task's checks together; there is no separate
artifact call:

```
create_task({ id, title, description, prompt, agent, requires_tasks, requires_artifacts,
              output_artifact_name, output_files, output_artifact_description, policies,
              can_create_tasks })
```

- `id` = the Step 3 task id; `output_artifact_name` = the Step 3 output artifact KEY (a valid
  free snake_case key); `output_files` = the exact files from the Step 3 table (for the open
  `character_table` artifact use `[]`); `policies` = the checks from the Step 3 table
  (task checks; they judge the task's output files).
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

### 4a. write_screenplay
- agent: writer; `output_artifact_name: "screenplay"`, `output_artifact_description: "Screenplay"`, `output_files: ["screenplay.md"]`, `policies: ["screenplay-quality"]`
- prompt: adapt `{workspace.story.plot}` into a film screenplay (INT./EXT. headings, action, dialogue); write `screenplay.md` (the only output file) as plain Markdown, never PDF or DOCX.

### 4b. character_table
- agent: cast writer; `requires_tasks: ["write_screenplay"]`, `requires_artifacts: ["screenplay"]`
- `output_artifact_name: "character_table"`, `output_artifact_description: "Character Breakdown Table"`, `output_files: []` (open), `policies: ["cast-quality"]`
- prompt, verbatim requirements:
  - identify every cast role (speaking, named, meaningful presence; no props or walk-ons)
  - write ONE plain Markdown file per character (never PDF or DOCX) with `sandbox_write_file`, named `character_<slug>.md`
    where `<slug>` is the lowercase name, `[a-z0-9]+(_[a-z0-9]+)*`
  - each file has exactly these sections as `##` headings: `NAME`, `ROLE`, `PERSONALITY`,
    `VISUAL PROFILE` (character type, age, ethnicity, height, hair, eyes, build, build detail,
    proportions, posture, distinguishing features — one `key: value` line each; NO `[...]`
    placeholders or blanks: every field gets a concrete value, or the explicit word `n/a` when it
    does not apply; invent a fitting value the screenplay does not contradict rather than leave a
    field open; in a workspace with `contentPolicy.nudity: allowed` (`{workspace.contentPolicy.nudity}`)
    and an adult character, add the anatomical details needed for a consistent depiction as
    `key: value` lines in the same section, concrete and non-euphemistic; a minor never gets
    them), `WARDROBE TRACKER` (a table: look slug | description |
    garments, colors, material, fit, accessories | scenes where worn; look slugs are
    lowercase, `[a-z0-9]+(_[a-z0-9]+)*`, e.g. `raincoat`, `evening_dress`)
  - files are registered automatically; then `task_complete`
  - the prompt states the output artifact `character_table` and the file pattern `character_<slug>.md`

### 4c. create_scenes
- agent: director; `requires_tasks: ["write_screenplay","character_table"]`,
  `requires_artifacts: ["screenplay","character_table"]`
- `output_artifact_name: "scene_list"`, `output_artifact_description: "Scene List"`, `output_files: ["scene_list.md"]`, `policies: ["scenes-quality","scenes-complete"]`
- prompt: write the single output file `scene_list.md` as plain Markdown (never PDF or DOCX), containing ONE markdown table with exactly these columns:
  `Scene #` | `INT/EXT` | `Location` (display name) | `location_slug` (lowercase slug, stable:
  the same place has the same slug in every scene) | `Time of day` | `Summary` (one sentence) |
  `Characters present` | then per present character its outfit: `Outfits` as
  `<character_slug>:<look_slug>` pairs separated by `; ` (e.g. `mira:raincoat; jonas:work_suit`).
  The Summary names every entrance, exit and spoken line that matters to the story, not only the
  main action.
  Character slugs must equal the `character_<slug>.md` file stems from the character table; look
  slugs must exist in that character's WARDROBE TRACKER (add a new look there only if the
  screenplay demands one, and say so in the summary). Every present character needs a look.
  Short-film default: no more than 4 scenes unless the story requires more.
  **Beats section (below the table, same file).** For EACH scene a `### Scene <n>` heading and a
  markdown table with one row per beat: `Beat #` | `Action` (what visibly happens) | `Framing`
  (shot size and angle of the beat) | `Camera move` (how the camera moves during the beat of the
  video clip: push-in, pull-out, pan left/right, tilt up/down, track, crane, handheld drift,
  orbit, or `hold` ONLY when the beat asks for stillness) | `Continuity` (how the beat relates to
  the PREVIOUS beat: `continuous` = the action carries straight on - same place, same moment,
  same people, even when the framing changes; `parallel` = the beat happens at the SAME TIME
  somewhere ELSE (a car arriving outside while the reaction inside goes on) and MUST name its place
  in the Action as the `location_slug` of a location (reuse a slug of the table or invent a new
  stable one, e.g. `driveway`); `new moment` = a jump in time, place or subject, or an
  insert; the first beat of a scene is `new moment`).
  Beyond those columns every Beats table also has `Blocking` (who is where, facing which way) and
  `Contact` (who touches whom or what, where; `none` when nothing does). In a workspace with
  `contentPolicy.nudity: allowed` it also has an `Act` column: plain, explicit words for who does
  what to whom, the positions and contact points, no euphemisms (`none` for a beat without an act;
  never for a depicted minor). **One beat per distinct happening**: each entrance, each exit and
  each dialogue line that changes the picture is its own beat (a character leaving gets an exit
  beat, not a clause of the previous one). **POV scenes**: say which character is the POV; that
  character is the camera - their beats show their hands or forearms only, never a full-body
  figure, and the character is not listed as visible in `Blocking`.
  One beat = one place and one opening framing: split a beat that packs two places or two framings. Every scene has at least one beat
  (typically 2-6, one per distinct action or change of framing) and EVERY beat names a camera
  move and a continuity. Downstream, the storyboard's `Movement:` and `Transition:` lines and the
  shoot skills' video prompts are taken from these beats (`continuous` becomes a `continue`
  transition: the clip carries on from the previous one; a `parallel` beat becomes a cutaway shot at
  its named place, and the storyboard links that place's location design); a scene list without them yields clips
  that barely move and cut where they should flow.

### 4d. plan_designs (the orchestrator)
- agent: `design_planner`; `difficulty: "hard"`; `can_create_tasks: true` (the only task of the chain that gets it)
- `requires_tasks: ["create_scenes","character_table"]`,
  `requires_artifacts: ["character_table","scene_list"]`
- `output_artifact_name: "design_plan"`, `output_artifact_description: "Design Plan"`, `output_files: ["scene_list.md","design_plan.json"]` (BOTH must be declared in this call; `scene_list.md` is a verbatim copy of the scene list, so the task check judge sees both in `{input}`), X
- description/prompt (the first line is exact, the worker keys on it):

```
Load and use skill: plan-designs

Inputs: artifact `character_table` (files character_<slug>.md), artifact `scene_list` (scene_list.md).
Deliverable: the designs. Create one design per plan entry with `create_design` (characters, locations, outfits), then one storyboard design per scene (`kind: "storyboard"`, see the skill). Writing files is NOT completion: call `task_complete` only after every `create_design` call and the audit, and report only counts the tool results show.
Along the way, write the plan record as output artifact `design_plan` (canonical names, write exactly these, plain text only, never PDF or DOCX): `scene_list.md` (Markdown, verbatim copy of the scene list) and `design_plan.json`.
```

## Step 5 — Verify and confirm

Reconcile before replying: call `task_index` once. All four tasks of the Step 3 plan must be
present with the expected `requires`; create any planned task that is missing (Step 4 rules, one
per round) and call `task_index` again. Report only tasks confirmed by `create_task` results and
this index; list only what still failed, precisely, and do not use the success message below for
a chain that is incomplete. Then tell the user, in at most 3 short lines
(see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`; no policy lists):

> "Scheduled pre-production: task://<screenplay> -> task://<cast> -> task://<scene_list> -> task://<plan_designs>.
> Skipped (already existed): task://<id>, ... (only if any).
> Designs and storyboards appear in the Pre-production tab once plan-designs finishes."

## Key rules

1. Preflight first; no plot means no tasks.
2. All four `create_task` calls in the same turn, one per round, in order, no prose between them; later `requires_*` use the keys/ids returned by earlier results.
3. Idempotent: skip existing tasks, artifacts and policies; never duplicate.
4. Canonical ids and filenames from the Step 3 table, identical in every prompt and in every `create_task` call.
5. Never write check/policy names into a task's prompt or description (a worker would pass them on, e.g. as `create_design` policies); checks are attached only through `create_task.policies`.
6. Policies exist before the `create_task` that references them (create missing ones with `create_policy` first, Step 2); an unknown check key is refused and nothing is created.
7. Never claim an unconfirmed task. Do not read artifacts or run `create_design` yourself; the `plan_designs` worker does it (it is the only task created with `can_create_tasks: true`).
