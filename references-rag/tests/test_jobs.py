from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from refsrag.jobs import Batch, BatchItem, collect, load_results, make_batches

SHA_A, SHA_B, SHA_C = "a" * 64, "b" * 64, "c" * 64


@pytest.fixture(autouse=True)
def _concepts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("refsrag.affinity.concept_names", lambda: ["foot_fetish", "x"])


def _items(*pairs: tuple[str, str]) -> list[BatchItem]:
    return [BatchItem(id=i, sha256=s, inputs={"image": f"/x/{i}.png"}) for i, s in pairs]


def _affinity(item_id: str, sha: str, **extra: Any) -> dict[str, Any]:
    return {"id": item_id, "sha256": sha, "concepts": {"foot_fetish": 0.8}, **extra}


def _answer(batch_path: Path, records: list[dict[str, Any]]) -> None:
    batch = Batch.model_validate_json(batch_path.read_text())
    Path(batch.output).write_text(json.dumps(records))


def test_round_trip_and_resume(tmp_path: Path) -> None:
    (b1,) = make_batches("concept_affinity", _items(("o1", SHA_A), ("o2", SHA_B)), root=tmp_path)
    _answer(b1, [_affinity("o1", SHA_A), _affinity("o2", SHA_B)])
    report = collect("concept_affinity", root=tmp_path)
    assert (report.accepted, report.pending_batches) == (2, [])
    assert set(load_results("concept_affinity", root=tmp_path)) == {"o1", "o2"}
    # unchanged items are not re-batched; a changed sha is
    assert make_batches("concept_affinity", _items(("o1", SHA_A), ("o2", SHA_B)), root=tmp_path) == []
    (b2,) = make_batches("concept_affinity", _items(("o1", SHA_C), ("o2", SHA_B)), root=tmp_path)
    assert [i.id for i in Batch.model_validate_json(b2.read_text()).items] == ["o1"]


@pytest.mark.parametrize(
    "records",
    [
        [_affinity("o1", SHA_A)],  # an item missing
        [_affinity("o1", SHA_A), _affinity("o2", SHA_A)],  # wrong sha
        [_affinity("o1", SHA_A), _affinity("o2", SHA_B, stray=1)],  # unknown key
        [
            _affinity("o1", SHA_A),
            {"id": "o2", "sha256": SHA_B, "concepts": {"x": 1.5}},
        ],  # weight out of range
    ],
)
def test_invalid_output_keeps_batch_pending(tmp_path: Path, records: list[dict[str, Any]]) -> None:
    (b1,) = make_batches("concept_affinity", _items(("o1", SHA_A), ("o2", SHA_B)), root=tmp_path)
    _answer(b1, records)
    report = collect("concept_affinity", root=tmp_path)
    assert (report.accepted, report.pending_batches) == (0, ["batch_0001"])
    assert load_results("concept_affinity", root=tmp_path) == {}


def test_missing_output_is_pending(tmp_path: Path) -> None:
    make_batches("concept_affinity", _items(("o1", SHA_A)), root=tmp_path)
    assert collect("concept_affinity", root=tmp_path).pending_batches == ["batch_0001"]


def test_make_collects_finished_outputs_first(tmp_path: Path) -> None:
    items = _items(("o1", SHA_A), ("o2", SHA_B))
    (b1,) = make_batches("concept_affinity", items, root=tmp_path)
    _answer(b1, [_affinity("o1", SHA_A), _affinity("o2", SHA_B)])
    assert make_batches("concept_affinity", items, root=tmp_path) == []  # the output was not lost
    assert set(load_results("concept_affinity", root=tmp_path)) == {"o1", "o2"}


def test_invalid_results_line_is_redone(tmp_path: Path) -> None:
    (b1,) = make_batches("concept_affinity", _items(("o1", SHA_A)), root=tmp_path)
    _answer(b1, [_affinity("o1", SHA_A)])
    collect("concept_affinity", root=tmp_path)
    results = tmp_path / "concept_affinity" / "results.jsonl"
    results.write_text(results.read_text() + '{"id": "o2", "broken": true}\n')
    assert set(load_results("concept_affinity", root=tmp_path)) == {"o1"}


def _pose(item_id: str, sha: str, views: list[str]) -> dict[str, Any]:
    return {
        "id": item_id, "sha256": sha, "name_en": "Kneel",
        "description_en": "Kneels upright, hands on thighs.",
        "support": "kneeling", "mood": {}, "sex_positions": [], "typical_acts": [], "confidence": 0.8,
        "views": {v: {"focus": {"thighs": 0.5}, "view": "front view"} for v in views},
    }  # fmt: skip


def test_pose_record_must_label_every_given_view(tmp_path: Path) -> None:
    item = BatchItem(
        id="p1",
        sha256=SHA_A,
        inputs={"series": "duo", "category": "x", "solo": False, "views": {"front": "/a", "side": "/b"}},
    )
    (b1,) = make_batches("pose_vision", [item], root=tmp_path)
    _answer(b1, [_pose("p1", SHA_A, ["front"])])
    assert collect("pose_vision", root=tmp_path).pending_batches == ["batch_0001"]
    _answer(b1, [_pose("p1", SHA_A, ["front", "side"])])
    assert collect("pose_vision", root=tmp_path).accepted == 1


def test_affinity_rejects_unknown_concepts(tmp_path: Path) -> None:
    (b1,) = make_batches("concept_affinity", _items(("o1", SHA_A)), root=tmp_path)
    _answer(b1, [{"id": "o1", "sha256": SHA_A, "concepts": {"made_up": 0.9}}])
    assert collect("concept_affinity", root=tmp_path).pending_batches == ["batch_0001"]
