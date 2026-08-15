---
name: prompt-writer-flux3
description: >
  Trigger when asked to write, enhance, or improve a prompt for FLUX 3, Black Forest Labs
  video model, or any FLUX workflow — e.g. "write a FLUX 3 prompt for this shot",
  "enhance this prompt for the FLUX video workflow", "write a prompt for this i2v clip".
  Produces an enhanced, model-optimised prompt ready to pass to a FLUX 3 workflow tool.
  Do NOT invoke for WAN 2.2, KREA-2, MiniMax H3, or any non-FLUX model.
agentType: worker,render
---

# FLUX 3 — Prompt Writer

## When this skill applies

Use this skill when asked to write or enhance a prompt targeting:
- FLUX 3 (any mode: t2v, i2v, v2v)
- Black Forest Labs FLUX video model

---

## Iron Laws — Non-Negotiable

1. **Never alter the scene, subjects, or core action.** Add structure — do not redirect.
2. **No invented elements.** Do not add subjects, props, or events not present in the input.
3. **Trust editorial intelligence.** FLUX 3 automatically applies appropriate camera grammar, pacing, lighting, and shot structure from semantic cues. Do NOT over-specify these — it degrades output.
4. **Brevity is correct.** A 5-word format trigger outperforms a 60-word granular description. Never pad.
5. **Mode determines scope.** In i2v: describe what happens next from the reference image, not what the image looks like. In v2v: describe what should happen next, not the source video.

---

## Step 1 — Identify the Generation Mode

Determine the mode from context — FLUX 3 uses the same endpoint for all modes; the mode is determined by what inputs are provided.

| Mode | Inputs present | Prompt covers |
|---|---|---|
| t2v | Text only | Everything: subject + action + scene + motion quality |
| i2v (1 image) | 1 image + text | What happens next: motion + camera + continuity |
| flf2v (2 images) | 2 images + text | Transition path only — not the endpoint frames |
| storyboard | Up to 10 timestamped images + text | Motion between visual checkpoints |
| v2v | Existing video + text | What should happen next — not re-description of source |

**API keyframe syntax reference:**

| Mode | Keyframes field |
|---|---|
| i2v single | `keyframes: [{ image: <url> }]` — no timestamp; defaults to t=0 |
| flf2v | `keyframes: [{ image: <start_url> }, { image: <end_url>, timestamp: <duration> }]` |
| storyboard | `keyframes: [{ image: url, timestamp: t1 }, { image: url, timestamp: t2 }, ...]` |

---

## Step 2 — Determine Enhancement Strategy

**t2v — Format-First (highest leverage)**

FLUX 3's most powerful technique: name the format alongside the subject. This automatically activates period-accurate cinematography, editorial rhythm, lighting, and sound design.

Pattern:
```
a [year] [format] about [subject]
```

Examples:
- "a 1969 documentary about Woodstock" → cinema verité, handheld cameras, period grain
- "a 1987 local news report about teenagers hanging out at the mall" → news package, standup, b-roll, period chyrons
- "archival footage of the Wright brothers' first flight in 1903. No sound" → silent film grain, sepia, locked camera
- "Visualize Frankenstein by Mary Shelley as a movie." → Gothic horror, period-accurate, all conventions inferred
- "a nature documentary about shopping carts returning to the wild" → Attenborough format on absurdist subject

**Ask yourself:** Does the subject map to a recognisable format (documentary, news report, genre film, literary adaptation, archival footage)? If yes, use the format trigger pattern. This is almost always the right approach for t2v.

If no strong format trigger applies, describe the subject + action + scene in one to two precise sentences.

---

## Step 3 — Build the Prompt

Structure around these five components. **Use only those that add information the model would not correctly infer on its own:**

```
1. Subject + Action    → Who/what moves; what happens
2. Camera Direction    → ONLY when editorial default would be wrong
3. Scene + Atmosphere  → Environment, weather, time of day
4. Motion Qualities    → Speed, weight, rhythm of movement
5. Continuity          → What must remain stable (critical for i2v / v2v)
```

Components 2–5 are optional. A format trigger on Component 1 often makes all others unnecessary.

