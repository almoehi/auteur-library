---
name: create-scene-list
description: >
  Use when your task prompt says "Load and use skill: create-scene-list" — turn the screenplay and
  the character table into scene_list.md: a scene table (one place per row, outfits per scene) plus
  a Beats table per scene (Outfits, Camera move, Continuity, Blocking, Contact and, when nudity is
  allowed, Act). Produces the `scene_list` artifact that design planning and storyboards read.
  Do NOT invoke for writing the screenplay or character profiles, planning designs, or shooting.
agentType: worker
---

# Create scene list

Runs in the worker of the `create_scenes` task (created by `run-preproduction`). The nudity policy
is `{workspace.contentPolicy.nudity}` (absent or empty = `forbidden`); the "Workspace facts" block
below shows its current value. The `scenes-complete` check judges the result against exactly these
rules.

## Preflight

The task prompt names the inputs (artifact `character_table`, artifact `screenplay`) and the output
file `scene_list.md`. If either input is missing, call `task_failed` with a clear message.

## Rules

FIRST STEP, before writing anything: read every `character_<slug>.md` of the character table and
list (a) the character stems (`<character_slug>`) and (b) each character's WARDROBE TRACKER look
slugs; from then on copy those slugs EXACTLY. Never invent a name, a character or a look slug (a
character the story names only by role keeps the role slug, e.g. `sister`).
Then write the single output file `scene_list.md` as plain Markdown (never PDF or DOCX), containing ONE markdown table with exactly these columns:
`Scene #` | `INT/EXT` (exactly `INT` or `EXT`; never `INT/EXT` or `EXT/INT`) | `Location` (display name of the ONE place) | `location_slug` (lowercase slug, stable:
the same place has the same slug in every scene) | `Time of day` | `Summary` (one sentence) |
`Characters present` | `Outfits` = the set of ALL looks the scene's beats use, as
`<character_slug>:<look_slug>` pairs separated by `; ` (e.g. `mira:raincoat; jonas:work_suit`; a
character who changes look inside the scene appears once per look: `sister:bikini_cardigan; sister:nude`).
The row's `Outfits` is exactly the UNION of the `Outfits` of its beats (below): nothing missing, nothing extra.
The Summary names every entrance, exit and spoken line that matters to the story, not only the
main action.
Character slugs must equal the `character_<slug>.md` file stems from the character table; the
`Outfits` column uses ONLY look slugs from that character's WARDROBE TRACKER (copy them exactly; add a
new row there only if the screenplay demands one, and say so in the summary), `nude` (only for an
adult in a workspace with `{workspace.contentPolicy.nudity}` allowed; a character's BASE look - the `wardrobe` of its character design in `plan-designs` - is `nude` for EVERY such adult, decided by age and policy only, never by whether the character is shown nude in a scene or by character-table notes like "face never shown"; garments belong to outfit looks, never to the base look), or `none` (a character that wears nothing, e.g. an animal). Every present character needs a look in every beat they are visible in. A point-of-view character whose hands or body are in frame counts as visible: list them in that beat's `Outfits`. A character who appears only in a `parallel` cutaway beat at another place need not be in the scene row's `Characters present`, but is still listed in that beat's `Outfits` and in the row's `Outfits` union.
**A scene row = ONE place and ONE continuous time.** A change of place starts a new scene; never
merge two places into one row ("Backyard terrace / Hallway" is two scenes). The short-film
default of about 4 scenes never overrides this: add scenes rather than merge places.
**Beats section (below the table, same file).** For EACH scene a `### Scene <n>` heading and a
markdown table with one row per beat: `Beat #` | `Action` (what visibly happens) | `Location` (the `location_slug` of where the beat happens: for every beat that is not `parallel` EXACTLY this scene row's own slug; only a `parallel` beat / cutaway names another place) | `Outfits` (REQUIRED, right after `Location`: the looks of the characters VISIBLE in this beat as `<character_slug>:<look_slug>` pairs separated by `; `, e.g. `husband:linen_shorts; sister:nude`; `none` when nobody is visible. Written out explicitly for EVERY beat - never "same as above" or an empty cell. Looks are the character's WARDROBE TRACKER slugs, `nude` or `none`. **A look change mid-scene is a change in the `Outfits` of the beat where it happens and of every later beat** - a character who undresses gets `<character_slug>:nude` from that beat on, but only when nudity is allowed (`{workspace.contentPolicy.nudity}` is `allowed`) and the character is an adult; otherwise keep a tracker look. The beat that shows the change itself carries the look the character has AFTER it) | `Framing`
(shot size and angle of the beat) | `Camera move` (how the camera moves during the beat of the
video clip: push-in, pull-out, pan left/right, tilt up/down, track, crane, handheld drift,
orbit, or `hold` ONLY when the beat asks for stillness) | `Continuity` (how the beat relates to
the PREVIOUS beat: `continuous` = the action carries straight on - same place, same moment,
same people, even when the framing changes; `parallel` = the beat happens at the SAME TIME
somewhere ELSE (a car arriving outside while the reaction inside goes on) and MUST give its place in the
`Location` column as a `location_slug` (reuse a slug of the table or define a new stable one,
e.g. `driveway`; any slug of lowercase a-z0-9 words joined by `_` is accepted for a `parallel` beat -
places are not characters, so inventing a place slug is allowed); `new moment` = a jump in time, place or subject, or an
insert; the first beat of a scene is `new moment`).
Beyond those columns every Beats table also has these columns (all REQUIRED, filled in EVERY beat; an empty cell fails the `scenes-complete` check):
- `Blocking`: who is where, facing which way.
- `Contact`: who touches whom or what, and where on the body or object; `none` when nothing does.
- `Act` - REQUIRED whenever nudity is allowed (`{workspace.contentPolicy.nudity}` is `allowed`; under `forbidden` or absent leave the column out): plain, explicit words for who does what to whom, with the positions and contact points, no euphemisms (e.g. `Lena kneels on the bed, Jonas enters her from behind, both facing the window`); `none` for a beat without an act. Never an act for a depicted minor. `Contact` and `Act` are separate: `Contact` is the touch, `Act` is what the characters are doing.
Undressing: when a character undresses in a beat (nudity allowed, adult only), that beat's `Outfits` already carries `<character_slug>:nude` and so does EVERY later beat of the character; the scene row's `Outfits` lists the `nude` pair as well.
**One beat per distinct happening**: each entrance, each exit and
each dialogue line that changes the picture is its own beat (a character leaving gets an exit
beat, not a clause of the previous one). **POV scenes**: say which character is the POV; that
character is the camera - their beats show their hands or forearms only, never a full-body
figure, and the character is not listed as visible in `Blocking`.
One beat = one place (its `Location`) and one opening framing: split a beat that packs two places or two framings. Every scene has at least one beat
(typically 2-6, one per distinct action or change of framing) and EVERY beat names a camera
move, a continuity and its `Outfits`. Downstream, the storyboard's `Movement:`, `Transition:` and `Outfits:` lines and the
shoot skills' video prompts are taken from these beats (`continuous` becomes a `continue`
transition: the clip carries on from the previous one; a `parallel` beat becomes a cutaway shot at
its named place, and the storyboard links that place's location design; the extra location designs are planned from the beat `Location` slugs, the outfit designs from the scene rows' `Outfits` = the union of the beat looks); a scene list without them yields clips
that barely move and cut where they should flow.



## Pre-completion audit

Before `task_complete`, re-open `scene_list.md` and confirm: every Beats table has `Outfits`, `Camera move`, `Continuity`, `Blocking`, `Contact` columns, plus `Act` when nudity is allowed, with no empty cell; every row's `Outfits` equals the union of its beats' looks; after any undressing beat the character stays `nude` until a later beat dresses them.
