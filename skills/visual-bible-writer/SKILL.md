---
name: visual-bible-writer
description: >
  Trigger when tasked with creating the visual bible for a film production —
  e.g. "write the visual bible", "create character prompt anchors", "build the consistency reference".
  Produces `visual_bible.json`: structured canonical prompt anchors for every character
  and every production location, derived from cast, scene_list, and art_direction.
  This artifact is the PRIMARY consistency mechanism — it is injected into every
  shot-prompt-writer and render task downstream.
  Do NOT invoke for art direction writing, shot list creation, or rendering.
agentType: worker
---

# Visual Bible Writer

## What this skill produces

`visual_bible.json` — a structured JSON file with:
- `style` block: global style anchor (from art_direction)
- `characters` block: one entry per named character with `t2i_anchor` phrase
- `locations` block: one entry per production location with `t2i_anchor` phrase

This file is the SINGLE source of truth for character appearance and location appearance.
Every downstream prompt task reads it and injects anchors verbatim. No paraphrase, no
summarization — the anchor IS the definition.

---

## Phase 1 — Read source artifacts

Call `artifact_index`, then `read_artifact` for:
1. `art_direction` — extract the global T2I style anchor phrase
2. `cast` — extract every named character's physical description
3. `scene_list` — extract every location that appears in the production

---

## Phase 2 — Build character anchors

For each named character in the cast:

**Character anchor rules:**
1. The anchor phrase must work STANDALONE in a T2I prompt. No pronouns. No "as described above."
2. Must specify ALL of: age range, gender, hair (length + style + color), clothing (type + color + era), skin tone, build, distinguishing features
3. Must include the NEGATIVE SPECIFICATION for common drift points — e.g. "NOT a summer dress", "NOT glasses", "NOT long hair"
4. Must be consistent with the art_direction era — no anachronistic clothing

**Format per character:**
```json
{
  "t2i_anchor": "[gender], [age range], [hair: length + style + color], [clothing: type + color + era note], [skin], [build], [key distinguishing feature], NOT [common drift failure 1], NOT [common drift failure 2]",
  "era_costume": "[brief costume note for period consistency]",
  "scenes": [list of scene numbers this character appears in],
  "drift_risks": ["[known failure mode 1]", "[known failure mode 2]"]
}
```

---

## Phase 3 — Build location anchors

For each distinct production location in the scene_list:

**Location anchor rules:**
1. Must specify: architectural era, specific furniture/props PRESENT, specific elements FORBIDDEN
2. Must specify: floor material, wall finish, window type, dominant light source per time-of-day
3. Must be consistent with art_direction era and color palette
4. Forbidden elements MUST be explicit and specific (not "no modern elements" — list them)

**Format per location:**
```json
{
  "t2i_anchor": "[era] [type]: [key architectural feature], [floor], [furniture item 1], [furniture item 2], [window description], NOT [forbidden element 1], NOT [forbidden element 2]",
  "lighting": {
    "day": "[lighting description]",
    "dusk": "[lighting description]",
    "night": "[lighting description]"
  },
  "key_props": ["[prop 1]", "[prop 2]"],
  "forbidden": ["[modern element 1]", "[modern element 2]"],
  "scenes": [list of scene numbers]
}
```

---

## Phase 4 — Write visual_bible.json

Assemble the full JSON:
```json
{
  "production": "[title]",
  "style": {
    "anchor_phrase": "[global T2I style anchor from art_direction]",
    "era": "[period]",
    "color_grade": "[palette description]"
  },
  "characters": {
    "[character_id]": { ... },
    ...
  },
  "locations": {
    "[location_id]": { ... },
    ...
  }
}
```

Write to `visual_bible.json` via sandbox.

---

## Critical validation before task_complete

1. Every character in cast.md has an entry in `characters`
2. Every location in scene_list.md has an entry in `locations`
3. Every `t2i_anchor` phrase is ≥ 30 words (too-short anchors provide insufficient constraint)
4. Every `t2i_anchor` contains at least one explicit NOT/FORBIDDEN clause
5. The `style.anchor_phrase` matches the one in art_direction.md verbatim

If any validation fails: fix the missing entry before calling task_complete.
