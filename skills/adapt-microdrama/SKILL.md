---
name: adapt-microdrama
description: >
  Trigger when the user wants the story turned into a vertical micro-drama / short-drama series
  before pre-production — e.g. "adapt the story as a micro drama", "make this a vertical series
  with cliffhangers", "rewrite the plot for ReelShort-style episodes". Schedules ONE task that
  decomposes the workspace story into one or more vertical dramas of short episodes (hook,
  escalation, turn, cliffhanger) as the artifact `story_adaptation`; the person picks a drama and
  it is adopted as the story pre-production plans from. Do NOT invoke for running
  pre-production itself, writing a screenplay, or editing an existing adaptation.
agentType: workspace
---

# Adapt the Story as a Micro-drama

Coordinator skill: creates ONE task. It writes no content; the worker does, with skill
`microdrama-rewrite`. Optional; run it BEFORE `run-preproduction`. No event of the story is
dropped: a stated total length merges neighbouring events into fewer episodes (at most 3 per
episode; a denser story gets more 45 s episodes and a longer total), and a story with
several central conflicts becomes several dramas (`drama_1.md`, `drama_2.md`, ...); one workspace
produces ONE adopted drama.

## 1. Preflight

- Source story = `{workspace.story.plot}`. Empty or placeholder -> create nothing; tell the user:
  "Cannot adapt: the workspace has no story plot. Add one (workspace spec `story.plot`) and ask me again."
- `{workspace.story.sourcePlot}` not empty -> an adaptation is already in force. The user did not
  ask to redo it -> create nothing; say so and offer a redo. On a redo they confirmed: first
  `update_story({ restore_source: true })` (the check must compare against the original), then
  `reset_task` the existing `adapt_story` with their instructions (or create it if it is gone).
- Call `task_index`, `artifact_index`, `policy_index`, `available_agents`.
- A live `adapt_story` task (not failed / cancelled) exists -> report its status and stop. The user
  asks to redo it -> `reset_task` it with their instructions instead of creating a second one.
- Pre-production already started (`write_screenplay` exists) -> create nothing; tell the user:
  "Pre-production already runs from the original story. Delete or re-run it after the adaptation."
- Agent: the story adapter (`story_adapter`, role "Story adapter" in `available_agents`), else the
  `screenwriter` role, else the general-purpose worker; never a planner.

## 2. Check

