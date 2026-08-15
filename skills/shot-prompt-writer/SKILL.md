---
name: shot-prompt-writer
description: >
  Trigger when tasked with pre-processing shot descriptions into hardened T2I and I2V
  prompts for a specific scene — e.g. "write shot prompts for scene 2", "create the
  prompt JSON for scene 3". Reads one shotlist and the visual_bible, injects canonical
  character and location anchors into every shot, and outputs a structured JSON file
  ready for direct use by the renderer — no creative expansion needed at render time.
  Do NOT invoke for writing shotlists, rendering images, or quality checking.
agentType: worker
---

# Shot Prompt Writer

## What this skill produces

`scene{X}_shot_prompts.json` — one entry per shot in the scene, containing:
- `t2i_prompt`: the complete, anchored T2I prompt for keyframe generation
- `i2v_motion`: the I2V motion prompt (MODE B from prompt-writer skills)
- `i2v_neg`: the negative prompt for the I2V workflow
- `duration_sec`: clip duration in seconds (3–15)
- `workflow_t2i`: T2I workflow name (e.g. `krea2_base_realism`)
- `workflow_i2v`: I2V workflow name (e.g. `iamcs_wan22_svi`)

The renderer downstream reads this JSON and calls workflow tools with these exact strings.
The renderer does NOT write its own prompts.

---

## Phase 1 — Read artifacts

Call `artifact_index`, then read:
1. `visual_bible` — get style anchor, character anchors, location anchors
2. `scene{X}_shotlist` (your task will specify which scene) — get shot descriptions

**Do not proceed without both artifacts.** If either is missing: call `task_complete` with
an error message listing the missing artifact ID.

Extract from visual_bible:
- `style.anchor_phrase` → STYLE_ANCHOR (prepend to every T2I prompt)
- `characters[*].t2i_anchor` → CHARACTER_ANCHOR per character
- `locations[scene_location_id].t2i_anchor` → LOCATION_ANCHOR
- `locations[scene_location_id].lighting[time_of_day]` → LIGHTING_ANCHOR

---

## Phase 2 — Extract shot list

From the shotlist, extract ALL shots with:
- Shot ID (e.g. `s2-01`)
- Summary (one-sentence action)
- Description (the full shot description)
- Camera settings (angle, lens, shot type)
- Characters present

State explicitly: "I found N shots: [s2-01, s2-02, ...s2-0N]"

**Critical: do not add, remove, or renumber shots. Use the exact IDs from the document.**

---

## Phase 3 — Write prompts for each shot (one at a time)

Process shots STRICTLY IN ORDER. Complete each shot fully before moving to the next.

### For each shot:

**3a. Identify anchors needed**
- Which characters are present? → look up each in visual_bible.characters
- What is the scene location? → look up in visual_bible.locations
- What time of day / lighting condition? → look up location.lighting

**3b. Write T2I prompt**

Structure:
```
[STYLE_ANCHOR] — [LOCATION_ANCHOR] — [CHARACTER_ANCHOR for each present character]. [Shot-specific content: camera angle, subject position, action state, specific props from shot description]. [LIGHTING_ANCHOR].
```

Rules:
- STYLE_ANCHOR must be FIRST in the prompt
- CHARACTER_ANCHOR must include the full anchor phrase from visual_bible (verbatim, not summarized)
- Shot-specific content describes POSITION and STATE only — not appearance (appearance is in anchors)
- Do not duplicate what the anchor already says
- Length: 60–120 words

**3c. Write I2V motion prompt (MODE B)**

Use the `prompt-writer-wan22` skill guidance:
- Describe ONLY what moves between start and end frame
- Active camera verbs: "holds steady", "slowly pushes in", "tilts down"
- Subject action as progression: "descends the remaining steps", "turns from the window"
- Include scene dynamics: "rain falls steadily", "grey light holds flat"
- For directional exits/entrances: add forward-time anchor — "time flows forward", "subject moves continuously toward the door"
- Do NOT describe static appearance
- Length: 2–4 sentences

**3d. Write negative prompt**

Always include: `blurry, low quality, compression artifacts, watermark, text overlay, distorted proportions, overexposed, underexposed, flickering, inconsistent lighting, duplicate frames, static image`

Add from character drift risks in visual_bible: e.g. `summer dress, long hair, glasses, modern hotel, bright saturated colours`

For shots with exits/entrances: add `reversed motion, backward movement, [specific reversal]`

**3e. Assign duration**

- Hold / static shots: 3–4 s
- Simple subject action (sit, turn, speak): 4–6 s
- Walking / traversal: 6–10 s
- Complex multi-subject with camera move: 10–15 s
- Maximum: 15 s

---

## Phase 4 — Assemble and write JSON

Build the output JSON with all shots, write to sandbox as `scene{X}_shot_prompts.json`.

```json
{
  "scene_id": "scene2",
  "shot_count": 8,
  "shots": {
    "s2-01": {
      "t2i_prompt": "...",
      "i2v_motion": "...",
      "i2v_neg": "...",
      "duration_sec": 4,
      "workflow_t2i": "krea2_base_realism",
      "workflow_i2v": "iamcs_wan22_svi"
    },
    ...
  }
}
```

---

## Completion validation

Before `task_complete`:
1. `shot_count` in JSON == number of shots extracted in Phase 2 (exact match)
2. Every shot_id from Phase 2 is a key in `shots`
3. Every `t2i_prompt` begins with the STYLE_ANCHOR phrase
4. Every `t2i_prompt` contains the CHARACTER_ANCHOR text for each character listed as present
5. Every `i2v_neg` contains the standard suppression list

If any check fails: fix before completing.
