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
| `upload-assets [--dry-run]` | Publishes library files to `s3://<bucket>/public/library/<catalog>/assets/<library path>`; skips unchanged files via the sha256 manifest |
| `export-lake` | Read-only snapshot of iWantClips clips and categories from the content lake into `data/lake/` |
| `jobs make <job>` / `jobs collect <job>` | Agent jobs (labelling): write batch files, validate and merge outputs; see [`LABELING.md`](LABELING.md) |
| `lexicon concepts` / `aliases [--round N] [--only C]` / `build` | Mine the concept lexicon from the lake snapshot: batches for the concept grouping and the alias filter, then assemble `vocab.yaml`, `lexicon.json` and `lexicon_report.md` (validated on held-out clips) |
| `index build <version> [--vector-set S]` | Builds `data/index/<version>`: `index.json` (with the `catalog` descriptor), vector sets, models, `golden.json` and the bundled `recommend.py` |
| `index golden <version>` | (Re)writes the TypeScript parity fixtures `golden.json` (stage 1) and `selection-golden.json` (whole results: filter cases of every op, an `image` and a `views` kind, a single-kind request, decider cases, and the `invalid` requests a reader must reject) |
| `index publish <version> [--no-latest]` | Uploads the version to `library/<catalog>/rag/<version>/` (index.json last), points `rag/latest.s<schema>.json` (with the sha256 of `index.json`) at it and, unless `--no-latest`, `rag/latest.json` too |
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
- item: `{id, kind, title, doc, concepts, attrs: {field: value}, media}`; `media` is `{image: ref key}` for
  an `image` kind and `{views: [{angle, image, depth?, focus, view?}]}` for a `views` kind.
- filters: a filter applies to items of its `kind` only and compares `attrs[field]` (`in`: the value is a
  non-empty list; `min`/`max` bound the value of a numeric filter); an item without the field fails it.
  An unknown filter or kind, or a value of the wrong type or range, is an error naming what is allowed.
- best view: for a `views` item, the view whose `focus` best matches the query concepts' `focus`
  weights (first view on ties).
- result: `{catalog, index_version, context, concepts, dense, decider?, picks: {kind: [pick]}}` with one
  `picks` entry per requested kind; pick = `{id, kind, title, score, why, image, depth?, best_angle?,
  views?: [{angle, image, depth?}], attrs}` where `attrs` holds the kind's `result_fields` only. Unset
  optional fields are omitted, never null. `decider` is the decision model that reranked, or
  `unavailable: <reason>`; absent when the decider is off.

**Pointers.** `rag/latest.json` is what the deployed (schema 1) TypeScript reader follows; a schema-2 publish
leaves it alone with `--no-latest`. Every publish writes `rag/latest.s<schema>.json`, so the TypeScript port
of schema 2 reads **`library/refs/rag/latest.s2.json`**. Once every reader speaks schema 2, publishing
without `--no-latest` flips `latest.json` as well. A recommend.py refuses an index of another schema.

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

Options: `-k` (1..`max_k`), `--kind <kind>` (repeatable), `--filter name=value` (repeatable; `in`
filters take comma-separated values, e.g. `--filter outfit_category=lingerie,sexy`), `--describe`,
`--base-url`, `--no-decider`. The index (`index.json`, vectors, models) is downloaded once into
`~/.cache/refs-recommender/<version>` (or `REFS_CACHE_DIR` / `--cache-dir`): the download is verified
against the `sha256` in the pointer and installed atomically, so concurrent runs
are safe. Needs numpy; onnxruntime + tokenizers enable local dense retrieval and reranking, and
`FEATHERLESS_API_KEY` enables Featherless embeddings and the decider rerank (optional). From the package:
`Recommender.load(url_or_dir).recommend(context, filters={"max_exposure": 1})`.
