# Job outfit_vision: label outfit reference images

You label a reference library for an adult-content production tool. Each image is a garment
flat-lay ("ghost mannequin" photo of one complete outfit, no person). Your labels drive a
recommender that picks outfits for scenes and kink/roleplay contexts. Write **English only**.

## Input
The batch file you were given (JSON) has `items[]`, each with `id`, `sha256` and `inputs`:
`image` (absolute path of a PNG: open it with the Read tool and look carefully), `category`
(the library's season/style folder) and `tags_hint` (the library's own tags: often incomplete or
wrong - **the image wins**; never copy a tag you cannot see).

## Output
Write ONE JSON array to the batch's `output` path: one object per item, in any order, every item
exactly once, `id` and `sha256` copied verbatim from the batch. Use only the listed terms; weights
are 0..1; omit a term below 0.2.

```json
{"id": "SXY-0127", "sha256": "<copied>",
 "description_en": "1-2 sentences: exactly what is visible - garments, cut, colours, notable details",
 "garments": ["cropped kimono top", "pleated mini skirt", "thigh-high stockings", "geta sandals"],
 "colors": ["white", "red"], "materials": ["cotton", "satin"],
 "archetypes": {"cosplay_like": 0.95, "schoolgirl_adjacent": 0.2},
 "exposure": 2,
 "accentuated": {"legs": 0.8, "thighs": 0.6},
 "footwear": "sandals", "season": "any", "confidence": 0.9, "notes": ""}
```

- `archetypes`: schoolgirl_adjacent (pleated skirt + blouse/ribbon/knee socks looks; an ADULT
  roleplay look), office_secretary, nurse_like, maid_like, cosplay_like (costumes: witch, ninja,
  angel, shrine maiden, qipao, bunny...), girl_next_door, date_night, boudoir, bridal, fetishwear,
  dominatrix, athleisure, beach, party_club, cozy_home, casual_street, elegant_evening.
- `exposure`: 0 covered street wear, 1 some skin / sheer, 2 revealing (mini, cutouts, plunge),
  3 lingerie or swimwear.
- `accentuated`: legs, feet, chest, butt, waist, back, thighs, arms - what the outfit shows off.
- `footwear` (the dominant one): heels, stockings, pantyhose, socks, sandals, sneakers, boots,
  flats, none. Stockings worn with heels: pick the one that defines the look and mention the
  other in `garments`.
- `season`: spring, summer, autumn, winter, any.
- `notes`: anything ambiguous, or where `tags_hint` disagrees with the image.

Finish by validating your file is a parseable JSON array (e.g. `python3 -m json.tool <output>`),
then reply with one line: `<batch>: <n> items written` plus any image you could not read.
