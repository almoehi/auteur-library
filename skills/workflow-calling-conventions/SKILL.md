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

A ⟦ref:r12.key⟧ in your earlier tool calls stands for a value you sent (call r12, argument key); to reuse it exactly pass the ⟦ref:…⟧ token (alone or inside a longer text) — never retype or copy a shortened value. A ref names an EARLIER call (never the call you are making) and reuses its value unchanged: to send a new or corrected value — e.g. a plan fixed after a refusal — write it out in full. Refs stay valid for the whole conversation; if one is refused, the error says why and lists the refs that exist.

## Correct sequence

- `read_artifact` the work spec → curate LoRAs ("Curated LoRAs") → write the
  prompts ("Prompts") → `wf_xxx` → check every take → `task_complete` only after every required
  call is done (never after only reading).
- One render per call. Leave `seed`, `cfg` / guidance and steps at the workflow defaults unless
  the task says otherwise; a re-render gets a fresh seed by leaving `seed` unset.
- A failed call: re-read `get_workflow_instructions`, fix the call, retry once.

## Curated LoRAs

THE definition of LoRA selection; `storyboard-scene` (per shot) and `design-asset` (per design) run it as their FIRST step and refer here.

- **When**: before the first `wf_xxx` render of a shot or design, call `lora_index()` once (reuse the result for the whole scene / design). It lists each LoRA's name, description, `modelFamily`, strength and triggers (some catalogs add `sexActs` / `sexPositions` hints). Infer from each LoRA's NAME and DESCRIPTION what it serves; tags, when present, are only hints. Skip only when the catalog is empty.
- **How many**: pick the up to 8 LoRAs most relevant to THIS shot / design, ranked most relevant first (fewer is fine; never pad). A LoRA is relevant when it serves anything the shot or design shows: the production's style and look (`{workspace.story.plot}`), the characters pictured (character LoRAs), outfits, clothing and fabrics, props, the location or environment, camera / lens / lighting / film look, poses and actions, anatomy and body detail, skin and realism - and an explicit act or position only when the shot has one (acts are one category among many). Examples: a noir style LoRA for a moody street scene, a character LoRA for a pictured heroine, a trench-coat clothing LoRA, an anamorphic-lens camera LoRA, a blowjob LoRA for a shot with that act. Rank what the frame depends on most first; also weigh trigger words that appear in the prompt. Obey each LoRA's description (usage rules, required phrases, strength).
- **Which**: exact catalog names only, never invented. Mix families freely: the render keeps those of the workflow's `modelFamily` (storyboards: the server; design renders: you). Do not worry about a LoRA the workflow already loads in its own graph: the render binding skips it (and a repeated one) automatically. Never add a LoRA just because the catalog has one.
- **Pass it on every render**: the curated list goes on EVERY `wf_xxx` render of the shot / design (first renders, retries, edits, variations), not only the first. For a `wf_xxx` call: the curated LoRAs of the tool's family in rank order, one per LoRA slot (`lora_1`, `style_lora`, …), up to the number of slots; strength only when the task or catalog sets one; the `design.json.loras` that match the family are part of the list: the person's explicit studio picks rank FIRST, then your curated additions in rank order (the same order the server uses for storyboard shots: picks, optional act safety net, curated list; the port cap cuts your curated tail first). A family mismatch is rejected at call time. An unset slot is always safe.
- **Act shots** (a shot or render with a sex act): the workflow has few LoRA slots (often 2) and only the top of the list loads, so rank for the act first: (1) the LoRA serving that act / position (a specific one, else a general sex LoRA of the family), (2) the anatomy / detail LoRA of the body parts in contact (e.g. a penis or vulva detail LoRA for penetration, oral or genital contact), then (3) everything else - realism, skin, face / expression (orgasm face, ahegao), style, camera. Never rank realism or a face LoRA above the act and anatomy LoRAs of an act shot; per family, the first two of this order are what renders.
- **Trigger words**: drafted prompt -> in the writer's `context`; the person's verbatim text -> at its very start or end.
- **Storyboard shots**: write the list on the shot's `LoRAs:` line (rule R15: at most 8, none twice, catalog names; any LoRA relevant to the shot - style, characters, outfits, camera, pose, act ...); the server loads it on every take render and repair of the shot in rank order (family + catalog filter, de-duplication, cut to the workflow's LoRA ports). Only when the catalog tags LoRAs with `sexActs` / `sexPositions` does the server also add a matching act LoRA if none of the listed ones covers the shot's act or position.

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

