---
name: storyboard-scene
description: >
  Use when your task is a storyboard design — keyed `storyboard_scene_<n>` (e.g.
  "storyboard_scene_3") — or the task prompt says "storyboard scene 3", "draft the keyframes
  for scene 2", "write the shot list for a scene", or the person asks in the storyboard chat for
  a change ("add a close-up", "swap shots 2 and 3", "another angle for shot 4"). Produces
  `shotlist.md` (one section per shot, written shot by shot with `write_shot`), plans each shot with `plan_shot` and hands the
  plans over with `draft_storyboard`; the server then renders, checks and repairs the keyframe takes. Do NOT invoke for rendering
  keyframes or video clips yourself, character / outfit / location designs (that is
  design-asset), writing `design.json`, or publishing or finishing a design.
agentType: worker
---

# Storyboard Scene — plan, hand over

Analyze once, write `shotlist.md` shot by shot with `write_shot`, plan each shot with `plan_shot`, hand the plans over with
`draft_storyboard()`, complete. The server
renders several candidates per shot, checks them, repairs what it can and records the best takes;
you render nothing. Prompt and reference conventions for the entity lines: `workflow-calling-conventions`
("References by extent", `load_skill` it). Nudity `allowed`: `load_skill explicit-acts` too (names of `Sex act` / `Sex position`).

## Hard rules

- Work in small steps. Never plan the whole scene's shot list in your head before acting. After
  reading the inputs, outline the scene as short beat lines (one line per beat, at most a few
  sentences of thinking), then decide ONLY the next 1-3 shots, call their tools, and decide the
  following shots after those results. Keep each deliberation short: the server checks the shot
  rules on every `write_shot`, so send the shot and fix what it refuses instead of pre-verifying
  every rule yourself. A long silent deliberation before the first tool call exhausts the output
  budget and the run fails.
- Never write, rename or delete `design.json`, a take file or a published name (`full_body_shot.*`,
  `sheet.*`, `view_*`, `frame_*`). The server owns the takes; the person picks, discards and
  finishes in the studio.
- Never call a `wf_*` tool for a shot take (`take_<shotId>-…`) — it is refused. The only way to get
  shot takes is `draft_storyboard`.
- Write only `shotlist.md` into `/workspace/<artifact id>/`. `<shotId>` = `s<scene>-<nn>` (`s3-01`).
- Write `shotlist.md` in this order, nothing else: (1) a short beat → shot-id map only (one line
  per shot: id, beat, place, who is in frame) — never validate every shot in your reasoning first;
  (2) `sandbox_write_file` the HEADER only — the title line and the `Format:` line, no shots —
  ONLY while `shotlist.md` has no shots yet (a retry or a later message never rewrites the file:
  `read_artifact` it and continue with the first missing shot; a whole-file write that drops accepted
  shots is refused);
  (3) `write_shot` ONCE PER SHOT, in order, about 3 shots per MESSAGE of tool calls — `text` is that shot's
  complete section, starting with its `## <shotId> — <title>` heading — and `plan_shot` for the same shot
  right after its `write_shot` was accepted (one plan per call, see section 3); (4) `draft_storyboard()`
  with NO arguments.
  `write_shot` checks only that shot (unlinked keys, R1–R20, with `Timing: beats` also R21–R23, unreadable lines). A refused shot is
  not saved and the refusal lists only its problems: fix THAT shot and send it again with
  `write_shot` — never touch other shots, never rewrite the file, never declare the task failed
  over a refusal. Sending a shot id again replaces its section; the file always keeps the shots in
  shot-number order, whatever order they are accepted in, so never reorder it yourself. Let
  `write_shot` do the validating: it checks the shot and refuses with the exact fix, so fix a
  refusal from its message instead of pre-checking every rule in your reasoning (long replies
  time out). Send at most 3 shots per message. There is NO next turn: a message without tool
  calls ends the run and the draft fails, so never announce "I will continue with the remaining
  shots" — keep sending `write_shot` / `plan_shot` messages until `draft_storyboard()` is accepted.
  Beat coverage and the other
  whole-scene checks run when you call `draft_storyboard`; its refusal names the shots to add,
  fix or plan — send those with `write_shot` / `plan_shot` and call it again (no arguments).
- `task_complete` is refused until `draft_storyboard` was accepted; never end a drafting turn
  text-only.

## 1 Analyze (read each input once)

- `read_artifact(artifactId="<task id>")`: artifact id, files, `design.json` (`scene`, `notes`,
  `links`: locations (first = default place), characters, outfits; `format` attribute).
- `scene_list`: the scene row and its Beats (action, Location, Outfits, framing, camera move,
  Continuity `continuous` | `parallel` | `new moment`, Blocking / Contact, Sex act / Sex position).
  `screenplay` (if any): the scene's slice.
- Setting = `{workspace.story.setting}` (a given fact): the props, devices, vehicles, wardrobe and architecture the shot lines name belong in it; style = `{workspace.story.style}` is the look the renderer applies, so shot lines never state a medium of their own.
- Each linked design: its digest (identity cue, outfit garments and colours, published
  `full_body_shot` / `sheet` refs; an older design's `primary.<ext>` stands in for
  `full_body_shot`). Never restate design documents.
- Each linked location's `layout:` line (in the Referenced designs block) states its main
  picture in camera terms (where the camera stands and faces; what is ahead / left / right /
  in the foreground; where water, doors, furniture and paths are). The renderer binds that
  picture as the place, so every shot at the location must agree with it: place subjects and
  the viewer in the layout's terms (the window is on the right, the doors are ahead), never
  mirror or reverse it, and keep `Blocking` / `Pose` / `Frame` / `Action` free of geometry the
  layout contradicts. A shot that needs a viewpoint the layout does not give (behind the camera)
  is not renderable at this location - reframe it, or name the gap in the summary. A location
  without a `layout:` line (published earlier): plan from its description and say so in the summary.
- Set map: a location of a set (`set:` / `connections:` lines in its digest) comes with a "Set map" listing every workspace location of the same set (key, space, `connections`, one-line layout, linked or not). Use it as the geometry of the property:
  - A shot through an opening (door, glass doors, window, gate) shows the CONNECTED space as the map states it (the garden beyond the glass doors), and its `Location:` is the space the camera stands in.
  - Pick the location (and the view `(view <id>)`) whose picture holds what the shot shows; a shot that looks at a neighbouring space which is a linked location uses that location's own picture for it.
  - A direction that is no listed view and no linked location (typically the reverse, 180° from the main picture) is a different set location or a gap: reframe the shot, or name the gap in the summary. Never invent the missing side or its connections.
- Note: the POV owner, `continuous` chains, beats holding several actions, shots with many people
  (the server binds the place, for a continued shot also the parent frame, and one picture per
  figure; when the workflow has too few image slots it leaves out the lowest-priority person and
  names them in words only - split a crowded shot by who is in frame to keep everyone pictured).
- Preflight — on any gap call `task_failed(reason)` naming it, plan nothing: the scene row; ≥1
  linked location; every linked design readable with a published full-body shot.

## 2 Plan — `shotlist.md`

The file is the header below plus one section per shot. Write the header (title + `Format:` + `Timing: beats` when the shots become clips) with
`sandbox_write_file` (only while the file has no shots yet), then each shot section with `write_shot`, in order (each followed by its `plan_shot`).

```
# Scene <n> shot list
Format: portrait
Timing: beats

## s3-01 — Short title
Action: Wife, seated across the table, typing on her laptop, head down; the viewer's hands resting on the table edge
Location: location_kitchen
Camera: medium, eye level
Lens: normal 35mm, shallow focus
Movement: push in, slow, from medium to close-up, ending on her face
Motion:
0-3 s character_wife: keeps typing, head down
3-6 s character_wife: lifts her head and looks at the viewer
0-6 s viewer: hands rest on the table edge
0-6 s camera: slow lean in
Dialogue: 3.5-5 s character_wife (soft, tired, slow, a small sigh first): "It's late"
Audio: small dry kitchen at night, fridge hum, rain on the window
Blocking: the camera is the viewer's eyes (seated); the viewer's forearms and hands enter the lower frame; wife across the table, facing the viewer, her hands on the laptop
Pose: wife: hands on the keyboard, head down; the viewer's hands flat on the table
Frame: wife centre background; the viewer's hands bottom foreground
Visible: character_wife (upper body); character_husband (limbs: forearms and hands); nobody else
POV: character_husband (seated)
LoRAs: noir_office_style, skin_realism_flux, anamorphic_lens_look, laptop_scene_detail
Beat: 3.1
Contact: character_wife (hands) on laptop keyboard; character_husband (hands) on table
Characters: character_wife, character_husband
Outfits: character_wife:outfit_wife_office; character_husband:outfit_husband_suit
Duration: 6
Transition: cut — first shot of the scene
```

Every line is ONE line (no wrapping), except `Motion:` (one timed beat per line, below). The shot lines are the single authority for who is in frame,
who touches what and how shots relate (the shot graph is read from `Transition:`); the structured
plan of step 3 only adds placement, facing and the compose prompt.

### Curate the shot's LoRAs (first step of every shot)

