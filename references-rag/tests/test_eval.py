"""Calibration helpers on a tiny hand-made index and synthetic clips: sampling, pooling items, grades,
nDCG@3, the tune/test split and the scoring bookkeeping. Offline: no lake, no network."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from conftest import TEST_CATALOG

from refsrag import eval as ev
from refsrag.labels import EvalGrades
from refsrag.lake import split_of
from refsrag.query import SCHEMA_VERSION, Index, Recommender

SHA = "0" * 64


def _item(item_id: str, kind: str, doc: str) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": item_id,
        "kind": kind,
        "title": f"title {item_id}",
        "doc": doc,
        "concepts": {},
    }
    if kind == "outfit":
        attrs: dict[str, Any] = {"exposure": 1, "category": "c"}
        return base | {"attrs": attrs, "media": {"image": f"library/refs/assets/{item_id}.png"}}
    view = {
        "angle": "front",
        "image": f"library/refs/assets/{item_id}.png",
        "depth": "d.png",
        "focus": {},
        "view": "v",
    }
    attrs = {"solo": True, "sex_positions": [], "series": "s", "category": "c"}
    return base | {"attrs": attrs, "media": {"views": [view]}}


ITEMS = [
    _item("O1", "outfit", "black lace garter set. Used for: stockings, nylons"),
    _item("O2", "outfit", "pleated skirt and blouse. Used for: schoolgirl"),
    _item("P1", "pose", "prone feet raised soles. Used for: foot fetish"),
    _item("P2", "pose", "all fours kneeling"),
]


@pytest.fixture
def rec(tmp_path: Path) -> Recommender:
    index = {
        "schema_version": SCHEMA_VERSION,
        "index_version": "vtest",
        "catalog": TEST_CATALOG,
        "default_base_url": "https://cdn.test/",
        "params": {"bm25_k1": 1.2, "bm25_b": 0.75, "rrf_k": 60, "w_bm25": 1.0, "w_concept": 1.0,
                   "w_dense": 1.0, "w_rerank": 1.0, "candidates": 30, "mmr_lambda": 0.7, "reranker": None},
        "lexicon": {},
        "concepts": {},
        "items": ITEMS,
        "vector_sets": {},
        "files": [],
    }  # fmt: skip
    (tmp_path / "index.json").write_text(json.dumps(index))
    return Recommender(Index(tmp_path), vector_set=None)


def _clip(clip_id: str, categories: list[str], popularity: float, **over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "clip_id": clip_id,
        "media_kind": "video",
        "title": f"Clip {clip_id}",
        "description": "plain",
        "categories": categories,
        "keywords": [],
        "popularity": popularity,
    }
    return base | over


def _heldout(count: int) -> list[str]:
    return [f"c{i}" for i in range(100_000) if split_of(f"c{i}") == "heldout"][:count]


# ── sampling ────────────────────────────────────────────────────────────────────────────────


def test_sampling_is_round_robin_so_the_cap_starves_no_concept(monkeypatch: pytest.MonkeyPatch) -> None:
    ids = _heldout(12)
    concepts = {"a": ["A"], "b": ["B"], "c": ["C"]}
    # "a" has the most popular clips: an alphabetical walk would give it everything under a cap of 4
    clips = [_clip(i, ["A"], 100 - n) for n, i in enumerate(ids[:6])]
    clips += [_clip(i, ["B"], 10 - n) for n, i in enumerate(ids[6:9])]
    clips += [_clip(i, ["C"], 1) for i in ids[9:12]]
    monkeypatch.setattr(ev, "MAX_CLIP_CONTEXTS", 4)
    clip_contexts = [c for c in ev.sample_contexts(clips, concepts) if c.source != "hand"]
    assert len(clip_contexts) == 4
    assert {k for c in clip_contexts for k in c.concepts} == {"a", "b", "c"}
    # the first round gave one per concept, the 4th pick is the second clip of "a"
    assert [c.source for c in clip_contexts[:3]] == [f"iwc:{ids[0]}", f"iwc:{ids[6]}", f"iwc:{ids[9]}"]
    assert clip_contexts[3].source == f"iwc:{ids[1]}"


def test_sampling_filters_and_adds_hand_cases() -> None:
    ids = _heldout(6)
    mine = next(f"c{i}" for i in range(10_000) if split_of(f"c{i}") == "mine")
    clips = [
        _clip(ids[0], ["A"], 1, description="<p>Hi&nbsp;there</p>"),
        _clip(ids[1], ["A"], 1, media_kind="audio"),
        _clip(ids[2], ["A"], 1, title=" "),
        _clip(ids[3], ["A"], 1, description="こんにちは"),
        _clip(ids[4], ["A"], 1, description="just turned 18"),
        _clip(ids[5], ["Other"], 1),
        _clip(mine, ["A"], 1),
    ]
    contexts = ev.sample_contexts(clips, {"a": ["A"]})
    clip_contexts = [c for c in contexts if c.source != "hand"]
    assert [(c.id, c.text) for c in clip_contexts] == [(f"iwc-{ids[0]}", f"Clip {ids[0]}. Hi there")]
    assert len(contexts) == 1 + len(ev.HAND_CASES)


# ── nDCG@3 ──────────────────────────────────────────────────────────────────────────────────


def test_ndcg_counts_unjudged_items_as_zero() -> None:
    grades = {"a": 3, "b": 1}
    assert ev.ndcg_at_3(["a", "b"], grades, grades) == pytest.approx(1.0)
    assert ev.ndcg_at_3(["zz", "a"], grades, grades) is not None
    worse = ev.ndcg_at_3(["zz", "a", "b"], grades, grades)
    assert worse is not None and 0 < worse < 1  # the unjudged pick pushed the relevant ones down


def test_ndcg_is_none_when_nothing_is_relevant() -> None:
    assert ev.ndcg_at_3(["a", "b"], {"a": 0, "b": 0}, ["a", "b"]) is None
    assert ev.ndcg_at_3(["a"], {}, []) is None


def test_ndcg_with_fewer_than_three_items() -> None:
    assert ev.ndcg_at_3(["a"], {"a": 2}, ["a"]) == pytest.approx(1.0)
    assert ev.ndcg_at_3([], {"a": 2}, ["a"]) == 0.0
    # ideal uses at most the top 3 grades; a 4th relevant item does not lower a perfect ranking
    assert ev.ndcg_at_3(["a", "b", "c"], dict.fromkeys("abcd", 3), "abcd") == pytest.approx(1.0)


# ── grading items ───────────────────────────────────────────────────────────────────────────


def test_strip_used_for_removes_the_lexicon_sentence() -> None:
    assert ev.strip_used_for("Garments: bra. Used for: stockings, nylons") == "Garments: bra"
    assert ev.strip_used_for("Used for: x") == ""
    assert ev.strip_used_for("no aliases here") == "no aliases here"


def test_grade_items_hide_the_aliases_and_pool_every_variant(rec: Recommender) -> None:
    ctx = ev.EvalContext("hand-01", "stockings", "hand", ())
    (item,) = ev.grade_items(rec.index, [ctx], {"v": rec})
    assert item.id == "hand-01"
    shown = {c["id"]: c for c in item.inputs["items"]}
    assert set(shown) == {"O1", "O2", "P1", "P2"}  # the pool is deeper than the index
    assert all("Used for" not in c["doc"] for c in shown.values())
    assert shown["O1"]["doc"] == "black lace garter set"


def test_grade_items_extra_has_only_ungraded_items(rec: Recommender) -> None:
    ctx = ev.EvalContext("hand-01", "stockings", "hand", ())
    graded = {"hand-01": {"O1": 3, "P1": 0}}
    (item,) = ev.grade_items(rec.index, [ctx], {"v": rec}, graded)
    assert item.id == "hand-01" + ev.EXTRA_SEP
    assert [c["id"] for c in item.inputs["items"]] == ["O2", "P2"]
    full = {"hand-01": dict.fromkeys(("O1", "O2", "P1", "P2"), 1)}
    assert ev.grade_items(rec.index, [ctx], {"v": rec}, full) == []  # nothing new: no item at all


# ── grades ──────────────────────────────────────────────────────────────────────────────────


def _results(monkeypatch: pytest.MonkeyPatch, **by_id: dict[str, int]) -> None:
    results = {k: EvalGrades(id=k, sha256=SHA, grades=g) for k, g in by_id.items()}
    monkeypatch.setattr(ev, "load_results", lambda job: results)


def test_load_grades_merges_extra_and_skips_unknown_items(monkeypatch: pytest.MonkeyPatch) -> None:
    _results(
        monkeypatch,
        **{
            "hand-01": {"O1": 3, "gone": 2},
            "hand-01" + ev.EXTRA_SEP: {"P1": 1, "also-gone": 3},
            "hand-02": {"O2": 0},
        },
    )
    assert ev.load_grades({"O1", "O2", "P1", "P2"}) == {"hand-01": {"O1": 3, "P1": 1}, "hand-02": {"O2": 0}}


def test_score_ignores_grades_of_items_no_longer_in_the_index(rec: Recommender) -> None:
    ctx = ev.EvalContext("hand-01", "stockings", "hand", ())
    kind_of = {i["id"]: i["kind"] for i in ITEMS}
    grades = {"hand-01": {"O1": 3, "P1": 2, "removed": 3}}
    result = ev.score(rec, [ctx, ev.EvalContext("hand-02", "x", "hand", ())], grades, kind_of)
    assert result.contexts == 1  # hand-02 has no grades
    assert result.kinds["outfit"] == pytest.approx(1.0)
    assert list(result.kinds) == ["outfit", "pose"]


def test_score_reports_the_unjudged_share_of_top3(rec: Recommender) -> None:
    ctx = ev.EvalContext("hand-01", "stockings", "hand", ())
    kind_of = {i["id"]: i["kind"] for i in ITEMS}
    result = ev.score(rec, [ctx], {"hand-01": {"O1": 3}}, kind_of)
    assert result.unjudged == pytest.approx(3 / 4)  # 2 outfits + 2 poses in the top 3; only O1 judged


# ── tune / test split and grid ──────────────────────────────────────────────────────────────


def test_tune_test_split_is_deterministic_and_partitions() -> None:
    contexts = [ev.EvalContext(f"iwc-{i}", "t", "hand", ()) for i in range(200)]
    tune, test = ev.split_contexts(contexts)
    assert ev.split_contexts(contexts) == (tune, test)
    assert len(tune) + len(test) == 200 and not {c.id for c in tune} & {c.id for c in test}
    assert 70 < len(tune) < 130


def test_grid_includes_the_index_default_and_skips_w_dense_without_dense(rec: Recommender) -> None:
    assert 0.7 in ev.GRID["mmr_lambda"]
    trials = list(ev.grid(rec))  # vector_set=None: no embedder
    assert {t["w_dense"] for t in trials} == {1.0}  # untouched
    assert len(trials) == len(ev.GRID["w_bm25"]) * len(ev.GRID["w_concept"]) * len(ev.GRID["mmr_lambda"])
