from __future__ import annotations

from pathlib import Path

import pytest
from conftest import (
    JA_CATEGORY,
    JA_NAME,
    JA_SERIES,
    OUTFIT,
    POSE_CATALOG_HEADER,
    POSE_DEPTH,
    POSE_IMAGE,
    write_catalog,
)

from refsrag.catalog import library_files, load_outfits, load_poses
from refsrag.settings import get_settings
from refsrag.text import NON_ENGLISH


def test_loads_english_only_items(library: Path) -> None:
    (outfit,) = load_outfits(library)
    assert (outfit.id, outfit.category, outfit.tags, outfit.image) == (
        "SPR-0001",
        "spring",
        ("ivory", "knit"),
        OUTFIT,
    )
    (pose,) = load_poses(library)
    assert (pose.id, pose.series, pose.category, pose.solo) == (
        "full_body_sexy/P001",
        "full_body_sexy",
        "standing",
        True,
    )
    assert [(v.angle, v.image, v.depth) for v in pose.views] == [("front", POSE_IMAGE, POSE_DEPTH)]
    assert not NON_ENGLISH.search(repr((outfit, pose)))
    assert not any(ja in repr((outfit, pose)) for ja in (JA_SERIES, JA_CATEGORY, JA_NAME))
    assert list(library_files([outfit], [pose])) == [OUTFIT, POSE_IMAGE, POSE_DEPTH]


def test_views_sorted_by_angle_and_duo_series(library: Path) -> None:
    rows = "".join(f"pair60_P007_{a}.png,duo/from_behind,x,x,P007,x,{a}\n" for a in ("side", "front", "low"))
    write_catalog(library / "pose_pngs/catalog.csv", POSE_CATALOG_HEADER + rows)
    (pose,) = load_poses(library)
    assert (pose.id, pose.series, pose.category, pose.solo) == ("duo/P007", "duo", "from_behind", False)
    assert [v.angle for v in pose.views] == ["front", "low", "side"]


def test_rejects_unknown_angle(library: Path) -> None:
    write_catalog(
        library / "pose_pngs/catalog.csv",
        POSE_CATALOG_HEADER + "f.png,solo/full_body_sexy/standing,x,x,P001,x,top\n",
    )
    with pytest.raises(ValueError, match="unknown angle"):
        load_poses(library)


def test_rejects_duplicate_outfit_ids(library: Path) -> None:
    write_catalog(
        library / "outfits/catalog.csv",
        "file,category,id,tags\nSPR-0001.png,spring,SPR-0001,a\nSPR-0001b.png,spring,SPR-0001,b\n",
    )
    with pytest.raises(ValueError, match="duplicate outfit id"):
        load_outfits(library)


def test_rejects_duplicate_angle_in_pose(library: Path) -> None:
    row = "full_sexy_P001_front.png,solo/full_body_sexy/standing,x,x,P001,x,front\n"
    write_catalog(library / "pose_pngs/catalog.csv", POSE_CATALOG_HEADER + row + row)
    with pytest.raises(ValueError, match="duplicate angle"):
        load_poses(library)


@pytest.mark.library
def test_real_library_catalog() -> None:
    root = get_settings().library_root
    if root is None or not root.is_dir():
        pytest.skip("REFS_LIBRARY_ROOT not available")
    outfits, poses = load_outfits(root), load_poses(root)
    assert (len(outfits), len(poses)) == (1407, 288)
    assert all((root / f).is_file() for f in library_files(outfits, poses))
    assert not NON_ENGLISH.search(repr((outfits, poses)))
