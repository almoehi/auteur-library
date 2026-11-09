# references-rag

Pose and outfit reference recommender for `nsfw-poses-references/`: given a text context it
returns the top poses and outfits with public URLs of their files. The index and the query code are
catalog-generic (index schema 2): a catalog's kinds, filters, media and result fields come from the
`catalog` descriptor inside its index, so another catalog (faces, locations, props…) needs a new index
only, not new query code. Design and phases:
[`../PLAN_REFERENCE_RECOMMENDER.md`](../PLAN_REFERENCE_RECOMMENDER.md); P0 spike results:
[`spike/FINDINGS.md`](spike/FINDINGS.md).

Everything is **English only**: the library catalog's Japanese columns are dropped on load, and
label records with non-English text are rejected.

## Setup

```sh
cp .env.example .env   # REFS_LIBRARY_ROOT, REFS_CONTENT_LAKE_DIR, AWS writer keys, FEATHERLESS_API_KEY (optional at query time)
uv sync
uv run pytest -q && uv run ruff check src tests && uv run mypy
```

The image library (about 2 GB) is not committed; `REFS_LIBRARY_ROOT` points at a checkout of it.
Non-secret defaults (bucket, prefix, public base URL) live in `config.yaml`; env `REFS_*` overrides them.
The catalog descriptor of `refs` (title, kinds, filters, result fields, decider wording, `max_k`) lives in
`catalog.yaml`, validated by pydantic (`settings.load_catalog`) against `descriptor.py`.

Environment: `REFS_LIBRARY_ROOT`, `REFS_CONTENT_LAKE_DIR`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_REGION` (writer, upload and publish only), `FEATHERLESS_API_KEY` (dense embeddings: needed to build
the index, **optional at query time**; without it queries use the local ONNX embedder if installed, else
stage 1 only), `REFS_BASE_URL` / `REFS_BUCKET` (overrides) and `REFS_INDEX` (default `--index` of
`recommend.py`).

## Commands (`uv run refs ...`)

| Command | What it does |
|---|---|
| `catalog` | Counts of the English-only catalog (1,407 outfits, 288 poses, 4,285 files) |
| `upload-assets [--dry-run] [--catalog Y] [--items J --root D]` | Publishes a catalog's files to `s3://<bucket>/public/library/<catalog>/assets/<library path>`: the files the `--items` media refer to (below `--root`), else the refs library's; skips unchanged files via the sha256 manifest |
| `export-lake` | Read-only snapshot of iWantClips clips and categories from the content lake into `data/lake/` |
| `jobs make <job>` / `jobs collect <job>` | Agent jobs (labelling): write batch files, validate and merge outputs; see [`LABELING.md`](LABELING.md) |
| `lexicon concepts` / `aliases [--round N] [--only C]` / `build` | Mine the concept lexicon from the lake snapshot: batches for the concept grouping and the alias filter, then assemble `vocab.yaml`, `lexicon.json` and `lexicon_report.md` (validated on held-out clips) |
| `index build <version> [--catalog Y] [--items J] [--lexicon L] [--vocab V] [--vector-set S \| --no-vectors] [--cases C]` | Builds `data/index/<version>` of the descriptor `--catalog` (default `catalog.yaml`): `index.json` (with the `catalog` descriptor), vector sets, models, `golden.json` and the bundled `recommend.py`. Items: `--items` (schema-2 jsonl), else the refs builder (labels, `lexicon.json`, `vocab.yaml`, affinities). `--no-vectors`: no vector set (offline, stage 1 only) |
| `index golden <version> [--cases C]` | (Re)writes the TypeScript parity fixtures `golden.json` (stage 1) and `selection-golden.json` (whole results: filter cases of every op, an `image` and a `views` kind, a single-kind request, a default-`k` request, decider cases including a failing kind, a `views` item without `depth`/`view`, and the `invalid` requests a reader must reject). `--cases`: a yaml of `queries`, `filters`, `invalid` (default: the refs cases) |
| `index publish <version>` | Uploads the version to `library/<catalog>/rag/<version>/` (index.json last) and points `rag/latest.s<schema>.json` (with the sha256 of `index.json`) at it; `rag/latest.json` only for a schema-1 index |
| `eval sample` | Writes `eval/contexts.jsonl`: held-out clips round-robin over the mined concepts (one per concept, then a second, up to 100), plus the hand cases |
| `eval pool [--extra] [--variant V]` | Pools every variant's top candidates per context into `eval_grade` batches (graders do not see the lexicon aliases); `--extra` grades only new pool members |
| `eval score [--no-search] [--variant V]` | nDCG@3 per variant and a grid search, tuned on the tune half of the contexts and reported on the test half with the share of unjudged top-3 picks; writes `eval/report.md` |

