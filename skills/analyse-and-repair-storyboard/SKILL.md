---
name: analyse-and-repair-storyboard
description: >
  Use when the person asks to review, audit, assess or "check the takes" of one or more drafted
  storyboards - "inspect the shot takes of scene 7", "which keyframes are wrong", "are the picks any
  good", "fix the storyboards" - and wants a verdict per shot and a repair plan. Produces a per-shot
  verdict (good / minor / wrong) with concrete defects and a ready-to-apply studio repair plan. Do NOT
  invoke for a single named defect or a cause hunt across layers (troubleshoot-production), writing a
  shot list from scratch (storyboard-scene), clips, or designs. This skill reports and plans; it never
  picks, discards or renders takes.
agentType: worker
---

# Analyse and repair a storyboard's takes

You are a worker. You read artifacts, look at pictures (sandbox + `describe_image`) and may change
shot lines ONLY of the storyboard you own: you own it only when this task's key is that
`storyboard_scene_<n>`. Picking, discarding and rendering takes are STUDIO actions of the person -
you hand them a plan. Never call a pick, discard, render or `wf_*` tool for a shot take, and never
claim a fix you did not see in a picture.

## 0. Preflight

The task names the storyboard(s) or scene(s). If it names none, a storyboard's `shotlist.md` /
`design.json` cannot be read, or a storyboard has no takes yet (its draft is still running), call
`task_failed(reason)` naming the gap and stop. Never guess a scene.

## 1. Inventory (per storyboard)

- `read_artifact` the storyboard: `shotlist.md` (the shot lines) and `design.json`: `takes[]` (each
  take's main file is the first of `takes[].files`; `checkOutcome {passed, hardFail, decisive[]}`,
  `suggestedEdit`, `repair`) and `shotPicks[]` (the picked take per shot). Read the scene's row and
  Beats table in `scene_list.md`.
- **Continuous coverage (a number, per scene)**: from the shotlist's `Beat:` + `Transition:` lines and the scene list's `Continuity` column, count the shots whose beat is `continuous` and how many of them are `Transition: continue`: `continue share = continue / continuous-beat shots`. A shot of a `new moment` / `parallel` beat is never counted. A low share (about under half, when the scene list is mostly `continuous`) means the scene is cut shot by shot: the clips start on new keyframes, the people and set drift between them, and the scene loses its flow. Fix in this order: (1) the SCENE LIST first - the `Framing` of consecutive `continuous` beats differs (a first-person scene must keep the size within a continuous run; a third-person one needs a `Camera move` that performs each step); a storyboard can only open each beat's shot with the beat's size (R36), so rewrite those beats with `write_beats` (a task that owns the scene list) or hand the exact beat edits to the person; (2) only then the storyboard: a third-person `continuous` beat written as a `cut` whose change a reliable move performs becomes a `continue` with that move (same angle words in both `Camera:` lines); a first-person one becomes a held `continue` (same framing, the people move). Report the share per scene in the final table.
- Look once at the pictures of every design the shots name (character / outfit / location main
  picture or the `view_*` the line chooses): identity, garments and set are judged against them.

## 2. Look at every shot (mandatory)

Text says what was ASKED; only pictures say what HAPPENED. Use the look-before-you-judge recipe of
troubleshoot-production step 2: per shot `sandbox_fetch` the previous shot's pick, the picked take and
the other takes (`artifact://<storyboard artifactId>/<main file>`), `hstack` them in that order into
`/workspace/<your artifactId>/inspect_<shot>.png`, and ask `describe_image` yes/no questions + why,
naming the panels. Per shot ask:

- **Framing**: the size and what fills the frame ("Is this an extreme close-up of only <the named detail>?"),
  camera height, from behind / front / side.
- **Extent and POV**: "Is any part of <the viewer> visible beyond what the shot line allows (for example only
  forearms and hands; not legs, torso, a face or forehead)? Is a second face or an extra torso in frame?"
- **Wardrobe as the shot's `Wardrobe:` line says**, not as the outfit design shows: every `removed:`
  garment absent (straps too)? every `partly:` garment where the line puts it?
