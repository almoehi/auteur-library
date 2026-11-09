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
from refsrag.query import Index, Recommender
from refsrag.settings import Settings, load_catalog


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
    decided = [c for c in fixtures["cases"] if c["decider"] and "decider_fails" not in c]
    assert decided and all(c["result"]["decider"] == "fixed" for c in decided)
    assert [i["error"].split(" ")[0] for i in fixtures["invalid"]] == [
        "unknown",
        "filter",
        "filter",
        "filter",
        "filter",
        "unknown",
        "k",
        "k",
    ]
    assert fixtures["invalid"][-1] == {"k": 5, "error": "k must be between 1 and 4"}
    default_k = [c for c in fixtures["cases"] if "k" not in c]
    assert default_k and all(len(p) <= 3 for c in default_k for p in c["result"]["picks"].values())
    failing = [c for c in fixtures["cases"] if c.get("decider_fails")]
    assert failing and all(
        c["result"]["decider"] == f"unavailable: the decision model failed ({', '.join(c['decider_fails'])})"
        for c in failing
    )
    (bare,) = [c for c in fixtures["cases"] if "media_override" in c]
    override = bare["media_override"]
    views = override["media"]["views"]
    assert not {"depth", "view"} & set(views[0]) and (views[1]["depth"], views[1]["view"]) == (None, None)
    (pick,) = [p for p in bare["result"]["picks"][bare["kinds"][0]] if p["id"] == override["id"]]
    assert all("depth" not in v for v in pick["views"][:2])


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


def test_publish_of_a_schema_2_index_never_touches_latest_json(s3_settings: Settings) -> None:
    """latest.json is the pointer the deployed schema-1 readers follow: a schema-2 publish leaves it."""
    pointers = index_build.publish(s3_settings, "v9")
    assert pointers == {"latest.s2.json": "https://cdn.test/public/library/refs/rag/latest.s2.json"}
    objects = _objects()
    assert set(objects) == {
        "public/library/refs/rag/v9/index.json",
        "public/library/refs/rag/v9/golden.json",
        "public/library/refs/rag/latest.s2.json",
    }
    pointer = json.loads(objects["public/library/refs/rag/latest.s2.json"])
    assert (pointer["index_version"], pointer["path"]) == ("v9", "v9/index.json")


def test_publish_of_a_schema_1_index_also_points_latest_json(s3_settings: Settings) -> None:
    src = index_build.INDEX_ROOT / "v9" / "index.json"
    src.write_text(json.dumps(json.loads(src.read_text()) | {"schema_version": 1}))
    assert set(index_build.publish(s3_settings, "v9")) == {"latest.s1.json", "latest.json"}
    objects = _objects()
    assert objects["public/library/refs/rag/latest.json"] == objects["public/library/refs/rag/latest.s1.json"]


def test_publish_cli_has_no_latest_switch() -> None:
    from typer.testing import CliRunner

    from refsrag.cli import app

    for flag in ("--latest", "--no-latest"):
        result = CliRunner().invoke(app, ["index", "publish", "v9", flag])
        assert result.exit_code != 0 and "No such option" in result.output


# ── A second catalog from a descriptor yaml + an items jsonl, no code ─────────────────────────────

FACES_YAML = """\
key: faces
title: Face references
description: Faces for portrait clips.
nudity: false
kinds:
  face:
    label: Faces
    description: A face, front and profile.
    media: views
  hair:
    label: Hairstyles
    description: A hairstyle.
    media: image
filters:
  - name: min_age
    kind: face
    field: age
    type: integer
    op: gte
    min: 18
    max: 99
    description: Faces of at least this apparent age.
result_fields:
  face: [age]
decider_context: a portrait clip
decider_guidance: {}
max_k: 2
"""


def _face(n: int, age: int, doc: str) -> dict[str, Any]:
    return {
        "id": f"F{n}", "kind": "face", "title": f"Face {n}", "doc": doc, "concepts": {}, "attrs": {"age": age},
        "media": {"views": [
            {"angle": "front", "image": f"library/faces/assets/f{n}_front.png", "focus": {"eyes": 1.0}},
            {"angle": "profile", "image": f"library/faces/assets/f{n}_profile.png",
             "depth": None, "view": None, "focus": {"nose": 1.0}},
        ]},
    }  # fmt: skip


FACE_ITEMS: list[dict[str, Any]] = [
    _face(1, 22, "smiling young face freckles red hair"),
    _face(2, 45, "serious mature face grey beard"),
    {"id": "H1", "kind": "hair", "title": "Braid", "doc": "long braid red hair", "concepts": {}, "attrs": {},
     "media": {"image": "library/faces/assets/h1.png"}},
]  # fmt: skip


