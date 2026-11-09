# P0 spike findings: reference recommender (2026-11-08)

Plan: `../../PLAN_REFERENCE_RECOMMENDER.md`. Status: **for review, before P1 starts.**

Artifacts in this folder:

- `vocab_v0.yaml`
- `labels/*.json`: 20 outfits and 10 poses × 5 angles, labelled by Claude Sonnet
- `iwc_categories_top150.json`
- `iwc_sample_clips.json`
- `bakeoff.py` and `bakeoff_qrels.json`
- `quickjs_findings.md`

**Caveat.** The evaluation is small: 30 items, 20 queries (7 of them real iWantClips clips), graded by me. Treat the numbers as directional; P5 is where the real calibration happens.

## 1. Labelling quality (Claude Sonnet vision)

- **Outfits are labelled reliably.** Spot checks matched the images. The labels name the actual garments and style: a fox-shrine-maiden costume, a witch costume, a sheer office turtleneck.
- **The existing outfit tags are unreliable.** In 8 of 20 items they are missing or wrong, e.g. "socks" on items that show thigh-high stockings, and an untagged bikini. Vision labels become the main source; the tags are only a hint.
- **The library does contain real costumes.** The `sexy` category includes witch, ninja, angel, shrine-maiden and qipao looks, so cosplay queries get real matches. True school uniforms are still missing; the pleated-skirt looks are used as nearest matches.
- **Pose body-focus per angle is reliable for large areas** (butt, chest, legs, soles) and shaky for crotch, belly and hands.
  - Duo poses have lower confidence where the male figure hides the female one.
  - The duo mapping to `explicit-acts` positions was right in all 3 cases (doggy style / kneeling upright from behind, missionary, cowgirl).
- **Angle file names are camera placements, not body orientation.** P007's `front` is a rear view, and several `low` angles aren't low. Labelling each angle separately, as planned, is necessary; the angle name can't be used as a stand-in.
- **Some Japanese catalog names don't match their images.** P022 has no wrists overhead; P023 is a man lying flat, not two people seated. **Rule: the image wins over the name.**

## 2. Retrieval comparison (nDCG@3; higher is better)

| Method | Outfits | Poses |
|---|---|---|
| BM25 only | 0.670 | 0.648 |
| Concept lexicon only | 0.673 | 0.892 |
| Dense (bge-small) only | 0.546 | 0.790 |
| **Stage 1: BM25 + concepts** (what TypeScript can run) | 0.737 | 0.823 |
| Hybrid: BM25 + concepts + dense | 0.754 | 0.905 |
| Hybrid + cross-encoder MiniLM-L6 (23 MB, 4 ms per pair) | 0.744 | 0.884 |
| Hybrid + cross-encoder mxbai-xsmall (87 MB, 10 ms) | 0.681 | 0.883 |
| **Hybrid + cross-encoder bge-reranker-base** (279 MB, 20 ms) | **0.760** | **0.919** |
| Cross-encoder alone (best one) | 0.723 | 0.784 |

What this shows:

1. **The concept lexicon does most of the work.** Two alias fixes moved outfit Stage 1 from 0.685 to 0.737 and the hybrid from 0.676 to 0.754: adding "school girl" and "college girl", and removing the generic "roleplay" alias, which had pulled costumes into a secretary query.
   - The remaining misses are also lexicon gaps, e.g. "tits" doesn't map to `tit_worship`.
   - **Plan change:** P2 gains an alias-mining step that proposes aliases per concept from real iWantClips titles and descriptions, with a person reviewing them. Generic aliases get flagged.
2. **Dense embeddings help poses** (+0.08 over Stage 1). They don't help outfits.
3. **Cross-encoders add little.** They are weak alone, and only bge-reranker-base edges past the hybrid, by +0.01 to +0.015, which is within noise at this sample size.
   - **Plan change:** the Python default becomes hybrid plus an *optional* cross-encoder.
   - P5 decides among no reranker, MiniLM and bge-base on about 100 queries, and also tests an LLM rerank.
   - bge-base costs about 0.6 s per query for 30 candidates and 279 MB to ship.

## 3. TypeScript in video-harness (QuickJS)

- **There is no `WebAssembly` in the agent runtime.** The compiled guest is wasm-rquickjs 0.2.3 on QuickJS-ng; its only WebAssembly strings are "not supported" errors. So ONNX or transformers.js inside an agent is ruled out, as expected.
  - `TextDecoder`, `Float32Array`, `DataView` and `fetch().arrayBuffer()` are available.
- **Speed is fine.** On a synthetic 1.7 MB index, measured in QuickJS:
  - `JSON.parse` takes 11–14 ms and the BM25 build about 133 ms.
  - **One query takes 5–7 ms** and about 4 MiB of memory.
  - Add about 3x margin for wasmtime.
  - QuickJS and Node return the same top 3.
- **Dense vectors are cheap to score** (about 40 ms over 1700×384) if they arrive as binary float32. Base64 decoding in JS is too slow (about 380 ms). But the query vector still can't be computed in-agent, so dense stays out of TypeScript.
- **Hosting pattern.** Use an ephemeral agent (model: `WorkspaceReadAgent`) with a content-addressed KV cache (model: `src/workspace/prefetch-index.ts`). `lora_index` is not a precedent: it doesn't fetch anything.
- **Quality gap.** TypeScript Stage 1 is 0.823 on poses against 0.905 for the hybrid. P5 must show the LLM rerank closes that gap. If it doesn't, the fallback is the small Python embed service from the plan.
- **Still to verify in a deployed agent (start of P6):**
  - `typeof WebAssembly`
  - native `atob` speed
  - whether ephemeral instances are reused
  - executor memory and fuel limits

## 4. Other notes

- **Content lake:** the reads work through `contentlake.views.connect`; the views are named `silver_iwantclips_clips` and `silver_iwantclips_categories`. The lake has 12,991 clips, of which 2,181 are flagged nudity.
- **Kink vocabulary:** seeded from the top 150 categories. Categories that don't describe anything visual (audio only, German, religious) and **age-coded categories** ("18-19 Years Old") are excluded. `schoolgirl` is always the adult roleplay look.
- **Enrichment key:** production enrichment needs `ANTHROPIC_API_KEY` in `references-rag/.env`, at build time only. The alternative is running the labelling through Claude Code subagents, as this spike did.
- **Not tested here:** the sandbox chroot run (P4) and the cost of a full enrichment run.

## 5. Proposed plan changes

1. **P2:** add alias mining from iWantClips clips, with review; treat vision labels as primary and catalog tags and names as hints only (the image wins).
2. **P4:** the Python default is hybrid (BM25 + concepts + dense) plus an optional cross-encoder. Ship MiniLM-L6 by default (23 MB) until P5 decides.
3. **P5:** compare no reranker, MiniLM, bge-base and an LLM rerank on about 100 queries. The TypeScript acceptance gate (within 0.05 of Python) depends on the LLM rerank.
4. **P6:** begin with a 30-minute check in a deployed agent of the 4 open runtime questions.
