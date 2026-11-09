"""Build the batch items of the vision jobs from the catalog: typed inputs, the cache key and
downscaled image copies (agents read <=768 px images: fewer tokens, same labels)."""

from __future__ import annotations

import hashlib
import os
from collections.abc import Callable
from pathlib import Path
from typing import Final

from PIL import Image
from pydantic import BaseModel, ConfigDict

from refsrag.catalog import Angle, Outfit, Pose, PoseSeries, load_outfits, load_poses, sha256_file
from refsrag.jobs import BatchItem, JobName, item_sha
from refsrag.settings import PROJECT_ROOT, Settings

THUMB_DIR: Final = PROJECT_ROOT / "data" / "thumbs"
THUMB_MAX_SIDE: Final = 768
QA_SHARE: Final = 20  # 1 in 20 items (5%) is labelled twice for the agreement gate


class OutfitInputs(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    image: str  # absolute path of the thumbnail
    category: str
    tags_hint: str  # the library's tags: often incomplete or wrong, the image wins


class PoseInputs(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    series: PoseSeries
    category: str
    solo: bool
    views: dict[Angle, str]  # angle -> absolute path of the thumbnail


def job_items(settings: Settings, job: JobName) -> list[BatchItem]:
    root = settings.require_library_root()
    builders: dict[JobName, Callable[[], list[BatchItem]]] = {
        "outfit_vision": lambda: [outfit_item(root, o, job) for o in load_outfits(root)],
        "pose_vision": lambda: [pose_item(root, p, job) for p in load_poses(root)],
        "qa_outfit": lambda: [outfit_item(root, o, job) for o in load_outfits(root) if in_qa_sample(o.id)],
        "qa_pose": lambda: [pose_item(root, p, job) for p in load_poses(root) if in_qa_sample(p.id)],
    }
    if job == "concept_affinity":
        from refsrag.affinity import affinity_items

        return affinity_items()
    if job not in builders:
        raise ValueError(f"{job}: its items come from `refs lexicon`")
    return builders[job]()


def outfit_item(root: Path, outfit: Outfit, job: JobName) -> BatchItem:
    sha = sha256_file(root / outfit.image)
    inputs = OutfitInputs(
        image=str(thumbnail(root / outfit.image, sha)),
        category=outfit.category,
        tags_hint=" ".join(outfit.tags),
    )
    return BatchItem(
        id=outfit.id,
        sha256=item_sha(job, [sha], inputs.model_dump(exclude={"image"})),
        inputs=inputs.model_dump(),
    )


def pose_item(root: Path, pose: Pose, job: JobName) -> BatchItem:
    shas = {v.angle: sha256_file(root / v.image) for v in pose.views}
    inputs = PoseInputs(
        series=pose.series,
        category=pose.category,
        solo=pose.solo,
        views={v.angle: str(thumbnail(root / v.image, shas[v.angle])) for v in pose.views},
    )
    key_inputs = inputs.model_dump(exclude={"views"}) | {"angles": list(shas)}
    return BatchItem(
        id=pose.id, sha256=item_sha(job, list(shas.values()), key_inputs), inputs=inputs.model_dump()
    )


def in_qa_sample(item_id: str) -> bool:
    return int(hashlib.sha256(item_id.encode()).hexdigest(), 16) % QA_SHARE == 0


def thumbnail(src: Path, sha: str) -> Path:
    """A <=THUMB_MAX_SIDE px copy of ``src``, keyed by its sha256 and the size; written atomically."""
    out = THUMB_DIR / f"{sha}_{THUMB_MAX_SIDE}.png"
    if not out.is_file():
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(out.name + ".tmp")
        with Image.open(src) as im:
            im.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE))
            im.save(tmp, format="PNG", optimize=True)
        os.replace(tmp, out)
    return out
