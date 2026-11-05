---
name: prompt-writer-flux2
description: >
  Trigger when asked to write, enhance, or review a prompt for a FLUX.2 workflow (model family
  flux2), above all an image edit — e.g. "dress her in the coat from the reference photo",
  "write an edit instruction for the FLUX.2 edit workflow", "swap the handbag using figure 2",
  "make the jacket red in this take". Produces a concise, instruction-style image-edit prompt
  that names the inputs as "Figure 1" / "Figure 2" and states what to keep, and a short,
  importance-ordered storyboard keyframe prompt for the FLUX.2 Klein reference-compose workflows.
  Do NOT invoke for Qwen-Image-Edit (qwenimage), KREA-2, FLUX 3 video, or any video/animation
  workflow.
agentType: worker,render
---

# FLUX.2 — Edit Instruction Writer

When the task carries a `Production context` block (`Setting:` / `Style:`), obey it in every prompt: the setting decides which wardrobe, props, devices, vehicles and architecture may appear (nothing of another era), the style is the look - state it verbatim as the medium / film look and never contradict it.

## When this skill applies

Use this skill for workflows with `model_family: flux2` — primarily **image edits**
(`workflow_type: i2i`, FLUX.2 Klein: a subject photo plus one reference photo). The prompt is one **instruction**; there is no negative prompt.

For a FLUX.2 **text-to-image** workflow (no image inputs) see "t2i mode" at the end.

---

## Iron Laws — Non-Negotiable

1. **Instruction, not description.** Tell the model what to change; everything unstated is
   generally preserved.
