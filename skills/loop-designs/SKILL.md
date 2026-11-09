---
name: loop-designs
description: >
  Use when the task prompt says "Load and use skill: loop-designs" with a `step:` of create,
  outfits or storyboards - the references for loopable cam-style clips: creating the character
  and set designs (finished by a person in the design studio), one reference per outfit of the
  visual plan, and per clip the loop anchor keyframe plus its storyboard entry. Do NOT invoke for planning the clips
  (play-preproduction), rendering video (loop-clip), or the film pipeline's designs and
  storyboards (design-asset, plan-designs, storyboard-scene).
agentType: worker
---

# Loop designs: character, outfits, anchor keyframes

ONE adult woman, the play's character, always the same identity, in ONE room. Every image is a
reference for the loop clips. Read `workflow-calling-conventions` (`load_skill`) once: prompt route
(`draft_prompt` → `prompt_ids`), `artifact://` inputs, `check_take`, retry once. Prompts come
from the prompt writer of the workflow's family (`prompt-writer-krea2`). Leave seeds, steps and
cfg at the defaults.

## 1. Preflight

Fields: `step` (`create` | `outfits` | `storyboards`), `inputs` (default `episode_inputs`),
`plan` (default `visual_plan`), `character` (default `character_vesper`, a design artifact),
Set designs: `location_<set id>` (one per set of the plan; a plan without `sets` - older
plans - uses the task's `location` field for every clip). Outfit designs: `outfit_vesper_<outfit id>`.
Resolve keys with `artifact_index`; `read_artifact` what the step needs; `task_failed(reason)`
naming a missing artifact or file. A finished design's files: `full_body_shot.<ext>` (the main
picture), its standard views (made by the finish, no sheet: a character front / profile / back /
face, an outfit front / profile / back) and its named pose views (`view_<view id>.<ext>`), plus
`design.json` (its `published.outputs` lists every view with id, label and file - read the files
from there, never guess names). Older designs may have `sheet.<ext>`, `view_1..6` and
`portrait.<ext>` instead.

The persona and look come from play.md section 3 (Character); the identity comes from the
character design's pictures - the picture wins over the words for the face.

## 2. step: create → two designs for a person to finish

Create both with `create_design`, then `task_complete` (a person curates and finishes them in the
design studio; never render them yourself):

1. **Character** - seeded with the inputs' `character.png`. That picture should be a clean
   full-body reference (no props, no gloves, plain background): props in the seed picture leak
   into every outfit edit and keyframe built on it (first pilot: a riding crop and latex gloves
   from the avatar). If it is not clean, say so in `designs.md` so the person adds a clean take
   before finishing. `create_design({ kind: "character", display_name: "Goonette Vesper Vex",
   key_slug: "vesper", start: "references", character_type: <the tool's adult-woman type or
   "adult woman">, reference_images: ["artifact://<inputs>/character.png"] })` (a reference-started
   design takes no attributes).
   **Face view:** the inputs' `face.png` is her face reference. It must become the design's tagged
   `face` view BEFORE the finish, so the finish publishes it instead of rendering one (a rendered
   face view drifts: in the pilot it aged and widened her face, and every clip reads the face view
   as her identity). Tell the person in `designs.md`: upload `face.png` as a take tagged `face`
   (studio Views panel, "Use as view" > face, or `workspace/designs.py upload <design> face.png
   --view face`), then finish with `character.png` as the primary.
   The brand details are the character's MARKS: the finish's describe step reads them from the
   picture and verifies each one, every outfit edit then keeps them unchanged, and an outfit
   accessory of the same kind on the same body part is never added over them. The describe step
   words them loosely ("thin black choker", "pendant with a geometric design"), so `designs.md`
   gives the person the `marks` attribute to set after the finish. A person's mark replaces a
   described one only at the same kind, part AND side, and the describe step picks the side
   differently from run to run (`both` in one pilot finish, `unsided` in the next): read the
   finished `design.json` `description.marks` and give each entry the stored side, e.g.
   `jewellery | neck | unsided | wide black velvet choker; jewellery | neck | unsided | small silver
   key pendant on a thin chain; jewellery | fingers | both | violet nail polish`. One attribute mark
   at a place replaces every described mark of that kind there (also a spurious "silver choker
   chain").
2. **Sets** - one location design per set in `visual_plan.json` (`sets[]`):
   `create_design({ kind: "location", display_name: "<set name>", key_slug: "<set id>",
   start: "attributes", initial_drafts: 2, attributes: [...] })` with `space` (interior /
   exterior) and the kind's description attributes filled from the set's `description`. The plan
   decides the room - a plain bedroom when the script stays in a bedroom. Describe it concretely
   either way, or it renders flat (first pilot: "a bedroom with a lamp" gave bare walls and had to
   be edited): the stage surface, the furniture she uses (`furniture[]` - sturdy, fully visible,
   with free space around it so she can lie, kneel, straddle or grind on it), the light (key
   light, practicals, colour accents), 3-5 background props kept off the stage's front edge, the
   set elements the plan's `kinks[]` ask for, the items placed for the clips (`items_placed`:
   where they lie, within reach of the stage), the mood; empty (no people); seen as a
   vertical 9:16 webcam view at the most common camera of the set's clips. A set whose clips use a
   very different camera (floor level, overhead, the far side) lists that view in the kind's
   `views` attribute (e.g. "from the floor at the foot of the bed, looking up"), so the room exists
   from that angle; the keyframe then uses that view as Picture 1. Use only the attribute keys the
   tool accepts.

Write `designs.md` into your output artifact (`/workspace/<artifact id>/designs.md`): every
design key (character and sets), @names and task ids, and the line "Finish both designs in the studio before the
outfits step is released." Then `task_complete`.

