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
4. **Observable behavior, not emotions.** Describe what a camera can see — not what characters feel. Vocal delivery is observable (audible) and is NOT covered by this ban: when the brief gives a spoken line's delivery (volume, pace, breath, pitch, a named emotion of the VOICE such as "whispered, trembling"), write it with the line (Step 6).
5. **Audio is mandatory.** MiniMax H3 generates stereo audio natively. Every brief must include `overall_soundscape` and `non_diegetic_music` fields, even if set to `"N/A"`.
6. **Use structured brief format.** Free-form prose is not accepted — output must use Template A or Template B.

---

## Medium / style rule — overrides every other ordering in this skill

When the brief, context or instruction names a MEDIUM or STYLE (comic, cartoon, illustration, cel-shaded, watercolor, anime, 3D render, painting, ...), that medium IS the Style element: state it FIRST and VERBATIM as the medium of the prompt (for example "Children's comic illustration, bold ink outlines, flat colors, cel shading: ..."). Never write photography language (photo, photograph, lens, focal length, depth of field, film stock, "studio photography") unless the brief explicitly asks for a photograph. A "reference portrait" or "plain studio backdrop" framing is composition, not a photographic medium. A medium named by the person stays inside the locked `instruction`; a rewrite or retry never drops it. Keep the negative-prompt rule: never negate the requested medium.

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

> ⚠️ **Reference-video timing must be measured, not assumed.** When the brief references a prior
> clip / reference video (`<Video 1>` in ref2va / video-continuation contexts) and states timing
> information about it — e.g. "the target video resumes from its final frame at the 0.00-second
> mark", or any offset/duration claim about that source video — that timing must come from the
> reference video's REAL measured duration, obtained via the `get_video_info` tool, never assumed
> from what the source clip was originally requested or targeted to be. Generative video models
> (including MiniMax H3 itself) routinely produce output that doesn't exactly match a requested
> target duration, so a chained "prior clip" cannot be assumed to be any particular length.
> Cross-reference: MiniMax H3 requires at least ~5 frames (~0.2s at 24fps) of reference video to
> remain after any such offset is applied, or the render fails.

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
- Write ONLY the beats the brief states. Never add behaviour (blinks, breaths, glances, weight shifts, props, small gestures) to fill time or to reach a beat count: a short action in a long clip is stated once, and the clip simply continues from its end state.

### Beat Structure

Each beat = one primary change + an observable end state:
```
[Action with speed and specifics]. [End state — something a viewer can point at].
```

Strong end states: "The portafilter is now locked in the group head" ✅ / "Her hand rests flat on the table, palm down" ✅
Weak end states: "He finishes the task" ❌ / "She feels calm" ❌

### Beats come from the brief, not from the duration

The number of beats is whatever the brief states (its Action, Motion, Beat and Dialogue lines) — never a function of the clip duration. A change of state in the brief (wardrobe, pose, a prop moving) IS a beat: write it as the action in progress, from its start state to its end state.

---

## Step 4 — Specify Camera in Every Shot

**Static shot template** — ONLY when the brief says `Movement: hold` (or `static`):
```
Static [wide/medium/close] shot. The frame never moves. No push in, no tilt, no pan, no reframing.
```
Never apply this template next to a camera move, and never to a shot whose brief carries no `Movement:` (see below).

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

**A given movement wins.** When the brief carries a `Movement:` (a shotlist/beat camera move),
write exactly that move with the dynamic template, verbatim in meaning (`slow push-in` -> "The
camera pushes in slowly ..."). When the brief says `Movement: hold` (or `static`), use the static
template above, including its "no zoom / no push / no pan" refusals. When the brief carries NO `Movement:`,
state the framing from the brief (shot size, angle) and add NO camera move of your own and no static refusal list. In a video continuation the prompt continues `<Video 1>` without a cut; the move
continues or holds that of the prior clip.

**The start-frame picture is the target framing.** When `<Picture 1>` is the storyboard keyframe of this shot (the picture lines say so), its framing IS this shot's framing: write that framing, and never describe a different framing as a camera move (no "pulls out to a wide", "pushes in to a close-up" unless the brief's `Movement:` says it). A change of framing between shots is a cut, not a move inside one clip.

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

**Delivery:** when the brief states how a line is spoken (emotion of the voice, volume, pace, breath, pitch), write it right before the tag, in the brief's words: `(S1) speaks, in a low, breathy, hesitant voice: <d>[English] ...</d>`. Delivery is audible, so it is not an "emotion label" (Iron Law 4). Never add a delivery the brief does not give.

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

**Out-of-frame exclusions.** When the brief carries an `Out of frame:` line and the workflow has no negative-prompt port, state it in the prompt body as one exclusion sentence: `Nothing else is visible: no <thing>, no <thing>.` (the brief's things, verbatim). Do not drop it.

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
- [ ] Only the beats the brief states — no padding behaviour
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

Output the production brief directly — no wrapper template. The `prompt` is ONLY the brief itself (all fields, plain text, ready to render): never append a "CHANGES SUMMARY", notes, bullets or any commentary to it, because everything in the prompt is rendered. Notes about what you added or restructured go in the tool result's separate `changes` field, never in `prompt`.

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

## Short prompts per workflow kind

- **VIDEO workflows** (i2v / ref2v / continuation): motion and camera first; do not re-describe what the start frame or references already show.
- **EDIT workflows** (if one uses this family): the change first, at most 2 short keep locks naming only what must stay (never "keep everything else" or the composition when the camera / angle / viewpoint / framing changes: lock appearance only), no restated character or location descriptions, and one image-naming sentence ("Picture 1 is ...").
- **REFERENCE-TO-IMAGE workflows** (ref2i): describe the NEW image (subject, setting, composition, camera, light) as a scene; name each picture by its label for what it contributes ("Picture 1 is the place, Picture 2 is the character's outfit"). No edit wording, no keep locks.

## Shot facts are kept

When the brief carries a shot's `Blocking`, `Pose`, `Frame`, `Visible`, `Sex act` or `Sex position` text (legacy `Act`), carry it into the prompt in the same meaning and, for the sex act and position, in the same plain words (verbatim; no euphemism, no softening, nothing added). Who is where, facing which way, the pose and the left / centre / right placement stay as written; who is NOT visible stays out of the frame (a POV shot shows hands or forearms only). Phrases listed as `verbatim_phrases` must appear unchanged. The caller supplies the "Picture N is <name>" lines (from `image_inputs`): use exactly those lines and numbers, never renumber them and never invent a Picture line. A frame's removed element (a frame edit such as "remove the car") is never put back. Describe the action of the clip as stated (a still keyframe is one instant; the clip is the motion from its start state to its end state).

## Fidelity

When an `instruction` is supplied it is LOCKED: never drop or alter any element of it, never add states that were not asked for (no invented poses, sleep, etc.), and keep the prompt free of internal contradictions. You may only add image naming/order and the syntax this family requires.
