from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import boto3
import pytest
from conftest import ITEMS, TEST_CATALOG
from moto import mock_aws

from refsrag import index_build
from refsrag.descriptor import Catalog
from refsrag.index_build import check_items, concept_focus, label_concepts, label_lexicon, selection_golden
from refsrag.settings import Settings


def test_label_aliases_phrase_and_rare_single_words_only() -> None:
    lex = label_lexicon(
        [
            "label:archetype:office_secretary",
            "label:focus:back",
            "label:position:doggy style",
            "label:footwear:none",
        ],
        common={"back"},
    )
    assert (
        lex["office secretary"]
        == lex["office"]
        == lex["secretary"]
        == {"label:archetype:office_secretary": 0.8}
    )
    assert "back" not in lex  # a common word never stands alone, even as a whole term
    assert "doggy style" in lex and "doggy" not in lex and "style" not in lex  # positions: phrase only
    assert not any("none" in k for k in lex)


def test_label_focus_concepts_present_their_own_part() -> None:
    assert label_concepts(["label:focus:feet_soles"])["label:focus:feet_soles"]["focus"] == {
        "feet_soles": 1.0
    }


def test_concept_focus_is_the_lift_over_the_average_pose() -> None:
    def pose(concepts: dict[str, float], focus: dict[str, float]) -> dict[str, object]:
        return {"kind": "pose", "concepts": concepts, "media": {"views": [{"focus": focus}]}}

    items = [
        pose({"feet": 1.0}, {"feet_soles": 0.9, "chest": 0.2}),
        pose({"feet": 1.0}, {"feet_soles": 0.8, "chest": 0.3}),
        pose({}, {"chest": 0.9}),
        pose({}, {"chest": 0.8}),
    ]
    focus = concept_focus(items, ["feet", "rare"])
    assert focus["feet"] == {"feet_soles": 1.0}  # chest is below the average pose's, so it is no lift
    assert "rare" not in focus  # no pose serves it


def test_check_items_wants_the_declared_media_and_attrs() -> None:
    catalog = Catalog.from_json(TEST_CATALOG)
    check_items(catalog, ITEMS)
    no_series = {**ITEMS[2], "attrs": {"category": "lying", "solo": True, "sex_positions": []}}
    with pytest.raises(ValueError, match=r"solo/P1: attrs \['series'\] missing"):
        check_items(catalog, [no_series])
    with pytest.raises(ValueError, match="no media 'views'"):
        check_items(catalog, [{**ITEMS[2], "media": {"image": "x.png"}}])
    with pytest.raises(ValueError, match="kind 'face'"):
        check_items(catalog, [{**ITEMS[0], "kind": "face"}])


def test_selection_golden_covers_filters_media_and_invalid_requests(index_dir: Path) -> None:
    fixtures = selection_golden(index_dir)
    filtered = [c for c in fixtures["cases"] if c["filters"]]
    assert {op for c in filtered for op in c["filters"]} == {
        "solo",
        "max_exposure",
        "outfit_category",
        "pose_series",
    }
    first = fixtures["cases"][0]["result"]
    assert "views" in first["picks"]["pose"][0] and "views" not in first["picks"]["outfit"][0]
    assert any(c["kinds"] == ["pose"] for c in fixtures["cases"])
    decided = [c for c in fixtures["cases"] if c["decider"]]
    assert decided and all(c["result"]["decider"] == "fixed" for c in decided)
    assert [i["error"].split(" ")[0] for i in fixtures["invalid"]] == [
        "unknown",
        "filter",
        "filter",
        "filter",
        "filter",
        "unknown",
    ]


@pytest.fixture
def s3_settings(tmp_path: Path, index_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Settings]:
    """A mocked bucket and data/index/v9 = the tiny index (schema 2) with one extra file."""
    version = tmp_path / "indexes" / "v9"
    version.mkdir(parents=True)
    (version / "golden.json").write_text("{}")
    data = json.loads((index_dir / "index.json").read_text())
    (version / "index.json").write_text(json.dumps(data | {"files": ["golden.json"]}))
    monkeypatch.setattr(index_build, "INDEX_ROOT", tmp_path / "indexes")
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="refs-test")
        yield Settings(bucket="refs-test", region="us-east-1", public_prefix="public/", base_url="https://cdn.test/public/",
                       aws_access_key_id="test", aws_secret_access_key="test")  # fmt: skip


def _objects() -> dict[str, Any]:
    s3 = boto3.client("s3", region_name="us-east-1")
    keys = [o["Key"] for o in s3.list_objects_v2(Bucket="refs-test")["Contents"]]
    return {k: s3.get_object(Bucket="refs-test", Key=k)["Body"].read() for k in keys}


def test_publish_without_latest_writes_only_the_schema_pointer(s3_settings: Settings) -> None:
    pointers = index_build.publish(s3_settings, "v9", flip_latest=False)
    assert pointers == {"latest.s2.json": "https://cdn.test/public/library/refs/rag/latest.s2.json"}
    objects = _objects()
    assert set(objects) == {
        "public/library/refs/rag/v9/index.json",
        "public/library/refs/rag/v9/golden.json",
        "public/library/refs/rag/latest.s2.json",
    }
    pointer = json.loads(objects["public/library/refs/rag/latest.s2.json"])
    assert (pointer["index_version"], pointer["path"]) == ("v9", "v9/index.json")


def test_publish_flips_latest_by_default(s3_settings: Settings) -> None:
    assert set(index_build.publish(s3_settings, "v9", flip_latest=True)) == {"latest.s2.json", "latest.json"}
    objects = _objects()
    assert objects["public/library/refs/rag/latest.json"] == objects["public/library/refs/rag/latest.s2.json"]
