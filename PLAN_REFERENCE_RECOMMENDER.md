# Plan: pose and outfit reference recommender

Status: **draft v3 for review** (2026-11-08). Revised after the P0 spike (`references-rag/spike/FINDINGS.md`) and the user's feedback on it (section 10).

## 1. Goal

Given some text context (a scene, clip pitch, kink, scenario or act), return the **top 3 poses** and the **top 3 outfits** from `nsfw-poses-references/`. Each result carries public https URLs to its files on S3, built from a configurable `baseUrl`.

The deliverables:

- An index build script.
- A file-based index on S3 (no RDBMS, no server).
- A Python query interface that a sandbox can download and run.
- A TypeScript port that runs inside video-harness.

Faces are out of scope.

The recommender **always returns the nearest matches**, and `why` says what matched.

| Context | Expected top results |
|---|---|
| "college girl cosplay" | Pleated-skirt, blouse and knee-socks looks; costume pieces (the `sexy` category has witch, ninja, angel, shrine-maiden and qipao costumes) |
| "foot fetish, soles" | Poses whose soles face the camera (best angle chosen); hosiery, sandal or barefoot looks |
| "ass worship" | All-fours, prone and arched-back poses from rear or low angles; thongs and short skirts |

## 2. The library (confirmed by the spike)

| Set | Unit | Count | Notes |
|---|---|---|---|
| `outfits/` | Garment flat-lay PNG plus JSON | 1,407 (8 categories) | The existing tags are wrong or incomplete in about 40% of items. **Vision labels are the source; the tags are only a hint.** |
| `pose_pngs/` | Mannequin line art, 5 angles | **288 poses**, 1,439 images | Angle names are camera placements, not body orientation (P007 `front` is a rear view). Some Japanese names don't match their images. **The image wins.** |
| `pose_depth/` | Depth map per pose image | 1,439 | Same file names as `pose_pngs/` |
| `_by_focus/` | Keyword copies | Duplicates | Never index units |

**English only.**

- `catalog.py` drops every Japanese catalog field (`series_ja`, `category_ja`, `pose_name_ja`) when it loads the catalog.
- A pose's identity and series/category come from the English folder path plus the pose number, e.g. `solo/full_body_sexy/lying` + `P063`.
- `name_en` comes from the vision labelling pass, which sees only the images and English context.
- No Japanese text reaches labels, `index.json`, results, docs or tests. A test asserts this over the built index.

**Worktrees and the library root.**

- Build code lives on branch `refs-recommender`, in the worktree `~/work/auteur-library-worktrees/refs-recommender`.
- The image library (`nsfw-poses-references/`, about 2 GB without faces) is not committed. `REFS_LIBRARY_ROOT` in `.env` points at it.
- video-harness changes (P6) go in their own worktree.

## 3. TypeScript answer (confirmed by the spike)

- **Neural models can't run inside an agent.** The Golem agent runtime is wasm-rquickjs 0.2.3 on QuickJS-ng, with no `WebAssembly`, so ONNX and transformers.js are out.
- **Everything else is fast in pure TypeScript.** On a 1.7 MB index in QuickJS:
  - parsing the index and building the BM25 index takes about 150 ms;
  - a query (BM25, concept matching, RRF fusion and MMR diversity) takes 5–7 ms;
  - scoring the query against every item's vector takes about 40 ms (1,700 × 384 dimensions), provided the vectors arrive as binary float32;
  - memory is about 4–7 MiB;
  - QuickJS and Node return the same top 3.
- **Dense embeddings come from an embedding API, not an in-agent model.** Featherless serves `Qwen/Qwen3-Embedding-0.6B` (1,024 dimensions) and `-4B` (2,560 dimensions) on an OpenAI-compatible `/v1/embeddings` endpoint. Both were verified live; the cost is about $1e-8 per token. Ollama Cloud has no embeddings endpoint.
- **The spike numbers** (nDCG@3, 30 items, 20 queries):

