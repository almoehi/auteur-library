# Job concept_affinity: weight library items against the mined concepts

A recommender picks POSE and OUTFIT reference images for adult clips. Each concept below was mined
from a clip store's categories. For every item you get its vision labels; say how typically the
item would be CHOSEN for a clip of each concept. Write **English only**.

## Input
- The concept list: `concepts.md` in the same folder as this prompt (read it first).
- Your batch file's `items[]`: `id` (`outfit:<id>` or `pose:<id>`), `inputs.kind` and
  `inputs.label` (outfits: description, garments, archetypes, exposure, accentuated, footwear;
  poses: name, description, support, mood, sex_positions, typical_acts, max_focus = the strongest
  presentation of each body part over its camera views).

## Task
For each item, weight 0..1 every concept the item clearly serves; omit the rest (most items serve
3-10). 1.0 = a textbook pick (a prone pose with soles to camera for foot_fetish; a garter-and-
stockings set for pantyhose_stockings), 0.5 = fits, 0.2 = possible. Judge from what the item SHOWS
and is typically used for:
- An OUTFIT serves garment and body-focus concepts through what it is and accentuates, AND the
  kink, roleplay and act concepts it would typically be WORN for in such a clip: lingerie, boudoir
  and revealing sets for sex acts and strip tease; latex / leather / boots for femdom; a pleated
  mini skirt + blouse look for schoolgirl roleplay; a costume for cosplay. Covered street wear
  serves acts weakly (0.2) at most.
- A POSE serves acts through its sex positions, body-focus concepts through what it presents, and
  garment concepts only when it shows that garment's area (legs for stockings, feet for socks/heels).
Use concept names exactly as listed.

## Output
Write ONE JSON array to the batch's `output` path, one object per item, `id` and `sha256` copied:
`{"id": "pose:full_body_sexy/P063", "sha256": "<copied>", "concepts": {"foot_fetish": 0.9, ...}}`.
Validate it parses, then reply with one line: `<batch>: <n> items`.
