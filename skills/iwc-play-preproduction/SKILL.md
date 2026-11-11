---
name: iwc-play-preproduction
description: >
  Use when the task prompt says "Load and use skill: iwc-play-preproduction", or asks to turn an
  iWantClips episode's play (play.md + play.srt) and its montage plan (montage_plan.json) into the
  visual plan of a MONTAGE: per look (camera set-up) its set, outfit, catalog body pose, anchor
  contact, items, kink reinforcement and its stills, with the plan's clip list copied verbatim.
  Produces visual_plan.md and visual_plan.json and screenplay.md (play.md copied verbatim - this
  production has no screenplay). Do NOT invoke for the character table (iwc-loop-cast), the scene
  list (iwc-loop-scenes), designs or storyboards (plan-designs, storyboard-scene) or rendering
  clips (iwc-loop-clip).
agentType: worker
---

# Play pre-production: montage plan → visual plan

The episode is an AUDIO clip (her voice over the whole runtime). The visuals are a cam-girl style
MONTAGE of ONE adult woman (the play's character): many short clips cut hard across a few LOOKS
(camera set-ups: framing, height, direction, body pose), at the pace of the episode's production
style (`production_style`, `render` of the montage plan): a slow style = each clip ONE gesture in
place, a cut every 10-15 s; a fast style = clips of 3-4 hard-cut shots in real time. Each clip starts from a STILL (a storyboard frame); a look has several stills that differ
only in small things (hands, expression, head).

**The clip list is already planned.** `montage_plan.json` (an input, made by a script from the
episode's visual profile) fixes the looks, their stills, every clip's slot on the audio, look,
still and gesture. You never add, drop, move or reorder clips, stills or looks, and never change a
gesture. Your job is what the script cannot decide: WHERE each look plays (set, room, furniture),
in WHAT (outfit, worn and handheld items), how its body pose and contact read, and how it serves
the play's kinks. Nothing is rendered here.

**Catalog tools.** Use `search_catalog` / `use_reference` ONLY as section 3b says: pose picks per
still from the `refs` catalog. NEVER the `outfit` kind and never a `garment_reference`: the
outfits stay text (more variety).

**Format and camera.** 16:9 landscape, 1080p. The camera is the plan's `render.camera_rule`
(copied into `format`, never changed). With a fixed camera (the slow style): a tripod that never
moves - no push in or out, no handheld-style movement, shake, pan, orbit, zoom or reframing (each
clip starts and ends on the same still, so a camera move can only go out and come back - the clips
read as jumps). Push-ins are a post-production effect on the finished clips. Any camera rule: a
look's stills share ONE camera set-up, and nothing moves toward or away from her inside a clip.

`play.md` is the AUTHORITATIVE source of the production. There is no screenplay adaptation: the
only "screenplay" is play.md copied verbatim (step 4b).

Downstream: `iwc-loop-cast` writes the character table (one wardrobe row per outfit of this plan),
`iwc-loop-scenes` writes the scene list (scene n = look n, one beat per still), `plan-designs`
creates the character, outfit, location and storyboard designs, and `iwc-loop-clip` renders each
look's clips from its stills.

## 1. Preflight

Task prompt fields: `inputs` (the episode inputs artifact, default `episode_inputs`).
`read_artifact` the inputs: `play.md`, `play.srt` and `montage_plan.json` (`looks` in plan order,
each with `name`, `role`, `camera`, `body_pose`, `family`, `stills[]` (`id`, `beat`, `detail`),
`whitelist`, `clips`; `clips[]` with `id`, `look`, `start`, `end`, `still`, `gesture`,
`prompt_line`, `seed`, `kind` (`reveal`, `state_change`, `multishot`); `render`, `production_style`
(labels: style, pace, camera, set, fluids), `set_style`, `nudity`, `tempo`; a still may carry
`body_state`, `fluids`, `phase`). `task_failed(reason)` if a file is missing or
the plan has no looks.

Look n = the n-th key of `looks` (plan order); it becomes scene n.

## 2. Central kinks → visual vocabulary

Read play.md sections 1-2 (featured kinks, goal / feeling, listener journey). For each central kink
write in `kinks[]` how it is SHOWN on camera:
- `motions`: the body language that reads as this kink, as in-place gestures at the episode's pace (gooning: slow
  hypnotic rhythm, glazed half-lidded eyes; denial / edging: a hand lifted away, a knowing smile;
  chastity / key: the key pendant lifted and shown; JOI: counting on fingers, a rhythm hand);
- `outfit`: the outfit details that signal it;
- `set`: the set elements that serve it (a bed to kneel on, a chair to straddle) - the set
  dressing itself (section 3) is always there: an attractive set in her style;
- `items`: worn accessories belong to the outfit; HANDHELD items are props (only what play.md's
  kinks, script or persona call for, never decoration);
- `camera`: why the plan's angles serve it (a low camera looking up when she dominates).
Adults only; within the workspace nudity policy.

## 3. Per look: set, outfit, pose, items

For each look (in plan order) decide, in the persona's style (play.md section 3) and the audio of
its clips' slots (the cues of `play.srt` inside each clip's `start`-`end`):

