---
name: storyboard-scene
description: >
  Use when your task is a storyboard design — keyed `storyboard_scene_<n>` (e.g.
  "storyboard_scene_3") — or the task prompt says "storyboard scene 3", "draft the keyframes
  for scene 2", "write the shot list and render a keyframe per shot", or the person asks in the
  storyboard chat for a change ("add a close-up", "swap shots 2 and 3", "another angle for
  shot 4"). Produces `shotlist.md` (one section per shot) and one keyframe image per shot
  (`take_<shotId>-draft-<n>.<ext>`, `take_<shotId>-<slug>.<ext>`) inside the design artifact
  for the person to pick from in the studio. Do NOT invoke for shooting or rendering video
  clips, character / outfit / location designs (that is design-asset), writing `design.json`,
  or publishing or finishing a design.
agentType: worker
---

# Storyboard Scene — shot list and one keyframe per shot

A storyboard is a design (an `llm+hitl` task plus one open artifact, both keyed
`storyboard_scene_<n>`) for ONE scene. The **web studio owns the design**: its `design.json`
and every published file (`primary.*`, `sheet.*`, `view_*`, `frame_*`, the published copy of
`shotlist.md`). Your job: write `shotlist.md`, then put keyframe **images** into the artifact;
the studio shows each `take_<shotId>-…` file as a take of that shot and the person picks one
per shot. The finished storyboard (`shotlist.md` + `frame_1…N` in shot order) feeds the
`shoot-scene-task` / `shoot-single-scene` skills.

## Hard rules

1. **Never write, overwrite, rename or delete `design.json`** — read it only
   (`read_artifact(artifactId="<task id>")`).
2. **Never write published names** (`primary.*`, `sheet.*`, `view_*`, `frame_*`) — "Finish
   design" creates them.
3. **File names are flat** (no `/`). The only non-image file you write is `shotlist.md`.
   Keyframes: initial drafts `take_<shotId>-draft-<n>.<ext>` (n = 1 … drafts per shot);
   chat-phase takes `take_<shotId>-<slug>.<ext>` (slug = a few lowercase hyphenated words
   naming the content or the change, `[a-z0-9]+(-[a-z0-9]+)*`, no `_`, never generic or
   numbered). `<shotId>` = `s<scene>-<nn>` (`s3-01`, two digits). Names are unique: append
   `-2`, `-3` … when the name exists in the artifact OR was used earlier in this conversation,
   including takes the person discarded. Never overwrite an existing file; every render is a
   new take.
4. **Write into this artifact's own directory** (`/workspace/<artifact id>/<file name>`).
   Generate images with `wf_*` tools via `output_ports` (render provenance is kept); read
   source takes via `artifact://<artifact id>/<file>` (`sandbox_fetch`, `describe_image`),
   never copied URLs. Every file in the directory is registered at the end of the turn.
5. **One render per take.** Leave `seed` at its default; never request batches.
6. **Never name a workflow from memory.** Choose among the `wf_*` tools you actually have, by
   capability (see "Choosing the workflow").
7. **Write `shotlist.md` in ONE go.** Compose the complete shotlist (all shots, final ids,
   order and fields) in reasoning first, then ONE `sandbox_write_file`. Never write a partial or
   draft shotlist and never rewrite it within the same drafting run (the runtime's write-once
   guard for output files blocks a rewrite and ends the attempt). In chat iteration, a change to
   the shots is exactly ONE full rewrite. Write every other file once, complete, too.
8. **Never end the drafting turn early.** No text-only reply and no `task_complete` before
   every shot of the shotlist has its draft render(s) dispatched; `shotlist.md` alone is not a
   deliverable (a storyboard handed over with 0 takes is a failure).

## Phase 1 — Preflight and shot list (LLM phase)

1. `read_artifact(artifactId="<task id>")` → the artifact **id** (for output paths), the
   existing files, and `design.json` (attributes `scene` and optional `notes`, drafts per
   shot = `initialDrafts` (default 1), the `links`: `location`, `characters`, `outfits`).
2. Preflight — if any of these fails do **not** guess: render nothing and call
   `task_complete` with a summary that says exactly what is missing:
   - the scene number (`scene` attribute or the task id `storyboard_scene_<n>`);
   - the `scene_list` artifact is readable and has a row for that scene;
   - each linked design is readable (`read_artifact` of its key) and has a published
     `primary.<ext>` (its `artifact://<id>/primary.<ext>`) — the linked designs finished
     before this task started, so this normally holds;
   - at least one `wf_*` tool that can render an image (see "Choosing the workflow").
3. Read the scene's row of `scene_list` (location, time of day, summary, characters present,
   outfits as `<character_slug>:<look_slug>`). Read the `screenplay` artifact too if it
   exists, and use the scene's slice of it for action, dialogue beats and mood. Read each
   linked design's published description (via `read_artifact` of its key) to keep looks
   consistent. Map
   `<character_slug>:<look_slug>` to the linked design keys `character_<slug>` and
   `outfit_<slug>_<look>` (the keys in `design.json.links` are the truth; names may carry a
   suffix).
