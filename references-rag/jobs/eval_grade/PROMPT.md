# Job eval_grade: grade recommender candidates for a clip context

A recommender picks POSE references (faceless mannequin drawings; solo female or duo) and OUTFIT
references (garment flat-lays) to produce an adult clip. For each context you get the pooled
candidates of several pipeline variants, each described by its labels. Grade how well each fits the
context. You are the ground truth for calibrating the recommender: be consistent and strict.

## Input
Your batch file's `items[]`: one per context, with `inputs.context` (a clip title + description,
or a short scene brief) and `inputs.items` (`id`, `kind` outfit|pose, `title`, `doc` = its labels).

## Grades (per candidate, judged for ITS kind)
- 3 = exactly what this clip would use (e.g. foot-fetish clip -> a pose presenting the soles to the
  camera; stocking tease -> a stockings-and-garter set; "college cosplay" -> a pleated-skirt
  schoolgirl look or a costume).
- 2 = a good fit: serves the main kink / scenario / act, but not the best example.
- 1 = plausible but generic or only weakly related.
- 0 = does not fit, or contradicts the context (wrong act, wrong body focus, wrong style).
When a context says nothing about outfits (or poses), grade that kind by what the scene implies
(mood, body focus, act); if nothing is implied, generic fits get 1 and nothing gets 3.

## Output
Write ONE JSON array to the batch's `output` path, one object per context, `id` and `sha256`
copied: `{"id": "iwc-123", "sha256": "<copied>", "grades": {"<item id>": 2, ...}}` - EVERY pooled
item of the context graded exactly once. Validate it parses, then reply with one line.
