---
name: run-preproduction
description: >
  Trigger when the user wants the whole pre-production phase set up from the story — e.g.
  "run pre-production", "prepare the production", "set up screenplay, cast and designs",
  "get everything ready before we shoot", "start from the plot and create the designs".
  Schedules the chain screenplay -> character table -> scene list -> design scheduling, so
  characters, outfits and locations end up as design-studio designs. Do NOT invoke for
  shooting or rendering scenes, storyboards, creating a single character/outfit/location
  design, or editing an existing screenplay, cast list or scene list.
agentType: workspace
---

# Run Pre-production

Runs in the workspace coordinator. It creates four chained tasks and makes sure the coverage
policies exist. It does not write content itself. The last task (`schedule_designs`) is executed
by a worker using the `schedule-designs` skill.

Chain: `write_screenplay` -> `character_table` -> `create_scenes` -> `schedule_designs`.

## Step 1 — Preflight

1. **Brief present.** The story brief is `{workspace.story.plot}` (the workspace spec's
   `story.plot`). If it is empty or a placeholder, stop and tell the user:
   > "Cannot run pre-production: the workspace has no story plot. Add one (workspace spec
   > `story.plot`) and ask me again."
   Create nothing.
2. **Current state.** Call `task_index`, `artifact_index`, `policy_index`, `available_agents`.
   Remember which of these already exist (live = not failed/cancelled):
   - tasks `write_screenplay`, `character_table`, `create_scenes`, `schedule_designs`
   - artifacts `screenplay`, `character_table`, `scene_list`, `design_manifest`
   - policies `screenplay-quality`, `cast-quality`, `scenes-quality`, `scenes-complete`,
     `manifest-covers-scenes`, `designs-cover-manifest`
3. **Agents.** You need a writer for the screenplay, one for the cast table, one for the scene
   list, and a plain LLM planner for `schedule_designs` (a tool-capable agent without a
   task-specific toolset, typically `planner`). Pick by objective from `available_agents`
   (spec defaults: `screenwriter`, `casting_director`, `director`, `planner`). If no suitable
   agent exists, tell the user which role is missing and stop.
4. **Idempotency.** Every task/artifact/policy that already exists is skipped, not recreated.
   If all four tasks exist, report their statuses and stop. If only a tail of the chain is missing,
   create just that tail (existing tasks are referenced in `requires_tasks` / `requires_artifacts`).

## Step 2 — Policies

Policies are attached atomically through `create_task.policies`, so they must exist first.
For every policy in the Step 1 list that is missing, call `create_policy` (text modality,
`Binary` grading, the model the other quality policies in `policy_index` use). The three
quality policies normally come from the workspace spec; recreate them only if absent, with
the intent below, using `{input}` and `{workspace.story.plot}` in the `evalPrompt`:

| id | intent (answer YES/NO only) |
|---|---|
| `screenplay-quality` | the screenplay faithfully adapts the plot with proper format (INT./EXT. headings, action, dialogue) |
| `cast-quality` | every cast role of the story has a dedicated, complete profile |
| `scenes-quality` | the scene list covers all narrative beats with numbered scenes, INT/EXT, location, one-line action |
| `scenes-complete` | every scene row has a location slug and, for every character present, an outfit/look slug |
| `manifest-covers-scenes` | `design_manifest.json` contains every character, location and (character, look) outfit that occurs in the scene list `{task.description}`-referenced artifact; none missing |
| `designs-cover-manifest` | the tool calls contain a successful `create_design` (or a documented skip for an already existing design) for every manifest entry |

`manifest-covers-scenes` and `designs-cover-manifest` also need the evidence as context: write
their prompts with `{input}` plus, where the engine supports them, `{artifactIndex}` and
`{toolCalls}` (see `ensure-render-covers-all-scenes` in `policy_index` for the style).
Never edit an existing policy here (see `modify-policy`).

## Step 3 — Planning (canonical names, decided once)

| Task id | Artifact id / name | Files |
|---|---|---|
| `write_screenplay` | `screenplay` | `screenplay.md` |
| `character_table` | `character_table` | open artifact: one file per character, `character_<slug>.md` |
| `create_scenes` | `scene_list` | `scene_list.md` |
| `schedule_designs` | `design_manifest` | `design_manifest.json` |

These names are canonical. Embed them in task prompts; never rename later.

## Step 4 — Create the tasks (in this order)

Each call carries its output artifact (`output_artifact_name` / `output_files`) and its
policies in the same `create_task` call. Skip any task that already exists.

### 4a. write_screenplay
- agent: writer; `output_artifact_name: "Screenplay"` (artifact id `screenplay`), `output_files: ["screenplay.md"]`
- `policies: ["screenplay-quality"]`
- prompt: adapt `{workspace.story.plot}` into a film screenplay (INT./EXT. headings, action, dialogue); write `screenplay.md`.

### 4b. character_table
- agent: cast writer; `requires_tasks: ["write_screenplay"]`, `requires_artifacts: ["screenplay"]`
- `output_artifact_name: "Character Breakdown Table"`, no `output_files` (open artifact)
- `policies: ["cast-quality"]`
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
- `output_artifact_name: "Scene List"`, `output_files: ["scene_list.md"]`
- `policies: ["scenes-quality","scenes-complete"]`
- prompt: produce ONE markdown table in `scene_list.md` with exactly these columns:
  `Scene #` | `INT/EXT` | `Location` (display name) | `location_slug` (lowercase slug, stable:
  the same place has the same slug in every scene) | `Time of day` | `Summary` (one sentence) |
  `Characters present` | then per present character its outfit: `Outfits` as
  `<character_slug>:<look_slug>` pairs separated by `; ` (e.g. `mira:raincoat; jonas:work_suit`).
  Character slugs must equal the `character_<slug>.md` file stems from the character table; look
  slugs must exist in that character's WARDROBE TRACKER (add a new look there only if the
  screenplay demands one, and say so in the summary). Every present character needs a look.
  Short-film default: no more than 4 scenes unless the story requires more.

### 4d. schedule_designs (the orchestrator)
- agent: the plain LLM planner; `difficulty: "hard"`
- `requires_tasks: ["create_scenes","character_table"]`,
  `requires_artifacts: ["character_table","scene_list"]`
- `output_artifact_name: "Design Manifest"`, `output_files: ["design_manifest.json"]`
- `policies: ["manifest-covers-scenes","designs-cover-manifest"]`
- description/prompt (the first line is exact, the worker keys on it):

```
Load and use skill: schedule-designs

Inputs: artifact `character_table` (files character_<slug>.md), artifact `scene_list` (scene_list.md).
Output: `design_manifest.json` (canonical name), then one create_design call per manifest entry.
```

## Step 5 — Verify and confirm

Call `task_index` once: all four tasks present with the expected `requires`. If any
`create_task` returned an error, report it; never claim success. Then tell the user:

> "Scheduled pre-production: **Write Screenplay** -> **Create Cast List** -> **Create Scene List**
> -> **Schedule Designs**. Skipped (already existed): <list or none>. Policies created: <list or none>.
> Designs appear in the Pre-production tab once `schedule_designs` finishes."

## Key rules

1. Preflight first; no plot means no tasks.
2. Idempotent: skip existing tasks, artifacts and policies; never duplicate.
3. Canonical ids and filenames from Step 3, identical in every prompt.
4. Policies are created before the tasks that reference them; attach via `create_task.policies`.
5. Do not read artifacts or run `create_design` yourself; the worker does it.
