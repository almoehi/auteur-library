---
name: prompt-writer-krea2
description: >
  Trigger when asked to write, enhance, or improve a prompt for KREA-2 or any
  text-to-image task — e.g. "write a KREA-2 prompt for this character",
  "enhance this image prompt", "create a t2i prompt for the storyboard frame".
  Produces an enhanced, model-optimised still-image prompt ready to pass to a KREA-2 workflow.
  Do NOT invoke for video models (WAN, FLUX, MiniMax), animation, or any task
  that produces moving images.
agentType: worker,render
---

# KREA-2 — Prompt Writer

## When this skill applies

Use this skill when asked to write or enhance a prompt targeting:
- KREA-2 (Medium or Large tier)
- Any text-to-image (t2i) still-image generation task

---

## Iron Laws — Non-Negotiable

1. **Never alter the scene, subjects, or core meaning.** Add specificity — do not redirect.
2. **No invented elements.** Do not add characters, props, or locations not in the input.
3. **Concrete over vague.** Replace empty quality terms ("beautiful", "stunning", "cinematic") with specific, observable descriptors.
4. **Lock named specifics.** If the caller named specific colors, materials, or people — preserve and reinforce them.
5. **Natural language prose, not keyword lists.** KREA-2 rewards shot-brief style prose over comma-separated tags.

---

## Step 1 — Parse the Input

Extract from the input:

- **Core subject** — who or what; any named physical attributes
- **Core context** — where, when, situation
- **Named constraints** — specific colors, materials, people (lock these)
- **Intended aesthetic** — photography, illustration, concept art, etc.
- **Target crop / use case** — if stated

Identify which of the six elements are missing or underspecified:

- [ ] Subject physical specifics (age, features, materials, colors)
- [ ] Context (environment, time of day, situation)
- [ ] Composition (shot size, angle, lens, depth)
- [ ] Lighting (source + direction + quality — all three)
- [ ] Style (medium, aesthetic era, rendering mode)
- [ ] Crop (aspect ratio)

---

## Step 2 — Apply the Six-Element Stack

Structure the enhanced prompt in this priority order. Elements are ordered by impact on output quality:

```
1. SUBJECT     → Who or what, with physical specifics
2. CONTEXT     → Where, when, situation
3. COMPOSITION → Shot size, angle, framing, lens
4. LIGHTING    → Source + direction + quality  ← highest-impact revision
5. STYLE       → Medium, aesthetic era, rendering mode
6. CROP        → Aspect ratio and final framing note
```

> **If output looks flat: improve lighting first.** It is the single highest-impact revision.

---

### Element 1 — Subject

Specify physical attributes concretely: age range, build, hair (length + texture + color), clothing (material + color + fit), accessories, expression.

Weak → Strong:
- ❌ "A woman in a red dress" → ✅ "A woman in her late 30s, angular features, tousled dark hair, wearing a structured crimson silk dress with a halter neck, a single pearl earring, posture direct and poised"
- ❌ "An old man" → ✅ "A weathered man in his 70s, deep-set eyes, hands folded in his lap, wearing a worn brown cardigan over a white collarless shirt"
- ❌ "A coffee cup" → ✅ "A matte ceramic espresso cup, squat cylindrical form, pale grey glaze with a hairline crack on the rim, resting on dark walnut wood grain"

For non-human subjects: describe material, color, texture, surface condition, scale.

---

### Element 2 — Context

Environment, time of day, weather, situation. Provide spatial relationship cues:
- "standing alone in a dead cornfield at dusk"
- "seated at a narrow espresso bar, early morning"
- "mid-stride on rain-slicked pavement at night"

---

### Element 3 — Composition

**Shot sizes:** `extreme close-up` | `portrait` (head and shoulders) | `three-quarter portrait` | `full body` | `wide establishing shot` | `overhead top-down`

**Angles:** `eye-level` | `low angle` | `high angle` | `top-down overhead` | `Dutch angle (tilted)`

**Lens focal length:**
| Lens | Effect |
|---|---|
| `35mm lens` | Environmental, slight barrel distortion, documentary feel |
| `50mm lens` | Neutral, natural, most versatile |
| `85mm lens` | Portrait compression, flattering, background isolation |
| `macro lens` | Extreme close detail, surface texture, shallow depth |
| `wide-angle lens` | Expansive environment, immersive space |

**Depth / focus:** `shallow depth of field` | `bokeh background` | `deep green background dissolves into soft creamy bokeh` | `deep depth of field (everything sharp)` | `blurred foreground framing sharp subject`

**Composition:** `rule of thirds` | `symmetrical composition` | `negative space [direction]` | `centered` | `tight crop` | `subject occupying left third of frame`

**Environmental framing:** `framed through out-of-focus foliage in foreground` | `window frame as compositional border` | `doorway framing the subject`

---

### Element 4 — Lighting (PRIMARY QUALITY LEVER)

Always specify all three dimensions:

**Source:** `golden hour sunlight` | `overcast diffuse` | `sodium streetlight` | `neon sign glow` | `candlelight` | `softbox` | `practical window light` | `on-camera flash` | `fluorescent tube` | `firelight` | `moonlight`

**Direction:** `front-lit` | `side-lit` | `rim-lit` | `backlit` | `three-quarter key` | `top-lit` | `under-lit` | `cross-lit`

