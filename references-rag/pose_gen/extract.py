"""Library-style line art + depth of one pose view (style experiment winners, see README):

- LINE ART = the `lineart` edit job's output (qwen_image_multi_edit: Picture 1 = the mannequin render, Picture 2 =
  a library line-art sample; it redraws the figures in the library's mannequin-construction style, pose kept),
  thresholded to clean dark lines on white.
  `<stem>=<render>,plain` instead extracts a PLAIN line art from the render (controlnet_aux lineart, people only):
  the fallback for a view the style edit cannot do - top-down views, where it redraws the library reference.
- DEPTH = Depth Anything V2 (small) of the mannequin render: the figures AND their support (bria-rmbg mask, which
  keeps a counter / bed / wall panel) normalised to 0.5..1.0 (white = near), composited over the library's
  background (measured on 12 library samples: ~0.2 flat over the upper half, rising to ~0.5 at the bottom edge).

Both are cropped by the SAME box (figures + support, 6% margin, widened to 3:4) and scaled to 900x1200 like the
library. Host-side only.

  uv run --no-project --with transformers --with torch --with pillow --with numpy --with rembg --with onnxruntime \
    [--with controlnet_aux] python -I extract.py <out dir> <stem>=<mannequin.png>[,<lineart.png>|,plain] ...
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = (900, 1200)
_DEPTH = None
_SEG = None


def depth_model():
    global _DEPTH
    if _DEPTH is None:
        from transformers import pipeline

        _DEPTH = pipeline("depth-estimation", model="depth-anything/Depth-Anything-V2-Small-hf")
    return _DEPTH


def support_mask(im: Image.Image) -> np.ndarray:
    """Figures AND their support as 0..1 (bria-rmbg; birefnet / u2net drop the furniture)."""
    global _SEG
    from rembg import new_session, remove

    if _SEG is None:
        _SEG = new_session("bria-rmbg")
    return np.asarray(remove(im, only_mask=True, session=_SEG).convert("L"), dtype=np.float32) / 255.0


def crop_box(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask > 0.5)
    if len(xs) == 0:
        return 0, 0, mask.shape[1], mask.shape[0]
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    w, h = (x1 - x0) * 1.12, (y1 - y0) * 1.12
    w, h = max(w, h * 3 / 4), max(h, w * 4 / 3)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return int(cx - w / 2), int(cy - h / 2), int(cx + w / 2), int(cy + h / 2)


def crop(im: Image.Image, box: tuple[int, int, int, int], fill: tuple[int, ...] | int) -> Image.Image:
    canvas = Image.new(im.mode, (box[2] - box[0], box[3] - box[1]), fill)
    canvas.paste(im, (-box[0], -box[1]))  # pads with `fill` where the box leaves the picture
    return canvas.resize(SIZE, Image.LANCZOS)


def library_background(h: int, w: int) -> np.ndarray:
    y = np.linspace(0, 1, h)[:, None]
    return np.repeat(0.2 + 0.3 * np.clip((y - 0.5) / 0.5, 0, 1) ** 1.7, w, axis=1)


def with_near_support(d: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """bria-rmbg keeps a counter or a bed but drops a large flat wall panel as background. Add every pixel ABOVE the
    feet line that is at least as near as the farthest 10% of the figures + support: the panel, never the studio
    backdrop (far) or the floor in front of the feet (below the line)."""
    ys = np.nonzero(mask.max(axis=1) > 0.5)[0]
    if len(ys) == 0:
        return mask
    feet = int(ys.max() - 0.04 * mask.shape[0])
    near = d >= np.percentile(d[mask >= 0.5], 10)
    near[feet:] = False
    # Only near regions TOUCHING the figures / support (a wall she is pressed against): stray bands at the frame
    # edges (depth artefacts of the crop padding) are dropped.
    from scipy.ndimage import binary_dilation, label

    regions, n = label(near)
    touching = set(np.unique(regions[binary_dilation(mask >= 0.5, iterations=6)])) - {0}
    keep = np.isin(regions, list(touching)) if n and touching else np.zeros_like(near)
    return np.maximum(mask, keep.astype(np.float32))


def library_depth(src: Image.Image, mask: np.ndarray) -> Image.Image:
    d = depth_model()(src)["predicted_depth"].squeeze().float().cpu().numpy()
    d = np.asarray(Image.fromarray(d).resize(src.size, Image.BICUBIC), dtype=np.float32)
    mask = with_near_support(d, mask)
    fg = d[mask >= 0.5]
    lo, hi = np.percentile(fg, 1), np.percentile(fg, 99.7)
    near = 0.5 + 0.5 * np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1)
    out = library_background(*d.shape) * (1 - mask) + near * mask
    return Image.fromarray((out * 255).astype(np.uint8))


def clean_lines(im: Image.Image) -> Image.Image:
    g = np.asarray(im.convert("L"), dtype=np.float32) / 255.0
    g = np.clip((g - 0.35) / 0.5, 0, 1)  # paper to pure white, lines stay dark and anti-aliased
    return Image.fromarray((g * 255).astype(np.uint8))


def plain_lineart(man: Image.Image) -> Image.Image:
    """Plain line art (not the library style): controlnet_aux lineart, inverted, people only (u2net_human_seg)."""
    from controlnet_aux import LineartDetector
    from rembg import new_session, remove

    detector = LineartDetector.from_pretrained("lllyasviel/Annotators")
    la = np.asarray(detector(man, coarse=False, detect_resolution=1024, image_resolution=1200).convert("L").resize(SIZE),
                    dtype=np.float32) / 255.0
    people = np.asarray(remove(man, only_mask=True, session=new_session("u2net_human_seg")).convert("L"),
                        dtype=np.float32) / 255.0
    lines = np.clip((la * people - 0.12) / 0.5, 0, 1)
    return Image.fromarray(((1 - lines) * 255).astype(np.uint8))


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for arg in sys.argv[2:]:
        stem, files = arg.split("=", 1)
        mannequin_path, *rest = files.split(",")
        src = Image.open(mannequin_path).convert("RGB")
        box = crop_box(support_mask(src))
        man = crop(src, box, src.getpixel((2, 2)))
        man.save(out / f"{stem}_mannequin.png")
        mask = support_mask(man)
        library_depth(man, mask).save(out / f"{stem}_depth.png")
        if rest and rest[0] == "plain":
            plain_lineart(man).save(out / f"{stem}_lineart.png")
        elif rest:
            line = Image.open(rest[0]).convert("RGB").resize(src.size, Image.LANCZOS)
            clean_lines(crop(line, box, (255, 255, 255))).save(out / f"{stem}_lineart.png")
        print(f"{stem}: done", flush=True)


if __name__ == "__main__":
    main()
