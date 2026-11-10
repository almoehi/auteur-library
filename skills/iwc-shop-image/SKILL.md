---
name: iwc-shop-image
description: >
  Use when the task prompt says "Load and use skill: iwc-shop-image", or asks for candidate store
  thumbnails (shop images) of an episode: 3 candidates, each a picture composed from the
  finished character / outfit / set designs (flux2_reference_compose_nsfw) plus its hook-word
  lettering set in code in the sandbox (Pillow), following the play's "7. Shop image" brief and rules.
  Do NOT invoke for designs (plan-designs), storyboards (storyboard-scene) or loop clips
  (iwc-loop-clip), or the GIF teaser.
agentType: worker
---

# Shop image: 3 candidate store thumbnails

**Catalog tools:** none in this task (no `search_catalog` / `use_reference`, no catalog outfit or
`garment_reference`).

Each candidate is ONE render plus code:
1. **Picture pass:** `wf_flux2_reference_compose_nsfw` builds the frame from the episode's finished designs (identity, outfit, set). This pass has no text.
2. **Lettering (sandbox, no render):** the hook word and the watermark are set in Python (Pillow) on the base - exact spelling, the picture untouched, no extra agent steps. (An AI type pass is only for a device graphic that code cannot draw.)

**Step budget.** The agent loop has a hard step limit; in the first pilot four candidates with image checks and retries used it up before any lettering was set, so the task handed over with untyped bases. Keep to: one batched `draft_prompts_batch` for all picture passes, one render response, ONE `describe_image` per base, the lettering of ALL bases in ONE `sandbox_exec`, one `describe_image` on the contact sheet. Write `candidates.md` as you go (plan first, then append each result), so a hand-over always shows what exists.

A person picks the winner. Everything specific comes from the episode's play. Read `workflow-calling-conventions` (`load_skill`) and `get_workflow_instructions` for the compose workflow once. Prompts come from `draft_prompt` / `draft_prompts_batch` with `prompt-writer-flux2`. Pass `prompt_ids`, never typed text.

## 1. Preflight

Fields:

| Field | Default | What it is |
|---|---|---|
| `inputs` | `episode_inputs` | holds `play.md` |
| `plan` | `visual_plan` | |
| `character` | `character_vesper` | the character design (its `view_face`, `full_body_shot`) |
| `design_plan` | `design_plan` | `design_plan.json`: the keys of the dynamic designs - `outfit_<slug>_<look>` per wardrobe row, `location_<room>` per room |
| `candidates` | 3 | allowed range 2-3 |
| `persona` | `Vesper Vex` | the watermark text |

Steps:
1. `read_artifact` `play.md`. Section **7. Shop image** gives the episode's brief, hook words, CTA labels, palette, device and teaser cuts, followed by the generic rules (Thumbnail, Animated teaser). Section **1** gives the featured kinks.
2. `read_artifact` the visual plan (`visual_plan.json`): its sets (with `room_id` and `view`), outfits and kink vocabulary; and `design_plan.json`: the design key of each outfit (`outfit_<slug>_<outfit id>`) and room (`location_<room_id>`). Use only designs that are finished (`artifact_index`: approved); a corner of a shared room is that location's published view named by the set's `view`.
3. Call `task_failed(reason)` when:
   - section 7 is missing ("rebuild play.md with make_play.py --shop-only");
   - the workflow tool is missing ("load workflow flux2_reference_compose_nsfw");
   - the character design has no published `full_body_shot`.

## 2. Plan the candidates (write `candidates.md` BEFORE rendering)

Candidate 1 follows the brief exactly. Each further candidate changes ONE or TWO axes the rules allow, so the person compares real alternatives:

