"""The query interface on a tiny hand-made index: ranking, best view, filters, URLs, the result shape,
and that the bundled single-file recommend.py gives the same answer as the package."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from conftest import BASE, ITEMS, TEST_CATALOG

from refsrag.index_build import bundle_recommend_py
from refsrag.query import SCHEMA_VERSION, Index, Recommender


def test_concepts_drive_ranking_and_the_best_view(index_dir: Path) -> None:
    rec = Recommender(Index(index_dir))
    out = rec.recommend("show me your soles in stockings", k=1)
    assert out.concepts == {"foot_fetish": 1.0, "pantyhose_stockings": 1.0}
    assert out.dense.startswith("unavailable")
    assert list(out.picks) == ["outfit", "pose"]  # catalog order
    (outfit,) = out.picks["outfit"]
    (pose,) = out.picks["pose"]
    assert (outfit.id, outfit.image) == ("LNG-1", BASE + "library/refs/assets/outfits/lingerie/LNG-1.png")
    assert outfit.attrs == {"category": "lingerie"}  # result_fields only: no exposure
    assert (pose.id, pose.best_angle) == ("solo/P1", "low")  # the view showing the soles, not the first one
    assert pose.depth == BASE + "library/refs/assets/pose_depth/low.png"
    assert pose.views is not None and [v.angle for v in pose.views] == ["front", "low"]
    assert pose.why[-1] == "best view: low (low view)"
    assert pose.attrs == {"series": "full_body_sexy", "category": "lying", "sex_positions": []}


def test_json_shape_omits_unset_optional_fields(index_dir: Path) -> None:
    out = Recommender(Index(index_dir)).recommend("show me your soles in stockings", k=1).to_dict()
    assert set(out) == {"catalog", "index_version", "context", "concepts", "dense", "picks"}  # no decider
    assert out["catalog"] == "refs"
    outfit, pose = out["picks"]["outfit"][0], out["picks"]["pose"][0]
    assert set(outfit) == {"id", "kind", "title", "score", "why", "image", "attrs"}
    assert set(pose) == set(outfit) | {"depth", "best_angle", "views"}


def test_filters_kinds_and_k(index_dir: Path) -> None:
    rec = Recommender(Index(index_dir))
    duo_only = rec.recommend("doggy style", k=3, kinds=["pose"], filters={"solo": False})
    assert list(duo_only.picks) == ["pose"] and [p.id for p in duo_only.picks["pose"]] == ["duo/P2"]
    covered = rec.recommend("school girl", k=3, kinds=["outfit"], filters={"max_exposure": 1})
    assert [p.id for p in covered.picks["outfit"]] == ["SPR-1"]
    lingerie = rec.recommend("school girl", k=3, filters={"outfit_category": ["lingerie"]})
    assert [p.id for p in lingerie.picks["outfit"]] == ["LNG-1"]
    assert len(lingerie.picks["pose"]) == 2  # a filter leaves the other kinds alone


@pytest.mark.parametrize(
    ("request_", "message"),
    [
        (
            {"filters": {"exposure": 1}},
            "unknown filter 'exposure'; allowed: max_exposure, solo, outfit_category, pose_series",
        ),
        ({"filters": {"max_exposure": "1"}}, "takes integer values"),
        ({"filters": {"max_exposure": True}}, "takes integer values"),
        ({"filters": {"max_exposure": 4}}, "outside 0..3"),
        ({"filters": {"solo": 1}}, "takes boolean values"),
        ({"filters": {"outfit_category": "lingerie"}}, "non-empty list"),
        ({"kinds": ["face"]}, "unknown kind 'face'; allowed: outfit, pose"),
    ],
)
def test_invalid_requests_are_rejected(index_dir: Path, request_: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        Recommender(Index(index_dir)).recommend("x", **request_)


def test_a_new_catalog_needs_no_code(tmp_path: Path) -> None:
    """A catalog with other kinds, media and filters: only the index changes."""
    catalog = {
        "key": "faces", "title": "Faces", "description": "Face references.", "nudity": False,
        "kinds": {"face": {"label": "Faces", "description": "a face", "media": "image"}},
        "filters": [{"name": "min_age", "kind": "face", "field": "age", "type": "integer", "op": "gte",
                     "description": "apparent age"}],
        "result_fields": {"face": ["age"]}, "decider_context": "a portrait", "decider_guidance": {}, "max_k": 2,
    }  # fmt: skip
    items = [
        {"id": f"F{age}", "kind": "face", "title": f"face {age}", "doc": f"smiling face freckles {age}",
         "concepts": {}, "attrs": {"age": age}, "media": {"image": f"library/faces/assets/{age}.png"}}
        for age in (20, 40)
    ]  # fmt: skip
    index = {"schema_version": SCHEMA_VERSION, "index_version": "f1", "catalog": catalog, "default_base_url": BASE,
             "params": {"bm25_k1": 1.2, "bm25_b": 0.75, "rrf_k": 60, "w_bm25": 1.0, "w_concept": 1.0,
                        "w_dense": 1.0, "candidates": 30, "mmr_lambda": 0.7, "reranker": None},
             "lexicon": {}, "concepts": {}, "items": items, "vector_sets": {}, "files": []}  # fmt: skip
    (tmp_path / "index.json").write_text(json.dumps(index))
    out = Recommender(Index(tmp_path)).recommend("smiling freckles", k=2, filters={"min_age": 30})
    assert out.to_dict()["picks"] == {
        "face": [{"id": "F40", "kind": "face", "title": "face 40", "score": out.picks["face"][0].score,
                  "why": [], "image": BASE + "library/faces/assets/40.png", "attrs": {"age": 40}}]
    }  # fmt: skip


def test_base_url_override_and_dense_vectors(index_dir: Path) -> None:
    index = Index(index_dir)
    assert (
        Recommender(index, base_url="https://other.test/x")
        .recommend("soles", k=1)
        .picks["pose"][0]
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


def test_cli_filters_kinds_and_describe(
    index_dir: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from refsrag.query import main

    monkeypatch.delenv("FEATHERLESS_API_KEY", raising=False)
    index = ["--index", str(index_dir)]
    main(["doggy style", *index, "--json", "--kind", "pose", "--filter", "solo=false"])
    assert [p["id"] for p in json.loads(capsys.readouterr().out)["picks"]["pose"]] == ["duo/P2"]
    main(
        [
            "school girl",
            *index,
            "--json",
            "--filter",
            "outfit_category=spring,sexy",
            "--filter",
            "max_exposure=1",
        ]
    )
    assert [p["id"] for p in json.loads(capsys.readouterr().out)["picks"]["outfit"]] == ["SPR-1"]
    main(["--describe", *index])
    assert json.loads(capsys.readouterr().out) == TEST_CATALOG
    for bad in (["--filter", "nope=1"], ["--filter", "solo=maybe"], ["-k", "5"]):
        with pytest.raises(SystemExit):
            main(["x", *index, *bad])


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
    first = rec.recommend("soles in stockings", k=1)
    assert first.picks["pose"][0].id == plain.picks["pose"][0].id
    assert first.decider == "unavailable: the decision model failed"
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
    assert [p.id for p in decided.picks["outfit"]] == [p.id for p in plain.picks["outfit"]][::-1]
    assert decided.decider == "m" and plain.decider is None


def test_decider_state_words_the_catalog_context_and_guidance(index_dir: Path) -> None:
    from dataclasses import replace

    from refsrag.query import decider_state

    catalog = Index(index_dir).catalog
    assert decider_state(catalog, "ctx", "pose", ["a", "b"]) == (
        "Context of an adult clip: ctx\n\nCandidate pose references:\nCandidate 1: a\nCandidate 2: b"
    )
    guided = replace(catalog, decider_guidance={"pose": "Prefer full-body views."})
    assert decider_state(guided, "ctx", "pose", ["a"]).endswith("Candidate 1: a\n\nPrefer full-body views.")


def test_cache_dir_falls_back_when_home_is_not_writable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from refsrag import query

    monkeypatch.delenv("REFS_CACHE_DIR", raising=False)
    monkeypatch.setattr(query.Path, "home", staticmethod(lambda: Path("/nonexistent-root-home")))
    assert query.default_cache_dir().parent == Path(query.tempfile.gettempdir())
    monkeypatch.setenv("REFS_CACHE_DIR", str(tmp_path / "c"))
    assert query.default_cache_dir() == tmp_path / "c"
