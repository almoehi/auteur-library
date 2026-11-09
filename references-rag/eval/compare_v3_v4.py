"""Proof that the schema-2 generalisation changed no ranking: v3 (its own bundled schema-1 recommend.py)
and v4 (the package) must return the same ids, scores, `why`, best views and URLs for every eval
context, per kind, with stage 1 + local dense (bge), filtered and with a fixed decider. Offline.

    uv run python eval/compare_v3_v4.py [old_version] [new_version]
"""

from __future__ import annotations

import importlib.util
import json
import sys
from typing import Any

from refsrag import query
from refsrag.eval import read_contexts
from refsrag.index_build import INDEX_ROOT, FixedDecider

BASE = "https://refs.example/base/"
VECTOR_SET = "local:bge-small-en-v1.5"
K = 8
# (name, schema-1 Filters kwargs, schema-2 filters, decider)
VARIANTS: list[tuple[str, dict[str, Any], dict[str, Any], bool]] = [
    ("plain", {}, {}, False),
    ("solo+max_exposure", {"solo": True, "max_exposure": 1}, {"solo": True, "max_exposure": 1}, False),
    ("duo", {"solo": False}, {"solo": False}, False),
    (
        "categories",
        {"outfit_categories": ("lingerie", "sexy"), "pose_series": ("full_body_sexy",)},
        {"outfit_category": ["lingerie", "sexy"], "pose_series": ["full_body_sexy"]},
        False,
    ),
    ("fixed decider", {}, {}, True),
]


def old_picks(result: Any) -> dict[str, list[dict[str, Any]]]:
    out = json.loads(result.to_json())
    return {"outfit": out["outfits"], "pose": out["poses"]}


def comparable(pick: dict[str, Any]) -> dict[str, Any]:
    """The fields both shapes share (schema 1 has no attrs; its outfit picks carry null view fields)."""
    keys = ("id", "kind", "title", "score", "why", "image", "depth", "best_angle", "views")
    return {k: pick[k] for k in keys if pick.get(k) not in (None, [])}


def main(old_version: str, new_version: str) -> int:
    spec = importlib.util.spec_from_file_location("recommend_old", INDEX_ROOT / old_version / "recommend.py")
    assert spec and spec.loader
    old = importlib.util.module_from_spec(spec)
    sys.modules["recommend_old"] = old  # dataclasses resolve their module
    spec.loader.exec_module(old)
    old_rec = old.Recommender(old.Index(INDEX_ROOT / old_version), base_url=BASE, vector_set=VECTOR_SET,
                              rerank=False)  # fmt: skip
    new_rec = query.Recommender(query.Index(INDEX_ROOT / new_version), base_url=BASE, vector_set=VECTOR_SET,
                                rerank=False)  # fmt: skip
    contexts = read_contexts()
    compared = mismatches = 0
    for name, old_filters, new_filters, decider in VARIANTS:
        old_rec.decider = FixedDecider() if decider else None
        new_rec.decider = FixedDecider() if decider else None
        bad = 0
        for ctx in contexts:
            a = old_rec.recommend(ctx.text, k=K, filters=old.Filters(**old_filters))
            b = new_rec.recommend(ctx.text, k=K, filters=new_filters)
            a_picks, b_picks = old_picks(a), b.to_dict()["picks"]
            same = a.concepts == b.concepts and all(
                [comparable(p) for p in a_picks[kind]] == [comparable(p) for p in b_picks[kind]]
                for kind in ("outfit", "pose")
            )
            compared += 1
            if not same:
                bad += 1
                print(f"MISMATCH {name} {ctx.id}")
        mismatches += bad
        print(f"{name:20} {len(contexts)} contexts x 2 kinds, top {K}: {len(contexts) - bad} identical")
    print(f"{old_version} vs {new_version}: {compared} requests, {mismatches} mismatches")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main(*(sys.argv[1:] or ["v3", "v4"])))
