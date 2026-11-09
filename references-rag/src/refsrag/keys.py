"""THE single place that builds object keys and public URLs.

Three layers, never mixed:
- library path: a file's path relative to REFS_LIBRARY_ROOT, e.g. ``outfits/sexy/SXY-0001.png``
- ref key: relative to the public base URL, e.g. ``library/refs/assets/outfits/sexy/SXY-0001.png``.
  The index stores ref keys; Python and TypeScript resolve them with ``url()``.
- s3 key: the bucket key, ``<public_prefix><ref key>``.

Every catalog lives below ``library/<catalog key>/``: its files in ``assets/``, its index versions in
``rag/<version>/`` and the pointers in ``rag/``: ``latest.json`` (the version the deployed readers
follow; a publish may leave it alone) and ``latest.s<schema>.json`` (the newest published version of
that index schema, for readers of exactly that schema).
"""

from __future__ import annotations

import re
from typing import Final

LIBRARY_DIR: Final = "library/"
ASSETS_DIR: Final = "assets/"
RAG_DIR: Final = "rag/"
LATEST_FILE: Final = "latest.json"
ASSET_MANIFEST_FILE: Final = "manifest.json"
_POINTER_FILE: Final = re.compile(r"latest(\.s\d+)?\.json")


def catalog_root(catalog: str) -> str:
    """Key root of a catalog, e.g. ``library/refs/``."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", catalog):
        raise ValueError(f"catalog key {catalog!r} is not a lower-case path segment")
    return f"{LIBRARY_DIR}{catalog}/"


def asset_ref_key(catalog: str, library_path: str) -> str:
    """Ref key of a library file."""
    return f"{catalog_root(catalog)}{ASSETS_DIR}{library_path.lstrip('/')}"


def asset_manifest_ref_key(catalog: str) -> str:
    """Ref key of the upload manifest (library path -> sha256)."""
    return f"{catalog_root(catalog)}{ASSETS_DIR}{ASSET_MANIFEST_FILE}"


def rag_ref_key(catalog: str, version: str, file_name: str) -> str:
    """Ref key of a file in one immutable index version, e.g. ``library/refs/rag/v1/index.json``."""
    return f"{catalog_root(catalog)}{RAG_DIR}{version}/{file_name}"


def latest_ref_key(catalog: str) -> str:
    """The unversioned pointer, e.g. ``library/refs/rag/latest.json``."""
    return f"{catalog_root(catalog)}{RAG_DIR}{LATEST_FILE}"


def schema_latest_ref_key(catalog: str, schema: int) -> str:
    """The pointer for readers of one index schema, e.g. ``library/refs/rag/latest.s2.json``."""
    return f"{catalog_root(catalog)}{RAG_DIR}latest.s{schema}.json"


def is_pointer(address: str) -> bool:
    """Whether a path or URL names a pointer file (``latest.json`` or ``latest.s<schema>.json``)."""
    return _POINTER_FILE.fullmatch(address.rsplit("/", 1)[-1]) is not None


def asset_s3_key(public_prefix: str, catalog: str, library_path: str) -> str:
    """Bucket key of a library file."""
    return s3_key(public_prefix, asset_ref_key(catalog, library_path))


def s3_key(public_prefix: str, ref_key: str) -> str:
    return _join(public_prefix, ref_key)


def url(base_url: str, ref_key: str) -> str:
    """Public URL of a ref key. Mirrored by the TypeScript port; keep the two in sync."""
    return _join(base_url, ref_key)


def _join(prefix: str, key: str) -> str:
    return f"{_dir(prefix)}{key}"


def _dir(prefix: str) -> str:
    return prefix if prefix.endswith("/") else prefix + "/"
