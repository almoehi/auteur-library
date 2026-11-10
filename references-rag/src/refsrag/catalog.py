"""Load the image library's catalogs into typed, English-only items.

The library's catalog CSVs carry Japanese columns (series, category, pose name). They are dropped
here, on read: a pose's identity and its series / category come from the English folder path plus
its pose number. English pose names come from the vision labelling job, never from the catalog.
"""

from __future__ import annotations

import csv
import hashlib
from collections import Counter, defaultdict
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal, get_args

# `back` (rear view) came with the generated poses (pose_gen/).
Angle = Literal["front", "high", "low", "side", "diag", "back"]
ANGLES: Final[tuple[Angle, ...]] = get_args(Angle)

PoseSeries = Literal["full_body_standard", "full_body_sexy", "upper_body", "duo"]
POSE_SERIES: Final[tuple[PoseSeries, ...]] = get_args(PoseSeries)

OUTFITS_DIR: Final = "outfits"
POSE_IMAGE_DIR: Final = "pose_pngs"
POSE_DEPTH_DIR: Final = "pose_depth"
CATALOG_FILE: Final = "catalog.csv"


@dataclass(frozen=True)
class Outfit:
    id: str  # e.g. "SXY-0001"
    category: str  # spring, summer, autumn, winter, lingerie, party, swimwear, sexy
    tags: tuple[str, ...]  # the library's own tags: a hint only, often incomplete
    image: str  # library path


@dataclass(frozen=True)
class PoseView:
    angle: Angle  # the camera placement the file is named after, not the body's orientation
    image: str  # library path of the line art
    depth: str  # library path of the depth map


@dataclass(frozen=True)
class Pose:
    id: str  # "<series>/<pose number>", e.g. "full_body_sexy/P063"
    series: PoseSeries
    category: str  # English folder name, e.g. "lying", "missionary"
    pose_number: str  # e.g. "P063"
    views: tuple[PoseView, ...]  # in ANGLES order; a few poses lack an angle

    @property
    def solo(self) -> bool:
        return self.series != "duo"


def load_outfits(library_root: Path) -> list[Outfit]:
    rows = _read_csv(library_root / OUTFITS_DIR / CATALOG_FILE)
    outfits = sorted(
        (
            Outfit(
                id=r["id"],
                category=r["category"],
                tags=tuple(r["tags"].split()),
                image=f"{OUTFITS_DIR}/{r['category']}/{r['file']}",
            )
            for r in rows
        ),
        key=lambda o: o.id,
    )
    _reject_duplicates("outfit id", [o.id for o in outfits])
    return outfits


def load_poses(library_root: Path) -> list[Pose]:
    by_pose: dict[tuple[PoseSeries, str, str], list[PoseView]] = defaultdict(list)
    for r in _read_csv(library_root / POSE_IMAGE_DIR / CATALOG_FILE):
        series, category = _series_and_category(r["folder"])
        angle = _angle(r["angle"])
        rel = f"{r['folder']}/{r['file']}"
        by_pose[(series, category, r["pose_number"])].append(
            PoseView(angle=angle, image=f"{POSE_IMAGE_DIR}/{rel}", depth=f"{POSE_DEPTH_DIR}/{rel}")
        )
    poses = [
        Pose(
            id=f"{series}/{number}",
            series=series,
            category=category,
            pose_number=number,
            views=tuple(sorted(views, key=lambda v: ANGLES.index(v.angle))),
        )
        for (series, category, number), views in by_pose.items()
    ]
    _reject_duplicates("pose id (a pose number in two categories of one series)", [p.id for p in poses])
    for p in poses:
        _reject_duplicates(f"angle in pose {p.id}", [v.angle for v in p.views])
    return sorted(poses, key=lambda p: p.id)


def library_files(outfits: list[Outfit], poses: list[Pose]) -> Iterator[str]:
    """Every library path the recommender publishes (``_by_focus`` copies are never included)."""
    for o in outfits:
        yield o.image
    for p in poses:
        for v in p.views:
            yield v.image
            yield v.depth


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _reject_duplicates(what: str, values: list[str]) -> None:
    dupes = sorted(v for v, n in Counter(values).items() if n > 1)
    if dupes:
        raise ValueError(f"duplicate {what}: {dupes}")


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as f:  # the catalogs start with a BOM
        return list(csv.DictReader(f))


def _series_and_category(folder: str) -> tuple[PoseSeries, str]:
    """``solo/full_body_sexy/lying`` -> (full_body_sexy, lying); ``duo/missionary`` -> (duo, missionary)."""
    parts = folder.split("/")
    series = parts[0] if parts[0] == "duo" else parts[1]
    if series not in POSE_SERIES:
        raise ValueError(f"unknown pose series in folder {folder!r}")
    return series, parts[-1]  # checked against POSE_SERIES above


def _angle(value: str) -> Angle:
    if value not in ANGLES:
        raise ValueError(f"unknown angle {value!r}")
    return value  # checked against ANGLES above