4. Compose the whole shot list first, then write `/workspace/<artifact id>/shotlist.md` with ONE
   write (hard rule 7) — **one section per shot**, exactly:

```
# Scene <n> shot list

## s3-01 — Short title
Action: what is VISIBLE in the frame, in one or two sentences
Camera: shot size, angle, lens feel, movement (e.g. "wide, eye level, slow push-in")
Characters: mira, jonas        (character slugs, comma-separated, or "none")
Outfits: mira:raincoat; jonas:work_suit      (<character>:<look> pairs, "; "-separated, or "none")
Duration: 5
```

   **`Action` = what is visible in the frame** — subjects, their positions, pose, expression and
   objects. No plot, no reasons or motives, no dialogue, no camera motion (motion belongs to
   shooting, not to a still keyframe; the `Camera` line gives the framing).
   Good: `Action: Mira stands at the harbor rail, hood up, looking out to sea; Jonas sits on a crate behind her, a thermos in his hand.`
   Bad: `Action: Mira, who just learned the ship is late, slowly walks to the rail and says "He lied to us" as the camera pushes in.`

   4–10 shots are typical; cover the WHOLE action of the scene in order, one clear beat per
   shot, an establishing shot first when the location is not yet known. `Duration` = whole
   seconds (3–10). Shot ids are `s<scene>-<nn>`, consecutive from 01, never renumbered later
   except by a rewrite the person asked for. The `Characters`/`Outfits` lines name only
   characters/looks that are linked designs (others: mention them in `Action` only).

## Phase 2 — Render the initial drafts (fan out across ALL shots)

Follow the **Prompt route** rule of `workflow-calling-conventions` (`load_skill` it) for every prompted `wf_*` call and pass `prompt_route`. Typical here: initial keyframes from the shot list are rewritten; a short user-typed chat edit ("add a close-up") on an edit workflow is a verbatim candidate.

Never loop shot by shot: single `draft_prompt` / `review_prompt` / `enhance_prompt` calls are
serialized by the runtime (one LLM round each), the `*_prompts_batch` tools run their items in
parallel. Four steps, about 3–4 LLM rounds for prompting plus one for renders, independent of
the shot count:

1. **Bind references for every shot** (reasoning only, no tool calls): per shot choose the
   workflow ("Choosing the workflow"), the reference list in priority order and the slot map.
2. **ONE drafting round**: `draft_prompts_batch(workflow_name, items=[{context}, …])`, one
   item per shot ("Prompt"). `workflow_name` is per CALL: group the shots by their chosen
   workflow (normally all share one) and issue one batch per workflow, all in the SAME
   response. No item limit is declared; if a call is refused for size, split into the fewest
   batches, again all in one response.
3. **Review once**: at most ONE `review_prompts_batch` over all shots' prompts (per workflow
   group, same response). Then, only for the items it flagged, at most ONE
   `enhance_prompts_batch` with the review feedback as `additional_context` (or a second
   `draft_prompts_batch` for flagged items). Never call the single-item tools for several
   shots; do not loop once a prompt passes.
4. **ONE render round**: issue ALL `wf_*` calls for ALL shots — `initialDrafts` per shot ×
   shots — in ONE response ("Render").

### Choosing the workflow (capability, never name)

Read each candidate `wf_*` tool's description and `get_workflow_instructions(<tool>)`. **Prefer
what the manifest declares**: `capabilities` (`multi-reference-edit` marks a multi-image edit)
and, per image input, `reference_role` (`subject` / `garment` / `background` / `reference`:
for a keyframe the location (`background`) is the anchor and goes first, then the main
character's outfit, further characters/outfits in `garment` / `reference`) and `label` (the exact name the prompt must use
for that image, e.g. "Picture 2"). When they are absent, infer from the descriptions and slot
order as follows: the workflow type (t2i, i2i, …), the number, kind and ORDER of image inputs, which ports are
required, the port descriptions (they say how the prompt must refer to each image:
"Picture 1", "Figure 1", "image 2" …), declared capabilities if present. Never pick by a
tool's name or family.

Keyframe references in **priority order** (a storyboard keyframe is COMPOSE intent — see
"Anchor (Picture 1) by intent" of `workflow-calling-conventions`: the location is the anchor,
Picture 1):
1. the location primary,
2. the outfit primary of the shot's main character (`outfit_…/primary.<ext>`; the character's
   own primary when the character has no outfit design),
3. further outfits / characters, in order of presence in the shot.

Choose:
- **Multi-image i2i** — among the i2i workflows whose required ports you can fill, the one
  with the MOST image slots able to hold references (image inputs, not masks/depth/control).
  Fewer slots than references → drop from the end of the priority list. Fill the slots in the
  order the port descriptions imply, the location first (the anchor).
- **Single-image i2i only** → edit the location primary into the scene (the anchor; the
  characters live in the prompt text only).
- **No i2i workflow** (or its required ports cannot be filled) → a t2i workflow, with the
  characters, outfits and location described fully in the prompt.
A workflow with a required input you cannot supply (a mask, a pose, a prior clip) is
disqualified. Remember the choice and say it in the summary, with the reason.

### Prompt

