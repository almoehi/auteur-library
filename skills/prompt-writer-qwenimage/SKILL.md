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
`model_family: qwenimage` — e.g. the `qwen_image_multi_edit` bundle (Qwen-Image-Edit 2511,
up to three reference images). The prompt is an **instruction** that tells the model what to
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