**Quality:** `soft diffused` | `hard directional` | `dappled` | `high-contrast` | `low-key` | `high-key` | `warm tungsten glow` | `cool daylight` | `dramatic shadow fill`

High-impact lighting phrases:
- "Single overhead sodium streetlight, hard shadows, deep pools of darkness below jaw and under brow"
- "Soft window light from left, warm golden undertones, shadow trailing right"
- "On-camera flash, harsh overexposure on light surfaces, flat shadows, lo-fi snapshot quality"
- "Candlelight from below chin, orange-warm flicker, deep background shadow with soft falloff"
- "Golden hour backlight, subject silhouetted, warm halo around edges"

Cinematic modifiers: `luminous shadows with cool blue undertones` | `high contrast chiaroscuro` | `low-saturation desaturated palette`

---

### Element 5 — Style / Medium / Aesthetic

**Photography styles:** `documentary photography` | `editorial fashion photography` | `street photography` | `folk horror photography` | `cinematic film still` | `product photography` | `macro photograph` | `liminal photography`

**Film / texture:** `35mm film grain` | `analog grain` | `lo-fi snapshot quality` | `visible film halation` | `slight underexposure` | `low dynamic range`

**Artistic mediums:** `digital painting` | `concept art` | `oil painting` | `watercolor illustration` | `vintage analog collage` | `retro risograph poster` | `ukiyo-e woodblock print` | `cel animation`

**Aesthetic eras:** `Y2K cyber-aesthetic` | `mid-century print` | `1970s editorial` | `1990s vintage anime` | `retro-futuristic` | `Art Nouveau`

**Rendering texture:** `smooth vinyl texture with glossy finish` | `matte clay with deep fingerprints` | `hyper-realistic 3D rendering` | `cel-shaded flat colors` | `stippled shading`

---

### Element 6 — Crop / Aspect Ratio

Close the prompt with the intended crop:

| Ratio | Best use |
|---|---|
| `1:1 square crop` | Product cards, social media, album art |
| `3:4 portrait crop` | Editorial portraits, book covers |
| `9:16 vertical crop` | Stories, vertical promos |
| `16:9 horizontal crop` | Banners, cinematic stills, key art |
| `4:3 standard crop` | Decks, print, editorial cards |

---

## Step 3 — Text Rendering (if required)

To render readable text within the image, wrap the exact target string in **double quotation marks** inside the prompt:

```
A vintage travel poster with the text "VISIT PATAGONIA" in bold condensed sans-serif, centered at the upper third, against an illustrated mountain landscape
```

Rules:
- Spell the exact characters that should appear
- Specify: weight (`bold`, `thin`), case (`all-caps`, `title case`, `lowercase`), family (`serif`, `sans-serif`, `condensed`, `script`)
- Specify: position in frame (`centered`, `lower third`, `upper right`)
- Add: `"Do not add any other text or subtitles"` if text control is critical

---

## Step 4 — Reference Strength (if style references are attached)

| Strength | Effect |
|---|---|
| 0.25 | Subtle atmospheric influence; prompt stays literal |
| 0.50 | Balanced; style and prompt share influence equally |
| 0.70–0.80 | Dominant style direction; allow prompt compression |
| 0.90+ | Style dominates; reduce prompt specificity significantly |

At 0.90+: shorten and simplify the text prompt — over-specified prompts at high reference strength produce incoherent conflicts.

**Multiple references (Moodboard):** Best for emergent aesthetics across multiple influences. Do not add single-reference modifiers; let the image cluster speak.

---

## Step 5 — Prompt Length Check

| Goal | Target |
|---|---|
| Exploration / thumbnail | 5–20 words |
| Controlled imagery, single subject | 30–80 words |
| Complex scene with full production detail | 80–140 words |

Priority order when compressing: Subject → Lighting → Style → Composition → Crop.

---

## Step 6 — Validate Before Output

- [ ] Subject has physical specifics (age, features, materials, colors) — not just role/type
- [ ] Lighting named with source + direction + quality (all three)
- [ ] Shot size and angle specified
- [ ] Lens / focal length noted
- [ ] Style medium named precisely
- [ ] Crop / aspect ratio specified
- [ ] Text wrapped in quotes if text should render in image
- [ ] No empty filler terms without observable specifics
- [ ] Original scene and subjects unchanged

---

## Step 7 — Output

```
ENHANCED PROMPT:
[Complete enhanced prompt — plain text, natural language prose, ready to paste]

NEGATIVE PROMPT:
blurry, distorted, text, watermark, logo, extra fingers, deformed hands, oversaturated, noise, JPEG artifacts, cropped head
[append per use case as needed: face asymmetry, crossed eyes — portraits / dust, scratches — product / tilted horizon — architecture]

CHANGES SUMMARY:
• [What was added or restructured — 3–5 concise bullets]
```

---

## Subject / Object Positioning Reference

**Spatial layer:** `in the foreground` | `in the deep background` | `mid-ground` | `in the near field`

**Frame anchor:** `lower left corner` | `upper right` | `center frame` | `occupying left third of frame` | `upper center` | `lower third`

**Size as depth cue:** "a tiny figure against a vast mountain landscape" / "a colossal weathered stone guardian towering above"

**Foreground framing:** `framed through out-of-focus branches in foreground` | `foreground elements blurred, subject in mid-ground sharp`

**Layer separation:** `subject in sharp focus, background dissolves into soft creamy bokeh`
