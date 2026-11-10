"""Pose-fidelity check of the style edit (method c can drift: on a top-down view it once redrew the library
reference instead of our figures): IoU of the line art's filled figure silhouette against the people silhouette of
the mannequin render, both from extract.py's aligned crops. A view below THRESHOLD is flagged for redo / review.

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
_SESSION = None


def people(path: Path) -> np.ndarray:
    from rembg import new_session, remove

    global _SESSION
    if _SESSION is None:
        _SESSION = new_session("u2net_human_seg")
    return np.asarray(remove(Image.open(path).convert("RGB"), only_mask=True, session=_SESSION)) > 127


def drawn(path: Path) -> np.ndarray:
    lines = Image.open(path).convert("L").point(lambda v: 255 if v < 160 else 0).filter(ImageFilter.MaxFilter(7))
    return binary_fill_holes(np.asarray(lines) > 0)


def main() -> None:
    for d in map(Path, sys.argv[1:]):
        for man in sorted(d.glob("*_mannequin.png")):
            line = man.with_name(man.name.replace("_mannequin", "_lineart"))
            if not line.exists():
                continue
            a, b = people(man), drawn(line)
            iou = float((a & b).sum() / max((a | b).sum(), 1))
            print(f"{d.parent.name}/{man.name.split('_')[0]}: IoU {iou:.2f} {'OK' if iou >= THRESHOLD else 'FLAG'}")


if __name__ == "__main__":
    main()
