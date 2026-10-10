---
name: run-preproduction
description: >
  Trigger when the user wants the whole pre-production phase set up from the story — e.g.
  "run pre-production", "prepare the production", "set up screenplay, cast and designs",
  "get everything ready before we shoot", "start from the plot and create the designs".
  Schedules the chain screenplay -> character table -> scene list -> design planning, so
  characters, outfits and locations end up as design-studio designs. Do NOT invoke for
  shooting or rendering scenes, storyboards, creating a single character/outfit/location
  design, or editing an existing screenplay, cast list or scene list.
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
     `design-plan-covers-scenes`, `designs-cover-plan`
3. **Agents.** You need a writer for the screenplay, one for the cast table, one for the scene
   list, and a plain LLM planner for `plan_designs` (a tool-capable agent without a
   task-specific toolset, the agent `design_planner`, which has `create_design`). Pick by objective from `available_agents`
   (spec defaults: `screenwriter`, `casting_director`, `director`, `design_planner`). Never use the generic `planner` for `plan_designs`. If no suitable
   agent exists, tell the user which role is missing and stop.
4. **Idempotency.** Every task/artifact/policy that already exists is skipped, not recreated.
   If all four tasks exist, report their statuses and stop. If only a tail of the chain is missing,
   create just that tail (existing tasks are referenced in `requires_tasks` / `requires_artifacts`).

## Step 2 — Policies

All six policies are attached as TASK checks (`create_task.policies`). In a task check, `{input}` is the contents of the task's output files and `{toolCalls}` the task's tool calls. They normally already exist in the workspace template. Check `policy_index` and call `create_policy` ONLY for those that are missing, in a workspace that lacks them with text modality,
`Binary` grading and the model the other quality policies in `policy_index` use, with the
intent below, using `{input}` and `{workspace.story.plot}` in the `evalPrompt`:

| id | intent (answer YES/NO only) |
|---|---|
| `screenplay-quality` | `{input}` holds `screenplay.md`: the screenplay faithfully adapts the plot with proper format (INT./EXT. headings, action, dialogue) |
| `cast-quality` | `{input}` holds the `character_<slug>.md` files: every cast role of the story has a dedicated, complete profile |
| `scenes-quality` | `{input}` holds `scene_list.md`: the scene list covers all narrative beats with numbered scenes, INT/EXT, location, one-line action |
| `scenes-complete` | `{input}` holds `scene_list.md`: every scene row has a location slug and, for every character present, an outfit/look slug |
| `design-plan-covers-scenes` | `{input}` holds ALL output files of the task: `design_plan.json` and `scene_list.md` (verbatim copy of the scene list, the ground truth). YES only if every character, location (by `location_slug`) and (character, look) outfit occurring in the scene list has an entry in the plan, and no outfit's character is missing from the plan; otherwise NO naming the missing entries |
| `designs-cover-plan` | `{input}` holds the plan (`design_plan.json`); `{toolCalls}` the task's tool calls (the worker's calls). Count the successful `create_design` calls (result "Design created: ..."), identified by `kind` + `display_name`, and compare with the plan entries; a design that already existed and is documented as skipped counts as covered. Tool-call args may be truncated at about 200 characters, so match on `kind` and `display_name` only. YES only if every plan entry is covered |

Each check is attached to the task named in the Step 3 table and judges that task's output files.
Never edit an existing policy here (see `modify-policy`).

## Step 3 — Planning (canonical names, decided once)

| Task id | Agent | Output artifact key | output_files (exact) | Required tasks / artifacts | `policies` (task checks) |
|---|---|---|---|---|---|
| `write_screenplay` | writer | `screenplay` | `["screenplay.md"]` | none | `screenplay-quality` |
| `character_table` | cast writer | `character_table` | open: `character_<slug>.md` per character (`files: []`) | tasks `write_screenplay`; artifacts `screenplay` | `cast-quality` |
| `create_scenes` | director | `scene_list` | `["scene_list.md"]` | tasks `write_screenplay`, `character_table`; artifacts `screenplay`, `character_table` | `scenes-quality`, `scenes-complete` |
| `plan_designs` | `design_planner` | `design_plan` | `["scene_list.md","design_plan.json"]` (BOTH, always) | tasks `create_scenes`, `character_table`; artifacts `character_table`, `scene_list` | `design-plan-covers-scenes`, `designs-cover-plan` |

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
              output_artifact_name, output_files, output_artifact_description, policies })
