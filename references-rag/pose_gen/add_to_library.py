"""Puts approved generated poses into the LOCAL library (untracked; never commit images): copies each approved view's
line art and depth into pose_pngs/<folder>/ and pose_depth/<folder>/ as <prefix>_<P-number>_<angle>.png and appends
one row per view to both catalog.csv files (the Japanese columns copied from an existing row of the folder, else
empty: the loader drops them). Idempotent: rows already present are skipped, files are overwritten.

  python3 add_to_library.py <library root (nsfw-poses-references)> <parts root> [library_items.json]
<parts root>/<slug>/parts/<stem>_lineart.png and _depth.png are extract.py's outputs.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
FIELDS = ["file", "folder", "series_ja", "category_ja", "pose_number", "pose_name_ja", "angle"]


def main() -> None:
    library, parts = Path(sys.argv[1]), Path(sys.argv[2])
    items = json.loads((HERE / (sys.argv[3] if len(sys.argv) > 3 else "library_items.json")).read_text())["items"]
    for kind in ("pose_pngs", "pose_depth"):
        catalog = library / kind / "catalog.csv"
        rows = list(csv.DictReader(catalog.open(encoding="utf-8-sig", newline="")))
        have = {(r["folder"], r["file"]) for r in rows}
        ja = {r["folder"]: (r["series_ja"], r["category_ja"]) for r in rows}
        added = 0
        for it in items:
            number = it["id"].split("/")[1]
            series_ja, category_ja = ja.get(it["folder"], ("", ""))
            out_dir = library / kind / it["folder"]
            out_dir.mkdir(parents=True, exist_ok=True)
            for angle, stem in it["views"].items():
                name = f"{it['file_prefix']}_{number}_{angle}.png"
                src = parts / it["slug"] / "parts" / f"{stem}_{'lineart' if kind == 'pose_pngs' else 'depth'}.png"
                im = Image.open(src)
                (im.convert("RGB") if kind == "pose_pngs" else im.convert("L")).save(out_dir / name)
                if (it["folder"], name) not in have:
                    rows.append({"file": name, "folder": it["folder"], "series_ja": series_ja, "category_ja": category_ja,
                                 "pose_number": number, "pose_name_ja": "", "angle": angle})
                    added += 1
        with catalog.open("w", encoding="utf-8-sig", newline="") as fh:  # the catalogs start with a BOM
            w = csv.DictWriter(fh, fieldnames=FIELDS)
            w.writeheader()
            w.writerows(rows)
        print(f"{kind}: {added} rows added, {len(rows)} total")


if __name__ == "__main__":
    main()