- **Camera** (`camera`): COPY the look's `camera` and split it into the storyboard vocabulary:
  `framing` (one of `extreme close-up`, `close-up`, `medium close-up`, `medium`, `medium full`,
  `full shot`), `height` (`eye level`, `low angle`, `high angle`, `top-down`; `worm's-eye view`
  only if the plan says so), `direction` (`from the front`, `three-quarter angle from her left
  side`, `three-quarter angle from her right side`, `from her left side`, `from her right side`,
  `from behind`), and `line` = framing + "shot", height, direction (`medium close-up shot, eye
  level, from the front`). Never change the plan's camera. Every framing keeps her FACE and EYES
  in frame: a `close-up` / `medium close-up` look is her face and chest, never a body part alone,
  never a first-person view. Write `why` (the kink focus and power dynamic it serves).
- **Set** (`set_id`): where the look plays. At most 2 sets for the whole episode (a montage cuts
  between looks every few seconds: one room keeps it one continuous session). A second set only
  where the play calls for it. Set ids are lowercase snake_case space words (`bed_corner`): they
  become location slugs.
  **The plan's `set_style` decides the KIND of set** (the production style's `set` label):
  `persona room` - her own styled space, as below; `real place` - the play's story location(s) as
  real places, dressed and lit by the same rules; `abstract` - NO real room: the place is a
  backdrop of darkness or a deep colour field with light as its subject (a halo or light ring
  behind her, a colour wash, a glow or light pattern) and one simple dressed surface she kneels or
  sits on; no walls, windows, furniture or room props, and the practicals are light shapes, not
  lamps. Every rule below still applies to its stage, backdrop, light and palette (an abstract set
  is never plain or black: it reads at every look's framing).
  **The set is HER space, dressed for her audience** - an attractive set that fits the
  episode's kinks and tone and the persona (play.md sections 1-3: her bio, style, epithets,
  signature colours and accessories), never a bare, empty, plain or anonymous one (a hotel-like
  room). A viewer should want to be there and should read who she is from it. Describe
  concretely, whatever the place (a bedroom, a living room, a bathroom, an office, outdoors):
  - the place and its style in HER taste, taken from the persona (its era, mood and signature
    colours decide the materials, e.g. velvet and candlelight, pastel and plush, chrome and neon,
    linen and daylight);
  - the stage she uses (what she kneels, sits or leans on) and how it is dressed - layered,
    textured and inviting (cushions, throws, upholstery, fabrics), never a single plain surface;
  - the backdrop behind her, which IS the background of every look (its colour, texture and what
    is on it) - at a close-up it is soft bokeh behind her head, at a wide or low angle it fills
    the frame around her: it must read at every look's framing;
  - the light: a soft flattering key on her, 2-3 practicals in the background (lamps, candles,
    string lights, a window) and ONE colour accent (a glow, a small neon, a coloured lamp) in the
    persona's palette - the background stays readable, never falling into black;
  - 4-6 background props that say who she is - styled and tidy, never clutter, no text, logos or
    screens;
  - the palette (2-3 colours plus her signature colour) and the mood.
- **Room** (`sets[].room`, `room_id`, `view`): `room: shared` - a corner of ONE room shared with
  other sets (same `room_id`, one location design; the room's first set `view: main`, every other
  corner `view: "<what the camera faces> (left 45°|left 90°|right 45°|right 90°)"`, at most a
  quarter turn); or `room: separate` - its own space (`room_id` = the set id, `view: main`).
- **Furniture** (`sets[].furniture`, per look `furniture_use`): what she kneels, sits or leans on
  for this look's body pose (the bed for `kneeling upright`, a chair for a straddle). Sturdy,
  fully visible, free space around it in the set description.