ONE advisory text check, `microdrama_review` (grading `ShouldHave`: it reports, never rejects -
the LLM judges measured in validation were not reliable enough to gate; the person reviews
the files before pre-production). Missing from `policy_index` -> `create_policy` it first with
`id: "microdrama_review"` (snake_case: the key of a policy created in chat), text modality,
grading `ShouldHave`, and as `model` the exact `model` value the other quality policies in
`policy_index` carry (e.g. `screenplay-quality`'s) - never a model name that is not listed in
`policy_index`. The `evalPrompt` is the text below VERBATIM (placeholders stay literal). Never edit
an existing policy here (an older `microdrama_review` keeps its own items until the person updates
it with `modify-policy`). `create_policy` returned an error -> fix only what the error names and
call it again (at most twice); still refused -> create no task, go to 4.

````
The input is the contents of the files "series.md" and "drama_<k>.md" (each under a "# <file name>" line): a micro-drama adaptation of the original story below, decomposed into one or more dramas. Workspace nudity policy: {workspace.contentPolicy.nudity} ("allowed", anything else = forbidden). Judge ONLY the words of the input; the original story is for comparison and is never itself a defect.

Check each item against the input and quote the exact words of the input that break it:
(1) Files and headings: "series.md" has "## Adaptation", "## Cast", "## Turning points", "## Dramas"; EVERY file its Dramas table names is present in the input (a named file missing from the input is a defect); its "Dramas:" line states the table's number of dramas and the number of turning points; the number of turning points equals the number of episodes; every "drama_<k>.md" has "## Adaptation", "## Logline", "## Spine", "## Cast", "## Places", "## Episodes", "## Drama arc" in this order, an Adaptation section with a "Mode:" line and a "Format:" line naming vertical 9:16, and at least 2 episodes.
(2) Mode: "drama" when the original story has no sexual content; else "steamy" when the nudity policy is forbidden, "explicit" when it is allowed.
(3) Cast rows: a Cast table row whose role or look says heard, voice, mentioned or off-screen is a defect (such characters belong on the "Heard or mentioned only" line).
(4) Names: every Cast name occurs in the original story or is a role word ("Sister", "Husband", "Neighbour"); a first name found nowhere in the original story is a defect.
(5) Adults: every character in a romantic, nude or sexual beat has a Cast age of 21 or more; NO word anywhere in the input (key lines and change notes included) states or quotes an age under 21 for such a character, calls them "girl", attaches "little" to them, or uses school, teen, childlike or "daughter" wording for them.
(6) Children: no romance, nude or sexual content involves a child or happens in a scene a child is in.
(7) Heat: mode "steamy" shows nothing nude, no sex act and has no "Sex act:" line; mode "drama" has no sexual or nude content; mode "explicit" has a "Sex act:" line for every entry of its "Source sex acts" line.
(8) Nothing dropped: every major event of the original story appears in some episode of some drama; a character keeps the same name and age in every file.
(9) Drama boundaries: each drama ends at the turning point that resolves its central conflict (a drama of 12 episodes may instead end at the turning point that resolves the most); a drama whose first episode goes on in the previous drama's scene, act or moment (the same encounter continued, the climax of the same act, its aftermath) is a defect - it belongs to the previous drama.
(10) Length: every "Format:" line states the episode length L and the total; L is 45-120 s (a length over 120 s per episode is a defect); when the original story or a user wish states a total, drama 1's total is not above its upper end (unless 2 episodes of 45 s, the 120 s cap, or a dense source force it, which a "Changes from the source" line says), no turning point merges more than 3 source events (a dense source gets ceil(events / 3) episodes of 45 s and a longer total instead), and events merged to fit it are named in a "Changes from the source" line.
For (5) and (6), unsure = not satisfied.

Satisfied only if (1) to (10) all hold. Otherwise not satisfied and, in the reason, list EVERY failing item: its number, the quoted words of the input and a one-line fix. Never list anything not covered by an item.

# Adaptation:

{input}

# Original story:

{workspace.story.plot}
````

## 3. Create the task

One `create_task` call, exactly:

```
create_task({ id: "adapt_story", requires_tasks: [], requires_artifacts: [], title: "Micro-drama adaptation",
  description: "Decompose the story into vertical micro-dramas", agent: <writer>,
  policies: ["microdrama_review"], prompt: <below>,
  output_artifact_name: "story_adaptation",
  output_artifact_description: "Micro-drama series: series.md + one drama_<k>.md per drama",
  output_files: [] })
```

prompt (VERBATIM; `{workspace.*}` placeholders stay literal; when the user stated wishes —
number of dramas or episodes, length, platform — replace the word `none` after `User wishes:`
with their own words):
````
Load and use skill: microdrama-rewrite

Workspace content policy (nudity): {workspace.contentPolicy.nudity} (allowed, anything else = forbidden).
Workspace style: {workspace.story.style}
Workspace setting: {workspace.story.setting}
User wishes: none
Deliverable: artifact `story_adaptation` (open: files are registered as you write them): `series.md` and one `drama_<k>.md` per drama (k = 1, 2, ...), plain Markdown, never PDF or DOCX. Do not force the story into one drama.

Source story:
{workspace.story.plot}
````

## 4. Reply

Concise (see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`):
`Scheduled the micro-drama adaptation: task://<id>.` and "Review `series.md` and the dramas; then
tell me which drama to produce here." Only when `create_task` succeeded: when `create_policy` or
`create_task` returned an error, nothing was scheduled - say "The micro-drama adaptation was NOT
scheduled:" and quote the error.

## 5. Adopt (after the person approves)

Only when the person explicitly says which drama to use (and `story_adaptation` is approved). One
drama -> `drama_1.md`; several -> ask which one, never pick yourself:

```
update_story({ plot_from_artifact: { artifact: "story_adaptation", file: "drama_<k>.md" } })
```

Never call it on your own. Report the result in one line (the original is kept; "restore the
original story" undoes it) and list `staleTasks`: they keep the old story until `reset_task`.
Then: "Run pre-production to produce drama <k>." This workspace produces ONE drama; for another
drama the person opens a new workspace whose plot is that drama file. Refused (not approved /
unreadable) -> relay the error, change nothing.

## 6. Refusal fallback (once, only on the person's yes)

Read the failure reason with `task_info`. A reason starting `PREFLIGHT:` is the skill's own
content rule (a minor, non-consent, incest, no story): report it in one line, offer NO retry and
never reword the story. Otherwise, when the reason is a REFUSAL of the content (the writer declined
the story; not a technical error): writer models differ in what adult fiction they accept. Tell the
person in two lines which writer refused and its reason (quoted, shortened), and offer ONE retry
with the `screenwriter` agent (only if it is not the agent that refused). Only on their explicit
yes:

1. `remove_task({ task_id: "adapt_story" })` (removes the refused task and its empty artifact).
2. The same `create_task` call as section 3, with `agent` = the `screenwriter` agent.

A second refusal -> stop and report both reasons; never retry again, never rewrite the source.
