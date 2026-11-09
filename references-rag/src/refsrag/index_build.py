"""Build one immutable index version from the labels and publish it.

    data/index/<version>/
      index.json            items (docs, concepts, URLs as ref keys), lexicon, concepts, params, vector sets
      vectors.<name>.f32    one L2-normalised float32 row per item (little-endian, item order)
      models/<name>/        local ONNX models (model.onnx + tokenizer.json)
      recommend.py          the single-file query interface (bundled from keys + stage1 + query)
      golden.json           parity fixtures for the TypeScript port

``publish`` uploads it to ``<key_root>rag/<version>/`` and then points ``rag/latest.json`` at it.
"""

from __future__ import annotations

import ast
import hashlib
import json
import logging
import re
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import boto3
import httpx
import numpy as np
import yaml

from refsrag import keys, query, stage1
from refsrag.catalog import Outfit, Pose, load_outfits, load_poses
from refsrag.jobs import load_results
from refsrag.labels import ConceptAffinity, OutfitVision, PoseVision
from refsrag.mine_lexicon import LEXICON_FILE, VOCAB_FILE, common_words, read_clips
from refsrag.settings import PROJECT_ROOT, Settings

log = logging.getLogger(__name__)

INDEX_ROOT: Final = PROJECT_ROOT / "data" / "index"
LAKE_CLIPS: Final = PROJECT_ROOT / "data" / "lake" / "clips.jsonl"
HF: Final = "https://huggingface.co"
FEATHERLESS_BATCH: Final = 32
ARCHETYPE_MIN: Final = 0.4  # archetypes / focus / concepts below these weights stay out of the doc text
FOCUS_MIN: Final = 0.6
CONCEPT_DOC_MIN: Final = 0.5
ALIASES_PER_CONCEPT_IN_DOC: Final = 3

DEFAULT_PARAMS: Final[dict[str, Any]] = {
    "bm25_k1": 1.2,
    "bm25_b": 0.75,
    "rrf_k": 60,
    "w_bm25": 1.0,
    "w_concept": 1.0,
    "w_dense": 1.0,
    "w_rerank": 1.0,
    "candidates": 30,
    "mmr_lambda": 0.7,
    # Calibration (eval/report.md): the cross-encoder adds nothing over hybrid retrieval, the decider
    # rerank does (+0.09 nDCG@3 on the test half). None = no cross-encoder shipped.
    "reranker": None,
    # Decision-model rerank (opt-in, needs FEATHERLESS_API_KEY): the TypeScript port uses spec.decider.
    "decider": {
        "url": "https://api.featherless.ai/v1/classifier",
        "model": "featherless-ai/Qwen3.8-27B-classifier",
    },
    "decider_depth": 12,
    "w_decider": 2.0,
}


@dataclass(frozen=True)
class VectorSetSpec:
    name: str  # "<provider>:<model>", the key the TypeScript port matches its embedder against
    provider: str  # "featherless" | "local"
    model: str
    dim: int
    query_instruction: str = ""  # featherless (Qwen3): prepended to queries only
    query_prefix: str = ""  # local (bge): prepended to queries only
    hf_repo: str = ""  # local: Hugging Face repo with onnx/model_quantized.onnx + tokenizer.json


QWEN_INSTRUCTION: Final = (
    "Instruct: Given a scene, kink or clip description, retrieve pose or outfit references that fit it\n"
    "Query: "
)
# Order = preference of recommend.py's automatic choice: 4B scored best in calibration; 0.6B is the
# smaller set the TypeScript port's workspaces use (7 MB vs 17 MB per cold call).
VECTOR_SETS: Final[tuple[VectorSetSpec, ...]] = (
    VectorSetSpec("featherless:Qwen/Qwen3-Embedding-4B", "featherless", "Qwen/Qwen3-Embedding-4B", 2560,
                  query_instruction=QWEN_INSTRUCTION),
    VectorSetSpec("featherless:Qwen/Qwen3-Embedding-0.6B", "featherless", "Qwen/Qwen3-Embedding-0.6B", 1024,
                  query_instruction=QWEN_INSTRUCTION),
    VectorSetSpec("local:bge-small-en-v1.5", "local", "bge-small-en-v1.5", 384,
                  query_prefix="Represent this sentence for searching relevant passages: ",
                  hf_repo="Xenova/bge-small-en-v1.5"),
)  # fmt: skip
RERANKER_REPO: Final = "Xenova/ms-marco-MiniLM-L-6-v2"


