---
name: iwc-loop-scenes
description: >
  Use when the task prompt says "Load and use skill: iwc-loop-scenes", or asks for the scene list
  of an iWantClips montage episode: one scene per LOOK of the visual plan, each with one act-free
  STILL beat per still of the look (same catalog body pose, furniture contact and camera; the
  stills differ in hands and expression; marked in the Summary as "Montage stills: beats N.a-N.b"),
  preceded by an outfit-change beat only where the outfit changes, and a Places table with one
  location per room, written with write_places / write_scene so the server checks it. Do NOT
  invoke for the visual plan (iwc-play-preproduction), the character table (iwc-loop-cast), a
  film's scene list from a screenplay (run-preproduction's create_scenes) or storyboards
  (storyboard-scene).
agentType: worker
---

# Montage scenes: one scene per look, one beat per still

**Catalog tools:** none in this task (no `search_catalog` / `use_reference`): the look's pose
references were imported by the visual plan (per still); you only list them in the Summary.

The scene list is the platform's bridge from the plan to the designs: `plan-designs` creates the
location, outfit and storyboard designs from it, and every storyboard shot is drafted from its
scene's beats. Here a scene is NOT a story scene: scene n = LOOK n of the visual plan (one camera
set-up), and each STILL beat is one held rest state that becomes one storyboard frame - the start
frame of that still's clips (`iwc-loop-clip` maps still k of the look to the frame of the shot
whose `Beat:` is the k-th still beat named in the Summary).

The footage is 16:9 landscape (1920x1080); every still of a look is ONE camera set-up (the clips'
camera is the plan's `render.camera_rule`). Lessons of the pilots:
- a still framed limbs-only (a first-person view of her lap) is useless: every framing shows her
  face and eyes;
- a Blocking that named the camera, tripod or phone made the image model draw the equipment:
  never name camera equipment, only where the viewpoint is;
- a scene in a different outfit than the scene before needs a shown look change (the scene check
  demands it), so the still beats do not always start at N.1: the Summary names them.

## 1. Preflight

Fields: `plan` (default `visual_plan`: `visual_plan.json`, `mode: montage`), `characters`
(default `character_table`), `screenplay` (default `screenplay`: play.md verbatim; context only).
`read_artifact` the plan and the character table. From `character_<slug>.md` take the character
slug (the file stem: `vesper`) and its WARDROBE TRACKER look slugs. Every look's `outfit_id` must
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
- `location_slug` = the `room_id` (`bedroom`). Shared-room sets (`room: shared`) of one room are
  ONE location: their corners are camera VIEWS of its main picture (the set with `view: main` is
  the main picture; the others are its `view` directions). A `room: separate` set is its own row.
- `set` = the property's display name, identical on every row (`Vesper's apartment`); with a
  single room it is that room's name.
- `space` = `interior` (exactly).
- `connections` = what the room's doors and windows open onto, naming other rows' slugs; `none`
  when no other room of the plan connects.

## 3. Scenes (one `write_scene` per look, in the looks' `scene` order)

For look L with `scene` = N:

Row:
- `int_ext` `INT`; `location` = the room's display name (`room_name`), IDENTICAL in every scene of
  that slug; `location_slug` = the look's set's `room_id`; `time_of_day` from the play / set
  (`night`); `lighting` = ONE phrase: the set's key light as source, direction, quality, colour.
- `summary` (copied by `plan-designs` into the storyboard's `notes`, so it carries the storyboard
  directive) - exactly this form, STARTING with the stills marker (`a` = 1, or 2 after an
  outfit-change beat; `b` = a + number of stills - 1):
  `Montage stills: beats N.a-N.b. Exactly ONE shot per still beat (no second or tighter shot of a beat), no establishing shot, 16:9 landscape, fixed camera, every shot's Camera = its beat's Framing with her face and eyes in frame, catalog Body pose <body_pose> in every shot, the furniture contact in Contact: <anchor_contact>. The stills differ only in hands, head and expression. Corner: <set name> (<view: main picture | location view '<view phrase>'>). Look <look id>: <the look's name>.`
  With an outfit-change beat, append: `Beat N.1 is one short beat of the look change from <old look> into <new look> and is never a still.`
  Always append the per-still wardrobe: `Wardrobe (one line per still shot): beat N.x -> Wardrobe: character_<slug> (wearing: <garments>; partly: <garment (end state)>; removed: <garments>); beat N.y -> ...` from each still's `garment_state` (omit an empty list; a fully worn still is `wearing:` only; each garment in exactly ONE list - a `partly:` / `removed:` garment is never also in `wearing:`, the storyboard's check refuses it) - the storyboard writes the line on that still's shot.
  When any still of the look has a non-empty `body_state`, append: `State (one line per still shot): beat N.x -> State: character_<slug> (<the still's body_state, comma-separated>); beat N.y -> ...` listing every still beat (`(none)` for a still with an empty body_state) - the storyboard writes the line on that still's shot (storyboard `State:`: fluids are the body, never wardrobe).
  When any still has a non-empty `loras` (the keyframe LoRAs of the fluids it shows, e.g. `flux2_nsfw_cum`), append: `Fluid LoRAs (one line per still shot, rank them first on its LoRAs line): beat N.x -> <loras, comma-separated>; beat N.y -> ...` listing only the still beats that have them.
  When any still of the look has a `pose_reference` (not `"none"`), append: `Pose references (one line per still shot, same camera line as the import): beat N.x -> Pose reference: <artifact ref>; beat N.y -> ...` listing every still beat with its still's reference (`none` for a still without one) - the storyboard writes the line on that still's shot, never on an outfit-change shot.