| Method | Outfits | Poses |
|---|---|---|
| BM25 + concepts (no dense) | 0.737 | 0.823 |
| Hybrid with local bge-small | 0.747 | 0.875 |
| Hybrid with Featherless Qwen3-Embedding-0.6B | 0.781 | 0.876 |
| Hybrid with Featherless Qwen3-Embedding-4B | **0.795** | **0.885** |
| Hybrid (bge-small) + bge-reranker-base | 0.760 | 0.919 |

→ **TypeScript gets dense retrieval through a new workspace setting, `spec.embedder` (section 4.6).** The Python side uses the same model when a Featherless key is present, so both languages rank with identical vectors.

## 4. Architecture

```
 BUILD (auteur-library/references-rag)                                   s3://auteur-model-cache-…/public/library/refs/
 content lake ──▶ mine_lexicon.py ──▶ agent job: concepts + alias filter ──▶ vocab.yaml, lexicon.json
 (iwantclips)        │  (stats: categories, n-gram log-odds, held-out test)
                     └──▶ eval.py (sample) ──▶ eval/contexts.jsonl
 library ──▶ catalog.py ──▶ make_batches.py ──▶ agent job: vision labels (Sonnet, batched, parallel)
                │                                   └──▶ validate.py (schema, vocab, coverage, agreement)
                │                          ──▶ agent job: concept affinities (text only)
                ├──▶ assets.py ─────────────────────────────────────────────▶ assets/<library path>.png
                └──▶ index_build.py (docs, lexicon, embeddings: local + Featherless) ─▶ rag/v<N>/{index.json,
                                                                                 vectors.*.f32, models/,
                                                                                 recommend.py, golden.json}
                                                                               rag/latest.json
 QUERY  Python recommend.py: concepts + BM25 + dense (Featherless if key, else local ONNX) ─▶ RRF ─▶ [cross-encoder] ─▶ group/MMR
        TS ReferenceIndexAgent: concepts + BM25 + dense (spec.embedder, if set) ─▶ RRF ─▶ [LLM rerank] ─▶ group/MMR
```

### 4.1 Item model, storage and URLs

These are unchanged from v2.

- `Outfit` and `Pose`. A pose has 5 angles, each with an image, a depth map and per-angle focus. Results carry a `best_angle`.
- **Bucket:** `auteur-model-cache-20260905193718168400000001`.
- **Prefix:** `public/library/refs/`, which is public-read.
  - Assets mirror the library folders under `assets/`.
  - Index versions live under `rag/v<N>/`, with `rag/latest.json` pointing to the current one.
- **URLs** are `baseUrl + key`, where the key is relative to `library/refs/`.
  - video-harness uses `modelCachePublicBaseUrl` as `baseUrl`.
  - Python takes `--base-url`, then `REFS_BASE_URL`, then the index default, in that order.
  - One function builds the URL in each language.

### 4.2 Lexicon: mined automatically from the content lake

The spike showed the concept lexicon is the strongest lever: two alias fixes moved outfits from 0.685 to 0.737. It is built automatically, with no manual review gate. The script is `mine_lexicon.py`, a read-only use of the content lake through `contentlake.views.connect`.

1. **Concepts.**
   - Take the top ~300 categories from `silver_iwantclips_categories`, by video count plus hottest rank.
   - An agent job groups them into about 40–60 concepts. Each concept gets one of the types `kink`, `roleplay`, `act`, `garment` or `body_focus`.
   - Categories with nothing visual are dropped (audio only, language, religious).
   - **Age-coded categories are always dropped** ("18-19 Years Old"). `schoolgirl` is always the adult roleplay look.
2. **Alias candidates (statistics).**
   - For each concept, take the 1–3-word n-grams from title, description and keywords of clips in its member categories.
   - Rank them by log-odds ratio against all clips, with a minimum support, and keep the top ~40.
   - Category names and keywords become aliases directly.
