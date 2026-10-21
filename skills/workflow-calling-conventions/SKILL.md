---
name: workflow-calling-conventions
description: "Producing output files with wf_xxx workflow tools — call sequence, prompt route (pass the person's own words through or draft with the prompt writer and pass prompt_ids), LoRAs, references, take checks, NSFW workflows and the explicit acts vocabulary."
agentType: all
---

# Rendering Output Files with Workflow Tools

Rules for every task that renders media with `wf_xxx` tools. Worked call shapes (only if unclear):
`load_skill workflow-calling-examples`.

## Concise replies and task/artifact URIs

- Replies and `task_complete` summaries: 1–4 short lines; tasks and artifacts as `task://<id>` /
  `artifact://<id>[/<file>]` (the system prompt's reply rules apply).

## Correct sequence

- `read_artifact` the work spec → `lora_index()` once if the tool has LoRA slots → write the
  prompts ("Prompts") → `wf_xxx` → check every take → `task_complete` only after every required
  call is done (never after only reading).
- One render per call. Leave `seed`, `cfg` / guidance and steps at the workflow defaults unless
  the task says otherwise; a re-render gets a fresh seed by leaving `seed` unset.
- A failed call: re-read `get_workflow_instructions`, fix the call, retry once.

## LoRA lookup and loading

- Only when the `wf_xxx` tool exposes LoRA slots (`lora_1`, `style_lora`, …); else never call
  `lora_index`.
- Pick a LoRA only when it fits the prompt and its `modelFamily` matches the workflow's; exact
  catalog name; strength only when the task or catalog sets one.
- Trigger words: drafted prompt → in the writer's `context`; the person's verbatim text → at its
  very start or end.
- Obey each LoRA's description (usage rules, required phrases, strength).

## Prompts

### Prompt route — code decides, you do not state it

There is no `prompt_route` argument: code routes every prompted wf_xxx call. Its prompt is accepted only when it is (a) the unchanged OUTPUT of a prompt-writer tool of this task for the SAME workflow, or (b) the person's own text word for word (found unchanged in your task prompt or a person's chat message). Anything else — a prompt you typed or edited, or the person's text plus an added sentence — is refused (naming workflow and port): run draft_prompt and pass its result's `prompt_id` as `prompt_ids: { "<prompt port>": "<prompt_id>" }` (preferred - code inserts the exact stored text), else its prompt unchanged. A prompt passed as text must be its decoded text exactly as returned: the JSON escapes you see in a tool result (`\"`, `\n`) are not part of the prompt - a quote is `"`, not `\"`. A refused prompt you did not edit almost always carries such escapes; re-sending it unchanged is refused again - pass its `prompt_id` instead. To add words, put them into the prompt writer's `context` and draft again - never edit the prompt.

- **PASS THROUGH** only when ALL hold: it comes from the person (chat or studio); an explicit, concrete, short, unambiguous instruction that needs nothing adapted. Pass it VERBATIM and add nothing, not even a sentence naming the images. Do NOT call draft_prompt, review_prompt or enhance_prompt.
- **REWRITE with the prompt writer** for everything else (agent-derived briefs, long or vague requests, generation from text or references, any call with images, variations, retries). Pass the person's text in `instruction` (kept LOCKED). `instruction` is ONLY for a person's own explicit correction or request (chat edit, re-run instructions) - never a goal line, a skill's boilerplate or your own paraphrase: whatever sits in `instruction` is pasted into the prompt. Put briefs, shot text and the goal line in `context`. Pass the call's images as `image_inputs` (`[{ "port": "<input>", "ref": "artifact://<id>/<file>" }]`): code writes the "Picture N is <name>" lines, never write or number pictures yourself. Pass wording that must survive as `verbatim_phrases`: code appends any the writer drops.
- **Explicit overrides**: "use my words exactly" means pass through; "improve the prompt" means rewrite.
- **Re-run instructions** ("## Instructions for this run" in your task prompt): they override the brief wherever they conflict; pass them VERBATIM as `instruction` of every prompt-writer call (never only inside `context`). The ONE exception to the bounded flow below: with the previous render's prompt at hand, revise it with enhance_prompt (original_prompt = that prompt, `instruction`) INSTEAD of draft_prompt, then review_prompt once (same `instruction`) and enhance_prompt once more only on "significant" (at most 2 enhances + 1 review).
- Bounded flow per prompt: draft once → review at most once → enhance once only on
  "significant" → pass the result's `prompt_id`. Never review or enhance the same prompt again.
- Video: pass `duration_seconds` to the prompt tools equal to the `wf_xxx` duration parameter.
- Batch tools (`draft_prompts_batch`, `review_prompts_batch`, `enhance_prompts_batch`): `items` is
  a real JSON array; on partial failure retry only the failed items.
- A task created with `prompt_writer: "skip"`, or "use this prompt verbatim": pass the text byte
  for byte, no prompt tools (only a required LoRA trigger may be added at the start or end).

## Render size and output files

- No `width` / `height` by default (the render profile decides); `is_portrait` (`true` /
  `false`) turns the size to that orientation.