- **Outfit** (`outfit_id`): ONE outfit for the whole episode where the play allows it (a montage
  that changes clothes between cuts reads as a continuity error); at most 2. Describe garments,
  colours and materials precisely. Outfit ids are snake_case look slugs (`black_lace_set`).
  **An outfit is the garments as WORN, fully on**: cut, colour, material, fit - never a body
  part, never exposure (no "nipples above the lace", no "bare breasts", no cupless, open-cup or
  crotchless wording). The outfit design renders it as a fully worn garment over her nude base
  picture; exposure baked into an outfit is drawn as the base's skin pasted onto the fabric (iwc
  pilot v3: nipples pasted onto full lace cups). Everything that is bared is a STILL's garment
  state (below), rendered and checked per shot. Name each garment by a plain noun the
  `garment_state` can reuse (`lace bralette`, `lace briefs`, `chiffon robe`).
  `nude` is a look outfit (`outfit_id: "nude"`) but NOT an entry of `outfits[]`. The brand
  details (wide black velvet choker, small silver key pendant on a thin silver chain, violet nail
  polish) stay on in every outfit: they are the character's marks, never listed as garments.
  Choose the outfit so the look's whitelisted gestures work (a strap that can slip, a bra the
  hands can rest on). The plan's `nudity`: `none` = dressed; `conditional` = dressed stills, the
  gesture may bare more only where the gesture says so; `full` = any.
- **Body pose** (`body_pose`): COPY the look's `body_pose` (a platform POSE CATALOG name for one
  person, or `other (<geometry>)`). Put the furniture contact in `anchor_contact` (plain body
  parts on the furniture: `Vesper's knees and shins on the mattress`).
- **Garment state per still** (`garment_state`): from the still's `exposure` slot (the montage
  plan's; never more exposure than the slot):
  - `worn`: `{"wearing": [every garment], "partly": [], "removed": []}`;
  - `partly`: ONE garment displaced or open - `"<plain garment noun> (<end state>)"`, at most 60
    characters, no sequence words (`lace bralette (cups pulled down below her breasts)`, `chiffon
    robe (off both shoulders, at the elbows)`, `lace bralette (left strap off the shoulder)`); the
    OTHER garments in `wearing` (a garment is in exactly one list);
  - `removed`: ONE garment fully off (`removed: ["chiffon robe"]`), the rest worn or partly.
  The displaced garment must sit on a body part the look's framing SHOWS: a `medium close-up` /
  `medium` the chest (bralette cups, straps, the robe), a `medium full` / `full shot` the whole
  body. A `close-up` / `extreme close-up` look is face-only: its stills are always `worn` (the
  platform refuses a garment state on a face-only shot; its exposure slots move to another look of
  the episode).
  **The bared part** (`exposure_part`, set by the montage plan on every `partly` / `removed`
  still: `chest`, `ass` or `hips`): the garment state bares exactly that part - the clips of the
  still play with it (their gestures come from that part's family: a chest still's clips cup,
  squeeze or bounce the bared chest). Displace the garment that covers that part, so its skin is
  visible in the framing; an outer layer alone (a robe or jacket off the shoulders) does not bare
  it. Copy `exposure_part` into the still.
  **Vary them and make them count:** no two looks use the same partly / removed state, and the
  states escalate with the episode's `nudity` flag - with `conditional` or `full`, at least one
  state per episode bares skin under the lingerie where the framing shows it (`lace bralette
  (cups pulled down below her breasts)`, `lace bralette (pushed up above her breasts)`); an outer
  layer (a robe off the shoulders) counts once at most. Never a state the flag does not allow
  (`none`: always `worn`).
- **Stills** (`stills[]`): COPY the look's stills (`id`, `beat`, `detail`, `exposure`,
  `exposure_part`, `body_state`, `fluids`, `phase`, `loras` where set) and add
  per still `garment_state` (above), `hands` and `face`: split the plan's `detail` into the hands / arms state (`hands` - a body
  state: `one hand resting on her collarbone, the other on her thigh`) and the expression and gaze
  (`face` - `lips slightly parted, eyes on the lens`). Never change the body pose, camera, set or
  outfit between the stills of a look: they differ only in hands, head tilt, expression and the
  garment state.
- **Items** (`items`): handheld props of the look from `kinks[]` (or `none`), each with where it
  is in the stills. A look with a `state_change` clip also holds the prop its `prompt_line` uses
  (a small bottle of oil, a bowl, a glass of water): at hand beside her in the stills before it,
  set aside after. An item exists only as words (no design, no item check).
