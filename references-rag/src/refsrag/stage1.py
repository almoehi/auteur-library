"""Stage 1 of the query: tokenizer, concept-lexicon matching, BM25, rank fusion and MMR diversity.
Standard library only: this module is inlined into the shipped ``recommend.py`` and ported
verbatim to TypeScript, so the rules here are the contract both languages implement and
``golden.json`` pins.

Tokenizer: lower-case ASCII-folded words of letters and digits; everything else separates tokens,
so "school-girl" == "school girl" and "JOI" == "joi". An alias matches when its token sequence
occurs contiguously in the text's tokens.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Callable, Mapping
from typing import Final

MAX_ALIAS_TOKENS: Final = 4
_TOKEN: Final = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return _TOKEN.findall(folded)


def alias_key(alias: str) -> str:
    """The canonical form an alias is stored and looked up under."""
    return " ".join(tokenize(alias))


def match_concepts(text: str, aliases: Mapping[str, Mapping[str, float]]) -> dict[str, float]:
    """Concept -> weight for every alias found in ``text``; a concept found by several aliases keeps
    its highest weight. ``aliases`` maps alias_key -> {concept: weight}."""
    tokens = tokenize(text)
    found: dict[str, float] = {}
    for n in range(1, MAX_ALIAS_TOKENS + 1):
        for i in range(len(tokens) - n + 1):
            hit = aliases.get(" ".join(tokens[i : i + n]))
            if hit:
                for concept, weight in hit.items():
                    found[concept] = max(found.get(concept, 0.0), weight)
    return found


# ── Scoring (pure functions over lists: the same arithmetic in Python and TypeScript) ───────────


class Bm25:
    """Okapi BM25 over pre-tokenized documents."""

    def __init__(self, docs: list[list[str]], *, k1: float, b: float) -> None:
        self.k1, self.b = k1, b
        self.doc_len = [len(d) for d in docs]
        self.avg_len = (sum(self.doc_len) / len(docs)) if docs else 0.0
        self.tf: list[dict[str, int]] = []
        df: dict[str, int] = {}
        for d in docs:
            counts: dict[str, int] = {}
            for t in d:
                counts[t] = counts.get(t, 0) + 1
            self.tf.append(counts)
            for t in counts:
                df[t] = df.get(t, 0) + 1
        n = len(docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def scores(self, query: list[str]) -> list[float]:
        terms = sorted(set(query))
        out = []
        for counts, dl in zip(self.tf, self.doc_len, strict=True):
            s = 0.0
            norm = self.k1 * (1 - self.b + self.b * dl / self.avg_len) if self.avg_len else self.k1
            for t in terms:
                tf = counts.get(t, 0)
                if tf:
                    s += self.idf[t] * tf * (self.k1 + 1) / (tf + norm)
            out.append(s)
        return out


def dot(weights: Mapping[str, float], other: Mapping[str, float]) -> float:
    return sum(w * other.get(k, 0.0) for k, w in weights.items())


def rank_positions(scores: list[float]) -> list[int]:
    """0-based competition rank of each index by descending score: tied scores share the best rank
    of their group (so ties never favour a lower index)."""
    order = sorted(range(len(scores)), key=lambda i: (-scores[i], i))
    ranks = [0] * len(scores)
    for pos, i in enumerate(order):
        prev = order[pos - 1] if pos else None
        ranks[i] = ranks[prev] if prev is not None and scores[prev] == scores[i] else pos
    return ranks


def rrf(score_lists: list[list[float]], weights: list[float], *, k: float) -> list[float]:
    """Weighted reciprocal rank fusion over competition ranks. In a non-negative signal (BM25,
    concepts) a score of 0 means "no signal": such items get no credit from that list, and an
    all-zero list adds nothing. Signals that can go negative (dense cosine, rerank logits) rank all."""
    n = len(score_lists[0]) if score_lists else 0
    fused = [0.0] * n
    for scores, w in zip(score_lists, weights, strict=True):
        if w == 0 or not any(scores):
            continue
        sparse = min(scores) >= 0
        for i, r in enumerate(rank_positions(scores)):
            if not (sparse and scores[i] == 0):
                fused[i] += w / (k + r + 1)
    return fused


def mmr_pick(
    candidates: list[int],
    relevance: list[float],
    similarity: Callable[[int, int], float],
    *,
    k: int,
    lam: float,
) -> list[int]:
    """Maximal marginal relevance: k picks from ``candidates`` (indices), trading relevance for novelty.
    Relevance is min-max scaled over the candidates first, so it is on the same 0..1 scale as the
    similarity (fused RRF scores are ~0.01-0.05 and would otherwise be swamped by it)."""
    if not candidates:
        return []
    lo = min(relevance[i] for i in candidates)
    span = max(relevance[i] for i in candidates) - lo
    scaled = {i: (relevance[i] - lo) / span if span else 1.0 for i in candidates}
    picked: list[int] = []
    pool = list(candidates)
    while pool and len(picked) < k:

        def gain(i: int) -> float:
            novelty = max((similarity(i, j) for j in picked), default=0.0)
            return lam * scaled[i] - (1 - lam) * novelty

        best = max(pool, key=lambda i: (gain(i), -i))
        picked.append(best)
        pool.remove(best)
    return picked
