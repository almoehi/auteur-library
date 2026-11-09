"""Items of the text-only ``concept_affinity`` job: each vision-labelled outfit and pose, summarised,
to be weighted against the mined concepts (vocab.yaml). Separate from the vision jobs so that a
lexicon change re-runs only this cheap job, never the image labelling."""

from __future__ import annotations

import hashlib
from typing import Final

import yaml

from refsrag.jobs import BatchItem, item_sha, load_results
from refsrag.labels import OutfitVision, PoseVision, Record
from refsrag.mine_lexicon import VOCAB_FILE
from refsrag.settings import PROJECT_ROOT

CONCEPTS_FILE: Final = PROJECT_ROOT / "jobs" / "concept_affinity" / "concepts.md"


def concept_names() -> list[str]:
    vocab = yaml.safe_load(VOCAB_FILE.read_text())
    return list(vocab["concepts"])


def write_concepts_file() -> str:
    """Write the concept list the agents weight against; returns its sha256 (part of every item key)."""
    vocab = yaml.safe_load(VOCAB_FILE.read_text())
    lines = ["# Concepts (name - type: what it means for a pose or an outfit)", ""]
    lines += [f"- `{name}` - {c['type']}: {c['description']}" for name, c in vocab["concepts"].items()]
    text = "\n".join(lines) + "\n"
    CONCEPTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONCEPTS_FILE.write_text(text)
    return hashlib.sha256(text.encode()).hexdigest()


def affinity_items() -> list[BatchItem]:
    concepts_sha = write_concepts_file()
    labels: list[tuple[str, Record]] = [("outfit", r) for r in load_results("outfit_vision").values()]
    labels += [("pose", r) for r in load_results("pose_vision").values()]
    items = []
    for kind, record in labels:
        inputs = {"kind": kind, "label": summary(record)}
        sha = item_sha("concept_affinity", [record.sha256, concepts_sha], inputs)
        items.append(BatchItem(id=f"{kind}:{record.id}", sha256=sha, inputs=inputs))
    return items


def summary(record: Record) -> dict[str, object]:
    """What the agent needs to weigh an item: its vision labels, poses reduced to their strongest views."""
    if isinstance(record, OutfitVision):
        return record.model_dump(
            include={"description_en", "garments", "archetypes", "exposure", "accentuated", "footwear"}
        )
    if isinstance(record, PoseVision):
        focus: dict[str, float] = {}
        for view in record.views.values():
            for part, w in view.focus.items():
                focus[part] = max(focus.get(part, 0.0), w)
        return record.model_dump(
            include={"name_en", "description_en", "support", "mood", "sex_positions", "typical_acts"}
        ) | {"max_focus": focus}
    raise TypeError(f"no summary for {type(record).__name__}")