3. **Alias filter (agent job).**
   - Keep aliases that precisely name the concept.
   - Drop generic ones like "roleplay", "custom", "video" or "hd", and anything age-coded.
   - Give each alias a weight (0.5–1.0).
4. **Automatic validation on held-out clips.**
   - Split the 12,991 clips 80/20.
   - On the 20%, map each clip's text through the lexicon and compare the result with the concepts of the clip's own categories.
   - Report precision and recall per concept.
   - Concepts with recall below 0.6 get another round of mining and filtering (at most 2 rounds). Aliases with precision below 0.5 are dropped.
   - The report lands in `lexicon_report.md`.

The output is `vocab.yaml` (concepts, plus the fixed outfit, pose and focus terms) and `lexicon.json` (alias → concept and weight), both committed. Rerunning `mine_lexicon.py` refreshes them from the current lake.

### 4.3 Labelling: in-session Claude Sonnet agents, batched and parallel

There is no Anthropic API key and no per-call billing. Labelling runs as **agent jobs** inside a Claude Code session, on Sonnet subagents.

- **Contract.** Deterministic Python writes `jobs/<job>/batch_NNN.json`, which lists the item ids, image paths, vocabulary and output schema. Each agent writes `jobs/<job>/out/batch_NNN.json`, and `validate.py` checks it.
- **Resumability.** A batch whose output exists and validates is skipped. A batch that fails validation is re-queued, up to 2 times. Item results are keyed by image sha256, so rerunning after library changes only labels new or changed images.
- **Runbook.** `LABELING.md` gives the exact commands and prompts, so any later Claude Code session can rerun a job.

| Job | Input per agent | Batches | Notes |
|---|---|---|---|
| `outfit_vision` | 20 outfits (images downscaled to 768 px) | about 71 | Description, garments, colours, materials, archetypes, exposure, accentuated body parts, footwear, season. The spike schema minus `concepts`. |
| `pose_vision` | 4 poses × 5 angles (20 images) | 72 | Per-angle focus and view, `name_en`, description, support, mood, and duo `sex_positions` / `typical_acts` (exact names from `explicit-acts`) |
| `concept_affinity` | 100 items, text only | about 17 | Weights each item against the mined concepts using its vision labels. **It's separate from the vision pass so a lexicon change needs no image re-read.** |
| `qa_double` | 5% of items, labelled again by a second agent | about 8 | Agreement report: archetype and focus overlap, top-concept match |

- **Execution.** About 170 agents in waves of about 12 in parallel, as a Workflow run. Expected wall time is 30–45 minutes.
- **Quality gates.** 100% coverage and schema validity, and at least 0.7 agreement on top focus and top archetype in `qa_double`.

### 4.4 Index format

- `index.json`:
  - `schema_version`, `index_version`, `default_base_url`, `params` (BM25 k1 and b, RRF k, fusion weights, rerank depth and blend, MMR λ);
  - `vocab` and `lexicon`;
  - `items[]`, each with its `doc` and `concepts{}`;
  - `vector_sets{}`.
- **Vector sets**, one per embedding model, keyed by `<provider>:<model>`. Each is binary **float32** (the spike showed base64 is too slow in QuickJS), L2-normalized, in item order.
  - `featherless:Qwen/Qwen3-Embedding-0.6B` or `-4B`, possibly truncated (Matryoshka) to 1,024 dimensions. P5 decides on quality against size and TypeScript cosine time.
  - `local:bge-small-en-v1.5`, the offline fallback for Python.
- `models/` holds the local ONNX embedder, plus the cross-encoder if P5 keeps one.
- `golden.json` holds parity fixtures for both languages: stage-1 scores, plus dense scores computed with stored query vectors so no network is needed.

### 4.5 Python interface

- `recommend.py` is a single file with dependencies `numpy`, `onnxruntime`, `tokenizers` and `httpx`.
- **Dense query vectors:**
  - If `FEATHERLESS_API_KEY` is set, embed the query with the index's Featherless model.
  - Otherwise use the local ONNX model and its vector set.
  - Otherwise use stage 1 only.