Each `draft_prompts_batch` item's `context` (one item per shot) holds: the shot's Action and Camera, the
location, time of day and mood, each present character with outfit (from the linked
descriptions), and the goal: *a single cinematic keyframe of this shot, consistent with the
reference images — keep every person's face, hair, build and outfit and the place's look
exactly; compose as the camera line says; no text, no captions, no panels*. Include the slot map: name
each image by its port label as the chosen workflow's prompt must ("Picture 1 is Mira in her
raincoat, Picture 2 is the harbor …" using the port descriptions' wording). The prompt writer applies the
model-family skill (`prompt-writer-<family>`) automatically; without the batch tool,
`load_skill("prompt-writer-<family>")` and follow it. If `design.json.loras` lists LoRAs, pass
those of the same model family on the lora ports.

### Render

Issue the render calls of ALL shots in ONE response (they run concurrently, subject to the
stack's render parallelism); never wait for one shot before issuing the next. Drafts per shot =
`initialDrafts` — never more:

```
wf_<tool>(prompt_positive="<prompt>", <image ports with artifact:// refs>, …,
  output_ports={"<primary output port>": "/workspace/<artifact id>/take_s3-01-draft-<n>.png"})
```

Same prompt for all drafts of a shot; the random seed varies them. A failed draft fails only
its own take: re-read the workflow instructions, fix the call, retry that draft once (same file
name); if it fails again, leave it (the studio shows a failed take with Retry) and report it.

## Check, retry once, suggest

For EVERY take you render (initial drafts and chat takes) follow "Check, retry once, suggest" of
`workflow-calling-conventions` (rubric, retry rule, `suggest_edit`). Storyboard naming of the
retry take: base + `-r2` (`take_s3-02-wide-rain.png` -> `take_s3-02-wide-rain-r2.png`;
`take_s3-01-draft-1.png` -> `take_s3-01-draft-1-r2.png`).

## Phase 3 — Hand over

Audit before completing:

- [ ] `shotlist.md` written exactly once (no partial draft, no rewrite in this run)
- [ ] every shot id of the shotlist has >= 1 dispatched `take_<shotId>-draft-<k>` render
- [ ] `shotlist.md` exists, every shot has `## <shotId> — <title>` plus `Action`, `Camera`,
      `Characters`, `Outfits`, `Duration`; ids consecutive `s<scene>-01…`
- [ ] every shot has `take_<shotId>-draft-<n>.<ext>` for n = 1 … drafts per shot (re-read the
      artifact), except drafts that failed twice (name them)
- [ ] no other file written; `design.json` untouched; no published names
- [ ] every rendered take was checked with `describe_image`; at most one retry per take, named
      `<base>-r2`; `suggest_edit` called exactly for takes whose retry also missed
      (see `workflow-calling-conventions`)
- [ ] drafts came from `wf_*` renders
- [ ] batch pattern used: prompts came from `draft_prompts_batch` (one item per shot, one call
      per workflow group), at most one `review_prompts_batch` and one `enhance_prompts_batch`,
      NO single `draft_prompt` / `review_prompt` / `enhance_prompt` call for several shots, and
      all renders of all shots went out in one response

Then `task_complete(summary="Storyboard scene <n>: <N> shots, <drafts> draft(s) each with
<workflow type, slot count and why>; failed: …")`. This hands the design to the person; it
does **not** finish it.

## Phase 4 — Chat (HITL phase)

For each message:

1. `read_artifact` again; read `design.json` for takes, primary/selection and discarded
   takes. A take you rendered earlier that is gone was discarded on purpose — never re-render
   it or its name.
2. **Shot list changes** (add / remove / reorder / retitle / change action or camera): rewrite
   `shotlist.md` as a whole file (a new write of the same name is the one allowed overwrite),
   renumbering shot ids consecutively `s<scene>-01…` in the new order. Existing takes keep
   their file names — tell the person that takes of a moved/renumbered shot stay under their
   old shot id and must be re-rendered if the numbering matters, offer to render the new
   shot's keyframe, and render nothing unless asked or the shot is new (a new shot gets its
   drafts as in Phase 2, named with its new id; several new shots → one batch).
3. **Re-render a shot** ("another angle for shot 4", "make it night"): one new take
   `take_<shotId>-<slug>.<ext>`. Source: the take the person names, else the shot's selected
   take, else its newest take. A change to an existing take is an **i2i edit with that take as
   the FIRST image** (+ further references the workflow can hold, by the priority list);
   "start over" re-renders from the references as in Phase 2. Choose the workflow by
   capability as above; write the instruction with `draft_prompts_batch` — a message touching
   SEVERAL shots ("redo shots 2 and 5") is ONE batch (one item per take) and ONE response of
   renders; a single `draft_prompt` only when it touches exactly one shot.
4. Render only what THIS message asks — one take unless it names a count. Check every take you
   render (drafts and chat takes) as in "Check, retry once, suggest" above. Reply with the new
   file name(s) and one line on what changed, then stop.
5. Never pick a primary / frame, discard takes, write descriptions, or finish the design —
   point the person to the studio controls (★ / 🗑 / Finish design).