# ── Items and docs ──────────────────────────────────────────────────────────────────────────


def build_items(settings: Settings, lexicon: Mapping[str, Mapping[str, float]]) -> list[dict[str, Any]]:
    root = settings.require_library_root()
    outfit_labels, pose_labels = load_results("outfit_vision"), load_results("pose_vision")
    affinity = load_results("concept_affinity")
    aliases = top_aliases(lexicon)
    items: list[dict[str, Any]] = []
    for o in load_outfits(root):
        label = outfit_labels[o.id]
        assert isinstance(label, OutfitVision)
        items.append(outfit_entry(settings, o, label, _concepts(affinity, f"outfit:{o.id}"), aliases))
    for p in load_poses(root):
        plabel = pose_labels[p.id]
        assert isinstance(plabel, PoseVision)
        items.append(pose_entry(settings, p, plabel, _concepts(affinity, f"pose:{p.id}"), aliases))
    return items


def outfit_entry(
    settings: Settings,
    o: Outfit,
    label: OutfitVision,
    concepts: dict[str, float],
    aliases: Mapping[str, list[str]],
) -> dict[str, Any]:
    archetypes = [a.replace("_", " ") for a, w in label.archetypes.items() if w >= ARCHETYPE_MIN]
    doc = ". ".join(
        [
            label.description_en,
            "Garments: " + ", ".join(label.garments),
            "Colours: " + ", ".join(label.colors) + "; materials: " + ", ".join(label.materials),
            "Style: " + ", ".join(archetypes),
            "Footwear: " + label.footwear,
            "Shows off: " + ", ".join(p for p, w in label.accentuated.items() if w >= ARCHETYPE_MIN),
            _used_for(concepts, aliases),
        ]
    )
    return {
        "id": o.id,
        "kind": "outfit",
        "title": _first_sentence(label.description_en),
        "doc": doc,
        "concepts": concepts | outfit_label_terms(label),
        "category": o.category,
        "exposure": label.exposure,
        "image": keys.asset_ref_key(settings.key_root, o.image),
    }


def pose_entry(
    settings: Settings,
    p: Pose,
    label: PoseVision,
    concepts: dict[str, float],
    aliases: Mapping[str, list[str]],
) -> dict[str, Any]:
    focus = _max_focus(label)
    doc = ". ".join(
        [
            label.name_en,
            label.description_en,
            "Support: " + label.support.replace("_", " "),
            "Shows off: " + ", ".join(k.replace("_", " ") for k, w in focus.items() if w >= FOCUS_MIN),
            "Positions: " + ", ".join(label.sex_positions),
            "Acts: " + ", ".join(label.typical_acts),
            _used_for(concepts, aliases),
        ]
    )
    views = []
    for v in p.views:
        vl = label.views[v.angle]
        views.append(
            {
                "angle": v.angle,
                "image": keys.asset_ref_key(settings.key_root, v.image),
                "depth": keys.asset_ref_key(settings.key_root, v.depth),
                "focus": {str(k): w for k, w in vl.focus.items()},
                "view": vl.view,
            }
        )
    return {
        "id": p.id,
        "kind": "pose",
        "title": label.name_en,
        "doc": doc,
        "concepts": concepts | pose_label_terms(label),
        "series": p.series,
        "category": p.category,
        "solo": p.solo,
        "sex_positions": list(label.sex_positions),
        "views": views,
    }


