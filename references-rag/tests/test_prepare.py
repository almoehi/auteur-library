from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest
from PIL import Image

from refsrag import prepare
from refsrag.catalog import load_outfits, load_poses


@pytest.fixture(autouse=True)
def _thumbs_in_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(prepare, "THUMB_DIR", tmp_path / "thumbs")


def test_outfit_item_has_thumbnail_and_sha(library: Path) -> None:
    item = prepare.outfit_item(library, load_outfits(library)[0], "outfit_vision")
    assert item.id == "SPR-0001" and len(item.sha256) == 64
    with Image.open(item.inputs["image"]) as im:
        assert max(im.size) <= prepare.THUMB_MAX_SIDE
    assert item.inputs["tags_hint"] == "ivory knit"


def test_pose_item_sha_changes_with_any_view(library: Path) -> None:
    pose = load_poses(library)[0]
    before = prepare.pose_item(library, pose, "pose_vision")
    assert set(before.inputs["views"]) == {"front"}
    Image.new("RGB", (10, 10), (1, 2, 3)).save(library / pose.views[0].image)
    assert prepare.pose_item(library, pose, "pose_vision").sha256 != before.sha256


def test_outfit_sha_covers_every_input_but_paths(library: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    outfit = load_outfits(library)[0]
    base = prepare.outfit_item(library, outfit, "outfit_vision").sha256
    assert prepare.outfit_item(library, replace(outfit, tags=("red",)), "outfit_vision").sha256 != base
    assert prepare.outfit_item(library, replace(outfit, category="sexy"), "outfit_vision").sha256 != base
    assert prepare.outfit_item(library, outfit, "qa_outfit").sha256 != base  # the job is part of the key
    monkeypatch.setattr(prepare, "THUMB_DIR", library / "elsewhere")  # a different path, same key
    assert prepare.outfit_item(library, outfit, "outfit_vision").sha256 == base


def test_qa_sample_is_deterministic_and_about_five_percent() -> None:
    ids = [f"item-{i}" for i in range(4000)]
    picked = [i for i in ids if prepare.in_qa_sample(i)]
    assert picked == [i for i in ids if prepare.in_qa_sample(i)]
    assert 150 < len(picked) < 250
