# Calibration report (P5)

Contexts: held-out iWantClips clips stratified by mined concept, plus hand cases, split by the
sha256 of the context id into a tune half (61) and a test half (57).
Metric: nDCG@3 against agent grades (0-3) of the pooled candidates; an unjudged pick counts as 0.
Unjudged = share of the top-3 picks no grader saw (tune / test). Contexts = scored (tune / test).

## Variants (index defaults)

| Variant | Tune mean | Test outfits | Test poses | Test mean | Unjudged | Contexts |
|---|---|---|---|---|---|---|
| stage1 | 0.610 | 0.642 | 0.583 | 0.613 | 0% / 0% | 61 / 57 |
| bge | 0.661 | 0.665 | 0.555 | 0.610 | 0% / 0% | 61 / 57 |
| qwen06 | 0.607 | 0.637 | 0.566 | 0.602 | 0% / 0% | 61 / 57 |
| qwen4 | 0.667 | 0.666 | 0.619 | 0.643 | 0% / 0% | 61 / 57 |
| bge+ce | 0.647 | 0.694 | 0.595 | 0.645 | 0% / 0% | 61 / 57 |
| qwen06+ce | 0.678 | 0.654 | 0.592 | 0.623 | 0% / 0% | 61 / 57 |
| qwen4+ce | 0.676 | 0.673 | 0.599 | 0.636 | 0% / 0% | 61 / 57 |
| qwen06+decider | 0.702 | 0.747 | 0.675 | 0.711 | 0% / 0% | 61 / 57 |
| qwen4+decider | 0.754 | 0.756 | 0.715 | 0.735 | 0% / 0% | 61 / 57 |

## Best parameters per variant (grid search on the tune half; test half is the honest number)

| Variant | Tune mean | Test outfits | Test poses | Test mean | Unjudged | Contexts | Params |
|---|---|---|---|---|---|---|---|
| stage1 | 0.659 | 0.676 | 0.627 | 0.651 | 3% / 2% | 61 / 57 | `{"w_bm25": 1.0, "w_concept": 3.0, "w_dense": 1.0, "mmr_lambda": 1.0}` |
| bge | 0.699 | 0.716 | 0.607 | 0.661 | 1% / 1% | 61 / 57 | `{"w_bm25": 1.0, "w_concept": 3.0, "w_dense": 1.0, "mmr_lambda": 1.0}` |
| qwen06 | 0.682 | 0.693 | 0.614 | 0.653 | 1% / 0% | 61 / 57 | `{"w_bm25": 1.0, "w_concept": 3.0, "w_dense": 0.5, "mmr_lambda": 1.0}` |
| qwen4 | 0.719 | 0.696 | 0.586 | 0.641 | 0% / 2% | 61 / 57 | `{"w_bm25": 0.5, "w_concept": 1.0, "w_dense": 1.0, "mmr_lambda": 0.8}` |
| bge+ce | 0.699 | 0.706 | 0.624 | 0.665 | 2% / 4% | 61 / 57 | `{"w_bm25": 1.0, "w_concept": 2.0, "w_dense": 2.0, "mmr_lambda": 1.0}` |
| qwen06+ce | 0.700 | 0.705 | 0.624 | 0.665 | 1% / 1% | 61 / 57 | `{"w_bm25": 0.5, "w_concept": 1.0, "w_dense": 1.0, "mmr_lambda": 1.0}` |
| qwen4+ce | 0.715 | 0.694 | 0.619 | 0.657 | 2% / 3% | 61 / 57 | `{"w_bm25": 1.0, "w_concept": 2.0, "w_dense": 2.0, "mmr_lambda": 1.0}` |
| qwen06+decider | 0.717 | 0.730 | 0.703 | 0.716 | 3% / 1% | 61 / 57 | `{"w_bm25": 0.5, "w_concept": 1.0, "w_dense": 0.5, "mmr_lambda": 0.7}` |
| qwen4+decider | 0.763 | 0.755 | 0.725 | 0.740 | 1% / 0% | 61 / 57 | `{"w_bm25": 1.0, "w_concept": 1.0, "w_dense": 1.0, "mmr_lambda": 1.0}` |
