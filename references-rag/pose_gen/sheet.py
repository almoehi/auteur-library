"""Contact sheet of one new pose for review: one row per view (mannequin, line art, depth) + a library row for style.

uv run --no-project --with pillow python -I sheet.py <rows.json> <parts dir> <out.png> "<title>"
rows.json: [{"label": ..., "method": ..., "stem": <parts/<stem>_{mannequin,lineart,depth}.png>}], plus
           {"label": "library ...", "method": ..., "lineart": <png>, "depth": <png>}; a row with neither stem nor
           lineart is a view that could not be made (its method text says why)
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CELL = (360, 480)
LABEL_W = 230
PAD = 8


def font(size: int) -> ImageFont.ImageFont:
    for f in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def cell(path: Path | None) -> Image.Image:
    if path is None or not path.exists():
        im = Image.new("RGB", CELL, (235, 235, 235))
        ImageDraw.Draw(im).text((20, CELL[1] // 2), "-", fill=(120, 120, 120), font=font(28))
        return im
    im = Image.open(path).convert("RGB")
    im.thumbnail(CELL, Image.LANCZOS)
    canvas = Image.new("RGB", CELL, (255, 255, 255))
    canvas.paste(im, ((CELL[0] - im.width) // 2, (CELL[1] - im.height) // 2))
    return canvas


def main() -> None:
    rows = json.loads(Path(sys.argv[1]).read_text())
    parts, out, title = Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
    width = LABEL_W + 3 * (CELL[0] + PAD) + PAD
    header = 80
    height = header + len(rows) * (CELL[1] + PAD) + PAD
    sheet = Image.new("RGB", (width, height), (250, 250, 250))
    draw = ImageDraw.Draw(sheet)
    draw.text((PAD, 12), title, fill=(0, 0, 0), font=font(24))
    for i, title in enumerate(("mannequin", "line art", "depth (white = near)")):
        draw.text((LABEL_W + PAD + i * (CELL[0] + PAD), 50), title, fill=(60, 60, 60), font=font(18))
    for r, row in enumerate(rows):
        y = header + r * (CELL[1] + PAD)
        draw.text((PAD, y + 10), row["label"], fill=(0, 0, 0), font=font(22))
        words, line, ly = row.get("method", "").split(), "", y + 44
        for w in words:  # wrap the method text into the label column
            if draw.textlength(f"{line} {w}", font=font(15)) > LABEL_W - 2 * PAD:
                draw.text((PAD, ly), line, fill=(70, 70, 70), font=font(15))
                line, ly = w, ly + 19
            else:
                line = f"{line} {w}".strip()
        draw.text((PAD, ly), line, fill=(70, 70, 70), font=font(15))
        if "stem" in row:
            paths = [parts / f"{row['stem']}_{k}.png" for k in ("mannequin", "lineart", "depth")]
        elif "lineart" in row:
            paths = [None, Path(row["lineart"]), Path(row["depth"])]
        else:  # a view that could not be made: only its note
            paths = [None, None, None]
        for c, p in enumerate(paths):
            sheet.paste(cell(p), (LABEL_W + PAD + c * (CELL[0] + PAD), y))
    sheet.save(out)
    print(out, sheet.size)


if __name__ == "__main__":
    main()
