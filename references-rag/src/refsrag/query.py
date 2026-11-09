"""The query interface: given a text context, the top poses and outfits with public URLs.

Shipped as the single file ``recommend.py`` (bundled from keys.py + stage1.py + this module by
``refs index build``), so it uses the standard library plus numpy; dense retrieval and reranking
use onnxruntime + tokenizers when installed, or the Featherless embeddings API when
FEATHERLESS_API_KEY is set. Without either it runs stage 1 only (lexicon + BM25).

    python recommend.py "college girl cosplay, foot tease" --index <dir or latest.json URL> [--json]
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Final, Literal, Protocol

import numpy as np

from refsrag.keys import url
from refsrag.stage1 import Bm25, dot, match_concepts, mmr_pick, rrf, tokenize

Kind = Literal["outfit", "pose"]
KINDS: Final[tuple[Kind, ...]] = ("outfit", "pose")
FEATHERLESS_URL: Final = "https://api.featherless.ai/v1/embeddings"
SCHEMA_VERSION: Final = 1
RETRIES: Final = 4
DECIDER_BREAKER: Final = 3  # consecutive failed requests that turn the decider rerank off
AUTO: Final = "auto"


# ── Results ──────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ViewUrls:
    angle: str
    image: str
    depth: str


@dataclass(frozen=True)
class Pick:
    id: str
    kind: Kind
    title: str
    score: float
    why: list[str]
    image: str  # outfit image, or the pose's best view line art
    depth: str | None = None  # pose only: depth map of the best view
    best_angle: str | None = None
    views: list[ViewUrls] = field(default_factory=list)  # pose only: every view


@dataclass(frozen=True)
class Recommendations:
    index_version: str
    context: str
    concepts: dict[str, float]  # what the context was understood as
    dense: str  # the vector set used, or "unavailable: <reason>"
    outfits: list[Pick]
    poses: list[Pick]

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=1)


@dataclass(frozen=True)
class Filters:
    solo: bool | None = None  # poses: True solo only, False duo only
    max_exposure: int | None = None  # outfits: 0..3
    outfit_categories: tuple[str, ...] = ()  # e.g. ("lingerie", "sexy")
    pose_series: tuple[str, ...] = ()  # e.g. ("full_body_sexy", "duo")


# ── Embedders ────────────────────────────────────────────────────────────────────────────────


class Embedder(Protocol):
    name: str

    def embed_query(self, text: str) -> np.ndarray: ...


class FeatherlessEmbedder:
    def __init__(self, name: str, spec: Mapping[str, Any], api_key: str) -> None:
        self.name, self.model, self.api_key = name, str(spec["model"]), api_key
        self.instruction = str(spec.get("query_instruction", ""))
        self.dim = int(spec["dim"])
        self._cache: dict[str, np.ndarray] = {}

    def embed_query(self, text: str) -> np.ndarray:
        if text not in self._cache:
            self._cache[text] = self._embed(text)
        return self._cache[text]

    def _embed(self, text: str) -> np.ndarray:
        body = json.dumps({"model": self.model, "input": [self.instruction + text]}).encode()
        req = urllib.request.Request(
            FEATHERLESS_URL,
            data=body,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            vec = np.asarray(json.load(resp)["data"][0]["embedding"], dtype=np.float32)[: self.dim]
        return vec / (np.linalg.norm(vec) or 1.0)


class OnnxEncoder:
    """A local ONNX transformer (bge-style CLS embedding, or a cross-encoder's logit)."""

    def __init__(self, model_dir: Path) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
        self.tokenizer.enable_truncation(512)
        self.tokenizer.enable_padding()
        self.session = ort.InferenceSession(str(model_dir / "model.onnx"), providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}

    def run(self, texts: Sequence[str | tuple[str, str]]) -> np.ndarray:
        encs = self.tokenizer.encode_batch(list(texts))
        feed = {
            "input_ids": np.array([e.ids for e in encs], dtype=np.int64),
            "attention_mask": np.array([e.attention_mask for e in encs], dtype=np.int64),
        }
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.array([e.type_ids for e in encs], dtype=np.int64)
        return np.asarray(self.session.run(None, feed)[0])


class LocalEmbedder:
    def __init__(self, name: str, spec: Mapping[str, Any], index_dir: Path) -> None:
        self.name = name
        self.prefix = str(spec.get("query_prefix", ""))
        self.encoder = OnnxEncoder(index_dir / str(spec["model_dir"]))
        self._cache: dict[str, np.ndarray] = {}

    def embed_query(self, text: str) -> np.ndarray:
        if text not in self._cache:
            self._cache[text] = self._embed(text)
        return self._cache[text]

    def _embed(self, text: str) -> np.ndarray:
        vec = np.asarray(self.encoder.run([self.prefix + text])[0, 0], dtype=np.float32)  # CLS pooling
        return vec / (np.linalg.norm(vec) or 1.0)


class CrossEncoder:
    def __init__(self, index_dir: Path, spec: Mapping[str, Any]) -> None:
        self.encoder = OnnxEncoder(index_dir / str(spec["model_dir"]))
        self._cache: dict[tuple[str, str], float] = {}

    def score(self, query: str, docs: Sequence[str]) -> list[float]:
        missing = [d for d in dict.fromkeys(docs) if (query, d) not in self._cache]
        if missing:
            out = self.encoder.run([(query, d) for d in missing])
            logits = out[:, 0] if out.ndim == 2 else out
            self._cache.update({(query, d): float(x) for d, x in zip(missing, logits, strict=True)})
        return [self._cache[(query, d)] for d in docs]


class DeciderReranker:
    """Reranks candidates with a decision model (Featherless classifier API): ONE request per kind,
    the context plus a numbered candidate list as state, one 0..3 score question per candidate. The
    TypeScript port does the same through the workspace decider (``spec.decider``)."""

    QUESTION: Final = (
        "How well does candidate {n} fit the context? 0 = does not fit, 3 = exactly what it would use."
    )

    def __init__(self, spec: Mapping[str, Any], api_key: str) -> None:
        self.url, self.model, self.api_key = str(spec["url"]), str(spec["model"]), api_key
        self._cache: dict[tuple[str, tuple[str, ...]], list[float] | None] = {}
        self.failures = 0  # consecutive; at DECIDER_BREAKER the reranker turns itself off

    def score(self, context: str, kind: str, docs: Sequence[str]) -> list[float] | None:
        """0..3 per doc, or None (the caller keeps its order) when the decision model fails, answers
        no candidate, or has failed DECIDER_BREAKER times in a row. Failures are cached too."""
        key = (context, tuple(docs))
        if key in self._cache:
            return self._cache[key]
        if self.failures >= DECIDER_BREAKER:
            return None
        result: list[float] | None = None
        for attempt in range(RETRIES):
            try:
                result = self._score(context, kind, docs)
                break
            except urllib.error.HTTPError as e:
                if (e.code < 500 and e.code != 429) or attempt == RETRIES - 1:  # a client error never heals
                    print(f"decider rerank skipped: {e}", file=sys.stderr)
                    break
            except Exception as e:  # network, timeout, malformed payload: never fail the recommendation
                if attempt == RETRIES - 1:
                    print(f"decider rerank skipped: {e}", file=sys.stderr)
                    break
            time.sleep(2**attempt)
        self.failures = 0 if result is not None else self.failures + 1
        self._cache[key] = result
        return result

    def _score(self, context: str, kind: str, docs: Sequence[str]) -> list[float]:
        listing = "\n".join(f"Candidate {n}: {d}" for n, d in enumerate(docs, start=1))
        state = f"Context of an adult clip: {context}\n\nCandidate {kind} references:\n{listing}"
        questions = {
            f"c{n}": {
                "type": "score",
                "instructions": self.QUESTION.format(n=n),
                "criteria": ["0", "1", "2", "3"],
            }
            for n in range(1, len(docs) + 1)
        }
        body = json.dumps({"model": self.model, "state": state, "questions": questions}).encode()
        req = urllib.request.Request(
            self.url,
            data=body,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            answers = json.load(resp)["answers"]
        scores = [answers.get(f"c{n}", {}).get("score") for n in range(1, len(docs) + 1)]
        if all(s is None for s in scores):
            raise ValueError("the decision model answered no candidate")
        return [float(s) if isinstance(s, int | float) else 0.0 for s in scores]


# ── Index ───────────────────────────────────────────────────────────────────────────────────


class Index:
    """``index.json`` plus its vector sets, loaded from a local directory."""

    def __init__(self, index_dir: Path) -> None:
        self.dir = index_dir
        data = json.loads((index_dir / "index.json").read_text())
        if data["schema_version"] != SCHEMA_VERSION:
            raise ValueError(f"index schema {data['schema_version']} != supported {SCHEMA_VERSION}")
        self.version: str = data["index_version"]
        self.default_base_url: str = data["default_base_url"]
        self.params: dict[str, Any] = data["params"]
        self.lexicon: dict[str, dict[str, float]] = data["lexicon"]
        self.concepts: dict[str, dict[str, Any]] = data["concepts"]
        self.items: list[dict[str, Any]] = data["items"]
        self.vector_sets: dict[str, dict[str, Any]] = data["vector_sets"]
        self.bm25 = {
            kind: Bm25(
                [tokenize(i["doc"]) for i in self.items if i["kind"] == kind],
                k1=self.params["bm25_k1"],
                b=self.params["bm25_b"],
            )
            for kind in KINDS
        }
        self.rows = {kind: [n for n, i in enumerate(self.items) if i["kind"] == kind] for kind in KINDS}
        self._bm25_cache: dict[tuple[Kind, tuple[str, ...]], list[float]] = {}

    def bm25_scores(self, kind: Kind, tokens: Sequence[str]) -> list[float]:
        """BM25 of every item of ``kind`` (in ``rows[kind]`` order), cached per query."""
        key = (kind, tuple(tokens))
        if key not in self._bm25_cache:
            self._bm25_cache[key] = self.bm25[kind].scores(list(tokens))
        return self._bm25_cache[key]

    def vectors(self, name: str) -> np.ndarray:
        spec = self.vector_sets[name]
        raw = np.fromfile(self.dir / spec["file"], dtype="<f4")
        return raw.reshape(len(self.items), int(spec["dim"]))


def fetch_index(source: str, cache_dir: Path) -> Path:
    """A local index directory for ``source``: a directory, or a ``latest.json`` / ``index.json`` URL
    (downloaded with its vector sets and models into ``cache_dir/<version>``, once).

    Safe for concurrent runs: the download goes to a per-process temp directory that is renamed into
    place, so ``cache_dir/<version>`` is either absent or complete. With a ``latest.json`` source the
    ``index.json`` bytes must match its sha256."""
    if not source.startswith(("http://", "https://")):
        return Path(source)
    expected_sha: str | None = None
    if source.endswith("latest.json"):
        latest = json.loads(_get(source))
        expected_sha = latest.get("sha256")
        source = source.rsplit("/", 1)[0] + "/" + _safe_rel(latest["path"])  # e.g. "v3/index.json"
    base = source.rsplit("/", 1)[0] + "/"
    raw = _get(source)
    if expected_sha is not None and hashlib.sha256(raw).hexdigest() != expected_sha:
        raise ValueError(f"{source}: sha256 does not match latest.json")
    index = json.loads(raw)
    target = cache_dir / _safe_rel(str(index["index_version"]))
    if (target / "index.json").is_file():
        return target
    cache_dir.mkdir(parents=True, exist_ok=True)
    tmp = Path(f"{target}.tmp-{os.getpid()}")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    try:
        for rel in index.get("files", []):
            dest = tmp / _safe_rel(rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(_get(base + rel))
        (tmp / "index.json").write_bytes(raw)  # the original bytes, so the sha256 still holds
        try:
            os.replace(tmp, target)
        except OSError:
            if not (target / "index.json").is_file():  # not a lost race: a real failure
                raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)  # gone after a successful rename; else the loser's copy
    return target


def _safe_rel(rel: str) -> str:
    """``rel`` when it is a relative path without ``..``: index.json is remote data, never trusted."""
    if not rel or rel.startswith(("/", "\\")) or ".." in rel.replace("\\", "/").split("/"):
        raise ValueError(f"unsafe path in index: {rel!r}")
    return rel


def _get(address: str) -> bytes:
    with urllib.request.urlopen(address, timeout=120) as resp:
        return bytes(resp.read())


# ── Recommender ─────────────────────────────────────────────────────────────────────────────


class Recommender:
    def __init__(
        self,
        index: Index,
        *,
        base_url: str | None = None,
        featherless_api_key: str | None = None,
        vector_set: str | None = AUTO,
        rerank: bool = True,
        decider_rerank: bool = False,
        params: Mapping[str, Any] | None = None,
    ) -> None:
        """``vector_set``: AUTO picks Featherless (with a key) or a local set; a name forces that set;
        None disables dense retrieval. ``params`` overrides the index's params (calibration)."""
        self.index = index
        self.params = {**index.params, **(params or {})}
        self.base_url = base_url or os.environ.get("REFS_BASE_URL") or index.default_base_url
        self.embedder, self.dense_status = _choose_embedder(index, featherless_api_key, vector_set)
        self.doc_vectors = index.vectors(self.embedder.name) if self.embedder else None
        spec = self.params.get("reranker")
        self.reranker = CrossEncoder(index.dir, spec) if rerank and spec and _has_onnx() else None
        decider = self.params.get("decider")
        self.decider = (
            DeciderReranker(decider, featherless_api_key)
            if decider_rerank and decider and featherless_api_key
            else None
        )

    def with_params(self, params: Mapping[str, Any]) -> Recommender:
        """A copy with other params that shares this one's loaded models and caches (calibration)."""
        clone = copy.copy(self)
        clone.params = {**self.index.params, **params}
        return clone

    @classmethod
    def load(
        cls, source: str, *, cache_dir: Path | None = None, base_url: str | None = None, decider: bool = True
    ) -> Recommender:
        """The calibrated default: the preferred vector set, and the decider rerank when
        FEATHERLESS_API_KEY is set (without a key: local ONNX or stage 1, no rerank)."""
        cache = cache_dir or Path.home() / ".cache" / "refs-recommender"
        return cls(Index(fetch_index(source, cache)), base_url=base_url, decider_rerank=decider,
                   featherless_api_key=os.environ.get("FEATHERLESS_API_KEY") or None)  # fmt: skip

    def recommend(
        self, context: str, *, k: int = 3, kinds: Sequence[Kind] = KINDS, filters: Filters | None = None
    ) -> Recommendations:
        p, flt = self.params, filters or Filters()
        q_concepts = {c: w for c, w in match_concepts(context, self.index.lexicon).items()}
        q_tokens = tokenize(context)
        q_vec = self.embedder.embed_query(context) if self.embedder else None
        picks: dict[Kind, list[Pick]] = {"outfit": [], "pose": []}
        for kind in kinds:
            rows = [r for r in self.index.rows[kind] if _passes(self.index.items[r], flt)]
            if not rows:
                continue
            local = {r: n for n, r in enumerate(self.index.rows[kind])}
            bm_all = self.index.bm25_scores(kind, q_tokens)
            bm = [bm_all[local[r]] for r in rows]
            cs = [dot(q_concepts, self.index.items[r]["concepts"]) for r in rows]
            ds = (
                [float(self.doc_vectors[r] @ q_vec) for r in rows]
                if q_vec is not None and self.doc_vectors is not None
                else [0.0] * len(rows)
            )
            fused = rrf([bm, cs, ds], [p["w_bm25"], p["w_concept"], p["w_dense"]], k=p["rrf_k"])
            order = sorted(range(len(rows)), key=lambda i: (-fused[i], i))[: p["candidates"]]
            relevance = {i: fused[i] for i in order}
            if self.reranker and order:
                ce = self.reranker.score(context, [self.index.items[rows[i]]["doc"] for i in order])
                blended = rrf([[fused[i] for i in order], ce, [cs[i] for i in order]],
                              [1.0, p["w_rerank"], p["w_concept"]], k=p["rrf_k"])  # fmt: skip
                relevance = dict(zip(order, blended, strict=True))
            if self.decider and order:
                # the decider scores the best candidates AFTER any cross-encoder rerank
                top = sorted(order, key=lambda i: (-relevance[i], i))[: p["decider_depth"]]
                decided = self.decider.score(context, kind, [self.index.items[rows[i]]["doc"] for i in top])
                if decided is not None:
                    fused_top = rrf(
                        [[relevance[i] for i in top], decided], [1.0, p["w_decider"]], k=p["rrf_k"]
                    )
                    relevance = dict(zip(top, fused_top, strict=True))
                    order = top  # the final picks come from the decided candidates
            rel = [relevance.get(i, 0.0) for i in range(len(rows))]
            chosen = mmr_pick(order, rel, _pair_similarity(self, rows), k=k, lam=p["mmr_lambda"])
            picks[kind] = [self._pick(rows[i], rel[i], q_concepts) for i in chosen]
        return Recommendations(
            self.index.version, context, q_concepts, self.dense_status, picks["outfit"], picks["pose"]
        )

    def _similarity(self, a: int, b: int) -> float:
        ia, ib = self.index.items[a], self.index.items[b]
        same_group = 1.0 if ia.get("group") and ia.get("group") == ib.get("group") else 0.0
        ca, cb = ia["concepts"], ib["concepts"]
        norm = (dot(ca, ca) * dot(cb, cb)) ** 0.5
        return max(same_group, dot(ca, cb) / norm if norm else 0.0)

    def _pick(self, row: int, score: float, q_concepts: Mapping[str, float]) -> Pick:
        item = self.index.items[row]
        why = [
            f"{readable_concept(c)} {item['concepts'][c]:.1f}"
            for c in sorted(q_concepts, key=lambda c: -q_concepts[c] * item["concepts"].get(c, 0))
            if item["concepts"].get(c, 0) > 0
        ][:4]
        if item["kind"] == "outfit":
            return Pick(
                item["id"], "outfit", item["title"], round(score, 5), why, url(self.base_url, item["image"])
            )
        views = item["views"]
        best = max(views, key=lambda v: (self._view_score(v, q_concepts), -views.index(v)))
        best_view = f"best view: {best['angle']} ({best['view']})"
        return Pick(
            id=item["id"],
            kind="pose",
            title=item["title"],
            score=round(score, 5),
            why=[*why, best_view],
            image=url(self.base_url, best["image"]),
            depth=url(self.base_url, best["depth"]),
            best_angle=best["angle"],
            views=[
                ViewUrls(v["angle"], url(self.base_url, v["image"]), url(self.base_url, v["depth"]))
                for v in views
            ],
        )

    def _view_score(self, view: Mapping[str, Any], q_concepts: Mapping[str, float]) -> float:
        """How well a camera view presents the body parts the query's concepts care about."""
        wanted: dict[str, float] = {}
        for c, w in q_concepts.items():
            for part, fw in self.index.concepts.get(c, {}).get("focus", {}).items():
                wanted[part] = wanted.get(part, 0.0) + w * fw
        return dot(wanted, view["focus"])


def _pair_similarity(rec: Recommender, rows: Sequence[int]) -> Callable[[int, int], float]:
    """Similarity of two candidates given by their position in ``rows``."""
    return lambda a, b: rec._similarity(rows[a], rows[b])


def readable_concept(name: str) -> str:
    """'label:archetype:office_secretary' -> 'archetype office secretary'; 'foot_fetish' -> 'foot fetish'."""
    return name.removeprefix("label:").replace(":", " ").replace("_", " ")


def _passes(item: Mapping[str, Any], f: Filters) -> bool:
    if item["kind"] == "outfit":
        return (f.max_exposure is None or item["exposure"] <= f.max_exposure) and (
            not f.outfit_categories or item["category"] in f.outfit_categories
        )
    return (f.solo is None or item["solo"] == f.solo) and (
        not f.pose_series or item["series"] in f.pose_series
    )


def _has_onnx() -> bool:
    try:
        import onnxruntime  # noqa: F401
        import tokenizers  # noqa: F401
    except ImportError:
        return False
    return True


def _choose_embedder(index: Index, api_key: str | None, choice: str | None) -> tuple[Embedder | None, str]:
    """AUTO: Featherless when a key is set, else a local ONNX set, else none (stage 1 only)."""
    if choice is None:
        return None, "unavailable: disabled"
    if choice != AUTO:
        spec = index.vector_sets[choice]
        if spec["provider"] == "featherless":
            if not api_key:
                raise ValueError(f"{choice} needs FEATHERLESS_API_KEY")
            return FeatherlessEmbedder(choice, spec, api_key), choice
        return LocalEmbedder(choice, spec, index.dir), choice
    for name, spec in index.vector_sets.items():
        if spec["provider"] == "featherless" and api_key:
            return FeatherlessEmbedder(name, spec, api_key), name
    for name, spec in index.vector_sets.items():
        if spec["provider"] == "local" and _has_onnx():
            return LocalEmbedder(name, spec, index.dir), name
    return None, "unavailable: no FEATHERLESS_API_KEY and no onnxruntime"


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Top poses and outfits for a text context.")
    ap.add_argument("context")
    ap.add_argument("--index", default=os.environ.get("REFS_INDEX", ""), help="index dir or latest.json URL")
    ap.add_argument("--base-url", default=None)
    ap.add_argument("-k", type=int, default=3)
    ap.add_argument("--kind", choices=KINDS, action="append")
    ap.add_argument("--solo", choices=["solo", "duo"])
    ap.add_argument("--max-exposure", type=int, choices=[0, 1, 2, 3])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-decider", action="store_true", help="skip the decision-model rerank")
    a = ap.parse_args(argv)
    if not a.index:
        ap.error("--index (or REFS_INDEX) is required")
    rec = Recommender.load(a.index, base_url=a.base_url, decider=not a.no_decider)
    filters = Filters(solo=None if a.solo is None else a.solo == "solo", max_exposure=a.max_exposure)
    result = rec.recommend(a.context, k=a.k, kinds=a.kind or KINDS, filters=filters)
    if a.json:
        print(result.to_json())
        return 0
    print(f"concepts: {result.concepts}  dense: {result.dense}")
    for pick in result.outfits + result.poses:
        print(f"{pick.kind:6} {pick.id:28} {pick.score:.4f}  {pick.title}")
        print(f"       {pick.image}\n       why: {'; '.join(pick.why)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