- **Pose, position, contact**: standing / seated / kneeling / lying as stated? what exactly each hand
  touches? which hand (<A>'s left or right)?
- **The act** (`Sex act:` / `Sex position:`): shown, in that position - including every modifier in parentheses (a leg, hold or fixture it states) - with the stated detail?
- **Place**: the set the `Location:` line names, not another surface or a place the `Out of frame:` line excludes?
- **Identity, anatomy, artefacts**: same person as the reference? extra or merged fingers, hands,
  limbs? text or watermark?
- **Continuity** with the previous shot: hair, wardrobe state, set, light.
- **Pose reference** (a shot with a `Pose reference:` line): read the route the take job / `plan_shot`
  reported (pose transfer, depth-pose keyframe, or the skip reason) and look at whether the take
  shows the imported pose. Common causes of a skip or a wrong pose: the imported view does not match the
  `Camera:` angle (incl. a `from behind` camera with no `back` view), the person touches someone (the
  viewer included), a duo shot framed closer than `medium full`, the `Sex position:` differs from the
  pick's, or the import's picture does not match its label. Never call it good because a line exists.

Note per shot: verdict `good` (usable as is) / `minor` (usable after a small fix) / `wrong` (does not
show the shot); each defect as one concrete sentence ("shows <A> from the front, the shot asks from
behind"); the better unpicked take, if any.

**The check results are evidence, not the verdict.** Dated platform limits (re-measure; the list
is a table, not a rule):

| Limit seen (2026-11) | Status |
|---|---|
| The outfit check demanded outfit-design garments the shot removed, and its suggested fix said "add <garment>" | believed addressed in a later release (re-measure) (one wardrobe rule + look plates); if still seen, report it - until then ignore such fixes |
| A framing miss counted less than any outfit finding, so a too-wide take won the auto-pick | believed addressed in a later release (re-measure) (measured ranking); if still seen, report |
| A take was picked even when every take failed | believed addressed in a later release (re-measure) (all-failed flag); if still seen, report |
| A second face in a POV close-up was not checked | believed addressed in a later release (re-measure) (absent-viewer check); if still seen, report |

## 3. Choose the fix per defect

If the shot LINES cause the defect (they contradict each other, a close-up's `Pose:` describes a whole
seated body, the chosen location picture shows what `Out of frame:` excludes), the fix is in the lines
(step 4) - a new take cannot fix them. Otherwise pick from the table. "Describe" = the studio's
"Describe what's wrong" on the picked take; the server re-renders the shot with the note. Outcome
rates were measured on 32 repairs of one production (2026-11); re-measure them when the take
renderer changes.

| Defect | Studio fix | Outcome |
|---|---|---|
| An unpicked take shows the shot better | switch the pick | always check this first |
| Extreme close-up / close-up of a small detail (a face, an eye, an object) comes out medium or wider | Describe: "Framed far too wide: this must be <the stated size> of <what> filling the frame." | works |
| Close-up of one detail (a hand, a prop, a label) comes out wide | Describe naming the detail that fills the frame | works |
| Wrong background (another surface or place instead of the stated set) | Describe: "<Subject> is at <the set surface>, which fills the background; no <excluded thing>." | works |
| POV shot shows a second face / the viewer's face | Describe: "This is <the viewer>'s point of view: <the viewer>'s face must never show." | works |
| A detail the shot line requires is missing (a prop, an action, a contact) | Describe naming exactly what must be visible | works |
| Wrong body posture or support (observed posture/support differs from the stated one) | Describe: "<Subject> must be <stated posture> on/at <stated support>, not <observed posture/support>." | mostly |
| Overlapping hands malformed | Describe: "Each hand needs five fingers and a clear owner." | partly |
| Gaze into the lens missing | Describe | partly |
| Medium close-up / close-up of a BODY region (back, shoulders, hips) comes out wide | - | rarely as of 2026-11; close-up crop + reframe in a later release (re-measure) - if still seen, report, keep the best take |
| A garment the shot removed is still worn | - | rarely as of 2026-11; wardrobe rule + look plates in a later release (re-measure) - if still seen, report |
| A `partly:` garment in the wrong place | - | does not work: report |
| Which hand / where a hand rests / what it holds | - | does not work: report, or simplify the shot line |
| Pose reference skipped or the pose is wrong (reason from the take job) | lines: re-import the view for the CURRENT `Camera:` (`use_reference`), or drop the `Pose reference:` line when the shot has contact, a close duo framing or a position the pick does not show; then `plan_shot` | a new take cannot fix it |
| A `wrong` shot with no usable take | regenerate x2 (after fixing the lines if they caused it) | - |

A Describe note names what is wrong AND what the frame must show instead, in the shot's own words;
one note per shot, at most three defects, most important first; never ask for another shot than the
lines describe - fix the lines instead. Only plan Describe notes for rows that work / mostly / partly.

## 4. Fix what you own, hand over the rest

- **Lines of the storyboard you own**: change only the faulty lines with `write_shot`, then
  `plan_shot` for that shot, then `draft_storyboard` (no arguments); quote each result. When the
  frames are right and only the text was wrong (the take already shows what the corrected line asks),
  call `keep_takes` for that shot instead of planning a regenerate.
- **Lines of a storyboard you do not own**: put the exact line change in the plan for the person.
- **The repair plan** for the person, grouped by storyboard:
  1. Pick switches: `<shot>: take <id> instead of <id> - <why>`.
  2. Describe notes: `<shot>, take <id>: "<note>"`.
  3. Regenerates: `<shot> x2`.
  4. Platform limits (not fixable by a new take): `<shot>: <defect>` - the person keeps the take or
     changes the shot.
- Only when re-invoked after the person applied the plan: look again (step 2) at the new takes beside
  the old pick and recommend a switch only where the new take is better on the shot lines AND adds no
  worse defect (a fix often repairs the named defect and breaks another - name it). Otherwise end
  after the report.

## 5. Audit, then report

Before `task_complete`: every shot of every named storyboard has a verdict from a picture you looked
at; every take id in the plan exists in `design.json`; every tool result you rely on is quoted; the
plan claims nothing you did not do. Then reply with, per storyboard: a line `Storyboard <key>: <n>
shots - <good> good, <minor> minor, <wrong> wrong`, the 2-3 recurring patterns, the continue share per scene (step 1), a table
`Shot | Verdict | Defects | Better take | Fix`, then the repair plan, what you changed yourself, and
what only the person can do.
