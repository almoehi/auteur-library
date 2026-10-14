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
`shotlist.md`). You write `shotlist.md`, then put keyframe **images** into the artifact; the
studio shows each `take_<shotId>-…` file as a take of that shot and the person picks one per
shot. Keep visible replies concise: see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`.

## Hard rules

1. **Never write, overwrite, rename or delete `design.json`** — read it only.
2. **Never write published names** (`primary.*`, `sheet.*`, `view_*`, `frame_*`).
3. **File names are flat** (no `/`). The only non-image file you write is `shotlist.md`.
   Initial drafts `take_<shotId>-draft-<n>.<ext>` (n = 1 … drafts per shot); chat-phase takes
   `take_<shotId>-<slug>.<ext>` (slug = a few lowercase hyphenated words naming the content or
   change, `[a-z0-9]+(-[a-z0-9]+)*`, no `_`, never generic or numbered). `<shotId>` =
   `s<scene>-<nn>` (`s3-01`). Names are unique: append `-2`, `-3` … when the name exists in the
   artifact OR was used earlier in this conversation (including discarded takes). Never
   overwrite; every render is a new take.
4. **Write into this artifact's directory** (`/workspace/<artifact id>/<file name>`). Generate
   images with `wf_*` tools via `output_ports`; read source takes via
   `artifact://<artifact id>/<file>`, never copied URLs.
5. **One render per take.** Leave `seed` at its default; never request batches.
6. **Never name a workflow from memory** — choose among the `wf_*` tools you have, by capability.
7. **Write `shotlist.md` in ONE go**: compose the complete shotlist silently first, then ONE
   `sandbox_write_file`. Never a partial/draft shotlist, never a rewrite in the same drafting
   run (the write-once guard ends the attempt). A chat change to the shots = exactly ONE full
   rewrite. Write every other file once, complete.
8. **Never end the drafting turn early.** No text-only reply and no `task_complete` before every
   shot has its draft render(s) dispatched; a storyboard with 0 takes is a failure.

## Reading inputs (compact, once)

- `read_artifact(artifactId="<task id>")` ONCE → artifact **id**, existing files, `design.json`
  (`scene`, optional `notes`, drafts per shot = `initialDrafts` (default 1), `links`: `location`,
  `characters`, `outfits`).
- Read `scene_list` (the scene's row: location, time of day, summary, characters, outfits as
  `<character_slug>:<look_slug>`; below the table the scene's **Beats**: per beat the action,
  framing, camera move and continuity) and the `screenplay` (if it exists; use the scene's slice for
  action and mood) exactly ONCE each. Never re-read them later.
- Read each linked design ONCE, compactly: `read_artifact` of a design returns a server-side
  compact digest in later turns; use only `artifact_index` / the published description. Never
  copy or restate design documents, takes history or file lists.
- Map `<character_slug>:<look_slug>` to the linked keys `character_<slug>` / `outfit_<slug>_<look>`
  (keys in `design.json.links` are the truth). A pair with no linked outfit design is a character's
  BASE LOOK (read `base_look` from `design_plan.json` when available): the linked character design
  covers it - use the character's primary for it and do not report it as missing.
- **Preflight** — if any fails do not guess: render nothing, `task_complete` saying exactly what
  is missing: the scene number (`scene` attribute or task id); a readable `scene_list` with a row
  for it; each linked design readable with a published `primary.<ext>`
  (`artifact://<id>/primary.<ext>`); at least one image-rendering `wf_*` tool.

## Phase 1 — Shot list

ONE write of `/workspace/<artifact id>/shotlist.md`, one section per shot, exactly:

```
# Scene <n> shot list

## s3-01 — Short title
Action: what is VISIBLE in the frame, in one or two sentences
Camera: KEYFRAME framing - shot size, angle, lens feel of the still image (e.g. "wide, eye level")
Movement: the camera move of the VIDEO clip of this shot (e.g. "slow push-in", "pan left", "hold")
Characters: mira, jonas        (character slugs, comma-separated, or "none")
Outfits: mira:raincoat; jonas:work_suit      (<character>:<look> pairs, "; "-separated, or "none")
Duration: 5
Transition: cut — new moment, first shot of the scene
```