- **Cross-encoder:** optional. P4 ships MiniLM-L6 (23 MB); P5 makes the final choice.
- **API and CLI:** `Recommender.from_url(...)`, `.recommend(context, k=3, kinds=..., filters=...)`, and `python recommend.py "<context>" --json`.
- **Sandbox:** add `onnxruntime`, `tokenizers` and `httpx` to the fat image (`release/Dockerfile`, `sandbox-toolchain-builder`, the chroot `/opt/venv`) and to `docker/sandbox-base`. Smoke-test through `sandbox_python`.

### 4.6 video-harness integration

**New workspace setting `spec.embedder`**, modelled on `spec.decider`:

```ts
/** `spec.embedder`: the embedding model behind dense retrieval (reference recommender). Absent = no dense retrieval. */
export interface EmbedderSpec {
  /** Id of an entry in `spec.models` that advertises the `embed` capability. */
  model: string;
}
```

- **Resolution** happens only in `resolveEmbedder(spec)`, next to `resolveDecider`. `validateWorkspace()` checks that the model exists and advertises `embed`.
- **Backend:** `createEmbeddingBackend()` (`src/llm/factory.ts`, today `unsupported`) gains an OpenAI-compatible `/v1/embeddings` backend. It covers Featherless, and any `openai`-provider endpoint that serves embeddings.
  - Durable agents reach it only through the transport (`embeddingBackendVia()`), following the decision-backend pattern.
  - The key is the existing `featherlessApiKey` secret.
- **Model mismatch:** if the workspace embedder's `<provider>:<model>` has no vector set in the index, the tool runs without dense retrieval and says so in its result (`dense: "unavailable: no vector set for <id>"`). It does not fail.
- **`src/references/`:**
  - `reference-index.ts`: types, loader, and the stage-1 and dense scorer;
  - an ephemeral `ReferenceIndexAgent` modelled on `WorkspaceReadAgent`, with a content-addressed KV cache in the style of `prefetch-index.ts`;
  - parity tests against `golden.json`.
- **Worker tool `recommend_references`:**
  - it sits next to `lora_index` and is gated in `tool-scope.ts`;
  - it takes `{context, kinds?, k?, filters?}` and returns the Python result shape;
  - an optional LLM rerank goes through the decider (`ai-decide` path).
- **Index location:** `modelCachePublicBaseUrl` + `library/refs/rag/latest.json`. There's no new URL config.
- **Before building, check in a deployed agent:** `typeof WebAssembly`, native `atob` speed, whether ephemeral instances are reused, and executor memory and fuel limits.
- **P7 (separate plan):** using a result as a design reference image (`artifact://` import or a URL allow-list).

## 5. Calibration from the content lake

- **Eval set.** `refs eval sample` takes up to 100 video clips from the **20% held-out split**, round-robin over the mined concepts (most popular clip first), plus 18 hand-written cases.
  - Clips with age-coded categories or text are always excluded (`text.is_age_coded`).
  - P1 stratified by the top categories. Requiring nudity skews that toward JOI and domination, so P5 re-samples stratified by the **mined visual concepts** (foot fetish, ass worship, cosplay and so on) and drops the nudity requirement.
- **Labels.** Pool the top 20 from all variants. The grading is an agent job: Sonnet agents grade 0–3 with a rationale, 10 queries per agent. That gives `eval/qrels.jsonl`.
- **Variants compared:**
  - stage 1;
  - hybrid with each embedder (local bge-small, Qwen3-0.6B, Qwen3-4B, 4B truncated to 1,024);
  - each of those with no reranker, MiniLM, bge-reranker-base, or an LLM rerank through the decider;
  - the TypeScript configuration (same embedder, LLM rerank).
- **Acceptance:**
  - nDCG@3 ≥ 0.80 for both kinds in the best Python configuration;
  - TypeScript (with `spec.embedder` set) within 0.03 of Python;
  - facet hit on all of the user's examples.