# ── Label terms: the vision labels as extra concepts, with aliases derived from the term names ──

LABEL_PREFIX: Final = "label:"
LABEL_ALIAS_WEIGHT: Final = 0.8
# Kinds whose single words may stand alone ("office" for office_secretary); a position or support
# name is only meaningful as a whole phrase.
SINGLE_WORD_KINDS: Final = frozenset({"archetype", "accentuated", "footwear", "focus", "mood"})
COMMON_WORD_SHARE: Final = 0.03  # a word in more than 3% of the lake's clip texts never stands alone


def outfit_label_terms(label: OutfitVision) -> dict[str, float]:
    terms = {f"{LABEL_PREFIX}archetype:{a}": w for a, w in label.archetypes.items()}
    terms |= {f"{LABEL_PREFIX}accentuated:{p}": w for p, w in label.accentuated.items()}
    terms[f"{LABEL_PREFIX}footwear:{label.footwear}"] = 1.0
    return terms


def pose_label_terms(label: PoseVision) -> dict[str, float]:
    terms = {f"{LABEL_PREFIX}mood:{m}": w for m, w in label.mood.items()}
    terms |= {f"{LABEL_PREFIX}focus:{p}": w for p, w in _max_focus(label).items()}
    terms[f"{LABEL_PREFIX}support:{label.support}"] = 1.0
    terms |= {f"{LABEL_PREFIX}position:{p}": 1.0 for p in label.sex_positions}
    return terms


def label_lexicon(terms: Iterable[str], common: Collection[str]) -> dict[str, dict[str, float]]:
    """alias_key -> {label term: weight}: each term's name as a phrase ("office secretary"), plus its
    single words that are not ``common`` in the domain's text ("office", "secretary"; never "back",
    "face"). Derived from the names and the lake's clip texts, never hand-listed."""
    lexicon: dict[str, dict[str, float]] = {}
    for term in sorted(set(terms)):
        if term.endswith(":none"):
            continue
        kind, name = term.removeprefix(LABEL_PREFIX).split(":", 1)
        words = stage1.tokenize(name.replace("_", " "))
        aliases = {" ".join(words)}
        if kind in SINGLE_WORD_KINDS:
            aliases |= {w for w in words if w not in common and len(w) > 3}
        aliases -= set(common)  # a single-word term that is itself a common word ("back") is dropped too
        for alias in aliases:
            lexicon.setdefault(alias, {})[term] = LABEL_ALIAS_WEIGHT
    return lexicon


def label_concepts(terms: Iterable[str]) -> dict[str, dict[str, Any]]:
    """Concept entries of the label terms; a focus term presents exactly its own body part."""
    out: dict[str, dict[str, Any]] = {}
    for term in sorted(set(terms)):
        kind, name = term.removeprefix(LABEL_PREFIX).split(":", 1)
        focus = {name: 1.0} if kind == "focus" else {}
        out[term] = {"type": "label", "description": f"{kind}: {name.replace('_', ' ')}", "focus": focus}
    return out


def top_aliases(lexicon: Mapping[str, Mapping[str, float]]) -> dict[str, list[str]]:
    """Concept -> its strongest aliases (multi-word first): the words a doc gets for a concept it serves."""
    by_concept: dict[str, list[tuple[float, int, str]]] = {}
    for alias, concepts in lexicon.items():
        for c, w in concepts.items():
            by_concept.setdefault(c, []).append((w, len(alias.split()), alias))
    return {
        c: [a for _, _, a in sorted(v, key=lambda t: (-t[0], -t[1], t[2]))[:ALIASES_PER_CONCEPT_IN_DOC]]
        for c, v in by_concept.items()
    }