## 3. step: outfits → one outfit DESIGN per outfit (a person reviews and finishes them)

For every outfit in `visual_plan.json` (`outfits[]`) create a design, then `task_complete`; never
render them yourself (the studio's design agent drafts them as image edits of the character's
published full-body shot once the character design is finished - an outfit design waits for it):

`create_design({ kind: "outfit", display_name: "<outfit name>", key_slug: "vesper_<outfit id>",
start: "attributes", initial_drafts: 2, links: [{ role: "character", key: "<character>" }],
attributes: [...] })` - the kind's attribute keys only (read the tool); describe the garments,
colours and materials exactly as the plan does (a garment list where the kind has one). The brand
details (black velvet choker, small silver key on a thin chain, violet nails) are the character's
marks: they stay on her in every outfit by themselves, so never list them as outfit garments or
accessories (another neck piece would be dropped against the choker mark anyway); a `nude`
outfit is "nude" - the marks remain. Name the details that reinforce the
episode's kinks (the plan's `kinks[]` outfit details and the outfit's own description). Worn
accessories (collar, heels, gloves, cuffs) are part of the outfit; never put a HANDHELD item
(key in the hand, crop, toy, cash) into an outfit or character design - it would leak into every
render built on it; handheld items appear only in the keyframes. Put the outfit's `pose_views` from the
plan into the `views` attribute (separated by `;`, never `,`; each label at most 80 characters,
body only), so the studio makes them as named pose views; the standard front / profile / back
views are made by the finish anyway. LoRAs: none.

Write `outfits.md` into your output artifact: per outfit its plan id, design key, @name, task id
and the pose views it needs, and the line "Make the pose views (Views) and finish every outfit
design in the studio (the finish renders the standard views) before the storyboards step is
released; a design finished without them gets them with Add views." Then `task_complete`.

## 4. step: storyboards → artifact `loop_storyboards`

Per clip in `visual_plan.json` (`clips[]`):

1. **Anchor keyframe** `anchor_clip<N>.png` = the FIRST and LAST frame of the loop, composed
   INTO the clip's set: `wf_flux2_reference_compose_nsfw` with
   - `reference_image_1` = the clip's set: the set design's named view matching the clip's
     `camera` when it has one, else its `full_body_shot.<ext>` (Picture 1);
   - `reference_image_2` = the outfit design's named pose view for the clip's `body_pose`
     (`artifact://outfit_vesper_<outfit_id>/<view file>`, found in its `design.json`
     `published.outputs` by the view label; Picture 2, her in the outfit and the pose);
   - `reference_image_3` = the character design's face view (else its portrait, else its
     `full_body_shot`; Picture 3, her face).
   A missing pose view or face view: `task_failed("<design>: missing view <label>")` - never
   compose a pose from words alone (the first pilot: faces drifted and a kneeling pose became
   sitting on the floor).
   Prompt: the woman from Picture 2 (face of Picture 3) in the set of Picture 1, posed as the
   catalog `Body pose:` `<body_pose>` - state it limb by limb (support, facing, arms, legs, head) -
   ON / AGAINST the furniture of the clip's `furniture_use` (where her body touches it: seat,
   edge, backrest, mattress), plus the clip's `anchor_pose` detail, the kink cue of its
   `reinforcement` that shows at the anchor (the key pendant lifted, stockinged feet toward the
   lens, …), the clip's `items` at their anchor places (in her hand, beside her knee - described
   by words; one item per hand at most) and the clip's `camera` (angle, height relative to her,
   distance), vertical 9:16 locked-off webcam view (`width` 720, `height` 1280); she looks into
   the lens unless the camera's angle or the kink makes her look elsewhere; keep identity, outfit,
   brand details and the set. `check_take` (request = body pose + framing + outfit + set +
   identity, references = the three pictures), retry once.
2. **Storyboard entry** in `storyboard.md`, one block per clip:

```
## Clip <N> - <phase title>
Anchor: anchor_clip<N>.png (body pose: <body_pose>, pose view: <view label>)
Covers audio: <start>-<end> (<groups>), repeats ≈ <x>
Outfit: <outfit_id> (outfit_vesper_<id> design)
Duration: <loop_seconds> s
Camera: locked off, <angle>, <height>, <distance>, no move - why: <camera.why>
Items: <item> at <at_anchor> - <use> (back at its place at the end)
Kink focus: <kink_focus> - outfit: <…>; action: <…>; set: <…>
Furniture: <furniture_use>
Action:
- 0-15 %: …
- 15-80 %: … (tease / reveal / self touch, the focus body part toward the lens)
- 80-100 %: returns to the anchor pose, garments as at the start - the last frame equals the first
Sound: no dialogue, lips closed; soft breathing, room tone
LoRAs: <names from lora_index that fit the act, or none>
Loop risk: <what could break the seam and how the action avoids it>
```

Write text files in SMALL pieces (a tool call with too-long arguments arrives cut off and
empty): `sandbox_write_file` the first block, then append one block per clip with `sandbox_exec`
(`cat >> storyboard.md <<'EOF' … EOF`); every write under ~2500 characters. Same for
`storyboard.json`: compact JSON, one clip appended per `sandbox_exec` python3 call, validated at
the end with `python3 -m json.tool`.

Every clip uses its own set from the plan (`set_id`); clips of the same set share its lighting. Also write
`storyboard.json` (`clips[]`: clip, anchor file, outfit_id, duration_seconds, action, loras).

## 5. Hand-over (llm+hitl)

These tasks end with a person's review. In the final reply list each file with one line, every
take that missed a check and what was retried; then `task_complete`. Never render video here.