- **Tuned `params`** are frozen into the index, so both languages use the same numbers.

## 6. Repo layout (auteur-library)

```
references-rag/                 uv project, Python 3.12
  pyproject.toml  .env.example (FEATHERLESS_API_KEY, AWS creds, lake creds)  config.yaml
  vocab.yaml  lexicon.json  lexicon_report.md  LABELING.md
  src/refsrag/
    catalog.py       normalize csv/json -> Outfit / Pose, stable keys (the single key builder)
    assets.py        upload library files (sha256 skip)
    lake.py          read-only content lake access (the only module that imports contentlake)
    mine_lexicon.py  concepts, alias stats, held-out validation
    jobs.py          agent-job contract: make_batches, collect, validate, sha256 cache
    index_build.py   docs, embeddings (local + Featherless), golden, pack + upload v<N>, flip latest.json
    stage1.py        tokenizer, lexicon match, BM25, RRF, group/MMR (inlined into recommend.py)
  recommend.py       shipped single-file query interface
  jobs/              batch inputs and outputs per job (outputs committed; they are the labels)
  eval/              contexts.jsonl, report.md (grades live in jobs/eval_grade/results.jsonl)
  spike/             P0 artifacts
  tests/             unit, golden parity, offline fixtures (~20 items)
```

## 7. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| ~~P0 Spike~~ | Done; see `spike/FINDINGS.md` | — |
| ~~P1 Foundation~~ | **Done 2026-11-08:** uv project, `catalog.py` (English only), `assets.py` (4,285 files public under `public/library/refs/assets/`), `lake.py` (snapshot of 12,991 clips and 969 categories; 80/20 split), `jobs.py` and `prepare.py` (batches written: 71 outfit, 72 pose, 6 QA) | Met |
| ~~P2 Lexicon~~ | **Done, gate missed (see 11.1):** 60 concepts, 938 aliases, mean held-out recall 0.65; 11 concepts below 0.6 | Recall gate not met; precision not measurable (incomplete clip categories) |
| ~~P3 Labelling~~ | **Done:** 1,407 outfits and 288 poses (all views) labelled, 0 invalid; concept affinity v2 for all 1,695 items; QA agreement 94% (outfits, n=71), 86-100% (poses, n=7) | Met |
| ~~P4 Index and Python~~ | **Done:** `v1` on S3; bundled `recommend.py` runs from S3 in a clean env (local ONNX); sandbox deps added in video-harness worktree `vh-refs-sandbox` (not built, not committed) | Met, except the chroot smoke run (needs a deployed sandbox) |
| ~~P5 Calibration~~ | **Done:** 118 contexts (100 held-out clips + 18 hand cases), tune/test halves, 9 variants; `v2` published with the defaults (11.9) | Test half: Qwen3-4B + decider 0.756 outfits / 0.715 poses = 97% / 80% of the grader ceiling |
| ~~P6 video-harness~~ | **Built, uncommitted** in worktree `vh-refs-recommender` (branch `229-refs-recommender`): `spec.embedder`, Featherless embedding backend, `src/references/*`, ephemeral `ReferenceIndexAgent`, tool `recommend_references` (nudity-gated), parity tests on v2 | Parity green (stage 1 + full selection); TS config (0.6B + decider) 0.711 vs best 0.735 = within 0.03. Runtime checks need a deployed agent (11.10) |
| **P7 Production flow** | Result as design reference | Separate plan |

## 8. Risks

- **Lexicon mining picks up noise.** Clip descriptions are spammy (markup codes, "custom"). The log-odds ranking needs a minimum support, a stop-list, and the agent filter. The held-out precision gate catches the rest.
- **Featherless becomes unavailable or changes the model.** The query degrades to stage 1 or local ONNX, as designed. Vector sets are keyed by `<provider>:<model>`, so a model change is a new vector set, never a silent mismatch.
- **Agent-job labelling consistency** across about 170 agents. Mitigations: a fixed schema, the vocabulary and examples in every batch, `validate.py`, and the `qa_double` agreement gate.
- **The Python and TypeScript ports drift.** One `params` block in the index, and parity tests in both languages against `golden.json`.

