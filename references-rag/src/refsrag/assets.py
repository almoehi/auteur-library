"""Publish the library files to the public bucket prefix, skipping files whose sha256 is unchanged.

A manifest object (library path -> sha256) records what is already uploaded. It is rewritten every
``CHECKPOINT_EVERY`` uploads and, on success or failure, once more at the end, so an interrupted or
failed run resumes with the remainder only.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from refsrag import keys
from refsrag.catalog import library_files, load_outfits, load_poses, sha256_file
from refsrag.settings import Settings

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

log = logging.getLogger(__name__)

CHECKPOINT_EVERY: Final = 500
PROGRESS_EVERY: Final = 250
PNG_CACHE_CONTROL: Final = (
    "public, max-age=86400"  # keys are library paths and get overwritten: never immutable
)


@dataclass(frozen=True)
class UploadReport:
    uploaded: int  # with dry_run: files that would be uploaded
    skipped: int
    bytes_uploaded: int
    total: int


def item_library_paths(catalog: str, items: Iterable[Mapping[str, Any]]) -> list[str]:
    """The library paths (sorted, unique) of every file the items' media refer to: each image and depth
    ref key ``library/<catalog>/assets/<path>`` gives ``<path>``."""
    prefix = keys.asset_ref_key(catalog, "")
    refs = []
    for item in items:
        media = item["media"]
        if "image" in media:
            refs.append(media["image"])
        for view in media.get("views") or []:
            refs += [view["image"], *([view["depth"]] if view.get("depth") is not None else [])]
    outside = [r for r in refs if not r.startswith(prefix)]
    if outside:
        raise ValueError(f"media outside {prefix}: {outside[:3]}")
    return sorted({r.removeprefix(prefix) for r in refs})


def upload_assets(
    settings: Settings,
    catalog: str,
    *,
    dry_run: bool,
    workers: int,
    root: Path | None = None,
    paths: Sequence[str] | None = None,
) -> UploadReport:
    """Upload library files to ``library/<catalog>/assets/``: ``paths`` below ``root`` (e.g. from
    ``item_library_paths``), else the ``refs`` library's files below ``REFS_LIBRARY_ROOT``."""
    root = root or settings.require_library_root()
    paths = list(paths) if paths is not None else list(library_files(load_outfits(root), load_poses(root)))
    missing = [p for p in paths if not (root / p).is_file()]
    if missing:
        raise FileNotFoundError(f"{len(missing)} missing library files: {missing}")
    s3 = _client(settings)
    manifest_key = keys.s3_key(settings.public_prefix, keys.asset_manifest_ref_key(catalog))
    known = _read_manifest(s3, settings.bucket, manifest_key)

    def sync(path: str) -> tuple[str, str, int]:
        """Upload one file unless unchanged; returns (path, sha256, bytes uploaded)."""
        file = root / path
        sha = sha256_file(file)
        if known.get(path) == sha:
            return path, sha, 0
        size = file.stat().st_size
        if not dry_run:
            s3.upload_file(
                str(file),
                settings.bucket,
                keys.asset_s3_key(settings.public_prefix, catalog, path),
                ExtraArgs={"ContentType": "image/png", "CacheControl": PNG_CACHE_CONTROL},
            )
        return path, sha, size

    done: dict[str, str] = {}

    def checkpoint() -> None:
        """Manifest of every current library file known to be uploaded (entries of removed files drop)."""
        current = set(paths)
        _write_manifest(
            s3,
            settings.bucket,
            manifest_key,
            {p: sha for p, sha in {**known, **done}.items() if p in current},
        )

    uploaded = bytes_uploaded = 0
    pool = ThreadPoolExecutor(workers)
    try:
        futures: list[Future[tuple[str, str, int]]] = [pool.submit(sync, p) for p in paths]
        for n, future in enumerate(as_completed(futures), start=1):
            path, sha, size = future.result()
            done[path] = sha
            if size:
                uploaded += 1
                bytes_uploaded += size
                if not dry_run and uploaded % CHECKPOINT_EVERY == 0:
                    checkpoint()
            if n % PROGRESS_EVERY == 0:
                log.info("assets: %d/%d processed, %d uploaded", n, len(paths), uploaded)
    except BaseException:
        pool.shutdown(cancel_futures=True)  # drop queued uploads; running ones finish on exit
        raise
    finally:
        pool.shutdown()
        if not dry_run:
            checkpoint()
    return UploadReport(uploaded, len(paths) - uploaded, bytes_uploaded, len(paths))


def _client(settings: Settings) -> S3Client:
    return boto3.client(
        "s3",
        region_name=settings.region,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        config=Config(max_pool_connections=64),
    )


def _read_manifest(s3: S3Client, bucket: str, key: str) -> dict[str, str]:
    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchKey":
            return {}
        raise
    manifest: dict[str, str] = json.loads(body)
    return manifest


def _write_manifest(s3: S3Client, bucket: str, key: str, manifest: dict[str, str]) -> None:
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(manifest, sort_keys=True).encode(),
        ContentType="application/json",
    )
