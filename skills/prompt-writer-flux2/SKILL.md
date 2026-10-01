---
name: prompt-writer-flux2
description: >
  Trigger when asked to write, enhance, or review a prompt for a FLUX.2 workflow (model family
  flux2), above all an image edit — e.g. "dress her in the coat from the reference photo",
  "write an edit instruction for flux2_image_edit", "swap the handbag using figure 2",
  "make the jacket red in this take". Produces a concise, instruction-style image-edit prompt
  that names the inputs as "Figure 1" / "Figure 2" and states what to keep.
  Do NOT invoke for Qwen-Image-Edit (qwenimage), KREA-2, FLUX 3 video, or any video/animation
  workflow.
agentType: worker,render
---

# FLUX.2 — Edit Instruction Writer

## When this skill applies

Use this skill for workflows with `model_family: flux2` — primarily **image edits**
(`workflow_type: i2i`, e.g. the `flux2_image_edit` bundle: FLUX.2 Klein 9B-KV, a subject photo
plus one reference photo). The prompt is one **instruction**; there is no negative prompt.

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
6. **Preserve identity explicitly.** For a character design, always add a keep-clause for face,
   hair, body shape and pose.
7. **No invented elements.**

---

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
- [ ] Keep-clause for identity and pose
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

---

## Output

Return only the finished prompt text (the caller's output contract — e.g. a JSON field — takes
precedence over any formatting here). Alternative takes of the same edit come from a different
`seed`, not from rewording.