**`Movement`** = the camera move of the video clip shot from this frame, taken from the shot's
beat in the scene list's **Beats** (one shot per beat, in order; the beat's `Camera move` verbatim,
e.g. `slow push-in`, `pan left`, `handheld drift`). Write `hold` ONLY when the beat asks for
stillness. When the scene list has no Beats (an older list), derive a fitting move from the
action and mood; never default to `static`/`hold`. `Camera` stays the framing of the keyframe
IMAGE (a still has no movement): do not put a move into `Camera`, and keyframe prompts use
`Camera`, never `Movement`.

**`Transition`** = how this shot relates to the PREVIOUS shot, taken from the shot's beat
`Continuity` in the scene list: `Transition: continue — <short reason>` when the beat is
`continuous` (the action carries straight on in the same setup: same place, same moment, same
people) **even when the framing changes** (wide -> close-up of the same moment); `Transition:
cut — <short reason>` when the beat is a `new moment` (new moment, place or subject, or an
insert). The first shot is always `cut`. A scene list without `Continuity` (older list): decide
with the same rule from the actions and say so in the reason. The shoot skills take this line as
given, so it is decided here once.

**`Action` = what is visible** — subjects, positions, pose, expression, objects. No plot, motives,
dialogue or camera motion.
Good: `Action: Mira stands at the harbor rail, hood up, looking out to sea; Jonas sits on a crate behind her.`
Bad: `Action: Mira, who just learned the ship is late, walks to the rail and says "He lied to us" as the camera pushes in.`

4–10 shots, covering the WHOLE action in order, one beat per shot, an establishing shot first when
the location is not yet known. `Duration` = whole seconds (3–10). Ids consecutive from 01, never
renumbered except by a rewrite the person asked for. `Characters` / `Outfits` name only linked
designs (others: in `Action` only).

## Phase 2 — Render the initial drafts (all shots, batched)

Follow the **Prompt route** of `workflow-calling-conventions` for every prompted `wf_*` call
(pass `prompt_route`): initial keyframes from the shot list are `rewritten`; a short user-typed
chat edit on an edit workflow is a verbatim candidate. Never loop shot by shot; single
`draft_prompt` / `review_prompt` / `enhance_prompt` calls are serialized, the `*_prompts_batch`
tools run in parallel.

1. **Bind references for every shot** silently: choose the workflow, the reference list in
   priority order and the slot map.
2. **EXACTLY ONE `draft_prompts_batch` call per workflow, in ONE round** (one item per shot;
   one call per workflow; shots may use different workflows, see "Choosing the workflow"). Never repeat it per shot subset or retry
   round for shots already drafted. If refused for size, split into the fewest batches, all in
   the same response.
3. **Review at most once**: ONE `review_prompts_batch` over all prompts, then only for flagged
   items ONE `enhance_prompts_batch` with the feedback as `additional_context`. No single-item
   tools for several shots.
4. **ONE render round**: ALL `wf_*` calls for ALL shots (`initialDrafts` per shot, never more) in
   ONE response; never wait for one shot before issuing the next:

```
wf_<tool>(prompt_positive="<prompt>", <image ports with artifact:// refs>, …,
  output_ports={"<primary output port>": "/workspace/<artifact id>/take_s3-01-draft-<n>.png"})
```

Same prompt for all drafts of a shot (the random seed varies them). A failed draft fails only
its own take: re-read the workflow instructions, fix the call, retry that draft once (same file
name); if it fails again leave it (the studio shows a failed take with Retry) and report it.

### Choosing the workflow (capability, never name)

Read each candidate's description and `get_workflow_instructions(<tool>)`. Prefer the manifest:
`capabilities` (`multi-reference-edit`), per image input `reference_role` and `label` (the exact
name the prompt must use, e.g. "Picture 2"); else infer from workflow type, number/kind/ORDER of
image inputs, required ports and port descriptions. Never pick by a tool's name or family.

References in priority order (keyframe = COMPOSE intent, location is the anchor, Picture 1; see
"Anchor (Picture 1) by intent"): 1. location primary; 2. outfit primary of the shot's main
character (its own primary if no outfit design: the character design shows the base look); 3. further outfits / characters by presence.

- **Reference-to-image (ref2i)**: preferred - composes a NEW frame from the references (location =
  Picture 1), any camera.