- **Body state** (`body_state`, from the montage plan per still): the fluids on her skin or hair
  (her storyboard `State:`) - COPY as is (also `fluids`, `phase`). Never in an outfit, `hands` or
  `face`; a fluid on a garment is still the body state. The plan escalates them through the
  episode and performs each first appearance in a `state_change` clip: never move or add one.
- **Act-free stills**: no sex act is in progress in any still (no hand inside the panties, no toy
  in use). A gesture may start one only where its `prompt_line` says so.
- **Kink focus** (`kink_focus`, `reinforcement`): the kink(s) the look serves and ONE line per
  channel (outfit, action = its whitelisted gestures, set / furniture, items, camera).
- **Sound**: no dialogue in any clip (her voice is overlaid later). Room tone and breaths only.

## 3b. Pose reference per still (the `refs` pose catalog)

The keyframe renderer uses a still shot's `Pose reference:` (an imported library pose, line art)
as the pose image of a pose transfer: it sets the support, torso, head AND ARMS of the one person
in the shot. The stills of a look share body pose and camera but differ in the hands, so the pick
is made PER STILL, matched to that still's `hands`; stills that match the same pose share ONE
import (an import is per pose and camera view). A look framed `close-up` or `extreme close-up`
shows her face only: NO pose pick for its stills (`pose_reference: "none"`, `pose_reason: "face-only
framing"` - the platform refuses a pose reference on a face-only shot, a pose is a body pose).
Per other look, per still, in order:
1. `search_catalog` with `catalog: "refs"`, `kinds: ["pose"]`, `k: 4`, `filters`:
   `{"solo": true, "pose_series": [...]}` - the series by the look's framing: `medium close-up`,
   `medium` → `["upper_body"]`; `medium full`, `full shot` →
   `["full_body_standard", "full_body_sexy"]`. `context` = one line: the support and torso of the
   body pose, the still's `hands` (both arms), the head, the camera line (`a woman kneeling upright,
   torso straight up, not leaning; one hand resting on her collarbone, the other arm relaxed at her
   side; head level facing the viewer; medium close-up, eye level, from the front`).
2. Accept a pick only when its title and `why` match ALL of: the support (kneeling / sitting / on
   all fours - for an `upper_body` pick the support is out of frame, so any upright upper body
   fits), the torso (upright vs leaning / bent / crouched forward - "crouched forward" or "leaning
   forward" is NOT upright), and both arms / hands of the still (hands on the collarbone, at the
   sides, on the thighs, at the pendant ~ hands near the throat). Arms that reach toward the
   viewer, cross, cup or cover the chest only when the still's hands say so. No pick fits: ONE
   more search with the context reworded; still none: `"none"` for that still (the shot is drafted
   without a pose reference) and say why in `visual_plan.md`.
3. A still whose accepted pick is an item already imported for this look with the same camera
   reuses that import. Otherwise `use_reference` with `catalog: "refs"`, the pick's `id`,
   `camera` = the look's camera `line` (the view by the camera's angle; `from behind` has none -
   then `"none"`) and `why` = the pick's `why` lines.
4. `describe_image` the imported `image.<ext>` once and compare support, torso, head and both arms
   with the still. When `describe_image` fails or is unavailable, re-read the pick's `title` /
   `why` against step 2 instead and SAY in `visual_plan.md` that the picture was not checked. A
   mismatch: drop it and take the next acceptable pick (at most 2 imports per still), else
   `"none"`.
Record per still `pose_reference` = `{"artifact": "<the artifact:// ref>", "item": "<id>",
"title": "<title>", "angle": "<angle>", "series": "<series>", "checked": "image" | "text"}` or
`"none"` (+ `pose_reason`). At most 2 searches and 2 imports per still.

## 4. Write the outputs

Write into the task's artifact folders (`/workspace/<artifact id>/`) in SMALL pieces: keep every
single write under ~2500 characters (a longer tool call arrives cut off and empty).
- `visual_plan.json`: first COPY the montage plan in the sandbox
  (`sandbox_fetch({ url: "artifact://<inputs>/montage_plan.json", targetFile: "/workspace/<artifact id>/visual_plan.json" })`),
  then add with `sandbox_exec` and short python3 snippets (load, set one part, save compact):
  `mode` = `"montage"`, `format`, `kinks`, `sets`, `outfits`, and per look (into
  `looks[<id>]`): `scene` (n), `camera` (the object above, replacing the plan's string - keep the
  plan's string as `camera_plan`), `set_id`, `set_reason`, `furniture_use`, `outfit_id`,
  `anchor_contact`, `items`, `kink_focus`, `reinforcement`, `stills` (with `hands`, `face` and
  `pose_reference` added). Never touch `clips`, `render`, `counts`, `pilot`.
- `visual_plan.md`: a summary (looks, clip count, the production style and render settings), the kinks, sets, outfits,
  and per look its scene number, camera line, set, outfit, body pose, contact, stills table (id |
  beat | hands | face) and its clips (id | slot | still | gesture). First `sandbox_write_file`,
  then append each section with `sandbox_exec` (`cat >> <file> <<'EOF' … EOF`).
- At the end `sandbox_exec` `python3 -m json.tool <file> > /dev/null` to prove the JSON is valid,
  and a python3 check that `clips` is unchanged against the input
  (`json.load(...)["clips"] == json.load(...)["clips"]`).

**visual_plan.json** (added fields, besides the copied plan):
```json
{"mode": "montage", "format": "16:9 landscape 1920x1080, <render.camera_rule>",
 "kinks": [{"name": "JOI", "motions": "…", "outfit": "…", "set": "…", "items": "…", "camera": "…"}],
 "sets": [{"id": "bed_corner", "name": "…", "room": "shared", "room_id": "bedroom",
           "room_name": "Vesper's bedroom", "view": "main", "description": "…",
           "furniture": [{"item": "bed", "uses": "kneel on the near edge"}],
           "items_placed": [], "why": "…"}],
 "outfits": [{"id": "black_lace_set", "name": "…", "description": "…"}],
 "looks": {"chest_mcu_eye": {"scene": 1, "camera_plan": "medium close-up shot, eye level, from the front",
   "camera": {"framing": "medium close-up", "height": "eye level", "direction": "from the front",
              "line": "medium close-up shot, eye level, from the front", "why": "…"},
   "set_id": "bed_corner", "set_reason": "…", "furniture_use": "kneels on the near edge of the bed",
   "outfit_id": "black_lace_set", "body_pose": "kneeling upright",
   "anchor_contact": "Vesper's knees and shins on the mattress", "items": "none",
   "kink_focus": ["JOI"],
   "reinforcement": {"outfit": "…", "action": "…", "set": "…", "items": "…", "camera": "…"},
   "stills": [{"id": "chest_mcu_eye.s1", "beat": 1, "detail": "…",
               "hands": "hands resting on her thighs", "face": "a soft knowing smile, eyes on the lens",
               "pose_reference": {"artifact": "artifact://ref-refs-...", "item": "upper_body/P045", "title": "…",
                                  "angle": "front", "series": "upper_body", "checked": "image"}}]}}}
