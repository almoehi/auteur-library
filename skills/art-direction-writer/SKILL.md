---
name: art-direction-writer
description: >
  Trigger when tasked with writing the art direction document for a film production —
  e.g. "write the art direction for cat_in_the_rain", "create the visual style guide".
  Produces `art_direction.md`: the authoritative visual language guide governing era,
  color palette, lens choices, lighting model, and forbidden visual elements for the
  entire production. MUST be written before any visual bible, shot prompts, or rendering.
  Do NOT invoke for screenplay writing, cast creation, or scene planning.
agentType: worker
---

# Art Direction Writer

## When to use this skill

Use this skill when your task is to write `art_direction.md` — the single source of
truth for how every frame of this production should LOOK.

This document is consumed by:
- `visual-bible-writer` (to build character/location anchors)
- `shot-prompt-writer` (to open every T2I prompt with the style anchor)
- Quality controllers (to evaluate whether renders match the intended look)

---

## Phase 1 — Read source artifacts

Call `artifact_index` to list available artifacts, then `read_artifact` for:
1. `screenplay` — establishes story world, period, setting
2. `cast` — establishes character physicality
3. `scene_list` — establishes locations and time-of-day requirements

---

## Phase 2 — Derive the visual language

Work through these sections in order before writing:

### Era & setting
- What time period does the story take place?
- What country/region? What is the architecture, fashion, technology visible?
- What is the equivalent photographic era (daguerreotype, 35mm B&W, early Kodachrome, etc.)?

### Color palette
- What is the dominant environmental palette? (weather, landscape, interiors)
- What accent colors appear? (specific props, clothing, foliage)
- What is the saturation level? (vivid, muted, desaturated, monochrome)
- What is the tonal range? (high-key, low-key, balanced, overcast)

### Film aesthetic
- What film stock / photographic character applies? (grain, sharpness, tonal response)
- What lens character? (soft, crisp, period-appropriate optic distortion)
- Reference: "looks like a photograph from [decade] [country], [photographer/film style]"

### Lighting model (per scene type)
- Exterior day: …
- Exterior rain: …
- Interior day: …
- Interior dusk/night: …
- State: which light sources are present and which are FORBIDDEN

### Forbidden elements
Be explicit. List visual elements that break the period or setting:
- Architectural features (glass curtain walls, LED fixtures, modern fixtures)
- Clothing (synthetic fabrics, modern cuts, sportswear)
- Colour choices (fluorescent, highly saturated, neon)
- Camera artifacts (HDR look, heavy vignette, teal-orange grading)

### Global T2I style anchor phrase
Derive a short phrase (15-25 words) that will be prepended to EVERY T2I prompt in the
production to enforce style consistency. Format:
```
"[medium] photograph, [country] [decade], [palette descriptor], [texture], [key visual quality]"
```

Example: `"35mm film photograph, Italy 1930s, muted grey-blue-green palette, soft film grain, period-accurate, overcast light"`

---

## Phase 3 — Write art_direction.md

Structure:
```markdown
# Art Direction — [Production Title]

## Era & Setting
[period, geography, photographic reference]

## Color Palette
[dominant, accent, saturation, tonal range]

## Film Aesthetic
[grain, lens character, photographic reference]

## Lighting Model
### Exterior (Day / Rain)
### Interior (Day)
### Interior (Dusk / Night)

## Forbidden Visual Elements
[explicit list]

## Global T2I Style Anchor
[the anchor phrase to prepend to every prompt]
```

Use **specific, observable language** throughout. Bad: "cinematic look". Good: "flat overcast grey light with no directional shadows, as if filmed through a north-facing window on a cloudy day."

---

## Completion contract

Call `task_complete` only after:
1. All three source artifacts have been read
2. All six sections above are written in the document
3. The global T2I style anchor phrase is present and usable standalone
