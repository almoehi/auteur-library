---
name: prompt-writer-wan22
description: >
  Trigger when asked to write, enhance, or improve a prompt for WAN 2.2, WAN 2.6,
  WAN Animate, or WAN FLF2V — e.g. "write a WAN 2.2 prompt for this shot",
  "enhance this prompt for WAN Animate", "write the motion prompt for this i2v clip".
  Produces an enhanced, model-optimised prompt ready to pass to a WAN workflow tool.
  Do NOT invoke for KREA-2, FLUX 3, MiniMax H3, or any non-WAN model.
agentType: worker,render
---

# WAN 2.2 / WAN 2.6 — Prompt Writer

## When this skill applies

Use this skill when asked to write or enhance a prompt targeting:
- WAN 2.2 (t2v or i2v / Animate)
- WAN 2.6 (t2v, ref2v, or v2v)
- WAN 2.2 FLF2V (first-last-frame)
- Any "Wan" family video model

---

## Iron Laws — Non-Negotiable

These override all other instructions:

1. **Never alter the scene, subjects, or core action.** You enhance structure and specificity — you do not redirect.
2. **No invented elements.** Do not introduce characters, props, or events not present or strongly implied by the input.
3. **Mode determines scope.** In t2v: describe everything. In i2v: motion and camera only — never re-describe what the reference image shows. In flf2v: describe only the transition path — never describe the endpoint frames.
4. **Front-weight critical content.** WAN 2.2 weights the beginning of the prompt most heavily. Critical details past word 30 are frequently ignored.
5. **One camera instruction.** Contradictory camera movements produce unstable output.

---

## Step 1 — Identify the Generation Mode

Determine the workflow mode before writing anything. Mode controls what the prompt is allowed to cover.

| Mode | Signal | Prompt covers |
|---|---|---|
| t2v | Text input only; no image attached | Everything: subject + motion + camera + scene |
| i2v | One reference image provided | Motion + camera only — appearance anchored by image |
| flf2v | Two images provided (start + end) | Transition path only — both endpoints anchored |
| ref2v | Reference image(s) tagged `@Video1` etc. | New scene + camera + motion (identity from reference) |
| v2v | Source video provided | Target style only — motion from source |
| End-frame chain | Final frame of a prior i2v segment | Continuity motion forward from that ending state |

If the mode is ambiguous, ask before writing.

---

## Step 2 — Parse the Input

Extract from the input prompt or briefing:

- **Core subject** — who or what is the focus; any named physical features
- **Core action** — what happens or what state is established
- **Scene/environment** — location, time of day, weather
- **Named constraints** — any specific colors, materials, or camera instructions the caller specified (lock these; do not change them)
- **Aesthetic register** — photoreal, anime, cinematic, claymation, etc.

Identify which production dimensions are missing or underspecified:

- [ ] Subject visual anchors (minimum 2 distinguishing features)
- [ ] Motion specificity (speed qualifier + verb + direction + body mechanics)
- [ ] Camera (shot size + movement — single non-contradictory instruction)
- [ ] Lighting (source + direction + quality — all three)
- [ ] Environmental atmosphere (texture, weather, reflections, particulates)
- [ ] Style register

---

## Step 3 — Apply the Enhancement Framework

### t2v: Four-Layer Structure (order is load-bearing)

```
Layer 1: [SUBJECT] → Layer 2: [MOTION] → Layer 3: [CAMERA] → Layer 4: [SCENE/LIGHTING]
```

**Layer 1 — Subject identity anchoring**

Minimum 2 distinguishing visual features. Template:
```
[Subject type] with [feature 1], [feature 2], [clothing material + color], [accessory], [state]
```

Feature categories: face (jaw, eye color, scars), hair (length + texture + color), clothing (specific color + material), accessories, expression.

**Layer 2 — Motion**

Formula: `[Subject] [speed qualifier] [specific verb] [direction] [body mechanic detail]`

Speed qualifiers — Slow: `slowly`, `gently`, `gradually` / Moderate: `steadily`, `briskly` / Fast: `rapidly`, `sharply`

Power verbs: `sprint`, `dash`, `bolt`, `rush`, `pivot`, `whip`, `spin`, `erupt`, `burst`, `glances`, `tilts`, `sways`

> ⚠️ Very fast motion (sprint, bolt, explosive burst) consistently produces lower-quality output than moderate speed. Test at 480p first. Prefer `"briskly runs"` over `"sprints explosively"` when possible.

Body mechanics examples:
- "Walks toward camera at relaxed pace, left hand running through hair, both hands drop to sides as she stops"
- "Pivots sharply on right foot, coat swinging with momentum"

Layered motion: separate subject from background explicitly — `"Subject remains still with subtle breathing; background tree branches sway gently in wind."`

**Layer 3 — Camera (ONE instruction only)**

Shot sizes: `extreme close-up` | `close-up` | `medium close-up` | `medium shot` | `wide shot` | `establishing shot`

| Movement | Phrase |
|---|---|
| No movement | `static shot`, `locked-off frame` |
| Horizontal | `slow pan left/right` |
| Vertical pivot | `slow tilt up/down` |
| Approach | `slow push in`, `dolly in` |
| Retreat | `pull back`, `dolly out` |
| Follow | `tracking shot` |
| Circle | `arc shot`, `orbits 15°–30° clockwise` |
| Rise | `crane up` |
| Handheld | `handheld with subtle wobble` |
| Aerial | `drone shot perspective` |

