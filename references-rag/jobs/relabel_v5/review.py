"""Builds the relabel review sheet (`review.md`, `review.csv`) from the audit's `raw.jsonl`.

Rules (PLAN_POSE_CATALOG_ADOPTION.md 4.6 L1 step 3). A position is SHOWN when (1) its catalog role postures and
`above` map onto the blind facts of call 1 (`structural_ok`, decided here) and (2) every essential support the
judge answered holds (`judged`). A tag that is not shown is dropped; an open-pass candidate that is shown is added
only at confidence >= ADD_MIN; everything else stays.
This only PROPOSES tags - nothing is applied to the index.

  uv run --no-project python review.py --index <index.json.gz>
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ADD_MIN = 0.85
KNOWN = {
    "duo/P036": "seated side by side, tagged scissoring",
    "duo/P031": "sitting astride, tagged reverse cowgirl + face sitting",
    "duo/P010": "sideways across his lap, tagged spooning",
    "full_body_sexy/P080": "reverse tabletop, tagged reverse cowgirl",
    "full_body_sexy/P054": "child's pose, tagged doggy style",
    **{
        f"duo/P0{n}": "man kneeling between a lying woman's legs, tagged kneeling between legs"
        for n in ("04", "20", "22", "26", "47", "59")
    },
}


POSTURE_OF_FACT = {"standing": "standing", "seated": "seated", "kneeling": "kneeling", "lying": "lying"}


def structural_ok(entry: dict[str, Any], facts: dict[str, Any]) -> tuple[bool, str]:
    """Can the catalog's role postures and `above` be mapped onto the BLIND facts? (code, not the model)"""
    figs = {
        f.get("who"): POSTURE_OF_FACT.get(str(f.get("posture")))
        for f in facts.get("figures", [])
        if isinstance(f, dict)
    }
    above = facts.get("above")
    want = entry["postures"]
    two = len(figs) >= 2
    reasons = []
    if two:
        for a, b in (("man", "woman"), ("woman", "man")):
            ok_post = all(want[r] is None or figs.get(who) == want[r] for r, who in (("a", a), ("b", b)))
            ok_above = entry["above"] is None or above == {"a": a, "b": b}[entry["above"]]
            if ok_post and ok_above:
                return True, f"A = {a}, B = {b}"
            reasons.append(f"A={a}/B={b}: postures {want} vs {figs}, above {entry['above']} vs {above}")
        return False, "; ".join(reasons[:1])
    posture = next(iter(figs.values()), None)
    for role in ("a", "b"):
        if entry["roles"].get(role) and (want[role] is None or posture == want[role]):
            return True, f"solo as {role.upper()}"
    return False, f"solo posture {posture} vs {want}"


def judged(check: dict[str, Any], entry: dict[str, Any]) -> tuple[bool, str]:
    """Every essential support the judge answered holds, at least one is answered, and the count matches."""
    answers = check.get("supports") or []
    n = sum(1 for sup in entry["supports"] if sup["essential"])
    if len(answers) != n:
        return False, f"{len(answers)} support answers for {n} essentials"
    answered = [a for a in answers if a is not None]
    if not answered:
        return False, "no support answered"
    failed = [
        entry_sentence
        for entry_sentence, a in zip(
            [sup["sentence"] for sup in entry["supports"] if sup["essential"]], answers, strict=True
        )
        if a is False
    ]
    return (not failed), ("fails: " + "; ".join(failed)) if failed else "all essential supports hold"