- Check every design-asset take you render with `check_take(file, request, references?)`, a
  round's checks in one response. Never re-check a take you did not render (studio buttons and
  the storyboard drafts are rendered and checked by the server); sandbox-derived files (crop,
  conversion, sheet) are not checked. Storyboard shot takes are never rendered or checked by an
  agent (`storyboard-scene`: `draft_storyboard`).
  - `request` (required): what the take had to show — the brief lines or the person's
    instruction; designs by display name, never keys.
  - `references`: `[{ref, label}]` of the reference pictures the render bound (label = the
    design's display name).
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

## What a take is judged against

Every take check (`check_take`, the studio's and the storyboard drafts' server checks) judges only
what is visible, against what the take was asked to show — so plan and prompt for these:
- ONE moment of the action, never a sequence; one continuous image (no panels or collage).
- Exactly the people the request lists: nobody extra, nobody missing; each one recognisably the
  named person. A POV owner appears only as their own body seen from their eyes (hands, forearms,
  lap, thighs, knees, feet; lying also the chest from above), never their face, in the sex, skin
  tone and garments the request states for the viewer.
- The named setting and props exactly (a lounger is not a chair, the named place is no other).
- Every listed outfit visible as described; no garment missing or replaced.
- A sex act / position line: its participants, positions and contact points as stated.
- The requested medium and style; nothing added that the request does not ask for.

## Reference plan

- Before every `wf_*` call with reference images, one entry per bound image:
  `<port> = <design key> (full_body_shot) - <who/what>`, FIRST in the writer's `context` (no
  writer call: state them in your message before the call).
- The plan, `image_inputs` and the call's image ports are the same images; the drafted prompt names
  no Picture beyond the bound images.
- One image per person in frame, from that person's own design; in `context` per person the
  outfit in words and the identity cue of their Picture line ("the wife from Picture 2, short
  wavy blonde hair, navy suit"; no cue → from the design digest). Never tell two similar-looking
  people apart by name only. An image whose subject is not in the shot is never bound.

## References by extent

Also the background for the entity lines of a storyboard plan (`storyboard-scene`: the server
applies these rules when it binds the pictures of a shot; you only write the shot lines).

Looks in `Outfits:` pairs (the single definition): `<c>:<outfit key>` = that outfit design;
`<c>:nude` = nude, the character design is the picture; `<c>:none` = no outfit design for this
look, the character design is the picture — a creature / animal wearing nothing (the scene list's
`none`), or in a shot list a clothed look without an outfit design, whose garments the shot's
`Pose:` states (keep them in the prompt).

For each character in a shot's `Characters:`, by their `Visible:` extent:
- `full figure` / `upper body` / `face` / `back`: the outfit design's full-body shot (the character
  design's for `:nude` / `:none` / no outfit design).
- `limbs` (anyone seen only by their limbs; another person's `lower body` is a figure, pictured like `upper body`) and the POV owner at any extent (lying:
  `upper body` = the chest from above): WORDS only — no picture, no `[[key]]`, no name; the POV owner is "the viewer" ("the viewer's own forearms and
  hands at the lower edge"), in the prompt and in the shot's `Action:` / `Blocking:` / `Pose:` /
  `Frame:` lines (the server copies those verbatim into the prompt; a name there summons the whole
  person).
- Never add a body part `Visible:` does not list. A character not in `Characters:` gets no image
  and is never mentioned as a figure in the prompt.

## Anchor (Picture 1) by intent

- EDIT: the image being edited is Picture 1, references follow.
- COMPOSE (new scene): the environment is Picture 1, then people / objects by priority; never an
  outfit or character image. A reference-to-image prompt describes the scene and names the
  pictures by label.
- Workflow choice follows the intent: an in-place editor (`i2i`, e.g. `qwen_image_multi_edit`) changes
  things INSIDE Picture 1's frame (colour, material, object, garment, expression, lighting, small pose)
  and keeps its geometry. A new angle, viewpoint, re-framing or "show another part of the place" is a
  new composition: use a reference-compose (`ref2i`) or text-to-image workflow, never an editor.

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
- NSFW LoRAs: curated as in "Curated LoRAs" (`design.json.loras` count; the act LoRA, when the shot has an act, ranks among the first). A nudity EDIT (undressing, a swap step
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
- **Act / position LoRAs**: curate them like any LoRA ("Curated LoRAs": infer from name and description which ones serve the act and position, rank them high) and name the act and position EXACTLY from the lists above. If the catalog tags LoRAs with `sexActs` / `sexPositions`, the server adds a matching tagged LoRA to storyboard takes when your `LoRAs:` line has none that covers the shot.
- An older shot list may carry `Act: <free text>`: read it as the sex act, with no position; never write it.
