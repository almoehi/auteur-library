"""Shared fixtures: a tiny fake image library with the real catalog layout (BOM, column names), and a
tiny hand-made index of the same catalog."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from refsrag.query import SCHEMA_VERSION

OUTFIT = "outfits/spring/SPR-0001.png"
POSE_IMAGE = "pose_pngs/solo/full_body_sexy/standing/full_sexy_P001_front.png"
POSE_DEPTH = "pose_depth/solo/full_body_sexy/standing/full_sexy_P001_front.png"
POSE_CATALOG_HEADER = "file,folder,series_ja,category_ja,pose_number,pose_name_ja,angle\n"


JA_SERIES = "全身1人・セクシー系"
JA_CATEGORY = "立ち"
JA_NAME = "S字立ち"


def write_png(path: Path, shade: int, size: tuple[int, int] = (40, 60)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (shade, shade, shade)).save(path)


def write_catalog(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8-sig")  # the real catalogs start with a BOM


@pytest.fixture
def library(tmp_path: Path) -> Path:
    """One outfit and one solo pose with a single (front) view; the *_ja columns hold real Japanese text."""
    root = tmp_path / "library"
    write_catalog(
        root / "outfits/catalog.csv", "file,category,id,tags\nSPR-0001.png,spring,SPR-0001,ivory knit\n"
    )
    write_catalog(
        root / "pose_pngs/catalog.csv",
        POSE_CATALOG_HEADER
        + f"full_sexy_P001_front.png,solo/full_body_sexy/standing,{JA_SERIES},{JA_CATEGORY},P001,"
        + f"{JA_NAME},front\n",
    )
    for shade, rel in enumerate((OUTFIT, POSE_IMAGE, POSE_DEPTH)):
        write_png(root / rel, 50 + shade * 50)
    return root


# The catalog descriptor of the hand-made test indexes (index.json "catalog"): the refs kinds and filters.
TEST_CATALOG: dict[str, object] = {
    "key": "refs",
    "title": "Pose and outfit references",
    "description": "Test catalog.",
    "nudity": True,
    "kinds": {
        "outfit": {"label": "Outfits", "description": "an outfit image", "media": "image"},
        "pose": {"label": "Poses", "description": "a pose in views", "media": "views"},
    },
    "filters": [
        {"name": "max_exposure", "kind": "outfit", "field": "exposure", "type": "integer", "op": "lte",
         "min": 0, "max": 3, "description": "skin"},
        {"name": "solo", "kind": "pose", "field": "solo", "type": "boolean", "op": "eq", "description": "solo"},
        {"name": "outfit_category", "kind": "outfit", "field": "category", "type": "string", "op": "in",
         "description": "categories"},
        {"name": "pose_series", "kind": "pose", "field": "series", "type": "string", "op": "in",
         "description": "series"},
    ],
    "result_fields": {"outfit": ["category"], "pose": ["series", "category", "sex_positions"]},
    "decider_context": "an adult clip",
    "decider_guidance": {},
    "max_k": 4,
}  # fmt: skip


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
    {"id": "LNG-1", "kind": "outfit", "title": "Black lace garter set",
     "doc": "black lace bra garter belt stockings heels. Used for: pantyhose stockings, nylons",
     "concepts": {"pantyhose_stockings": 0.9}, "attrs": {"category": "lingerie", "exposure": 3},
     "media": {"image": "library/refs/assets/outfits/lingerie/LNG-1.png"}},
    {"id": "SPR-1", "kind": "outfit", "title": "Pleated skirt and blouse",
     "doc": "white blouse ribbon pleated mini skirt knee socks. Used for: schoolgirl roleplay",
     "concepts": {"schoolgirl": 0.8}, "attrs": {"category": "spring", "exposure": 1},
     "media": {"image": "library/refs/assets/outfits/spring/SPR-1.png"}},
    {"id": "solo/P1", "kind": "pose", "title": "Prone, feet up",
     "doc": "prone on forearms feet raised soles. Used for: foot fetish, soles", "concepts": {"foot_fetish": 0.9},
     "attrs": {"series": "full_body_sexy", "category": "lying", "solo": True, "sex_positions": []},
     "media": {"views": [_view("front", {"chest": 0.8}), _view("low", {"feet_soles": 0.9})]}},
    {"id": "duo/P2", "kind": "pose", "title": "Doggy style",
     "doc": "all fours partner kneeling behind. Positions: doggy style", "concepts": {"doggy": 0.9},
     "attrs": {"series": "duo", "category": "from_behind", "solo": False, "sex_positions": ["doggy style"]},
     "media": {"views": [_view("side", {"butt": 0.9})]}},
]  # fmt: skip


@pytest.fixture
def index_dir(tmp_path: Path) -> Path:
    """A tiny refs index (schema 2): two outfits, a solo pose with two views and a duo pose."""
    index = {
        "schema_version": SCHEMA_VERSION,
        "index_version": "vtest",
        "catalog": TEST_CATALOG,
        "default_base_url": BASE,
        "params": {"bm25_k1": 1.2, "bm25_b": 0.75, "rrf_k": 60, "w_bm25": 1.0, "w_concept": 1.0, "w_dense": 1.0,
                   "w_rerank": 1.0, "candidates": 30, "mmr_lambda": 0.7, "reranker": None,
                   "decider_depth": 12, "w_decider": 2.0},
        "lexicon": {"soles": {"foot_fetish": 1.0}, "stockings": {"pantyhose_stockings": 1.0},
                    "school girl": {"schoolgirl": 1.0}, "doggy style": {"doggy": 1.0}},
        "concepts": {"foot_fetish": {"type": "kink", "description": "feet", "focus": {"feet_soles": 1.0}}},
        "items": ITEMS,
        "vector_sets": {},
        "files": [],
    }  # fmt: skip
    (tmp_path / "index.json").write_text(json.dumps(index))
    return tmp_path