**Camera vocabulary (use sparingly — only when the model's default would be wrong):**

| Situation | Phrase |
|---|---|
| No movement | `static composition` |
| Slow approach | `slow push-in` |
| Follow subject | `handheld follow` |
| Top-down | `overhead drift` |
| Fast sweep | `rapid pan` |
| Ground level | `low ground-level framing` |

Implied camera through scale: `"growing larger in frame"` — implies approach without specifying mechanics.
Environmental framing: `"framed through soft out-of-focus branches"` — creates depth without camera specification.

**Motion quality vocabulary (character of movement, not direction):**

| Quality | Phrases |
|---|---|
| Measured | `steadily`, `deliberate pace` |
| Leisurely | `unhurried ambling`, `languid` |
| Forceful | `thundering`, `powering through` |
| Gentle environmental | `swaying`, `mist billowing`, `dust settling` |
| Kinetic | `dust boiling off`, `surging`, `snapping through` |

**Scene + atmosphere language:**

Terrain: `dry savanna` | `alpine ridge` | `dusty construction site` | `dense urban market`
Time / light: `hazy orange sunset` | `blue hour` | `dawn mist` | `overcast grey` | `golden afternoon`
Weather: `mist billowing` | `dust catching light` | `light rain on cobblestones` | `strong wind bending grass`

---

### i2v (single image): What Happens Next

Do NOT describe the visual content of the reference image. Describe only what happens next from that state.

```
[What moves from this state] + [optional camera direction] + [optional continuity]
```

Example:
```
The elephant herd continues walking steadily toward the camera as the sun sinks lower, growing larger in frame.
```

---

### flf2v (two images): Transition Path Only

Do NOT describe the visual endpoints — both are anchored by the images. Describe only the motion path connecting them.

```
[Subject's motion path from start to end] + [camera behavior] + [continuity constraints]
```

Example:
```
She stands slowly from the chair, the camera holding its medium shot position, morning light consistent throughout.
```

---

### v2v: What Happens Next

Do NOT re-describe the source video. Describe what should continue.

Example:
```
The herd continues moving across the savanna as the sun descends further, the wide shot maintained.
```

---

## Step 4 — Audio Handling

Audio is generated automatically from visual semantics — do not add audio direction unless suppressing it.

- **To suppress:** Add `"No sound"` or `"No audio"` at the end of the prompt
- **Silent-era archival:** `"archival footage of X. No sound"` — adds period grain and suppresses audio together

Do NOT add quality negatives ("blurry, distorted, low quality") — FLUX 3 has no separate negative prompt field and these phrases have no effect.

---

## Step 5 — Prompt Length Check

| Mode | Target | Notes |
|---|---|---|
| t2v format-trigger | 5–15 words | Single sentence; trust editorial intelligence |
| t2v descriptive | 15–40 words | One to two sentences max |
| i2v / flf2v | 15–40 words | Motion + camera + continuity |
| storyboard | 10–20 words per segment | Plus overall scene description |
| v2v | 10–30 words | What happens next only |

**Hard rule:** If the prompt exceeds 60 words for a t2v task and is not an i2v continuity description, trim aggressively. Over-specification limits editorial intelligence.

---

## Step 6 — Validate Before Output

- [ ] Format trigger used when content is historical, documentary, genre, or literary
- [ ] Single sentence preferred for t2v; two short sentences maximum
- [ ] Camera specified ONLY when editorial default would be wrong
- [ ] Prompt under 60 words for t2v
- [ ] For i2v: only motion and continuity described — not visual appearance
- [ ] For flf2v: transition path described — not endpoint appearance
- [ ] For v2v: what happens next described — not re-description of source video
- [ ] Audio suppressed with `"No sound"` if silence required
- [ ] Original scene and subjects unchanged

---

## Step 7 — Output

```
ENHANCED PROMPT:
[Complete enhanced prompt — plain text, ready to paste directly into the workflow]

NEGATIVE PROMPT:
N/A — FLUX 3 has no separate negative prompt field. Audio suppression via "No sound" appended to prompt if needed.

CHANGES SUMMARY:
• [What was added or restructured — 3–5 concise bullets]
```

---

## Subject / Object Positioning Reference

- Scale contrast for depth: `"a tiny figure against the vast waterfall"` / `"a giraffe towering over scrubland"`
- Approach / retreat: `"growing larger in frame"` (approach) / `"receding into haze"` (retreat)
- Spatial anchor: `"low ground-level view of hiking boots"` / `"overhead drift over crowd"`
- Environmental framing: `"framed through soft out-of-focus branches"` / `"emerging from between parked vehicles"`
- Motion direction: `"swings through toward camera"` / `"powers past frame left to right"`
