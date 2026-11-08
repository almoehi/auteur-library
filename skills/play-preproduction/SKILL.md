---
name: play-preproduction
description: >
  Use when the task prompt says "Load and use skill: play-preproduction", or asks to turn an
  episode's play (play.md + play.srt audio script) into a visual plan of loopable cam-style clips.
  Produces visual_plan.md and visual_plan.json: beat groups of the audio, the phases they form,
  and one loop clip per phase with its anchor pose, outfit, focus and a short shot description.
  Do NOT invoke for rendering images or clips, character / outfit designs, storyboards
  (loop-designs) or shooting loops (loop-clip).
agentType: worker
---

# Play pre-production: audio script → loop clip plan

The episode is an AUDIO clip (her voice over the whole runtime). The visuals are a cam-girl
style counterpart: ONE adult woman (the play's character) on camera, seducing, moving, teasing,
touching herself, partly undressing and redressing. Clips are expensive, so the audio is covered
by a FEW loopable clips, each repeated over its part of the audio. You plan them; nothing is
rendered here.

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
  worshipped (a squat that opens and closes her knees above the lens), a high camera looking
  down when the listener is the one in control or she offers herself, a close camera on the
  worshipped body part, eye level for the girlfriend intimacy of a goon-along. The camera is
  always locked off: the choice is angle, height and distance, never a move.
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
- **Furniture she uses** (`sets[].furniture`, per clip `furniture_use`): the set's furniture is
  part of the performance, not decoration. List each piece with what she can do with it where it
  fits the script and the kinks: a bed - lie across it, kneel, writhe, ride a pillow, feet up
  toward the lens; a chair or stool - straddle it, grind against the seat edge or backrest, lap
  dance on it facing the lens; an armchair / sofa - drape over the arm, sit spread, recline; a
  vanity / desk - sit on its edge, lean over it, display in its mirror; a wall or door - lean,
  press against it. Each clip names the piece it uses and how (`furniture_use`, or `none`); the
  anchor pose is ON / AGAINST that piece (sitting on the bed's edge, straddling the chair), and the
  loop returns to it. Only furniture listed in the clip's set; it must be sturdy, fully visible
  and with free space around it in the set description.
- **Items** (`items`, per clip): the handheld props the clip uses from `kinks[]` (or `none`),
  each with WHERE it is at the anchor (in her hand, on the bed beside her knee, hanging from the
  choker) and what she does with it in the loop (lifts and shows the key, taps the crop on her
  palm, slides the toy along her thigh). Loop rule: the item is back where it was at the anchor
  at the end. Items she picks up during the loop must lie in the set within reach at the anchor
  (list them in the set's `items_placed`). Worn accessories go into the outfit, never here.
  Props are never part of the character or outfit designs (a prop in a reference picture leaks
  into every render built on it).
- **Camera** (`camera`, per clip): `angle` (eye level / low looking up / high looking down /
  overhead / floor level), `height` (relative to her: below her knees, hips, chest, eyes, above
  her head), `distance` (close-up of a body part / medium-close / medium / full body) and `why`
  (the kink focus and power dynamic it serves, from play.md). Pick the angle the kink needs,
  not a default; keep it plausible for a webcam or phone on a tripod. Locked off: no move, no
  zoom. The anchor pose must read from that angle (the face visible from below, the worshipped
  part toward the lens).
- **Pose views** (per outfit, `outfits[].pose_views`): the anchor `body_pose` of every clip that
  wears the outfit (deduplicated) - these become named pose views of the outfit design and drive
  the keyframes. Each entry is a view label of at most 80 characters that names the BODY only
  (posture, limbs, hands, head, facing - no bed, floor, room or props: the pose view is drawn
  without surroundings), e.g. "kneeling upright, sitting back on the heels, hands flat on the
  thighs". Merge clips whose anchors differ only in small details into one view. At most 10 per
  outfit (the design's front / profile / back standard views are made automatically and do not
  count).
- **Outfit** (`outfit_id`): at most 3 distinct outfits for the whole episode, reused across clips;
  describe garments, colours and materials precisely (they are rendered as reference images).
  Choose each outfit to reinforce the kinks of the clips that wear it (`kinks[]` outfit details)
  and to allow the clip's reveal and the furniture use (a slip that rides up when she straddles, a
  front-closing bra for a reveal, stockings for foot / leg focus).
  `nude` is an outfit. The brand details (black velvet choker, silver key pendant, violet nails)
  stay on in every outfit: they are the character's marks, never listed as an outfit's garments.
- **Anchor pose**: the pose the clip STARTS and ENDS in (the loop seam). Choose a stable,
  easy-to-return-to pose that suits the phase and a static webcam framing. Name it as a catalog
  body pose in `body_pose` (the one-person names of `workflow-calling-conventions` "Body poses":
  `kneeling upright`, `sitting on the edge of a bed`, `lying on the stomach`, `sitting
  cross-legged`, `crouching`, …; `other (<plain words>)` only when none is close) and add the
  detail in `anchor_pose` (arms, hands, head, gaze, where on the stage). Name framing (medium /
  medium-close / full body) and camera height. Camera is LOCKED OFF (a webcam on a tripod): no
  camera move. List the poses she passes through inside the loop in `loop_poses` (catalog names;
  usually 1-2, ending back in `body_pose`).
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

Write the files into the task's artifact folder (`/workspace/<artifact id>/`) in SMALL pieces:
a tool call whose arguments are too long arrives cut off and empty ("the call arrived with no
arguments"). Rules:
- keep every single write under ~2500 characters;
- `visual_plan.json`: write it compact (no indentation) with `sandbox_write_file` holding only
  `window`, `loop_seconds`, `clips_n` and `outfits`; then add `groups` and each clip with
  `sandbox_exec` and a short python3 snippet that loads the file, appends one part and saves it
  (one call per few groups, one call per clip);
- `visual_plan.md`: first `sandbox_write_file` the summary, then append each further section
  with `sandbox_exec` (`cat >> <file> <<'EOF' … EOF`), one call per section / per clip;
- at the end `sandbox_exec` `python3 -m json.tool <file> > /dev/null` to prove the JSON is valid.

The two files:

**visual_plan.json**
```json
{"window": "00:00-08:00", "loop_seconds": 25, "clips_n": 5,
 "kinks": [{"name": "gooning", "motions": "…", "outfit": "…", "set": "…", "items": "…",
            "camera": "…"}],
 "sets": [{"id": "s1", "name": "…", "description": "room, stage surface, light, props, mood",
           "furniture": [{"item": "bed", "uses": "lie across, kneel, ride a pillow"}],
           "items_placed": [{"item": "…", "where": "…"}],
           "why": "which beat groups / words place clips here"}],
 "outfits": [{"id": "o1", "name": "…", "description": "…",
              "pose_views": ["kneeling upright", "lying on the stomach"]}],
 "groups": [{"id": "g1", "start": "00:00.0", "end": "00:24.5", "arc_span": "00:00-02:00",
             "what_happens": "…", "intensity": 2, "body_focus": "none"}],
 "clips": [{"clip": 1, "groups": ["g1", "g2", "g3", "g4"], "start": "00:00.0", "end": "02:00.0",
            "repeats": 4.8, "set_id": "s1", "set_reason": "…", "furniture_use": "kneels on the bed, rides a pillow",
            "items": [{"item": "…", "at_anchor": "…", "use": "…"}],
            "camera": {"angle": "low looking up", "height": "below her knees", "distance": "full body",
                       "why": "…"},
            "kink_focus": ["gooning"], "reinforcement": {"outfit": "…", "action": "…", "set": "…",
                                                          "items": "…", "camera": "…"}, "outfit_id": "o1", "body_pose": "kneeling upright", "loop_poses": ["…"], "anchor_pose": "…", "framing": "…",
            "body_focus": "none", "intensity": 2,
            "action": "0-15%: … 15-80%: … 80-100%: back to the anchor, …",
            "shot_description": "2-3 sentences: what we see, how she behaves",
            "reveal": "none | which garment opens and closes again"}]}
```

**visual_plan.md**: the same as tables for a human reviewer: a summary (window, N, the
formula with the numbers), the kinks and how they show (motions, outfit, set, items, camera), the sets
(with why, furniture and placed items), the outfits, the beat groups, and per clip the anchor, outfit, action
timeline, shot description and the audio it covers.

## 6. Pre-completion audit

Before `task_complete` check: every cue of the window belongs to exactly one group; groups are
20-30 s (the last may be shorter); N follows the formula; every clip starts and ends in its anchor
with the garments as at the start; at most 3 outfits and 3 sets, every clip's set justified by
its beat groups; every clip's anchor covered by a `pose_views` entry of its outfit (at most 10, each at most 80
characters, body only); every central kink of play.md has a `kinks[]` entry and appears in at
least one clip's `kink_focus`; every clip states its `reinforcement`, `furniture_use`, `items` and `camera`; the furniture it
uses is listed in its set and every item it picks up lies in the set's `items_placed`; no clip
has a camera move; no clip has dialogue or a camera move.
Fix and rewrite before completing.
