"""The query interface: given a text context, the top items of each kind of a catalog (poses and
outfits for ``refs``) with public URLs. Catalog-generic: kinds, filters, media and result fields come
from the index's ``catalog`` descriptor (``descriptor.py``).

Shipped as the single file ``recommend.py`` (bundled from keys.py + stage1.py + descriptor.py + this
module by ``refs index build``), so it uses the standard library plus numpy; dense retrieval and
reranking use onnxruntime + tokenizers when installed, or the Featherless embeddings API when
FEATHERLESS_API_KEY is set. Without either it runs stage 1 only (lexicon + BM25).

    python recommend.py "college girl cosplay, foot tease" --index <dir or latest.s2.json URL> [--json]
    python recommend.py --describe --index <...>   # the catalog: kinds, filters, max_k
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Final, Protocol

import numpy as np

from refsrag.descriptor import Catalog, Filters, FilterSpec, FilterValue
from refsrag.keys import is_pointer, url
from refsrag.stage1 import Bm25, dot, match_concepts, mmr_pick, rrf, tokenize

FEATHERLESS_URL: Final = "https://api.featherless.ai/v1/embeddings"
SCHEMA_VERSION: Final = 2
RETRIES: Final = 4
DECIDER_BREAKER: Final = 3  # consecutive failed requests that turn the decider rerank off
AUTO: Final = "auto"


# ── Results ──────────────────────────────────────────────────────────────────────────────────


# The JSON form omits unset optional fields (never null): depth, best_angle and views of an ``image``
# pick, depth of a view without one, and decider when the decision-model rerank is off.


@dataclass(frozen=True)
class ViewUrls:
    angle: str
    image: str
    depth: str | None = None


@dataclass(frozen=True)
class Pick:
    id: str
    kind: str
    title: str
    score: float
    why: list[str]  # the query concepts the item serves; a ``views`` pick ends with its best view
    image: str  # the item's image, or its best view's image (``views`` kinds)
    attrs: dict[str, Any]  # the kind's ``result_fields`` only
    depth: str | None = None  # ``views`` kinds: depth map of the best view, when it has one
    best_angle: str | None = None  # ``views`` kinds
    views: list[ViewUrls] | None = None  # ``views`` kinds: every view


@dataclass(frozen=True)
class Recommendations:
    catalog: str  # the catalog key
    index_version: str
    context: str
    concepts: dict[str, float]  # what the context was understood as
    dense: str  # the vector set used, or "unavailable: <reason>"
    picks: dict[str, list[Pick]]  # kind -> picks, one entry per requested kind in catalog order
    decider: str | None = None  # the decision model that reranked, "unavailable: <reason>", or off

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = _without_none(asdict(self))
        return out

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=1)


def _without_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _without_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_without_none(v) for v in value]
    return value


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


class Decider(Protocol):
    model: str

    def score(self, context: str, kind: str, docs: Sequence[str]) -> list[float] | None: ...


class DeciderReranker:
    """Reranks candidates with a decision model (Featherless classifier API): ONE request per kind,
    the context plus a numbered candidate list as state, one 0..3 score question per candidate. The
    TypeScript port does the same through the workspace decider (``spec.decider``). The catalog's
    ``decider_context`` and ``decider_guidance`` word the state."""

    QUESTION: Final = (
        "How well does candidate {n} fit the context? 0 = does not fit, 3 = exactly what it would use."
    )

    def __init__(self, spec: Mapping[str, Any], api_key: str, catalog: Catalog) -> None:
        self.url, self.model, self.api_key = str(spec["url"]), str(spec["model"]), api_key
        self.catalog = catalog
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
        state = decider_state(self.catalog, context, kind, docs)
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


def decider_state(catalog: Catalog, context: str, kind: str, docs: Sequence[str]) -> str:
    """The decision model's state: the context, the numbered candidates and the kind's guidance."""
    listing = "\n".join(f"Candidate {n}: {d}" for n, d in enumerate(docs, start=1))
    state = f"Context of {catalog.decider_context}: {context}\n\nCandidate {kind} references:\n" + listing
    guidance = catalog.decider_guidance.get(kind)
    return f"{state}\n\n{guidance}" if guidance else state


# ── Index ───────────────────────────────────────────────────────────────────────────────────


class Index:
    """``index.json`` plus its vector sets, loaded from a local directory."""

    def __init__(self, index_dir: Path) -> None:
        self.dir = index_dir
        data = json.loads((index_dir / "index.json").read_text())
        if data["schema_version"] != SCHEMA_VERSION:
            raise ValueError(f"index schema {data['schema_version']} != supported {SCHEMA_VERSION}")
        self.catalog = Catalog.from_json(data["catalog"])
        self.version: str = data["index_version"]
        self.default_base_url: str = data["default_base_url"]
        self.params: dict[str, Any] = data["params"]
        self.lexicon: dict[str, dict[str, float]] = data["lexicon"]
        self.concepts: dict[str, dict[str, Any]] = data["concepts"]
        self.items: list[dict[str, Any]] = data["items"]
        self.vector_sets: dict[str, dict[str, Any]] = data["vector_sets"]
        strays = {i["kind"] for i in self.items} - set(self.catalog.kinds)
        if strays:
            raise ValueError(f"items of kinds {sorted(strays)} the catalog does not declare")
        self.rows = {k: [n for n, i in enumerate(self.items) if i["kind"] == k] for k in self.catalog.kinds}
        self.bm25 = {
            kind: Bm25(
                [tokenize(self.items[r]["doc"]) for r in rows],
                k1=self.params["bm25_k1"],
                b=self.params["bm25_b"],
            )
            for kind, rows in self.rows.items()
        }
        self._bm25_cache: dict[tuple[str, tuple[str, ...]], list[float]] = {}

    def bm25_scores(self, kind: str, tokens: Sequence[str]) -> list[float]:
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
    """A local index directory for ``source``: a directory, or a pointer (``latest.json``,
    ``latest.s<schema>.json``) / ``index.json`` URL (downloaded with its vector sets and models into
    ``cache_dir/<version>``, once).

    Safe for concurrent runs: the download goes to a per-process temp directory that is renamed into
    place, so ``cache_dir/<version>`` is either absent or complete. With a pointer source the
    ``index.json`` bytes must match its sha256."""
    if not source.startswith(("http://", "https://")):
        return Path(source)
    expected_sha: str | None = None
    if is_pointer(source):
        latest = json.loads(_get(source))
        expected_sha = latest.get("sha256")
        source = source.rsplit("/", 1)[0] + "/" + _safe_rel(latest["path"])  # e.g. "v3/index.json"
    base = source.rsplit("/", 1)[0] + "/"
    raw = _get(source)
    if expected_sha is not None and hashlib.sha256(raw).hexdigest() != expected_sha:
        raise ValueError(f"{source}: sha256 does not match its pointer")
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
        self.decider: Decider | None = (
            DeciderReranker(decider, featherless_api_key, index.catalog)
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
        cache = cache_dir or default_cache_dir()
        return cls(Index(fetch_index(source, cache)), base_url=base_url, decider_rerank=decider,
                   featherless_api_key=os.environ.get("FEATHERLESS_API_KEY") or None)  # fmt: skip

    def recommend(
        self,
        context: str,
        *,
        k: int = 3,
        kinds: Sequence[str] | None = None,
        filters: Mapping[str, FilterValue] | None = None,
    ) -> Recommendations:
        """Top ``k`` picks per kind (``kinds``: None = all, in catalog order). ``filters``: filter name
        -> value as the catalog declares them; an unknown filter or a wrongly typed value is a
        ValueError."""
        p, catalog = self.params, self.index.catalog
        wanted = catalog.check_kinds(kinds)
        active = catalog.check_filters(filters)
        q_concepts = {c: w for c, w in match_concepts(context, self.index.lexicon).items()}
        q_tokens = tokenize(context)
        q_vec = self.embedder.embed_query(context) if self.embedder else None
        picks: dict[str, list[Pick]] = {kind: [] for kind in wanted}
        decider_failed = False
        for kind in wanted:
            rows = [r for r in self.index.rows[kind] if _passes(self.index.items[r], active)]
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
                else:
                    decider_failed = True
            rel = [relevance.get(i, 0.0) for i in range(len(rows))]
            chosen = mmr_pick(order, rel, _pair_similarity(self, rows), k=k, lam=p["mmr_lambda"])
            picks[kind] = [self._pick(rows[i], rel[i], q_concepts) for i in chosen]
        decider = None
        if self.decider:
            decider = "unavailable: the decision model failed" if decider_failed else self.decider.model
        return Recommendations(
            catalog.key, self.index.version, context, q_concepts, self.dense_status, picks, decider
        )

    def _similarity(self, a: int, b: int) -> float:
        """Cosine of two items' concept weights (MMR's redundancy)."""
        ca, cb = self.index.items[a]["concepts"], self.index.items[b]["concepts"]
        norm = (dot(ca, ca) * dot(cb, cb)) ** 0.5
        return dot(ca, cb) / norm if norm else 0.0

    def _pick(self, row: int, score: float, q_concepts: Mapping[str, float]) -> Pick:
        item = self.index.items[row]
        kind, media, attrs = item["kind"], item["media"], item["attrs"]
        why = [
            f"{readable_concept(c)} {item['concepts'][c]:.1f}"
            for c in sorted(q_concepts, key=lambda c: -q_concepts[c] * item["concepts"].get(c, 0))
            if item["concepts"].get(c, 0) > 0
        ][:4]
        fields = self.index.catalog.result_fields.get(kind, [])
        common: dict[str, Any] = {
            "id": item["id"],
            "kind": kind,
            "title": item["title"],
            "score": round(score, 5),
            "attrs": {f: attrs[f] for f in fields if f in attrs},
        }
        if self.index.catalog.kinds[kind].media == "image":
            return Pick(**common, why=why, image=self._url(media["image"]))
        views = media["views"]
        best = max(views, key=lambda v: (self._view_score(v, q_concepts), -views.index(v)))
        best_view = f"best view: {best['angle']}" + (f" ({best['view']})" if best.get("view") else "")
        return Pick(
            **common,
            why=[*why, best_view],
            image=self._url(best["image"]),
            depth=self._optional_url(best.get("depth")),
            best_angle=best["angle"],
            views=[
                ViewUrls(v["angle"], self._url(v["image"]), self._optional_url(v.get("depth"))) for v in views
            ],
        )

    def _url(self, ref_key: str) -> str:
        return url(self.base_url, ref_key)

    def _optional_url(self, ref_key: str | None) -> str | None:
        return None if ref_key is None else url(self.base_url, ref_key)

    def _view_score(self, view: Mapping[str, Any], q_concepts: Mapping[str, float]) -> float:
        """How well a view presents what the query's concepts care about: the concepts' ``focus``
        weights (e.g. body parts) against the view's ``focus``."""
        wanted: dict[str, float] = {}
        for c, w in q_concepts.items():
            for part, fw in self.index.concepts.get(c, {}).get("focus", {}).items():
                wanted[part] = wanted.get(part, 0.0) + w * fw
        return dot(wanted, view["focus"])


