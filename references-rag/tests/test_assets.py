from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import boto3
import pytest
from conftest import OUTFIT, POSE_DEPTH, POSE_IMAGE
from moto import mock_aws

from refsrag import assets, keys
from refsrag.settings import Settings

BUCKET = "test-bucket"
PREFIX = "public/"
CATALOG = "refs"
MANIFEST_KEY = "public/library/refs/assets/manifest.json"


@pytest.fixture
def settings(library: Path) -> Iterator[Settings]:
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=BUCKET)
        yield Settings(
            library_root=library,
            bucket=BUCKET,
            region="us-east-1",
            public_prefix=PREFIX,
            base_url="https://example.test/",
            aws_access_key_id="test",
            aws_secret_access_key="test",
        )


def _object_keys() -> set[str]:
    resp = boto3.client("s3", region_name="us-east-1").list_objects_v2(Bucket=BUCKET)
    return {o["Key"] for o in resp.get("Contents", [])}


def _s3_key(library_path: str) -> str:
    return keys.asset_s3_key(PREFIX, CATALOG, library_path)


def test_first_upload_sends_everything(settings: Settings) -> None:
    report = assets.upload_assets(settings, CATALOG, dry_run=False, workers=2)
    assert (report.uploaded, report.skipped, report.total) == (3, 0, 3)
    assert report.bytes_uploaded > 0
    assert _object_keys() == {_s3_key(OUTFIT), _s3_key(POSE_IMAGE), _s3_key(POSE_DEPTH), MANIFEST_KEY}
    s3 = boto3.client("s3", region_name="us-east-1")
    head = s3.head_object(Bucket=BUCKET, Key=_s3_key(OUTFIT))
    assert head["ContentType"] == "image/png"
    assert head["CacheControl"] == "public, max-age=86400"
    manifest_obj = s3.get_object(Bucket=BUCKET, Key=MANIFEST_KEY)
    assert manifest_obj["ContentType"] == "application/json"
    assert set(json.loads(manifest_obj["Body"].read())) == {OUTFIT, POSE_IMAGE, POSE_DEPTH}


def test_second_run_skips_everything(settings: Settings) -> None:
    assets.upload_assets(settings, CATALOG, dry_run=False, workers=2)
    report = assets.upload_assets(settings, CATALOG, dry_run=False, workers=2)
    assert (report.uploaded, report.skipped, report.bytes_uploaded) == (0, 3, 0)


def test_changed_file_is_the_only_upload(settings: Settings, library: Path) -> None:
    assets.upload_assets(settings, CATALOG, dry_run=False, workers=2)
    (library / OUTFIT).write_bytes(b"changed")
    report = assets.upload_assets(settings, CATALOG, dry_run=False, workers=2)
    assert (report.uploaded, report.skipped) == (1, 2)
    body = boto3.client("s3", region_name="us-east-1").get_object(Bucket=BUCKET, Key=_s3_key(OUTFIT))["Body"]
    assert body.read() == b"changed"


def test_dry_run_uploads_nothing(settings: Settings) -> None:
    report = assets.upload_assets(settings, CATALOG, dry_run=True, workers=2)
    assert (report.uploaded, report.total) == (3, 3)
    assert _object_keys() == set()


def _manifest() -> dict[str, str]:
    s3 = boto3.client("s3", region_name="us-east-1")
    manifest: dict[str, str] = json.loads(s3.get_object(Bucket=BUCKET, Key=MANIFEST_KEY)["Body"].read())
    return manifest


def test_failed_upload_keeps_checkpoint_and_rerun_uploads_the_rest(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(assets, "CHECKPOINT_EVERY", 1)
    real_client = assets._client
    failing = _s3_key(POSE_DEPTH)

    def client(s: Settings) -> Any:
        s3 = real_client(s)
        real_upload = s3.upload_file

        def upload_file(filename: str, bucket: str, key: str, **kw: Any) -> None:
            if key == failing:
                raise RuntimeError("boom")
            real_upload(filename, bucket, key, **kw)

        s3.upload_file = upload_file
        return s3

    monkeypatch.setattr(assets, "_client", client)
    with pytest.raises(RuntimeError, match="boom"):
        assets.upload_assets(settings, CATALOG, dry_run=False, workers=1)
    assert set(_manifest()) == {OUTFIT, POSE_IMAGE}  # everything before the failure is recorded
    assert failing not in _object_keys()

    monkeypatch.setattr(assets, "_client", real_client)
    report = assets.upload_assets(settings, CATALOG, dry_run=False, workers=1)
    assert (report.uploaded, report.skipped) == (1, 2)
    assert set(_manifest()) == {OUTFIT, POSE_IMAGE, POSE_DEPTH}


def test_missing_files_are_listed_before_any_upload(settings: Settings, library: Path) -> None:
    (library / OUTFIT).unlink()
    (library / POSE_DEPTH).unlink()
    with pytest.raises(FileNotFoundError, match="2 missing") as e:
        assets.upload_assets(settings, CATALOG, dry_run=False, workers=2)
    assert OUTFIT in str(e.value) and POSE_DEPTH in str(e.value)
    assert _object_keys() == set()
