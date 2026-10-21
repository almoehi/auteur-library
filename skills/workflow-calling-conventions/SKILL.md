---
name: workflow-calling-conventions
description: "Producing output files with wf_xxx workflow tools — call sequence, prompt route (pass the person's own words through or draft with the prompt writer and pass prompt_ids), LoRAs, references, take checks, NSFW workflows and the explicit acts vocabulary."
agentType: all
---

# Rendering Output Files with Workflow Tools

Rules for every task that renders media with `wf_xxx` tools. Worked call shapes (only if unclear):
`load_skill workflow-calling-examples`.

## Concise replies and task/artifact URIs

- Replies and `task_complete` summaries: 1–4 short lines — what was done, what is next or needed.
- Never restate plans, file lists, workflow or skill names, slot counts, design descriptions or
  tool results unless asked. Think silently; write only decisions.
- Mention tasks and artifacts as `task://<id>` / `artifact://<id>` (`artifact://<id>/<file>` for
  one file) with the runtime id; never a bare key or file name.

## Reusing earlier values

A ⟦ref:r12.key⟧ in your earlier tool calls stands for a value you sent (call r12, argument key); to reuse it exactly pass the ⟦ref:…⟧ token (alone or inside a longer text) — never retype or copy a shortened value. Refs stay valid for the whole conversation; if one is refused, the error lists the refs that exist.

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
  catalog name; strength only when the task or catalog sets one. Never invent a LoRA name; a
  family mismatch is rejected at call time.
- An unset slot is always safe; never add a LoRA just because the catalog has one.
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

- No `width` / `height` by default (the render profile decides); set them only when the story or
  shot needs a different format (they then override the profile's size).
- `is_portrait` (`true` / `false`) turns the size to that orientation. Omit it on image-to-video
  calls unless the shot's format differs from the keyframe: without it the size follows the
  first-frame image, so a clip never crops or stretches its keyframe.
- Outputs route to the declared file named like the output port; else pass
  `output_ports={"<port>": "/workspace/<artifact id>/<file>"}`.

## Artifact-backed inputs

- Pass `artifact://<artifactId>/<file>` directly as an input value. Do NOT call
  `get_artifact_url` or download into the sandbox for this. Every file-URL tool
  (`describe_image`, `sandbox_fetch`, `get_video_info`, `wf_xxx` ports) accepts the same
  `artifact://` ref.
- Never copy, retype or shorten a URL (a dropped character gives a 403 that looks like expiry);
  for shell commands paste only the short `url` of `get_artifact_url` (`curl -L`). Plain http(s)
  is for external sources only.

## Medium / style is kept

- The medium / style of `{workspace.story.plot}` and the design brief goes VERBATIM into the
  `context` of every prompt-writer call. A take in another medium is a miss.

## Checks that gate the task

- Read the kickoff's checks before you start. `run_checks` runs them on the current files and
  tool calls — call it before an expensive step. It does NOT complete the task; at most 6 calls
  per attempt (each rejection allows one rewrite of the files it judged). Fix every listed item in
  one rewrite.

## Check, retry once, suggest

- Check every take you render with `check_take(file, request, references?)`, a round's checks
  in one response. Never re-check a take you did not render (studio buttons are checked by the
  server); sandbox-derived files (crop, conversion, sheet) are not checked.
  - `request` (required): what the take had to show — the shot / brief lines or the person's
    instruction; designs by display name, never keys.
  - `references`: `[{ref, label}]` of the reference pictures the render bound (label = the
    design's display name, or e.g. "previous shot's take").
- Read the result: `verdict` `match` | `miss` | `unchecked`; the findings (rated severe / major /
  minor when rated); `fix` = the correction. `unchecked` = the judge failed: say so, never count
  it as a match.
- A miss with a severe or major finding (or an unrated miss): ONE re-render, a new take named
  base + `-r2` from the same source, the missed take kept:
  - new prompt via the prompt writer: original `context` + `fix`, medium / style and every lock
    kept verbatim, only what the finding names changed; the person's instruction stays
    `instruction`; fresh seed;
  - identity drift: move that person's picture to an earlier image port after the anchor / use
    their full-body shot;
  - extra or missing people: state the exact head count;
  - several re-renders: ONE `draft_prompts_batch` and ONE render response.
- The `-r2` also misses: `suggest_edit(file, instruction, reason)` on the better take
  (instruction ≤ ~1000 chars, reason one line; fire-and-forget), report both and stop. Never
  re-render a `-r2`.
- A suggested fix the person sends from the Edit box is their instruction: a pass-through
  candidate ("Prompt route").

## Reference plan

- Before every `wf_*` call with reference images, one entry per bound image:
  `<port> = <design key> (<full_body_shot|sheet>) - <who/what>` (POV owner without a published
  sheet: `(full_body_shot, no sheet)`), FIRST in the writer's `context` (no writer call: state
  them in your message before the call).
- The plan, `image_inputs` and the call's image ports are the same images; the drafted prompt names
  no Picture beyond the bound images.
- One image per person in frame, from that person's own design; in `context` per person the
  outfit in words and the identity cue of their Picture line ("the wife from Picture 2, short
  wavy blonde hair, navy suit"; no cue → from the design digest). Never tell two similar-looking
  people apart by name only. An image whose subject is not in the shot is never bound.

## References by extent

Looks in `Outfits:` pairs (the single definition): `<c>:<outfit key>` = that outfit design;
`<c>:nude` = nude, the character design is the picture; `<c>:none` = no outfit design for this
look, the character design is the picture — a creature / animal wearing nothing (the scene list's
`none`), or in a shot list a clothed look without an outfit design, whose garments the shot's
`Pose:` states (keep them in the prompt).

For each character in a shot's `Characters:`, by their `Visible:` extent:
- `full figure` / `upper body` / `face` / `back`: the outfit design's full-body shot (the character
  design's for `:nude` / `:none` / no outfit design).
- `limbs` / `lower body` of the POV owner (`POV:` line): that design's `sheet` (its POV
  <seated|lying> tile; "use only its POV <posture> tile: <detail> seen from their own eyes, never
  their face or torso" in `context`); no published sheet → `(full_body_shot, no sheet)` with the
  phrase below.
- `limbs` / `lower body` of anyone else: their full-body shot, plus "only their <detail> are in
  frame, never their face or the rest of their body" in `context`.
- Never add a body part `Visible:` does not list. A character not in `Characters:` gets no image
  and is never mentioned as a figure in the prompt.

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
- Explicit acts: an [nsfw] reference-to-image workflow (place = Picture 1, people after, a general
  NSFW LoRA). An [nsfw] multi-reference EDIT cannot produce an act (people keep their reference
  poses). Without a reference-to-image one, two steps:
  - (1) the act with the [nsfw] text-to-image workflow + the act LoRA, the room of the location
    described;
  - (2) the [nsfw] multi-reference edit, ONE person per call (Picture 1 = the act frame / previous
    output, Picture 2 = that person's full-body shot): "Replace the woman in image 1 with the adult
    woman from image 2 … Leave the man unchanged. Keep the exact poses, camera angle, framing and
    room of image 1." Never pass two people as one picture in a swap.
  - Act LoRA on step 1; anatomy LoRAs on both steps. Frame people large (small figures barely
    take the identity).
- NSFW LoRAs: `design.json.loras` first, then `lora_index`. A nudity EDIT (undressing, a swap step
  showing a nude body) uses the catalog's image-edit nudity LoRA of the edit workflow's family
  (solo nudity only, never for an act).
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