| # | Changes |
|---|---|
| 1 | the brief as written; the first hook word |
| 2 | another hook word, plus a tighter crop or the other focal point the rules allow (face with eye contact vs the body focus the kink sells) |
| 3 | the text on the other side and the face on the other side, plus a different light accent within the palette |
| 4 | the genre device or a collage variant, only when the rules allow one for this concept; otherwise a third framing (e.g. a low or high camera taken from the plan's camera vocabulary) |

Per candidate, write down:
- the hook word, used verbatim from section 7;
- the framing: distance, angle, focal point, eye line;
- the pose;
- the outfit (an outfit design key from `design_plan.json`, or the character's nude base) and the set (a location design key, optionally one of its published views, or "studio backdrop in the palette" when no set fits the brief);
- the palette and light;
- the device;
- the text side (the side opposite her face) and the free area left for it;
- the watermark corner.

Check every candidate against the Thumbnail rules and record the result per rule. A candidate that breaks a rule is redesigned before rendering, not flagged afterwards.

## 3. Picture pass (per candidate)

1. `draft_prompt` for `wf_flux2_reference_compose_nsfw`. The `context` is the candidate's plan block plus these locks:
   - 16:9 landscape store thumbnail;
   - the subject fills at least half the frame;
   - the planned side (about a third of the frame) is calm and darker, with no props or busy detail, so the type pass can place large letters there;
   - NO text, letters, logos or watermark anywhere in this pass;
   - one woman only (mirrored or ghosted copies of her only when the device asks for it);
   - saturated light in the palette, darker surroundings, rim light on her;
   - explicitness within what a store thumbnail allows (the play's kink is shown by pose, outfit, item or device, not by explicit detail).
2. Render inputs:
   - `reference_image_1` = the set's published view that matches the planned camera (else its main plate; omit for a studio backdrop);
   - next reference = the character's `view_face` (else `full_body_shot`);
   - next reference = the outfit's standard view closest to the pose (`view_front` / `view_profile`, else its `full_body_shot`).

   Find the files in each design's `design.json` `published.outputs`. Number the Pictures only over the references you supply. Set `width` 1664 and `height` 928 (16:9, multiples of 16). Add LoRAs only when the pose needs one.
3. Save the output as `/workspace/<artifact id>/candidate_<N>_base.png`.
4. Run `describe_image` on the base with these questions:
   - Is the face the same person as the character's face view?
   - Is the planned text side free and calm?
   - Is there any text or extra person?
   - Is the kink readable?

   Retry ONLY a hard miss (another person, text or a logo in the picture, a different face) - once, with the finding in `context` and a fresh seed. A soft miss (a busy text side, a weak kink cue) is noted in `candidates.md` and the base is lettered anyway; the person decides.

## 4. Lettering (sandbox, all candidates in one call)

One `sandbox_exec` (python3 with Pillow): fetch the font once -
`curl -sL -o /workspace/Anton-Regular.ttf https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf`
(Open Font License) - then for every base:
- **Text:** the candidate's hook word, ALL CAPS, at most two lines (break given explicitly, e.g. `LOOP` / `WITH ME`).
- **Fit:** the largest font size at which the block is at most 34 % of the frame width and 62 % of its height.
- **Place:** on the planned text side (opposite her face), 5 % from the edge, block centred at 56 % of the height.
- **Style:** white fill, a dark stroke (`#140a19`, width = size / 18), and a glow in the episode hue (the same text drawn with a stroke three times as wide in the hue, Gaussian-blurred by size / 7, composited twice under the fill).
- **Watermark:** `persona` in the same font at 1/30 of the height, white at 65 % opacity with a thin dark stroke, in the planned corner.
- **Save:** `candidate_<N>.png` (full size) and `candidate_<N>_400.png` (400x225).

The reference implementation is `projects/iwantclips/workspace/letter_shop_image.py` (auteur-content-lake); the sandbox code does the same. Never call a lettering check "pass" before the lettered file exists.

## 5. Store-size previews and reply

In the sandbox:
1. Resize each candidate to 400x225 (`candidate_<N>_400.png`), the size buyers actually see.
2. Build `contact_sheet.png` with all candidates at 400x225 side by side, each labelled with its number and hook word.
3. Run `describe_image` on the contact sheet: at that size, is each hook word readable and the kink clear in one second?

Append the results to `candidates.md`. Per candidate, record:
- the hook word, framing, device and designs used;
- the rules check, done on the FINISHED files (the plan section only says "planned");
- the base check result and any retry;
- files.

End with a short recommendation of which candidate to pick and why. Copy the recommended candidate to `shop_image.png` and its 400x225 version to `shop_image_400.png`.

## 6. Hand-over (llm+hitl)

This task ends with a person's review. They keep the recommendation or name another candidate, or ask for "redo N: <note>". On a redo, re-run step 3 and the lettering for that candidate only, at most 2 redos, and re-copy the pick. In the final reply, list each file with one line and every check that missed and what was retried; then `task_complete`.