def concept_focus(items: Sequence[Mapping[str, Any]], concepts: Sequence[str]) -> dict[str, dict[str, float]]:
    """Concept -> body-focus weights, learnt from the poses: the focus profile of the poses that serve a
    concept (affinity-weighted) minus the average pose's; positive parts only, max scaled to 1. It
    tells the query which camera view of a pose presents what the concept is about."""
    poses = [i for i in items if i["kind"] == "pose"]
    profiles = [_view_max_focus(p) for p in poses]
    parts = sorted({k for pr in profiles for k in pr})
    mean = {k: sum(pr.get(k, 0.0) for pr in profiles) / len(profiles) for k in parts}
    out: dict[str, dict[str, float]] = {}
    for c in concepts:
        weights = [p["concepts"].get(c, 0.0) for p in poses]
        total = sum(weights)
        if total < 1.0:  # too few poses serve it to learn a profile
            continue
        lift = {
            k: sum(w * pr.get(k, 0.0) for w, pr in zip(weights, profiles, strict=True)) / total - mean[k]
            for k in parts
        }
        top = max(lift.values())
        if top > 0:
            out[c] = {k: round(v / top, 3) for k, v in sorted(lift.items()) if v > 0.05 * top}
    return out


def _view_max_focus(pose: Mapping[str, Any]) -> dict[str, float]:
    focus: dict[str, float] = {}
    for v in pose["views"]:
        for k, w in v["focus"].items():
            focus[k] = max(focus.get(k, 0.0), w)
    return focus


def _max_focus(label: PoseVision) -> dict[str, float]:
    focus: dict[str, float] = {}
    for view in label.views.values():
        for k, w in view.focus.items():
            focus[k] = max(focus.get(k, 0.0), w)
    return focus


def _merge_lexicons(*lexicons: Mapping[str, Mapping[str, float]]) -> dict[str, dict[str, float]]:
    merged: dict[str, dict[str, float]] = {}
    for lex in lexicons:
        for alias, concepts in lex.items():
            slot = merged.setdefault(alias, {})
            for c, w in concepts.items():
                slot[c] = max(slot.get(c, 0.0), w)
    return dict(sorted(merged.items()))


def _concepts(affinity: Mapping[str, Any], key: str) -> dict[str, float]:
    record = affinity.get(key)
    return dict(record.concepts) if isinstance(record, ConceptAffinity) else {}


def _used_for(concepts: Mapping[str, float], aliases: Mapping[str, list[str]]) -> str:
    strong = sorted((c for c, w in concepts.items() if w >= CONCEPT_DOC_MIN), key=lambda c: -concepts[c])
    words = [w for c in strong for w in [c.replace("_", " "), *aliases.get(c, [])]]
    return "Used for: " + ", ".join(dict.fromkeys(words))


def _first_sentence(text: str, limit: int = 90) -> str:
    first = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
    return first if len(first) <= limit else first[: limit - 1].rsplit(" ", 1)[0] + "…"


# ── Embeddings and models ───────────────────────────────────────────────────────────────────


def embed_docs(spec: VectorSetSpec, docs: Sequence[str], out_dir: Path, settings: Settings) -> np.ndarray:
    if spec.provider == "featherless":
        if not settings.featherless_api_key:
            raise RuntimeError("FEATHERLESS_API_KEY is needed to build the Featherless vector sets")
        rows = []
        with httpx.Client(timeout=120) as client:
            for start in range(0, len(docs), FEATHERLESS_BATCH):
                resp = client.post(
                    query.FEATHERLESS_URL,
                    headers={"Authorization": f"Bearer {settings.featherless_api_key}"},
                    json={"model": spec.model, "input": list(docs[start : start + FEATHERLESS_BATCH])},
                )
                resp.raise_for_status()
                rows += [d["embedding"][: spec.dim] for d in resp.json()["data"]]
        vecs = np.asarray(rows, dtype=np.float32)
    else:
        model_dir = fetch_onnx_model(spec.hf_repo, out_dir / local_model_dir(spec.name))
        encoder = query.OnnxEncoder(model_dir)
        vecs = np.concatenate(
            [encoder.run(list(docs[s : s + 32]))[:, 0] for s in range(0, len(docs), 32)]
        ).astype(np.float32)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    return (vecs / np.where(norms == 0, 1, norms)).astype("<f4")


