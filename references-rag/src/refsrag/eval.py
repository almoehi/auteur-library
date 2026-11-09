"""Calibration (P5): eval contexts from held-out iWantClips clips, pooled candidates graded by agents
(job ``eval_grade``), nDCG@3 per pipeline variant and a parameter grid search.

Pooling: every variant's top POOL_DEPTH per kind is graded once; an item no variant pooled counts
as 0 in later scoring, so grid-search variants are judged on the same pool. Because of that, the share
of a variant's top-3 picks that nobody judged is reported next to its score (``Score.unjudged``).

The contexts are split deterministically into a tune and a test half: the grid search picks parameters
on the tune half and the report shows both, so the winner's score is not its own selection bias.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
from collections.abc import Collection, Iterable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Final

from refsrag.descriptor import Catalog
from refsrag.jobs import BatchItem, item_sha, load_results
from refsrag.labels import EvalGrades
from refsrag.lake import clean_text, split_of
from refsrag.query import Index, Recommender
from refsrag.settings import PROJECT_ROOT
from refsrag.text import is_age_coded, is_english

EVAL_DIR: Final = PROJECT_ROOT / "eval"
CONTEXTS_FILE: Final = EVAL_DIR / "contexts.jsonl"
REPORT_FILE: Final = EVAL_DIR / "report.md"
POOL_DEPTH: Final = 8
POOL_WORKERS: Final = 3  # Featherless plan concurrency
PER_CONCEPT: Final = 2
MAX_CLIP_CONTEXTS: Final = 100
MAX_CONTEXT_CHARS: Final = 500

# The user's examples and edge cases the clip sample may miss.
HAND_CASES: Final[tuple[str, ...]] = (
    "college girl cosplay",
    "foot fetish, show me your soles",
    "ass worship, bend over and show your ass",
    "lingerie strip tease in stockings and garters",
    "doggy style sex",
    "cowgirl riding him",
    "missionary, legs on his shoulders",
    "femdom goddess in leather and boots",
    "secretary roleplay, the boss in his office",
    "nurse roleplay medical exam",
    "beach bikini tease",
    "cute girlfriend experience, romantic date night",
    "big tits tit worship",
    "spread legs pussy worship JOI",
    "jeans and leggings fetish, tight yoga pants",
    "halloween witch costume",
    "latex catsuit domination",
    "sock fetish, white knee socks",
)

VARIANTS: Final[dict[str, dict[str, Any]]] = {
    "stage1": {"vector_set": None, "rerank": False},
    "bge": {"vector_set": "local:bge-small-en-v1.5", "rerank": False},
    "qwen06": {"vector_set": "featherless:Qwen/Qwen3-Embedding-0.6B", "rerank": False},
    "qwen4": {"vector_set": "featherless:Qwen/Qwen3-Embedding-4B", "rerank": False},
    "bge+ce": {"vector_set": "local:bge-small-en-v1.5", "rerank": True},
    "qwen06+ce": {"vector_set": "featherless:Qwen/Qwen3-Embedding-0.6B", "rerank": True},
    "qwen4+ce": {"vector_set": "featherless:Qwen/Qwen3-Embedding-4B", "rerank": True},
    "qwen06+decider": {
        "vector_set": "featherless:Qwen/Qwen3-Embedding-0.6B",
        "rerank": False,
        "decider_rerank": True,
    },
    "qwen4+decider": {
        "vector_set": "featherless:Qwen/Qwen3-Embedding-4B",
        "rerank": False,
        "decider_rerank": True,
    },
}
GRID: Final[dict[str, tuple[float, ...]]] = {
    "w_bm25": (0.5, 1.0),
    "w_concept": (1.0, 2.0, 3.0),
    "w_dense": (0.5, 1.0, 2.0),
    "mmr_lambda": (0.6, 0.7, 0.8, 1.0),  # 0.7 is the index default
}


@dataclass(frozen=True)
class EvalContext:
    id: str
    text: str
    source: str  # "iwc:<clip_id>" or "hand"
    concepts: tuple[str, ...]  # the clip's category concepts (empty for hand cases)


def sample_contexts(
    clips: Iterable[Mapping[str, Any]], concept_categories: Mapping[str, Sequence[str]]
) -> list[EvalContext]:
    """Up to PER_CONCEPT held-out clips per mined concept (most popular first, each clip once), taken
    round-robin (one per concept, then a second per concept) up to MAX_CLIP_CONTEXTS, then the hand cases."""
    member_of: dict[str, set[str]] = {}
    for concept, cats in concept_categories.items():
        for cat in cats:
            member_of.setdefault(cat, set()).add(concept)
    pool = []
    for c in clips:
        title, desc = clean_text(c.get("title")), clean_text(c.get("description"))
        texts = [title, desc, *(c.get("categories") or []), *(c.get("keywords") or [])]
        if c.get("media_kind") != "video" or not title or split_of(str(c["clip_id"])) != "heldout":
            continue
        if not all(is_english(t) for t in texts) or any(is_age_coded(t) for t in texts):
            continue
        concepts = tuple(sorted({k for cat in c.get("categories") or [] for k in member_of.get(cat, ())}))
        if concepts:
            text = f"{title}. {desc}"[:MAX_CONTEXT_CHARS].rstrip()
            pool.append((float(c.get("popularity") or 0), str(c["clip_id"]), text, concepts))
    pool.sort(key=lambda t: (-t[0], t[1]))
    chosen: dict[str, EvalContext] = {}
    for _ in range(PER_CONCEPT):  # round-robin: the cap must not starve the concepts late in the alphabet
        for concept in sorted(concept_categories):
            clip = next(((i, t, cs) for _, i, t, cs in pool if concept in cs and i not in chosen), None)
            if clip is not None and len(chosen) < MAX_CLIP_CONTEXTS:
                clip_id, text, concepts = clip
                chosen[clip_id] = EvalContext(f"iwc-{clip_id}", text, f"iwc:{clip_id}", concepts)
    hand = [EvalContext(f"hand-{n:02d}", t, "hand", ()) for n, t in enumerate(HAND_CASES, start=1)]
    return [*chosen.values(), *hand]


def write_contexts(contexts: Sequence[EvalContext]) -> None:
    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    CONTEXTS_FILE.write_text("".join(json.dumps(asdict(c)) + "\n" for c in contexts))


def read_contexts() -> list[EvalContext]:
    rows = [json.loads(line) for line in CONTEXTS_FILE.read_text().splitlines() if line.strip()]
    return [EvalContext(r["id"], r["text"], r["source"], tuple(r["concepts"])) for r in rows]


def is_tune(context_id: str) -> bool:
    """The deterministic tune/test split: the parity of the sha256 of the context id."""
    return hashlib.sha256(context_id.encode()).digest()[0] % 2 == 0


def split_contexts(contexts: Sequence[EvalContext]) -> tuple[list[EvalContext], list[EvalContext]]:
    """(tune, test) halves."""
    return [c for c in contexts if is_tune(c.id)], [c for c in contexts if not is_tune(c.id)]


_USED_FOR = re.compile(r"(?:^|\.\s+)Used for:.*\Z", re.DOTALL)


def strip_used_for(doc: str) -> str:
    """``doc`` without its final "Used for: ..." sentence (mined lexicon aliases): graders must judge
    the item itself, not the lexicon that the pipeline matches against."""
    return _USED_FOR.sub("", doc)


def ranking(rec: Recommender, context: str, kind: str, depth: int) -> list[str]:
    # pools go deeper than the catalog's max_k, so the unbounded variant
    return [p.id for p in rec._recommend(context, depth, [kind]).picks[kind]]


EXTRA_SEP: Final = "+extra"  # id suffix of an incremental grading item (new pool members only)


def grade_items(
    index: Index,
    contexts: Sequence[EvalContext],
    recommenders: Mapping[str, Recommender],
    graded: Mapping[str, Mapping[str, int]] | None = None,
) -> list[BatchItem]:
    """One ``eval_grade`` item per context: the union of every variant's top POOL_DEPTH per kind.
    With ``graded``, only the pool members not graded yet (items ``<context>+extra``)."""
    by_id = {i["id"]: i for i in index.items}

    def pool_of(ctx: EvalContext) -> dict[str, None]:
        pooled: dict[str, None] = {}
        for rec in recommenders.values():
            for kind in index.catalog.kinds:
                pooled.update(dict.fromkeys(ranking(rec, ctx.text, kind, POOL_DEPTH)))
        return pooled

    with ThreadPoolExecutor(POOL_WORKERS) as ex:  # the remote rerankers / embedders dominate
        pools = list(ex.map(pool_of, contexts))
    items = []
    for ctx, pooled in zip(contexts, pools, strict=True):
        if graded is not None:
            pooled = {i: None for i in pooled if i not in graded.get(ctx.id, {})}
            if not pooled:
                continue
        candidates = [
            {
                "id": i,
                "kind": by_id[i]["kind"],
                "title": by_id[i]["title"],
                "doc": strip_used_for(by_id[i]["doc"]),
            }
            for i in sorted(pooled)
        ]
        inputs = {"context": ctx.text, "items": candidates}
        item_id = ctx.id + (EXTRA_SEP if graded is not None else "")
        items.append(BatchItem(id=item_id, sha256=item_sha("eval_grade", [], inputs), inputs=inputs))
    return items


def ndcg_at_3(ranked: Sequence[str], grades: Mapping[str, int], kind_ids: Iterable[str]) -> float | None:
    """nDCG@3 against the graded pool of this kind; None when nothing of the kind is relevant."""
    ideal = sorted((grades.get(i, 0) for i in kind_ids), reverse=True)[:3]
    idcg = sum(g / math.log2(r + 2) for r, g in enumerate(ideal))
    if idcg == 0:
        return None
    return sum(grades.get(i, 0) / math.log2(r + 2) for r, i in enumerate(ranked[:3])) / idcg


@dataclass(frozen=True)
class Score:
    kinds: dict[str, float]  # mean nDCG@3 per kind, in catalog order
    contexts: int  # contexts actually scored: graded, and with something relevant for at least one kind
    unjudged: float  # share of the top-3 picks that no grader saw (they count as 0)

    @property
    def mean(self) -> float:
        return sum(self.kinds.values()) / len(self.kinds) if self.kinds else 0.0


@dataclass(frozen=True)
class SplitScore:
    tune: Score
    test: Score


def score(
    rec: Recommender,
    contexts: Sequence[EvalContext],
    grades: Mapping[str, Mapping[str, int]],
    kind_of: Mapping[str, str],
) -> Score:
    """Mean nDCG@3 per kind over the graded contexts. Grades of items missing from ``kind_of`` (no longer
    in the index) are ignored."""
    kinds = list(rec.index.catalog.kinds)
    jobs = [(ctx, kind) for ctx in contexts if ctx.id in grades for kind in kinds]
    with ThreadPoolExecutor(POOL_WORKERS) as ex:  # remote rerank calls dominate; results are cached
        ranked = list(ex.map(lambda job: ranking(rec, job[0].text, job[1], 3), jobs))
    per_kind: dict[str, list[float]] = {kind: [] for kind in kinds}
    scored: set[str] = set()
    picks = unjudged = 0
    for (ctx, kind), top in zip(jobs, ranked, strict=True):
        g = grades[ctx.id]
        picks += len(top)
        unjudged += sum(i not in g for i in top)
        value = ndcg_at_3(top, g, [i for i in g if kind_of.get(i) == kind])
        if value is not None:
            per_kind[kind].append(value)
            scored.add(ctx.id)
    return Score(
        {k: round(sum(v) / len(v), 4) if v else 0.0 for k, v in per_kind.items()},
        len(scored),
        round(unjudged / picks, 4) if picks else 0.0,
    )


def load_grades(known_ids: Collection[str]) -> dict[str, dict[str, int]]:
    """Context id -> item id -> grade, merging the incremental (``+extra``) gradings into their context.
    Grades of items not in ``known_ids`` (the current index) are dropped."""
    grades: dict[str, dict[str, int]] = {}
    for k, r in load_results("eval_grade").items():
        if isinstance(r, EvalGrades):
            kept = {i: g for i, g in r.grades.items() if i in known_ids}
            grades.setdefault(k.removesuffix(EXTRA_SEP), {}).update(kept)
    return grades


def grid(rec: Recommender) -> Iterable[dict[str, Any]]:
    """The grid around ``rec``'s params; ``w_dense`` is only searched with dense retrieval."""
    keys = [k for k in GRID if k != "w_dense" or rec.embedder is not None]
    for values in itertools.product(*(GRID[k] for k in keys)):
        yield {**rec.params, **dict(zip(keys, values, strict=True))}


