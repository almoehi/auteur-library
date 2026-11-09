# references-rag

Pose and outfit reference recommender for `nsfw-poses-references/`: given a text context it
returns the top poses and outfits with public URLs of their files. Design and phases:
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
Non-secret defaults (bucket, prefixes, public base URL) live in `config.yaml`; env `REFS_*` overrides them.

Environment: `REFS_LIBRARY_ROOT`, `REFS_CONTENT_LAKE_DIR`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_REGION` (writer, upload and publish only), `FEATHERLESS_API_KEY` (dense embeddings: needed to build
the index, **optional at query time**; without it queries use the local ONNX embedder if installed, else
stage 1 only), `REFS_BASE_URL` / `REFS_BUCKET` (overrides) and `REFS_INDEX` (default `--index` of
`recommend.py`).

## Commands (`uv run refs ...`)

| Command | What it does |
|---|---|
| `catalog` | Counts of the English-only catalog (1,407 outfits, 288 poses, 4,285 files) |
| `upload-assets [--dry-run]` | Publishes library files to `s3://<bucket>/public/library/refs/assets/<library path>`; skips unchanged files via the sha256 manifest |
| `export-lake` | Read-only snapshot of iWantClips clips and categories from the content lake into `data/lake/` |
| `jobs make <job>` / `jobs collect <job>` | Agent jobs (labelling): write batch files, validate and merge outputs; see [`LABELING.md`](LABELING.md) |
| `lexicon concepts` / `aliases [--round N] [--only C]` / `build` | Mine the concept lexicon from the lake snapshot: batches for the concept grouping and the alias filter, then assemble `vocab.yaml`, `lexicon.json` and `lexicon_report.md` (validated on held-out clips) |
| `index build <version> [--vector-set S]` | Builds `data/index/<version>`: `index.json`, vector sets, models, `golden.json` and the bundled `recommend.py` |
| `index publish <version>` | Uploads the version to `<key_root>rag/<version>/` (index.json last), then points `rag/latest.json` (with the sha256 of `index.json`) at it |
| `eval sample` | Writes `eval/contexts.jsonl`: held-out clips round-robin over the mined concepts (one per concept, then a second, up to 100), plus the hand cases |
| `eval pool [--extra] [--variant V]` | Pools every variant's top candidates per context into `eval_grade` batches (graders do not see the lexicon aliases); `--extra` grades only new pool members |
| `eval score [--no-search] [--variant V]` | nDCG@3 per variant and a grid search, tuned on the tune half of the contexts and reported on the test half with the share of unjudged top-3 picks; writes `eval/report.md` |

## Layout

- `src/refsrag/keys.py` is the only place that builds object keys and URLs: library path → ref key
  (`library/refs/assets/...`, what the index stores) → S3 key (`public/` + ref key) and public URL
  (`base_url` + ref key).
- `catalog.py` loads typed items; `vocab.py` holds the fixed vision vocabularies as types;
  `labels.py` the record schemas agents must return; `jobs.py` the batch contract;
  `prepare.py` builds batch items (768 px thumbnails, sha256 cache keys).
- `lake.py` is the only module that touches the content lake (read-only, run inside the lake's own
  uv environment); `split_of` assigns each clip to `mine` (80%) or `heldout` (20%).
- `text.py`: the English-only and age-code filters shared by all modules.
- `stage1.py` (lexicon matching, BM25, RRF, MMR) and `query.py` (the `Recommender`: dense retrieval,
  reranking, best view per pose, `fetch_index`) are standard library plus numpy. With `keys.py` they are
  bundled by `index build` into the single script `recommend.py` shipped inside each index version.
- `mine_lexicon.py` builds the lexicon, `affinity.py` item-to-concept weights, `index_build.py` the index
  and its publication, `eval.py` the calibration (contexts, pooling, nDCG@3, grid search); `eval/` holds
  the contexts, grades and reports.

## Using the recommender

`recommend.py` is published with each index version. Fetch it and run it against `latest.json`, which is
`base_url` from `config.yaml` plus `library/refs/rag/latest.json`:

```sh
BASE=$(grep '^base_url:' config.yaml | cut -d' ' -f2)
curl -fsSO "${BASE}library/refs/rag/$(curl -fsS "${BASE}library/refs/rag/latest.json" | jq -r .path | cut -d/ -f1)/recommend.py"
python recommend.py "college girl cosplay, foot tease" --index "${BASE}library/refs/rag/latest.json" --json
```

Options: `-k`, `--kind outfit|pose`, `--solo solo|duo`, `--max-exposure 0..3`, `--base-url`. The index
(`index.json`, vectors, models) is downloaded once into `~/.cache/refs-recommender/<version>`: the
download is verified against the `sha256` in `latest.json` and installed atomically, so concurrent runs
are safe. Needs numpy; onnxruntime + tokenizers enable local dense retrieval and reranking, and
`FEATHERLESS_API_KEY` enables Featherless embeddings (optional). From the package:
`Recommender.load(url_or_dir).recommend(context)`.