def default_cache_dir() -> Path:
    """REFS_CACHE_DIR, else ~/.cache/refs-recommender when the home is writable, else the system temp
    dir (sandboxes run with an unwritable HOME)."""
    if env := os.environ.get("REFS_CACHE_DIR"):
        return Path(env)
    home_cache = Path.home() / ".cache" / "refs-recommender"
    try:
        home_cache.mkdir(parents=True, exist_ok=True)
        probe = home_cache / ".write-probe"
        probe.touch()
        probe.unlink()
        return home_cache
    except OSError:
        return Path(tempfile.gettempdir()) / "refs-recommender"


def _pair_similarity(rec: Recommender, rows: Sequence[int]) -> Callable[[int, int], float]:
    """Similarity of two candidates given by their position in ``rows``."""
    return lambda a, b: rec._similarity(rows[a], rows[b])


def readable_concept(name: str) -> str:
    """'label:archetype:office_secretary' -> 'archetype office secretary'; 'foot_fetish' -> 'foot fetish'."""
    return name.removeprefix("label:").replace(":", " ").replace("_", " ")


def _passes(item: Mapping[str, Any], active: Sequence[tuple[FilterSpec, FilterValue]]) -> bool:
    return all(spec.matches(item, value) for spec, value in active)


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
    ap = argparse.ArgumentParser(description="Top items per kind of a catalog for a text context.")
    ap.add_argument("context", nargs="?", default="")
    ap.add_argument("--index", default=os.environ.get("REFS_INDEX", ""), help="index dir or pointer URL")
    ap.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help="download cache (default: REFS_CACHE_DIR, ~/.cache or temp)",
    )
    ap.add_argument("--base-url", default=None)
    ap.add_argument("-k", type=int, default=3, help="picks per kind, at most the catalog's max_k")
    ap.add_argument("--kind", action="append", help="only this kind (repeatable; default: all)")
    ap.add_argument(
        "--filter", action="append", default=None, metavar="NAME=VALUE", help="repeatable; see --describe"
    )
    ap.add_argument("--describe", action="store_true", help="print the catalog descriptor and exit")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-decider", action="store_true", help="skip the decision-model rerank")
    a = ap.parse_args(argv)
    if not a.index:
        ap.error("--index (or REFS_INDEX) is required")
    rec = Recommender.load(a.index, cache_dir=a.cache_dir, base_url=a.base_url, decider=not a.no_decider)
    catalog = rec.index.catalog
    if a.describe:
        print(json.dumps(catalog.to_json(), indent=1))
        return 0
    if not a.context:
        ap.error("a context is required")
    if not 1 <= a.k <= catalog.max_k:
        ap.error(f"-k must be 1..{catalog.max_k} for this catalog")
    try:
        filters: Filters = dict(catalog.parse_filter(f) for f in a.filter or [])
        result = rec.recommend(a.context, k=a.k, kinds=a.kind, filters=filters)
    except ValueError as e:
        ap.error(str(e))
    if a.json:
        print(result.to_json())
        return 0
    print(f"{catalog.title} ({result.index_version})  concepts: {result.concepts}  dense: {result.dense}")
    for kind, picks in result.picks.items():
        print(f"\n{catalog.kinds[kind].label}:")
        for pick in picks:
            print(f"  {pick.id:28} {pick.score:.4f}  {pick.title}")
            print(f"       {pick.image}\n       why: {'; '.join(pick.why)}")
            if pick.attrs:
                print(f"       {', '.join(f'{k}: {v}' for k, v in pick.attrs.items())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
