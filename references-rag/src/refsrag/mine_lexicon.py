"""Mine the concept lexicon from the content lake snapshot (``refs export-lake``), automatically.

1. ``category_pool``: the categories worth grouping (most videos first; age-coded and non-English
   ones never). The agent job ``lexicon_concepts`` groups them into concepts.
2. ``alias_candidates``: per concept, the n-grams (and clip keywords) whose document frequency in the
   concept's clips most exceeds the rest (smoothed log-odds z-score, ``mine`` split only). The agent
   job ``alias_filter`` keeps the precise ones and weights them.
3. ``build_lexicon``: category names + filtered aliases -> alias_key -> {concept: weight}.
4. ``validate``: on the ``heldout`` split, does the lexicon find a clip's own concepts in its title and
   description? Per-concept precision / recall decide which concepts get another mining round.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Final

import yaml

from refsrag.jobs import BatchItem, item_sha
from refsrag.labels import ConceptGrouping
from refsrag.lake import split_of
from refsrag.settings import PROJECT_ROOT
from refsrag.stage1 import MAX_ALIAS_TOKENS, alias_key, match_concepts, tokenize
from refsrag.text import is_age_coded, is_english

CATEGORY_POOL_SIZE: Final = 300
MAX_NGRAM: Final = 3
MIN_CONCEPT_DOCS: Final = 8  # an alias candidate must occur in at least this many of the concept's clips
PRIOR: Final = 0.5  # additive smoothing of the log-odds
# Words that never make an alias on their own (they still occur inside longer n-grams).
STOPWORDS: Final = frozenset(
    (
        "a an and are as at be but by for from has have he her hers him his i if in into is it its just me "
        "my myself no not of on or our own so than that the their them then there these they this to too "
        "up us was we were what when which while who will with you your yours yourself all can do don get "
        "got how more now out over very am im ill ive youre youll dont cant let make go going want need "
        "know see one two new video clip clips custom hd 4k 1080p mp4 full minutes min"
    ).split()
)
_NOISE: Final = re.compile(r"https?://\S+|www\.\S+|<[^>]*>|&[a-z]+;")  # URLs, HTML tags and entities


@dataclass(frozen=True)
class CategoryInfo:
    name: str
    video_count: int
    description: str
    sample_titles: tuple[str, ...]


@dataclass(frozen=True)
class AliasCandidate:
    alias: str  # alias_key form
    concept_docs: int  # clips of the concept containing it
    other_docs: int
    z: float


@dataclass
class ConceptScore:
    support: int  # held-out clips that carry the concept
    predicted: int
    hits: int

    @property
    def precision(self) -> float:
        return self.hits / self.predicted if self.predicted else 0.0

    @property
    def recall(self) -> float:
        return self.hits / self.support if self.support else 0.0


@dataclass
class ValidationReport:
    clips: int
    per_concept: dict[str, ConceptScore] = field(default_factory=dict)

    def mean_recall(self) -> float:
        scored = [s.recall for s in self.per_concept.values() if s.support]
        return sum(scored) / len(scored) if scored else 0.0


def read_clips(path: Path) -> list[dict[str, Any]]:
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def clip_text(clip: Mapping[str, Any], *, with_keywords: bool) -> str:
    parts = [clip.get("title") or "", _NOISE.sub(" ", clip.get("description") or "")]
    if with_keywords:
        parts += clip.get("keywords") or []
    return "\n".join(parts)


def category_pool(
    categories: Sequence[Mapping[str, Any]], clips: Sequence[Mapping[str, Any]]
) -> list[CategoryInfo]:
    """The CATEGORY_POOL_SIZE categories with most videos, each with up to 3 popular sample titles."""
    titles: dict[str, list[tuple[int, str]]] = {}
    for c in clips:
        for name in c.get("categories") or []:
            titles.setdefault(name, []).append((c.get("popularity") or 0, c.get("title") or ""))
    usable = [
        c
        for c in categories
        if c.get("name") and is_english(c["name"]) and not is_age_coded(c["name"]) and c.get("video_count")
    ]
    usable.sort(key=lambda c: (-int(c["video_count"]), c["name"]))
    return [
        CategoryInfo(
            name=c["name"],
            video_count=int(c["video_count"]),
            description=(c.get("description") or "")[:300],
            sample_titles=tuple(
                t
                for _, t in sorted(titles.get(c["name"], []), reverse=True)[:3]
                if is_english(t) and not is_age_coded(t)
            ),
        )
        for c in usable[:CATEGORY_POOL_SIZE]
    ]


def alias_candidates(
    concept_categories: Mapping[str, Iterable[str]], clips: Sequence[Mapping[str, Any]], *, top_k: int
) -> dict[str, list[AliasCandidate]]:
    """Per concept, the top_k n-grams over-represented in its ``mine`` clips (doc frequency log-odds)."""
    member_of: dict[str, set[str]] = {}
    for concept, cats in concept_categories.items():
        for cat in cats:
            member_of.setdefault(cat, set()).add(concept)
    docs = [
        (_concepts_of(c, member_of), _doc_terms(c)) for c in clips if split_of(str(c["clip_id"])) == "mine"
    ]
    total = Counter(t for _, terms in docs for t in terms)
    n_docs = len(docs)
    out: dict[str, list[AliasCandidate]] = {}
    for concept in concept_categories:
        inside = [terms for concepts, terms in docs if concept in concepts]
        df_in = Counter(t for terms in inside for t in terms)
        n_in, n_out = len(inside), n_docs - len(inside)
        scored = [
            AliasCandidate(term, a, total[term] - a, _log_odds_z(a, n_in, total[term] - a, n_out))
            for term, a in df_in.items()
            if a >= MIN_CONCEPT_DOCS and not is_age_coded(term)
        ]
        out[concept] = sorted(scored, key=lambda s: (-s.z, s.alias))[:top_k]
    return out


def build_lexicon(
    concept_categories: Mapping[str, Iterable[str]], selected: Mapping[str, Mapping[str, float]]
) -> dict[str, dict[str, float]]:
    """alias_key -> {concept: weight}: every member category name (and each '-' part of it) at 1.0,
    plus the filtered aliases. A category name belongs to exactly the concepts holding that category:
    a filtered alias equal to it never adds another concept ("ass worship" stays ass_worship's even
    if body_goddess_worship's filter kept it). Age-coded aliases never enter."""
    lexicon: dict[str, dict[str, float]] = {}
    category_keys = {
        alias_key(part)
        for cats in concept_categories.values()
        for c in cats
        for part in category_alias_parts(c)
    }

    def add(alias: str, concept: str, weight: float) -> None:
        key = alias_key(alias)
        if key and len(key.split()) <= MAX_ALIAS_TOKENS and not is_age_coded(key):
            slot = lexicon.setdefault(key, {})
            slot[concept] = max(slot.get(concept, 0.0), weight)

    for concept, cats in concept_categories.items():
        add(concept.replace("_", " "), concept, 1.0)
        for cat in cats:
            for part in category_alias_parts(cat):
                add(part, concept, 1.0)
    for concept, aliases in selected.items():
        for alias, weight in aliases.items():
            key = alias_key(alias)
            if key not in category_keys or concept in lexicon.get(key, {}):
                add(alias, concept, weight)
    return dict(sorted(lexicon.items()))


def category_alias_parts(category: str) -> list[str]:
    """The aliases a category name gives: the whole name, and each '-' part that is not a stopword
    ("Jerk Off Instruction-JOI" -> "jerk off instruction", "joi"; "Strap-On" -> "strap on" only)."""
    parts = [p for p in category.split("-")[1:] if p.strip()] if "-" in category else []
    head = category.split("-")[0] if "-" in category else ""
    candidates = [category, *([head] if head else []), *parts]
    return [
        c
        for c in candidates
        if (k := alias_key(c)) and not (len(k.split()) == 1 and (k in STOPWORDS or len(k) < 2))
    ]


def common_words(clips: Iterable[Mapping[str, Any]], *, share: float) -> set[str]:
    """Single words that occur in more than ``share`` of the clips' titles + descriptions: too common
    in this domain to stand alone as an alias ("back", "face", "party")."""
    df: Counter[str] = Counter()
    n = 0
    for clip in clips:
        n += 1
        df.update(set(tokenize(clip_text(clip, with_keywords=False))))
    return {w for w, f in df.items() if n and f / n > share}


def validate(
    lexicon: Mapping[str, Mapping[str, float]],
    concept_categories: Mapping[str, Iterable[str]],
    clips: Sequence[Mapping[str, Any]],
    *,
    min_weight: float = 0.5,
) -> ValidationReport:
    """Held-out clips: predicted = concepts the lexicon finds in title + description (keywords and
    categories are NOT used, as a query context will not have them); gold = the clip's categories."""
    member_of: dict[str, set[str]] = {}
    for concept, cats in concept_categories.items():
        for cat in cats:
            member_of.setdefault(cat, set()).add(concept)
    report = ValidationReport(clips=0)
    for concept in concept_categories:
        report.per_concept[concept] = ConceptScore(0, 0, 0)
    for clip in clips:
        if split_of(str(clip["clip_id"])) != "heldout":
            continue
        report.clips += 1
        gold = _concepts_of(clip, member_of)
        found = {
            c
            for c, w in match_concepts(clip_text(clip, with_keywords=False), lexicon).items()
            if w >= min_weight
        }
        for c in gold:
            report.per_concept[c].support += 1
        for c in found:
            score = report.per_concept.setdefault(c, ConceptScore(0, 0, 0))
            score.predicted += 1
            score.hits += c in gold
    return report


def _concepts_of(clip: Mapping[str, Any], member_of: Mapping[str, set[str]]) -> set[str]:
    return {c for cat in clip.get("categories") or [] for c in member_of.get(cat, ())}


def _doc_terms(clip: Mapping[str, Any]) -> set[str]:
    """The candidate aliases one clip contains: its 1..MAX_NGRAM-grams (not all stopwords, not pure
    numbers) and its keywords as whole phrases."""
    tokens = tokenize(clip_text(clip, with_keywords=False))
    terms = {alias_key(k) for k in clip.get("keywords") or [] if is_english(k)}
    terms.update(_ngrams(tokens))
    terms.discard("")
    return terms


def _ngrams(tokens: Sequence[str]) -> Iterator[str]:
    for n in range(1, MAX_NGRAM + 1):
        for i in range(len(tokens) - n + 1):
            gram = tokens[i : i + n]
            if all(t in STOPWORDS for t in gram) or gram[0] in STOPWORDS or gram[-1] in STOPWORDS:
                continue
            if any(not t.isalpha() for t in gram):  # numbers and codes like "lynch100"
                continue
            yield " ".join(gram)


def _log_odds_z(a: int, n_in: int, b: int, n_out: int) -> float:
    """z-score of the smoothed log-odds ratio of a term's document frequency inside vs outside."""
    if n_in == 0 or n_out == 0:
        return 0.0
    p = PRIOR
    lo_in = math.log((a + p) / (n_in - a + p))
    lo_out = math.log((b + p) / (n_out - b + p))
    var = 1 / (a + p) + 1 / (n_in - a + p) + 1 / (b + p) + 1 / (n_out - b + p)
    return (lo_in - lo_out) / math.sqrt(var)


# ── Agent-job items and outputs ─────────────────────────────────────────────────────────────

VOCAB_FILE: Final = PROJECT_ROOT / "vocab.yaml"
LEXICON_FILE: Final = PROJECT_ROOT / "lexicon.json"
REPORT_FILE: Final = PROJECT_ROOT / "lexicon_report.md"
GATE_RECALL: Final = 0.6  # a kept concept below this gets another mining round


def concept_items(pool: Sequence[CategoryInfo]) -> list[BatchItem]:
    """The single ``lexicon_concepts`` item: the whole category pool."""
    inputs = {"categories": [asdict(c) for c in pool]}
    return [BatchItem(id="concepts", sha256=item_sha("lexicon_concepts", [], inputs), inputs=inputs)]


def alias_item_id(concept: str, round_no: int) -> str:
    """``alias_filter`` item ids carry the mining round, so every round's selection is kept."""
    return f"{concept}#r{round_no}"


def merge_selections(selections: Mapping[str, Mapping[str, float]]) -> dict[str, dict[str, float]]:
    """Concept -> alias -> weight over every round (item id ``<concept>#r<n>``, or a bare concept
    name from before rounds were tracked); an alias kept in several rounds keeps its highest weight."""
    merged: dict[str, dict[str, float]] = {}
    for item_id, aliases in selections.items():
        slot = merged.setdefault(item_id.split("#", 1)[0], {})
        for alias, weight in aliases.items():
            slot[alias] = max(slot.get(alias, 0.0), weight)
    return merged


def alias_items(
    grouping: ConceptGrouping, candidates: Mapping[str, Sequence[AliasCandidate]], *, round_no: int
) -> list[BatchItem]:
    """One ``alias_filter`` item per concept that has candidates, for mining round ``round_no``."""
    items = []
    for concept in grouping.concepts:
        cands = candidates.get(concept.name, [])
        if not cands:
            continue
        inputs = {
            "concept": concept.name,
            "type": concept.type,
            "description": concept.description,
            "categories": concept.categories,
            "candidates": [asdict(c) | {"z": round(c.z, 2)} for c in cands],
        }
        item_id = alias_item_id(concept.name, round_no)
        items.append(BatchItem(id=item_id, sha256=item_sha("alias_filter", [], inputs), inputs=inputs))
    return items


def concept_categories_of(grouping: ConceptGrouping) -> dict[str, list[str]]:
    return {c.name: list(c.categories) for c in grouping.concepts}


def write_outputs(
    grouping: ConceptGrouping, lexicon: Mapping[str, Mapping[str, float]], report: ValidationReport
) -> list[str]:
    """Write vocab.yaml, lexicon.json and lexicon_report.md; return the concepts failing the gates."""
    vocab = {
        "concepts": {
            c.name: {"type": c.type, "description": c.description, "categories": list(c.categories)}
            for c in grouping.concepts
        },
        "dropped_categories": list(grouping.dropped),
    }
    VOCAB_FILE.write_text(
        "# Mined by `refs lexicon build` from the content lake; do not edit by hand.\n"
        + yaml.safe_dump(vocab, sort_keys=False, allow_unicode=False)
    )
    LEXICON_FILE.write_text(json.dumps({"version": 1, "aliases": lexicon}, indent=1, sort_keys=True) + "\n")
    weak = [c for c, s in report.per_concept.items() if s.support >= 5 and s.recall < GATE_RECALL]
    rows = sorted(report.per_concept.items(), key=lambda kv: -kv[1].support)
    lines = [
        "# Lexicon validation (held-out clips)",
        "",
        f"Held-out clips: {report.clips}. Concepts: {len(grouping.concepts)}. Aliases: {len(lexicon)}. "
        f"Mean recall: {report.mean_recall():.3f}.",
        f"Gate (concepts with support >= 5): recall >= {GATE_RECALL}.",
        "",
        "Precision is a LOWER BOUND: a clip carries only 1-3 categories while its text names more",
        "(a JOI clip mentioning stockings is not tagged Pantyhose), so many 'false' positives are right.",
        "It is reported, not gated.",
        "",
        "Predicted from title + description only; gold = the concepts of the clip's own categories.",
        "",
        "| Concept | Type | Support | Precision (lower bound) | Recall | Gate |",
        "|---|---|---|---|---|---|",
    ]
    types = {c.name: c.type for c in grouping.concepts}
    for name, s in rows:
        gate = "below" if name in weak else ("n/a" if s.support < 5 else "ok")
        cells = [name, types.get(name, "?"), str(s.support), f"{s.precision:.2f}", f"{s.recall:.2f}", gate]
        lines.append("| " + " | ".join(cells) + " |")
    REPORT_FILE.write_text("\n".join(lines) + "\n")
    return weak
