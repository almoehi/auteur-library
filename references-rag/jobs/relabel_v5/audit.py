"""Relabel audit v5 (PLAN_POSE_CATALOG_ADOPTION.md 4.6 L1): checks every pose's `sex_positions` against the
server pose catalog (`pose_catalog.json`, exported by `export_pose_catalog.mts` - the one authority).

Per pose TWO vision calls (Featherless, the NSFW templates' judge model), each seeing the front view plus the
diag and side views of the line art:
  1. BLIND facts - no tags, no catalog (a model shown the tags anchors on them): per figure its posture in the
     catalog's own posture terms, who is above, the female figure's support, the people count;
  2. CHECK - with the catalog and the blind facts: up to 3 candidate positions (open pass), then per tagged AND
     candidate position the role mapping and a true / false / null per numbered ESSENTIAL support (limb by limb,
     the server's methodology).
`review.py`, not the model, decides whether a position is shown: its catalog postures / `above` must map onto
the blind facts AND every answered essential support must hold.
Raw answers go to `raw.jsonl` (resumable: a pose already answered is skipped); `review.py` turns them into
`review.md` / `review.csv`. Nothing here touches the index.

Run (credentials from the environment, never printed):
  set -a; . <video-harness>/video-harness/.env; set +a
  uv run --no-project --with pillow python audit.py --index <index.json.gz> --library <nsfw-poses-references> [--only ID ...]
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import gzip
import io
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image

HERE = Path(__file__).resolve().parent
ENDPOINT = "https://api.featherless.ai/v1/chat/completions"
MODEL = "huihui-ai/Huihui-Qwen3.6-27B-abliterated"  # judge-vision of the NSFW workspace templates
VIEWS = ("front", "diag", "side")  # front first; the others disambiguate line art
MAX_SIDE = 768
ASSET_PREFIX = "library/refs/assets/"
SUPPORTS = (
    "standing", "sitting", "kneeling", "all_fours", "lying_back", "lying_front",
    "lying_side", "squatting", "bridge", "bent_over",
)
_lock = threading.Lock()


def catalog_text(entries: list[dict[str, Any]]) -> str:
    """The NSFW positions with their roles, postures, who is above and their NUMBERED essential supports."""
    lines = []
    for e in entries:
        if e["content"] != "nsfw":
            continue
        above = {"a": "person A is above", "b": "person B is above"}.get(e["above"] or "", "neither is above")
        essentials = " ".join(f"({n}) {s['sentence']}." for n, s in enumerate(essential_supports(e), 1))
        lines.append(
            f"- **{e['name']}**: {e['arrangement']}. A = {e['roles']['a']} (posture: {e['postures']['a'] or 'any'}), "
            f"B = {e['roles']['b']} (posture: {e['postures']['b'] or 'any'}); {above}. Essential: {essentials}"
        )
    return "\n".join(lines)


def essential_supports(entry: dict[str, Any]) -> list[dict[str, Any]]:
    return [s for s in entry["supports"] if s["essential"]]


PROMPT = """You audit the labels of a pose reference library for an adult-content production tool. The pictures are
faceless mannequin line drawings of adults (several camera views of ONE pose): a solo female figure, or a duo
(a female and a male figure). The view names are camera placements and some are mislabelled - judge the bodies.

A position name means exactly what the catalog below defines - the arrangement, the role of each person, their
postures, who is above, and its numbered ESSENTIAL supports, limb by limb - not what the name suggests in
everyday language. Roles are abstract (person A / person B); either figure may play either role. A solo figure
can only hold ONE role of a position (the partner is absent) - say which.

## Catalog
{catalog}

## This pose
Library id {id}, series {series}, {people_hint}. Current tags: {tags}.

## Facts from an earlier careful look at the same pictures
{facts}

## Task
1. Describe precisely what each body does: what carries the weight (feet, knees, buttocks, back, hands, forearms),
   where the arms and legs are, which way each torso faces, who is above / behind / between whom.
