"""Applies the relabel audit's result (review.csv `proposed_tags` = the kept tags plus the open-pass additions,
i.e. every removal AND every addition of review.py's rule) to the pose labels the index build reads
(`jobs/pose_vision/results.jsonl` `sex_positions`). Idempotent: a re-run changes nothing and keeps the
`applied.md` of the run that applied it (the exact per-pose diff and the per-position counts before / after).

  uv run --no-project python apply_review.py
"""

from __future__ import annotations

import csv
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABELS = HERE.parent / "pose_vision" / "results.jsonl"


def main() -> None:
    rows = {r["id"]: r for r in csv.DictReader((HERE / "review.csv").open()) if r["flags"] != "not audited"}
    lines, diff = [], []
    before_counts, after_counts = Counter(), Counter()
    tagged_before = tagged_after = 0
    for line in LABELS.read_text().splitlines():
        rec = json.loads(line)
        old = list(rec["sex_positions"])
        row = rows.get(rec["id"])
        new = [t for t in row["proposed_tags"].split("; ") if t] if row else old
        before_counts.update(old)
        after_counts.update(new)
        tagged_before += bool(old)
        tagged_after += bool(new)
        if new != old:
            rec["sex_positions"] = new
            diff.append(
                (rec["id"], old, new, [t for t in old if t not in new], [t for t in new if t not in old])
            )
        lines.append(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
    if not diff:
        print("nothing to apply: labels already match review.csv (applied.md kept)")
        return
    LABELS.write_text("\n".join(lines) + "\n")
    md = [
        "# Relabel v5 - applied tags",
        "",
        f"{len(diff)} poses changed in `jobs/pose_vision/results.jsonl`: "
        f"{sum(len(d[3]) for d in diff)} tags removed, {sum(len(d[4]) for d in diff)} added. "
        f"Tagged poses {tagged_before} -> {tagged_after}.",
        "",
        "## Per position",
        "",
        "| position | before | after |",
        "|---|---|---|",
    ]
    for name in sorted(set(before_counts) | set(after_counts), key=lambda n: (-after_counts[n], n)):
        md.append(f"| {name} | {before_counts[name]} | {after_counts[name]} |")
    md += ["", "## Per pose", "", "| id | before | after | removed | added |", "|---|---|---|---|---|"]
    md += [
        f"| {i} | {', '.join(b) or '-'} | {', '.join(a) or '-'} | {', '.join(r) or '-'} | {', '.join(ad) or '-'} |"
        for i, b, a, r, ad in diff
    ]
    (HERE / "applied.md").write_text("\n".join(md) + "\n")
    print(
        f"{len(diff)} poses; removed {sum(len(d[3]) for d in diff)}, added {sum(len(d[4]) for d in diff)}; "
        f"tagged {tagged_before} -> {tagged_after}"
    )


if __name__ == "__main__":
    main()