- `characters_present` = the character slug; `outfits` = the union of the beats' looks
  (`<slug>:<outfit_id>`; with an outfit-change beat both pairs); `audio` = the room's atmosphere in
  one line (room tone, size, distance, mood; never "silent"; no dialogue, no events).

**Outfit-change beat** (only when look L's `outfit_id` differs from the previous scene's; never in
scene 1): beat `N.1` in the OLD look shows the change at the stills' place: `action` = body state
with the garments mid-change, `outfits` = `<slug>:<old>`, `framing` = the look's camera line,
`camera_move` `hold`, `continuity` `new moment`, `blocking` / `contact` as for the stills,
`sex_act` / `sex_position` `none`. The still beats then start at `N.2`.

**Still beats** `N.a` … `N.b` (one per entry of the look's `stills`, in order; still k = beat
N.(a+k-1)):
- `action` = BODY STATE ONLY: support, posture, limbs, the furniture contact, the hands (the
  still's `hands`) and the still's garment state in plain words (`Vesper kneels upright on the near
  edge of the mattress, sitting back on her heels, one hand resting on her collarbone, the other on
  her thigh, the lace bralette cups pulled down below her bare breasts`; a `worn` still: `both
  bralette straps on her shoulders`). The same posture, support and outfit in every still beat; the
  hands and the garment state differ. Keep gaze, lips, breath, eyes, smile, skin, fluids and voice words OUT of the action (a
  sensation signal inside a body-state action is refused).
- `location` = the row's `location_slug`; `outfits` = `<slug>:<outfit_id>`.
- `framing` = the look's `camera.line`, IDENTICAL in every still beat. A `close-up` or `medium
  close-up` look frames her face and chest: say in `blocking` which body parts are out of frame
  (`her legs and knees are below the frame`). Never a body part alone, never a first-person view.
- `camera_move` `hold`. `continuity`: the first still beat `new moment` (`continuous` after an
  outfit-change beat), every further still beat `new moment`.
- `blocking` = where she is in frame and facing, where the VIEWPOINT is (`seen from the foot of
  the bed at her chest height, about one metre away`), the still's `face` (gaze and expression:
  `she looks into the lens, lips slightly parted`) and, for a close framing, what is out of frame.
  NEVER name camera equipment (camera, webcam, tripod, phone, ring light); `the lens` for her gaze
  is fine.
- `contact` = ONLY the contacts the look's framing SHOWS, plain body-part words, one entry per
  contact: the look's `anchor_contact` entries whose body parts are in frame plus the still's hand
  contacts that are in frame. The storyboard must put every beat contact on a shot of the beat, so
  a contact the framing cannot show forces an extra wider shot (pilot v5: a full shot added per
  medium close-up still to show the knees) or blocks the storyboard (a face-only close-up can never
  show them: the draft was refused and the task stalled). By framing: `full shot` / `medium full`
  - the support contact (knees and shins on the mattress) and the hands; `medium` / `medium
  close-up` - only what touches the upper body (a hand on the collarbone, fingers at the pendant;
  never the knees or a seat); `close-up` / `extreme close-up` - `none` unless a hand touches the
  face or hair (`her right fingers in her hair at the temple`). Nothing in frame: `none`.
- `sex_act` `none`, `sex_position` `none` (always both; see "Act-free stills").

A refusal lists only that scene's problems and saves nothing: fix exactly those (`write_beats` for
a beat, `write_scene` again for the row) and send again.

## Act-free stills (KNOWN LIMITATION - read before changing this skill)

A still beat NEVER carries a sex act: the scene-list check requires `Sex act` and `Sex position`
set together or both `none`; the pose catalog's sex positions are all two-person; a shot with an
act cannot use a catalog `Body pose:`, which gives the frame its limb-by-limb pose checks. An act
starts a moment into a clip (driven by the gesture's prompt line), never in the still. Items held
in a still exist only as words in `Contact`.

## 4. Pre-completion audit

Every look of the plan has its scene (scene n = the look with `scene` n) and every scene was
accepted; each scene has exactly one still beat per still of its look (after at most one
outfit-change beat N.1 where the outfit changes from the scene before), all with `hold`, the
look's camera line as `framing` (her face and eyes in frame), the same posture apart from the
hands, a body-state-only `action`, `contact` holding only contacts the framing shows (`none` when
nothing touches in frame) and `sex_act` / `sex_position` both
`none`; no `blocking` names camera equipment; every summary STARTS with `Montage stills: beats
N.a-N.b.` naming exactly the still beats, lists each still beat's Wardrobe from its garment_state
and (when the look has any) its State from its body_state, and
lists each still beat's pose reference when the look has any; every beat's `outfits` stays the
look's outfit (a partly-off garment keeps the outfit look); the row's `outfits` equals the union of the beats'
pairs; every `location_slug` is a room id with exactly one Places row; one `location` name per
slug. The policy `scenes-complete` judges each scene; fix what it names. Then `task_complete`.
