"""Agent jobs: work done by Claude Code subagents (vision labelling, lexicon grouping, alias
filtering), exchanged through files so it is deterministic on both ends, resumable and re-runnable.

Layout per job (``jobs/<job>/``):
  PROMPT.md               the agent instructions (committed)
  batches/batch_NNNN.json the inputs of one agent run (generated; machine paths, not committed)
  out/batch_NNNN.json     the agent's output: a JSON array of records (not committed)
  results.jsonl           validated records, one per item id (committed: these ARE the labels)

``make_batches`` first collects any finished outputs, then batches only the items without a valid
result for their current sha256 (the item's cache key: every input the agent sees plus the job's
version), so re-runs after library or prompt changes redo only what changed. ``collect`` accepts a
batch only when its whole output validates; otherwise the batch stays pending.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, ValidationError

from refsrag.labels import (
    AliasSelection,
    ConceptAffinity,
    ConceptGrouping,
    EvalGrades,
    OutfitVision,
    PoseVision,
    Record,
)
from refsrag.settings import PROJECT_ROOT

JobName = Literal[
    "outfit_vision",
    "pose_vision",
    "qa_outfit",
    "qa_pose",
    "concept_affinity",
    "lexicon_concepts",
    "alias_filter",
    "eval_grade",
]

JOBS_ROOT: Final = PROJECT_ROOT / "jobs"
log = logging.getLogger(__name__)


class BatchItem(BaseModel):
    """One item of a batch: its id, its cache key and the job-specific inputs the agent reads."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    sha256: str
    inputs: dict[str, Any]  # a job's inputs model, dumped (see prepare.py / mine_lexicon.py)


ItemCheck = Callable[[BatchItem, Record], None]  # raises ValueError when a record does not fit its item


def _views_complete(item: BatchItem, record: Record) -> None:
    labelled, given = set(getattr(record, "views", {})), set(item.inputs["views"])
    if labelled != given:
        raise ValueError(f"{item.id}: views labelled {sorted(labelled)} != given {sorted(given)}")


def _known_concepts(item: BatchItem, record: Record) -> None:
    from refsrag.affinity import concept_names  # vocab.yaml: mined, so read at check time

    unknown = set(getattr(record, "concepts", {})) - set(concept_names())
    if unknown:
        raise ValueError(f"{item.id}: unknown concepts {sorted(unknown)}")


def _all_graded(item: BatchItem, record: Record) -> None:
    pooled = {i["id"] for i in item.inputs["items"]}
    graded = set(getattr(record, "grades", {}))
    if graded != pooled:
        raise ValueError(f"{item.id}: graded {len(graded)} of {len(pooled)} pooled items")


def _no_check(item: BatchItem, record: Record) -> None:
    return None


@dataclass(frozen=True)
class JobSpec:
    record: type[Record]
    batch_size: int
    version: int  # bump to re-run every item (prompt or schema change that invalidates old labels)
    check: ItemCheck = _no_check


JOB_SPECS: Final[dict[JobName, JobSpec]] = {
    "outfit_vision": JobSpec(OutfitVision, 20, 1),
    "pose_vision": JobSpec(PoseVision, 4, 1, _views_complete),
    # 5% re-labelled by a second agent; compared with the main job for the agreement gate
    "qa_outfit": JobSpec(OutfitVision, 20, 1),
    "qa_pose": JobSpec(PoseVision, 4, 1, _views_complete),
    "concept_affinity": JobSpec(ConceptAffinity, 60, 2, _known_concepts),  # v2: outfits get act/kink use
    "lexicon_concepts": JobSpec(ConceptGrouping, 1, 1),
    "alias_filter": JobSpec(AliasSelection, 8, 1),
    "eval_grade": JobSpec(EvalGrades, 5, 1, _all_graded),
}


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    job: JobName
    batch: str  # e.g. "batch_0007"
    prompt: str  # absolute path of PROMPT.md
    output: str  # absolute path the agent must write
    items: list[BatchItem]


@dataclass
class CollectReport:
    job: JobName
    accepted: int = 0
    pending_batches: list[str] = field(default_factory=list)
    errors: dict[str, str] = field(default_factory=dict)  # batch -> first error