def local_model_dir(name: str) -> str:
    return "models/" + name.split(":", 1)[1].lower().replace("/", "-").replace(".", "-")


def fetch_onnx_model(repo: str, target: Path) -> Path:
    """model.onnx (quantized) + tokenizer.json of a Hugging Face repo, downloaded once."""
    target.mkdir(parents=True, exist_ok=True)
    for remote, local in (("onnx/model_quantized.onnx", "model.onnx"), ("tokenizer.json", "tokenizer.json")):
        dest = target / local
        if not dest.is_file():
            with httpx.stream(
                "GET", f"{HF}/{repo}/resolve/main/{remote}", follow_redirects=True, timeout=600
            ) as r:
                r.raise_for_status()
                tmp = dest.with_name(dest.name + ".tmp")
                with tmp.open("wb") as f:
                    for chunk in r.iter_bytes():
                        f.write(chunk)
                tmp.replace(dest)
    return target


# ── Bundle, golden, build, publish ──────────────────────────────────────────────────────────

BUNDLED_MODULES: Final = (keys, stage1, query)  # dependency order


def bundle_recommend_py() -> str:
    """keys.py + stage1.py + query.py as one self-contained script: one module docstring (query's),
    one ``from __future__`` import, no ``refsrag`` imports (they are defined above their use)."""
    parts = [
        f'"""{ast.get_docstring(ast.parse(Path(query.__file__).read_text()))}"""',
        "",
        "from __future__ import annotations",
        "",
    ]
    for module in BUNDLED_MODULES:
        source = Path(str(module.__file__)).read_text()
        tree = ast.parse(source)
        lines = source.splitlines()
        drop: set[int] = set()
        for node in tree.body:
            is_docstring = (
                isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and node is tree.body[0]
            )
            is_internal = isinstance(node, ast.ImportFrom) and (
                node.module == "__future__" or (node.module or "").startswith("refsrag")
            )
            if is_docstring or is_internal:
                drop.update(range(node.lineno - 1, (node.end_lineno or node.lineno)))
        parts.append(f"# ── {module.__name__.rsplit('.', 1)[1]}.py " + "─" * 60)
        parts.append("\n".join(line for n, line in enumerate(lines) if n not in drop).strip("\n"))
        parts.append("")
    return "\n".join(parts) + "\n"


GOLDEN_QUERIES: Final = (
    "college girl cosplay",
    "foot fetish, show me your soles",
    "ass worship, bend over and show your ass",
    "lingerie strip tease in stockings and garters",
    "doggy style sex",
    "cowgirl riding him",
    "femdom goddess in leather boots",
    "Shiny Tan Pantyhose Footjob. I love you underneath me, look up at my nyloned legs and high heels.",
    "secretary roleplay in the office",
    "beach bikini tease",
)


def golden(
    items: Sequence[Mapping[str, Any]], lexicon: Mapping[str, Mapping[str, float]], params: Mapping[str, Any]
) -> dict[str, Any]:
    """Stage-1 outputs (no dense, no rerank) the TypeScript port must reproduce exactly."""
    cases = []
    for text in GOLDEN_QUERIES:
        q_concepts = stage1.match_concepts(text, lexicon)
        q_tokens = stage1.tokenize(text)
        case: dict[str, Any] = {"context": text, "tokens": q_tokens, "concepts": q_concepts}
        for kind in query.KINDS:
            rows = [i for i in items if i["kind"] == kind]
            bm = stage1.Bm25(
                [stage1.tokenize(i["doc"]) for i in rows], k1=params["bm25_k1"], b=params["bm25_b"]
            ).scores(q_tokens)
            cs = [stage1.dot(q_concepts, i["concepts"]) for i in rows]
            fused = stage1.rrf([bm, cs], [params["w_bm25"], params["w_concept"]], k=params["rrf_k"])
            top = sorted(range(len(rows)), key=lambda n: (-fused[n], n))[:10]
            case[kind] = [
                {
                    "id": rows[n]["id"],
                    "bm25": round(bm[n], 6),
                    "concept": round(cs[n], 6),
                    "fused": round(fused[n], 8),
                }
                for n in top
            ]
        cases.append(case)
    return {"cases": cases}


