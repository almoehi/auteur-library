"""Applies the approved labels of the generated poses (library_items.json) on top of their `pose_vision` records
(jobs/pose_vision/results.jsonl, written by the labelling job, LABELING.md): `sex_positions` exactly as approved (the
position the pose was BUILT from - the labeller's extra guesses are dropped), the approved title as `name_en`, and
`typical_acts` from the manifest when it names any (else the labeller's stay). Idempotent.

  python3 apply_labels.py
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABELS = HERE.parent / "jobs" / "pose_vision" / "results.jsonl"


def main() -> None:
    items = {it["id"]: it for it in json.loads((HERE / "library_items.json").read_text())["items"]}
    lines, changed = [], 0
    for line in LABELS.read_text().splitlines():
        rec = json.loads(line)
        it = items.get(rec["id"])
        if it:
            new = {**rec, "sex_positions": it["sex_positions"], "name_en": it["title"]}
            if it["typical_acts"]:
                new["typical_acts"] = it["typical_acts"]
            changed += new != rec
            rec = new
        lines.append(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
    missing = set(items) - {json.loads(x)["id"] for x in lines}
    if missing:
        raise SystemExit(f"no pose_vision record for {sorted(missing)}: run the labelling job first (README)")
    LABELS.write_text("\n".join(lines) + "\n")
    print(f"{changed} records updated")


if __name__ == "__main__":
    main()