```

- `id` = the Step 3 task id; `output_artifact_name` = the Step 3 output artifact KEY (a valid
  free snake_case key); `output_files` = the exact files from the Step 3 table (for the open
  `character_table` artifact use `[]`); `policies` = the checks from the Step 3 table
  (task checks; they judge the task's output files).
- Unknown check keys are refused with the list of known keys and nothing is created: fix the
  key from that list (or create the missing policy per Step 2) and call again.

**One turn, four calls, no prose.** Create ALL four tasks in the SAME turn, back to back: one
`create_task` call per round, each issued after the previous result (a later step's `requires_*`
references the earlier result, so never put several in one round: a `create_scenes` issued before
`character_table` exists fails with `requires.tasks references unknown task id`). Between the
calls write NO text: no announcements, no "let me verify", no progress notes. A text-only reply
ENDS your turn and the rest of the chain is never created. Do not re-read or re-verify stored
prompts; trust each `create_task` result. Only after the 4th result (or after a stop on failure,
below) may you write your single final report (Step 5).

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
    `VISUAL PROFILE` (character type, age, ethnicity, hair, eyes, build, distinguishing
    features — one `key: value` line each), `WARDROBE TRACKER` (a table: look slug | description |
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
  Character slugs must equal the `character_<slug>.md` file stems from the character table; look
  slugs must exist in that character's WARDROBE TRACKER (add a new look there only if the
  screenplay demands one, and say so in the summary). Every present character needs a look.
  Short-film default: no more than 4 scenes unless the story requires more.

### 4d. plan_designs (the orchestrator)
- agent: `design_planner`; `difficulty: "hard"`
- `requires_tasks: ["create_scenes","character_table"]`,
  `requires_artifacts: ["character_table","scene_list"]`
- `output_artifact_name: "design_plan"`, `output_artifact_description: "Design Plan"`, `output_files: ["scene_list.md","design_plan.json"]` (BOTH must be declared in this call; `scene_list.md` is a verbatim copy of the scene list, so the task check judge sees both in `{input}`), `policies: ["design-plan-covers-scenes","designs-cover-plan"]`
- description/prompt (the first line is exact, the worker keys on it):

```
Load and use skill: plan-designs

Inputs: artifact `character_table` (files character_<slug>.md), artifact `scene_list` (scene_list.md).
Output artifact `design_plan`; output files (canonical names, write exactly these, plain text only, never PDF or DOCX): `scene_list.md` (Markdown, verbatim copy of the scene list) and `design_plan.json`, then one create_design call per design plan entry.
```

## Step 5 — Verify and confirm

Call `task_index` once: all four tasks present with the expected `requires`. Report only tasks
confirmed by `create_task` results and this index; if any step failed or is missing, say so
precisely and do not use the success message below. Then tell the user:

> "Scheduled pre-production: **Write Screenplay** -> **Create Cast List** -> **Create Scene List**
> -> **Plan Designs**. Skipped (already existed): <list or none>. Policies created: <list or none>.
> Designs appear in the Pre-production tab once `plan_designs` finishes."

## Key rules

1. Preflight first; no plot means no tasks.
2. All four `create_task` calls in the same turn, one per round, in order, no prose between them; later `requires_*` use the keys/ids returned by earlier results.
3. Idempotent: skip existing tasks, artifacts and policies; never duplicate.
4. Canonical ids and filenames from the Step 3 table, identical in every prompt and in every `create_task` call.
5. Never write check/policy names into a task's prompt or description (a worker would pass them on, e.g. as `create_design` policies); checks are attached only through `create_task.policies`.
6. Policies exist before the `create_task` that references them (create missing ones with `create_policy` first, Step 2); an unknown check key is refused and nothing is created.
7. Never claim an unconfirmed task. Do not read artifacts or run `create_design` yourself; the worker does it.
