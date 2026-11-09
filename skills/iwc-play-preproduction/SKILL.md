---
name: iwc-play-preproduction
description: >
  Use when the task prompt says "Load and use skill: iwc-play-preproduction", or asks to turn an
  iWantClips episode's play (play.md + play.srt audio script) into a visual plan of loopable
  cam-style clips. Produces visual_plan.md and visual_plan.json (beat groups, phases, one loop
  clip per phase with its catalog body pose, storyboard camera, set, outfit, items and action)
  and screenplay.md (play.md copied verbatim - this production has no screenplay). Do NOT invoke
  for the character table (iwc-loop-cast), the scene list (iwc-loop-scenes), designs or
  storyboards (plan-designs, storyboard-scene) or shooting loops (iwc-loop-clip).
agentType: worker
---

# Play pre-production: audio script → loop clip plan

The episode is an AUDIO clip (her voice over the whole runtime). The visuals are a cam-girl
style counterpart: ONE adult woman (the play's character) on camera, seducing, moving, teasing,
touching herself, partly undressing and redressing. Clips are expensive, so the audio is covered
by a FEW loopable clips, each repeated over its part of the audio. You plan them; nothing is
rendered here.

`play.md` is the AUTHORITATIVE source of the production. There is no screenplay adaptation: the
only "screenplay" is play.md copied verbatim (step 5b).

Downstream (so you know what your fields feed): `iwc-loop-cast` writes the character table (one
wardrobe row per outfit of this plan), `iwc-loop-scenes` writes the scene list (scene n = clip n,
ONE beat per scene = the clip's anchor), `plan-designs` creates the character, outfit, location
and storyboard designs from them, and `iwc-loop-clip` renders each loop from its storyboard frame.

## 1. Preflight

Task prompt fields: `inputs` (the artifact key of the episode inputs, default `episode_inputs`),
`window` (`mm:ss-mm:ss`, the part of the audio to cover; default: all), `loop_seconds` (default
25, allowed 20-30), `max_clips` (upper bound from the budget), `max_repeats` (default 4).

`read_artifact` the inputs: `play.md` (sections: kink, goal, character, arc, script) and
`play.srt` (every spoken line AND sound-only cue with time codes). `task_failed(reason)` if either
file is missing or the window lies outside the script.

## 1b. Central kinks → visual vocabulary

Read play.md sections 1-2 (featured kinks, goal / feeling, listener journey). For each central kink
write in `kinks[]` how it is SHOWN on camera, so every clip can reinforce it:
- the body language and motions that read as this kink (gooning: slow hypnotic rhythm, swaying,
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
  herself, a close camera on the worshipped body part, eye level for the girlfriend intimacy of
  a goon-along. The camera is always locked off: the choice is angle, height and distance, never
  a move.
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

  N = min( max_clips, max( number of arc spans in the window, ceil(window_seconds / (loop_seconds × max_repeats)) ) )

Merge or split phases until there are exactly N, each phase at most `loop_seconds × max_repeats`
long where possible. One phase = one clip, repeated (looped) over the phase's duration.

## 4. Per clip: anchor, outfit, action

For each clip decide, in the persona's style (play.md section 3) and the phase's audio:

- **Set** (`set_id`): where the clip plays, decided by its beat groups (what she says, the
  arc span, the intensity and the play's kink / goal). At most 3 distinct sets for the whole
  episode, reused across clips; one set is right when the script stays in one place (a bedroom
  can be enough). A new set only where the audio implies it (she runs a bath, sits at a vanity,
  lounges on a sofa, is "at her desk"), never for variety alone. Describe each set concretely so
  it renders with character, not flat: room type, the surface she uses as the stage, light (key
  light, practicals, colour accents), 3-5 background props, mood. The camera is always a webcam
  view (vertical 9:16, locked off) at the clips' height. Note the reason per clip
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
    `medium full` or `full shot` (portrait canvas: the widest is one person `full shot`; never
    `wide`). A close framing names the body part (`close-up on her feet`).
  - `height`: ONE of `eye level`, `low angle`, `high angle`, `top-down`. Use the EXTREME words only
    when truly meant: `worm's-eye view` (the lens on the floor looking straight up) and `top-down`
    (directly overhead looking straight down). An everyday low or high webcam is `low angle` /
    `high angle`: only extreme heights are checked as a major miss, so an extreme word for a mild
    angle makes every take fail.
  - `direction`: ONE of `from the front`, `three-quarter angle from her left side`,
    `three-quarter angle from her right side`, `from her left side`, `from her right side`,
    `from behind` (her OWN left / right).
  - `line`: the full camera line as the storyboard writes it, framing first, then height, then
    direction, e.g. `medium shot, low angle, from the front` or `full shot, high angle,
    three-quarter angle from her left side`.
  - `why`: the kink focus and power dynamic it serves, from play.md.
  Pick the angle the kink needs, not a default; keep it plausible for a webcam or phone on a
  tripod. Locked off: no move, no zoom. The anchor pose must read from that angle (the face visible
  from below, the worshipped part toward the lens).
- **Outfit** (`outfit_id`): at most 3 distinct outfits for the whole episode, reused across clips;
  describe garments, colours and materials precisely (they are rendered as reference images).
  Outfit ids are lowercase snake_case look slugs naming the outfit (`black_silk_slip`,
  `lace_bra_set`): they become the character table's wardrobe rows and the outfit design keys.
  Choose each outfit to reinforce the kinks of the clips that wear it (`kinks[]` outfit details)
  and to allow the clip's reveal and the furniture use (a slip that rides up when she straddles, a
  front-closing bra for a reveal, stockings for foot / leg focus).
  `nude` is a clip outfit (`outfit_id: "nude"`) but NOT an entry of `outfits[]` (her design's base
  picture is nude). The brand details (wide black velvet choker, small silver key pendant on a
  thin silver chain, violet nail polish) stay on in every outfit: they are the character's marks,
  never listed as an outfit's garments or accessories. NO pose views on outfits: each clip's
  catalog `body_pose` drives the storyboard's pose checks instead.
- **Anchor pose**: the pose the clip STARTS and ENDS in (the loop seam). Choose a stable,
  easy-to-return-to pose that suits the phase and a static webcam framing. Name it in `body_pose`
  as a platform POSE CATALOG name for one person, exactly as written: `kneeling upright`,
  `lying on the stomach`, `sitting on the edge of a bed`, `sitting on a chair`, `sitting
  cross-legged`, `crouching`, `leaning against a wall`, `standing with arms crossed`, `walking`
  (never for an anchor), `lying on the back reading` (only with a book). A catalog name is stated
  limb by limb and checked on every take, so prefer the closest catalog name; only when none is
  close write `other (<geometry>)`: what carries her weight, torso angle and facing, each arm and
  leg (`other (lying on her back across the bed, knees bent and apart, feet flat on the
  mattress)`). Put the rest in `anchor_pose` (hands, head, gaze, where on the stage) and the
  furniture contact in `anchor_contact` (`Vesper's knees and shins on the mattress; her hands on
  her thighs`: plain body parts on the furniture). List the poses she passes through inside the
  loop in `loop_poses` (catalog names; usually 1-2, ending back in `body_pose`).
- **Act-free anchor**: at 0 % and 100 % no sex act is in progress (no hand inside the panties, no
  toy in use, no fingers inside her). The scene list's anchor beat cannot carry an act (see
  `iwc-loop-scenes`, "Act-free anchor"): an act STARTS a moment into the clip (15 %) and ENDS
  before the return (80 %). An item held at the anchor is only in her hand or beside her.
- **Action timeline** (loop rule): 0-15 % she settles out of the anchor; 15-80 % the move of the
  phase (sway, slow hip rolls, hands over her body, a tease or reveal: pulling a strap down,
  lifting a hem, sliding panties aside, showing the focus body part to the camera, self touch);
  80-100 % she returns EXACTLY to the anchor pose, garments back as they were at 0 %. Anything
  undressed in the loop is redressed before the end (a nude outfit stays nude). One continuous
  take, no cut, large readable motions (small finger or blink motions render static).
- **Kink focus** (`kink_focus`, `reinforcement`): which central kink(s) the clip serves (from its
  beat groups) and ONE line per channel how it is reinforced: outfit (the worn detail that signals
  it), action (the motions from `kinks[]`), set / furniture (the piece and its use), items (the
  handheld props), camera (angle / height / distance). A clip with no reinforcement on a channel
  says why.
- **Worship focus**: when `body_focus` is set, the framing and the action feature that body part
  (feet toward the lens, breasts presented, ass to the camera …).
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
  `window`, `loop_seconds`, `clips_n` and `outfits`; then add `kinks`, `sets`, `groups` and each
  clip with `sandbox_exec` and a short python3 snippet that loads the file, appends one part and
  saves it (one call per few groups, one call per clip);
- `visual_plan.md`: first `sandbox_write_file` the summary, then append each further section
  with `sandbox_exec` (`cat >> <file> <<'EOF' … EOF`), one call per section / per clip;
- at the end `sandbox_exec` `python3 -m json.tool <file> > /dev/null` to prove the JSON is valid.

**visual_plan.json**
```json
{"window": "00:00-08:00", "loop_seconds": 25, "clips_n": 5,
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
            "repeats": 4.8, "set_id": "bed_corner", "set_reason": "…",
            "furniture_use": "kneels on the bed, rides a pillow",
            "items": [{"item": "…", "at_anchor": "…", "use": "…"}],
            "camera": {"framing": "medium", "height": "eye level", "direction": "from the front",
                       "line": "medium shot, eye level, from the front", "why": "…"},
            "kink_focus": ["gooning"], "reinforcement": {"outfit": "…", "action": "…", "set": "…",
                                                          "items": "…", "camera": "…"},
            "outfit_id": "black_silk_slip", "body_pose": "kneeling upright",
            "loop_poses": ["…"], "anchor_pose": "…", "anchor_contact": "…",
            "body_focus": "none", "intensity": 2,
            "action": "0-15%: … 15-80%: … 80-100%: back to the anchor, …",
            "shot_description": "2-3 sentences: what we see, how she behaves",
            "reveal": "none | which garment opens and closes again"}]}
```

**visual_plan.md**: the same as tables for a human reviewer: a summary (window, N, the
formula with the numbers), the kinks and how they show (motions, outfit, set, items, camera), the
sets (room shared / separate, view, why, furniture and placed items), the outfits, the beat
groups, and per clip the catalog body pose, anchor, camera line, outfit, action timeline, shot
description and the audio it covers.

## 5b. The screenplay artifact: play.md verbatim

The task's second artifact `screenplay` holds `screenplay.md` = play.md copied VERBATIM under
one header line. Never retype, summarise or rewrite it; copy it in the sandbox:
1. `sandbox_fetch({ url: "artifact://<inputs>/play.md", targetFile: "/tmp/play.md" })`;
2. `sandbox_exec`: `{ printf '%s\n\n' 'Source play, verbatim. This production has no screenplay; play.md is authoritative.'; cat /tmp/play.md; } > /workspace/<screenplay artifact id>/screenplay.md`;
3. `sandbox_exec` `tail -n +3 /workspace/<screenplay artifact id>/screenplay.md | cmp - /tmp/play.md`
   must print nothing (identical).

## 6. Pre-completion audit

Before `task_complete` check: every cue of the window belongs to exactly one group; groups are
20-30 s (the last may be shorter); N follows the formula; every clip starts and ends in its anchor
with the garments as at the start and no act in progress; at most 3 outfits and 3 sets, every
clip's set justified by its beat groups; every set has `room`, `room_id` and `view` (one `main`
per room_id, every other view a turn of at most 90°); every clip's `body_pose` is a catalog name
for one person or `other (<geometry>)`, and it has `anchor_contact`; every `camera` has a
standard `framing`, one `height` word, one `direction` and the `line` built from them (extreme
words only where truly meant); every central kink of play.md has a `kinks[]` entry and appears in
at least one clip's `kink_focus`; every clip states its `reinforcement`, `furniture_use`, `items`
and `camera`; the furniture it uses is listed in its set and every item it picks up lies in the
set's `items_placed`; outfit and set ids are snake_case; no outfit lists a brand mark or has
pose views; no clip has dialogue or a camera move; `screenplay.md` is play.md byte for byte under
the header line. Fix and rewrite before completing.