def proposal(raw: dict[str, Any], catalog: dict[str, dict[str, Any]]) -> dict[str, Any]:
    ans, facts = raw["answer"], raw.get("facts", {})
    old = list(raw["tags"])
    checks: dict[str, dict[str, Any]] = {}
    for c in ans.get("checks", []):
        if isinstance(c, dict) and c.get("position") in catalog and c["position"] not in checks:
            checks[c["position"]] = c
    kept, dropped, added, evidence, confs = [], [], [], [], []
    for name in old + [n for n in checks if n not in old]:
        entry, c = catalog.get(name), checks.get(name)
        if entry is None:
            kept.append(name)
            evidence.append(f"{name}: not a catalog position (kept)")
            continue
        s_ok, s_why = structural_ok(entry, facts)
        if c is None:
            ok, why = s_ok, "not checked by the judge; " + s_why
        else:
            j_ok, j_why = judged(c, entry)
            ok, why = (
                s_ok and j_ok,
                f"{s_why if not s_ok else ''}{' / ' if not s_ok else ''}{j_why} ({c.get('role_mapping', '')}) {c.get('evidence', '')}",
            )
        conf = float((c or {}).get("confidence") or 0)
        if name in old:
            if ok or (c is None and s_ok):
                kept.append(name)
                evidence.append(f"{name}: keep - {why}")
            else:
                dropped.append(name)
                evidence.append(f"{name}: DROP - {why}")
            confs.append(conf)
        elif ok and conf >= ADD_MIN:
            added.append(name)
            evidence.append(f"{name}: ADD ({conf}) - {why}")
            confs.append(conf)
    figures = "; ".join(
        f"{f.get('who')} {f.get('posture')}" for f in facts.get("figures", []) if isinstance(f, dict)
    )
    return {
        "old": old,
        "proposed": kept + added,
        "dropped": dropped,
        "added": added,
        "fits": [
            f"{c.get('position')} ({c.get('confidence')})"
            for c in ans.get("checks", [])
            if isinstance(c, dict) and c.get("origin") == "candidate"
        ],
        "people": facts.get("people"),
        "support": facts.get("support"),
        "description": f"[{figures}; above: {facts.get('above')}] {facts.get('description', '')}",
        "evidence": evidence,
        "confidence": round(min(confs), 2) if confs else None,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", required=True, type=Path)
    args = ap.parse_args()
    catalog = {
        e["name"]: e
        for e in json.loads((HERE / "pose_catalog.json").read_text())["entries"]
        if e["content"] == "nsfw" and not e.get("proposed")  # proposed: not the server's yet
    }
    with gzip.open(args.index) as fh:
        items = {i["id"]: i for i in json.load(fh)["items"] if i["kind"] == "pose"}
    old_support = {}
    for line in (HERE.parent / "pose_vision" / "results.jsonl").read_text().splitlines():
        rec = json.loads(line)
        old_support[rec["id"]] = rec.get("support")
    raws: dict[str, dict[str, Any]] = {}
    for line in (HERE / "raw.jsonl").read_text().splitlines():
        rec = json.loads(line)
        if "answer" in rec and "facts" in rec:
            raws[rec["id"]] = rec
    rows = []
    for pid, item in items.items():
        if pid not in raws:
            rows.append({"id": pid, "title": item["title"], "status": "not audited"})
            continue
        p = proposal(raws[pid], catalog)
        solo = item["attrs"]["solo"]
        flags = []
        if p["dropped"] or p["added"]:
            flags.append("tags")
        if p["people"] not in (None, 1 if solo else 2):
            flags.append(f"people={p['people']} but solo={solo}")
        if p["support"] != old_support.get(pid):
            flags.append("support")
        rows.append(
            {
                "id": pid,
                "title": item["title"],
                "status": "audited",
                "solo": solo,
                "old_support": old_support.get(pid),
                **p,
                "flags": flags,
            }
        )
    audited = [r for r in rows if r["status"] == "audited"]
    changed = [r for r in audited if r["dropped"] or r["added"]]
    n_dropped = sum(len(r["dropped"]) for r in audited)
    n_added = sum(len(r["added"]) for r in audited)

    with (HERE / "review.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(
            [
                "id",
                "title",
                "solo",
                "old_tags",
                "proposed_tags",
                "dropped",
                "added",
                "open_pass_fits",
                "confidence",
                "old_support",
                "new_support",
                "people",
                "flags",
                "known_case",
                "description",
                "evidence",
            ]
        )
        for r in rows:
            if r["status"] != "audited":
                w.writerow(
                    [
                        r["id"],
                        r["title"],
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        "not audited",
                        KNOWN.get(r["id"], ""),
                        "",
                        "",
                    ]
                )
                continue
            w.writerow(
                [
                    r["id"],
                    r["title"],
                    r["solo"],
                    "; ".join(r["old"]),
                    "; ".join(r["proposed"]),
                    "; ".join(r["dropped"]),
                    "; ".join(r["added"]),
                    "; ".join(r["fits"]),
                    r["confidence"],
                    r["old_support"],
                    r["support"],
                    r["people"],
                    "; ".join(r["flags"]),
                    KNOWN.get(r["id"], ""),
                    r["description"],
                    " | ".join(r["evidence"]),
                ]
            )

    def esc(s: Any) -> str:
        return str(s).replace("|", "/").replace("\n", " ")

    md = [
        "# Relabel audit v5 - review sheet",
        "",
        "PLAN_POSE_CATALOG_ADOPTION.md 4.6 L1. Proposals only: nothing is applied to the index or published.",
        "",
        "- Authority: `pose_catalog.json` (exported from video-harness `src/design/pose-catalog.ts` by `export_pose_catalog.mts`).",
        f"- Judge: `{next(iter(raws.values()))['model'] if raws else '?'}` (Featherless), front + diag + side line art per pose, "
        f"two calls per pose (`audit.py`); cost ${sum(r.get('cost', 0) for r in raws.values()):.2f}.",
        "- Rule (decided in code, `review.py`): a position is shown when its catalog postures / `above` map onto the "
        "BLIND facts (call 1, no tags shown) AND every essential support the judge answered holds (call 2). A tag "
        f"not shown is dropped; an open-pass candidate shown is added only at confidence >= {ADD_MIN}.",
        f"- Audited {len(audited)} / {len(rows)} poses. Tagged before: {sum(1 for r in audited if r['old'])}; "
        f"after: {sum(1 for r in audited if r['proposed'])}.",
        f"- Changed poses: {len(changed)}; tags dropped: {n_dropped}; tags added: {n_added} "
        f"({sum(len(r['added']) for r in audited if r['solo'])} of them on SOLO figures, which only hold one role of a "
        "position - review those adds with care; the plan tags a solo only when it clearly mimics the position).",
        f"- Support differs from pose_vision: {sum(1 for r in audited if 'support' in r['flags'])}; "
        f"people count differs from `solo`: {sum(1 for r in audited if any(f.startswith('people') for f in r['flags']))}.",
        "",
        "**Status: APPLIED.** The full result (every DROP and every ADD; the `proposed` column) is applied to "
        "`jobs/pose_vision/results.jsonl` by `apply_review.py`; exact diff and per-position counts: `applied.md`.",
        "",
        "## Known cases",
        "",
        "| id | expected | old | proposed | confidence | evidence |",
        "|---|---|---|---|---|---|",
    ]
    by_id = {r["id"]: r for r in rows}
    for pid, why in KNOWN.items():
        r = by_id.get(pid)
        if not r or r["status"] != "audited":
            md.append(f"| {pid} | {why} | | not audited | | |")
            continue
        md.append(
            f"| {pid} | {esc(why)} | {esc(', '.join(r['old']))} | **{esc(', '.join(r['proposed']) or '-')}** | "
            f"{r['confidence']} | {esc(' / '.join(r['evidence']))} |"
        )
    md += [
        "",
        "## All tag changes",
        "",
        "| id | title | old | proposed | conf | evidence |",
        "|---|---|---|---|---|---|",
    ]
    for r in changed:
        md.append(
            f"| {r['id']} | {esc(r['title'])} | {esc(', '.join(r['old']) or '-')} | **{esc(', '.join(r['proposed']) or '-')}** | "
            f"{r['confidence']} | {esc(' / '.join(r['evidence']))} |"
        )
    md += [
        "",
        "## Support / people-count disagreements (informational)",
        "",
        "| id | title | old support | new | people | solo |",
        "|---|---|---|---|---|---|",
    ]
    for r in audited:
        if "support" in r["flags"] or any(f.startswith("people") for f in r["flags"]):
            md.append(
                f"| {r['id']} | {esc(r['title'])} | {r['old_support']} | {r['support']} | {r['people']} | {r['solo']} |"
            )
    (HERE / "review.md").write_text("\n".join(md) + "\n")
    print(f"audited {len(audited)}, changed {len(changed)}, dropped {n_dropped}, added {n_added}")


if __name__ == "__main__":
    main()
