# Job alias_filter: keep the precise aliases of each concept

A recommender maps free text (scene pitches, clip titles and descriptions) to concepts by matching
aliases - short phrases - in the text. For each concept you get statistically mined candidate
phrases from adult clip titles and descriptions (with how often they occur in the concept's clips vs
others, and a z-score). Keep the ones that, when they appear in a text, reliably signal THIS
concept. Write **English only**.

## Input
Your batch file has `items[]`, one per concept: `id` (= concept name) and `inputs`: `concept`,
`type`, `description`, `categories` (member store categories) and `candidates`
(`alias, concept_docs, other_docs, z`).

## Task, per concept
- Keep 5-30 aliases. Weight each 0.5-1.0: 1.0 = unambiguous ("soles", "foot worship"),
  0.7 = strong but sometimes used otherwise ("toes", "nylons"), 0.5 = weak but useful.
- Drop: generic words of the genre ("worship", "goddess", "stroke", "cum", "slave", "custom",
  "roleplay"), names, numbers, store jargon, phrases meaning another concept, and anything
  age-coded (teen, barely legal, a number below 18) - never keep those.
- You MAY add up to 10 obvious aliases not in the candidates (synonyms, singular/plural, common
  spellings: "school girl", "schoolgirl", "college girl"), lower-case, at most 4 words.

## Output
Write ONE JSON array to the batch's `output` path, one object per item:
`{"id": "<concept>", "sha256": "<copied>", "aliases": {"soles": 1.0, "toes": 0.7}}`.
Validate it parses, then reply with one line: `<batch>: <n> concepts`.
