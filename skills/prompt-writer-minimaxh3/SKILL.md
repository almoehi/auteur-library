---
name: prompt-writer-minimaxh3
description: >
  Trigger when asked to write, enhance, or improve a prompt for MiniMax H3, MiniMax Video,
  or any MiniMax multimodal video model — e.g. "write a MiniMax H3 brief for this scene",
  "enhance this prompt for MiniMax Video", "write an i2va prompt for this shot".
  Produces a structured production brief (T2VA or Full-Reference format) ready to pass
  to a MiniMax H3 workflow tool.
  Do NOT invoke for WAN 2.2, KREA-2, FLUX 3, or any non-MiniMax model.
agentType: worker,render
---

# MiniMax H3 — Prompt Writer

## When this skill applies

Use this skill when asked to write or enhance a prompt targeting:
- MiniMax H3
- MiniMax Video (H3 series)
- Any MiniMax multimodal video model

---

## Iron Laws — Non-Negotiable

1. **Never alter the scene, subjects, or core action.** Add structure — do not redirect.
2. **No invented elements.** Do not add characters, props, or events not in the input.
3. **Always specify camera.** H3 defaults to continuous drift and reframing when nothing is stated.
4. **Observable behavior, not emotions.** Describe what a camera can see — not what characters feel.
5. **Audio is mandatory.** MiniMax H3 generates stereo audio natively. Every brief must include `overall_soundscape` and `non_diegetic_music` fields, even if set to `"N/A"`.
6. **Use structured brief format.** Free-form prose is not accepted — output must use Template A or Template B.

---

## Step 1 — Identify the Generation Mode

Identify from context (attached inputs, workflow config, or explicit statement):

| Mode | Model weights | Inputs | Template |
|---|---|---|---|
| t2va | default | Text only | Template A — no preamble |
| i2va | default | 1 image + text | Template A — i2va preamble |
| fl2va | `fl2va` | 2 images + text | Template A — fl2va dual preamble |
| l2va | default | 1 end-frame image + text | Template A — l2va preamble |
| Keyframe completion | default | Up to 6 timestamped images + text | Template B |
| ref2va | `ref2va` | Reference media + text | Template B |

> ⚠️ `fl2va` and `ref2va` model weights are mutually exclusive — a single generation cannot use both.

---

## Step 2 — Select Template and Write Preamble (if applicable)

### Template A: T2VA Brief

Three fields in this order — **do NOT include the label `integrated_multimodal_description:` in the output; start the timeline body directly with the preamble line (for i2va/fl2va/l2va) or `[Shot 1]` (for t2va)**:
```
[preamble if i2va/fl2va/l2va, then main timeline body starting with [Shot 1]]

overall_soundscape:
[1–4 sentences: ambient + physical action sounds only]

non_diegetic_music:
[1–3 sentences: instrumentation, tempo, rhythm, dynamics — no mood words]
```

**Preamble syntax by mode:**

i2va (single first-frame anchor):
```
For the target video, at 0.00 seconds, <Picture 1> is fully referenced.
```

fl2va (first + last frame):
```
For the target video, at 0.00 seconds, <Picture 1> is fully referenced. At [N] seconds, <Picture 2> is fully referenced.
```

l2va (last-frame anchor):
```
For the target video, at [N] seconds, <Picture 1> is fully referenced.
```

Where `[N]` = the target clip duration in seconds.

After the preamble, begin the timeline body immediately with `[Shot 1]`.

---

### Template B: Full-Reference Brief

Six sections in this order:
```
subject_definitions:
[Define all referenced subjects and media with labels]

summary:
[task-type prefix + what the video achieves — one paragraph]

retention_analysis:
[Per-asset retention level for all referenced media]

detailed_description:
[Main body: 350–500 words; establish style BEFORE [Shot 1]]

overall_soundscape:
[1–4 sentences: ambient + physical action sounds only]

non_diegetic_music:
[1–3 sentences: instrumentation, tempo, rhythm, dynamics]
```

**Media reference labels** — assigned by type, 1-based, independent per category. Never rename or renumber:
- Images: `<Picture 1>`, `<Picture 2>`, ...
- Videos: `<Video 1>`, `<Video 2>`, ...
- Audio: `<Audio 1>`, `<Audio 2>`, ...
- Reusable subjects: `<Subject 1>`, `<Subject 2>`, ...

**Summary task-type prefix** — choose one:
`keyframe completion` | `reference generation` | `video editing` | `video continuation` | `audio reuse` | `audio reference`

**Retention level keywords:**

For visible content:
- `fully_preserved` — all attributes retained exactly
- `partially_preserved` — core attributes retained; some variation permitted
- `attribute_transfer` — extracting a specific attribute (style, structure)
- `weak_reference` — loose inspiration; significant generation freedom