def _pct(share: float) -> str:
    return f"{share:.0%}"


def write_report(
    catalog: Catalog,
    variant_scores: Mapping[str, SplitScore],
    best: Mapping[str, tuple[dict[str, Any], SplitScore]],
    tune_contexts: int,
    test_contexts: int,
) -> Path:
    test_cols = " | ".join(f"Test {spec.label.lower()}" for spec in catalog.kinds.values())
    rule = "|---" * (5 + len(catalog.kinds))
    lines = [
        "# Calibration report (P5)",
        "",
        "Contexts: held-out iWantClips clips stratified by mined concept, plus hand cases, split by the",
        f"sha256 of the context id into a tune half ({tune_contexts}) and a test half ({test_contexts}).",
        "Metric: nDCG@3 against agent grades (0-3) of the pooled candidates; an unjudged pick counts as 0.",
        "Unjudged = share of the top-3 picks no grader saw (tune / test). Contexts = scored (tune / test).",
        "",
        "## Variants (index defaults)",
        "",
        f"| Variant | Tune mean | {test_cols} | Test mean | Unjudged | Contexts |",
        rule + "|",
        *[_row(n, s) for n, s in variant_scores.items()],
        "",
        "## Best parameters per variant (grid search on the tune half; test half is the honest number)",
        "",
        f"| Variant | Tune mean | {test_cols} | Test mean | Unjudged | Contexts | Params |",
        rule + "|---|",
    ]
    for n, (params, s) in best.items():
        shown = {k: params[k] for k in GRID}
        lines.append(f"{_row(n, s)} `{json.dumps(shown)}` |")
    REPORT_FILE.write_text("\n".join(lines) + "\n")
    return REPORT_FILE


def _row(name: str, s: SplitScore) -> str:
    per_kind = " | ".join(f"{v:.3f}" for v in s.test.kinds.values())
    return (
        f"| {name} | {s.tune.mean:.3f} | {per_kind} | {s.test.mean:.3f} "
        f"| {_pct(s.tune.unjudged)} / {_pct(s.test.unjudged)} | {s.tune.contexts} / {s.test.contexts} |"
    )
