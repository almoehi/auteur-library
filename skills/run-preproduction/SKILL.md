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

Runs in the workspace coordinator. It creates four chained tasks and makes sure the coverage
policies exist. It does not write content itself. The last task (`plan_designs`) is executed
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

All six policies are ARTIFACT policies (they judge an output artifact's files) and normally already exist in the workspace template. Check `policy_index` and call `create_policy` ONLY for those that are missing, in a workspace that lacks them with text modality,
`Binary` grading and the model the other quality policies in `policy_index` use, with the
intent below, using `{input}` and `{workspace.story.plot}` in the `evalPrompt`:

| id | intent (answer YES/NO only) |
|---|---|
| `screenplay-quality` | the screenplay faithfully adapts the plot with proper format (INT./EXT. headings, action, dialogue) |
| `cast-quality` | every cast role of the story has a dedicated, complete profile |
| `scenes-quality` | the scene list covers all narrative beats with numbered scenes, INT/EXT, location, one-line action |
| `scenes-complete` | every scene row has a location slug and, for every character present, an outfit/look slug |
| `design-plan-covers-scenes` | `{input}` holds ALL files of the `design_plan` artifact: `design_plan.json` and `scene_list.md` (verbatim copy of the scene list, the ground truth). YES only if every character, location (by `location_slug`) and (character, look) outfit occurring in the scene list has an entry in the plan, and no outfit's character is missing from the plan; otherwise NO naming the missing entries |
| `designs-cover-plan` | `{input}` holds the plan (`design_plan.json`); `{toolCalls}` the worker's calls. Count the successful `create_design` calls (result "Design created: ..."), identified by `kind` + `display_name`, and compare with the plan entries; a design that already existed and is documented as skipped counts as covered. Tool-call args may be truncated at about 200 characters, so match on `kind` and `display_name` only. YES only if every plan entry is covered |

`scenes-complete` attaches to the `scene_list` artifact; the other five likewise to the artifacts named in Step 4.
Never edit an existing policy here (see `modify-policy`).

## Step 3 — Planning (canonical names, decided once)

| Task id | Artifact id / name | Files |
|---|---|---|
| `write_screenplay` | `screenplay` | `screenplay.md` |
| `character_table` | `character_table` | open artifact: one file per character, `character_<slug>.md` |
| `create_scenes` | `scene_list` | `scene_list.md` |
| `plan_designs` | `design_plan` | `design_plan.json`, `scene_list.md` (verbatim copy) |

These names are canonical. Embed them in task prompts; never rename later.

## Step 4 — Create the tasks (in this order)

**One call per step, strictly in order.** Issue exactly ONE `create_artifact` or `create_task`
call per round and wait for its result before the next. Never put several of these calls in the
same round: a later step's `requires_*` references the earlier step's result, so it cannot be
issued before that result exists (a `create_scenes` issued before `character_table` exists fails
with `requires.tasks references unknown task id`).

**Use returned identifiers, never assumed ones.** After every `create_artifact` / `create_task`,
read the artifact key and task id FROM THE RESULT TEXT (e.g. `key: <key>`) and use exactly those
in later `requires_tasks` / `requires_artifacts` (the Step 3 names below are the intent; the
result is the truth; never derive a key from a name or guess `<task>_output`). An `error:` result
names the known artifacts/tasks: pick the right one from that list and correct the call; never
retry an identical call.

**Stop on repeated failure.** If a step fails twice, stop the chain and report precisely which
steps were created (with the ids from their results) and which failed, with the error text. Never
claim a task that `create_task` did not confirm.

Policies must sit on the OUTPUT ARTIFACT, not the task, and `create_task.policies` only
attaches task policies. So for each step: first `create_artifact({id, name, description, files, policies})`
(artifact id and files from Step 3; for the open `character_table` artifact use `files: []`),
then, as a separate later call, `create_task({..., artifacts: ["<artifact key from the result>"]})`.
Do not use `output_artifact_name` for outputs that carry policies. If `create_artifact` fails
twice, stop and report; never create the task without its artifact. Skip any task/artifact that
already exists.

### 4a. write_screenplay
- agent: writer; artifact `screenplay` ("Screenplay"), files `["screenplay.md"]`, artifact policies `["screenplay-quality"]`
- prompt: adapt `{workspace.story.plot}` into a film screenplay (INT./EXT. headings, action, dialogue); write `screenplay.md`.

### 4b. character_table
- agent: cast writer; `requires_tasks: ["write_screenplay"]`, `requires_artifacts: ["screenplay"]`
- artifact `character_table` ("Character Breakdown Table"), open (no files), artifact policies `["cast-quality"]`
- prompt, verbatim requirements:
  - identify every cast role (speaking, named, meaningful presence; no props or walk-ons)
  - write ONE markdown file per character with `sandbox_write_file`, named `character_<slug>.md`
    where `<slug>` is the lowercase name, `[a-z0-9]+(_[a-z0-9]+)*`
  - each file has exactly these sections as `##` headings: `NAME`, `ROLE`, `PERSONALITY`,
    `VISUAL PROFILE` (character type, age, ethnicity, hair, eyes, build, distinguishing
    features — one `key: value` line each), `WARDROBE TRACKER` (a table: look slug | description |
    garments, colors, material, fit, accessories | scenes where worn; look slugs are
    lowercase, `[a-z0-9]+(_[a-z0-9]+)*`, e.g. `raincoat`, `evening_dress`)
  - files are registered automatically; then `task_complete`

### 4c. create_scenes
- agent: director; `requires_tasks: ["write_screenplay","character_table"]`,
  `requires_artifacts: ["screenplay","character_table"]`
- artifact `scene_list` ("Scene List"), files `["scene_list.md"]`, artifact policies `["scenes-quality","scenes-complete"]`
- prompt: produce ONE markdown table in `scene_list.md` with exactly these columns:
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
- artifact `design_plan` ("Design Plan"), files `["design_plan.json","scene_list.md"]` (the second is a verbatim copy of the scene list, so the artifact policy judge sees both), artifact policies `["design-plan-covers-scenes","designs-cover-plan"]`
- description/prompt (the first line is exact, the worker keys on it):

```
Load and use skill: plan-designs

Inputs: artifact `character_table` (files character_<slug>.md), artifact `scene_list` (scene_list.md).
Output files (canonical names): `design_plan.json` and `scene_list.md` (verbatim copy of the scene list), then one create_design call per design plan entry.
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
2. One create call per round, in order; later `requires_*` use the keys/ids returned by earlier results.
3. Idempotent: skip existing tasks, artifacts and policies; never duplicate.
4. Canonical ids and filenames from Step 3, identical in every prompt.
5. Policies exist before the artifacts that reference them; attach them to the output artifact via `create_artifact.policies`, then link it with `create_task.artifacts`.
6. Never claim an unconfirmed task. Do not read artifacts or run `create_design` yourself; the worker does it.
