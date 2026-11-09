---
name: iwc-play-preproduction
description: >
  Use when the task prompt says "Load and use skill: iwc-play-preproduction", or asks to turn an
  iWantClips episode's play (play.md + play.srt audio script) into a visual plan of loopable
  cam-style clips. Produces visual_plan.md and visual_plan.json (beat groups, phases, one loop
  clip per phase with its catalog body pose, storyboard camera, set, outfit, items and its short
  loop variants: one slow in-place gesture each, starting and ending on the clip's anchor)
  and screenplay.md (play.md copied verbatim - this production has no screenplay). Do NOT invoke
  for the character table (iwc-loop-cast), the scene list (iwc-loop-scenes), designs or
  storyboards (plan-designs, storyboard-scene) or shooting loops (iwc-loop-clip).
agentType: worker
---

# Play pre-production: audio script → loop clip plan

The episode is an AUDIO clip (her voice over the whole runtime). The visuals are a cam-girl
style counterpart: ONE adult woman (the play's character) on camera, seducing, moving, teasing,
touching herself, teasing. Clips are expensive, so the audio is covered by a FEW loop clips
(anchors), each played as a set of short VARIANTS that all start and end on the same anchor frame
and are repeated over the clip's part of the audio. You plan them; nothing is rendered here.

**Format and camera.** 16:9 landscape, 1080p (iWantClips clips are overwhelmingly landscape
1920x1080), filmed by a FIXED camera on a tripod: at most a very slow, subtle push in or out;
never handheld-style movement, shake, pan, orbit, zoom jumps or reframing.

**Why short variants (the v1 pilot).** 25 s loop clips cut away mid-clip into a different room,
or the model slowly pushed the camera in, and the action became a busy montage (bra down, hand in
the panties, kisses) - far too fast. A spike of 12 s variants, each ONE slow gesture in place with
the set's empty plate as an extra reference and explicit tempo and fixed-camera wording, had no
cuts; the best (her hand slowly to the key pendant, lifts it, returns) kept the background stable
and ended exactly on the anchor. Variants that moved her TOWARD the lens (a hip roll, a lean-in)
made the model push the camera in or ended off the anchor. So: slow, sensual, teasing, flirty,
seductive, and every gesture stays in place.

`play.md` is the AUTHORITATIVE source of the production. There is no screenplay adaptation: the
only "screenplay" is play.md copied verbatim (step 5b).

Downstream (so you know what your fields feed): `iwc-loop-cast` writes the character table (one
wardrobe row per outfit of this plan), `iwc-loop-scenes` writes the scene list (scene n = clip n,
the clip's anchor beat, plus an outfit-change beat where the look changes), `plan-designs`
creates the character, outfit, location and storyboard designs from them, and `iwc-loop-clip`
renders each variant of a clip from the anchor's storyboard frame.

## 1. Preflight

Task prompt fields: `inputs` (the artifact key of the episode inputs, default `episode_inputs`),
`window` (`mm:ss-mm:ss`, the part of the audio to cover; default: all), `variants` (variants per
clip, default 3, allowed 1-4), `variant_seconds` (playback seconds; default 11, allowed 10-12 - each variant renders at
1/1.5 of it and plays in slow motion, see `iwc-loop-clip`), `max_clips` (upper
bound from the budget). A clip's CYCLE is `variants × variant_seconds` (3 × 11 s = 33 s): the
variant set played once, every join on the anchor frame.

`read_artifact` the inputs: `play.md` (sections: kink, goal, character, arc, script) and
`play.srt` (every spoken line AND sound-only cue with time codes). `task_failed(reason)` if either
file is missing or the window lies outside the script.

## 1b. Central kinks → visual vocabulary

Read play.md sections 1-2 (featured kinks, goal / feeling, listener journey). For each central kink
write in `kinks[]` how it is SHOWN on camera, so every clip can reinforce it:
- the body language and motions that read as this kink, always translated into the slow,
  in-place gestures of the variants (section 4; nothing fast, nothing toward the lens) (gooning: slow hypnotic rhythm, swaying,
  rolling hips, glazed half-lidded eyes, lips parted, hands that never stop; denial / edging:
  rising tempo then a sudden stop and hold, hands lifted away, a knowing smile; chastity / key
  holding: the key pendant lifted, shown, kissed, dangled; foot / leg worship: soles and toes
  toward the lens, stockings, slow pointing and flexing; ass / breast worship: that body part
  presented to the lens, framing on it; findom: cash or a card in hand, counting; JOI / mantra:
  counting on fingers, rhythmic beat with the hand, lips mouthing a mantra);
- the outfit details that signal it (sheer stockings for legs / feet, the key pendant prominent
  for denial / chastity, lingerie that opens easily for tease and reveal, latex for a domme);
- the set elements that serve it (a bed to lie and writhe on, a chair or armchair to straddle,
  grind against or lap-dance, a mirror to show the back, a vanity to sit and display at);
- the items, tools and accessories that signal or serve it, split by how they appear:
  WORN accessories belong to the outfit (a collar, heels, gloves, cuffs worn on the wrists);
  HANDHELD items are props of a clip (the key, a crop or flogger, a leash, cuffs, a toy, a
  lollipop, cash or a card, a phone, a candle, a feather) - only what play.md's kinks, script
  or persona call for, never generic decoration;
- the camera that serves it: the angle, height and distance that express the kink's power
  dynamic and focus - derived from play.md (who dominates, what is worshipped, the listener's
  position in the fantasy), e.g. a low camera looking up at her when she dominates or is
  worshipped, a high camera looking down when the listener is the one in control or she offers
  herself, the worshipped body part turned toward the lens, eye level for the girlfriend
  intimacy of a goon-along. The camera is always fixed on a tripod: the choice is angle, height
  and distance, never a move; the framing always keeps her face and eyes in frame.
Adults only; within the workspace nudity policy.

## 2. Beat groups (20-30 s each)

Walk the SRT cues inside the window in order and cut them into beat groups:
- each group covers 20-30 s of audio (start of its first cue to the start of the next group);
- never split a sentence; prefer cuts at sound-only cues (breaths, moans) and at the arc spans
  of play.md section 4 (a group never crosses an arc span boundary);
- per group note: `id` (g1, g2 …), `start`, `end`, `arc_span`, `what_happens` (one line: what
  she says / does in the audio), `intensity` (1 calm … 5 peak), `body_focus` (none | feet | breasts
  | ass | legs | mouth | hands | full body) when the words make a body part the object of worship.

## 3. Phases → clips

Merge consecutive groups into PHASES that can share one looping visual: same arc span or a
smooth continuation, compatible intensity (±1), same body focus, same outfit state. Then fix
the number of clips N:

  cycle_seconds = variants × variant_seconds
  N = min( max_clips, max( number of arc spans in the window, ceil(window_seconds / (cycle_seconds × 4)) ) )

Merge or split phases until there are exactly N, each phase at most 4 cycles long where possible.
One phase = one clip; its variant set is repeated over the phase's duration
(`cycles = phase_seconds / cycle_seconds`, e.g. a 120 s phase = 3.6 cycles of 3 × 11 s).

## 4. Per clip: anchor, outfit, action

For each clip decide, in the persona's style (play.md section 3) and the phase's audio:

- **Set** (`set_id`): where the clip plays, decided by its beat groups (what she says, the
  arc span, the intensity and the play's kink / goal). At most 3 distinct sets for the whole
  episode, reused across clips; one set is right when the script stays in one place (a bedroom
  can be enough). A new set only where the audio implies it (she runs a bath, sits at a vanity,
  lounges on a sofa, is "at her desk"), never for variety alone. Describe each set concretely so
  it renders with character, not flat: room type, the surface she uses as the stage, light (key
  light, practicals, colour accents), 3-5 background props, mood. The camera is always a 16:9
  landscape view from a fixed tripod camera at the clips' height (a wide set: the stage and its
  surroundings fill the width). Note the reason per clip
  (`set_reason`: the beat-group words that place it).
  Set ids are lowercase snake_case words naming the space (`bed_corner`, `vanity_corner`,
  `bathroom`): they become location slugs.
- **Room** (`sets[].room`, `sets[].room_id`, `sets[].view`): every set is either
  - `room: shared` - a corner of ONE room that other sets of the plan share (the bed corner and the
    vanity corner of one bedroom). All shared sets of a room carry the same `room_id` (a snake_case
    space slug, `bedroom`) and become ONE location design of that room; each corner is a camera
    VIEW of it. The room's first set has `view: main` (its main picture); every other corner has
    `view: "<what the camera faces> (left 45°|left 90°|right 45°|right 90°)"`, the turn from the
    main picture (at most a quarter turn; a corner behind the main camera is a separate room, never
    a 180° view), e.g. `facing the vanity and its round mirror (left 90°)`.
  - `room: separate` - its own space (a bathroom, a living room): its own location design;
    `room_id` = the set id, `view: main`.
  Prefer `shared` for corners of the room the play stays in; `separate` only where the audio
  moves her to another room.
- **Furniture she uses** (`sets[].furniture`, per clip `furniture_use`): the set's furniture is
  part of the performance, not decoration. List each piece with what she can do with it where it
  fits the script and the kinks: a bed - lie across it, kneel, writhe, ride a pillow, feet up
  toward the lens; a chair or stool - straddle it, grind against the seat edge or backrest, lap
  dance on it facing the lens; an armchair / sofa - drape over the arm, sit spread, recline; a
  vanity / desk - sit on its edge, lean over it, display in its mirror; a wall or door - lean,
  press against it. Each clip names the piece it uses and how (`furniture_use`, or `none`); the
  anchor pose is ON / AGAINST that piece (sitting on the bed's edge, kneeling on the mattress),
  and the loop returns to it. Only furniture listed in the clip's set; it must be sturdy, fully
  visible and with free space around it in the set description.
- **Items** (`items`, per clip): the handheld props the clip uses from `kinks[]` (or `none`),
  each with WHERE it is at the anchor (in her hand, on the bed beside her knee, hanging from the
  choker) and what she does with it in the loop (lifts and shows the key, taps the crop on her
  palm, slides the toy along her thigh). Loop rule: the item is back where it was at the anchor
  at the end. Items she picks up during the loop must lie in the set within reach at the anchor
  (list them in the set's `items_placed`). Worn accessories go into the outfit, never here.
  Props are never part of the character or outfit designs (a prop in a reference picture leaks
  into every render built on it). An item at the anchor exists only as words (the scene list's
  Contact) - it gets no design and no item check.
- **Camera** (`camera`, per clip) in the STORYBOARD camera vocabulary, because it becomes the scene
  beat's `Framing` and the storyboard shot's `Camera:` line, which the take check reads word by word:
  - `framing`: ONE standard size - `extreme close-up`, `close-up`, `medium close-up`, `medium`,
    `medium full` or `full shot` (one person on a 16:9 landscape canvas: the widest is `full
    shot`; never `wide`). The ANCHOR framing always shows her face and eyes: at least a `medium`
    shot (`medium`, `medium full`, `full shot`), a `full shot` for full-body poses (lying,
    kneeling with the legs shown, feet toward the lens). Never a close-up on a body part, never
    limbs only, never a first-person view (her lap seen from above as if by the listener): a
    worshipped body part is turned toward the lens inside that framing.
  - `height`: ONE of `eye level`, `low angle`, `high angle`, `top-down`. Use the EXTREME words only
    when truly meant: `worm's-eye view` (the lens on the floor looking straight up) and `top-down`
    (directly overhead looking straight down). An everyday low or high camera is `low angle` /
    `high angle`: only extreme heights are checked as a major miss, so an extreme word for a mild
    angle makes every take fail.
  - `direction`: ONE of `from the front`, `three-quarter angle from her left side`,
    `three-quarter angle from her right side`, `from her left side`, `from her right side`,
    `from behind` (her OWN left / right).
  - `line`: the full camera line as the storyboard writes it, framing first, then height, then
    direction, e.g. `medium shot, low angle, from the front` or `full shot, high angle,
    three-quarter angle from her left side`.
  - `why`: the kink focus and power dynamic it serves, from play.md.
  Pick the angle the kink needs, not a default; keep it plausible for a fixed camera on a
  tripod. Fixed: no handheld movement, no shake, no pan, no orbit, no zoom, no reframing (at most
  a very slow, subtle push in or out). The anchor pose must read from that angle (the face visible
  from below, the worshipped part toward the lens). Never name the camera equipment in any
  description (a named tripod or phone gets drawn into the picture): say where the viewpoint is.
- **Outfit** (`outfit_id`): at most 3 distinct outfits for the whole episode, reused across clips;
  describe garments, colours and materials precisely (they are rendered as reference images).
  Outfit ids are lowercase snake_case look slugs naming the outfit (`black_silk_slip`,
  `lace_bra_set`): they become the character table's wardrobe rows and the outfit design keys.
  Choose each outfit to reinforce the kinks of the clips that wear it (`kinks[]` outfit details)
  and to allow the variants' gestures and the furniture use (thin straps that can slip off a
  shoulder, a slip that rides up when she kneels, stockings for foot / leg focus). Clips in
  different outfits are fine, but each look change costs the scene list an extra outfit-change
  beat (see `iwc-loop-scenes`): change the outfit only where the audio calls for it.
  `nude` is a clip outfit (`outfit_id: "nude"`) but NOT an entry of `outfits[]` (her design's base
  picture is nude). The brand details (wide black velvet choker, small silver key pendant on a
  thin silver chain, violet nail polish) stay on in every outfit: they are the character's marks,
  never listed as an outfit's garments or accessories. NO pose views on outfits: each clip's
  catalog `body_pose` drives the storyboard's pose checks instead.
- **Anchor pose**: the pose the clip STARTS and ENDS in (the loop seam). Choose a stable,
  easy-to-return-to pose that suits the phase and a fixed 16:9 framing. Name it in `body_pose`
  as a platform POSE CATALOG name for one person, exactly as written: `kneeling upright`,
  `lying on the stomach`, `sitting on the edge of a bed`, `sitting on a chair`, `sitting
  cross-legged`, `crouching`, `leaning against a wall`, `standing with arms crossed`, `walking`
  (never for an anchor), `lying on the back reading` (only with a book). A catalog name is stated
  limb by limb and checked on every take, so prefer the closest catalog name; only when none is
  close write `other (<geometry>)`: what carries her weight, torso angle and facing, each arm and
  leg (`other (lying on her back across the bed, knees bent and apart, feet flat on the
  mattress)`). Put the rest in `anchor_pose` (hands, head, gaze, where on the stage) and the
  furniture contact in `anchor_contact` (`Vesper's knees and shins on the mattress; her hands on
  her thighs`: plain body parts on the furniture). The variants never leave this pose: she
  gestures IN it (no `loop_poses`).
- **Act-free anchor**: at the start and end of every variant no sex act is in progress (no hand
  inside the panties, no toy in use, no fingers inside her). The scene list's anchor beat cannot
  carry an act (see `iwc-loop-scenes`, "Act-free anchor"). An item held at the anchor is only in
  her hand or beside her.
- **Variants** (`variants[]`, exactly the task's `variants` count, each `variant_seconds` long):
  short loops of the SAME anchor, each starting and ending on the anchor frame, so they can be
  played in any order and repeated. Each variant is ONE slow gesture IN PLACE (at most two, one
  after the other), from this vocabulary only - none of it moves her toward or away from the lens:
  - hands: slide slowly along a thigh, over the stomach, up through her hair;
  - the key pendant: her fingers find it, lift it, toy with it, let it fall back to her chest;
  - head: a slow tilt, chin down then up, a look away and slowly back to the lens;
  - shoulders / straps: a strap slips off a shoulder and is slowly pulled back up;
  - a slow hip sway or roll that stays on the spot (her knees / seat / feet do not move);
  - breathing and a slow smile.
  NOT allowed: leaning toward the lens, crawling, standing up, turning away fully, lying down or
  sitting up, any change of the support, any garment coming off beyond a strap slipping and
  pulled back, any sex act. (The spike: a hip roll toward the lens made the model push the camera
  in; a lean-in ended off the anchor.)
  Each variant has `phases` with seconds that add up to `variant_seconds`: a HOLD on the anchor
  (2-3 s: eyes on the lens, a knowing smile, slow breathing), the GESTURE (5-6 s), the RETURN
  (3-4 s) ending in the EXACT anchor pose of `anchor_pose` / `anchor_contact` (hands, head, gaze,
  every strap and garment as at the start). A `mood` per variant chosen to fit the clip's kink and
  beat groups, and the set varied: one `teasing`, one `flirty`, one `sensual` (a 4th: `playful`
  or `hypnotic`). Tempo words in every gesture and phase: slow, languid, unhurried, lingering eye
  contact, playful smile; she stays at the same distance from the camera.
  Example (the spike's best variant, 12 s): hold 0-2 s (still, eyes on the lens, a knowing
  smile); gesture 2-8 s (her right hand slides slowly up from her thigh over her stomach to the
  small silver key pendant, lifts it between two fingers, holds it with a teasing look, lets it
  fall back against her chest); return 8-12 s (her hand slides slowly back down to rest flat on
  her thigh, exactly as at the start, eyes on the lens).
- **Kink focus** (`kink_focus`, `reinforcement`): which central kink(s) the clip serves (from its
  beat groups) and ONE line per channel how it is reinforced: outfit (the worn detail that signals
  it), action (the motions from `kinks[]`), set / furniture (the piece and its use), items (the
  handheld props), camera (angle / height / distance). A clip with no reinforcement on a channel
  says why.
- **Worship focus**: when `body_focus` is set, the anchor pose presents that body part inside a
  framing that keeps her face (feet toward the lens, breasts presented, the ass turned toward the
  camera with her face looking back over her shoulder), and the variants' gestures feature it
  (a hand sliding along the presented leg).
- **Sound**: no dialogue in the clip (lips closed or soft breathing; her voice is overlaid later
  from the audio script). Ambient room tone and breaths only.
- **Explicitness**: as the play's heat demands, within the workspace nudity policy. Adults only;
  never anything youthful.

## 5. Write the outputs

Write the files into the task's artifact folders (`/workspace/<artifact id>/`) in SMALL pieces:
a tool call whose arguments are too long arrives cut off and empty ("the call arrived with no
arguments"). Rules:
- keep every single write under ~2500 characters;
- `visual_plan.json`: write it compact (no indentation) with `sandbox_write_file` holding only
  `window`, `variants`, `variant_seconds`, `cycle_seconds`, `clips_n` and `outfits`; then add `kinks`, `sets`, `groups` and each
  clip with `sandbox_exec` and a short python3 snippet that loads the file, appends one part and
  saves it (one call per few groups, one call per clip);
- `visual_plan.md`: first `sandbox_write_file` the summary, then append each further section
  with `sandbox_exec` (`cat >> <file> <<'EOF' … EOF`), one call per section / per clip;
- at the end `sandbox_exec` `python3 -m json.tool <file> > /dev/null` to prove the JSON is valid.

**visual_plan.json**
```json
{"window": "00:00-08:00", "variants": 3, "variant_seconds": 12, "cycle_seconds": 36,
 "clips_n": 5, "format": "16:9 landscape 1920x1080, fixed tripod camera",
 "kinks": [{"name": "gooning", "motions": "…", "outfit": "…", "set": "…", "items": "…",
            "camera": "…"}],
 "sets": [{"id": "bed_corner", "name": "…", "room": "shared", "room_id": "bedroom",
           "room_name": "Vesper's bedroom", "view": "main",
           "description": "room, stage surface, light, props, mood",
           "furniture": [{"item": "bed", "uses": "lie across, kneel, ride a pillow"}],
           "items_placed": [{"item": "…", "where": "…"}],
           "why": "which beat groups / words place clips here"}],
 "outfits": [{"id": "black_silk_slip", "name": "…", "description": "…"}],
 "groups": [{"id": "g1", "start": "00:00.0", "end": "00:24.5", "arc_span": "00:00-02:00",
             "what_happens": "…", "intensity": 2, "body_focus": "none"}],
 "clips": [{"clip": 1, "groups": ["g1", "g2", "g3", "g4"], "start": "00:00.0", "end": "02:00.0",
            "seconds": 120.0, "cycles": 3.3, "set_id": "bed_corner", "set_reason": "…",
            "furniture_use": "kneels on the bed, rides a pillow",
            "items": [{"item": "…", "at_anchor": "…", "use": "…"}],
            "camera": {"framing": "medium", "height": "eye level", "direction": "from the front",
                       "line": "medium shot, eye level, from the front", "why": "…"},
            "kink_focus": ["gooning"], "reinforcement": {"outfit": "…", "action": "…", "set": "…",
                                                          "items": "…", "camera": "…"},
            "outfit_id": "black_silk_slip", "body_pose": "kneeling upright",
            "anchor_pose": "…", "anchor_contact": "…",
            "body_focus": "none", "intensity": 2,
            "shot_description": "2-3 sentences: what we see, how she behaves",
            "variants": [
              {"id": "v1", "mood": "teasing", "gesture": "the key pendant: lifts it, toys with it, lets it fall",
               "phases": [{"from": 0, "to": 2, "kind": "hold", "text": "still, eyes on the lens, a knowing smile"},
                          {"from": 2, "to": 8, "kind": "gesture", "text": "her right hand slides slowly up …"},
                          {"from": 8, "to": 12, "kind": "return", "text": "… exactly as at the anchor, eyes on the lens"}]},
              {"id": "v2", "mood": "flirty", "gesture": "…", "phases": ["…"]},
              {"id": "v3", "mood": "sensual", "gesture": "…", "phases": ["…"]}]}]}
```
Each variant's `phases` are contiguous from 0 to `variant_seconds`, the first a `hold`, the last a
`return` whose text ends in the anchor pose.

**visual_plan.md**: the same as tables for a human reviewer: a summary (window, N, the
formula with the numbers), the kinks and how they show (motions, outfit, set, items, camera), the
sets (room shared / separate, view, why, furniture and placed items), the outfits, the beat
groups, and per clip the catalog body pose, anchor, camera line, outfit, shot description, the
audio it covers and a variants table (id, mood, gesture, phases with seconds), plus the coverage
line: `<variants> variants × <variant_seconds> s = <cycle_seconds> s per cycle; <cycles> cycles
cover <start>-<end>`.

## 5b. The screenplay artifact: play.md verbatim

The task's second artifact `screenplay` holds `screenplay.md` = play.md copied VERBATIM under
one header line. Never retype, summarise or rewrite it; copy it in the sandbox:
1. `sandbox_fetch({ url: "artifact://<inputs>/play.md", targetFile: "/tmp/play.md" })`;
2. `sandbox_exec`: `{ printf '%s\n\n' 'Source play, verbatim. This production has no screenplay; play.md is authoritative.'; cat /tmp/play.md; } > /workspace/<screenplay artifact id>/screenplay.md`;
3. `sandbox_exec` `tail -n +3 /workspace/<screenplay artifact id>/screenplay.md | cmp - /tmp/play.md`
   must print nothing (identical).

## 6. Pre-completion audit

Before `task_complete` check: every cue of the window belongs to exactly one group; groups are
20-30 s (the last may be shorter); N follows the formula; every clip has exactly `variants`
variants, each `variant_seconds` long with contiguous phases (hold - gesture - return) ending in
the exact anchor pose, garments as at the start and no act in progress, every gesture from the
in-place vocabulary (nothing toward or away from the lens) with slow tempo words, the moods
varied; every clip states its `cycles`; every anchor framing is at least `medium` and shows her
face (no limbs-only, no first-person view); at most 3 outfits and 3 sets, every
clip's set justified by its beat groups; every set has `room`, `room_id` and `view` (one `main`
per room_id, every other view a turn of at most 90°); every clip's `body_pose` is a catalog name
for one person or `other (<geometry>)`, and it has `anchor_contact`; every `camera` has a
standard `framing`, one `height` word, one `direction` and the `line` built from them (extreme
words only where truly meant); every central kink of play.md has a `kinks[]` entry and appears in
at least one clip's `kink_focus`; every clip states its `reinforcement`, `furniture_use`, `items`
and `camera`; the furniture it uses is listed in its set and every item it picks up lies in the
set's `items_placed`; outfit and set ids are snake_case; no outfit lists a brand mark or has
pose views; no clip has dialogue or a camera move, and no
description names camera equipment; `screenplay.md` is play.md byte for byte under
the header line. Fix and rewrite before completing.