Lens: `medium focal length` (default) | `telephoto` | `shallow depth of field` | `anamorphic bokeh`

Contradictions to avoid: `drone shot` + `extreme close-up` / `static shot` + `slow pan` / `dolly in` + `pull back`

**Layer 4 — Scene / Lighting**

Always specify: source + direction + quality.

| Source | Direction | Quality |
|---|---|---|
| `golden hour sun` | `side-lit` | `soft diffused` |
| `neon sign glow` | `rim-lit` | `hard directional` |
| `candlelight` | `underlit` | `flickering warm` |
| `sodium streetlight` | `from above-left` | `warm amber, hard` |
| `moonlight` | `backlit` | `cool blue cast` |

Atmosphere (add 1–2): `light rain catching light` / `wet pavement reflecting neon` / `dust motes in light beams` / `steam from manhole cover` / `16mm grain` / `teal-and-orange grade`

---

### i2v: Motion and Camera Only

Do NOT include subject appearance, colors, clothing, environment, or style (all defined by the reference image).

Micro-motion vocabulary (portrait i2v): `micro-blink`, `subtle smile develops`, `hair sways lightly`, `eyes glance left`, `head tilts 10° right`, `breathing visible in chest rise`, `fabric ripples at shoulder`

Stability rules:
- Orbit cap: max 10–30° to prevent identity drift
- Use `fixed lens` for portrait subjects
- Prefer soft/low-contrast descriptions — hard lighting accelerates face drift
- Target 3–10 second clips for stability

**i2v formula:**
```
[What moves + speed + direction + body mechanics] + [camera movement] [+ optional: style modifier]
```

---

### flf2v: Transition Path Only

Both images pin start and end frames. Describe only the journey between them — not what the frames look like.

**flf2v formula:**
```
[Start state summary] + [end state summary] + [transition motion character] + [camera behavior] + [continuity constraint]
```

Effective transition language:
- `smooth continuous motion, cinematic pacing`
- `rises from seated position, weight shifting deliberately`
- `rotates 90° clockwise, coat following with momentum`
- `gradual transformation, steady linear progression`

---

### ref2v: Reference Tag Embedding

Embed `@Video1`, `@Video2`, `@Video3` inline in prose — not as separate lines:
- "a woman `@Video1` walking through a market"
- "the man `@Video1` hands the bag to the woman `@Video2`"

Duration constraint: only 5 or 10 seconds available in ref2v mode.

---

### v2v: Style Description Only

Describe the target style only — not motion (comes from source video). Example:
`"Cyberpunk aesthetic, neon-lit streets, rain-soaked surfaces, teal-and-orange grade"`

---

### End-Frame Chain: Continuity Forward

- Describe what the subject is **continuing** to do, not restarting
- Use continuity phrases: `"continuing to walk forward"`, `"still turning left"`, `"resuming approach"`
- Match camera position and lighting from the previous segment's endpoint

---

## Step 4 — Prompt Length Check

| Mode | Target | Notes |
|---|---|---|
| t2v simple | 25–50 words | Critical content in first 30 words |
| t2v standard | 50–80 words | Optimal |
| t2v complex | 80–120 words | Content past 120 words frequently ignored |
| i2v | 20–50 words | Motion + camera only |
| flf2v | 30–60 words | Transition path + camera + continuity |
| WAN 2.6 multi-shot | 15–30 words per shot | Plus a global style header line |

**WAN 2.6 multi-shot format:**
```
[Global style line]. Shot 1 [0-3s] [description]. Shot 2 [3-7s] [description]. Shot 3 [7-10s] [description].
```

---

## Step 5 — Validate Before Output

Check:
- [ ] Original scene and subjects unchanged
- [ ] i2v prompt contains ONLY motion and camera (no visual re-description)
- [ ] flf2v prompt describes transition path only (not endpoint appearance)
- [ ] Single, non-contradictory camera instruction
- [ ] Critical content in first 30 words
- [ ] No empty filler terms ("cinematic", "beautiful") without observable specifics
- [ ] Length within mode guidelines

---

## Step 6 — Output

Return:

```
ENHANCED PROMPT:
[Complete enhanced prompt — plain text, ready to paste directly into the workflow]

NEGATIVE PROMPT:
morphing, warping, distortion, blurry, low quality, face deformation, flickering, jittering, inconsistent lighting, extra fingers, poorly drawn hands, deformed, bad anatomy, watermark, text, oversaturated
[append: eye distortion, identity drift, changing face — for portraits]
[append: motion blur artifacts, smearing, strobing — for action]

CHANGES SUMMARY:
• [What was added or restructured — 3–5 concise bullets]
```

---

## Subject / Object Positioning Reference

`in the foreground` | `in the deep background` | `center frame` | `left of center` | `occupying left third of frame` | `right edge of frame`

Depth: `extreme close-up filling frame` (close) / `waist-up medium shot` (mid) / `small figure against vast environment` (far)

Spatial relationships: `standing at distance from camera` / `facing camera at 45°` / `positioned behind subject, slightly right`

---

## Style Tags Reference

| Style | Phrase |
|---|---|
| Photoreal | `photoreal`, `shot on ARRI` |
| Film | `16mm grain`, `anamorphic bokeh`, `bleach-bypass grade` |
| Anime | `2D anime`, `cel-shaded`, `Studio Ghibli style` |
| Claymation | `claymation`, `stop-motion texture` |
| 3D Cinematic | `Pixar style`, `3D game engine render` |
| Cyberpunk | `neon-lit`, `cyberpunk aesthetic` |