2. Name up to 3 catalog positions that could fit ("candidates") - possibly none for an everyday pose.
3. Check EVERY current tag and EVERY candidate support by support: map the roles to the figures, then for each
   numbered essential support of that position answer true only if the picture clearly shows exactly that
   (for a solo figure: answer only the supports about her own role's body; null for supports about the absent
   partner). Be strict: "on all fours" needs the weight on the hands with straight arms AND on the knees;
   "facing each other" needs the torsos to face each other; "between the knees" needs the knees on either side.

## Answer
ONE JSON object, no prose, no code fence:
{{"people": 1 or 2,
 "description": "the step-1 description, 1-2 sentences",
 "support": the female figure's support, one of {supports},
 "checks": [{{"position": "<name>", "origin": "tag" or "candidate",
    "role_mapping": "A = the man|the woman|the figure|absent, B = ...",
    "postures_ok": true|false, "above_ok": true|false,
    "supports": [true|false|null, ... one per numbered essential support, in order],
    "evidence": "the decisive observation", "confidence": 0..1}}]}}
Confidence 0.9+ only when the drawing is unambiguous."""


BLIND_PROMPT = """These pictures are several camera views of ONE pose of faceless mannequin line drawings of
adults ({people_hint}). The view names are camera placements and some are mislabelled - judge the bodies.
Describe the bodies precisely; do not name sex positions.

Posture of each figure, exactly one of:
- standing: upright on the feet, the legs carry the weight;
- seated: the hips / buttocks rest on a surface or on the partner (sitting on a seat, a lap, astride a partner);
- kneeling: the knees carry the weight with the hips raised off the heels (kneeling upright, on all fours);
- lying: the torso lies on a surface (on the back, the front or the side);
- squatting: on the feet with the hips low near the heels;
- other: none of these (say what in the detail).