BEFORE you write a shot's lines, run "Curated LoRAs" of `workflow-calling-conventions` for it: call `lora_index()` once per scene (reuse the result for every later shot), then pick the up to 8 LoRAs most relevant to THIS shot, ranked most relevant first, inferred from each LoRA's name and description: everything the shot shows - the production's style and look, the pictured characters (character LoRAs), outfits and clothing, props, the place, camera / lens / lighting, pose and action, anatomy and detail - and the act and position only when the shot has a `Sex act:` / `Sex position:` whose act is SHOWN - an intimate `Contact:` entry in frame; an act that goes on out of frame loads no act LoRA, so name none (rank the LoRA serving a shown act high). Write them on the shot's `LoRAs:` line (`LoRAs: <name>, <name>, ...`, exact catalog names, comma-separated, ONE line) or `LoRAs: none` when nothing fits or the catalog is empty. Curate LoRAs of the storyboard's RENDER families only: the family of the keyframe (compose) workflow and of the masked-inpaint workflow that paints an act into it (read `model_family` of the workflows in the workflow index / workspace facts and `modelFamily` per LoRA in `lora_index`) - a LoRA of any other family NEVER loads on these renders (the write tool notes it as "never loaded"). For a shot whose `Sex act:` is SHOWN include that family's ACT-DETAIL LoRAs and rank them FIRST - the genital / anatomy detail LoRAs of the body parts the act shows and the act / position LoRA, inferred from each LoRA's name and description - because the inpaint workflow has only 4 LoRA ports and the tail is cut; a shot whose shown act lists no LoRA of the keyframe family is REFUSED at the write (when the catalog has one). Anatomy-detail LoRAs (a body part's detail) only where the OPENING frame shows that body part (it is in a `Visible:` extent that shows it and in `Contact:`/`Pose:`, not only reached by a later Motion beat); both parts' LoRAs when the join between them is the subject; none when a part is out of frame or the act is stated only by a Motion beat. Example, a flux2 storyboard, vaginal penetration from behind: `LoRAs: flux2_nsfw_penis, flux2_nsfw_vulva, flux2_nsfw_sex_aio, flux2_nsfw_realism` (never `krea2_nsfw_penis` there). No need to avoid a LoRA the workflow already loads (the render skips it). The server loads this list on EVERY take render and repair of the shot, after the design's explicit studio picks (which rank first; the port cap cuts your tail); the line is checked at the write (at most 8, no duplicates, names must be in the catalog - rule R15; a shown act needs a LoRA of the keyframe workflow's family when the catalog has one). The accepted `write_shot` result lists what will load per render, so you see the port cut.

### Cinematography (the shot rules below, R1-R29 and the POV / act rules R4 / R20 / R24 / R29 take precedence)

- Scene 1 opens on its hook (the scene list's first beat); an establishing wide may follow it. Any other scene at a NEW place opens with an establishing wide (`Format: portrait`: one vertical establishing frame instead, see below).
- Shot size follows intensity: wide -> medium -> close as it rises; never the same size three shots in a row; an insert only for an object the story needs.
- Keep each person's screen side from the scene's `Blocking` (left / right of frame) for the whole scene; over-the-shoulder shots keep the same shoulder; never mirror a person between shots unless they move.
- A `continue` shot changes framing clearly: at least one size step or a visible angle change (more than about 30 degrees), performed by its `Movement:` (R25); a change no move performs is a `cut`. The one exception is a first-person `continue` (below): it may keep the framing (R16).
- A continuous moment (its beat is `continuous`) is covered as `continue` shots, not as cuts: plan its framings so each step is one the clip workflow can perform - a size step (`push in` / `pull out`) or an `arc` within the workflow's `max_arc_degrees` (read `camera:` from `workflow_index`; 45 for MiniMax H3) - instead of jumping to the other side of the people. A jump of more than that (left side -> right side, front -> behind) is a `cut` and starts a new keyframe; keep such jumps for a new beat, a reaction or a real change of view. Write `cut — … on the same moment` only when no performable framing tells the moment.
- Both `Camera:` lines of a `continue` pair name the same angle words: camera height (`eye level` / `high angle` / `low angle`) AND direction (`from the front` / `three-quarter angle from her left side` / `from behind`), each in both lines, even when unchanged. The clip planner compares only what both lines state; a height in one line and a direction in the other cannot be measured, and the clip is then shot as a cut.
- Keep each beat's `Framing` size and `Contact` on the shot that shows it: a beat none of whose shots opens `Camera:` with the beat's size is refused (extra coverage shots of the beat may use other sizes). The scene list's `Camera move` column is the beat's intended camera move: it goes in `Movement:` (or a `camera` Motion beat) only, never into `Action:`, `Pose:` or a person's Motion. Every `Contact:` body part of a whole-body person (`full figure` / `back` / `upper body`) must lie inside the `Camera:` size (R34): the chest `medium close-up` or wider, the waist, belly and hips `medium` or wider, the thighs `medium full` or wider, legs and feet `full`; <A>'s hand on <B>'s waist in a `medium close-up` is refused - open wider, show <B> as `lower body`, or drop the contact.
- `Frame:` states the composition at t=0 (the keyframe is the opening frame): which third the subject sits in, foreground / midground / background, room in the direction they face; and it repeats the scene's `Lighting` phrase from the scene table (never contradicts it).
- `Duration:` guide (3-10 s): establishing 4-6 s, action 3-6 s, emotional beat 6-10 s, reaction 2-4 s.
- `Format: portrait` (a vertical frame shows little side to side; these override the size and establishing-wide rules of this skill):
  - Size mix led by `close-up`, `medium close-up` and two-shots (a two-shot = a `medium close-up` or `medium` with both people in frame); "shot size follows intensity" runs medium -> medium close-up -> close-up -> extreme close-up.
  - An `extreme close-up` for every sensation beat: the body part the scene list's `Action` names as the signal (a hand stopping short, lips parting, skin, breath).
  - Two people side by side or one behind the other, close (within arm's reach), never at opposite edges of the frame.
  - The widest shot is ONE person `full shot`; never a `wide` with more than one full figure. A new place's establishing image is one vertical frame (a doorway, a corridor, a window), not a `wide` of the room.

### Shots

- One shot = ONE moment (a keyframe is a single still), one place (`Location:`), one framing
  (`Camera:` = the opening frame only; a pan from A to B is `Camera:` A, the pan goes in
  `Movement:`).
- `Camera:` OPENS with one standard framing size, then the angle: `extreme close-up` (one detail
  fills the frame) | `close-up` (head and top of the shoulders) | `medium close-up` (head to
  mid-chest) | `medium` (head to waist) | `medium full` / `cowboy` (head to mid-thigh) |
  `full shot` (head to feet) | `wide` (people small in the setting) — e.g. `Camera: close-up on
  the wife's face, eye level`. The server states that size in every render prompt, measures it on
  every take and reframes a subject that came out too small; a `Camera:` line opening with
  anything else ("<seat> POV …") gets no framing check.
- After the framing size, the angle, in these words only: `from behind` | `from the front` |
  `from her left side` / `from his right side` | `three-quarter` (e.g. `three-quarter angle from
  her left side`) | `over the shoulder` | `low angle` (also `slightly low`) | `high angle` (also
  `slightly high`) | `top-down` | `dutch angle` | `eye level` | `POV`. They become checked items of
  every take: the direction words a camera-direction item, the height words a camera-height item —
  a take shot from another side fails it.
- `Action:` = the ONE instant as a state, with participles: "Wife, standing, presses …";
  "Wife mid-stride toward the table, reaching for her laptop".
  - The sequence words `then`, `after`, `before`, `followed by`, `cut to` and arrows (`→`, `->`)
    are REFUSED in `Action:` and `Camera:` (rule R9, any case, whole words) and in a plan prompt.
    Never rephrase a sequence around them: it is fixed only by splitting it into shots. A word
    used for PLACE, not time, is reworded instead: "kneels before him" -> "kneels in front of him".
  - Two successive verbs ("stands and presses", "enters and crosses") = separate shots too, one per
    action, in order (not checked by the server - your job). With `Timing: beats` one continuous
    action stays ONE shot: its verbs are successive `Motion:` beats (see "Timed motion").
  - One shot: simultaneous actions joined by "as" / "while" (both happen in the same instant);
    speech, breath or a sound together with one action; a progressing state ("thrusting faster",
    "pace building").
  - Visible only: no motives or camera motion. Speech goes on its own `Dialogue:` line (with
    `Timing: beats`: `<t0>-<t1> s <character_key> (<delivery>): "<words>"`), never in `Action:` (Action shows only the visible part: mouth open, calling).
  - Bad → good: "Wife sighs and says it is late, closes the laptop and gets up" → s3-01
    `Action: Wife, seated at the table, sighing` + `Dialogue: 1-2.5 s character_wife (tired, soft): "It's late"`; s3-02
    `Action: Wife, laptop closed, rising from her chair`.
    "Wife stands, moves to his chair, hands him the letter" → three shots: `Wife, rising from her
    chair` / `Wife, mid-stride toward his chair, letter in hand` / `Wife, beside his chair, holding
    out the letter`.
- Split every multi-action beat into one shot per action, in order — never one shot that lists
  them. Count actions, not beats: 4 beats can need 7 shots.
- `Beat:` = the `Beat #` of the scene-list beat the shot shows, copied exactly (`Beat: 1.9`); every
  shot has one, every shot of a split beat carries the same beat, and every beat of the scene has
  at least one shot (all checked at the write: `beat 1.3: no shot shows it`).
- A sequence is fixed ONLY by splitting it into shots, never by rephrasing it into one sentence
  (participles or "as" around successive actions are still a sequence).
- Typically 4–10 shots covering the whole scene in story order, an establishing wide first when
  the place is new (`Format: portrait`: one vertical establishing frame, see Cinematography) (scene 1: after its hook, see Cinematography). Sections follow story order; a split keeps its id for the first part.
- A `parallel` beat = its own cutaway shot at its place, its characters from that beat:
  `Transition: cut — cutaway (parallel action)`; the main action resumes in a later shot
  (`cut — back to …`).
- `Location:` = a linked location key; a place with no linked design → the nearest linked
  location, and name the gap in the summary.
- Named views: `Location: <key> (view <id>)`, an `Outfits:` pair `<characterKey>:<outfitKey> (view <id>)` and a `Characters:` entry `<characterKey> (view <id>)` pick a VIEW of that design (a location's camera direction, a person's pose or expression) as its picture instead of the main one. An `Outfits:` view selects the OUTFIT's view; a `Characters:` view is the character's own, used when no outfit stands in for them. The "Referenced designs" block of the task prompt lists each linked design's views: id, kind, label, the exact line to write and its description (a location's description is its camera layout).
  A location with views: pick, PER SHOT, the view whose camera direction matches the shot's `Camera:` (a reverse or side shot takes the view facing that way); the main picture only for shots that look the same way it does. Reusing one picture for every direction renders the room mirrored or rebuilt. A place state no picture shows (a door closed that every picture shows open) is written in words in `Action:` - the picture otherwise wins.
  - Choose a view only when it fits the shot: a location view whose layout matches the shot's `Blocking:` / `Frame:` (e.g. facing the window wall when the shot looks at the window); a person view whose pose / expression is the one the shot's `Action:` / `Pose:` needs. Otherwise write the plain key and the main picture is used, and the shot stays consistent with the main layout.
  - Match by the DESCRIPTION, never by the view's number: a location view fits when its `Ahead:` (and `Left:` / `Right:`) is what the shot's `Frame:` puts ahead and beside; a view of a person fits when its angle / pose is the one the shot needs. A view listed without a description has an unknown direction: never pick it. When no listed picture (main or view) shows the direction the shot looks in, do not take the nearest one: name the gap in the summary (the design's "Add views" can make that view) and write the shot for the closest picture you do have.
  - The server states the chosen picture's layout in the render prompt (a `Place (as in Picture N, the location picture): ahead ...; left ...; right ...` requirement) - so when the camera faces a different way than the location's main picture, pick the view whose `Ahead:` / `Left:` / `Right:` matches that direction, and never write `Blocking:` / `Frame:` side facts about the PLACE (which wall, which door is on the left) that contradict the chosen picture's layout; `Blocking:` / `Frame:` say where the PEOPLE are.
  - `Blocking:` / `Frame:` follow the CHOSEN picture's layout, not the main one's.
  - A view whose layout shows a thing the shot's `Out of frame:` line excludes (<excluded thing>) is the WRONG view for that shot: read each listed view's `Ahead:` / `Left:` / `Right:` and take the one that matches the shot's `Frame:` and shows none of the `Out of frame:` things (for example a view that shows the stairwell a shot excludes). When no listed picture satisfies both, name the gap in the summary instead of taking the nearest one.
  - Scenes at one place: the task prompt ends with a **Previous scene** block naming the previous scene's last shot and its exact `Location:` line (view included). A scene that CONTINUES at that place reuses that line for its first shot (same location key, same `(view <id>)`) and changes the view only when the shot's `Frame:` looks another way (binding the main picture after the previous scene ended at `(view 3)` jumps the layout). A scene at another place ignores the block.
  - A person's STANDARD views `(view back)` / `(view profile)` / `(view front)` suit shots from behind / in profile / facing the camera (`face` a head-and-shoulders close-up); an older design may list numbered views (`view_1`..) and a `portrait` instead, matched by their description.
  - Never invent a view id: only listed ones are valid (the write is refused for another). A `continue` shot keeps the previous shot's location KEY; its view may change with the framing.
- `Movement:` = the beat's camera move in the canonical grammar of "Camera moves" below (`hold` only when the beat asks for stillness); the `from` / `to` frames follow the `Transition:` rule there.
- `Lens:` (optional, keyframe-relevant): `Lens: <wide|normal|long> [<N>mm][, <deep|shallow> focus][, focus on <thing>]`. Classes: wide <= 28 mm (default 24), normal 35-50 mm (default 35), long >= 85 mm (default 85); an explicit N must fit the class. It sets perspective and depth of field of the keyframe, never movement; leave it out when the scene's look needs nothing special.
- Coverage of one moment: consecutive `continue` shots change the framing size or the angle
  (wide from behind → medium close-up of her face over her shoulder → close-up of his hands on her
  hips). A continue shot with the SAME framing size, angle and `Location:` as the previous one is
  refused (rule R16): the renderer copies the previous frame, so it would be the same picture.
  Beats that would look the same as a still are ONE shot — its clip carries them (`Action:` the
  state, the progression in `Movement:` / `Duration:`), never two identical keyframes.
- A `continue` shot that keeps an outfit whose garments the previous shot removed or left partly off (`Wardrobe: … removed:` / `partly:`) restates a `Wardrobe:` entry for that character (the same state, now removed, or worn again) — otherwise refused (rule R17): the renderer would re-dress the person. A `partly:` garment must be restated wherever this shot's extent shows it — the viewer's own too (the waistband of their own shorts still lowered in a `lower body` shot); where the extent does not show it (a close-up above the waist, a `limbs` viewer) leave it out — it is not in frame, and R19 refuses it there.
- A `continue` shot that shows a person the previous shot gave a `State:` (wet hair, sweaty …) restates a `State:` entry for that person (the same states while they last, or what changed — preferably explicit, `dry hair` after toweling, else `(none)`) — otherwise refused (rule R18): the renderer would draw them as designed (dry hair after the jump into the water).
- `Transition:` says how THIS shot follows the PREVIOUS one (the cut or continuation INTO this shot) —
  never how it leads to the next. Shot 1 is always `cut — first shot of the scene`; the last shot's line
  is about the shot before it (never "end of scene"). Write it from THIS shot's first beat's Continuity:
  a beat whose Continuity is `new moment` / `parallel` starts with a `cut` (the write is refused
  otherwise); later shots of the same beat follow the rules below.
  The FIRST word is the mode and decides the shot graph:
  `continuous` → `continue — <reason>` (same place, moment, people; the framing may change; the
  SAME `Location:` as the previous shot — a frame of one place never seeds another, so a
  `continue` at another place renders without the previous frame: make it a `cut`), e.g.
  `Transition: continue — same moment, closer on <B>` (`closer` needs a TIGHTER framing
  size in `Camera:` than the previous shot — the same size with "closer" is not closer);
  `parallel` / `new moment` →
  `cut — <reason>`, e.g. `Transition: cut — later that afternoon`. The reason says WHY in your own
  words — never the Continuity word itself (`cut — continuous` is a contradiction: write
  `continue — …`). The first shot is `cut — first shot of the scene`.
  A `continue` shot changes framing (rule R16), and its clip must PERFORM that change: `Movement:` is a
  move that can REACH the new framing (the "Camera moves" table below; handheld, pan, tilt,
  truck, follow and `hold` do NOT count); with `Timing: beats` the `camera` beats in `Motion:` perform it. When no
  move can reach the new framing, write `Transition: cut — …` instead (the clip then starts on the
  new keyframe). The write is refused (rule R25) when a changed dimension has no move of its row in
  `Movement:` (or a `camera` beat) — several changed need one move each; a push-in cannot turn an
  eye-level shot into a low-angle one, and a pan cannot turn a front view into a three-quarter one.

  **Camera moves** (THE vocabulary and grammar of `Movement:`, parsed and checked by the server):

  ```
  Movement: <step>[; <step>]...[, handheld|steadicam|gimbal [subtle|moderate|strong]]
  <step> := <move> [<dir>] [<N>°] [, slow|medium|fast] [, from <frame> to <frame>]
            [, following <key> | , to reveal <thing> | , ending on <thing>]
  <move> := hold | pan | tilt | roll | push in | pull out | truck | follow | lead | pedestal | crane | arc
            | whip pan | dolly zoom | rack focus
  <dir>  := left | right | up | down       <frame> := a framing size and/or camera-angle words
  ```

  Examples: `hold`; `push in, slow, from medium to close-up, ending on her face`;
  `arc right 45°, from from the front to three-quarter, ending on her profile`;
  `pedestal down, slow, from eye level to low angle; tilt up, ending on her face`;
  `truck left, slow, following character_wife, handheld subtle`; `rack focus from the glass to her face`.

  | Framing change | Move that performs it |
  |---|---|
  | shot size (wide / medium / close-up ...) | `push in` / `pull out` (must END tighter / wider than it starts; about one size step per 5 s on MiniMax H3). Write `push in` / `pull out`, never `zoom`, `dolly in`, `track` (accepted only as aliases) |
  | side of the subject (front / side / three-quarter / behind / over the shoulder) | `arc left` / `arc right` `[N°]`; front <-> behind (180°) is always a `cut` |
  | camera height (eye level / low / high angle / top-down) | `crane` / `pedestal` up or down, ending in a higher / lower height band (a tilt alone does not) |
  | dutch angle | `roll` (checked only when both `Camera:` lines name a dutch angle) |
  | POV / no POV | none: always a `cut` |

  - **Arc convention**: `arc left` = the camera travels to ITS OWN left (counter-clockwise seen from above); from a frontal camera it reveals the subject's RIGHT side. About 45° = front -> three-quarter, about 90° = front -> side (profile); stay at 15-45° per clip on MiniMax H3. Only an arc changes the side seen: pan / tilt / truck never do.
  - `pan` / `tilt` (turn in place), `truck left|right` (travel sideways), `follow <key>` / `lead <key>` (travel with a moving subject, framing kept) reframe WITHIN the same view: allowed as a shot's move, never a framing change. Never write `track` (ambiguous): use `truck`, `follow` / `lead` or `push in`.
  - `handheld` / `steadicam` / `gimbal` are MODIFIERS of the whole `Movement:` (after the last step), never a move; "drift" is not a move. `dolly zoom` is size-neutral (performs no size change).
  - `hold` = strictly static: no move, no zoom, no focus change. A focus shift is `rack focus from <near thing> to <subject>` (both ends named; the frame stays still).
  - Speed words (`slow` = spans the clip, `medium` = about half, `fast` = <= 1 s) carry no guarantee; `Duration:` and the beat times carry the speed.
  - **`from <frame> to <frame>` depends on this shot's `Transition:`** (the server checks both against the `Camera:` lines; a mismatch is refused):
    - `Transition: continue`: `from` = the PREVIOUS shot's `Camera:`, `to` = THIS shot's `Camera:` — the move reaches this shot's keyframe (`push in, slow, from medium to close-up`, this shot's `Camera:` opening with `close-up`).
    - `Transition: cut` (and the first shot): `from` = THIS shot's own `Camera:` (the opening), `to` = the framing at the END of the clip (free) — the move happens during this shot (`arc right 45°, from from the front to three-quarter`).
    `Camera:` itself is always the opening frame of THIS shot; a move that "starts at A" on a cut shot is `Camera:` A plus the move.
  - **A first-person camera is the viewer's EYES** (rule R29, refused at the write on a `cut` shot as much as a `continue` shot; R25 reads the same table). The `Movement:` of a `POV:` shot - and its `camera` beats - may only name what the viewer's body does, by their posture and whether they are attached (a `Contact:` joins them to another person; a contact with a thing does not attach them):

    | Viewer | Free | Attached (a `Contact:` with a person) |
    |---|---|---|
    | `lying` | turn: `look <dir> [N°]`, `turn head` | turn only |
    | `seated` / `kneeling` | turn + a small `lean in` / `lean back` | turn only |
    | `standing` | turn + `step in` / `step back` | turn only |
    | `walking` | turn + `walk`, `walk after <key>` (never `follow` in a POV shot) | turn only |

    Never arc, crane / pedestal, truck, push in / pull out or zoom for a first-person shot: the viewer's head does not travel (a pull back from a lying viewer leaves the viewer's head, shows the face, breaks the contact or turns the subject). So a NEW framing for a seated, lying or attached viewer is a `cut`: write `Transition: cut — <reason>` and give the next shot its own framing. **A continuous moment of a first-person scene is a `continue` that KEEPS the framing** (R16 allows it for the same `POV:` owner in the same posture): the same `Camera:` line, `Movement: hold` (or a look / turn, or the lean / step / walk its row allows, when the workflow declares that move reliable), and the change is in the people - the `Pose:` or `Contact:` line differs from the previous shot's (an unchanged pair is refused, R16), driven by the shot's `Motion:` beats. Reach for it whenever the scene list's beat is `continuous` and only the people move - a held first-person take is how a POV scene flows; cut only for a new framing, a posture change or a new moment.
  - Keyframe prompts (`plan_shot` prompt, image writers) NEVER carry movement words: a keyframe is one instant.
  - Read the clip workflow's declared `camera:` (reliable moves, `max_arc_degrees`, unreliable moves) and `limits:` from `workflow_index` BEFORE writing `Movement:` / `Motion:`: a move the workflow cannot perform reliably makes a `continue` a cut (write `cut`), and a beat that matches a limit class is designed around it (see "Shot design for video models").

- `Duration:` 3–10 s. Ids consecutive from `01`; a changed shot keeps its id
  (new / split shots get ids after the highest).
- `Format:` on the line after the title, always: the `format` attribute, else the production
  canvas `{workspace.profiles.master.video.width} x {workspace.profiles.master.video.height}` (`portrait` when the height is larger than the width, e.g. 9:16), else `landscape`.

### Shot design for video models

The clip is rendered by a video model with declared limits (`limits:` in `workflow_index`); design the shots around them instead of hoping:

- **Cut at take-off, restart in the new medium.** A body entering or leaving another medium (diving into water, stepping into fire or smoke) is never inside one clip: end the shot at take-off and start the next shot (a `cut`) already in the water. A medium transition inside a clip fails.
- **Interactions early and short.** Hand-offs, contact and exchanges belong in the first 3 s of a clip; late interactions drift. Split a long interaction across shots rather than stretching it.
- **Micro-actions need size.** Fingertips, blinks, a flicker of a smile stay static in a clip: write them as a larger visible motion (the whole hand, a head turn) or as a close insert of the thing (`insert` = a close-up of a thing).
- **Spoken lines read best with at least 3 words** (a one-word whisper is hard to hear): a shorter line is only a non-blocking note on the saved shot; lengthen it or fold it into a longer line when you can.
- Camera moves come only from the workflow's reliable list and within `max_arc_degrees`; otherwise `cut`.

### Timed motion (header `Timing: beats`)

Write `Timing: beats` under `Format:` whenever the shots become CLIPS. The keyframe stays a still of
ONE instant; the clip carries the action. `Action:` is then the state at **0 s** (the keyframe),
`Motion:` the action **in progress** from there, per subject, with timing. `Motion:`, `Dialogue:`
and `Audio:` never reach the keyframe (the server leaves them out of the picture and of the stale
check); they go to the clip prompt verbatim.

- `Motion:` = one beat per line, `<t0>-<t1> s <subject>: <what is in progress>`. Subject = a `Characters:`
  key, `camera` or `viewer` (the POV owner's own hands and limbs). Per subject the beats run from `0`
  to `Duration` without a gap or an overlap. Every figure of `Characters:` (not the POV owner, not a
  `limbs` person) has a beat; there is always at least one `camera` beat (`hold` is a beat too).
  Write the action in progress ("reaches for the glass, fingers closing"), not an instant, and only
  what the scene list's beat states: no filler behaviour. A pose held for the whole shot is no motion:
  "0-4 s hangs airborne" is wrong; a jump is "0-1 s crouches, arms swinging back; 1-2 s pushes off the
  step, both feet leaving the floor; 2-4 s lands on both feet, knees bending".
- A beat carries its MECHANICS, stated as the action in progress: which hand, which fastening or
  motion ("left hand pulls the cord loose", not "undresses"), where a garment or prop goes ("the top
  drops to the floor by her feet"; "the cup is set on the table's near edge") and the end state it
  leaves ("the cardigan hangs open off one shoulder"). Every garment or prop a beat touches gets an
  end state in that beat or a later beat of the shot; none is left unresolved.
- **The picture lines show the instant BEFORE Motion beat 1** (rule R27, refused at the write: the server asks
  the decision model whether `Action:` / `Pose:` / `Blocking:` / `Wardrobe:` / `State:` show each person
  before, partway through or after their first beat). The keyframe is the START frame of the clip, so it
  shows each person as they are when their first beat begins; the beat performs the change; the result is
  the NEXT shot's picture. Counter-example: a beat "0-2 s <A> climbs out of the water" with picture lines
  "<A> stands at the edge, dripping" - the clip never shows <A> climbing out. Right: the picture lines say
  <A> stands IN the water at the ladder, hands on the rail, and the beat "0-2 s pulls up the ladder
  and steps out onto the deck" performs it; the next shot's lines show <A> on the deck, `State: wet hair`.
  Same for "<B> stands up from the chair": the picture lines show <B> seated, not already standing.
  A person without a first beat is not asked. Write the opening state in words of a still, never as the
  motion. This covers the viewer (`viewer:` beats) and anyone seen only by `limbs` too, and `Contact:` /
  `Sex act:` count as picture lines: a beat that ENDS a join or touch starts from it (state the `Contact:`
  and act at the opening frame); a beat that BEGINS one starts without it.
- **Every shot ENDS on a held state** (rule R33, refused at the write: the server asks the decision model
  whether each person's LAST beat ends settled or still moving, and - when the camera move ends `ending on` /
  `to reveal` something - whether that is where a person only arrives after this shot). A video model carries
  any movement still under way at the end on and performs the next action inside this clip (for example a last beat
  "<A> sets the cup down, weight shifting toward the door" with `Movement: slow pull-out,
  ending on the doorway` - the clip walked <A> on through the door, and the next shot's exit played
  twice). The last beat FINISHES its action and settles: "...<A> sets the cup down and stands
  still at the table, back to the viewer". A move toward the next action (shifting toward, reaching
  for, about to, starting to, walking toward) is the FIRST beat of the next shot, also when the next shot
  continues (`Transition: continue` starts from this clip's real last frame). A camera move ends on what the
  frame holds when the last beat ends ("ending on <A> standing at the table"), never on where the next
  action will happen. The server also adds a final hold segment to every clip brief (from the last beat to
  the end of the clip nobody moves), so never pad a beat to fill the clip.
- Rule R26 (clip rule, refused at the write like R25, never part of the keyframe gate): a `Wardrobe:` or
  `State:` entry that differs between shot k and shot k+1 must be PERFORMED by a `Motion:` beat of shot k
  that names the garment (or state) and where it ends up; shot k+1's `Wardrobe:` / `State:` show the RESULT.
  A beat of shot k+1 does not count: its own picture lines would already show the end state of what its own
  Motion then does (the keyframe never shows the opening moment). A change nobody in shot k performs is
  refused: write the beat into shot k, or keep k+1's entry as in k.
- Speech direction belongs to the beat it happens in: the `Motion:` beat of the speaker says how they
  speak or hold themselves while speaking ("speaks over her shoulder without turning"), the `Dialogue:`
  line carries the words and voice delivery.
- Two verbs = two beats of ONE shot ("stands, then crosses" is `0-2 s … rises` and `2-5 s … crosses`),
  never two shots, when the beat is one continuous action; a new place, framing or moment is still a new shot.
- Never cut at a sub-second instant: every beat is at least 1 s (rule R22). A beat the clip cannot
  show in 1 s is merged into its neighbour.
- `Duration:` (3–10 s) is sized from the beats, the dialogue and a settle: sum what the beats need
  (a mechanic with several steps takes its real time), the dialogue at its pace, then a settle so the
  end state is visible; the last word ends at least 0.5 s before the shot ends. Never pad a short
  action to a round length.
- `Dialogue:` = `<t0>-<t1> s <character_key> (<delivery>): "<words>"`, several separated by `;`. The speaker
  is the character's design KEY. The delivery names emotion, volume, pace, breath and pitch ("soft, tired,
  slow, a small sigh first") — what the voice does is audible, so emotion words belong here. Size each
  line at about 2.5 words per second (plus 0.3 s of slack); lines never overlap and stay inside the shot
  (rule R23).
- `Audio:` = the scene's atmosphere (room tone, space, distance, mood), copied VERBATIM from the scene
  list's `Audio` for this scene onto EVERY shot of the scene (the write is refused when it differs). The ambient bed is ALWAYS audible at a natural level: 'quiet', 'distant', 'faint' or 'hushed' may describe the PLACE (its size, its sources), never the loudness of the sound; every clip carries an audible ambient bed. A scene `Audio` that names only a level ("quiet", "silence") is a scene-list defect: say so in the task result, do not copy it into a clip.
- `Beat:` may list several beats (`Beat: 1.2, 1.3`) when one continuous action spans them.
- The moment rules above (R9) apply to `Action:` and `Camera:` only: the sequence lives in `Motion:`.

### Who is in frame

- Keys only, copied from `design.json.links` (never names or slugs) in `Location:`,
  `Characters:`, `Outfits:`, `Visible:`, `POV:`.
- `Visible:` = `<characterKey> (<extent>[: detail]); …; <exclusion>`; extent EXACTLY one of
  `full figure` | `upper body` | `face` | `back` | `limbs` | `lower body` — one per person, never a
  combination (the write is refused): pick the WIDEST part of them in frame (`face and upper body`
  → `upper body`); nudity is not an extent, it goes in `Outfits:` (`<characterKey>:nude`), so
  `full figure, nude` → `(full figure)` + `<characterKey>:nude`; a change during the shot
  (`back then upper body`) is two moments → split it into two shots. Detail states counts
  (`limbs: one pair of hands`); the last segment is the exclusion clause (`nobody else`).
- `Characters:` = exactly the keys in `Visible:`; `Outfits:` = one valid pair per character
  (below), `; `-separated. Nobody in
  frame: `Characters: none`, `Outfits: none`, `Visible: nobody`.
- The exclusion clause states a count (`nobody else`, `no other hands`), never names people to
  exclude: negated names are weak in image models and tend to summon the people they name.
- Things of the place the frame must NOT show (<excluded thing> behind the viewer, the doors) go only on
  `Out of frame: <thing>, <thing>` (at most 6 things, each a few words) — never a person: a linked
  character's key or display name there is refused (people are `Visible:` and its count), and any
  other person belongs in the exclusion clause, not here.
  Nowhere else: no "no <thing> visible", "the doors behind the camera" or "out of frame" in `Action:`,
  `Blocking:`, `Pose:`, `Frame:` or the plan prompt — a named thing is painted in. Those lines name
  only what IS in frame (pick a location view whose picture lacks the thing, and say what fills
  that part of the frame).
- People without a design (extras, a crowd) get no key: they appear in `Action:` / `Frame:` and in
  the exclusion clause (`character_wife (upper body); three diners in the background, nobody else`).
- `Outfits:` comes from the shot's beat (its opening beat), never the scene row; looks change
  within a scene. Valid pairs: `<characterKey>:<linked outfitKey>` (key from `design_plan.json`
  `outfits[]`, else `outfit_<c>_<look>`), `<characterKey>:nude`, `<characterKey>:none` (no
  outfit design for this look: the character design is the picture; looks: "References by
  extent" in `workflow-calling-conventions`). `:none` is for a character who wears nothing by
  nature (a creature, an animal). A clothed person whose look has no linked outfit design is a
  production defect: say so in the hand-over summary, write `:none`, state the garments in
  `Pose:` (from the beat / the wardrobe tracker row; `Pose:` survives into clip tasks) and in the
  plan prompt — and garments that come off still go in `Wardrobe:` (`removed:` / `partly:`, allowed
  on a `:none` look), so they are carried and checked.
- Wardrobe is carried through the scene: once any garment of a person is `partly:` / `removed:`, every
  later shot showing them has a full `Wardrobe:` entry (also a `cut`, not only a `continue`); a garment the
  act or blocking needs off (e.g. a top, for skin contact) is `removed:` in some shot's `Wardrobe:` BEFORE
  it must be off - for every person, not just one; a `removed:` garment never returns unless an `Action:`
  puts it back on; and a garment is worn once (no doubled layers, e.g. two tops).
- Partial undress inside an undressing beat: a shot that still shows a garment of the earlier look
  keeps that OUTFIT key + `Wardrobe:` (`removed:` / `partly:`), even when the beat's Outfits says
  `nude`; `:nude` starts at the first shot where nothing is worn.
- A beat whose ACTION changes a look (undresses, unties, takes off, puts on) starts in the EARLIER
  look, whatever its Outfits column says: the shot(s) before the change wear it, and the change itself
  is a `Motion:` beat of the shot that ends where the new look shows ("4-6 s <A's key>: unties her
  scarf and lets it fall"); the NEXT shot's `Wardrobe:` shows the scarf removed. When the
  scene list gives only the later look for such a beat, take the earlier one from the character's
  previous beat in this scene (or its wardrobe-tracker row) and name the mismatch in the hand-over
  summary - never drop the change.
- `Blocking:` places only people in frame plus a POV owner: "the camera is the viewer's eyes
  (seated); the viewer's forearms and hands enter the lower frame". Never call a POV owner whose
  limbs are in `Visible:` "off-frame"; "(off-frame)" is only for someone with nothing in frame.
- `POV: <characterKey> (seated|standing|kneeling|lying|walking)` only for a first-person camera; the
  posture is REQUIRED (a `POV:` line without one, or with another, is refused - there is no default);
  the posture decides what the camera may do (the first-person camera table under "Camera moves"); the posture is said in words only ("first-person view,
  standing"). A first-person view shows only the viewer's own body seen from their eyes; the
  posture decides the extent in frame (rule R4): seated / kneeling / standing `limbs` or `lower body`
  (lap, thighs — and the hands resting there); lying also `upper body` (the chest seen from above) —
  never `face` or `full figure`. Pick the extent that shows every part of theirs a `Contact:` or the
  act touches: a touch on the viewer's lap or groin is `lower body` (or `upper body` lying), never
  `limbs`. With none of their body in frame, leave them out of `Characters:` / `Visible:`. The server
  states the viewer's sex, skin tone and garments itself (from their design and `Outfits:` look) —
  never describe their face. Their key appears ONLY in
  `POV:`, `Visible:`, `Characters:` and `Outfits:`. In `Action:`, `Blocking:`, `Pose:` and `Frame:`
  they are only "the viewer" ("the viewer's forearms and hands enter the lower frame") — never
  their name, key or a figure ("as <the owner's name> watches", "<owner's name> seated centre frame as POV"):
  the server copies these lines verbatim into the prompt, and a name there summons the whole
  person. The write is refused (rule R8: "Blocking names the POV owner (`<Name>`) …") when one of
  these lines holds the owner's key, the key's name words (`character_<name>` → "<name>") or
  their display name — also as an owner of something ("<B>'s partner's hand", "<A> and <owner>
  remain"): write "the viewer's hand", "<A> remains in front of the viewer". Anyone else
  seen only by `limbs` (hands / feet at the edge) is likewise named by role in words ("a man's hands"),
  never as a figure. Another person shown by `lower body` IS a figure: they are counted, pictured
  (design picture and outfit) and placed in `Blocking:`.
- `Pose:` per person in frame (body position); for a `:none` look also its garments. For an extreme
  close-up, close-up or medium close-up, `Blocking:` / `Pose:` (and the plan entities' `posture` /
  `support`) describe only what the frame HOLDS: an eyes or face shot names the head, gaze and
  expression - no seat, knees, hands or support below the frame (the server crops the place to the
  shot's size, and a seat or knees in the prompt pulls the camera back to show them); the body belongs
  to the wider shot beside it.
- `Body pose: <pose>: <key>[, <key>]; <pose>: <key>` (any workspace) whenever a person's body position
  is one of the catalog poses (`workflow-calling-conventions`, "Body poses"): sitting, kneeling,
  leaning, walking - and ALWAYS when two people kiss, embrace, carry or dance. Keys are `Characters:`
  keys in the pose's role order (two-person poses: the one who acts first - `carried kiss: <carrier>,
  <carried>`), one entry per pose, each person in at most ONE entry, ONE `Body pose:` line per shot.
  Prefer the closest catalog name over `other (<words>)` (only a catalog name is stated limb by limb):
  a lift is `carried kiss` / `bridal carry` / `piggyback` by how the legs are held. Never beside
  `Sex position:` (the explicit position already poses its people). Each person's `Pose:` line must
  agree with the named pose (the same support, facing and limbs: `tiptoe kiss` = she is on tiptoe,
  arms around his neck); a pose changes = a new shot.
- A character with a `true size (not human-sized)` line in the Referenced designs block (a doll, a pet, a
  giant) is NOT drawn at a person's size: its `Pose:` says how it is held and how big it is ("a small doll
  in her arms at her chest"), and a `Contact:` entry states the hold; a held small character is pictured
  small in the holder's arms or hands, never as a person-sized figure standing beside them (its `Visible:`
  extent is still what the frame shows of it).
- **Identity comes from the design picture, never from words.** Shot lines (`Action:`, `Blocking:`, `Pose:`,
  `Frame:`) and plan prompts describe only pose, expression, wardrobe state and position — never a pictured
  person's face, skin tone, hair, age or build: the approved design picture is the authority, and a
  second description in the prompt fights it and drifts the likeness.
- **Geometry — one physical setup per shot** (the keyframe model draws exactly what the lines say; it cannot
  repair a contradiction, it follows the loudest line):
  - `Blocking:` places EVERY person in frame (not the viewer, who is "the viewer") by name: a spot or
    piece of furniture in the place (`on the left sofa`, `at the counter`) AND their position relative
    to the other people and the viewer (`facing the viewer, an arm's length in front of him`, `on the
    sofa next to the viewer's`). Where the viewer is and their posture are stated too ("the viewer
    sits on the right sofa"). Two people never share a seat or a spot unless the shot says so
    (`on the viewer's lap`); a person without a stated seat gets put wherever the model likes. The write
    is refused when a person of `Characters:` is not named in `Blocking:` (rule R13; the viewer and
    anyone shown only by `limbs` are exempt; a non-viewer `lower body` person must be named).
  - The camera IS the viewer's eyes: its height and direction follow the POV owner's posture and
    spot — a seated or lying viewer has an eye-level of a seated / lying person, never "water level" or
    "from the floor" unless they are there, never "at hip height", "from the side of the sofa" or
    any position offset from the viewer's head (for that view write a third-person shot with the owner
    as a figure). State `Camera:` and `Blocking:` from the same position. Angles by posture (rule R20,
    the write is refused): a lying viewer looks up or along their own body — never `high angle` or
    `top-down`; seated or kneeling never `top-down`; a slight high or low angle from a seat is fine.
  - A first-person act at the viewer's own groin (`Contact:` names the POV owner's `groin`) must have
    the contact point IN the frame. A standing or kneeling viewer looks DOWN at the joined hips:
    `Camera: high angle, medium shot` (or closer), the partner's extent `back`, `upper body` or
    `lower body` - never `eye level` / `low angle`, never a `full` / `wide` shot, never the partner's
    `full figure` (at eye level the joined hips lie below the frame; a full figure only fits at a
    distance where the bodies cannot be joined - the write is refused). A seated or lying viewer's
    partner is in front of / on them, so their usual angles hold. A beat that needs the whole place
    or the whole body is a third-person shot, or a shot before the bodies join.
  - A partner <B> who touches the viewer is pictured at least to the `upper body`, <B>'s arm reaching from their shoulder (a dance partner taking the viewer's hand): a lone `limbs` hand entering from the camera side reads as the viewer's own hand and <B> vanishes. <B>'s hands reaching DOWN to a lying viewer's torso (a physio's hands on the viewer's chest) need a `medium` frame or wider to be in frame (the write notes a tighter one). When a close framing would include a part of the viewer's body that no line states yet (the lap under a partner leaning over them), either state it (`lower body`, `Wardrobe: partly:` for a garment state; under nudity `allowed` also the state of the parts) or compose it out (a face or hands insert) - never leave it open.
  - The viewer's `Visible:` detail states exactly what `Blocking:` / `Pose:` show of them
    (`lower body` for "hands on the viewer's own thighs", `limbs: forearms and hands` when only the
    hands are in frame): the render and the judge read the viewer's body from `Visible:` alone.
  - What the shot shows must be visible from that camera position in the place: before combining two
    things in one view (a staircase and a fountain, a door and a window) check the place design — if they lie on
    opposite sides of the viewer, they are two shots, not one frame.
  - Contact must be physically possible from the stated positions: whoever touches whom is within
    reach from their seats / postures (`kneeling in front of <B>` needs <B> seated with room in front,
    not lying flat on a bench). If the Blocking cannot reach the Contact, change the Blocking.
    Each `Pose:` is physically possible for the stated posture: weight rests on supported feet, knees or
    hips, and a limb reaches only what it touches ("standing" with "her heels on his lower back" is
    impossible - make her lifted / seated, or drop the contact).
  - A state of the place a shot sets or relies on (door closed / locked, lights on, curtain drawn) is
    restated in the `Action:` or `Frame:` of EVERY later shot at that place that shows the fixture - the
    location picture shows its own state and wins over a shot that stays silent.
  - A reflective surface in frame (mirror, window, screen, water, glossy surface): a reflection is wanted only
    in a medium or wider shot and only when the story needs it; a close-up never asks for one beside the face.
    The `Reflection: <character key> in <surface>` line (one entry, a person in `Visible:`) states it: the real
    person stands in front of the surface and the surface holds only that person's own reflection, never a
    second person. A shot "from the surface's side" is a direct shot with the surface out of frame
    (`Out of frame: <surface>`); never write "the camera in the <surface>" or a person "in the glass" in
    `Frame:` / `Action:` / `Pose:`. Without a `Reflection:` line the angle shows no reflection.
  - A `continue` shot keeps everyone's spot and posture, the viewer's included, from the previous shot
    — copy the previous `Blocking:` positions and change only what the new `Action:` moves, and say
    so in `Action:` ("<B> has risen"). A person who moved in the story but not in the lines
    teleports in the render. A change of the viewer's posture is stated in `Action:` too ("the viewer
    now lies back on the bench") with the new `POV:` posture: the renderer then drops the previous
    frame (its viewpoint is the old eyes) and carries the state in words.
  - `Visible:` extents must fit `Camera:`'s framing size: `full figure` needs `full` / `wide`,
    `upper body` needs `medium close-up` or wider; a `close-up` is `face` (or hands / feet as `limbs`).
    Writing "medium, head to waist" with `full figure` draws full figures (rule R12 refuses it). Pick
    the extent the size really shows, or the size the extent needs — never both wide and tight.
    The extent is also what the framing actually shows, not only the minimum size: `lower body` on a
    waist-up two-shot contradicts its `Camera:`; write `upper body` there.
  - Describe only what the extent shows. A person shown by `limbs` (the viewer's hands) has no
    `Wardrobe:` entry (rule R14) and no garment, torso or lap wording anywhere in `Pose:` / `Frame:`:
    "grey shorts lowered" next to `limbs: hands` makes every take show the abdomen and lap. If the
    garment state matters, widen the extent (`lower body`) so the frame shows it.
- `Wardrobe:` = partial undress of an OUTFIT look, `<characterKey> (wearing: <garment>, …; partly:
  <garment> (<end state>), …; removed: <garment>, …)`, `;` between characters: the `Outfits:` pair keeps
  the outfit key while ANY of its garments is still on (the server keeps the outfit picture and states
  what is worn in words, "wears only ..."). `<key>:nude` only when nothing is worn (a Wardrobe entry on a
  `:nude` look is refused; on a `:none` look it is allowed — the garments in words only). Every garment of the look that changed goes in exactly ONE list:
  - `removed:` — fully OFF the body. Leave it unmentioned everywhere else in the shot and the prompt —
    never "held", never "in her hands", never "lying beside her": a named garment is painted back on.
  - `partly:` — still ON the body but displaced or open: lowered, pulled up, pushed up, unbuttoned,
    unzipped, a strap off one shoulder. Write the plain garment noun, then its END state in parentheses:
    `partly: grey shorts (lowered to mid-thigh)`. The state is where the garment is NOW (a still), never
    the motion ("being pulled down", "then kicked off"), at most 60 characters; do not repeat it in
    `Pose:`. A partly garment counts as worn: the server says "wears only … grey shorts (lowered to
    mid-thigh)" and the judge checks that exact state.
  - a NEW OUTFIT LOOK in the scene list instead, when the state is the designed look for several beats
    or scenes (an open shirt worn all evening) or a garment is added or swapped.
  `wearing:` lists what is worn as designed. Items are separated by commas outside the parentheses (a
  comma inside a state is fine); each item is a garment, never a state: `removed: grey shorts, lowered
  to mid-thigh` is refused — that is `partly: grey shorts (lowered to mid-thigh)`. `State:` is the BODY
  (wet hair, sweaty), never garments.
  Extent: the person's `Visible:` extent must show where a `partly:` garment is worn (rule R19): partly
  shorts need `lower body` or wider, a partly top `upper body`. For the POV viewer, `lower body` shows
  their own shorts and waistband (not their shirt); a `limbs` viewer has no `Wardrobe:` at all (R14).
  Examples:
  - POV, the viewer's own shorts lowered: `POV: <owner's key> (seated)`, `Visible: …;
    <owner's key> (lower body); nobody else`, `Wardrobe: <owner's key> (wearing: linen
    shirt; partly: shorts (lowered to mid-thigh))`.
  - Top off, cardigan slipped down: `Outfits: <A's key>:<outfit_a_look>` + `Wardrobe:
    <A's key> (wearing: skirt; partly: cardigan (off both shoulders, at the elbows);
    removed: blouse)`.
  - Jacket open: `Wardrobe: character_officer (wearing: uniform trousers, boots; partly: uniform jacket
    (unbuttoned, open))`.
  A keyframe is a still, so a garment state is written as the state of the still, never as the motion:
  "back bare, both hands at her waist", not "untying the strings, top slipping down" (the model paints
  the tied top). The shot whose Motion performs the undress shows the BEFORE state in its picture lines
  (R27); the following shot shows this removed state. In `Action:` / `Pose:` / `Frame:` and the prompt, a REMOVED garment is not
  mentioned at all — "blouse held in her hands" or "cardigan slipped off her shoulders" summons
  it back on (measured on one production, 2026-11: nearly every take kept the held garment on; re-measure); a garment that is still on her arms
  is `partly: cardigan (off both shoulders, at the elbows)` instead.
- `Expression:` = the face at t=0 of the keyframe, `<characterKey> (<expression>, <expression>, …)`, `;` between characters
  (e.g. `Expression: <A's key> (tired smile, eyes on the lens); <B's key> (surprised)`):
  at most 4 short phrases per person, each at most 40 characters — shocked, blushing, nervous,
  smug, tearful, determined, amused (under nudity `allowed` also seductive, aroused, ecstatic). Every shot with a visible face has one entry per person whose face shows (extent
  `full figure` / `upper body` / `face`); never for the POV owner or a `back` / `limbs` / `lower body` person. It is the face,
  `State:` is the body (wet hair, mud); where the head or eyes point belongs in `Pose:` with a TARGET
  ("eyes level on <Other>", "head turned toward <thing>"), never a bare direction ("chin lifted",
  "face raised") — a head direction without a target is rendered toward the nearest default (the ceiling); keep it consistent with the beat's emotion. An expression that CHANGES during
  the clip is a `Motion:` beat, not a second `Expression:`. Crying is an expression (`teary eyes`,
  `glistening eyes`), never fluid on the skin: "tear tracks" / "tear-streaked" render as thick streaks;
  name no body fluid a shot does not explicitly need.
- `State:` = transient, VISIBLE appearance of a person shown as a figure, `<characterKey> (<state>, <state>, …)`,
  `;` between characters: short phrases of what the camera sees — `wet hair`, `wet skin`, `sweaty`,
  `messy hair`, `make-up smudged`, `flushed` (at most 6 per person, each at most 40 characters; never for
  the POV owner or a `limbs` person — they are words only). Write it in the first shot AFTER the action
  that changes such a state (<A>'s beat "climbs out of the water" is in shot k → shot k+1 has `State:
  <A's key> (wet hair, wet skin)`; shot k itself, which starts before <A> climbs out, does not) and
  in EVERY later shot of the scene that shows the person while it lasts — a `continue` shot must restate
  it (rule R18); a `cut` shot later in the same moment should repeat it too (not checked — your job).
  A distinctive marking in the character's digest (tattoo, scar, birthmark) is permanent, but it is written
  as a `State:` entry ONLY in a shot that shows that body area BARE: side + body part (`tattoo left upper arm`,
  at most 40 characters), so it lands on the right arm and the right person. Where clothing covers it, or the
  framing leaves that area out, write NOTHING about it - never `under sleeve` / `covered` / `hidden`: the image
  model draws every marking it reads, so a covered tattoo is painted onto the sleeve or the forearm. A marking
  of a `limbs` / POV person goes in words in `Pose:` under the same rule (only when that area is bare in frame).
  A visible fluid or residue is a `State:` entry of the person it is on (`sweaty`, `rain on face`,
  `flour on hands`, `blood on knuckles`), from the shot that first shows it until it is cleaned or
  covered. Under nudity `allowed` the same holds for explicit fluids (`semen on <her/his> face`,
  `saliva on lips and chin`); a `cumshot` shot's `Contact:` then names where it lands
  (`<A's key> (groin) on <B's key> (face)`).
  When it ends, say so, preferably as the explicit new state (`dry hair`, `dry skin`): the judge checks
  a named state best. `(none)` means back to the design's own look (the server then states "no longer:
  <the previous shot's states>"); write it alone, never mixed with states. The server states each state
  as "must show" and the judge checks it; nothing carries over unless the line says it. A beat's outfit look with a partial state in its Action → every shot of that beat keeps the outfit key and states the state in `Wardrobe:` (e.g. `Wardrobe: character_x (wearing: pale shorts; removed: yellow sundress)`); a `continue` shot restates it (R17).
- `Contact:` = every touch the frame shows at ONE instant (never a motion path of successive contacts - that is
  `Motion:`), `<characterKey> (<body part>) on <characterKey> (<body part>)`
  or `<characterKey> (<body part>) on <thing>`, `;`-separated (`none` / omit = no touch). A thing is
  plain words, never written like a person: `character_brianna (hands) on bin lid`, not `bin (lid)`. Body parts
  (exactly these; singular or `lips` accepted): head, face, mouth, neck, shoulders, chest, breasts,
  back, waist, belly, hips, buttocks, groin, lap, thighs, legs, knees, feet, arms, forearms, hands,
  fingers. Copy the beat's `Contact` onto the shot that shows the touch: a beat with a `Contact` needs
  at least one shot with a `Contact:` line. Every named part must be in frame by that person's
  `Visible:` extent (rule R10): `face` shows head, face, mouth, neck; `upper body` head to hands;
  `lower body` waist, hips, buttocks, groin, lap, legs, feet; `limbs` arms and legs; `back` the figure
  from behind; `full figure` everything — widen the extent (or reframe) when a touched part is
  hidden. A shot with a `Sex act:` always has a `Contact:` line naming the contact points.
- `Sex act:` / `Sex position:` only when `{workspace.contentPolicy.nudity}` is `allowed` and all
  depicted are adults: copy the beat's columns (names: skill `explicit-acts`, `load_skill` it first); both
  `none` or both set. ONE position per shot; when the beat's position does not match the staging
  (a lift against the vanity coded `standing face to face`), use the position whose support matches
  (`standing carry`, `edge of surface`, ...) - the server states it limb by limb in every shot of the
  act, so the `Pose:` lines must agree with it (who stands, who is lifted, what each faces). Otherwise omit both. A split beat's act goes on every shot whose frame shows
  the act being performed; its lead-up or aftermath shots carry `none` — never drop the act: at
  least one shot of the beat carries every act name of the beat (checked at the write: `beat 1.9:
  Sex act \`blowjob\` is on no shot of the beat`), with its `Contact:` points.
- **An act lasts until the people separate.** While the bodies are still joined - the act paused,
  interrupted, frozen mid-act ("frozen mid-thrust", "both freeze as a car arrives"), or a reaction
  shot during it - the shot keeps the act's `Sex act:` / `Sex position:` and its `Contact:` points
  (the groin contact included), even when its beat's act is over or its `Action:` is about
  something else. Set `none` and drop the contact only in the shot where they visibly separate (or
  a cutaway that shows neither of them). A `continue` shot during an act copies the previous shot's
  act lines unless its `Action:` separates them - words like "mid-thrust" next to `Sex act: none`
  are a contradiction the renderer resolves by showing NO act.
  The server shows the act ("must show") only when a `Contact:` entry touches an intimate part
  (groin, buttocks, breasts). A close-up whose contacts are hands on shoulders or fingers on a thigh
  keeps the `Sex act:` / `Sex position:` lines for the record, but the server then says NOTHING about
  the act to the renderer and loads NO act LoRA (the act words and
  the act LoRA draw an out-of-frame act into the frame). So curate NO act / position LoRA on such a shot's `LoRAs:` line
  (the write notes "act LoRAs not loaded (the act is out of frame)"): only the LoRAs for what the shot SHOWS
  (style, skin, the touched body part, the place).
- Act / position LoRAs: only for a shot whose act is SHOWN (an intimate `Contact:` entry in frame). Then curate them on the `LoRAs:` line like any other (infer from name and description which
  serve the act; rank them high; see "Act shots" in "Curated LoRAs" for the order; a third-person act shot
  also gets the krea2 act LoRAs on that line - the staging drafts render on krea2 and load them, the real
  keyframe renders ignore a LoRA of another family) and name the act and position exactly from the vocabulary in
  skill `explicit-acts`. If the catalog tags LoRAs with `sexActs` /
  `sexPositions`, the server adds a matching tagged LoRA when none of your listed ones covers the shot's act.

### Writing rules per shot

Write each shot to these rules as you write it — do not re-check every shot against them in your
reasoning: `write_shot` validates the shot (R1–R20, keys, unreadable lines) and refuses with the
exact fix, `run_checks` and `draft_storyboard` judge the whole scene. Fix what a refusal names and
send that shot again:
- camera's eye — what the lens sees from the viewer's spot and facing in `Blocking:`:
  - everything `Frame:` puts in the background lies IN FRONT of the camera; a thing the viewer sits
    beside or has their back to (the doors behind their chair) cannot be in the background;
  - a garment still worn hides what it covers from this side: "bare back" seen from behind with an
    open cardigan on is impossible — take the cardigan off (`Wardrobe:`) or show the bare part from
    a side it is visible from;
  - the viewer's own seat, chair or bench is never an object in the frame (the camera sits in it):
    only their limbs per `Visible:`; never "the wicker chair in front of the camera";
  - a garment `removed:` in `Wardrobe:` is not mentioned anywhere in the shot (not held, not nearby);
  - nothing that must stay out of frame is named in `Action:` / `Blocking:` / `Pose:` / `Frame:` (not
    negated, not "behind the camera"): it is on `Out of frame:` only, and never a person;
- `Wardrobe:` `wearing:` / `removed:` items are plain garment nouns, comma-separated, no descriptions;
  a garment still on but displaced is `partly: <garment> (<end state>)`, in one list only, its extent
  shows where it is worn (R19), and a `continue` shot restates it where its extent shows it (R17, the viewer's own too);
- `State:`: every person whose visible state the action changed (wet, sweaty, messy) has it here and
  in every later shot that shows them while it lasts; a `continue` shot restates the previous shot's
  `State:` of everyone it shows (R18), or says what changed (an explicit `dry hair` rather than `(none)`);
- every `Visible:` entry has ONE extent (no "and", "then" or ", nude" inside the parentheses);
- geometry: everyone in frame is placed in `Blocking:` (spot + relative to the others and the viewer),
  the camera is at the viewer's eyes and its angle fits their posture (R20: lying never high angle /
  top-down, seated / kneeling never top-down), the viewer's `Visible:` detail is what `Blocking:` /
  `Pose:` show of them, a posture change is said in `Action:`, everything in one view is visible from the camera's
  spot, the `Contact:` is within reach, a `continue` shot keeps the previous positions, every
  `Visible:` extent fits the `Camera:` size, and a limbs-only person has no `Wardrobe:` / torso wording;
  a POV owner in frame is `limbs` / `lower body` (lying: also `upper body`);
- every `Action:` and `Camera:` is ONE moment: no two successive verbs, no `then` / `after` /
  `before` / `followed by` / `cut to` / arrows; a sequence is split into more shots (never
  rephrased); every action of every beat has a shot;
- every shot has `Beat:`; every beat has a shot; every beat's `Contact` is on a shot's `Contact:`
  whose touched parts the `Visible:` extents show (the viewer's lap / groin = `lower body`);
- partial undress of an outfit = the outfit key + `Wardrobe:` (`removed:` fully off, `partly:` still on
  but displaced) — also inside an undressing beat while a garment is still shown; `:nude` only when
  nothing is worn; `:none` on a clothed person is a defect named in the summary, its garments that
  come off still in `Wardrobe:`;
- `Camera:` is the opening framing only and opens with a standard framing size; the shot holds
  one place; a `continue` shot keeps the previous shot's `Location:` and changes the framing size
  or angle (R16), and its `Movement:` performs that change — a move of the "Camera moves" row of each
  changed dimension (size: push in / pull out; side: arc; height: crane / pedestal), else `cut` (R25);
- `(view <id>)` on `Location:` / `Outfits:` / `Characters:` only with a listed view id; the shot's `Blocking:` /
  `Frame:` match the chosen picture's layout;
- the POV owner is "the viewer" in `Action:` / `Blocking:` / `Pose:` / `Frame:` — never by name,
  key, name word or as a figure, not even as an owner ("<owner>'s glass"); limbs-only people
  likewise only as their limbs in words;
- every beat's `Sex act` / `Sex position` is on the shot(s) that show it (nudity `allowed` only).

## 3 Plan each shot, then hand over — `plan_shot`, `draft_storyboard()`

One `plan_shot` call per shot, right after that shot's `write_shot` was accepted (the plan is built
from the shot's lines): `plan_shot` takes ONE plan - the fields below at the top level - checks it
alone and stores it; a repeat for the same shot id replaces the stored plan. A refusal lists only that
shot's problems (an enum field names its allowed values): fix THAT plan and send it again, never
touch other shots. Never put all shots into one call - a plan for every shot in one reply is too
long and one mistake forces a rewrite of all of them. A plan is tied to the shot's lines it was made
from: when you change a shot with `write_shot` after planning it, plan it again with a CHANGED plan
(an identical repeat is not stored again) - `draft_storyboard` refuses a shot whose lines changed
since its plan. A plan of a shot that is no longer in `shotlist.md` is dropped at hand-over.

When your tools include `run_checks`, call it once after the last `write_shot` was accepted and
fix every shot a rejected check names (`write_shot`, then `plan_shot` again for it, then
`run_checks` again) BEFORE `draft_storyboard`: the server renders as soon as the plans are handed
over, so a contradiction found later costs a full re-render. Then call `draft_storyboard()` with NO
arguments: it hands over the stored plans. The first call must have a plan for EVERY shot of
`shotlist.md` (a shot without one is refused by id - plan it and call again). Per shot, the arguments
of `plan_shot` (the example shot s3-01 above):

```
{ "shot": "s3-01",
  "entities": [
    { "key": "character_wife", "kind": "person", "region": { "third": "centre", "depth": "background" },
      "facing": "camera", "gaze": "laptop", "posture": "seated", "support": "chair", "contact_with": ["laptop"] },
    { "key": "character_b", "kind": "person", "region": { "third": "centre", "depth": "frame-edge" },
      "facing": "away", "limbs": "forearms and hands" },
    { "kind": "object", "count": 1, "region": { "third": "centre", "depth": "midground" }, "facing": "camera" } ],
  "prompt": "Medium shot, eye level, first-person view from a seat at the kitchen table:
    [[character_wife]], ... seated across the table, head down, hands on the
    keyboard of an open laptop; at the lower edge the viewer's own forearms and hands resting on the
    table. <place in words>. <production style line>. No text or lettering." }
```

Other shapes: a crowd beside a principal = `{ "kind": "person", "count": 3, "extras": 20, … }`
(3 placed figures plus a loosely counted crowd); a shot with nobody in frame (`Visible: nobody`) =
`"entities": []` or only its animals / props, the prompt describing the place.

### Entities — fill them from `Blocking:`, `Pose:`, `Frame:`, `Visible:`

- Exactly one entity per key of the shot's `Characters:`, with that `key` (`kind` = what the
  design depicts: a person, an animal or a creature). Everything else that matters to the frame and
  has no design — extras, animals, props — is an entry without `key`, with its `kind` (`person` |
  `animal` | `creature` | `object`) and the exact `count` the frame shows; `extras` adds loosely
  counted background figures (a crowd). Entries without `key` never take a picture.
- `region.third` (`left` | `centre` | `right`) and `region.depth` (`foreground` | `midground` |
  `background` | `frame-edge`) come from `Frame:` and `Blocking:`; `facing` (`camera` | `left` |
  `right` | `away` | `down` | `up`) from `Blocking:` / `Pose:` — the server states it for every
  figure as a frame requirement ("Wife faces away from the camera"), so set it deliberately.
  `facing` is where the TORSO and hips point, never the head: a figure with its back to the lens
  who looks back over the shoulder is `away` (the head turn goes in `Pose:` and the prompt); only a
  figure whose chest is turned to the lens is `camera`.
  `facing`, `posture`, `support` and `region` describe the OPENING frame (0 s), never the end state of
  `Motion:`: a turn or move that happens during the shot is a `Motion:` beat, not the plan entity.
  The facing must fit the same person's `Pose:` / `support` (a person bent toward a feature faces it,
  not the opposite way).
- `gaze` = where the eyes are directed in the opening frame — REQUIRED for every person whose face is
  shown (facing `camera` | `left` | `right`, head in frame): `camera` (the lens), another person's key from
  `Characters:`, `off-frame left|right|up|down`, or a thing in words (`<thing>`). The server states it
  ("<Name> looks at <Other>, eyes level") and the take check asks it. In a shot / reverse shot (A looks
  at B, then B at A, same place) the two gazing bodies face opposite frame sides (`left` vs `right`) so
  the eyelines meet; the plan is refused otherwise.
- `motion` = where a moving figure is heading in this instant ("walking toward the doors"); omit
  for a still figure. The server adds it to the figure's facing line.
- `posture` = a person's body posture from `Pose:`: `standing` | `seated` | `kneeling` | `lying`.
  Set it for every person shown as a figure: the framing check judges a frame too wide by the cut-off
  body (ankles in a medium full shot) only for standing people.
- `support` = what they sit, stand or lie on, or are in, when it matters — name the container:
  "in the bathtub", "on the grey sofa" (the take check holds every figure to it). A close-up
  states `support` only when the support is in frame.
  A THIRD-PERSON act shot (a `Sex act:` and no `POV:`) ALWAYS names the anchor furniture the act uses
  in `support` ("on the bed", "against the kitchen counter", "on the sofa"): the two-stage keyframe
  route stages the act on it before the real people are composed in.
  `contact_with` = who or what they touch (from `Blocking:`), only when there is contact.
- The POV owner (`POV:`) is the camera. When their limbs are in frame (they are in `Characters:`):
  an entity with `region.depth: "frame-edge"` and `limbs` (matching their `Visible:` detail) — never
  a full person. With nothing of them in frame they are not in `Characters:` and get no entity.
- Pictures: the place; for a `continue` shot ALSO the previous shot's frame; then one picture
  per figure (words-only people — the POV owner, limbs-only — take none). A shot needing more than
  the render workflow's image slots is not refused: the server leaves out the lowest-priority
  person and names them in words. To keep everyone pictured, split such a shot in `shotlist.md` by
  WHO is in frame (each part shows a subset; the rest is off-frame there), never by time alone.

### Prompt — the visible end state of the frame

The server appends the shot's own `Visible:` (as the exact people count), the viewer's body
(sex, skin tone, garments), `Blocking:`, `Pose:`, each figure's facing / motion, the `Wardrobe:`
state, the `State:` states, the `Contact:` points and `Frame:` lines to every prompt, under
`Frame requirements (authoritative - they override anything above):`. So the prompt is the scene
in your words: never repeat those lines and never contradict them. State NO people count in the
prompt ("exactly two people", "three of them", "alone") — the server states the one count; a count
of your own can only disagree with it.

- Describe what the opening frame SHOWS, never a process or a change ("wife seated, hands on the
  keyboard", not "the wife sits down and starts typing"). A prompt with `then` / `after` / `before`
  / `followed by` / `cut to` / an arrow is refused ("Close-up on her face then cut to hands" is two
  shots). Never put `Movement:`, `Transition:` or `Duration:` in it (a keyframe is a still).
- Write each shot's prompt from ITS OWN lines: never copy another shot's people, placeholders or
  who-is-where wording.
- Name every figure as `[[<design key>]]` (the entity keys, except words-only people), with their look and outfit
  in words and their place in the frame — no count. Never exclude anybody by name ("no <B>"
  summons him; the server's count excludes everyone else). Never write "Picture N" or number
  images; the server does.
- Add the shot's camera and framing, the place in words and the style line of the production
  (the medium / style of the story is kept verbatim).
- No speech bubbles, captions, signs or lettering unless the shot asks for them.
- Never name what must not be in the picture — not negated ("no <thing>"), not "behind the camera",
  not "out of frame": the shot's `Out of frame:` line is the only place, and the server keeps it out
  of the prompt. Describe what fills that part of the frame instead.
- Words-only people — the POV owner and anyone seen only by `limbs` — are never a
  placeholder or a name: "the viewer's own forearms and hands at the lower edge" (a `[[key]]` of
  theirs is refused).
- Describe the viewer only within their `Visible:` extent: for `limbs: hands` write the hands
  and nothing else; never name the viewer's garments above what the extent shows ("beige shirt
  open at the waist" in a `lower body` shot draws the shirt and chest). A garment of the viewer
  is always "the viewer's own"; never place it near another person's body.
- Wear state in the prompt is positive: what each person wears now ("wears only the navy
  trousers"), never "without the cardigan" or "the cardigan is off".
- Explicit acts and positions: copy the shot's `Sex act:` / `Sex position:` words (names in
  skill `explicit-acts`), only under the nudity policy.

`plan_shot` returns `shot <id> planned` or an `error:` for that shot. `draft_storyboard()` returns
`accepted: …` or an `error:` listing every problem; nothing was started in the error case. Fix the
plan of each shot it names with `plan_shot` — or, when a problem names a shot to add or fix, send that
shot with `write_shot` first, then plan it again — and call `draft_storyboard()` again (no arguments;
the stored plans of the other shots stay). Keep fixing and calling until it is accepted:
`task_complete` is refused while no plan was accepted.

## 4 Audit and hand over

- [ ] every shot of `shotlist.md` has a `plan_shot` plan and the hand-over was accepted (re-read the file)
- [ ] ONE moment and ONE framing per shot (no `then` / `after` / `before` / `followed by` /
      `cut to` / arrows, no two successive verbs; every multi-action beat split into one shot per
      action, never rephrased)
- [ ] every `Transition:` describes the step FROM the previous shot INTO this one (shot 1 `cut`; no
      "end of scene"; the first shot of a `new moment` / `parallel` beat is a `cut`)
- [ ] a continuous moment is `continue` shots with performable steps (size step or an arc within `max_arc_degrees`), and both `Camera:` lines of each pair state height AND direction
- [ ] a marking (tattoo, scar) appears in `State:` only where its body area is bare in frame - never "under sleeve" / "covered"
- [ ] every `Transition: continue` shot has a `Movement:` (and, with `Timing: beats`, `camera` beats) that
      performs its framing change (push in / pull out for size; arc for the side; crane /
      pedestal for the height; never pan / tilt / truck / follow / handheld / hold); otherwise
      it is a `cut`
- [ ] every shot names its `Beat:`; every beat has a shot; every beat's `Contact` is on a shot
- [ ] with `Timing: beats`: `Action:` is the 0 s state; every shot has `Motion:` beats (no gaps, each at
      least 1 s, every figure and the camera covered, ending at `Duration:`), each `Dialogue:` line has a
      speaker key and a delivery and fits its time, and `Audio:` is the scene's, verbatim, on every shot
- [ ] with `Timing: beats`: every beat names its mechanics and end state; every `Wardrobe:` / `State:`
      difference to the next shot is performed by a beat of THIS shot naming the garment and where it
      ends up (R26), this shot's own picture lines show each person at the instant before their
      first beat (R27), and every shot ends on a held state: the last beat finishes the action and
      settles, a move toward the next action starts the next shot, the camera move ends on what the
      frame holds at the end, never on where the next action happens (R33)
- [ ] every `POV:` line names a posture; every first-person shot's `Movement:` / `camera` beats only name
      what the viewer's posture allows (R29 table); a new framing for a seated, lying or attached
      viewer is a `cut`; a `continuous` beat where only the people move is a `continue` that keeps the
      framing with a changed `Pose:` / `Contact:`
- [ ] the POV owner is only "the viewer" in `Action:` / `Blocking:` / `Pose:` / `Frame:` and the
      prompt (no name, key, placeholder or figure); no prompt copies another shot's people
- [ ] every POV owner's `Visible:` extent covers each part of their own body that `Pose:` /
      `Blocking:` / `Contact:` put in frame: hands resting on their own thighs or lap are `lower body`,
      never `limbs` (the judge fails every take whose frame shows more of the viewer than `Visible:`)
- [ ] every first-person act at the viewer's groin looks down at it (high angle, medium or closer,
      the partner never `full figure`) - the contact point is inside the frame
- [ ] no plan prompt states a people count (the server's frame requirements state it)
- [ ] every beat's `Sex act` / `Sex position` is carried by the shot(s) that show it (nudity
      `allowed` only)
- [ ] every kiss / embrace / carry / dance - and every catalog sitting, kneeling, leaning or walking
      pose - is on a `Body pose:` line (catalog name, keys in role order); `Pose:` agrees with it and
      with the `Sex position:`
- [ ] `draft_storyboard` was accepted; `design.json` untouched
- `task_complete(summary="Storyboard scene <n>: <N> shots handed to the server; open: …")` (1–3
  lines). The takes land afterwards; this hands the design to the person, it does not finish it.
- Retry drafting: keep the existing `shotlist.md`; `plan_shot` the shots the stop reason names -
  every shot when no plan was accepted before (the first accepted hand-over must cover them all) -
  then `draft_storyboard()`, then `task_complete`.

## Chat (after hand-over)

- Each message: `read_artifact` again; the current `shotlist.md` and file list are the truth (a
  missing take was discarded by the person).
- Shot changes (add, retitle, change lines): `write_shot` for each changed or new shot — the
  same id replaces its section, a new shot gets an id after the highest and lands at the end;
  `Transition` re-derived for shots whose predecessor changed; then `plan_shot` for each changed or
  new shot and `draft_storyboard()` (no arguments - it hands over only the shots planned since the last
  hand-over). A refused shot is not saved: fix what the refusal names and send it
  again, or say it failed. Removing or reordering shots is the one case for a complete
  `sandbox_write_file` of the whole file (all checks apply; a refusal keeps your text as a draft
  that `sandbox_edit_file` fixes).
- When you change a shot's lines with `write_shot` after its takes were rendered, plan it again
  with `plan_shot` before your next `draft_storyboard()`. Its picked take was rendered from the older
  lines: the studio marks it "Older shot lines", Finish warns about it, and `draft_storyboard`
  refuses a hand-over that leaves it out.
- "Another angle for shot 4" / a different pose: change the shot's lines, send it with
  `write_shot`, plan it with `plan_shot`, call `draft_storyboard()`. Never `wf_*` for a shot take.
- Who is visible follows the shot lines: change `Visible:` / `Characters:` / `Outfits:` first.
- Reply in one short line naming what THIS turn wrote or handed over, then stop; never claim a
  change you did not make. Never pick, discard or finish — point to the studio.
