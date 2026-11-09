"""Agreement between the main vision labels and the independent QA re-labels (5% sample): the gate
of P3 is >= 0.7 on the top archetype / top focus part."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass

from refsrag.jobs import JobName, load_results
from refsrag.labels import OutfitVision, PoseVision, Record


@dataclass(frozen=True)
class Agreement:
    items: int
    scores: dict[str, float]  # measure -> share of items that agree


def outfit_agreement() -> Agreement:
    pairs = _pairs("outfit_vision", "qa_outfit", OutfitVision)
    return Agreement(
        len(pairs),
        _shares(
            pairs,
            {
                "top_archetype": lambda a, b: _top(a.archetypes) in _top_n(b.archetypes, 2),
                "top_accentuated": lambda a, b: _top(a.accentuated) in _top_n(b.accentuated, 2),
                "footwear": lambda a, b: a.footwear == b.footwear,
                "exposure_within_1": lambda a, b: abs(a.exposure - b.exposure) <= 1,
            },
        ),
    )


def pose_agreement() -> Agreement:
    pairs = _pairs("pose_vision", "qa_pose", PoseVision)

    def top_focus_per_view(a: PoseVision, b: PoseVision) -> bool:
        views = a.views.keys() & b.views.keys()
        hits = [_top(a.views[v].focus) in _top_n(b.views[v].focus, 2) for v in views]
        return bool(hits) and sum(hits) / len(hits) >= 0.6

    return Agreement(
        len(pairs),
        _shares(
            pairs,
            {
                "support": lambda a, b: a.support == b.support,
                "top_focus_per_view": top_focus_per_view,
                "sex_positions_overlap": lambda a, b: (
                    (not a.sex_positions and not b.sex_positions)
                    or bool(set(a.sex_positions) & set(b.sex_positions))
                ),
            },
        ),
    )


def _pairs[R: Record](main: JobName, qa: JobName, model: type[R]) -> list[tuple[R, R]]:
    a, b = load_results(main), load_results(qa)
    out = []
    for k in sorted(a.keys() & b.keys()):
        ra, rb = a[k], b[k]
        if isinstance(ra, model) and isinstance(rb, model):
            out.append((ra, rb))
    return out


def _shares[R](pairs: list[tuple[R, R]], measures: Mapping[str, Callable[[R, R], bool]]) -> dict[str, float]:
    n = len(pairs) or 1
    return {name: round(sum(f(a, b) for a, b in pairs) / n, 3) for name, f in measures.items()}


def _top[K: str](weights: Mapping[K, float]) -> K | None:
    return max(weights, key=lambda k: weights[k]) if weights else None


def _top_n[K: str](weights: Mapping[K, float], n: int) -> list[K | None]:
    top: list[K | None] = [k for k in sorted(weights, key=lambda k: -weights[k])[:n]]
    return top or [None]
