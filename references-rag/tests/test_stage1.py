from refsrag.stage1 import alias_key, match_concepts, tokenize

LEXICON = {
    "soles": {"foot_fetish": 1.0},
    "foot worship": {"foot_fetish": 1.0},
    "school girl": {"schoolgirl_roleplay": 1.0},
    "nylons": {"pantyhose": 0.7, "foot_fetish": 0.5},
}


def test_tokenize_folds_case_accents_and_punctuation() -> None:
    assert tokenize("School-Girl JOI, café!") == ["school", "girl", "joi", "cafe"]
    assert alias_key("  Foot   Worship ") == "foot worship"


def test_match_takes_highest_weight_per_concept() -> None:
    found = match_concepts("Soles and nylons: a school-girl foot worship clip", LEXICON)
    assert found == {"foot_fetish": 1.0, "pantyhose": 0.7, "schoolgirl_roleplay": 1.0}


def test_match_needs_contiguous_tokens() -> None:
    assert match_concepts("school uniform, girl next door", LEXICON) == {}


def test_bm25_prefers_rare_matching_terms() -> None:
    from refsrag.stage1 import Bm25

    bm = Bm25([["red", "dress"], ["red", "shoes"], ["blue", "stockings", "garter"]], k1=1.2, b=0.75)
    s = bm.scores(["garter", "red"])
    assert s[2] > s[0] > 0 and s[0] == s[1]


def test_rrf_skips_absent_signals_and_weights() -> None:
    from refsrag.stage1 import rrf

    a, b = [3.0, 1.0, 2.0], [0.1, 0.9, 0.5]
    assert rrf([a, [0.0, 0.0, 0.0], b], [1.0, 5.0, 1.0], k=60) == rrf([a, b], [1.0, 1.0], k=60)
    heavy_b = rrf([a, b], [1.0, 3.0], k=60)
    assert heavy_b.index(max(heavy_b)) == 1  # b's top item wins once b weighs more


def test_mmr_trades_relevance_for_novelty() -> None:
    from refsrag.stage1 import mmr_pick

    rel = [1.0, 0.95, 0.5]
    same = {(0, 1), (1, 0)}
    picks = mmr_pick([0, 1, 2], rel, lambda i, j: 1.0 if (i, j) in same else 0.0, k=2, lam=0.5)
    assert picks == [0, 2]


def test_rrf_gives_no_credit_for_zero_and_ties_share_a_rank() -> None:
    from refsrag.stage1 import rank_positions, rrf

    assert rank_positions([0.0, 2.0, 0.0, 2.0, 1.0]) == [3, 0, 3, 0, 2]
    fused = rrf([[0.0, 0.0, 5.0, 0.0]], [1.0], k=60)
    assert fused == [0.0, 0.0, 1 / 61, 0.0]  # zero-score items gain nothing, whatever their index
    dense = rrf([[-0.2, -0.1, 0.3]], [1.0], k=60)  # a signal that can go negative ranks every item
    assert dense[2] > dense[1] > dense[0] > 0


def test_mmr_scales_relevance_to_the_similarity_range() -> None:
    from refsrag.stage1 import mmr_pick

    rel = [0.050, 0.049, 0.010]  # RRF-sized relevance: a near-duplicate 2nd must still beat a weak 3rd
    sim = {(0, 1): 0.1, (1, 0): 0.1}
    assert mmr_pick([0, 1, 2], rel, lambda i, j: sim.get((i, j), 0.0), k=2, lam=0.7) == [0, 1]