## Layout

- `src/refsrag/keys.py` is the only place that builds object keys and URLs: library path → ref key
  (`library/<catalog>/assets/...`, what the index stores) → S3 key (`public/` + ref key) and public URL
  (`base_url` + ref key); index versions live in `library/<catalog>/rag/<version>/`.
- `descriptor.py`: the catalog descriptor and the generic item contract (below).
- `catalog.py` loads typed items; `vocab.py` holds the fixed vision vocabularies as types;
  `labels.py` the record schemas agents must return; `jobs.py` the batch contract;
  `prepare.py` builds batch items (768 px thumbnails, sha256 cache keys).
- `lake.py` is the only module that touches the content lake (read-only, run inside the lake's own
  uv environment); `split_of` assigns each clip to `mine` (80%) or `heldout` (20%).
- `text.py`: the English-only and age-code filters shared by all modules.
- `stage1.py` (lexicon matching, BM25, RRF, MMR) and `query.py` (the `Recommender`: dense retrieval,
  reranking, best view of `views` items, `fetch_index`) are standard library plus numpy. With `keys.py`
  and `descriptor.py` they are bundled by `index build` into the single script `recommend.py` shipped
  inside each index version.
- `mine_lexicon.py` builds the lexicon, `affinity.py` item-to-concept weights, `index_build.py` the index
  and its publication, `eval.py` the calibration (contexts, pooling, nDCG@3, grid search); `eval/` holds
  the contexts, grades and reports, and `compare_v3_v4.py`, the proof that schema 2 changed no ranking.

## Index schema 2 (the contract the TypeScript port implements)

`index.json`: `schema_version` 2, `index_version`, `catalog`, `default_base_url`, `params` (fusion
weights etc.), `lexicon`, `concepts`, `items`, `vector_sets`, `files`.

- `catalog`: `key` (the S3 path segment, `library/<key>/`), `title`, `description`, `nudity`,
  `kinds` (`{kind: {label, description, media: "image" | "views"}}`, in result order), `filters`
  (`[{name, kind, field, type: integer|number|boolean|string, op: eq|lte|gte|in, description, min?, max?}]`),
  `result_fields` (`{kind: [attr]}`), `decider_context`, `decider_guidance` (`{kind: hint}`), `max_k`.
  Kind keys are never integer-like (all digits, e.g. `"1"`): JavaScript would reorder them.
- item: `{id, kind, title, doc, concepts, attrs: {field: value}, media}`; `media` is `{image: ref key}` for
  an `image` kind and `{views: [{angle, image, depth?, focus, view?}]}` for a `views` kind. A view's
  `depth` and `view` may be absent or null; readers treat null as absent (the build never writes null).
- filters: a filter applies to items of its `kind` only and compares `attrs[field]` (`in`: the value is a
  non-empty list; `min`/`max` bound the value of a numeric filter); an item without the field fails it.
  An unknown filter or kind, or a value of the wrong type or range, is an error naming what is allowed.
- best view: for a `views` item, the view whose `focus` best matches the query concepts' `focus`
  weights (first view on ties).
- result: `{catalog, index_version, context, concepts, dense, decider?, picks: {kind: [pick]}}` with one
  `picks` entry per requested kind; pick = `{id, kind, title, score, why, image, depth?, best_angle?,
  views?: [{angle, image, depth?}], attrs}` where `attrs` holds the kind's `result_fields` only. Unset
  optional fields are omitted, never null.
