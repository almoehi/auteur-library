"""Read-only content lake access: the only module that touches the lake.

The lake is a separate uv project, so its data is read by a small script run in its own environment
(``export_lake``). The split and the text cleaning live here; eval sampling is in ``eval.py``.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from refsrag.settings import Settings

Split = Literal["mine", "heldout"]
HELDOUT_PERCENT = 20

# Data access only; runs inside the lake's environment. argv[1] is the output folder.
_EXPORT_SCRIPT = """
import json, sys
from pathlib import Path
from contentlake.settings import get_settings
from contentlake.views import connect

out = Path(sys.argv[1])
con = connect(get_settings())

def dump(sql):
    cur = con.execute(sql)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]

clips = dump(
    "SELECT clip_id, media_kind, title, description, categories, keywords, popularity, nudity,"
    " published_at FROM silver_iwantclips_clips"
)
cats = dump(
    "SELECT coalesce(name, index_name) AS name, slug, video_count, hottest_rank, description"
    " FROM silver_iwantclips_categories"
)
with (out / "clips.jsonl").open("w") as f:
    for c in clips:
        f.write(json.dumps(c, default=str) + "\\n")
(out / "categories.json").write_text(json.dumps(cats, default=str, indent=1))
"""

_TAG = re.compile(r"<[^>]*>")
_SPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class LakeExport:
    clips_path: Path
    categories_path: Path
    clips: int
    categories: int
    by_media_kind: dict[str, int]
    by_split: dict[str, int]


def split_of(clip_id: str) -> Split:
    """The single split: lexicon mining uses ``mine``, calibration uses ``heldout``."""
    bucket = int.from_bytes(hashlib.sha256(clip_id.encode()).digest()[:8], "big") % 100
    return "heldout" if bucket < HELDOUT_PERCENT else "mine"


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def export_lake(settings: Settings, out_dir: Path) -> LakeExport:
    lake_dir = settings.require_content_lake_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "uv",
            "run",
            "--frozen",
            "--project",
            str(lake_dir),
            "python",
            "-c",
            _EXPORT_SCRIPT,
            str(out_dir.resolve()),
        ],
        cwd=lake_dir,
        check=True,
    )
    clips_path, categories_path = out_dir / "clips.jsonl", out_dir / "categories.json"
    clips = _read_jsonl(clips_path)
    return LakeExport(
        clips_path=clips_path,
        categories_path=categories_path,
        clips=len(clips),
        categories=len(json.loads(categories_path.read_text())),
        by_media_kind=dict(Counter(str(c["media_kind"]) for c in clips)),
        by_split=dict(Counter(split_of(c["clip_id"]) for c in clips)),
    )


def clean_text(s: str | None) -> str:
    """HTML stripped, entities decoded, whitespace collapsed."""
    return _SPACE.sub(" ", html.unescape(_TAG.sub(" ", s or ""))).strip()
