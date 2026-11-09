---
name: iwc-loop-scenes
description: >
  Use when the task prompt says "Load and use skill: iwc-loop-scenes", or asks for the scene list
  of an iWantClips loop episode: one scene per loop clip of the visual plan, each with the clip's
  act-free ANCHOR beat (catalog body pose, furniture contact, the clip's camera, hold; marked in the
  Summary as "Loop anchor: beat N.k"), preceded by an outfit-change beat only where the look
  changes, and a Places table with one location per room, written with write_places / write_scene so the
  server checks it. Do NOT invoke for the visual plan (iwc-play-preproduction), the character
  table (iwc-loop-cast), a film's scene list from a screenplay (run-preproduction's create_scenes)
  or storyboards (storyboard-scene).
agentType: worker
---

# Loop scenes: one anchor scene per clip

The scene list is the platform's bridge from the plan to the designs: `plan-designs` creates the
location, outfit and storyboard designs from it, and every storyboard shot is drafted from its
scene's beats. Here a scene is NOT a story scene: scene n = clip n of the visual plan, and its
ANCHOR beat is the held rest state every variant of the clip starts and ends in. The storyboard
shot of the anchor beat becomes the first and last frame of every variant (`iwc-loop-clip` picks
the frame of the shot whose `Beat:` is the anchor beat named in the Summary).

The footage is 16:9 landscape (1920x1080) from a FIXED camera on a tripod. Lessons of the v1
pilot, built into the rules below:
- an anchor framed limbs-only (a first-person view of her lap) is useless as a loop anchor: the
  anchor framing always shows her face and eyes;
- a Blocking that named the camera, tripod or phone made the image model draw the equipment:
  never name camera equipment, only where the viewpoint is;
- a clip in a different outfit than the clip before needs a shown look change (the scene check
  demands it), so the anchor beat is not always N.1: it is marked explicitly.

## 1. Preflight

Fields: `plan` (default `visual_plan`: `visual_plan.json`), `characters` (default
`character_table`), `screenplay` (default `screenplay`: play.md verbatim; context only).
`read_artifact` the plan and the character table. From `character_<slug>.md` take the character
slug (the file stem: `vesper`) and its WARDROBE TRACKER look slugs. Every clip's `outfit_id` must
be a look slug or `nude`; else `task_failed` naming both lists (never map by guesswork).

The server writes `scene_list.md` from your calls - never `sandbox_write_file` it (refused).
Tools: `write_places` (the Places rows), `write_scene` (ONE scene per call: `scene`, `row`,
`beats`), `write_beats` (fixes: only the beats you change). Field names are the column names in
snake_case: row `int_ext`, `location`, `location_slug`, `time_of_day`, `lighting`, `summary`,
`characters_present`, `outfits`, `audio`; beat `beat`, `action`, `location`, `outfits`,
`framing`, `camera_move`, `continuity`, `blocking`, `contact`, `sex_act`, `sex_position`; place
`location_slug`, `set`, `space`, `connections`. Cells are plain text on one line, no `|`, no
backticks, no straight double quotes (use 'single quotes').

## 2. Places (first call: `write_places`)

ONE row per distinct ROOM of the plan (`sets[].room_id`), never one per corner:
- `location_slug` = the `room_id` (`bedroom`). Shared-room sets (`room: shared`) of one room
  are ONE location: their corners are camera VIEWS of that location's main picture (the set with
  `view: main` is the main picture; the others are its `view` directions). A `room: separate`
  set is its own row (`location_slug` = its `room_id`).
- `set` = the property's display name, identical on every row (`Vesper's apartment`); with a
  single room it is that room's name (a set of one).
- `space` = `interior` (exactly).
- `connections` = what the room's doors and windows open onto, naming other rows' slugs (`the
  door opens onto bathroom`); `none` when no other room of the plan connects.

## 3. Scenes (one `write_scene` per clip, in clip order)

For clip N of `visual_plan.json` (`clips[]`), scene `N`:

Row:
- `int_ext` `INT`; `location` = the room's display name (`room_name`), IDENTICAL in every scene of
  that slug; `location_slug` = the clip's set's `room_id`; `time_of_day` from the play / set
  (`night`); `lighting` = ONE phrase: the set's key light as source, direction, quality, colour
  (`warm tungsten floor lamp from camera-left, soft, pink neon rim from the window behind`).
- `summary` (copied by `plan-designs` into the storyboard's `notes`, so it carries the storyboard
  directive) - exactly this form, STARTING with the anchor marker (`k` = 1, or 2 after an
  outfit-change beat):
  `Loop anchor: beat N.k. Exactly ONE shot for beat N.k (no second or tighter shot of it), no establishing shot, 16:9 landscape, fixed camera, Camera = the beat's Framing with her face and eyes in frame, catalog Body pose <body_pose>, the furniture contact in Contact: <anchor_contact>. Corner: <set name> (<view: main picture | location view '<view phrase>'>). Clip N covers <start>-<end>: <one line what happens in the audio>.`
  With an outfit-change beat, append: `Beat N.1 is one short beat of the look change from <old look> into <new look> and is never the loop frame.`
