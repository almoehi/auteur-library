"""THE single place that builds object keys and public URLs.

Three layers, never mixed:
- library path: a file's path relative to REFS_LIBRARY_ROOT, e.g. ``outfits/sexy/SXY-0001.png``
- ref key: relative to the public base URL, e.g. ``library/refs/assets/outfits/sexy/SXY-0001.png``.
  The index stores ref keys; Python and TypeScript resolve them with ``url()``.
- s3 key: the bucket key, ``<public_prefix><ref key>``.
"""

from __future__ import annotations

from typing import Final

ASSETS_DIR: Final = "assets/"
RAG_DIR: Final = "rag/"
LATEST_FILE: Final = "latest.json"
ASSET_MANIFEST_FILE: Final = "manifest.json"


def asset_ref_key(key_root: str, library_path: str) -> str:
    """Ref key of a library file."""
    return f"{_dir(key_root)}{ASSETS_DIR}{library_path.lstrip('/')}"


def asset_manifest_ref_key(key_root: str) -> str:
    """Ref key of the upload manifest (library path -> sha256)."""
    return f"{_dir(key_root)}{ASSETS_DIR}{ASSET_MANIFEST_FILE}"


def rag_ref_key(key_root: str, version: str, file_name: str) -> str:
    """Ref key of a file in one immutable index version, e.g. ``library/refs/rag/v1/index.json``."""
    return f"{_dir(key_root)}{RAG_DIR}{version}/{file_name}"


def latest_ref_key(key_root: str) -> str:
    return f"{_dir(key_root)}{RAG_DIR}{LATEST_FILE}"


def asset_s3_key(public_prefix: str, key_root: str, library_path: str) -> str:
    """Bucket key of a library file."""
    return s3_key(public_prefix, asset_ref_key(key_root, library_path))


def s3_key(public_prefix: str, ref_key: str) -> str:
    return _join(public_prefix, ref_key)


def url(base_url: str, ref_key: str) -> str:
    """Public URL of a ref key. Mirrored by the TypeScript port; keep the two in sync."""
    return _join(base_url, ref_key)


def _join(prefix: str, key: str) -> str:
    return f"{_dir(prefix)}{key}"


def _dir(prefix: str) -> str:
    return prefix if prefix.endswith("/") else prefix + "/"
