---
name: iwc-loop-cast
description: >
  Use when the task prompt says "Load and use skill: iwc-loop-cast", or asks for the character
  table of an iWantClips loop episode: ONE character file (character_<slug>.md) in the platform's
  character-table format (NAME, ROLE, PERSONALITY, VISUAL PROFILE, WARDROBE TRACKER), built from
  the play (screenplay.md = play.md verbatim) and the visual plan's outfits, with the brand marks
  written so plan-designs makes them the design's `marks`. Do NOT invoke for the visual plan
  (iwc-play-preproduction), the scene list (iwc-loop-scenes), designs (plan-designs) or a film
  cast of several characters (run-preproduction).
agentType: worker
---

# Loop cast: the character table of one performer

**Catalog tools:** none in this task (no `search_catalog` / `use_reference`, no catalog outfit or
`garment_reference`).

The episode has ONE cast role: the play's character (play.md section 3). The listener ("you",
"him") is the camera and the audio's addressee, never on screen: NOT a cast role. The file you
write is read by the server's scene-list check (looks and the `character type:` / `age:` lines),
by `iwc-loop-scenes` (the look slugs) and by the library skill `plan-designs` (the character and
outfit designs: `hair`, `build`, `features`, `marks`, `voice` and one outfit per wardrobe row).

## 1. Preflight

Fields: `screenplay` (default `screenplay`: `screenplay.md` = play.md verbatim), `plan` (default
`visual_plan`: `visual_plan.json`). `read_artifact` both; `task_failed(reason)` naming a missing
file. play.md section 3 (Character: Identity, Look, Body, Persona, Voice) and sections 1-2 (kink,
goal) are the sources; the visual plan's `outfits[]` are the looks. Also look at the nude base
reference ONCE: `describe_image` of `artifact://episode_inputs/character.png` (the character
design's primary take - every view and shot is drawn from it), asking for the breasts, the pubic
area (hair or shaved) and the genitals at rest in plain anatomical words.

Slug: the character's short stage name, lowercase snake_case - `vesper` for "Goonette Vesper
Vex" (the file `character_vesper.md`, design key `character_vesper`). Every later step uses it.

## 2. The file `character_<slug>.md`

Write it with ONE `sandbox_write_file` into your output artifact folder (`/workspace/<artifact
id>/character_<slug>.md`; keep the call under ~6000 characters). Plain Markdown, exactly these
five `##` headings in this order:

```
## NAME
Vesper (Goonette Vesper Vex)

## ROLE
Lead and only performer: on camera alone in every loop clip; her voice carries the episode audio.

## PERSONALITY
<3-5 short lines from play.md section 3 Persona / Narration style, in visible terms where possible>
Want: <what she pursues in this episode, from sections 1-2>
Obstacle: <what stands in the way / her flaw, from the play>

## VISUAL PROFILE
character type: woman
age: adult, early thirties
ethnicity: <play.md>
height: <relative: tall / average, long-limbed ...; never feet / inches>
face: <shape, notable features>
hair: <colour, length, style>
skin tone: <...>
eyes: <colour, makeup>
build: <...>
build detail: <...>
proportions: <...>
posture: <...>
breasts: <plain anatomical words>
pubic hair: <...>
genitals: <plain anatomical words, at rest>
distinguishing features: wide black velvet choker; small silver key pendant on a thin silver chain; violet nail polish
marks: jewellery | neck | | wide black velvet choker; jewellery | neck | | small silver key pendant on a thin silver chain; other | fingers | both | violet nail polish
voice: <pitch, timbre, apparent age, accent, pace, one signature quality - from play.md Voice description>

## WARDROBE TRACKER
| look slug | description | garments, colors, material, fit, accessories | scenes where worn |
|---|---|---|---|
| black_silk_slip | ... | ... | 1, 3 |
```

Rules:
- VISUAL PROFILE: one `key: value` line each, no `[...]` placeholders or blanks (`n/a` only when a
  field does not apply). `character type: woman` and `age: adult, early thirties` exactly (the
  server reads them to allow the `nude` look; a missing or vague age refuses `nude`). The values
  come from play.md section 3 "Look"; invent a fitting value only where the play is silent -
  EXCEPT the body lines below.
- **Body lines** (`breasts`, `pubic hair`, `genitals`): NEVER invented. They come from play.md's
  `Body` row and must agree with the nude base reference (`describe_image` above): the views and
  shots repeat these words, and words that contradict the picture win over it (an invented "neat
  dark strip" put pubic hair on every view of a shaved reference). No `Body` row: write what the
  picture shows. The row and the picture disagree: the picture wins; name the conflict in the
  reply. Concrete, non-euphemistic, adult, at rest (`vulva with full outer lips closed at rest`;
  never words for a penis or arousal on a woman, such as "flaccid" or "erect").
- **Brand marks** (wide black velvet choker; small silver key pendant on a thin silver chain;
  violet nail polish): they are the character's MARKS, never garments. Write them in
  `distinguishing features:` AND on the `marks:` line exactly in the platform's mark format
  `kind | part | side | description`, entries separated by `; ` (kind: jewellery / other; part:
  neck / fingers; side empty = centred, `both` for both hands) - `plan-designs` copies that line
  into the character design's `marks` attribute, which every outfit and shot then keeps and which
  wins over any outfit accessory of the same kind on the same body part. Never put them into a
  wardrobe row.
- WARDROBE TRACKER: a Markdown table with the header row and the separator row shown above, then
  ONE row per outfit in the visual plan's `outfits[]`, in plan order:
  - look slug = the outfit's `id` EXACTLY (`[a-z0-9]+(_[a-z0-9]+)*`);
  - description = the outfit's name and what it is for (the kink it signals);
  - garments = every garment the plan's description names, with colours, material and fit, and
    worn accessories (heels, stockings, gloves) - never a brand mark, never a handheld item, and
    never a body part or exposure (nipples, areolae, bare breasts, genitals, cupless / open-cup /
    crotchless wording): the outfit is drawn fully worn, and bared skin is a still's garment state
    in the scene list, never the outfit. A plan outfit whose description names one:
    `task_failed("visual_plan outfit <id> names a body part / exposure - an outfit is the garments as worn")`;
  - scenes where worn = the scene numbers that wear it (scene n = look n of the visual plan; never
    clip ids).
  - NO row for nudity: `nude` is the scene list's base look (the character design's own picture is
    the nude base reference), never a tracker row (`nude`, `naked`, `topless`, "no garments" rows
    are refused by the check). Clips with `outfit_id: nude` are covered by it.
  - One row per OUTFIT, never per garment state (a strap down or panties aside is a state the
    scene list names, not a row).

## 3. Pre-completion audit and checks

Re-open the file (`sandbox_read_file`): five headings in order; `PERSONALITY` ends with `Want:`
and `Obstacle:`; VISUAL PROFILE has `character type: woman`, `age: adult, early thirties`, the
`marks:` line in the exact format (three entries, `; ` between them) and no blank field; one
tracker row per plan outfit with the plan's id as look slug and no nude row; no brand mark in a
garments cell; `breasts`, `pubic hair` and `genitals` match the play's `Body` row and the
reference picture (none invented). Then `run_checks` (policy `cast-from-play` judges the file against the play and
the plan); fix exactly what a finding names. Then `task_complete`.