2. **Reference inputs as `Figure 1` / `Figure 2`.** `Figure 1` = the subject photo (first image
   input, e.g. `subject_image`), `Figure 2` = the reference photo (second input, e.g.
   `garment_reference_image`). Describing a photo by its content ("the jacket in the second
   photo") also works — but pick one style and stay consistent within the instruction.
3. **Most important first.** Earlier words carry more weight: Subject + Action → Source/Detail →
   Context/Style → Locks.
4. **Say what you want, not what you don't.** There is no negative prompt. Write "keep the
   background unchanged", "sharp focus" — never "don't change the background", "no blur".
5. **One coherent change per instruction.** Stacking unrelated edits (garment + background +
   accessory) is unreliable; if unavoidable, list them as short clauses in priority order.
6. **Preserve identity explicitly.** For a character design, add a keep-clause for face,
   hair and body shape (and pose when the request leaves it alone). Keep-clauses name only what must
   stay. When the request changes the camera, angle, viewpoint, framing or composition, never write
   "keep everything else the same" / "keep the composition or background": keep appearance only
   (identity, materials, colours) and describe the new view.
7. **No invented elements.**

---

## Medium / style rule — overrides every other ordering in this skill

When the brief, context or instruction names a MEDIUM or STYLE (comic, cartoon, illustration, cel-shaded, watercolor, anime, 3D render, painting, ...), that medium IS the Style element: state it FIRST and VERBATIM as the medium of the prompt (for example "Children's comic illustration, bold ink outlines, flat colors, cel shading: ..."). Never write photography language (photo, photograph, lens, focal length, depth of field, film stock, "studio photography") unless the brief explicitly asks for a photograph. A "reference portrait" or "plain studio backdrop" framing is composition, not a photographic medium. A medium named by the person stays inside the locked `instruction`; a rewrite or retry never drops it. Keep the negative-prompt rule: never negate the requested medium.

## Step 1 — Parse the request

- **Subject** — who/what in Figure 1 is edited.
- **Change** — the single most important edit (verb phrase).
- **Source** — the element taken from Figure 2, named precisely (garment type, color, material).
- **Placement / fit** — where and how it sits ("buttoned", "over the shoulders", "in her right
  hand").
- **Locks** — pose, identity, framing, background, lighting that must stay.

---

## Step 2 — Build the instruction

```
<Subject in Figure 1> <verb> <element from Figure 2, named>, <fit/placement>.
<optional context/lighting match>. Keep <locks> the same.
```

Length guide:

| Edit | Words |
|---|---|
| simple swap | 10–30 |
| typical single-change edit | 30–80 |
| several explicit elements | 80+ (only when each needs its own direction) |

Useful clauses:

- Lighting match for composites: "matching the original photo's lighting and shadow direction".
- Texture/style transfer: "apply the knitted texture and warm palette of the sweater in Figure 2
  to her sweater; keep its shape and fit".
- Edits without a source photo: state the target concretely ("change her jacket to deep red
  waxed cotton").

---

## Step 3 — Validate before output

- [ ] Imperative instruction; most important change first
- [ ] `Figure 1` / `Figure 2` used consistently (or content-descriptions consistently)
- [ ] Source element named precisely (type + color/material when known)
- [ ] Only positive phrasing — no "don't"/"no"
- [ ] Keep-clause for identity (and pose only if unchanged); no layout lock when the camera / angle / composition changes
- [ ] Caller's named specifics preserved; nothing invented

---

## Examples

- Garment transfer: "Have the woman in Figure 1 put on the yellow raincoat from Figure 2, worn
  open over her grey sweater. Keep her face, hairstyle, pose and the background the same."
- Object swap: "Replace the handbag held by the person in Figure 1 with the bag shown in
  Figure 2, matching the original photo's lighting and shadow direction. Keep the person's pose,
  outfit and the background unchanged."
- Background: "Keep the person in Figure 1 exactly as they are — same pose, outfit and
  expression — but place them in the location shown in Figure 2, matching its light on the
  subject."
- Attribute edit: "Make the man in Figure 1 look about ten years older, with grey at the temples
  and light lines around the eyes. Keep his face shape, expression and clothing the same."

---

## t2i mode (FLUX.2 workflow without image inputs)

Write a descriptive prose prompt instead of an instruction: Subject (with physical specifics) →
Action → Setting → Lighting (source, direction, quality) → Style/medium → framing. Natural
sentences, 30–80 words, positive phrasing only.

Composition vocabulary (t2i and ref2i): shot size (`extreme close-up` … `wide`), angle (`eye-level` | `low angle` | `high angle` | `top-down` | `Dutch angle`), lens feel (`35mm` environmental, `50mm` neutral, `85mm` compressed / isolated background, `wide-angle` expansive), `rule of thirds` / `subject in the left third`, foreground / midground / background, lead room (space in the direction the subject faces), `negative space`. When the brief carries a `Lighting (scene, keep)` line, keep its phrase verbatim.

**`Lens:` line of the brief** (the shot's optional `Lens: <wide|normal|long> [<N>mm][, <deep|shallow> focus][, focus on <thing>]`): map the class to a focal length and depth of field in the prompt - wide <= 28 mm (`24mm wide-angle lens`), normal 35-50 mm (`35mm` / `50mm lens`), long >= 85 mm (`85mm lens`, compressed background); an explicit `N mm` wins; `deep focus` = `deep depth of field (everything sharp)`, `shallow focus` = `shallow depth of field`, `focus on <thing>` = that thing sharp, the rest soft. Keep the medium rule above (no photography language for a drawn medium). A keyframe prompt NEVER carries Movement words (push in, pan, arc, handheld, tracking ...): a keyframe is one instant.

---

## Output

Return only the finished prompt text (the caller's output contract — e.g. a JSON field — takes
precedence over any formatting here). Negative terms go in the answer's separate `negative` field, never into the prompt. Alternative takes of the same edit come from a different
`seed`, not from rewording.

## Short prompts per workflow kind

- **EDIT workflows** (i2i): the change first, at most 2 short keep locks (naming only what must stay - never "everything else" or the composition when the camera / angle / framing changes; that is a new composition for a ref2i / t2i workflow), no restated character or location descriptions (the reference images carry them), and one image-naming sentence ("Picture 1 is ...").
- **REFERENCE-TO-IMAGE workflows** (ref2i): describe the NEW image as a scene, in the order of "Keyframe compose prompts" below; name each picture by its label for what it contributes ("Picture 1 is the place, Picture 2 is the character's outfit"). No edit wording, no keep locks.
- **VIDEO workflows** (i2v / ref2v / continuation): motion and camera first; do not re-describe what the start frame or references already show.

## Keyframe compose prompts (ref2i storyboard keyframes, FLUX.2 Klein)

FLUX.2 Klein is step-distilled and runs at cfg 1: there is NO negative prompt, and every word you write is drawn. Earlier words weigh most. The server puts each person's picture label (with an identity note) where you write their placeholder, adds LoRA trigger words in front and appends the shot's frame requirements after your text - so your prose only has to set up the picture, briefly and in the right order.

- **Length:** 60-120 words of your own, not counting the placeholders. Never restate the brief's requirement lines one by one.
- **Order:** (1) the people by placeholder and what their bodies do - the sex act and position in the FIRST sentence, right after the placeholders ("[[a]] and [[b]] have vaginal sex standing face to face: ..."); (2) where they touch; (3) what each wears or has taken off; (4) the place; (5) camera, framing, light and style last.
- **Hands:** state each hand exactly once, with its owner and side ("her left hand on his shoulder; his right hand on her hip"). Do not repeat a hand from Action, Pose and Contact in three wordings; when they disagree, follow Contact.
- **Mirrors:** whenever a mirror is in the frame, say what it shows - whose reflection, seen from where - or that it reflects only the wall or room behind the camera. A reflection shows a person from the side facing the mirror, never a second, separate person.
- **Crying** is an expression: "glistening eyes, wet lashes, a faint clear shine on her cheeks". Never "tear tracks", "streaks" or anything running down the face - it is drawn as fluid.
- **Body fluids:** name semen, sweat or saliva only when the brief's `Visible anatomy` / `State` lines require it, once, with where it is. Wet hair or skin from water is "wet hair", "water droplets on her shoulders".
- **Removed garments:** say what is visible instead - "bare legs", "barefoot", "bare chest", "naked below the waist". A garment named, even as removed, gets painted in. Feet are "bare feet" - never "heels" (drawn as high-heeled shoes).
- **Genitals:** describe them once and consistently (e.g. "an average-sized erect penis"); never add a size word the brief does not give.
- **Colours of the place:** copy the place's own colour and material words from the brief; do not paraphrase them.

## Shot facts are kept

When the brief carries a shot's `Blocking`, `Pose`, `Frame`, `Visible`, `Sex act` or `Sex position` text (legacy `Act`), carry it into the prompt in the same meaning and, for the sex act and position, in the same plain words (verbatim; no euphemism, no softening, nothing added). For an explicit act, name the visible genitals in plain anatomical words, as the brief's `Visible anatomy (must show)` line says - never euphemisms like "joined" or "groin to groin" - and any body fluid only as "Keyframe compose prompts" above allows. Who is where, facing which way, the pose and the left / centre / right placement stay as written; who is NOT visible stays out of the frame (a POV shot shows hands or forearms only). Phrases listed as `verbatim_phrases` must appear unchanged. The caller supplies the "Picture N is <name>" lines (from `image_inputs`): use exactly those lines and numbers, never renumber them and never invent a Picture line. A frame's removed element (a frame edit such as "remove the car") is never put back. Describe one instant, not a sequence. Posture: state each person's posture with the exact posture words of `Pose:` (on her back stays "on her back", never "face down"). Order: the sex act and position are the FIRST sentence, before posture, clothing and place. Clothing: describe every in-frame person's clothing state positively - what is worn and what is bare - including the POV viewer's visible body (arms, hands, lap, legs as the brief allows); a removed garment is stated as bare skin, never left unmentioned. Carry the brief's `Expression (<name>): … (must show)` lines into the prompt in the same meaning, as what the camera sees (crying: as "Keyframe compose prompts" above says).

## Wardrobe terms

- Name garments the way a costume department would: garment type and cut, material, colour or pattern, embellishment, fit or length, how it is worn ("cropped double-breasted wool blazer, navy, gold buttons, worn open" - never "nice jacket" or "sparkly outfit").
- Name only what the caller or the pictures state; never invent construction details (pockets, buttons, trims) nobody gave you.
- The server may append an `Outfit (<Name>): ...` line after your prompt (the outfit design's garment list, verbatim). Do not write that line yourself, and do not repeat or paraphrase its garments: describe pose, action and how the clothes sit now (open, rolled, wet), not the outfit again.

## Fidelity

When an `instruction` is supplied it is LOCKED: never drop or alter any element of it, never add states that were not asked for (no invented poses, sleep, etc.), and keep the prompt free of internal contradictions. You may only add image naming/order and the syntax this family requires.