- **Multi-image i2i edit**: for shots matching the location plate's framing; the fillable i2i
  workflow with the MOST image slots able to hold references (not masks/depth/control); fewer
  slots → drop from the end of the list.
- **Single-image i2i only** → edit the location primary into the scene (characters in the prompt).
- **No usable i2i** → t2i with characters, outfits and location described in the prompt.
- **INTERIM**: when no ref2i workflow exists and the shot's Camera differs from the plate's
  framing, use the text-to-image workflow with a rich description of place, characters and
  outfits instead of an edit.

Several workflows may be used within one scene (chosen per shot). The workflow type is read from
the `wf_*` tool description, which ends with the type display name (e.g. "(reference-to-image)").

A workflow with a required input you cannot supply (mask, pose, prior clip) is disqualified. Say
the choice and reason in the summary.

### Prompt `context` (per shot, SHORT)

Shot text (Action + Camera - never Movement: a keyframe is a still), image labels (slot map by port label: "Picture 1 is the harbor,
Picture 2 is Mira"), one style line (`{workspace.story.plot}` medium/style verbatim, see "Medium /
style is kept"), and the goal: *one cinematic keyframe of this shot, consistent with the
reference images; compose as the camera line says; no text, captions or panels*. Never restate
what the reference images show or the design descriptions. The prompt writer applies
`prompt-writer-<family>` itself. Pass same-family `design.json.loras` on the lora ports.

### Check, retry once, suggest

For EVERY take you render follow "Check, retry once, suggest" of `workflow-calling-conventions`.
Retry naming: base + `-r2` (`take_s3-02-wide-rain.png` -> `take_s3-02-wide-rain-r2.png`;
`take_s3-01-draft-1.png` -> `take_s3-01-draft-1-r2.png`).

## Phase 3 — Hand over

Audit before completing:

- [ ] `shotlist.md` written exactly once; every shot has `## <shotId> — <title>` plus `Action`,
      `Camera`, `Movement`, `Characters`, `Outfits`, `Duration`, `Transition`; ids consecutive `s<scene>-01…`;
      every `Movement` comes from its beat (`hold` only when the beat asks for stillness);
      every `Transition` is `continue` or `cut` with a reason, from the beat's continuity, the first is `cut`
- [ ] every shot has `take_<shotId>-draft-<n>.<ext>` for n = 1 … drafts per shot (re-read the
      artifact), except drafts that failed twice (name them); all from `wf_*` renders
- [ ] no other file written; `design.json` untouched; no published names
- [ ] every take checked; at most one retry per take (`<base>-r2`); `suggest_edit` exactly for
      takes whose retry also missed
- [ ] one `draft_prompts_batch` per workflow, at most one review and one enhance batch, all
      renders in one response

Then `task_complete(summary="Storyboard scene <n>: <N> shots drafted; failed: …")` (1-3 lines; no
workflow types or slot counts). This hands the design to the person; it does
**not** finish it.

## Phase 4 — Chat (HITL phase)

For each message:

1. `read_artifact` again; read `design.json` for takes, primary/selection and discarded takes. A
   take you rendered earlier that is gone was discarded on purpose — never re-render it or its name.
2. **Shot list changes** (add / remove / reorder / retitle / change action, camera, movement or transition): rewrite
   `shotlist.md` as a whole file (the one allowed overwrite), ids renumbered consecutively; re-derive `Transition` of every shot whose predecessor changed (the first stays `cut`).
   Existing takes keep their file names — say takes of a renumbered shot stay under their old id;
   render nothing unless asked or the shot is new (new shots get drafts as in Phase 2, one batch).
3. **Re-render a shot** ("another angle for shot 4"): one new take `take_<shotId>-<slug>.<ext>`
   from the take the person names, else the selected, else the newest. A change to an existing
   take is an **i2i edit with that take as the FIRST image** (+ references by priority); "start
   over" re-renders from the references as in Phase 2. SEVERAL shots in one message = ONE
   `draft_prompts_batch` and ONE response of renders; a single `draft_prompt` only for one shot.
4. Render only what THIS message asks (one take unless it names a count); check every take. Reply
   with one short line (new take name(s), what changed), then stop.
5. Never pick a primary / frame, discard takes, write descriptions, or finish the design — point
   the person to the studio controls (★ / 🗑 / Finish design).