- Outputs route to the declared file named like the output port; else pass
  `output_ports={"<port>": "/workspace/<artifact id>/<file>"}`.

## Artifact-backed inputs

- Pass `artifact://<artifactId>/<file>` directly as an input value; never copy or retype a URL.

## Medium / style is kept

- The medium / style of `{workspace.story.plot}` and the design brief goes VERBATIM into the
  `context` of every prompt-writer call. A take in another medium is a miss.

## Checks that gate the task

- `run_checks` runs the kickoff's checks on the current files and tool calls (capped per attempt)
  — call it before an expensive step. Fix every listed item in one rewrite; each rejected
  `run_checks` grants one rewrite of a written output file.

## Check, retry once, suggest

- Check every take you render with `check_take(file, request, references?)`, a round's checks
  in one response.
  - `request` (required): what the take had to show — the shot / brief lines or the person's
    instruction; designs by display name, never keys.
  - `references`: `[{ref, label}]` of the reference pictures the render bound (label = the
    design's display name, or e.g. "previous shot's take").
- Read the result: `verdict` `match` | `miss` | `unchecked`; the findings (rated severe / major /
  minor when rated); `fix` = the correction. `unchecked` = the judge failed: say so, never count
  it as a match.
- A miss with a severe or major finding (or an unrated miss): ONE re-render, a new take named
  base + `-r2` from the same source, the missed take kept:
  - new prompt via the prompt writer (original `context` + `fix`; the person's instruction stays
    `instruction`), fresh seed;
  - identity drift: move that person's picture to a higher slot / use their full-body shot;
  - extra or missing people: state the exact head count.
- The `-r2` also misses: `suggest_edit(file, instruction, reason)` on the better take
  (instruction ≤ ~1000 chars, reason one line), report both and stop. Never re-render a `-r2`.

## Reference plan

- Before every `wf_*` call with reference images, one entry per bound image:
  `<port> = <design key> (<full_body_shot|sheet>) - <who/what>` (POV owner without a published
  sheet: `(full_body_shot, no sheet)`), FIRST in the writer's `context`.
- The plan, `image_inputs` and the call's image ports are the same images.
- One image per person in frame, from that person's own design; in `context` per person the
  outfit in words and the identity cue of their Picture line ("the wife from Picture 2, short
  wavy blonde hair, navy suit"; no cue → from the design digest).

## Anchor (Picture 1) by intent

- EDIT: the image being edited is Picture 1, references follow.
- COMPOSE (new scene): the environment is Picture 1, then people / objects by priority; never an
  outfit or character image. A reference-to-image prompt describes the scene and names the
  pictures by label.

## NSFW-marked workflows

- A workflow whose description starts with **[nsfw]** renders nudity and sex. Choose by
  `{workspace.contentPolicy.nudity}` (absent = forbidden), never by name.
- `forbidden`, or any depicted minor: never an [nsfw] workflow.
- `allowed` and the frame shows adult nudity or sex: prefer the [nsfw] workflow of the SAME
  capability (capability first).
- Explicit acts: an [nsfw] reference-to-image workflow. Without one: (1) the act with the [nsfw]
  text-to-image workflow + act LoRA; (2) the [nsfw] multi-reference edit, one person per call
  (Picture 1 = the act frame, Picture 2 = their full-body shot; "Replace the woman in image 1
  with the adult woman from image 2 … keep the poses, camera and room").
- NSFW LoRAs: `design.json.loras` first, then `lora_index`.
- Call every depicted person an adult in the prompt.

## Explicit acts and positions

The single source of the names used by every skill, scene list, shot list and check. Applies ONLY when `{workspace.contentPolicy.nudity}` is `allowed` and no depicted character is a minor; otherwise there is no such field.

- **Fields**: the scene list Beats columns `Sex act` and `Sex position`; the shot list lines `Sex act:` and `Sex position:`.
- **Value**: `none` (no sexual act), or `<name>[ + <name>]*[: <detail>]`. `<name>` is lower case, exactly as listed below, or `other (<plain words>)` for an act / position the list lacks. `Sex act` may combine acts with ` + ` (`blowjob + fingering`); `Sex position` names exactly ONE position (a position change is a new beat / shot). `<detail>` (optional) = who does what to whom and the contact points, in plain explicit words (`Sex position: doggy style: Lena on hands and knees on the bed, Jonas kneeling behind her`).
- **Pairing**: `Sex act` is `none` exactly when `Sex position` is `none`.
- **Not a sex act**: nudity alone, undressing, posing nude, kissing, hugging, caressing, touching. Nudity is the look (`<character>:nude` in Outfits), touch is `Contact` / `Blocking`; such beats and shots have `none`.
- **Sex acts**: vaginal penetration, anal penetration, double penetration, blowjob, deepthroat, cunnilingus, 69, rimming, handjob, fingering, titjob, footjob, masturbation, cumshot.
- **Sex positions**: missionary, doggy style, cowgirl, reverse cowgirl, spooning, prone bone, lotus, lap sitting, standing face to face, standing from behind, kneeling, squatting, face sitting, lying on back, lying on side, 69.
- An older shot list may carry `Act: <free text>`: read it as the sex act, with no position; never write it.