- `characters_present` = the character slug; `outfits` = the union of the beats' looks
  (`<slug>:<outfit_id>`; with an outfit-change beat both pairs, `<slug>:<old>; <slug>:<new>`); `audio` = the room's atmosphere in one line (room tone,
  size, distance, mood; never "silent"; no dialogue, no events).

**Outfit-change beat** (only when clip N's `outfit_id` differs from clip N-1's; never in scene 1):
beat `N.1` in the OLD look shows the change at the anchor's place, ending one short moment
before the anchor: `action` = body state with the garments mid-change (`Vesper sits on the edge
of the mattress in the lace bralette and panties, the black silk slip gathered in both hands on
her lap`), `outfits` = `<slug>:<old>`, `framing` = the anchor's camera line, `camera_move` `hold`,
`continuity` `new moment`, `blocking` / `contact` as for the anchor (the garment in her hands is a
contact), `sex_act` / `sex_position` `none`. The anchor beat is then `N.2` with `continuity`
`continuous`. One change beat at most; never a second anchor-like beat.

**Anchor beat** `N.k` (`N.1`, or `N.2` after an outfit-change beat; the held rest state):
- `action` = BODY STATE ONLY: support, posture, limbs, the furniture contact, the garment state at
  the anchor (`Vesper kneels upright on the near edge of the mattress, sitting back on her heels,
  hands flat on her thighs, both slip straps on her shoulders`). Keep gaze, lips, breath, eyes,
  skin and voice words OUT of the action: a sensation signal must be its own beat and is refused
  inside a body-state action, and the anchor gets no sensation beat. No act, no motion verbs of
  the variants (those live in the plan's `variants` and reach the clip prompts there).
- `location` = the row's `location_slug`.
- `outfits` = `<slug>:<outfit_id>` (`<slug>:nude` for a nude clip).
- `framing` = the clip's `camera.line` (`medium shot, eye level, from the front`): one standard
  size first, then the height and direction words. Framing words for the 16:9 landscape canvas:
  the anchor shows her FACE and EYES - at least a `medium` shot (`medium`, `medium full`, `full
  shot`), a `full shot` for full-body poses (lying, kneeling with the legs in view, feet toward
  the lens); never a close-up on a body part, never limbs only, never a first-person view (her lap
  seen from above as by the listener). A plan camera that breaks this: widen it to the nearest
  allowed size and say so in the reply.
- `camera_move` `hold` (fixed camera). `continuity` `new moment` (`continuous` after an
  outfit-change beat).
- `blocking` = where she is in frame and facing, where the VIEWPOINT is (`seen from the foot of
  the bed at her eye level, about two metres away`), and her gaze (`she looks into the lens`):
  gaze belongs HERE, never in `action`. NEVER name camera equipment (camera, webcam, tripod,
  phone, lens stand, ring light): a named device is drawn into the picture. `the lens` for her
  gaze is fine. For a shared-room corner name the corner (`at the vanity corner`).
- `contact` = the clip's `anchor_contact` in plain body-part words, one entry per contact
  (`Vesper's knees and shins on the mattress; her hands on her thighs`); an item held at the
  anchor is a contact in words (`the silver key between her right thumb and fingers`).
- `sex_act` `none`, `sex_position` `none` (always both; see "Act-free anchor").

A refusal lists only that scene's problems and saves nothing: fix exactly those (`write_beats`
for the beat, `write_scene` again for the row) and send again.

## Act-free anchor (KNOWN LIMITATION - read before changing this skill)

The anchor beat NEVER carries a sex act:
- the scene-list check requires `Sex act` and `Sex position` to be set TOGETHER or both `none`;
- the pose catalog's sex positions are all two-person, so a solo act has no position name;
- a shot with an act cannot use a catalog `Body pose:` (`storyboard-scene`: never beside
  `Sex position:`), and the catalog `Body pose:` is what gives the anchor frame its limb-by-limb
  pose checks.
So an act that must ALREADY be visible in the first frame (a hand inside the panties, a toy
already in use) cannot be pictured in the anchor: it starts a moment into the clip (driven by the
clip prompt from the plan's `action`) and the clip returns to the act-free anchor at its end.
Items held at the anchor exist only as words in `Contact` (no item design, no item check).
Revisit if the platform gains one-person sex positions.

## 4. Pre-completion audit

Every clip of the plan has its scene (scene n = clip n) and every scene was accepted; each scene
has exactly one anchor beat (`N.1`, or `N.2` after exactly one outfit-change beat `N.1` where the
look changes from the clip before) with `hold`, the clip's camera line as `framing` (at least
`medium`, her face and eyes in frame, never limbs only or first-person), a body-state-only
`action` (no gaze / lips / breath / eyes words), `contact` filled, and `sex_act` /
`sex_position` both `none`; no `blocking` names camera equipment; every summary STARTS with
`Loop anchor: beat N.k.` naming the anchor beat; the row's `outfits` equals the union of the
beats' pairs; every
`location_slug` is a room id with exactly one Places row (`set`, `space` interior, `connections`
filled); one `location` name per slug.
The policy `scenes-complete` judges each scene; fix what it names. Then `task_complete`.