## 9. Not needed any more

- `ANTHROPIC_API_KEY`: labelling, alias filtering and grading all run as in-session agent jobs.
- A manual vocabulary review gate: replaced by the automatic held-out validation from the lake.

## 10. Decisions log

| Date | Decision |
|---|---|
| 2026-11-08 | Calibration from the content lake; bucket `auteur-model-cache-…/public/library/refs`; Claude Sonnet labelling; always nearest match; no faces; add the dependencies to the fat image and `sandbox-base` |
| 2026-11-08 | Build code in `auteur-library`. Plan v2 approved; P0 spike run. |
| 2026-11-08 | Lexicon mined automatically from the content lake; dense in TypeScript through Featherless and a new `spec.embedder`; labelling in-session with batched, parallel Sonnet agents |

## 11. Deviations and findings during the build (2026-11-08)

1. **Lexicon gate (P2).**
   - The lexicon reached mean held-out recall 0.65, against a target of 0.70.
   - 11 concepts stay below 0.6. They are mostly ones clip text rarely names: femdom 0.33, cosplay, roleplay, bondage.
   - Precision can't be measured: a clip carries only 1-3 categories while its text names more, so "false" positives are often right. It is reported as a lower bound and not gated.
   - Two fixes after review:
     - mining rounds are merged, not replaced;
     - a category name maps only to its own concepts, and '-' parts that are stopwords ("Strap-On" → "on") are dropped.
2. **Calibration ceiling (P5).** An independent second grader, ranking its own top 3, scores nDCG@3 0.78 (outfits) and 0.89 (poses) against the first grader (n=20). The plan's absolute 0.80 is therefore at or above inter-grader agreement, and results are reported against this ceiling.
3. **Label terms as concepts.**
   - The vision labels are added to every item as `label:*` concepts: outfit archetype, accentuation, footwear; pose mood, focus, support, position.
   - Their aliases are derived from the term names. Single words are dropped when they occur in more than 3% of the lake's clip texts ("back", "face", "feet").
   - This covers library styles the store has no category for (office / secretary, nurse).
4. **Concept affinity v2.** Outfits are also weighted for the acts and kinks they are worn for: lingerie for sex acts, latex for femdom.
5. **Decider rerank.**
   - The decision-model rerank, Featherless `Qwen3.8-27B-classifier` with one 0..3 score question per candidate, is the planned TypeScript reranker.
   - Python implements it as an opt-in, so it can be calibrated.
6. **Ranking fixes from review.**
   - Rank fusion uses competition ranks and gives no credit for a zero score in a non-negative signal. Before, catalog position leaked into rankings.
   - MMR scales relevance to 0..1 first. Before, diversity swamped relevance.
7. **Calibration fixes from review.**
   - Contexts are sampled round-robin over concepts (5 concepts had none before).
   - Contexts are split into tune and test halves, and best params are reported on the test half.
   - The unjudged share is reported.
   - Graders no longer see the mined "Used for" alias sentence (it made grading partly circular).
8. **TypeScript port (P6).** Built in video-harness worktree `vh-refs-recommender`, branch `229-refs-recommender`, uncommitted. Review fixes are in progress:
   - a nudity-policy gate;
   - selection inside the ephemeral agent to keep the worker's oplog small;
   - no cross-call cache (every call is a fresh instance);
   - embedding prices.
9. **Frozen v2 defaults (from the test half of `eval/report.md`).**
   - Hybrid retrieval: BM25 + concepts + dense, weights 1/1/1, RRF k 60.
   - Decider rerank of the top 12 (weight 2) whenever a Featherless key or a workspace decider is available.
   - MMR λ 0.7. Diversity costs about 0.005; the grid's no-diversity optimum did not hold up on test.
   - No cross-encoder: no gain, and it saves a 23 MB model download.
   - `recommend.py` prefers Qwen3-Embedding-4B; the TypeScript templates use 0.6B (7 MB instead of 17 MB per cold call, 0.711 vs 0.735).
   - Without a key: local bge-small, test mean 0.61.