SELECTION_BASE_URL: Final = "https://refs.example/base/"
GOLDEN_FILE: Final = "golden.json"
SELECTION_GOLDEN_FILE: Final = "selection-golden.json"


class FixedDecider:
    """Deterministic stand-in for the decision model in the selection fixtures: candidate n (1-based)
    scores (n * 7) % 4. The TypeScript parity test feeds the same scores."""

    def score(self, context: str, kind: str, docs: Sequence[str]) -> list[float] | None:
        return [float((n * 7) % 4) for n in range(1, len(docs) + 1)]


def selection_golden(index_dir: Path) -> dict[str, Any]:
    """``Recommender.recommend`` results (stage 1: no dense, no cross-encoder) the TypeScript port
    must reproduce field for field: every GOLDEN_QUERIES context, two filtered variants of two of
    them, and four decider cases with ``FixedDecider`` scores."""
    idx = query.Index(index_dir)
    plain = query.Recommender(idx, base_url=SELECTION_BASE_URL, vector_set=None, rerank=False)
    decided = query.Recommender(idx, base_url=SELECTION_BASE_URL, vector_set=None, rerank=False)
    decided.decider = FixedDecider()  # type: ignore[assignment]

    def case(rec: query.Recommender, ctx: str, k: int, flt: dict[str, Any], decider: bool) -> dict[str, Any]:
        result = rec.recommend(ctx, k=k, filters=query.Filters(**flt))
        out = json.loads(result.to_json())
        return {"context": ctx, "k": k, "filters": flt, "decider": decider, "result": out}

    cases = [case(plain, ctx, 3, {}, False) for ctx in GOLDEN_QUERIES]
    for ctx in (GOLDEN_QUERIES[0], GOLDEN_QUERIES[4]):
        cases.append(case(plain, ctx, 4, {"solo": True, "max_exposure": 1}, False))
        cases.append(case(plain, ctx, 3, {"solo": False}, False))
    cases += [case(decided, ctx, 3, {}, True) for ctx in GOLDEN_QUERIES[:4]]
    return {"base_url": SELECTION_BASE_URL, "decider_scores": "(n * 7) % 4 for candidate n", "cases": cases}


def write_golden(version: str) -> list[Path]:
    """(Re)write the parity fixtures of ``data/index/<version>`` from its own ``index.json``:
    ``golden.json`` (stage 1) and ``selection-golden.json`` (whole recommendations)."""
    out = INDEX_ROOT / version
    index = json.loads((out / "index.json").read_text())
    stage = golden(index["items"], index["lexicon"], index["params"])
    paths = [out / GOLDEN_FILE, out / SELECTION_GOLDEN_FILE]
    paths[0].write_text(json.dumps(stage, indent=1) + "\n")
    paths[1].write_text(json.dumps(selection_golden(out), indent=1) + "\n")
    return paths


