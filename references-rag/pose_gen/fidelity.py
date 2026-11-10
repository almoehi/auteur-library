"""Pose-fidelity check of the style edit (method c drifts on top-down views: it redraws the library reference
instead of our figures): IoU of the line art's filled silhouette against the mannequin render's silhouette, both from
extract.py's aligned crops. The edit sometimes draws the support (counter) too, so the score is the better of two
references: people only (u2net_human_seg) and people + support (bria-rmbg). Below THRESHOLD = flagged.

  uv run --no-project --with pillow --with numpy --with scipy --with rembg --with onnxruntime \
    python -I fidelity.py <parts dir> [<parts dir> ...]
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import binary_fill_holes

THRESHOLD = 0.6
_SESSIONS: dict[str, object] = {}


def silhouette(path: Path, model: str) -> np.ndarray:
    from rembg import new_session, remove

    if model not in _SESSIONS:
        _SESSIONS[model] = new_session(model)
    return np.asarray(remove(Image.open(path).convert("RGB"), only_mask=True, session=_SESSIONS[model])) > 127


def drawn(path: Path) -> np.ndarray:
    lines = Image.open(path).convert("L").point(lambda v: 255 if v < 160 else 0).filter(ImageFilter.MaxFilter(7))
    return binary_fill_holes(np.asarray(lines) > 0)


def main() -> None:
    for d in map(Path, sys.argv[1:]):
        for man in sorted(d.glob("*_mannequin.png")):
            line = man.with_name(man.name.replace("_mannequin", "_lineart"))
            if not line.exists():
                continue
            b = drawn(line)
            iou = max(
                float((a & b).sum() / max((a | b).sum(), 1))
                for a in (silhouette(man, "u2net_human_seg"), silhouette(man, "bria-rmbg"))
            )
            print(f"{d.parent.name}/{man.name.split('_')[0]}: IoU {iou:.2f} {'OK' if iou >= THRESHOLD else 'FLAG'}")


if __name__ == "__main__":
    main()
