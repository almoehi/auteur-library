from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from refsrag.labels import OutfitVision, PoseVision

SHA = "d" * 64


def _outfit(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "SXY-0127", "sha256": SHA, "description_en": "A white and red shrine-maiden costume.",
        "garments": ["kimono top"], "colors": ["white"], "materials": ["cotton"],
        "archetypes": {"cosplay_like": 0.9}, "exposure": 2, "accentuated": {"legs": 0.7},
        "footwear": "sandals", "season": "any", "confidence": 0.9,
    }  # fmt: skip
    return base | over


def test_outfit_valid() -> None:
    assert OutfitVision.model_validate(_outfit()).archetypes == {"cosplay_like": 0.9}


@pytest.mark.parametrize(
    "over",
    [
        {"archetypes": {"pirate": 0.5}},  # not a vocabulary term
        {"footwear": "geta"},
        {"exposure": 4},
        {"description_en": "A costume with the label 巫女 on it."},  # non-English text
    ],
)
def test_outfit_rejects(over: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        OutfitVision.model_validate(_outfit(**over))


def test_pose_sex_positions_use_explicit_acts_names() -> None:
    pose: dict[str, Any] = {
        "id": "duo/P013", "sha256": SHA, "name_en": "All fours with partner behind",
        "description_en": "She is on all fours; he kneels behind her.", "support": "all_fours",
        "mood": {"explicit": 0.8}, "views": {"side": {"focus": {"butt": 0.9}, "view": "true profile"}},
        "sex_positions": ["doggy style"], "typical_acts": ["vaginal penetration"], "confidence": 0.8,
    }  # fmt: skip
    assert PoseVision.model_validate(pose).sex_positions == ["doggy style"]
    with pytest.raises(ValidationError):
        PoseVision.model_validate(pose | {"sex_positions": ["doggy"]})
    with pytest.raises(ValidationError):
        PoseVision.model_validate(pose | {"views": {}})