def build(settings: Settings, version: str, *, vector_sets: Sequence[str] | None = None) -> Path:
    out = INDEX_ROOT / version
    out.mkdir(parents=True, exist_ok=True)
    lexicon = json.loads(LEXICON_FILE.read_text())["aliases"]
    vocab = yaml.safe_load(VOCAB_FILE.read_text())["concepts"]
    items = build_items(settings, lexicon)
    terms = {c for i in items for c in i["concepts"] if c.startswith(LABEL_PREFIX)}
    focus = concept_focus(items, list(vocab))
    concepts = {
        c: {"type": v["type"], "description": v["description"], "focus": focus.get(c, {})}
        for c, v in vocab.items()
    } | label_concepts(terms)
    common = common_words(read_clips(LAKE_CLIPS), share=COMMON_WORD_SHARE) if LAKE_CLIPS.is_file() else set()
    if not common:
        log.warning("no lake snapshot at %s: label aliases are not filtered for common words", LAKE_CLIPS)
    lexicon = _merge_lexicons(lexicon, label_lexicon(terms, common))
    params = dict(DEFAULT_PARAMS)
    if params["reranker"]:
        fetch_onnx_model(RERANKER_REPO, out / params["reranker"]["model_dir"])
    sets: dict[str, Any] = {}
    files: list[str] = []
    for spec in VECTOR_SETS:
        if vector_sets and spec.name not in vector_sets:
            continue
        log.info("embedding %d docs with %s", len(items), spec.name)
        vecs = embed_docs(spec, [i["doc"] for i in items], out, settings)
        file = f"vectors.{_slug(spec.name)}.f32"
        vecs.tofile(out / file)
        files.append(file)
        sets[spec.name] = {"provider": spec.provider, "model": spec.model, "dim": spec.dim, "file": file}
        if spec.provider == "featherless":
            sets[spec.name]["query_instruction"] = spec.query_instruction
        else:
            sets[spec.name] |= {"query_prefix": spec.query_prefix, "model_dir": local_model_dir(spec.name)}
            files += [
                f"{local_model_dir(spec.name)}/model.onnx",
                f"{local_model_dir(spec.name)}/tokenizer.json",
            ]
    if params["reranker"]:
        files += [
            f"{params['reranker']['model_dir']}/model.onnx",
            f"{params['reranker']['model_dir']}/tokenizer.json",
        ]
    (out / "recommend.py").write_text(bundle_recommend_py())
    (out / GOLDEN_FILE).write_text(json.dumps(golden(items, lexicon, params), indent=1) + "\n")
    files += ["recommend.py", "golden.json"]
    index = {
        "schema_version": query.SCHEMA_VERSION,
        "index_version": version,
        "default_base_url": settings.base_url,
        "params": params,
        "lexicon": lexicon,
        "concepts": concepts,
        "items": items,
        "vector_sets": sets,
        "files": files,
    }
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=True, separators=(",", ":")))
    return out


def publish(settings: Settings, version: str) -> str:
    """Upload ``data/index/<version>`` (index.json last), then point latest.json at it. Returns its URL."""
    src = INDEX_ROOT / version
    index = json.loads((src / "index.json").read_text())
    s3 = boto3.client(
        "s3",
        region_name=settings.region,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
    )

    def put(rel: str, body: bytes, content_type: str, cache: str) -> None:
        key = keys.s3_key(settings.public_prefix, keys.rag_ref_key(settings.key_root, version, rel))
        s3.put_object(
            Bucket=settings.bucket, Key=key, Body=body, ContentType=content_type, CacheControl=cache
        )

    immutable = "public, max-age=31536000, immutable"  # a version's files never change
    for rel in [*index["files"], "index.json"]:
        put(rel, (src / rel).read_bytes(), _content_type(rel), immutable)
    latest = {
        "index_version": version,
        "path": f"{version}/index.json",
        "sha256": hashlib.sha256((src / "index.json").read_bytes()).hexdigest(),
    }
    s3.put_object(
        Bucket=settings.bucket,
        Key=keys.s3_key(settings.public_prefix, keys.latest_ref_key(settings.key_root)),
        Body=json.dumps(latest).encode(),
        ContentType="application/json",
        CacheControl="public, max-age=60",
    )
    return keys.url(settings.base_url, keys.latest_ref_key(settings.key_root))


def _content_type(rel: str) -> str:
    if rel.endswith(".json"):
        return "application/json"
    if rel.endswith(".py"):
        return "text/x-python"
    return "application/octet-stream"


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