10. **Runtime checks (2026-11-09; local stack redeployed with a state reset).** The image was built from the integration branch `229-refs-integration` = local `229-design-studio` + both P6 branches.
    - **QuickJS:** `ReferenceIndexAgent.recommendDirect` gives the same output as Python (concepts, ids, scores, best views, `why`) on a lexical request with accented text, so `String.prototype.normalize` and the float maths match. `typeof WebAssembly` doesn't matter: the port uses none.
    - **Cold call (fresh ephemeral instance, CLI round trip included):**
      - lexical only: 7.3 s;
      - 0.6B embedding + decider: 7.6 s;
      - 4B embedding: 4.1 s.
    - **Memory:** the container peaked about 170 MB above baseline. The result is about 9 KB.
    - **Sandbox:** the fat image's sandbox venv has `onnxruntime` 1.31.1 and `tokenizers` 0.23.3. `recommend.py` downloaded from S3 runs there both without a key (local ONNX, 8.8 s cold) and with a key (4B + decider, 6.5 s). It was run with `/opt/venv/bin/python` in the container, not through the `sandbox_python` tool.
    - **Build blocker found and fixed:** `golem build` aborted in Wizer pre-initialization ("fuel allocated for hostcalls has been exhausted").
      - The JS bundle's memory snapshot (~135 MB) is read back as one `list<u8>` against wasmtime's default 128 MiB host-call fuel. The base branch was right at the limit; any growth fails.
      - Fix: `wasm-rquickjs` 0.3.4 vendored in the golem fork with `store.set_hostcall_fuel(1 << 31)` (golem worktree `golem-wizer-fuel`, branch `wizer-hostcall-fuel`, not pushed).
      - This must land in the golem fork before any production build of the recommender.
    - **Release gate still failing:** the checked-in `api/raw-openapi.json` is stale (`deployment/lib/export-raw-openapi.sh --write`). It also covers base-branch changes (`apiWorkerRenderFile`), not only the new `embed` purpose.
11. **Pose improvement experiments (2026-11-09), none adopted.** Measured with Qwen3-4B + decider on the same graded pool (nDCG@3 poses, tune / test).
    - Baseline (v3): 0.704 / 0.703.
    - No measurable gain:
      - deeper decider rerank (top 24): test 0.699;
      - a partner-on-screen gate (decision model yes/no → solo only): test 0.719 at depth 12, within noise; tune dropped;
      - pose-only fusion params: overfit;
      - option 1, a pose-specific affinity prompt (solo-performer kinks → solo poses): 0.691 / 0.703, and outfits test 0.731 → 0.695 from re-scored outfit affinities;
      - option 2, per-kind decider guidance ("viewer is the off-screen partner") + a `Figures:` doc line, with option 1: 0.723 / 0.693.
    - Option 3, per-view retrieval (one vector per camera view, pose = best view). After grading its 225 unseen picks: + decider 0.688 / 0.703 vs baseline 0.711 / 0.695 on the same cache. Paired test +0.008, 95% CI [-0.036, +0.055]: noise. Not adopted.
    - Option 4, vision rerank: line-art images attached to the decision model, 2×4 images or a contact sheet. Test 0.63–0.67, worse. The model reads the images but tracks the grades half as well as text (rank correlation 0.16 vs 0.33) and favours two-figure poses. Not adopted.
    - Finding: duo poses are over-picked (172 picks vs 99 among the best-graded), yet steering them away does not raise held-out nDCG. Remaining candidates:
      - per-view indexing (option 3);
      - a vision-model rerank of the top pose images (option 4);
      - library content (more solo standing / seated poses for JOI / femdom contexts).