def job_dir(job: JobName, root: Path = JOBS_ROOT) -> Path:
    return root / job


def load_results(job: JobName, root: Path = JOBS_ROOT) -> dict[str, Record]:
    """Valid records by id. A line that no longer validates (e.g. after a schema change) is skipped,
    so its item counts as missing and is re-batched."""
    path = job_dir(job, root) / "results.jsonl"
    if not path.is_file():
        return {}
    model, results = JOB_SPECS[job].record, {}
    for n, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = model.model_validate_json(line)
        except ValidationError as e:
            log.warning(
                "%s results.jsonl line %d no longer validates, will be redone: %s", job, n, e.errors()[0]
            )
            continue
        results[record.id] = record
    return results


def make_batches(job: JobName, items: Sequence[BatchItem], root: Path = JOBS_ROOT) -> list[Path]:
    """Collect finished outputs, then (re)write batch files for every item without a valid result."""
    spec, d = JOB_SPECS[job], job_dir(job, root)
    if (d / "batches").is_dir():
        collect(job, root)
    done = load_results(job, root)
    pending = sorted((i for i in items if _stale(done.get(i.id), i)), key=lambda i: i.id)
    for sub in ("batches", "out"):
        (d / sub).mkdir(parents=True, exist_ok=True)
        for old in (d / sub).glob("batch_*.json"):
            old.unlink()
    paths = []
    for n, start in enumerate(range(0, len(pending), spec.batch_size), start=1):
        name = f"batch_{n:04d}"
        batch = Batch(
            job=job,
            batch=name,
            prompt=str(d / "PROMPT.md"),
            output=str(d / "out" / f"{name}.json"),
            items=list(pending[start : start + spec.batch_size]),
        )
        path = d / "batches" / f"{name}.json"
        _write_atomic(path, batch.model_dump_json(indent=1))
        paths.append(path)
    return paths


def collect(job: JobName, root: Path = JOBS_ROOT) -> CollectReport:
    """Validate every batch output; merge the valid batches' records into results.jsonl."""
    spec, d = JOB_SPECS[job], job_dir(job, root)
    report = CollectReport(job)
    results = load_results(job, root)
    for batch_path in sorted((d / "batches").glob("batch_*.json")):
        batch = Batch.model_validate_json(batch_path.read_text())
        try:
            records = _validate_output(spec, batch)
        except (OSError, ValueError, ValidationError) as e:
            report.pending_batches.append(batch.batch)
            report.errors[batch.batch] = str(e).splitlines()[0][:300]
            continue
        for r in records:
            results[r.id] = r
        report.accepted += len(records)
    _write_atomic(
        job_dir(job, root) / "results.jsonl",
        "".join(results[k].model_dump_json() + "\n" for k in sorted(results)),
    )
    return report


def item_sha(job: JobName, input_shas: Sequence[str], inputs: Mapping[str, object]) -> str:
    """THE cache key of a batch item: the job version, the sha256 of every input file and every other
    input the agent sees. Pass inputs without file paths: they are machine-specific."""
    payload = json.dumps(
        {"job": job, "version": JOB_SPECS[job].version, "files": list(input_shas), "inputs": inputs},
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _validate_output(spec: JobSpec, batch: Batch) -> list[Record]:
    """All or nothing per batch: every item once, its sha256 copied, schema-valid and fitting its item."""
    raw = json.loads(Path(batch.output).read_text())
    if not isinstance(raw, list):
        raise ValueError("output is not a JSON array")
    records = [spec.record.model_validate(r) for r in raw]
    expected = {i.id: i for i in batch.items}
    got = {r.id: r for r in records}
    if len(got) != len(records) or got.keys() != expected.keys():
        missing, extra = expected.keys() - got.keys(), got.keys() - expected.keys()
        raise ValueError(
            f"item mismatch: missing={sorted(missing)} extra={sorted(extra)} dupes={len(records) - len(got)}"
        )
    for item_id, item in expected.items():
        if got[item_id].sha256 != item.sha256:
            raise ValueError(f"{item_id}: sha256 not copied from the batch")
        spec.check(item, got[item_id])
    return records


def _stale(record: Record | None, item: BatchItem) -> bool:
    return record is None or record.sha256 != item.sha256


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)
