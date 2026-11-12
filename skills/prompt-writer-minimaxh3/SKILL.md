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

When the task carries a `Production context` block (`Setting:` / `Style:`), obey it in every prompt: the setting decides which wardrobe, props, devices, vehicles and architecture may appear (nothing of another era), the style is the look - state it verbatim as the medium / film look and never contradict it.

## When this skill applies

Use this skill when asked to write or enhance a prompt targeting:
- MiniMax H3
- MiniMax Video (H3 series)
- Any MiniMax multimodal video model

---

## Iron Laws — Non-Negotiable

1. **Never alter the scene, subjects, or core action.** Add structure — do not redirect.
2. **No invented elements.** Do not add characters, props, or events not in the input.
3. **Always specify camera.** H3 reframes on its own when nothing is stated, so every shot states its camera: the brief's `movement:` move, `drift` (the default: the camera follows the action with a gentle drift) or a written `hold`.
4. **Observable behavior, not emotions.** Describe what a camera can see — not what characters feel. Vocal delivery is observable (audible) and is NOT covered by this ban: when the brief gives a spoken line's delivery (volume, pace, breath, pitch, a named emotion of the VOICE such as "whispered, trembling"), write it with the line (Step 6).
5. **Audio is mandatory.** MiniMax H3 generates stereo audio natively. Every brief must include `overall_soundscape` and `non_diegetic_music` fields, even if set to `"N/A"`.
6. **Use structured brief format.** Free-form prose is not accepted — output must use Template A or Template B.
7. **Looks come from the `picture_map:` and the shot block only.** When the brief has a `picture_map:` (every clip task: single cut, continuation, bundle), `subject_definitions` take each subject's look - nude, or the garments worn, a persisting state - ONLY from that subject's picture line (the text after the dash: `nude in this clip`, `wearing: wool coat`) and the shot's `Wardrobe:` / `State:` lines. Never copy a look from the style line, the story or plot text, a design's name, another shot, or your own assumption about the character (a plot that says a character wears a bikini does not dress a nude clip). A picture whose line says `face and identity only` gives face and identity, never its clothes; one that says `bare skin where garments are off` shows what is NOT worn. A person with no picture line is described by the shot block alone. **A picture line that ends `applies to shot(s) <ids> only`** is stated ONLY in those shots: in every other shot of the bundle never mention its look, garments or outfit (each shot block's `pictures:` line lists the pictures that apply to it). A brief line `garments_not_shown:` / a bundle constraint `no garment is in frame ... state no clothing or outfit` means the shot's frame cannot show the person's garments: write no clothing, outfit or "as designed" for that person in that shot - only what the frame shows. One line per `<Picture N>` / `<Video 1>` / `<Audio N>` exactly as the map names it - never invent, renumber, add or drop a picture.

---

## Medium / style rule — a non-photographic medium overrides every other ordering in this skill

When the brief, context or instruction names a MEDIUM or STYLE (comic, cartoon, illustration, cel-shaded, watercolor, anime, 3D render, painting, ...) and the medium is NON-PHOTOGRAPHIC, that medium IS the Style element: state it FIRST and VERBATIM as the medium of the prompt (for example "Children's comic illustration, bold ink outlines, flat colors, cel shading: ..."). Photography language (photo, photograph, lens, focal length, depth of field, film stock, "studio photography") only when the brief asks for a photographic look, and then only as the closing clause described below. A "reference portrait" or "plain studio backdrop" framing is composition, not a photographic medium. A medium named by the person stays inside the locked `instruction`; a rewrite or retry never drops it. Keep the negative-prompt rule: never negate the requested medium. **A photographic look is not a medium that goes first:** a style that describes how a photo was taken or what it feels like (photo, smartphone-shot, candid, documentary, 35mm film look, anamorphic cinema look, natural light, crisp and vibrant, ...) is placed AFTER the subject, the requested framing and the lighting, as a closing clause; it never changes the requested framing (a full-body reference stays full body, nothing cropped), age, skin tone, build or pose, and never overrides a lighting the brief requests, and it never replaces the subject-first ordering. A request for a photograph is honored this way, not by opening the prompt with the look.

## Step 1 — Identify the Generation Mode

Identify from context (attached inputs, workflow config, or explicit statement):

| Mode | Model weights | Inputs | Template |
|---|---|---|---|
| t2va | default | Text only | Template A — no instruction line |
| i2va | default | 1 image + text | Template A — i2va instruction line |
| fl2va | `fl2va` | 2 images + text | Template A — fl2va instruction line |
| l2va | default | 1 end-frame image + text | Template A — l2va instruction line |
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

## Step 2 — Select Template and Write the Instruction Line (if applicable)

### Template A: T2VA Brief

Three fields in this order, each starting with its label. For i2va / fl2va / l2va the instruction line comes first, then ONE blank line, then the fields (this is MiniMax's own format: MiniMax H3's Video Prompt Writing Guide, `docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` in the MiniMaxAI/MiniMax-H3 model repo):
```
[instruction line if i2va/fl2va/l2va]

integrated_multimodal_description: [Shot 1] ...

overall_soundscape:
[1–4 sentences: ambient + physical action sounds only]

non_diegetic_music:
[1–3 sentences: instrumentation, tempo, rhythm, dynamics — no mood words]
```

**Instruction line by mode — copy it exactly, filling only `N` and `S.SS`:**

t2va: no instruction line; the prompt starts with `integrated_multimodal_description: [Shot 1]`.

i2va (first frame):
```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

fl2va (first + last frame):
```
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
```

l2va (last frame):
```
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

- `N` = the number of the clip's LAST shot (1 for a single-shot clip).
- `S.SS` = the target clip duration with exactly two decimals (`8.00`, `5.50`).
- Keep each line's own spelling: the fl2va line writes `Picture 1` / `Shot 1` without brackets, the i2va and l2va lines write `<Picture 1>` / `[Shot N]` with them.
- fl2va prefers ONE shot (the model interpolates from the first frame to the last); use several only when the brief asks for cuts, and the last frame is reached at the end of the final shot.

---

### Template B: Full-Reference Brief

Six sections in this order (seven when the brief carries `continuity_constraints:`):
```
subject_definitions:
[Define all referenced subjects and media with labels]

summary:
[task-type prefix + what the video achieves — one paragraph]

retention_analysis:
[Per-asset retention level for all referenced media]

continuity_constraints:
[ONLY when the brief has a continuity_constraints section: its lines, VERBATIM]

detailed_description:
[Main body: 350–500 words; establish style BEFORE [Shot 1]]

overall_soundscape:
[1–4 sentences: ambient + physical action sounds only]

non_diegetic_music:
[1–3 sentences: instrumentation, tempo, rhythm, dynamics]
```

**`continuity_constraints:`** — the brief's `continuity_constraints:` lines are locked phrases (who faces away, what stays on or off, which states persist, the camera keeping its framing). Copy every line verbatim into this section: never drop, merge, reword or move one into the timeline, and keep each at its shot. No brief section = no section; never invent constraints.

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

### Layered prompt shape (the order the model weights)

Inside the integrated description write the blocks in this order: (1) GLOBAL STYLE - medium, look, lens / aspect, grain: what kind of film this is; (2) ASSET TAGS - ONE short line per reference image, taken from the `picture_map:` ("<Picture 2> defines <NAME> (build and wardrobe only)"), never a description of what the image already shows (describing it pulls the actor away from the environment and flattens the look); a tiled character sheet line of the map ("one character per column, each column the face above the outfit in three-quarter view; left to right: <Name A>, <Name B>") is copied as that picture's tag and every later mention of those people uses those names; (3) SEQUENCE CONTEXT - only when the brief states a sequence type (it sets the pacing), else omit; (4) the timed SHOT LIST - `[mm:ss - mm:ss]` lines in film language (size, angle, move, the action, a cut when the shot changes); (5) LIGHTING last, naming real sources. Who is where, facing which way and how much of them shows is stated once, where the timed shot list needs it - never a separate still-description paragraph.

### Shot and Cut Syntax

```
[Shot 1] [Style]. [Camera instruction]. [Scene + subjects + action + diegetic sound].
[Shot N] At MM:SS.mmm, the camera cuts to [new framing]. [Camera + action + diegetic sound].
```

Rules:
- `[Shot 1]` has NO timestamp
- All subsequent shots: `[Shot N] At MM:SS.mmm, ...` — timestamps strictly increasing, all within target duration
- A cut introduces new information: subject, space, state, viewpoint, or time
- Inside a clip the framing travels ONLY through the brief's `movement:`; never invent a move the brief does not name. The start frame is the OPENING framing: a framing travel the `movement:` writes (push in, pull out, arc, follow) is performed in full, to the end state it names. With `movement: drift` the camera follows the action gently and the framing stays near the opening one.
- Budget ~4 seconds for prop changes, handoffs, or complex actions
- Write ONLY the beats the brief states. Never add behaviour (blinks, breaths, glances, weight shifts, props, small gestures) to fill time or to reach a beat count: a short action in a long clip is stated once, and the clip simply continues from its end state.
- **The clip ends with the shot's last Motion beat.** Its end state is the clip's last state: never write what happens after it - not the next shot's action (a step, a jump, a dive, an exit, an arrival), not as "then …", not as "as the camera …". A beat that ends "her weight shifting toward the doorway" ends there; the step through it is the next clip.
- **The clip's end follows the brief's `clip_end:`.** `settles` (the brief's `end_hold:` line, or a bundle shot's `motion ... everyone: holds the end pose ...` line): write it as the last timed sentence at its time, in the clip's own words - "At 00:06.000, she stands still at the end of the room, her back to the camera; nothing moves." - the end state of the last beat, held, nobody starting anything new. `in-motion` (a cut or coverage shot follows; no `end_hold:` line): the last timed sentence is the last beat still in progress, ending inside the movement the next shot picks up - no frozen tail, nothing after it. Never fill the end with new motion, never add a hold the brief does not give.
- **One camera sentence, and it agrees with `movement:`.** A brief that names a move gets that move and nothing that contradicts it - never a static or locked-off sentence next to a pull-out, push-in, arc or pan. `movement: drift` gets one sentence of gentle drift following the action; `movement: hold` gets the static template (Step 4). A `movement_adjusted:` line is the server's note: state the `movement:` as given and mention nothing else.
- **An act that is not in frame is not performed.** A brief line `act_not_shown:` (single clip) or a `continuity_constraints:` line `the shot's act (...) goes on out of frame` names body parts that make NO motion of the act: write no rhythmic, thrusting or stroking movement, no act sounds of those parts, toward a partner who is not in frame; the people move only as the shot's timed Motion beats list. State the constraint once, in the brief's meaning (the bundle line is copied verbatim like every constraint).
- **Keep every hold, facing and out-of-frame line.** Each line of the brief that says what stays (`back to camera`, `faces away`, `never turns toward the camera`, `no part of the viewer is visible`, `nobody else`, the `Visible:` extent, the `POV:` / `camera_body:` lines) appears in the prompt - never dropped to save words (a prompt without "back to camera" turned her to the lens; one without "no part of the viewer visible" showed the viewer's legs). Restating what the start frame shows is not needed - keep the line, not a description of the picture.
- The server reads every clip prompt back against these lines before it renders; a prompt that breaks one comes back to you ONCE as a correction naming the finding and the shot lines - fix exactly those points and keep the rest.

### Bundle mode (a multi-shot brief)

A brief with a `picture_map:` and several shot blocks with absolute time windows is ONE render of consecutive shots, cut inside the clip; use Template B (`keyframe completion`).
- `subject_definitions` and `retention_analysis` come from the `picture_map:`: one line per Picture N exactly as the map names it (which keyframe at which time, which identity reference); never invent, renumber or add a picture, and take each retention level from the map.
- One `[Shot k]` per shot block, in order: `[Shot 1] [Style]. [Camera]. ...` without timestamp, then `[Shot k] At MM:SS.mmm, the camera cuts to [framing]. ...` at the block's start time exactly as the brief gives it (bundle time, never shifted or rounded). Each shot states its keyframe framing as the opening frame, its own Movement and its timed Motion / Dialogue beats at their bundle times.
- Timed beats stay timed: write each at the time the brief gives it (the clip times of the shot block, bundle time for a bundle) inside its own shot, with its mechanics and end state as the brief states them. Never move a shot's beats or lines to the clip start or into another shot's window, and never shift one to make the timeline tidier. No filler motion between beats (rule above); a shot's stretch with no beat continues from the last end state.
- Dialogue crossing a cut follows the cross-cut dialogue rules (Step 6); the scene `Audio:` goes once into `overall_soundscape`.

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

**Static shot template** - ONLY when the brief says `movement: hold` (or `static`), written positively as what the camera does:
```
Locked-off static [wide/medium/close] shot: the camera stays fixed on this framing from the first frame to the last.
```
When the brief carries `camera_hold:` (a written hold only), use its words as given (prose: write its meaning, never a field name). Never apply this template next to a camera move, and never to a shot whose brief says `movement: drift`. Never write what the camera must not do - a hold is the sentence above, nothing negated.

**Drift (the default)** - `movement: drift`: ONE sentence, "The camera follows the action with a gentle drift, keeping the subject in frame." No target, no reframing the brief does not name. **With a `camera_body:` line (a first-person camera) `movement: drift` is a gentle head sway that only turns - write the locked-head sentence of the first-person paragraph below plus "with a small natural sway of the viewer's head", never the follow-the-action sentence.**

**Dynamic shot template:**
```
The camera [movement] [toward/around/across] [target element], [ending on / to reveal] [what the frame shows when the move ends].
```

Speed and size are carried by the shot's duration, the beat times and the NAMED END STATE; amplitude words are unreliable in both directions ("large amplitude" did nothing, "small amplitude" came out large, a move plus a subject step in the same direction compounds into a travelling shot) - name the end framing and keep the subject beat short; one plain adverb ("slowly") is enough. Never combine `handheld` / shake wording with the static template; handheld is ONE short sway clause on a dynamic move.

Always write the RESULT of the move: what the frame shows when it ends ("The camera pans left slowly to reveal the green café door", "The camera arcs 45 degrees to the right around her, ending on a three-quarter view of her face"). Take the target from the brief's `Movement:` (`pan left to reveal the door`) or, without one, from the shot's own framing; never invent a target the brief does not name.

Complete camera vocabulary:
```
Push In / Pull Out
Pan Left / Pan Right
Truck Left / Truck Right
Tilt Up / Tilt Down
Pedestal Up / Pedestal Down
Arc Left / Arc Right
Follow / Lead (travel with a moving subject)
Static Shot
Rack Focus
Shake Slightly / Shake Strongly
POV
Roll Clockwise / Roll Counterclockwise
```

What each move does (keep them apart - each is a different picture):
- **Push In / Pull Out** - the camera travels toward / away from the subject: the shot size changes and the foreground slides past.
- **Zoom** - there is no lens zoom on MiniMax H3: a zoom renders like a push-in (spike 2026-11-02). Write "pushes in" / "pulls out" for a size change; never promise a flattened background or a dolly-zoom effect.
- **Pan Left / Right, Tilt Up / Down** - the camera turns IN PLACE: other things come into frame, but the side of the subject it sees does not change (spike: "pans right, ending on a three-quarter view" stayed frontal). Never write a pan or tilt to reach a new side or a new camera height.
- **Truck Left / Right** - the camera slides sideways: the subject crosses the frame, near things faster than far ones.
- **Arc Left / Arc Right** - the camera travels around the subject: the ONLY move that turns a front view into a three-quarter or side view (spike: a 45-degree arc landed on three-quarter). Convention: "arcs left" = the camera travels to ITS OWN left (counter-clockwise from above), which from a frontal camera reveals the subject's right side. State left / right, 15-45 degrees per clip and the side it ends on. **Large orbit (beyond 45 degrees) - MEASURE in the step-1 gate before relying on it:** the comma-list form "camera motion, <subject>, <scene>, slow orbit to the <side> around <subject> with large amplitude, from <start view> to <end view>" drove a full ~180-degree orbit on plain H3 (set and identity held) where the structured "arcs 45 degrees" sentence gave 30-45; use it only where the brief's `movement:` asks for more than 45 degrees, and keep the structured form for arcs up to 45.
- **Follow / Lead** - the camera travels with a moving subject and keeps its framing (there is no "Tracking Shot": write "follows <subject>", or "trucks left / right" for plain sideways travel).
- **Pedestal Up / Down** (or crane) - the camera rises / lowers: the only move that changes the camera height (eye level -> low / high angle); pair it with the tilt that keeps the subject in frame and state the angle it ends at. Its effect is small in one clip.
- **Rack focus** (no camera move): name BOTH ends - "Focus starts on [near thing], [subject] soft; then racks to [subject]; at the end [subject] is sharp and [near thing] blurred." (spike: performed). A rack focus is not a camera move: write it with the locked-off static frame sentence.

Rules: write the moves the brief's `movement:` names, in the brief's order, in one camera sentence (one move, or several when it names several, one per framing change); never combine a camera move with a fast subject action in one short clip. When the brief carries a `Lighting (scene, keep)` line, keep its phrase verbatim.

**A given movement wins.** `movement: <move>` (a shotlist / beat camera move): write exactly that move with the dynamic template, verbatim in meaning (`slow push-in` -> "The camera pushes in slowly ..."), to the end state it names. `movement: hold` (or `static`): the static template above. `movement: drift` (nothing written - the default): the drift sentence above. Never add a move of your own. In a video continuation the prompt continues `<Video 1>` without a cut; the move continues or holds that of the prior clip.

**Reveal.** A brief line `reveal_space:` says the move shows set the start frame does not (approach, follow, arc, truck, pan, crane) and names the place picture: write the revealed place from that picture, state what the frame shows when the move ends, and never invent set the picture does not show (an unpictured space comes out as invented rooms).

**Over-the-shoulder shots** (the `Camera:` line is over a person's shoulder) render as a locked-off or gently drifting frame, never a push-in: the foreground person is lost within seconds. The brief already carries `movement: drift` for them (`movement_adjusted:` is the server's note); a size change there is a separate shot, planned by the caller.

**Exits.** A take never lets its subject leave the frame completely - the model cuts on its own when it does. An exit is written as the step out of frame with the clip ending on it (the next shot picks the movement up).

**A first-person camera is the viewer's head (brief line `camera_body:`).** `POV` in the vocabulary above names a viewpoint, never a camera move: do not write "POV" as a move. When the brief carries `camera_body: the viewer's eyes (<posture>[, attached to <person>]) - <what it may do>`, the camera is the viewer's eyes and the clip obeys that line: write ONE locked-camera sentence after the camera sentence, driven by it - "The camera is locked to the viewer's head and never leaves it; it may only turn." when the line says `turns only, never translates` (a lying viewer, any viewer attached to a person, or any viewer whose shot holds the camera - the brief never offers a step or a lean next to a hold), "... it may only turn and lean in or back a little." for `leans in or back`, "... turn and step in or back." for `steps`, "... turn and walk forward." for `walks or follows`. Then state the move the brief's `Movement:` names (a turn is "The camera turns slowly to the left, ending on ..."), never a push-in, pull-out, arc, pedestal, truck, track or zoom, and never anything that shows the viewer's head or face, breaks a held contact or turns the subject: a first-person clip has no such move (the plan makes that framing change a cut). A `movement: drift` on such a shot adds only that gentle sway of the head (a turn, never a lean, step or travel). Copy `camera_body:` into the section of locked lines like any other brief constraint.

**The start-frame picture is the opening framing.** When `<Picture 1>` is the storyboard keyframe of this shot (the picture lines say so), its framing IS this shot's opening framing: write that framing as the opening, and describe a different framing only as the result of the brief's `movement:`.

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

**Timing and mid-act lines.** A spoken line starts early in the take: a line late in a long take pulled a hard cut in a spike. A brief `dialogue_note:` names a late line - write it at the time the brief gives, never moved, and keep it a clean spoken moment (the speaker's mouth free of the act). A line spoken during an act is a short utterance of at least the workflow's minimum words with the speaker's mouth outside the act, or an off-screen voiceover over the take (below).

**Preserve every word and punctuation mark verbatim inside `<d>` tags.** Each spoken line of the brief appears **exactly once** in the prompt: copy its words once, never add a word, repeat a word or a phrase (a stutter, an echo, a second take of the line), change a word or leave one out, and never write a spoken line the brief's shot does not have. A line sits in ITS OWN shot at the time the brief gives it (a bundle: bundle time), never in another shot's window.

At the moment dialogue ends: describe lips closing and speaking motion ceasing.

---

## Step 7 — Write Audio Fields

### Three audio channels — never cross-contaminate

**1. Dialogue + diegetic music** → in the timeline body only
- All spoken content via `(S1)` and `<d>[Language] text.</d>`
- Diegetic music (characters can hear it — radio, TV, live performer): describe in timeline at the moment it starts

**2. Physical action sounds + ambient environment** → `overall_soundscape` field only
- Room tone, ambient baseline - ALWAYS stated and audible at a natural level in every clip, also one without dialogue or action sounds. Write the sound sources of the scene `Audio:` ("fridge hum, rain on the window"), never a level: "quiet", "distant", "faint", "silent" may describe the place (a small dry room, a large echoing hall), not how loud the bed is. A clip is never prompted as silent or near-silent.
- Physical action sounds: footsteps, impacts, fabric rustling, breathing, machine sounds
- Non-verbal human sounds: laughter, panting, exhales
- NOT dialogue, NOT singing, NOT diegetic music

**3. Non-diegetic music** → `non_diegetic_music` field only
- Instrumentation + tempo + rhythm + dynamics
- **No abstract mood words** — not "epic", "emotional", "tense", "beautiful"

✅ `"Cinematic orchestral score, slow tempo, featuring a solitary French horn melody over sustained string dissonances, building to a peak then cutting to silence."`
❌ `"Epic and emotional music that builds tension and releases dramatically."`

Use `"N/A"` when a field has nothing to fill.

**Out-of-frame exclusions.** When the brief carries an `Out of frame:` line and the workflow has no negative-prompt port, state it in the prompt body as one exclusion sentence: `Not in frame: no <thing>, no <thing>.` (the brief's things, verbatim). Do not drop it.

---

## Step 8 — Lock Wardrobe and On-Screen Text

**Wardrobe** — name every garment and accessory the LOOK of the `picture_map:` line / the shot's `Wardrobe:` states, explicitly (H3 drifts wardrobe across long generations); a nude look names none, and no garment is added (Iron Law 7):
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

Hard upper limit: 7,000 characters and a budget of about 2,500 tokens: cut restated stills (appearance, blocking, framing the pictures already show) first, then beat descriptions - never audio or camera fields. One generation of a complicated shot stays within 15 seconds (only held conversations go longer); a longer brief is the caller's to split.

---

## Step 10 — Validate Before Output

- [ ] Mode identified; correct template selected
- [ ] i2va / fl2va / l2va: the instruction line is the first line, copied exactly (shot number `N`, duration `S.SS` with two decimals), then one blank line; the body starts with `integrated_multimodal_description: [Shot 1]`
- [ ] Camera specified in every shot: the brief's move, the drift sentence, or the positive static lock - no negated camera wording anywhere
- [ ] Every spoken line appears exactly once, word for word, in its own shot at its brief time; no beat moved out of its shot's window
- [ ] A brief with `act_not_shown:` (or the `goes on out of frame` constraint) has no motion of that act in the prompt
- [ ] A brief with `camera_body:` gets the locked-head sentence and only the moves that line allows (never a translation); POV is never written as a move
- [ ] `reveal_space:` brief: the place written from its picture; every camera move states what the frame shows when it ends; a new side of the subject only by Arc, a new camera height only by Pedestal / crane; a rack focus names where focus starts and ends
- [ ] Only the beats the brief states — no padding behaviour
- [ ] Every beat ends with an observable end state
- [ ] Every garment and accessory named for all characters
- [ ] Non-diegetic music described without mood words
- [ ] On-screen text typed exactly with typography and position
- [ ] Timestamps strictly increasing; all within target duration (4–15 integer seconds); the last segment follows `clip_end:` (`settles`: the end state held; `in-motion`: the last beat still in progress, no hold)
- [ ] Diegetic sounds in timeline body; ambient/physical in `overall_soundscape`; score in `non_diegetic_music`
- [ ] `overall_soundscape` names an audible ambient bed in natural-level words (no "quiet" / "faint" / "silent" bed)
- [ ] Speaker IDs established on first appearance; dialogue verbatim in language tags
- [ ] `<cutoff>` placed inside `</d>` after last word — not outside
- [ ] `[unclear]` placed inside `<d>` block — not outside
- [ ] fl2va + ref2va not combined in same generation
- [ ] `continuity_constraints:` copied verbatim when the brief has it (none dropped or reworded)
- [ ] Bundle: one `[Shot k]` per shot block at the brief's times; picture lines from the `picture_map:` only
- [ ] Original scene and subjects unchanged

---

## Step 11 — Output

Output the production brief directly — no wrapper template. The brief is the whole output: exactly the text the video model receives (all fields, plain text, ready to render), nothing else. No change notes or summary in it - any notes about what you changed or why go in the answer's separate `changes` field (it may be empty), never into the prompt - and no headings, titles or labels copied from your inputs (story brief, workspace facts, shot lines).

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

When the brief carries a shot's `Blocking`, `Pose`, `Frame`, `Visible`, `Sex act` or `Sex position` text (legacy `Act`), carry what the clip needs into the timed shot list ONCE, in the same meaning: who is where, facing which way, how much of them shows (the `Visible:` extent) and - for the sex act and position - the same plain words (verbatim; no euphemism, no softening, nothing added). For an explicit act, name the visible genitals, any visible body fluids and the act's motion in plain anatomical words, as the brief's `Visible anatomy (must show)` and `State (...)` lines say - never euphemisms like "joined" or "groin to groin". Do NOT restate what the start frame and the pictures already show (a still-description paragraph per shot dilutes the motion text and pulls the actor away from the environment); who is NOT visible stays out of the frame (a POV shot shows hands or forearms only). Phrases listed as `verbatim_phrases` must appear unchanged. The caller supplies the "Picture N is <name>" lines (from `image_inputs`): use exactly those lines and numbers, never renumber them and never invent a Picture line. A frame's removed element (a frame edit such as "remove the car") is never put back. Describe the action of the clip as stated (a still keyframe is one instant; the clip is the motion from its start state to its end state). Carry the brief's `Expression (<name>): … (must show)` lines into the prompt verbatim.

## Fidelity

When an `instruction` is supplied it is LOCKED: never drop or alter any element of it, never add states that were not asked for (no invented poses, sleep, etc.), and keep the prompt free of internal contradictions. You may only add image naming/order and the syntax this family requires.

## Voice references

When the brief lists voice references (a `voice_ref_k` audio input was supplied), write the line `<Audio j> is the voice-timbre reference for <Subject n> (S#).` verbatim, once per reference, in the subject definitions. `j` (the audio number), `n` and `S#` are exactly the numbers the brief gives: never renumber, never infer a speaker or subject the brief does not pair with a reference. The voice description for that speaker is the brief's voice text, passed through verbatim: never describe the voice again in different words, and never add a pitch, timbre, accent or age the brief does not state. When the brief lists no voice reference, write no `<Audio j>` line. In a continuation `<Audio 1>` is the prior clip's mixed soundtrack: when voice references are supplied never cite `<Audio 1>` as anyone's voice and give it no line; the references are `<Audio 2>` and `<Audio 3>` as the brief numbers them. A speaker the brief gives no reference keeps its voice text only: the brief's voice text for that `(S#)` goes verbatim into the first-appearance description of the speaker (pitch, timbre, age, accent, pace), outside the `<d>` tag.