- `decider`: absent when no decider runs (none configured, or the index's `params` define none); the
  decision model's name when it reranked; `unavailable: the decision model failed (<kind>[, <kind>…])`
  naming the kinds it failed on, in catalog kind order (e.g. `(outfit, pose)`).
- `k`: picks per kind; default `min(3, max_k)`; outside 1..`max_k` it is an error with the text
  `k must be between 1 and <max_k>`.
- describe (`recommend.py --describe`, `Catalog.describe()` / `Recommender.describe()`, the TypeScript
  `search_catalog` describe mode), field for field: `{catalog, title, description, nudity, kinds: {kind:
  {label, description, media}}, filters: [{name, kind, type, op, min?, max?, description}], max_k}`
  (no attr `field`, result fields or decider wording).
- Numbers in error texts print as JavaScript does (`0..3`, not `0.0..3.0`).

**Pointers.** `rag/latest.json` is what the deployed (schema 1) TypeScript reader follows, so only a
schema-1 index is ever published to it; a schema ≥ 2 publish cannot move it. Every publish writes
`rag/latest.s<schema>.json`, so the TypeScript port of schema 2 reads **`library/refs/rag/latest.s2.json`**.
A recommend.py refuses an index of another schema.

## Adding a catalog

A new catalog (faces, locations, props…) is data only: a descriptor yaml, an items jsonl and its files.

1. `faces.yaml`: the descriptor (same keys as `catalog.yaml`; `key` is the S3 path segment).
2. `faces.jsonl`: one schema-2 item per line, `{id, kind, title, doc, concepts, attrs, media}`, with media
   ref keys `library/<key>/assets/<library path>`. The build checks every item against the descriptor
   (fields, unique ids, declared kinds, media of the kind's type below the catalog's assets, the attrs
   that filters and result fields name). `concepts` may be `{}`; then add `--lexicon` / `--vocab` for
   concept matching, or rely on BM25 and dense retrieval.
3. Build, check, upload, publish (pick a version name no other catalog uses in `data/index/`):

```sh
uv run refs index build faces-v1 --catalog faces.yaml --items faces.jsonl   # --no-vectors: offline, stage 1 only
uv run refs index golden faces-v1 --cases faces-cases.yaml                  # queries, filters, invalid
uv run refs upload-assets --catalog faces.yaml --items faces.jsonl --root /path/to/faces-files
uv run refs index publish faces-v1   # -> library/faces/rag/latest.s2.json
```

The query code (`recommend.py`, the TypeScript port) needs no change. The Featherless query instruction
of the vector sets still names poses and outfits; a catalog that needs other wording changes
`QWEN_INSTRUCTION`.

## Using the recommender

`recommend.py` is published with each index version. Fetch the schema-2 one and run it against
`latest.s2.json`, which is `base_url` from `config.yaml` plus `library/refs/rag/latest.s2.json`:

```sh
BASE=$(grep '^base_url:' config.yaml | cut -d' ' -f2)
LATEST="${BASE}library/refs/rag/latest.s2.json"
curl -fsSO "${BASE}library/refs/rag/$(curl -fsS "$LATEST" | jq -r .path | cut -d/ -f1)/recommend.py"
python recommend.py --describe --index "$LATEST"   # kinds, filters, max_k
python recommend.py "college girl cosplay, foot tease" --index "$LATEST" --filter solo=true --json
```

Options: `-k` (1..`max_k`, default `min(3, max_k)`), `--kind <kind>` (repeatable), `--filter name=value` (repeatable; `in`
filters take comma-separated values, e.g. `--filter outfit_category=lingerie,sexy`), `--describe`,
`--base-url`, `--no-decider`. The index (`index.json`, vectors, models) is downloaded once into
`~/.cache/refs-recommender/<version>` (or `REFS_CACHE_DIR` / `--cache-dir`): the download is verified
against the `sha256` in the pointer and installed atomically, so concurrent runs
are safe. Needs numpy; onnxruntime + tokenizers enable local dense retrieval and reranking, and
`FEATHERLESS_API_KEY` enables Featherless embeddings and the decider rerank (optional). From the package:
`Recommender.load(url_or_dir).recommend(context, filters={"max_exposure": 1})`.