```

## 4b. The screenplay artifact: play.md verbatim

The task's second artifact `screenplay` holds `screenplay.md` = play.md copied VERBATIM under one
header line. Never retype it; copy it in the sandbox:
1. `sandbox_fetch({ url: "artifact://<inputs>/play.md", targetFile: "/tmp/play.md" })`;
2. `sandbox_exec`: `{ printf '%s\n\n' 'Source play, verbatim. This production has no screenplay; play.md is authoritative.'; cat /tmp/play.md; } > /workspace/<screenplay artifact id>/screenplay.md`;
3. `sandbox_exec` `tail -n +3 /workspace/<screenplay artifact id>/screenplay.md | cmp - /tmp/play.md`
   must print nothing.

## 5. Pre-completion audit

Before `task_complete`: every look of the plan has `scene`, `camera` (its line equal to the plan's
camera), `set_id`, `outfit_id`, `body_pose` (the plan's), `anchor_contact`, `items`,
`kink_focus`, `reinforcement` and its stills with `hands`, `face` and `pose_reference` (an
import whose title / why match the still's support, torso and arms, or `"none"` with the reason)
and its `garment_state` (per its exposure slot, on a body part the framing shows) and the plan's
`body_state` unchanged; every set follows the plan's `set_style` (an abstract set names no room,
wall or furniture); no outfit text
names a body part or exposure; no outfit search or `garment_reference`; `clips` is unchanged; at
most 2 sets and 2 outfits; every set has `room`, `room_id`, `view` (one `main` per room_id);
outfit and set ids are snake_case; no outfit lists a brand mark; no description names camera
equipment; every central kink of play.md has a `kinks[]` entry; `screenplay.md` is play.md byte
for byte under the header line. Fix and rewrite before completing.
