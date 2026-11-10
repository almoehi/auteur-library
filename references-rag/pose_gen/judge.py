"""Vision gate of the new-pose pipeline: judges renders against their pose's catalog position with the relabel
audit's method (`../jobs/relabel_v5/audit.py` blind facts + per-support check, `review.py` structural + support decision).

One deviation, decided by the user: the catalog's `above` is NOT judged where the vertical order is set by sitting /
kneeling / standing at furniture - the pose has a support (`PoseSpec.furniture`) and the blind facts show one person
seated (on the furniture) and the other standing or kneeling (a standing partner at a hip-height edge is level, a
woman kneeling on the floor before a man seated on a bed edge is "neither" to the judge). Everything else blocks.

Second mode, for the VIEWS of an accepted pose (`--same-as <base.png>`): a view is judged against the accepted base
render (human- or gate-accepted) - "does Picture 2 show the same pose as Picture 1 from another camera?" - per fixed
facts, majority of VOTES. This avoids re-judging the catalog definition from viewpoints where it is unreadable
(from behind, top-down) and keeps a human override of a judge false negative for the whole pose.

  set -a; . <video-harness>/video-harness/.env; set +a
  uv run --no-project --with pillow python judge.py <slug> <png> ...                    base renders vs the catalog
  uv run --no-project --with pillow python judge.py <slug> --same-as <base.png> <png> ...  views vs the accepted base
  -> one JSON line per render (PASS = majority of VOTES=3 judgements)
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "jobs" / "relabel_v5"))
import audit  # noqa: E402
import review  # noqa: E402
from poses import CATALOG, POSE_BY_SLUG, PoseSpec  # noqa: E402


def image_parts(path: Path) -> list[dict]:
    im = Image.open(path).convert("RGB")
    im.thumbnail((1024, 1024))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    return [{"type": "image_url", "image_url": {"url": url}}]


def structural(spec: PoseSpec, entry: dict, facts: dict) -> tuple[bool, str]:
    ok, why = review.structural_ok(entry, facts)
    if ok or entry.get("above") is None or not spec.furniture:
        return ok, why
    postures = sorted(str(f.get("posture")) for f in facts.get("figures", []) if isinstance(f, dict))
    relaxed_ok, relaxed_why = review.structural_ok({**entry, "above": None}, facts)
    if relaxed_ok and "seated" in postures and len(postures) == 2 and set(postures) - {"seated"} <= {"standing", "kneeling"}:
        return True, f"{relaxed_why} (above '{facts.get('above')}' not judged: vertical order set by furniture)"
    return ok, why


def judge(spec: PoseSpec, path: Path, api_key: str) -> dict:
    entry = CATALOG[spec.position]
    people_hint = "a solo female figure" if spec.solo else "a duo: a woman and a man"
    images = image_parts(path)
    facts, _ = audit.ask(api_key, audit.BLIND_PROMPT.format(people_hint=people_hint, supports=", ".join(audit.SUPPORTS)), images)
    ans, _ = audit.ask(
        api_key,
        audit.PROMPT.format(
            catalog=audit.catalog_text([entry], include_proposed=True), id=path.stem, series=spec.series, people_hint=people_hint,
            facts=audit.facts_text(facts), tags=spec.position, supports=", ".join(audit.SUPPORTS),
        ),
        images,
    )
    check = next((c for c in ans.get("checks", []) if c.get("position") == spec.position), None)
    s_ok, s_why = structural(spec, entry, facts)
    j_ok, j_why = review.judged(check, entry) if check else (False, "not checked")
    people_ok = facts.get("people") == (1 if spec.solo else 2)
    return {
        "file": path.name, "PASS": bool(s_ok and j_ok and people_ok), "people": facts.get("people"),
        "structural": [s_ok, s_why], "supports": [j_ok, j_why, (check or {}).get("supports")],
        "figures": [(f.get("who"), f.get("posture")) for f in facts.get("figures", []) if isinstance(f, dict)],
        "above": facts.get("above"), "evidence": (check or {}).get("evidence", ""),
    }


VOTES = int(os.environ.get("VOTES", "3"))

SAME_POSE = """Picture 1 is an accepted reference render of a pose of faceless grey mannequins: {pose}
Picture 2 should show the SAME figures in the SAME pose from another camera position (another angle, height or
distance). Ignore the camera, framing, lighting and the background; judge only the bodies.
ONE JSON object, no prose: {{"same_people": true|false (the same number of people, nobody added or missing),
"same_support": true|false (each person rests on the same thing: feet, knees, the surface, the wall),
"same_limbs": true|false (arms and legs placed the same way relative to the body and the partner),
"same_contact": true|false (the same body parts touch each other),
"evidence": "the decisive observation"}}"""


def same_pose(spec: PoseSpec, base: Path, view: Path, api_key: str) -> dict:
    ans, _ = audit.ask(api_key, SAME_POSE.format(pose=spec.pose_text()), [*image_parts(base), *image_parts(view)])
    keys = ("same_people", "same_support", "same_limbs", "same_contact")
    return {"PASS": all(ans.get(k) is True for k in keys), **{k: ans.get(k) for k in keys}, "evidence": ans.get("evidence", "")}


def gate(spec: PoseSpec, path: Path, api_key: str, base: Path | None = None) -> dict:
    """The judge is noisy on single calls (the same render flips between runs), so the gate is a MAJORITY of
    VOTES independent judgements; each vote's details are kept. With `base`, each vote is `same_pose()`."""
    votes = [same_pose(spec, base, path, api_key) if base else judge(spec, path, api_key) for _ in range(VOTES)]
    passed = sum(v["PASS"] for v in votes)
    return {"file": path.name, "PASS": passed * 2 > len(votes), "votes": f"{passed}/{len(votes)}", "details": votes}


def main() -> None:
    spec = POSE_BY_SLUG[sys.argv[1]]
    args = sys.argv[2:]
    base = None
    if args[:1] == ["--same-as"]:
        base, args = Path(args[1]), args[2:]
    key = os.environ["FEATHERLESS_API_KEY"]
    for p in args:
        print(json.dumps(gate(spec, Path(p), key, base)), flush=True)


if __name__ == "__main__":
    main()