For audio:
- `fully_copy` — audio reused verbatim
- `partially_copy` — audio reused but mixed or trimmed
- `reference` — voice timbre or musical style referenced, not copied
- `weak_reference` — loose stylistic inspiration

---

## Step 3 — Write the Timeline Body

### Shot and Cut Syntax

```
[Shot 1] [Style]. [Camera instruction]. [Scene + subjects + action + diegetic sound].
[Shot N] At MM:SS.mmm, the camera cuts to [new framing]. [Camera + action + diegetic sound].
```

Rules:
- `[Shot 1]` has NO timestamp
- All subsequent shots: `[Shot N] At MM:SS.mmm, ...` — timestamps strictly increasing, all within target duration
- A cut introduces new information: subject, space, state, viewpoint, or time
- Distance or angle changes only → use camera motion, not a cut
- Budget ~4 seconds for prop changes, handoffs, or complex actions
- **Most important beat goes in the MIDDLE of the timeline — not last** (final beat is most likely compressed)

### Beat Structure

Each beat = one primary change + an observable end state:
```
[Action with speed and specifics]. [End state — something a viewer can point at].
```

Strong end states: "The portafilter is now locked in the group head" ✅ / "Her hand rests flat on the table, palm down" ✅
Weak end states: "He finishes the task" ❌ / "She feels calm" ❌

### Duration → Beat Count Reference

| Duration | Segments |
|---|---|
| ~5 seconds | 2–3 beats |
| ~8 seconds | 3–4 beats |
| ~10 seconds | 4–5 beats |
| ~15 seconds | 5–8 beats |

---

## Step 4 — Specify Camera in Every Shot

**Static shot template:**
```
Static [wide/medium/close] shot. The frame never moves. No push in, no tilt, no pan, no reframing.
```

**Dynamic shot template:**
```
The camera [movement] with [amplitude] amplitude at [speed] speed [toward/around/across] [target element].
```

Complete camera vocabulary:
```
Zoom In / Zoom Out
Push In / Pull Out
Pan Left / Pan Right
Truck Left / Truck Right
Tilt Up / Tilt Down
Pedestal Up / Pedestal Down
Arc Shot
Tracking Shot
Static Shot
Shake Slightly / Shake Strongly
POV
Roll Clockwise / Roll Counterclockwise
```

Rules: ONE camera move per shot. If static: state "frame never moves" AND list what should not happen.

---

## Step 5 — Translate Emotions to Observable Behavior

Never write emotional states — always translate to physical behavior:

| ❌ Emotion label | ✅ Observable behavior |
|---|---|
| "she looks anxious" | "her gaze is fixed downward, fingers grip the table edge, shoulders stay raised" |
| "he seems confident" | "posture upright, gaze holds steady on camera, breathing slow" |
| "they appear excited" | "weight shifts between feet, gestures become faster, smile begins and settles" |
| "she is sad" | "eyes cast downward, jaw slightly loose, she exhales once before speaking" |
| "he is angry" | "jaw muscles tighten, one hand closes into a fist, gaze narrows and stays on target" |

---

## Step 6 — Handle Dialogue and Speaker Syntax

All spoken content must use the speaker + dialogue tag system:

**Speaker IDs:** `(S1)`, `(S2)`, ... — stable across all shots. Multi-speaker: `(S1,S2)` for simultaneous speech.

**First appearance:** Establish outside the tag — character type, age, gender, whether on-screen, pitch, timbre, speaking rate, accent.

**Dialogue tag:**
```
(S1) speaks: <d>[English] Exact words here.</d>
```

Valid language tags: `Arabic` | `Chinese` | `English` | `French` | `German` | `Italian` | `Japanese` | `Korean` | `Portuguese` | `Russian` | `Spanish`

**Voiceover:** Use exact phrase `"says in an off-screen voiceover"`; immediately after the `<d>` block, state that lips remain completely closed.

**Speech truncated by end of video** — place `<cutoff>` immediately inside the closing `</d>` tag, after the last word:
```
<d>[English] I was just about to<cutoff></d>
```

**Unintelligible spans** — write `[unclear]` inside the `<d>` block in place of the indistinct words:
```
<d>[English] He said [unclear] and walked away.</d>
```

**Cross-cut dialogue** — when the same line crosses a shot cut, place `<scenetrans>` at BOTH connection points:
```
[Shot 2] ... (S1) begins: <d>[English] Follow the wind,<scenetrans></d>
[Shot 3] At 00:05.000, ... <scenetrans>(S1) continues: <d>[English] live free.</d>
```
State the audio continues: "continues seamlessly across the cut" / "carries over from the previous shot."

**Preserve every word and punctuation mark verbatim inside `<d>` tags.**