ONE JSON object, no prose, no code fence:
{{"people": 1 or 2,
 "figures": [{{"who": "woman" or "man", "posture": "<one of the above>",
   "detail": "what carries the weight, where the arms and legs are, which way the torso faces"}}],
 "above": "woman" | "man" | "neither" (whose body is over the other's: on top of, astride, on the lap, standing over a lower one),
 "support": the woman's support, one of {supports},
 "description": "1-2 sentences: who is where relative to whom (behind, between the legs, side by side, facing)"}}"""


def facts_text(facts: dict[str, Any]) -> str:
    figs = "; ".join(f"the {f.get('who')}: {f.get('posture')} ({f.get('detail')})" for f in facts.get("figures", []))
    return f"{figs}. Above: {facts.get('above')}. {facts.get('description', '')}"


def load_image(path: Path) -> str:
    im = Image.open(path).convert("RGB")
    im.thumbnail((MAX_SIDE, MAX_SIDE))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def call(api_key: str, content: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
        "max_tokens": 3500,
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    delay = 10.0
    for attempt in range(8):
        req = urllib.request.Request(ENDPOINT, data=body, headers={
            "Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read())
            if "choices" not in data:  # e.g. "temporarily at capacity", answered with HTTP 200
                if attempt < 7:
                    print(f"  no choices (retry in {delay:.0f}s): {json.dumps(data)[:160]}", file=sys.stderr)
                    time.sleep(delay)
                    delay = min(delay * 1.6, 90)
                    continue
                raise RuntimeError(f"no choices: {json.dumps(data)[:300]}")
            return data["choices"][0]["message"]["content"] or "", data.get("usage", {})
        except urllib.error.HTTPError as err:
            msg = err.read()[:300].decode(errors="replace")
            if err.code in (429, 500, 502, 503, 504) and attempt < 7:
                print(f"  http {err.code} (retry in {delay:.0f}s): {msg}", file=sys.stderr)
                time.sleep(delay)
                delay = min(delay * 1.6, 90)
                continue
            raise RuntimeError(f"http {err.code}: {msg}") from err
        except (urllib.error.URLError, TimeoutError) as err:
            if attempt < 7:
                time.sleep(delay)
                continue
            raise RuntimeError(str(err)) from err
    raise RuntimeError("retries exhausted")


def parse_json(text: str) -> dict[str, Any]:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    start, end = text.find("{"), text.rfind("}")
    return json.loads(text[start:end + 1])


def ask(api_key: str, text: str, images: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    """One call; up to 3 attempts at a parseable JSON answer. Returns (answer, usage)."""
    last = ""
    for _ in range(3):
        reply, usage = call(api_key, [{"type": "text", "text": text}, *images])
        try:
            return parse_json(reply), usage
        except (ValueError, json.JSONDecodeError) as err:
            last = f"{err}: {reply[:200]}"
    raise RuntimeError(f"unparseable answer: {last}")


def audit(item: dict[str, Any], library: Path, catalog: str, api_key: str) -> dict[str, Any]:
    attrs = item["attrs"]
    tags = list(attrs.get("sex_positions") or [])
    views = {v["angle"]: v["image"] for v in item["media"]["views"]}
    images: list[dict[str, Any]] = []
    for angle in VIEWS:
        if angle in views:
            images.append({"type": "text", "text": f"View '{angle}':"})
            images.append({"type": "image_url", "image_url": {
                "url": load_image(library / views[angle].removeprefix(ASSET_PREFIX))}})
    people_hint = "a duo: a woman and a man" if not attrs["solo"] else "a solo female figure"
    facts, usage1 = ask(api_key, BLIND_PROMPT.format(people_hint=people_hint, supports=", ".join(SUPPORTS)), images)
    answer, usage2 = ask(api_key, PROMPT.format(
        catalog=catalog, id=item["id"], series=attrs["series"], people_hint=people_hint, facts=facts_text(facts),
        tags=", ".join(tags) if tags else "(none)", supports=", ".join(SUPPORTS)), images)
    cost = float(usage1.get("cost") or 0) + float(usage2.get("cost") or 0)
    return {"id": item["id"], "tags": tags, "facts": facts, "answer": answer, "cost": round(cost, 6), "model": MODEL}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", required=True, type=Path)
    ap.add_argument("--library", required=True, type=Path)
    ap.add_argument("--out", type=Path, default=HERE / "raw.jsonl")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()
    api_key = os.environ.get("FEATHERLESS_API_KEY")
    if not api_key:
        sys.exit("FEATHERLESS_API_KEY is not set")
    catalog = catalog_text(json.loads((HERE / "pose_catalog.json").read_text())["entries"])
    items = [i for i in json.load(gzip.open(args.index))["items"] if i["kind"] == "pose"]
    if args.only:
        items = [i for i in items if i["id"] in set(args.only)]
    done = set()
    if args.out.exists():
        done = {json.loads(line)["id"] for line in args.out.read_text().splitlines()
                if line.strip() and "error" not in json.loads(line)}
    todo = [i for i in items if i["id"] not in done]
    print(f"{len(todo)} to audit ({len(done)} done)", file=sys.stderr)
    with cf.ThreadPoolExecutor(args.workers) as pool:
        futures = {pool.submit(audit, i, args.library, catalog, api_key): i["id"] for i in todo}
        for n, fut in enumerate(cf.as_completed(futures), 1):
            try:
                rec = fut.result()
            except Exception as err:  # one pose failing never stops the run; it is re-run next time
                rec = {"id": futures[fut], "error": str(err)}
            with _lock, args.out.open("a") as fh:
                fh.write(json.dumps(rec) + "\n")
            print(f"[{n}/{len(todo)}] {rec['id']} {'ERROR ' + rec['error'][:120] if 'error' in rec else 'ok'}",
                  file=sys.stderr)


if __name__ == "__main__":
    main()
