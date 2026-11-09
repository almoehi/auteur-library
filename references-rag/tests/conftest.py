"""Shared fixtures: a tiny fake image library with the real catalog layout (BOM, column names)."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

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
