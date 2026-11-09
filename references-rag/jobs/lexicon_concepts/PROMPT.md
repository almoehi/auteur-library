# Job lexicon_concepts: group clip categories into visual concepts

You build the concept vocabulary of a recommender that picks POSE and OUTFIT reference images
(mannequin pose drawings, garment flat-lays) for adult clips. Input: the ~300 most used categories
of an adult clip store (iWantClips), each with its video count, store description and sample titles.
Write **English only**.

## Input
Your batch file has one item (`id` = "concepts") whose `inputs.categories` lists
`{name, video_count, description, sample_titles}`.

## Task
Group the categories into **40-70 concepts** that a pose or an outfit can visibly serve, e.g.
`foot_fetish` (Foot Fetish, Foot Worship, Barefoot-Soles Fetish, Wrinkled Soles, Foot Domination...),
`ass_worship`, `pantyhose_stockings`, `latex_leather`, `schoolgirl_roleplay`, `cosplay`, `femdom`,
`joi_tease`, `strip_tease`, `doggy_style`, `cowgirl_riding`, `blowjob`...

- `name`: snake_case, 3-40 chars, specific. `type`: kink | roleplay | act | garment | body_focus.
- `description`: one sentence: what it means visually for a pose or an outfit.
- `categories`: member category names copied VERBATIM. A category may belong to 2 concepts at most
  (e.g. "Foot Domination" -> foot_fetish and femdom). Keep concepts distinct; merge near-duplicates.
- `dropped`: every category that nothing visual can serve (audio only, languages, ethnicities,
  body types the library cannot vary, money/findom, cuckold, chastity, humiliation-only, religion,
  "18-19 Years Old" or anything age-coded) - copied verbatim.
- Every input category is either in at least one concept or in `dropped`.
- Adults only: "schoolgirl" / "college" concepts are adult roleplay looks; never make an age concept.

## Output
Write a JSON array with ONE object to the batch's `output` path:
`{"id": "concepts", "sha256": "<copied from the item>", "concepts": [{"name", "type", "description",
"categories": [...]}], "dropped": [...]}`. Validate it parses (`python3 -m json.tool <output>`),
then reply with one line: number of concepts and dropped categories.
