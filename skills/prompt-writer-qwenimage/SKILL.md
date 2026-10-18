---
name: prompt-writer-qwenimage
description: >
  Trigger when asked to write, enhance, or review an edit instruction for a Qwen-Image-Edit
  workflow (model family qwenimage) — e.g. "put the jacket from picture 2 on her",
  "write an edit prompt for the qwen multi-edit workflow", "make her older in this take",
  "swap the background for the harbor reference". Produces a concise, instruction-style
  image-edit prompt that names each reference image by position ("Picture 1/2/3").
  Do NOT invoke for text-to-image generation from scratch (KREA-2, t2i), FLUX.2 edits,
  video models, or any task that produces moving images.
agentType: worker,render
---

# Qwen-Image-Edit — Edit Instruction Writer

## When this skill applies

Use this skill for an **image edit** (`workflow_type: i2i`) whose workflow has
`model_family: qwenimage` — Qwen-Image-Edit (2511), which takes up to three reference images (check the
workflow's own ports for the actual count). The prompt is an **instruction** that tells the model what to
change in existing images, not a description of a new picture.

---

## Iron Laws — Non-Negotiable

1. **Instruction, not description.** Write an imperative edit ("Replace …", "Change …",
   "Keep …"), never a from-scratch scene description. Everything not mentioned is preserved.
2. **Name every image by position.** `Picture 1` = the first reference input (the anchor whose
   subject, pose and composition are kept), `Picture 2` = the second, `Picture 3` = the third.
   Never write "the second image", "it", "that one" — the model follows literal positional
   references far more reliably than pronouns.
3. **Name the exact attribute to take from each supporting picture.** "the red raincoat in
   Picture 2", "the harbor background in Picture 3" — never "combine these images".
4. **One coherent change per instruction.** If several changes are required, list them as short
   clauses in priority order (most important first).
5. **Preserve identity explicitly.** When the subject must stay recognisable (a character
   design), end with a keep-clause: "Keep her face, hairstyle and pose from Picture 1 unchanged."
6. **No invented elements.** Do not add props, people or styles the caller did not ask for.

---

## Medium / style rule — overrides every other ordering in this skill

When the brief, context or instruction names a MEDIUM or STYLE (comic, cartoon, illustration, cel-shaded, watercolor, anime, 3D render, painting, ...), that medium IS the Style element: state it FIRST and VERBATIM as the medium of the prompt (for example "Children's comic illustration, bold ink outlines, flat colors, cel shading: ..."). Never write photography language (photo, photograph, lens, focal length, depth of field, film stock, "studio photography") unless the brief explicitly asks for a photograph. A "reference portrait" or "plain studio backdrop" framing is composition, not a photographic medium. A medium named by the person stays inside the locked `instruction`; a rewrite or retry never drops it. Keep the negative-prompt rule: never negate the requested medium.

## Step 1 — Parse the request

Extract:

- **Anchor** — which picture is the subject to edit (normally Picture 1).
- **Change(s)** — what should differ in the result, each as one verb phrase.
- **Sources** — for each change, which picture (if any) supplies the new element.
- **Locks** — what must stay the same (face, identity, pose, framing, lighting, background).
- **Unused slots** — the workflow may require all three inputs; if the caller fed a duplicate or
  neutral image into a slot it does not need, do not mention that picture at all.

---

## Step 2 — Build the instruction

Order: **change → source → placement/fit → locks**.

```
<Verb> the <attribute> of <subject> in Picture 1 [with/using the <attribute> from Picture N],
<placement or fit detail>. Keep <locked attributes> from Picture 1 unchanged.
```

Verbs that work well: `Replace`, `Change`, `Put … on`, `Remove`, `Add`, `Recolor`, `Make … look`,
`Place … in`, `Turn … into`.

Detail to add only when it changes the result:

- **Fit / placement** — "worn open over the white shirt", "hanging from her left shoulder".
- **Material / color** — when the caller named them, or when the source picture is ambiguous.
- **Lighting match** — "match the lighting and shadow direction of Picture 1" for composites.
- **Attribute edits without a source picture** ("make her older") — state the target concretely:
  "Make the woman in Picture 1 look about 60 years old: grey streaks in her hair, fine wrinkles
  around the eyes. Keep her face shape, expression and pose unchanged."

Length: 1–3 sentences (≈ 15–70 words). Longer prompts dilute the edit.

---

## Step 3 — Negative prompt

The workflow has an optional `prompt_negative`. Keep its default unless the caller reports a
specific artifact; then append that artifact ("extra fingers", "blurred face", "duplicated
jacket collar"). Never put the edit itself into the negative prompt.

**Negative prompt rule:** Negative prompt = quality defects (blur, artifacts, deformed anatomy, text/watermark) plus what the brief explicitly excludes. NEVER negate the medium or style the brief asks for (an illustrated, comic, anime, painted or stylised brief must not get CGI/anime/cartoon/illustration/digital-art negatives). If the brief states no exclusions, keep it to the quality defects. Skip the negative entirely for models that take none.

---

## Step 4 — Validate before output

- [ ] Imperative instruction, not a scene description
- [ ] Every picture referenced as `Picture N`, and only pictures that are actually used
- [ ] Each transferred attribute named explicitly with its source picture
- [ ] Locks stated for identity-critical attributes
- [ ] No invented elements; caller's named colors/materials preserved
- [ ] 1–3 sentences

---

## Examples

- Outfit transfer: "Put the yellow raincoat from Picture 2 on the woman in Picture 1, worn
  open over her grey sweater. Keep her face, hairstyle, pose and the background of Picture 1
  unchanged."
- Background swap: "Place the man from Picture 1 in the harbor scene from Picture 3, standing
  on the pier in the foreground, lit by the same overcast daylight as Picture 3. Keep his face,
  clothing and pose unchanged."
- Three-way composite: "Replace the clothes of the woman in Picture 1 with the outfit in
  Picture 2, and replace the background with the street in Picture 3. Keep her face and pose
  from Picture 1."
- Attribute edit (no source): "Change the jacket of the man in Picture 1 to deep red leather.
  Keep everything else unchanged."

---

## Output

Return only the finished instruction text (the caller's output contract — e.g. a JSON field —
takes precedence over any formatting here). Seeds are not part of the prompt: to get
alternative takes of the same edit, re-render with a different `seed`, not a reworded prompt.

## Short prompts per workflow kind

- **EDIT workflows** (i2i): the change first, at most 2 short keep locks, no restated character or location descriptions (the reference images carry them), and one image-naming sentence ("Picture 1 is ...").
- **REFERENCE-TO-IMAGE workflows** (ref2i): describe the NEW image (subject, setting, composition, camera, light) as a scene; name each picture by its label for what it contributes ("Picture 1 is the place, Picture 2 is the character's outfit"). No edit wording, no keep locks.
- This family has no video workflow; for text-to-image keep the prompt as short as the six-element stack allows.

## Shot facts are kept

When the brief carries a shot's `Blocking`, `Pose`, `Frame`, `Visible`, `Sex act` or `Sex position` text (legacy `Act`), carry it into the prompt in the same meaning and, for the sex act and position, in the same plain words (verbatim; no euphemism, no softening, nothing added). Who is where, facing which way, the pose and the left / centre / right placement stay as written; who is NOT visible stays out of the frame (a POV shot shows hands or forearms only). Phrases listed as `verbatim_phrases` must appear unchanged. The caller supplies the "Picture N is <name>" lines (from `image_inputs`): use exactly those lines and numbers, never renumber them and never invent a Picture line. A frame's removed element (a frame edit such as "remove the car") is never put back. Describe one instant, not a sequence.

## Fidelity

When an `instruction` is supplied it is LOCKED: never drop or alter any element of it, never add states that were not asked for (no invented poses, sleep, etc.), and keep the prompt free of internal contradictions. You may only add image naming/order and the syntax this family requires.
