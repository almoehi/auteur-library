"""The query interface on a tiny hand-made index: ranking, best view, filters, URLs, and that the bundled
single-file recommend.py gives the same answer as the package."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from refsrag.index_build import bundle_recommend_py
from refsrag.query import SCHEMA_VERSION, Filters, Index, Recommender

BASE = "https://cdn.test/public/"


def _view(angle: str, focus: dict[str, float]) -> dict[str, Any]:
    return {
        "angle": angle,
        "image": f"library/refs/assets/pose_pngs/{angle}.png",
        "depth": f"library/refs/assets/pose_depth/{angle}.png",
        "focus": focus,
        "view": f"{angle} view",
    }


ITEMS: list[dict[str, Any]] = [
    {"id": "LNG-1", "kind": "outfit", "title": "Black lace garter set", "category": "lingerie", "exposure": 3,
     "doc": "black lace bra garter belt stockings heels. Used for: pantyhose stockings, nylons",
     "concepts": {"pantyhose_stockings": 0.9}, "image": "library/refs/assets/outfits/lingerie/LNG-1.png"},
    {"id": "SPR-1", "kind": "outfit", "title": "Pleated skirt and blouse", "category": "spring", "exposure": 1,
     "doc": "white blouse ribbon pleated mini skirt knee socks. Used for: schoolgirl roleplay",
     "concepts": {"schoolgirl": 0.8}, "image": "library/refs/assets/outfits/spring/SPR-1.png"},
    {"id": "solo/P1", "kind": "pose", "title": "Prone, feet up", "series": "full_body_sexy", "category": "lying",
     "solo": True, "sex_positions": [], "doc": "prone on forearms feet raised soles. Used for: foot fetish, soles",
     "concepts": {"foot_fetish": 0.9},
     "views": [_view("front", {"chest": 0.8}), _view("low", {"feet_soles": 0.9})]},
    {"id": "duo/P2", "kind": "pose", "title": "Doggy style", "series": "duo", "category": "from_behind",
     "solo": False, "sex_positions": ["doggy style"], "doc": "all fours partner kneeling behind. Positions: doggy style",
     "concepts": {"doggy": 0.9}, "views": [_view("side", {"butt": 0.9})]},
]  # fmt: skip


@pytest.fixture
def index_dir(tmp_path: Path) -> Path:
    index = {
        "schema_version": SCHEMA_VERSION,
        "index_version": "vtest",
        "default_base_url": BASE,
        "params": {"bm25_k1": 1.2, "bm25_b": 0.75, "rrf_k": 60, "w_bm25": 1.0, "w_concept": 1.0, "w_dense": 1.0,
                   "w_rerank": 1.0, "candidates": 30, "mmr_lambda": 0.7, "reranker": None},
        "lexicon": {"soles": {"foot_fetish": 1.0}, "stockings": {"pantyhose_stockings": 1.0},
                    "school girl": {"schoolgirl": 1.0}, "doggy style": {"doggy": 1.0}},
        "concepts": {"foot_fetish": {"type": "kink", "description": "feet", "focus": {"feet_soles": 1.0}}},
        "items": ITEMS,
        "vector_sets": {},
        "files": [],
    }  # fmt: skip
    (tmp_path / "index.json").write_text(json.dumps(index))
    return tmp_path


def test_concepts_drive_ranking_and_the_best_view(index_dir: Path) -> None:
    rec = Recommender(Index(index_dir))
    out = rec.recommend("show me your soles in stockings", k=1)
    assert out.concepts == {"foot_fetish": 1.0, "pantyhose_stockings": 1.0}
    assert out.dense.startswith("unavailable")
    (outfit,) = out.outfits
    (pose,) = out.poses
    assert (outfit.id, outfit.image) == ("LNG-1", BASE + "library/refs/assets/outfits/lingerie/LNG-1.png")
    assert (pose.id, pose.best_angle) == ("solo/P1", "low")  # the view showing the soles, not the first one
    assert pose.depth == BASE + "library/refs/assets/pose_depth/low.png"
    assert [v.angle for v in pose.views] == ["front", "low"]


def test_filters_and_k(index_dir: Path) -> None:
    rec = Recommender(Index(index_dir))
    duo_only = rec.recommend("doggy style", k=3, kinds=["pose"], filters=Filters(solo=False))
    assert [p.id for p in duo_only.poses] == ["duo/P2"] and duo_only.outfits == []
    covered = rec.recommend("school girl", k=3, kinds=["outfit"], filters=Filters(max_exposure=1))
    assert [p.id for p in covered.outfits] == ["SPR-1"]


def test_base_url_override_and_dense_vectors(index_dir: Path) -> None:
    index = Index(index_dir)
    assert (
        Recommender(index, base_url="https://other.test/x")
        .recommend("soles", k=1)
        .poses[0]
        .image.startswith("https://other.test/x/library/refs/")
    )
    vecs = np.eye(len(ITEMS), 4, dtype="<f4")
    vecs.tofile(index_dir / "v.f32")
    data = json.loads((index_dir / "index.json").read_text())
    data["vector_sets"] = {"t": {"provider": "test", "model": "t", "dim": 4, "file": "v.f32"}}
    (index_dir / "index.json").write_text(json.dumps(data))
    assert Index(index_dir).vectors("t").shape == (len(ITEMS), 4)


def test_bundled_script_matches_the_package(index_dir: Path, tmp_path: Path) -> None:
    script = tmp_path / "recommend.py"
    script.write_text(bundle_recommend_py())
    run = subprocess.run(
        [
            sys.executable,
            "-I",
            str(script),
            "show me your soles in stockings",
            "--index",
            str(index_dir),
            "--json",
        ],
        capture_output=True,
        text=True,
        check=True,
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin", "FEATHERLESS_API_KEY": ""},
    )
    bundled = json.loads(run.stdout)
    package = json.loads(Recommender(Index(index_dir)).recommend("show me your soles in stockings").to_json())
    assert bundled == package
    assert "refsrag" not in script.read_text().replace("refs-recommender", "")


def test_decider_failures_keep_the_order_and_trip_the_breaker(
    index_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from refsrag import query

    calls = []

    def boom(self: object, context: str, kind: str, docs: list[str]) -> list[float]:
        calls.append(context)
        raise ValueError("malformed payload")

    monkeypatch.setattr(query.DeciderReranker, "_score", boom)
    monkeypatch.setattr(query.time, "sleep", lambda s: None)
    rec = Recommender(Index(index_dir), featherless_api_key="k", decider_rerank=True,
                      params={"decider": {"url": "http://x", "model": "m"}, "decider_depth": 4, "w_decider": 2.0})  # fmt: skip
    plain = Recommender(Index(index_dir)).recommend("soles in stockings", k=1)
    assert rec.recommend("soles in stockings", k=1).poses[0].id == plain.poses[0].id
    assert rec.decider is not None and rec.decider.failures >= 1
    for n in range(query.DECIDER_BREAKER + 2):
        rec.recommend(f"stockings {n}", k=1)
    tripped = len(calls)
    rec.recommend("stockings again", k=1)
    assert len(calls) == tripped  # breaker open: no more requests


def test_decider_scores_reorder_the_top(index_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from refsrag import query

    def prefer_last(self: object, context: str, kind: str, docs: list[str]) -> list[float]:
        return [float(n) for n in range(len(docs))]  # the lowest-ranked candidate gets the best score

    monkeypatch.setattr(query.DeciderReranker, "_score", prefer_last)
    params = {"decider": {"url": "http://x", "model": "m"}, "decider_depth": 2, "w_decider": 10.0}
    rec = Recommender(Index(index_dir), featherless_api_key="k", decider_rerank=True, params=params)
    plain = Recommender(Index(index_dir)).recommend("soles stockings school girl", k=2, kinds=["outfit"])
    decided = rec.recommend("soles stockings school girl", k=2, kinds=["outfit"])
    assert [p.id for p in decided.outfits] == [p.id for p in plain.outfits][::-1]


def test_cache_dir_falls_back_when_home_is_not_writable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from refsrag import query

    monkeypatch.delenv("REFS_CACHE_DIR", raising=False)
    monkeypatch.setattr(query.Path, "home", staticmethod(lambda: Path("/nonexistent-root-home")))
    assert query.default_cache_dir().parent == Path(query.tempfile.gettempdir())
    monkeypatch.setenv("REFS_CACHE_DIR", str(tmp_path / "c"))
    assert query.default_cache_dir() == tmp_path / "c"