At the moment dialogue ends: describe lips closing and speaking motion ceasing.

---

## Step 7 — Write Audio Fields

### Three audio channels — never cross-contaminate

**1. Dialogue + diegetic music** → in the timeline body only
- All spoken content via `(S1)` and `<d>[Language] text.</d>`
- Diegetic music (characters can hear it — radio, TV, live performer): describe in timeline at the moment it starts

**2. Physical action sounds + ambient environment** → `overall_soundscape` field only
- Room tone, ambient baseline
- Physical action sounds: footsteps, impacts, fabric rustling, breathing, machine sounds
- Non-verbal human sounds: laughter, panting, exhales
- NOT dialogue, NOT singing, NOT diegetic music

**3. Non-diegetic music** → `non_diegetic_music` field only
- Instrumentation + tempo + rhythm + dynamics
- **No abstract mood words** — not "epic", "emotional", "tense", "beautiful"

✅ `"Cinematic orchestral score, slow tempo, featuring a solitary French horn melody over sustained string dissonances, building to a peak then cutting to silence."`
❌ `"Epic and emotional music that builds tension and releases dramatically."`

Use `"N/A"` when a field has nothing to fill.

---

## Step 8 — Lock Wardrobe and On-Screen Text

**Wardrobe** — name every garment and accessory explicitly (H3 drifts wardrobe across long generations):
```
"Preserve [hair description], [top garment + material], [bottom garment], [outer layer], [accessories], [footwear]."
```

**On-screen text** — always type the exact string:
```
A [position] title card reads "[EXACT STRING]" in [weight], [case], [family], [frame position].
Do not misspell it. Do not add any other text. Do not add subtitles.
```

Typography controls: `condensed` | `all-caps` | `lowercase` | `serif` | `sans-serif` | `tracked wide` | `bold` | `thin` | `italic` | `monospace`
Position: `centered` | `lower third` | `upper center` | `overlaid full-frame`

---

## Step 9 — Prompt Length Check

| Mode | Recommended length |
|---|---|
| t2va, simple scene | 200–400 words |
| t2va, multi-shot | 400–700 words |
| i2va / l2va | 150–350 words |
| fl2va | 100–250 words |
| Keyframe completion | 350–600 words |
| ref2va | 400–800 words |

Hard upper limit: 7,000 characters. At 800+ words, prune beat descriptions — never omit audio or camera fields.

---

## Step 10 — Validate Before Output

- [ ] Mode identified; correct template selected
- [ ] Preamble line(s) present for i2va / fl2va / l2va
- [ ] Camera specified in every shot OR explicit static lock with refusal list stated
- [ ] Most important action placed in middle of timeline
- [ ] Every beat ends with an observable end state
- [ ] Every garment and accessory named for all characters
- [ ] Non-diegetic music described without mood words
- [ ] On-screen text typed exactly with typography and position
- [ ] Timestamps strictly increasing; all within target duration (4–15 integer seconds)
- [ ] Diegetic sounds in timeline body; ambient/physical in `overall_soundscape`; score in `non_diegetic_music`
- [ ] Speaker IDs established on first appearance; dialogue verbatim in language tags
- [ ] `<cutoff>` placed inside `</d>` after last word — not outside
- [ ] `[unclear]` placed inside `<d>` block — not outside
- [ ] fl2va + ref2va not combined in same generation
- [ ] Original scene and subjects unchanged

---

## Step 11 — Output

Output the production brief directly — no wrapper template. MiniMax H3 uses a different output format from other models:

```
[Complete T2VA or Full-Reference brief — all fields, plain text, ready to paste]

CHANGES SUMMARY:
• [What was added or restructured — 3–5 concise bullets]
```

---

## Subject / Object Positioning Reference

Frame position: `center midground` | `foreground` | `deep background` | `upper left` | `lower right` | `left of center` | `silhouetted against [light source]` | `flanking the main subject`

Observable positioning: describe physical spatial relationship to environment — "standing at the counter, facing the espresso machine, back to camera" rather than "positioned in the middle of the scene."

---

## Lighting and Visual Style Reference

**Lighting:** `soft front-side key light` | `warm interior light` | `cool white mist-light` | `high-contrast lighting` | `golden hour warm wash` | `fluorescent flicker` | `backlit with exposure breathing`

**Film texture:** `fine grain` | `coarse noise` | `soft highlight halation` | `35mm film stock aesthetic` | `VHS signal` | `analog gate weave` | `chromatic aberration`

**Style labels** (place at start of [Shot 1]):
`Cinematic, live-action` | `2D-animated` | `3D CG` | `claymation` | `watercolor` | `vintage film` | `Wes Anderson-inspired 35mm` | `film noir` | `photoreal cinematic`