@pytest.fixture
def faces(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """faces.yaml + faces.jsonl in tmp_path; indexes are built below tmp_path/indexes."""
    (tmp_path / "faces.yaml").write_text(FACES_YAML)
    (tmp_path / "faces.jsonl").write_text("".join(json.dumps(i) + "\n" for i in FACE_ITEMS))
    monkeypatch.setattr(index_build, "INDEX_ROOT", tmp_path / "indexes")
    return tmp_path


def test_a_second_catalog_builds_from_yaml_and_jsonl_only(faces: Path) -> None:
    from typer.testing import CliRunner

    from refsrag.cli import app

    result = CliRunner().invoke(
        app,
        ["index", "build", "faces-v1", "--catalog", str(faces / "faces.yaml"),
         "--items", str(faces / "faces.jsonl"), "--no-vectors"],
    )  # fmt: skip
    assert result.exit_code == 0, result.output
    out = faces / "indexes" / "faces-v1"
    index = json.loads((out / "index.json").read_text())
    assert index["catalog"]["key"] == "faces" and index["vector_sets"] == {}
    assert [i["id"] for i in index["items"]] == ["F1", "F2", "H1"]
    assert index["lexicon"] == {} and index["concepts"] == {}
    profile = index["items"][0]["media"]["views"][1]
    assert "depth" not in profile and "view" not in profile  # null is absent: never written as null
    assert set(index["files"]) == {"recommend.py", "golden.json"}
    rec = Recommender(Index(out), vector_set=None, base_url=BASE_V)
    picks = rec.recommend("red hair freckles", filters={"min_age": 20}).to_dict()["picks"]
    assert [p["id"] for p in picks["face"]] == ["F1", "F2"] and [p["id"] for p in picks["hair"]] == ["H1"]
    assert picks["face"][0]["views"][1] == {"angle": "profile",
                                           "image": BASE_V + "library/faces/assets/f1_profile.png"}  # fmt: skip
    golden = CliRunner().invoke(app, ["index", "golden", "faces-v1", "--cases", str(faces / "cases.yaml")])
    assert golden.exit_code != 0  # no cases file yet
    (faces / "cases.yaml").write_text(
        "queries: [red hair, grey beard]\nfilters: [{min_age: 30}]\ninvalid: [{filters: {min_age: 5}}]\n"
    )
    golden = CliRunner().invoke(app, ["index", "golden", "faces-v1", "--cases", str(faces / "cases.yaml")])
    assert golden.exit_code == 0, golden.output
    fixtures = json.loads((out / "selection-golden.json").read_text())
    assert {c["result"]["catalog"] for c in fixtures["cases"]} == {"faces"}
    assert fixtures["invalid"] == [
        {"filters": {"min_age": 5}, "error": "filter min_age: 5 is outside 18..99"}
    ]


def test_items_are_checked_against_the_descriptor(faces: Path) -> None:
    catalog = load_catalog(faces / "faces.yaml")
    bad = [
        ({**FACE_ITEMS[2], "kind": "1"}, "kind '1' is not in the catalog"),
        ({**FACE_ITEMS[2], "id": "F2"}, "duplicate id 'F2'"),
        ({k: v for k, v in FACE_ITEMS[2].items() if k != "doc"}, "missing doc"),
        ({**FACE_ITEMS[2], "media": {"image": "library/refs/assets/h1.png"}}, "not below library/faces/assets/"),
        ({**FACE_ITEMS[0], "attrs": {}}, r"attrs \['age'\] missing"),
        ({**FACE_ITEMS[0], "media": {"views": [{"angle": "front", "image": "library/faces/assets/x.png"}]}},
         "missing focus"),
    ]  # fmt: skip
    for item, message in bad:
        with pytest.raises(ValueError, match=message):
            check_items(catalog, [FACE_ITEMS[1], item])
    with pytest.raises(ValueError, match="already holds catalog faces"):
        index_build.build(
            _settings(), load_catalog(), "faces-v1", items_file=_write_index(faces), vector_sets=[]
        )


BASE_V = "https://cdn.test/public/"


def _settings() -> Settings:
    return Settings(bucket="b", region="us-east-1", public_prefix="public/", base_url=BASE_V)


def _write_index(faces: Path) -> Path:
    """data/index/faces-v1 holding the faces catalog; returns the items file."""
    index_build.build(_settings(), load_catalog(faces / "faces.yaml"), "faces-v1",
                      items_file=faces / "faces.jsonl", vector_sets=[])  # fmt: skip
    return faces / "faces.jsonl"


def test_upload_assets_of_a_catalog_from_its_items(faces: Path) -> None:
    from conftest import write_png

    from refsrag.assets import item_library_paths, upload_assets

    catalog = load_catalog(faces / "faces.yaml")
    items = index_build.read_items(faces / "faces.jsonl")
    paths = item_library_paths(catalog.key, items)
    assert paths == ["f1_front.png", "f1_profile.png", "f2_front.png", "f2_profile.png", "h1.png"]
    root = faces / "faces-lib"
    for p in paths:
        write_png(root / p, 90)
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket="refs-test")
        settings = Settings(bucket="refs-test", region="us-east-1", public_prefix="public/", base_url=BASE_V,
                            aws_access_key_id="test", aws_secret_access_key="test")  # fmt: skip
        report = upload_assets(settings, catalog.key, dry_run=False, workers=2, root=root, paths=paths)
        assert report.uploaded == 5
        assert "public/library/faces/assets/h1.png" in _objects()
