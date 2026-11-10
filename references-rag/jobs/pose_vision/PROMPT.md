# Job pose_vision: label pose reference images

You label a reference library for an adult-content production tool. Each pose is a faceless
mannequin line drawing of adults - a solo female figure, or a duo (female + male figure) - drawn
from up to 6 camera placements named front, high, low, side, diag, back. Your labels drive a
recommender that picks poses for scenes, kinks and sex acts. Write **English only**.

## Input
The batch file you were given (JSON) has `items[]`, each with `id`, `sha256` and `inputs`:
`series` (full_body_standard, full_body_sexy, upper_body, duo), `category` (an English folder
name such as lying, kneeling_all_fours, missionary - a hint only) , `solo` and `views`
(angle -> absolute PNG path). Open EVERY view with the Read tool and look carefully.

**The angle names are camera placements, not the body's orientation**, and some are mislabelled
(a "front" file may show the figure from behind; a "low" may not be low). Describe what each image
actually shows.

## Output
Write ONE JSON array to the batch's `output` path: one object per item, every item exactly once,
`id` and `sha256` copied verbatim. Use only the listed terms; weights are 0..1; omit a term below 0.2.

```json
{"id": "full_body_sexy/P063", "sha256": "<copied>",
 "name_en": "Prone on forearms, chin on hand, one leg raised",
 "description_en": "2 sentences: body support, limbs, torso, head, and what the pose shows off; for a duo, who is where and how the bodies connect",
 "support": "lying_front",
 "mood": {"playful": 0.6, "seductive": 0.5},
 "views": {
   "front": {"focus": {"feet_soles": 0.7, "butt": 0.6, "chest": 0.6}, "view": "front of the figure; raised sole faces the camera above the buttocks"},
   "high": {"focus": {...}, "view": "..."}, "low": {...}, "side": {...}, "diag": {...}},
 "sex_positions": [], "typical_acts": [], "confidence": 0.85, "notes": ""}
```

- `views`: one entry per given view (same angle keys). `focus` = how prominently each body part
  OF THE FEMALE FIGURE is presented to THIS camera: feet_soles, feet, legs, thighs, butt, crotch,
  chest, back, armpits, face, hands, belly. A part hidden by the partner or turned away scores low.
- `support` (the female figure's): standing, sitting, kneeling, all_fours, lying_back, lying_front,
  lying_side, squatting, bridge, bent_over.
- `mood`: cute, playful, seductive, submissive, dominant, explicit, relaxed.
- `sex_positions` (duo; solo only if it clearly mimics one) - exact names, choose by how the
  bodies are held (who carries the weight, what touches the floor, which way each faces):
  missionary, legs on shoulders, prone bone, spooning, lying on back, lying on side, 69,
  doggy style, kneeling upright from behind, kneeling, kneeling between legs, cowgirl,
  reverse cowgirl, squatting, face sitting, lotus, lap sitting, chair facing, reverse chair,
  scissoring, standing face to face, standing carry, against the wall, standing one leg raised,
  edge of surface, bent over surface, standing from behind, against the wall from behind
  (she faces a wall, chest pressed to it, palms flat on it above her head, he stands behind her).
- `typical_acts` - exact names: vaginal penetration, anal penetration, double penetration,
  blowjob, deepthroat, cunnilingus, 69, rimming, handjob, fingering, titjob, footjob, masturbation.
- `notes`: mislabelled angles, occlusion, anything uncertain.

Finish by validating your file is a parseable JSON array, then reply with one line:
`<batch>: <n> items written` plus any image you could not read.
